import json
import os
import stat

from docx import Document
from docx.shared import RGBColor

from truth_sound import case_store
from truth_sound.export import GUESS_NOTE, NOTICE, export_docx, export_log, export_txt
from conftest import write_sine


def _w(w, p):
    return {"w": w, "start": 0.0, "end": 0.0, "p": p}


def _case(tmp_path, reviewed=(False, False), extra=None):
    src = write_sine(tmp_path / "src.wav", seconds=4.0)
    cid = case_store.create_case(src, "통화.wav", 1700000000.0)
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[0, 2]]},
                                  {"id": "partner", "name": "상대방", "enroll": [[2, 4]]}])
    entries = [
        {"id": "e0001", "speaker": "me", "start": 1.0, "end": 2.0, "text": "여보세요 지금 괜찮으세요",
         "words": [_w("여보세요", 0.9), _w("지금", 0.3), _w("괜찮으세요", 0.9)], "low": [1],
         "reviewed": reviewed[0], "source": "track:me"},
        {"id": "e0002", "speaker": "partner", "start": 65.0, "end": 66.0, "text": "돈은 보냈어요.",
         "words": [_w("돈은", 0.9), _w("보냈어요.", 0.2)], "low": [1],
         "reviewed": reviewed[1], "source": "track:partner"},
    ]
    for e, x in zip(entries, extra or ()):
        e.update(x)
    (case_store.case_dir(cid) / "transcript.json").write_text(
        json.dumps({"entries": entries, "created_at": case_store.now_iso(), "models": {}}, ensure_ascii=False),
        encoding="utf-8")
    return cid


def _text(path):
    doc = Document(str(path))
    parts = [p.text for p in doc.paragraphs]
    parts += [c.text for t in doc.tables for row in t.rows for c in row.cells]
    return "\n".join(parts)


def test_uncertain_candidate_keeps_label_and_original_times(home, tmp_path):
    cid = _case(tmp_path, extra=({"uncertain": True, "start": 1.125, "end": 1.225}, {}))
    for text in (export_txt(cid).read_text(encoding="utf-8"), _text(export_docx(cid))):
        assert "[불확실 · 원본 확인 필요] 여보세요" in text
    row, = json.loads(export_log(cid).read_text(encoding="utf-8"))["uncertain_entries"]
    assert row["original_ranges"] == [[1.125, 1.225]]
    assert not row["reviewed"] and not row["excluded"]


def test_docx_draft_title_and_hash(home, tmp_path):
    cid = _case(tmp_path)
    path = export_docx(cid)
    assert path.parent.name == "exports" and path.suffix == ".docx"
    doc = Document(str(path))
    assert doc.paragraphs[0].text == "녹취록 (초안)"
    text = _text(path)
    assert case_store.load_case(cid)["original"]["sha256"] in text
    assert NOTICE in text


def test_docx_final_title_when_all_reviewed(home, tmp_path):
    cid = _case(tmp_path, reviewed=(True, True))
    doc = Document(str(export_docx(cid)))
    assert doc.paragraphs[0].text == "녹취록"
    assert "검수 2/2" in _text(export_docx(cid))


def test_docx_marks_low_conf_unreviewed(home, tmp_path):
    cid = _case(tmp_path, reviewed=(True, False))
    text = _text(export_docx(cid))
    assert "[00:00:01] 나: 여보세요 지금 괜찮으세요" in text
    assert "[00:01:05] 상대방: 돈은 보냈어요(?)." in text


def test_docx_warns_on_hash_mismatch(home, tmp_path):
    cid = _case(tmp_path)
    orig = case_store.case_dir(cid) / case_store.load_case(cid)["original"]["path"]
    os.chmod(orig, stat.S_IREAD | stat.S_IWRITE)
    with open(orig, "ab") as f:
        f.write(b"\0")
    doc = Document(str(export_docx(cid)))
    warn = [p for p in doc.paragraphs if "원본 파일이 등록 때와 다릅니다" in p.text]
    assert warn and warn[0].runs[0].font.color.rgb == RGBColor(0xC0, 0x00, 0x00)


def test_txt_contains_lines(home, tmp_path):
    cid = _case(tmp_path)
    text = export_txt(cid).read_text(encoding="utf-8")
    assert text.startswith("녹취록 (초안)")
    assert "[00:00:01] 나: 여보세요 지금(?) 괜찮으세요" in text
    assert case_store.load_case(cid)["original"]["sha256"] in text and NOTICE in text


def test_empty_unexcluded_line_blocks_final_title(home, tmp_path):
    cid = _case(tmp_path, reviewed=(True, True), extra=({}, {"text": "  "}))
    assert export_txt(cid).read_text(encoding="utf-8").startswith("녹취록 (초안)")
    cid = _case(tmp_path, reviewed=(True, True), extra=({}, {"text": "", "excluded": True, "exclude_reason": "noise"}))
    assert export_txt(cid).read_text(encoding="utf-8").startswith("녹취록" + chr(10))


def test_export_omits_excluded_line_and_counts_it(home, tmp_path):
    cid = _case(tmp_path, reviewed=(True, True), extra=({}, {"excluded": True, "exclude_reason": "bleed"}))
    for text in (export_txt(cid).read_text(encoding="utf-8"), _text(export_docx(cid))):
        assert "[00:00:01] 나: 여보세요 지금 괜찮으세요" in text
        assert "돈은 보냈어요" not in text
        assert "검수에서 뺀 줄 1개" in text


def test_export_log_lists_excluded_entries(home, tmp_path):
    manual = {"id": "m0a1b2c3d", "source": "manual", "words": [], "low": [], "text": "작게 들린 말"}
    cid = _case(tmp_path, reviewed=(True, True), extra=(manual, {"excluded": True, "exclude_reason": "bleed"}))
    data = json.loads(export_log(cid).read_text(encoding="utf-8"))
    assert data["excluded_entries"] == [{"id": "e0002", "time": "00:01:05", "speaker": "상대방",
                                         "text": "돈은 보냈어요.", "reason": "다른 사람 말이 새어 듦"}]
    assert data["manual_entries"] == [{"id": "m0a1b2c3d", "time": "00:00:01", "speaker": "나",
                                       "text": "작게 들린 말"}]


def _speaker_rows(path):
    return [[c.text for c in r.cells] for r in Document(str(path)).tables[1].rows]


def test_unknown_speaker_named_and_listed_in_table(home, tmp_path):
    cid = _case(tmp_path, extra=({}, {"speaker": "unknown"}))
    assert "[00:01:05] 화자 미상: 돈은 보냈어요(?)." in export_txt(cid).read_text(encoding="utf-8")
    assert _speaker_rows(export_docx(cid))[-1] == ["화자 미상", "어느 목소리 샘플과도 뚜렷이 닮지 않은 구간"]
    cid = _case(tmp_path, extra=({}, {"speaker": "unknown", "excluded": True, "exclude_reason": "bleed"}))
    assert json.loads(export_log(cid).read_text(encoding="utf-8"))["excluded_entries"][0]["speaker"] == "화자 미상"


def test_no_unknown_row_without_unknown_lines(home, tmp_path):
    rows = _speaker_rows(export_docx(_case(tmp_path)))
    assert [r[0] for r in rows] == ["이름", "나", "상대방"]


def test_short_guess_speaker_marked_until_reviewed(home, tmp_path):
    guess = {"short_guess": True}
    cid = _case(tmp_path, reviewed=(False, True), extra=(guess, guess))
    for text in (export_txt(cid).read_text(encoding="utf-8"), _text(export_docx(cid))):
        assert "[00:00:01] 나(추정): 여보세요 지금(?) 괜찮으세요" in text
        assert "[00:01:05] 상대방: 돈은 보냈어요." in text
        assert f"{GUESS_NOTE} (검수 전 1줄)" in text
    cid = _case(tmp_path, reviewed=(True, True), extra=(guess, guess))
    for text in (export_txt(cid).read_text(encoding="utf-8"), _text(export_docx(cid))):
        assert "(추정)" not in text and GUESS_NOTE not in text


def _original_only(tmp_path, **kw):
    """샘플·분리 없이 원본에서 받아쓴 사건."""
    cid = _case(tmp_path, extra=({"speaker": "unknown"}, {"speaker": "unknown"}), **kw)
    path = case_store.case_dir(cid) / "transcript.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(dict(data, source="original"), ensure_ascii=False), encoding="utf-8")
    case = case_store.load_case(cid)
    case["processing"] = {
        "started_at": "2026-11-02T10:00:00+09:00", "finished_at": "2026-11-02T10:01:00+09:00", "speakers": [],
        "models": {"separator": None, "encoder": None,
                   "transcriber": {"model": "fake-whisper", "device": "cpu", "compute_type": "int8"}},
        "settings": {}, "tracks": {}, "duplicates_excluded": 0,
        "transcribed_from_original": {"started_at": "2026-11-02T10:00:00+09:00",
                                      "finished_at": "2026-11-02T10:01:00+09:00"}}
    case_store.save_case(cid, case)
    return cid


def test_export_marks_no_separation(home, tmp_path):
    cid = _original_only(tmp_path)
    docx = export_docx(cid)
    assert _speaker_rows(docx) == [["이름", "목소리 샘플 구간"],
                                   ["화자 미상", "화자를 나누지 않고 받아 적었습니다. 원본을 들어 화자를 고르세요"]]
    for text in (export_txt(cid).read_text(encoding="utf-8"), _text(docx)):
        assert "목소리 분리: 하지 않음" in text and "None" not in text
        assert "원본에서 다시 받아쓴 시각: 2026-11-02T10:00:00+09:00 ~ 2026-11-02T10:01:00+09:00" in text
        assert "[00:00:01] 화자 미상: 여보세요 지금(?) 괜찮으세요" in text


def test_export_normal_transcript_keeps_unknown_row(home, tmp_path):
    cid = _case(tmp_path, extra=({}, {"speaker": "unknown"}))
    assert _speaker_rows(export_docx(cid))[-1] == ["화자 미상", "어느 목소리 샘플과도 뚜렷이 닮지 않은 구간"]
    assert "원본에서 다시 받아쓴" not in export_txt(cid).read_text(encoding="utf-8")


def test_export_empty_original_transcript(home, tmp_path):
    cid = _original_only(tmp_path)
    path = case_store.case_dir(cid) / "transcript.json"
    path.write_text(json.dumps({"entries": [], "created_at": "t", "models": {}, "source": "original"}), encoding="utf-8")
    assert _speaker_rows(export_docx(cid)) == [["이름", "목소리 샘플 구간"]]
    assert "검수 0/0줄" in export_txt(cid).read_text(encoding="utf-8")
    assert json.loads(export_log(cid).read_text(encoding="utf-8"))["entries"] == 0
