"""녹취록 문서(DOCX·TXT)와 처리 기록을 내보낸다."""
import json
from datetime import datetime
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from . import case_store, editing
from .transcript import EXCLUDE_REASONS, fmt_time

NOTICE = ("이 녹취록은 Truth Sound가 AI로 받아쓴 초안을 바탕으로 작성되었습니다. "
          "정확한 내용은 원본 녹음 파일을 직접 들어 확인해야 합니다. "
          "함께 제공되는 분리·보정 음성은 청취 보조용이며 원본이 아닙니다.")
GUESS_NOTE = ("이름 뒤 (추정): 아주 짧은 소리라 목소리 특징만으로는 누구인지 확실하지 않아 음색이 가장 닮은 사람으로 "
              "추정한 줄입니다. 원본을 들어 확인해야 합니다.")
MISMATCH = "경고: 원본 파일이 등록 때와 다릅니다. 이 녹취록을 쓰기 전에 원본 파일을 다시 확인하세요."
RED = RGBColor(0xC0, 0x00, 0x00)
FONT = "맑은 고딕"
_PUNCT = ".,?!…~\"'"
UNKNOWN_ID = "unknown"
UNKNOWN_NAME = "화자 미상"
UNKNOWN_ROW = (UNKNOWN_NAME, "어느 목소리 샘플과도 뚜렷이 닮지 않은 구간")
UNKNOWN_ROW_ORIGINAL = (UNKNOWN_NAME, "화자를 나누지 않고 받아 적었습니다. 원본을 들어 화자를 고르세요")


def _out_path(case_id: str, stem: str, suffix: str) -> Path:
    d = case_store.case_dir(case_id) / "exports"
    d.mkdir(exist_ok=True)
    base = f"{stem}_{datetime.now():%Y%m%d-%H%M%S}"
    path, n = d / f"{base}{suffix}", 2
    while path.exists():
        path, n = d / f"{base}_{n}{suffix}", n + 1
    return path


def _load(case_id: str) -> tuple[dict, list[dict], dict]:
    case = case_store.load_case(case_id)
    path = case_store.case_dir(case_id) / "transcript.json"
    raw = json.loads(path.read_text(encoding="utf-8"))["entries"] if path.exists() else []
    duration = float(case["original"]["probe"]["duration"])
    cuts = editing.cuts_from_edits(editing.edit_state(case), duration)
    entries = editing.project_entries(raw, duration, cuts)
    for e in entries:
        if e.get("uncertain"):
            a = min(duration, max(0.0, e["start"]))
            b = min(editing.edited_duration(duration, cuts), e["end"])
            e["original_ranges"] = editing.edited_range_to_source(a, b, duration, cuts) if b > a else []
    return case_store.public_case(case), entries, case_store.verify_original(case_id)


def _from_original(case_id: str) -> bool:
    """샘플·분리 없이 원본에서 바로 받아쓴 녹취록인가."""
    path = case_store.case_dir(case_id) / "transcript.json"
    return path.exists() and json.loads(path.read_text(encoding="utf-8")).get("source") == "original"


def _title(entries: list[dict]) -> str:
    final = (any(not e.get("excluded") for e in entries) and all(e["reviewed"] for e in entries)
             and all(e["text"].strip() for e in entries if not e.get("excluded")))
    return "녹취록" if final else "녹취록 (초안)"


def _marked_text(e: dict) -> str:
    """검수 전 줄은 자신 없는 단어 뒤에 (?)를 붙인다. 글이 고쳐져 단어를 못 찾으면 그대로 둔다."""
    text = e["text"]
    if e["reviewed"]:
        return text
    pos = 0
    for i in e.get("low", []):
        w = e["words"][i]["w"].strip().strip(_PUNCT)
        at = text.find(w, pos) if w else -1
        if at < 0:
            continue
        end = at + len(w)
        text = text[:end] + "(?)" + text[end:]
        pos = end + 3
    return ("[불확실 · 원본 확인 필요] " if e.get("uncertain") else "") + text


def _names(case: dict) -> dict:
    return {s["id"]: s["name"] for s in case["speakers"]} | {UNKNOWN_ID: UNKNOWN_NAME}


def _guessed(e: dict) -> bool:
    return bool(e.get("short_guess")) and not e["reviewed"]


def _lines(case: dict, entries: list[dict]) -> list[str]:
    names = _names(case)
    return [f"[{fmt_time(e['start'])}] {names.get(e['speaker'], e['speaker'])}{'(추정)' if _guessed(e) else ''}: "
            f"{_marked_text(e)}" for e in entries if not e.get("excluded")] or ["[기재할 수 있는 발화 없음 · 원본 확인 필요]"]


def _notices(entries: list[dict]) -> list[str]:
    n = sum(1 for e in entries if _guessed(e) and not e.get("excluded"))
    return [NOTICE] + ([f"{GUESS_NOTE} (검수 전 {n}줄)"] if n else [])


def _original_rows(case: dict) -> list[tuple[str, str]]:
    o, p = case["original"], case["original"]["probe"]
    mtime = (datetime.fromtimestamp(o["client_mtime"]).astimezone().isoformat(timespec="seconds")
             if o.get("client_mtime") else "알 수 없음")
    rows = [
        ("파일명", o["name"]),
        ("크기", f"{o['size']:,} 바이트"),
        ("원본 길이", f"{fmt_time(p.get('source_duration', p['duration']))} ({p.get('source_duration', p['duration']):.1f}초)"),
        ("형식", f"{p.get('format')} / {p.get('codec')} / {p.get('sample_rate')} Hz / {p.get('channels')}채널"),
        ("SHA-256", o["sha256"]),
        ("파일 수정 시각", mtime),
        ("등록 시각", case["created_at"]),
    ]
    edit = case.get("edit") or {}
    if edit.get("count"):
        rows.append(("편집본 길이", f"{fmt_time(edit['duration'])} ({edit['duration']:.1f}초), 컷 {edit['count']}개"))
    return rows


def _check_text(check: dict) -> str:
    if check["ok"]:
        return f"원본 파일의 SHA-256 값이 등록 때와 같습니다. (확인 시각 {check['checked_at']})"
    return f"{MISMATCH} (등록 때 {check['expected']}, 지금 {check['actual']}, 확인 시각 {check['checked_at']})"


def _processing_lines(case: dict, entries: list[dict]) -> list[str]:
    reviewed = sum(1 for e in entries if e["reviewed"])
    out = [f"검수 {reviewed}/{len(entries)}줄",
           f"검수에서 뺀 줄 {sum(1 for e in entries if e.get('excluded'))}개"]
    p = case.get("processing")
    if not p:
        return out + ["처리 기록 없음"]
    m = p["models"]
    t = m.get("transcriber", {})
    separation = (f"{m['separator']} / 화자 특징: {m.get('encoder')}" if m.get("separator") else "하지 않음")
    out += [f"처리 시각: {p['started_at']} ~ {p['finished_at']}",
            f"목소리 분리: {separation}",
            f"받아쓰기: {t.get('model')} ({t.get('device')}, {t.get('compute_type')})",
            "설정: " + json.dumps(p["settings"], ensure_ascii=False),
            f"중복 의심으로 자동으로 뺀 줄: {p.get('duplicates_excluded', 0)}"]
    again = p.get("transcribed_from_original")
    if again:
        out.append(f"원본에서 다시 받아쓴 시각: {again['started_at']} ~ {again['finished_at']}")
    return out


def _set_font(doc: Document) -> None:
    style = doc.styles["Normal"]
    style.font.name = FONT
    style.font.size = Pt(10.5)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), FONT)


def _table(doc: Document, rows: list[tuple[str, ...]], header: tuple[str, ...] | None = None) -> None:
    all_rows = ([header] if header else []) + rows
    t = doc.add_table(rows=len(all_rows), cols=len(all_rows[0]))
    t.style = "Table Grid"
    for r, row in enumerate(all_rows):
        for c, val in enumerate(row):
            t.cell(r, c).text = str(val)


def export_docx(case_id: str) -> Path:
    case, entries, check = _load(case_id)
    doc = Document()
    _set_font(doc)
    doc.add_heading(_title(entries), level=0)
    doc.add_heading("원본 파일", level=1)
    _table(doc, _original_rows(case))
    doc.add_heading("무결성 확인", level=1)
    para = doc.add_paragraph()
    run = para.add_run(_check_text(check))
    if not check["ok"]:
        run.font.color.rgb = RED
        run.bold = True
    doc.add_heading("화자", level=1)
    # 구간은 현재 편집 시간축의 샘플 위치를 적는다.
    original = _from_original(case_id)
    processing = case.get("processing") or {}
    snapshot = [s for s in processing.get("speakers", []) if isinstance(s, dict)]
    people = [] if original and processing.get("speakers") == [] else (
        case["speakers"] if (case.get("edit") or {}).get("count") else snapshot or case["speakers"])
    names = _names(case)
    rows = [(names.get(s["id"], s["name"]), ", ".join(f"{fmt_time(a)}~{fmt_time(b)}" for a, b in s["enroll"]) or "-")
            for s in people]
    if any(e["speaker"] == UNKNOWN_ID for e in entries):
        rows.append(UNKNOWN_ROW_ORIGINAL if original else UNKNOWN_ROW)
    _table(doc, rows, header=("이름", "목소리 샘플 구간"))
    doc.add_heading("녹취 내용", level=1)
    for line in _lines(case, entries):
        doc.add_paragraph(line)
    doc.add_heading("주의", level=1)
    for line in _notices(entries):
        doc.add_paragraph(line)
    doc.add_heading("처리 기록", level=1)
    for line in _processing_lines(case, entries):
        doc.add_paragraph(line)
    path = _out_path(case_id, "녹취록", ".docx")
    doc.save(str(path))
    case_store.append_log(case_id, "내보내기", file=f"exports/{path.name}", original_ok=check["ok"])
    return path


def export_txt(case_id: str) -> Path:
    case, entries, check = _load(case_id)
    parts = [_title(entries), "", "[원본 파일]"]
    parts += [f"{k}: {v}" for k, v in _original_rows(case)]
    parts += ["", "[무결성 확인]", _check_text(check), "", "[녹취 내용]"]
    parts += _lines(case, entries)
    parts += ["", "[주의]", *_notices(entries), "", "[처리 기록]"] + _processing_lines(case, entries)
    path = _out_path(case_id, "녹취록", ".txt")
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    case_store.append_log(case_id, "내보내기", file=f"exports/{path.name}", original_ok=check["ok"])
    return path


def export_log(case_id: str) -> Path:
    case, entries, check = _load(case_id)
    path = _out_path(case_id, "처리기록", ".json")
    case_store.append_log(case_id, "내보내기", file=f"exports/{path.name}", original_ok=check["ok"])
    case = case_store.public_case(case_store.load_case(case_id))
    names = _names(case)

    def brief(e):
        return {"id": e["id"], "time": fmt_time(e["start"]), "speaker": names.get(e["speaker"], e["speaker"]),
                "text": e["text"]}

    data = {"original": case["original"], "integrity_check": check, "edit": case.get("edit"),
            "speakers": case["speakers"],
            "processing": case.get("processing"), "reviewed": sum(1 for e in entries if e["reviewed"]),
            "entries": len(entries),
            "uncertain_entries": [dict(brief(e), start=e["start"], end=e["end"],
                                       original_ranges=e["original_ranges"], reviewed=e["reviewed"],
                                       excluded=bool(e.get("excluded"))) for e in entries if e.get("uncertain")],
            "excluded_entries": [dict(brief(e), reason=EXCLUDE_REASONS.get(e.get("exclude_reason"), "-"))
                                 for e in entries if e.get("excluded")],
            "manual_entries": [brief(e) for e in entries if e.get("source") == "manual" and not e.get("excluded")],
            "log": case["log"]}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
