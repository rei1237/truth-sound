"""한 사건을 처음부터 끝까지 처리한다: 원본 확인 → 분리 → 보정 → 받아쓰기 → 녹취록."""
import json
import os
import shutil
from datetime import datetime
from typing import Callable

import numpy as np

from . import case_store, editing
from .audio_io import load_audio, write_wav
from .diarize import (HOP_SEC, MIN_MARGIN, MIN_SIMILARITY, OVERLAP_STREAM_MIN_DB, QUIET, REFINE_PASSES,
                      SMOOTH_WINDOWS, TRACK_SR, UNKNOWN, VOICED_RULE, WINDOW_SEC, forced_labels, label_windows,
                      split_tracks, voiced_mask, window_levels, window_starts)
from .dsp import enhance_speech, rms_db
from .integrity import sha256_file
from .separate import CHUNK_SEC, OVERLAP_SEC, SEP_SR, Separator, SpeakerEncoder
from .short_sound import SETTINGS as SHORT_SETTINGS, rejudge
from .transcribe import SETTINGS as ASR_SETTINGS, Transcriber
from .transcript import LOW_CONF, dedupe, finalize, from_segments, mark_short_guess

SR = 16000
MIN_ENROLL_SEC = 0.2  # '네' 한마디도 받는다. 짧을수록 화자 배정이 틀릴 수 있어 화면에서 2초 이상을 권한다
TRACK_COMMENT = "청취 보조용 - 원본 아님 (Truth Sound)"
UNKNOWN_ID = "unknown"  # 누구와도 확실히 닮지 않은 소리. 사람 id로는 쓸 수 없다
UNKNOWN_LABEL = "화자 확인 필요"
UNKNOWN_TRACK = "청취보조_화자확인필요.wav"
UNKNOWN_WARN_PERCENT = 30
CLIP_LEVEL = 0.99  # 이 크기 넘는 샘플은 녹음 한계에 닿아 잘린 소리로 본다
CLIP_WARN_PERCENT = 1  # 보통 녹음은 잘린 샘플이 거의 없다
ASR_LEVEL_DB = -20.0
ASR_INPUT = "level_normalized_-20dBFS"
NO_CLEAR_SPEECH_PREFIX = "받아쓸 수 있는 분명한 말소리를 찾지 못했습니다."

Progress = Callable[[str, float, str], None]


def _speakers_to_process(case: dict) -> list[dict]:
    speakers = [s for s in case_store.public_speakers(case)[0] if s["enroll"]]
    if not 2 <= len(speakers) <= 3:
        raise ValueError("목소리 샘플을 지정한 사람이 2명 또는 3명이어야 합니다.")
    for s in speakers:
        total = sum(b - a for a, b in s["enroll"])
        if total < MIN_ENROLL_SEC:
            raise ValueError(f"{s['name']}: 목소리 샘플이 {MIN_ENROLL_SEC:.1f}초 이상 필요합니다(지금 {total:.1f}초).")
    return speakers


def _track_names(speakers: list[dict], with_unknown: bool = False) -> dict[str, str]:
    names, used = {}, set()
    if with_unknown:
        names[UNKNOWN_ID] = UNKNOWN_TRACK
        used.add(UNKNOWN_TRACK)
    for s in speakers:
        label = s["name"].replace("/", "_").replace("\\", "_")  # 경로 구분자가 접두어를 잘라 먹지 않게
        name = case_store.safe_name(f"청취보조_{label}.wav")
        if name in used:
            name = case_store.safe_name(f"청취보조_{label}_{s['id']}.wav")
        used.add(name)
        names[s["id"]] = name
    return names


def _asr_input(y: np.ndarray) -> np.ndarray:
    """받아쓰기 입력: 보정하지 않은 트랙의 전체 크기만 −20dBFS로 맞춘다. 무음은 그대로."""
    level = rms_db(y)
    if level <= -100:
        return y
    return (y * 10 ** ((ASR_LEVEL_DB - level) / 20)).astype(np.float32)


def _clipped_percent(x: np.ndarray) -> float:
    return 100 * float(np.mean(np.abs(x) >= CLIP_LEVEL)) if len(x) else 0.0


def _recording_clip_warning(percent: float) -> str:
    return (f"녹음의 {round(percent)}%가 너무 커서 잘린 소리입니다. 증폭해 저장한 파일이면 "
            "증폭하기 전 원래 녹음을 등록하세요. 작은 목소리는 Truth Sound가 알아서 키웁니다.")


def _is_recording_clip_warning(text: str) -> bool:
    return text.startswith("녹음의 ") and "가 너무 커서 잘린 소리입니다." in text


def _no_clear_speech_warning(duration: float, clipped: float) -> str:
    if duration <= 3.0 and clipped >= CLIP_WARN_PERCENT:
        detail = f" 녹음 길이가 {duration:.1f}초로 매우 짧고, 약 {round(clipped)}%가 너무 커서 잘린 소리입니다."
    elif duration <= 3.0:
        detail = f" 녹음 길이가 {duration:.1f}초로 매우 짧습니다."
    elif clipped >= CLIP_WARN_PERCENT:
        detail = f" 녹음의 약 {round(clipped)}%가 너무 커서 잘린 소리입니다."
    else:
        detail = ""
    return (f"{NO_CLEAR_SPEECH_PREFIX}{detail} 한 문장 이상 이어진 증폭 전 원본으로 다시 시도하거나, "
            "녹취록에서 원본을 들으며 줄을 직접 추가하세요.")


def _warnings(speakers: list[dict], assigned: dict[str, float], labels: np.ndarray,
              clipped: dict[str, float]) -> list[str]:
    """clipped: 녹음 전체("recording")와 사람마다 목소리 샘플에서 잘린 샘플 비율(%)."""
    out = [f"{s['name']}: 목소리 샘플로 지정한 곳 말고는 이 사람으로 판정된 구간이 없습니다. "
           "그 사람 혼자 말하는 곳을 더 길게 지정해 다시 처리해 보세요."
           for s in speakers if assigned[s["id"]] == 0]
    out += [f"{s['name']}: 목소리 샘플의 {round(clipped[s['id']])}%가 잘린 소리라 음색이 달라져 화자 판정이 "
            "틀리기 쉽습니다. 잘리지 않은 곳을 샘플로 고르세요."
            for s in speakers if clipped[s["id"]] >= CLIP_WARN_PERCENT]
    if clipped["recording"] >= CLIP_WARN_PERCENT:
        out.append(_recording_clip_warning(clipped["recording"]))
    voiced = int((labels != QUIET).sum())
    n = round(100 * int((labels == UNKNOWN).sum()) / voiced) if voiced else 0
    if n >= UNKNOWN_WARN_PERCENT:
        out.append(f"화자를 확인하지 못한 구간이 {n}%입니다. 목소리 샘플을 사람마다 2초 이상 지정하면 줄어듭니다.")
    return out


def _commit_tracks(case_id: str, d, new_dir, names: dict[str, str], stamp: str) -> None:
    """받아쓰기까지 성공한 뒤에만 새 분리 음성으로 바꾼다. 이전 것은 work/에 보관한다."""
    tracks = d / "tracks"
    old = [p for p in tracks.iterdir() if p.is_file()]
    if old:
        backup = d / "work" / f"tracks_before_{stamp}"
        backup.mkdir(exist_ok=True)
        for p in old:
            os.replace(p, backup / p.name)
        case_store.append_log(case_id, "이전 분리 음성 보관", folder=f"work/{backup.name}")
    for name in names.values():
        os.replace(new_dir / name, tracks / name)
    shutil.rmtree(new_dir, ignore_errors=True)


def _save_transcript(case_id: str, d, entries: list[dict], models: dict, stamp: str, **extra) -> None:
    path = d / "transcript.json"
    if path.exists():  # 다시 처리해도 이전 검수 내용은 남긴다
        backup = d / "work" / f"transcript_before_{stamp}.json"
        os.replace(path, backup)
        case_store.append_log(case_id, "이전 녹취록 보관", file=f"work/{backup.name}")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"entries": entries, "created_at": case_store.now_iso(), "models": models, **extra},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _set_status(case_id: str, status: str, **fields) -> None:
    with case_store._lock:
        case = case_store.load_case(case_id)
        case["status"] = status
        case.update(fields)
        case_store.save_case(case_id, case)


def run_pipeline(case_id: str, progress: Progress, separator_factory=Separator,
                 encoder_factory=SpeakerEncoder, transcriber_factory=Transcriber) -> None:
    case = case_store.load_case(case_id)
    speakers = _speakers_to_process(case)
    started = case_store.now_iso()
    case_store.append_log(case_id, "처리 시작", speakers=[s["id"] for s in speakers])
    _set_status(case_id, "processing")
    try:
        _run(case_id, case, speakers, started, progress, separator_factory, encoder_factory,
             transcriber_factory)
    except Exception as e:
        case_store.append_log(case_id, "처리 실패", error=str(e))
        _set_status(case_id, "error")
        raise


def _run(case_id, case, speakers, started, progress, separator_factory, encoder_factory, transcriber_factory):
    d = case_store.case_dir(case_id)
    progress("확인", 0.0, "원본 파일이 등록 때와 같은지 확인하는 중")
    check = case_store.verify_original(case_id)
    if not check["ok"]:
        case_store.append_log(case_id, "원본 불일치로 처리 중단", expected=check["expected"], actual=check["actual"])
        raise RuntimeError("원본 파일이 등록 때와 다릅니다. 처리를 멈췄습니다.")
    progress("확인", 1.0, "원본 확인 완료")

    progress("준비", 0.0, "녹음 파일을 읽는 중")
    orig = d / case["original"]["path"]
    source_duration = float(case["original"]["probe"]["duration"])
    cuts = editing.cuts_from_edits(editing.edit_state(case), source_duration)
    x16 = editing.cut_audio(load_audio(orig, SR), SR, cuts)
    x8 = editing.cut_audio(load_audio(orig, SEP_SR), SEP_SR, cuts)
    sample_of = {s["id"]: np.concatenate([x16[int(a * SR):int(b * SR)] for a, b in s["enroll"]]) for s in speakers}
    clipped = {"recording": _clipped_percent(x16)} | {k: _clipped_percent(v) for k, v in sample_of.items()}
    progress("준비", 1.0, "준비 완료")

    find, split = "누가 말하는지 찾는 중", "목소리를 사람별로 나누는 중"
    progress("목소리 분리", 0.0, find)
    enc = encoder_factory()
    try:
        refs = enc.embed_many([sample_of.pop(s["id"]) for s in speakers])
        starts = window_starts(len(x16), SR)
        embs = enc.embed_many([x16[int(t * SR):int((t + WINDOW_SEC) * SR)] for t in starts])
        voiced = voiced_mask(window_levels(x16, SR, starts))
        forced = forced_labels(starts, [s["enroll"] for s in speakers])
        labels, refs = label_windows(embs, refs, voiced, forced)
        # 화자 특징으로 못 알아본 아주 짧은 소리(네·응)는 프레임 음색으로 다시 본다
        labels, guessed = rejudge(x16, starts, labels, len(speakers))
        progress("목소리 분리", 0.3, find)
        sep = separator_factory(len(speakers))
        try:
            parts, added = split_tracks(x16, x8, starts, labels, refs, forced, sep, enc,
                                        lambda p: progress("목소리 분리", 0.3 + 0.7 * p, split))
            sep_name = sep.name
        finally:
            sep.close()
        enc_name = enc.name
    finally:
        enc.close()
    del x16, x8  # 긴 녹음은 배열 하나가 수백 MB라 다 쓴 것은 바로 놓는다

    keys = [(s["id"], k) for k, s in enumerate(speakers)]
    if UNKNOWN in parts:
        keys.append((UNKNOWN_ID, UNKNOWN))
    label_of = {s["id"]: s["name"] for s in speakers} | {UNKNOWN_ID: UNKNOWN_LABEL}
    names = _track_names(speakers, with_unknown=UNKNOWN in parts)
    new_dir = d / "work" / "tracks_new"
    shutil.rmtree(new_dir, ignore_errors=True)
    new_dir.mkdir(parents=True)
    raw = {}
    for i, (sid, k) in enumerate(keys):
        raw[sid] = parts.pop(k)
        rendered = editing.expand_audio(enhance_speech(raw[sid], SR), SR, source_duration, cuts)
        write_wav(new_dir / names[sid], rendered, SR, comment=TRACK_COMMENT)
        progress("음성 보정", (i + 1) / len(keys), f"{label_of[sid]} 목소리를 또렷하게 만드는 중")

    tr = transcriber_factory()
    try:
        entries = []
        for i, (sid, _) in enumerate(keys):
            # 보정한 소리는 사람 귀에는 낫지만 받아쓰기는 더 틀린다. 크기만 맞춘 원 트랙을 넣는다
            segs = tr.transcribe(_asr_input(raw[sid]), lambda p, i=i, sid=sid: progress(
                "받아쓰기", (i + p) / len(keys), f"{label_of[sid]} 말을 받아쓰는 중"))
            entries += from_segments(sid, segs)
        asr_info = tr.info()
    finally:
        tr.close()

    progress("정리", 0.0, "녹취록을 정리하는 중")
    # 보정 전 크기로 비교해야 새어 들어간 작은 사본이 진짜 주인 트랙을 이기지 않는다
    entries, removed = dedupe(entries, lambda spk, a, b: rms_db(raw[spk][int(a * SR):int(b * SR)]))
    entries = finalize(entries)
    centers = np.asarray(starts) + WINDOW_SEC / 2
    entries = mark_short_guess(entries, [(speakers[k]["id"], float(c - HOP_SEC), float(c + HOP_SEC), bool(g))
                                         for c, k, g in zip(centers, labels, guessed) if k >= 0])
    editing.ensure_entry_sources(entries, source_duration, cuts)
    assigned = {s["id"]: round(added.get(k, 0) * HOP_SEC, 1) for k, s in enumerate(speakers)}
    assigned[UNKNOWN_ID] = round(added.get(UNKNOWN, 0) * HOP_SEC, 1)
    warnings = _warnings(speakers, assigned, labels, clipped)
    if not entries:
        warnings.append(_no_clear_speech_warning(editing.edited_duration(source_duration, cuts),
                                                 clipped["recording"]))
    models = {"separator": sep_name, "encoder": enc_name, "transcriber": asr_info}
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    _commit_tracks(case_id, d, new_dir, names, stamp)
    _save_transcript(case_id, d, entries, models, stamp)

    processing = {
        "started_at": started,
        "finished_at": case_store.now_iso(),
        "original_check": check,
        "speakers": [{"id": s["id"], "name": s["name"], "enroll": s["enroll"]} for s in speakers],
        "models": models,
        "settings": {"speaker_assignment": "time_window", "window_sec": WINDOW_SEC, "hop_sec": HOP_SEC,
                     "min_similarity": MIN_SIMILARITY, "min_margin": MIN_MARGIN,
                     "smooth_windows": SMOOTH_WINDOWS, "refine_passes": REFINE_PASSES,
                     "voiced_rule": VOICED_RULE, "overlap_stream_min_db": OVERLAP_STREAM_MIN_DB,
                     "separation_sr": SEP_SR, "chunk_sec": CHUNK_SEC, "overlap_sec": OVERLAP_SEC,
                     "track_sr": TRACK_SR, "output_sr": SR, "asr_input": ASR_INPUT,
                     "low_confidence_below": LOW_CONF, "transcription": ASR_SETTINGS,
                     "short_sound": SHORT_SETTINGS},
        "tracks": {k: f"tracks/{n}" for k, n in names.items()},
        "track_sha256": {k: sha256_file(d / "tracks" / n) for k, n in names.items()},
        "duplicates_excluded": removed,
        "short_guess_windows": int(guessed.sum()),
        "assigned_seconds": assigned,
        "warnings": warnings,
        "edit_revision": editing.summary(case)["revision"],
    }
    _set_status(case_id, "done", processing=processing)
    case_store.append_log(case_id, "처리 완료", entries=len(entries), duplicates_excluded=removed,
                          assigned_seconds=assigned, short_guess_windows=int(guessed.sum()))
    progress("정리", 1.0, "완료")


def run_transcribe(case_id: str, progress: Progress, transcriber_factory=Transcriber) -> None:
    """샘플·분리 없이 원본만으로 녹취록을 만든다. 이미 분리한 사건의 트랙은 건드리지 않고, 실패하면 status도 그대로 둔다.
    끝난(done) 사건은 도는 동안에도 status를 바꾸지 않는다: 도중에 꺼져도 '중단됨'으로 잠기지 않는다."""
    started = case_store.now_iso()
    before = case_store.load_case(case_id)["status"]
    flip = before != "done"
    case_store.append_log(case_id, "받아쓰기 시작")
    if flip:
        _set_status(case_id, "processing")
    try:
        _transcribe(case_id, started, progress, transcriber_factory)
    except BaseException as e:  # 강제 종료성 예외에서도 status를 돌려 놓는다
        case_store.append_log(case_id, "받아쓰기 실패", error=str(e))
        if flip:
            _set_status(case_id, before)
        raise


def _transcribe(case_id, started, progress, transcriber_factory):
    d = case_store.case_dir(case_id)
    case = case_store.load_case(case_id)
    progress("확인", 0.0, "원본 파일이 등록 때와 같은지 확인하는 중")
    check = case_store.verify_original(case_id)
    if not check["ok"]:
        case_store.append_log(case_id, "원본 불일치로 처리 중단", expected=check["expected"], actual=check["actual"])
        raise RuntimeError("원본 파일이 등록 때와 다릅니다. 처리를 멈췄습니다.")
    progress("확인", 1.0, "원본 확인 완료")

    progress("준비", 0.0, "녹음 파일을 읽는 중")
    source_duration = float(case["original"]["probe"]["duration"])
    cuts = editing.cuts_from_edits(editing.edit_state(case), source_duration)
    x16 = editing.cut_audio(load_audio(d / case["original"]["path"], SR), SR, cuts)
    clipped = _clipped_percent(x16)
    progress("준비", 1.0, "준비 완료")

    tr = transcriber_factory()
    try:
        segs = tr.transcribe(_asr_input(x16), lambda p: progress("받아쓰기", p, "녹음을 받아쓰는 중"))
        asr_info = tr.info()
    finally:
        tr.close()
    del x16

    progress("정리", 0.0, "녹취록을 정리하는 중")
    entries = finalize(from_segments(UNKNOWN_ID, segs))
    editing.ensure_entry_sources(entries, source_duration, cuts)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    finished = case_store.now_iso()
    case = case_store.load_case(case_id)
    old = case.get("processing")
    models = (old["models"] if old else {"separator": None, "encoder": None}) | {"transcriber": asr_info}
    _save_transcript(case_id, d, entries, models, stamp, source="original")

    settings = {"asr_input": ASR_INPUT, "output_sr": SR, "low_confidence_below": LOW_CONF,
                "transcription": ASR_SETTINGS}
    warnings = [w for w in (old["warnings"] if old else [])
                if not _is_recording_clip_warning(w) and not w.startswith(NO_CLEAR_SPEECH_PREFIX)]
    if clipped >= CLIP_WARN_PERCENT:
        warnings.append(_recording_clip_warning(clipped))
    if not entries:
        warnings.append(_no_clear_speech_warning(editing.edited_duration(source_duration, cuts), clipped))
    done = {"started_at": started, "finished_at": finished, "segments": len(segs), "entries": len(entries),
            "rejected": max(0, len(segs) - len(entries))}
    if old:  # 이미 분리한 사건: 트랙·화자·배정 시간은 그대로 두고 받아쓰기 관련 값만 바꾼다
        processing = old | {"models": models, "original_check": check, "settings": old["settings"] | settings,
                            "warnings": warnings, "transcribed_from_original": done}
    else:
        processing = {**done, "original_check": check, "speakers": [], "models": models, "settings": settings,
                      "tracks": {}, "track_sha256": {}, "duplicates_excluded": 0, "warnings": warnings,
                      "transcribed_from_original": done}
    _set_status(case_id, "done", processing=processing)
    case_store.append_log(case_id, "받아쓰기 완료", entries=len(entries), segments=len(segs),
                          rejected=max(0, len(segs) - len(entries)))
    progress("정리", 1.0, "완료")
