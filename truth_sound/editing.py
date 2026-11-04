"""비파괴 컷 편집의 시간축 변환과 편집본 오디오 생성.

컷은 항상 등록 원본의 초 좌표로 저장한다. 화면/API는 편집 좌표를 쓰며,
원본 파일은 읽기만 한다.
"""
from __future__ import annotations

import copy
import uuid
from pathlib import Path

import numpy as np

from .audio_io import load_audio, write_wav

VERSION = 1
MIN_CUT_SEC = 0.05
EPS = 1e-6


def empty_edits() -> dict:
    return {"version": VERSION, "revision": 0, "history": [], "cursor": 0}


def edit_state(case: dict) -> dict:
    raw = case.get("edits") or {}
    history = raw.get("history") if isinstance(raw.get("history"), list) else []
    cursor = max(0, min(int(raw.get("cursor", len(history))), len(history)))
    return {"version": VERSION, "revision": int(raw.get("revision", 0)),
            "history": copy.deepcopy(history), "cursor": cursor}


def merge_ranges(ranges: list[list[float]], duration: float | None = None) -> list[list[float]]:
    clean = []
    for item in ranges or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            continue
        a, b = float(item[0]), float(item[1])
        if duration is not None:
            a, b = max(0.0, a), min(float(duration), b)
        if b - a > EPS:
            clean.append([a, b])
    clean.sort()
    out: list[list[float]] = []
    for a, b in clean:
        if out and a <= out[-1][1] + EPS:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [[round(a, 6), round(b, 6)] for a, b in out]


def cuts_from_edits(edits: dict | None, duration: float | None = None) -> list[list[float]]:
    e = edits or empty_edits()
    history = e.get("history") or []
    cursor = max(0, min(int(e.get("cursor", len(history))), len(history)))
    return merge_ranges([r for op in history[:cursor] for r in op.get("source_ranges", [])], duration)


def kept_ranges(duration: float, cuts: list[list[float]]) -> list[list[float]]:
    out, at = [], 0.0
    for a, b in merge_ranges(cuts, duration):
        if a > at + EPS:
            out.append([at, a])
        at = max(at, b)
    if at < duration - EPS:
        out.append([at, duration])
    return out


def edited_duration(duration: float, cuts: list[list[float]]) -> float:
    return round(sum(b - a for a, b in kept_ranges(duration, cuts)), 6)


def edited_range_to_source(start: float, end: float, duration: float,
                           cuts: list[list[float]]) -> list[list[float]]:
    total = edited_duration(duration, cuts)
    a, b = float(start), float(end)
    if a < -EPS or b > total + EPS or b < a:
        raise ValueError("선택 구간이 편집본 길이 밖에 있습니다.")
    a, b = max(0.0, a), min(total, b)
    out, cursor = [], 0.0
    for sa, sb in kept_ranges(duration, cuts):
        span = sb - sa
        left, right = max(a, cursor), min(b, cursor + span)
        if right > left + EPS:
            out.append([sa + left - cursor, sa + right - cursor])
        cursor += span
    return merge_ranges(out, duration)


def source_ranges_to_edited(ranges: list[list[float]], duration: float,
                            cuts: list[list[float]]) -> list[list[float]]:
    out, cursor = [], 0.0
    source = merge_ranges(ranges, duration)
    for ka, kb in kept_ranges(duration, cuts):
        for a, b in source:
            left, right = max(a, ka), min(b, kb)
            if right > left + EPS:
                out.append([cursor + left - ka, cursor + right - ka])
        cursor += kb - ka
    return merge_ranges(out, edited_duration(duration, cuts))


def project_interval(ranges: list[list[float]], duration: float, cuts: list[list[float]]) -> dict:
    original = merge_ranges(ranges, duration)
    visible = source_ranges_to_edited(original, duration, cuts)
    before = sum(b - a for a, b in original)
    after = sum(b - a for a, b in visible)
    return {"ranges": visible, "removed": after <= EPS,
            "partial": after > EPS and after < before - EPS}


def ensure_entry_sources(entries: list[dict], duration: float, cuts: list[list[float]]) -> None:
    """구버전/새 처리 결과의 편집 좌표를 원본 좌표 메타데이터로 보강한다."""
    for entry in entries:
        if entry.get("source_ranges"):
            continue
        total = edited_duration(duration, cuts)
        start = max(0.0, min(total, float(entry.get("start", 0))))
        end = max(start, min(total, float(entry.get("end", entry.get("start", 0)))))
        entry["source_ranges"] = edited_range_to_source(start, end, duration, cuts) if end > start else []


def project_entries(entries: list[dict], duration: float, cuts: list[list[float]]) -> list[dict]:
    if not cuts:
        out = copy.deepcopy(entries)
        for item in out:
            item.pop("source_ranges", None)
            item.pop("edited_ranges", None)
            item.pop("cut_review_required", None)
        return sorted(out, key=lambda item: (item["start"], item["end"]))
    out = []
    for entry in entries:
        item = copy.deepcopy(entry)
        ranges = item.get("source_ranges") or [[item.get("start", 0), item.get("end", 0)]]
        projected = project_interval(ranges, duration, cuts)
        if projected["removed"]:
            continue
        item["start"] = round(projected["ranges"][0][0], 3)
        item["end"] = round(projected["ranges"][-1][1], 3)
        item["edited_ranges"] = [[round(a, 3), round(b, 3)] for a, b in projected["ranges"]]
        item.pop("source_ranges", None)
        if projected["partial"]:
            if entry.get("cut_review_required", True):
                item["cut_review_required"] = True
                item["reviewed"] = False
            else:
                item.pop("cut_review_required", None)
        else:
            item.pop("cut_review_required", None)
        out.append(item)
    return sorted(out, key=lambda item: (item["start"], item["end"]))


def add_cut(edits: dict | None, start: float, end: float, duration: float, at: str) -> dict:
    state = edit_state({"edits": edits})
    cuts = cuts_from_edits(state, duration)
    if float(end) - float(start) < MIN_CUT_SEC - EPS:
        raise ValueError(f"{MIN_CUT_SEC:.2f}초 이상인 구간을 선택하세요.")
    source = edited_range_to_source(start, end, duration, cuts)
    if sum(b - a for a, b in source) < MIN_CUT_SEC - EPS:
        raise ValueError("자를 수 있는 소리가 없는 구간입니다.")
    if edited_duration(duration, merge_ranges(cuts + source, duration)) < MIN_CUT_SEC - EPS:
        raise ValueError("녹음 전체를 자를 수는 없습니다. 최소 0.05초를 남겨 주세요.")
    history = state["history"][:state["cursor"]]
    history.append({"id": uuid.uuid4().hex[:12], "at": at,
                    "edited_range": [round(float(start), 6), round(float(end), 6)],
                    "source_ranges": source})
    return {"version": VERSION, "revision": state["revision"] + 1,
            "history": history, "cursor": len(history)}


def move_cursor(edits: dict | None, delta: int) -> dict:
    state = edit_state({"edits": edits})
    nxt = state["cursor"] + int(delta)
    if not 0 <= nxt <= len(state["history"]):
        raise ValueError("되돌리거나 다시 적용할 컷이 없습니다.")
    state["cursor"] = nxt
    state["revision"] += 1
    return state


def summary(case: dict) -> dict:
    duration = float(case["original"]["probe"]["duration"])
    state = edit_state(case)
    cuts = cuts_from_edits(state, duration)
    return {"version": VERSION, "revision": state["revision"], "cursor": state["cursor"],
            "count": state["cursor"], "can_undo": state["cursor"] > 0,
            "can_redo": state["cursor"] < len(state["history"]), "cuts": cuts,
            "duration": edited_duration(duration, cuts), "source_duration": duration}


def cut_audio(x: np.ndarray, sr: int, cuts: list[list[float]]) -> np.ndarray:
    duration = len(x) / sr
    parts = [x[max(0, round(a * sr)):min(len(x), round(b * sr))]
             for a, b in kept_ranges(duration, cuts)]
    return np.concatenate(parts) if parts else np.empty(0, dtype=x.dtype)


def expand_audio(x: np.ndarray, sr: int, source_duration: float,
                 cuts: list[list[float]]) -> np.ndarray:
    out = np.zeros(round(source_duration * sr), dtype=x.dtype)
    pos = 0
    for a, b in kept_ranges(source_duration, cuts):
        n = min(round((b - a) * sr), len(x) - pos)
        if n <= 0:
            break
        start = round(a * sr)
        out[start:start + n] = x[pos:pos + n]
        pos += n
    return out


def render_file(source: Path, target: Path, cuts: list[list[float]], sr: int | None = None) -> Path:
    if target.exists():
        return target
    from .analysis import audio_info
    rate = int(sr or audio_info(source)["sr"])
    audio = cut_audio(load_audio(source, rate), rate, cuts)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
    write_wav(tmp, audio, rate)
    try:
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)
    return target
