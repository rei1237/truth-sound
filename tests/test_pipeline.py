import hashlib
import json
import os
import stat

import numpy as np
import pytest
import soundfile as sf

from truth_sound import case_store, editing, pipeline
from truth_sound.diarize import WINDOW_SEC
from truth_sound.dsp import rms_db
from truth_sound.export import export_docx, export_txt
from truth_sound.pipeline import _asr_input, _track_names, run_pipeline
from truth_sound.short_sound import SETTINGS as SHORT_SETTINGS
from truth_sound.transcribe import SETTINGS as ASR_SETTINGS
from truth_sound.transcript import LOW_CONF
from conftest import ToneEncoder, sine, write_tones

STAGES = {"확인", "준비", "목소리 분리", "음성 보정", "받아쓰기", "정리"}
PARTS = [(200, 2.5), (None, 1.0), (330, 2.5)]  # 나 2.5초, 쉼 1초, 상대방 2.5초


class PassSeparator:
    """받은 소리를 첫 줄기로 그대로, 나머지 줄기는 무음으로 돌려준다."""
    name = "fake-separator"

    def __init__(self, n):
        self.n = n

    def run(self, seg):
        return np.stack([seg] + [np.zeros_like(seg)] * (self.n - 1))

    def close(self):
        pass


class BandSeparator(PassSeparator):
    """265Hz를 경계로 낮은 소리(나)와 높은 소리(상대방)를 다른 줄기로 나눈다."""

    def run(self, seg):
        spec = np.fft.rfft(seg)
        low = np.fft.rfftfreq(len(seg), 1 / 8000) < 265
        streams = [np.fft.irfft(spec * low, len(seg)), np.fft.irfft(spec * ~low, len(seg))]
        return np.stack(streams + [np.zeros_like(seg)] * (self.n - 2))


class FakeTranscriber:
    TEXTS = ["여보세요 지금 통화 괜찮으세요", "그 돈은 이미 다 보냈다고 몇 번을 말해요", "누구랑 통화하는 거야"]
    levels = []  # 받은 입력 크기(dBFS)

    def __init__(self):
        self.n = 0

    def transcribe(self, x16k, progress):
        FakeTranscriber.levels.append(rms_db(x16k))
        i = self.n % len(self.TEXTS)
        text, start = self.TEXTS[i], 0.5 + 2.0 * i
        self.n += 1
        progress(1.0)
        return [{"start": start, "end": start + 1.0, "text": text,
                 "words": [{"w": w, "start": start, "end": start + 1.0, "p": 0.9} for w in text.split()]}]

    def info(self):
        return {"model": "fake-whisper", "device": "cpu", "compute_type": "int8"}

    def close(self):
        pass


def _case(tmp_path, parts=None, me=None, partner=None):
    src = write_tones(tmp_path / "call.wav", parts or PARTS)
    cid = case_store.create_case(src, "call.wav", None)
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": me or []},
                                  {"id": "partner", "name": "상대방", "enroll": partner or []},
                                  {"id": "bystander", "name": "옆 사람", "enroll": []}])
    return cid


def _run(cid, progress=lambda *a: None, separator=PassSeparator):
    run_pipeline(cid, progress, separator, ToneEncoder, FakeTranscriber)


def _track(cid, name):
    return sf.read(str(case_store.case_dir(cid) / "tracks" / name))


def test_pipeline_with_fakes(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 1.0]], partner=[[4.0, 5.0]])
    events = []
    _run(cid, lambda stage, p, msg: events.append((stage, msg)))
    d = case_store.case_dir(cid)
    for name in ("청취보조_나.wav", "청취보조_상대방.wav"):
        x, sr = _track(cid, name)
        assert sr == 16000 and rms_db(x) > -40  # 두 사람 모두 무음 아님
        assert "청취 보조용 - 원본 아님 (Truth Sound)".encode("utf-8") in (d / "tracks" / name).read_bytes()
    assert not (d / "tracks" / "청취보조_화자확인필요.wav").exists()
    assert not (d / "tracks" / "청취보조_옆 사람.wav").exists()
    assert {s for s, _ in events} == STAGES
    assert events[0][0] == "확인" and events[-1][0] == "정리"
    assert ("목소리 분리", "누가 말하는지 찾는 중") in events
    assert ("목소리 분리", "목소리를 사람별로 나누는 중") in events
    case = case_store.load_case(cid)
    assert case["status"] == "done"
    assert set(case["processing"]["tracks"]) == {"me", "partner"}
    assert case["processing"]["tracks"]["me"] == "tracks/청취보조_나.wav"
    assert case["processing"]["models"]["transcriber"]["model"] == "fake-whisper"
    assert case["processing"]["warnings"] == []
    a = case["processing"]["assigned_seconds"]
    assert a["me"] > 0 and a["partner"] > 0 and a["unknown"] == 0
    tr = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert {e["speaker"] for e in tr["entries"]} == {"me", "partner"}
    assert [e["id"] for e in tr["entries"]] == ["e0001", "e0002"]
    events = [x["event"] for x in case["log"]]
    assert "처리 시작" in events and "처리 완료" in events
    assert case["log"][-1]["assigned_seconds"] == a


def test_pipeline_reprocesses_edited_timeline_but_keeps_source_length_tracks(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 1.0]], partner=[[4.0, 5.0]])
    case = case_store.load_case(cid)
    case["edits"] = editing.add_cut(case.get("edits"), 2.5, 3.5, 6.0, "t")
    case_store.save_case(cid, case)
    _run(cid)
    saved = case_store.load_case(cid)
    assert saved["processing"]["edit_revision"] == 1
    assert saved["processing"]["speakers"][1]["enroll"] == [[3.0, 4.0]]
    for rel in saved["processing"]["tracks"].values():
        assert sf.info(str(case_store.case_dir(cid) / rel)).duration == pytest.approx(6.0, abs=0.01)
    entries = json.loads((case_store.case_dir(cid) / "transcript.json").read_text(encoding="utf-8"))["entries"]
    assert all("source_ranges" in entry for entry in entries)


def test_pipeline_records_time_window_settings(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 1.0]], partner=[[4.0, 5.0]])
    _run(cid)
    s = case_store.load_case(cid)["processing"]["settings"]
    assert s["speaker_assignment"] == "time_window"
    assert s["window_sec"] == 0.6 and s["hop_sec"] == 0.2
    assert s["min_similarity"] == 0.30 and s["min_margin"] == 0.03
    assert s["smooth_windows"] == 3 and s["refine_passes"] == 1
    assert s["voiced_rule"] == "창 크기 > max(min(하위 10% + 8dB, 최대 − 20dB), −70dB)"
    assert s["overlap_stream_min_db"] == -30
    assert s["asr_input"] == "level_normalized_-20dBFS"
    assert s["track_sr"] == 16000 and s["output_sr"] == 16000
    assert s["separation_sr"] == 8000 and s["chunk_sec"] == 8.0 and s["overlap_sec"] == 1.0
    assert s["low_confidence_below"] == LOW_CONF and s["transcription"] == ASR_SETTINGS


def test_short_sound_guess_marks_line_and_is_recorded(home, tmp_path, monkeypatch):
    seen = {}

    def guess_partner_in_gap(x16, starts, labels, n_people):
        # 쉼(2.5~3.5초) 가운데 창들을 상대방의 짧은 소리로 다시 정했다고 친다
        c = np.asarray(starts) + WINDOW_SEC / 2
        g = (c > 2.6) & (c < 3.2) & (labels < 0)
        new = labels.copy()
        new[g] = 1
        seen["n"] = int(g.sum())
        return new, g

    monkeypatch.setattr(pipeline, "rejudge", guess_partner_in_gap)
    cid = _case(tmp_path, me=[[0, 1.0]], partner=[[4.0, 5.0]])
    _run(cid)
    tr = json.loads((case_store.case_dir(cid) / "transcript.json").read_text(encoding="utf-8"))
    flags = {e["speaker"]: e.get("short_guess", False) for e in tr["entries"]}
    assert seen["n"] > 0 and flags == {"me": False, "partner": True}
    p = case_store.load_case(cid)["processing"]
    assert p["short_guess_windows"] == seen["n"] and p["settings"]["short_sound"] == SHORT_SETTINGS


def test_asr_gets_level_normalised_unenhanced_audio(home, tmp_path):
    FakeTranscriber.levels.clear()
    _run(_case(tmp_path, me=[[0, 1.0]], partner=[[4.0, 5.0]]))
    assert FakeTranscriber.levels and all(abs(v + 20) < 0.5 for v in FakeTranscriber.levels)


def test_asr_input_leaves_silence():
    z = np.zeros(1600, np.float32)
    assert not _asr_input(z).any() and np.isfinite(_asr_input(z)).all()


def test_unknown_track_and_lines_when_voice_matches_nobody(home, tmp_path):
    # 500Hz 3초 = 소리 있는 창의 약 40%가 누구와도 닮지 않음
    cid = _case(tmp_path, parts=[(200, 2.0), (500, 3.0), (330, 2.0)], me=[[0, 1.0]], partner=[[5.5, 6.5]])
    _run(cid)
    case = case_store.load_case(cid)
    assert case["processing"]["tracks"]["unknown"] == "tracks/청취보조_화자확인필요.wav"
    assert rms_db(_track(cid, "청취보조_화자확인필요.wav")[0]) > -40
    assert case["processing"]["assigned_seconds"]["unknown"] > 0
    entries = json.loads((case_store.case_dir(cid) / "transcript.json").read_text(encoding="utf-8"))["entries"]
    assert "unknown" in {e["speaker"] for e in entries}
    assert any(w.startswith("화자를 확인하지 못한 구간이 ") for w in case["processing"]["warnings"])


def test_warns_when_person_only_found_inside_sample(home, tmp_path):
    cid = _case(tmp_path, parts=[(200, 2.5), (None, 1.0), (330, 0.5), (None, 2.0)],
                me=[[0, 1.0]], partner=[[3.0, 4.5]])
    _run(cid)
    case = case_store.load_case(cid)
    assert case["processing"]["assigned_seconds"]["partner"] == 0
    assert ("상대방: 목소리 샘플로 지정한 곳 말고는 이 사람으로 판정된 구간이 없습니다. "
            "그 사람 혼자 말하는 곳을 더 길게 지정해 다시 처리해 보세요.") in case["processing"]["warnings"]


def test_warns_when_voice_sample_is_clipped(home, tmp_path):
    # 실제 사례: 증폭해 저장한 녹음은 상대방 샘플의 70% 넘게 잘린 소리였다
    loud = np.clip(sine(2.5, 16000, freq=330, amp=3.0), -1, 1)  # |sin| ≥ 0.33인 79%가 잘림
    x = np.concatenate([sine(2.5, 16000, freq=200, amp=0.3), np.zeros(16000, np.float32), loud])
    sf.write(str(tmp_path / "loud.wav"), x, 16000, subtype="PCM_16")
    cid = case_store.create_case(tmp_path / "loud.wav", "loud.wav", None)
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[0, 1.0]]},
                                  {"id": "partner", "name": "상대방", "enroll": [[4.0, 5.0]]}])
    _run(cid)
    w = case_store.load_case(cid)["processing"]["warnings"]
    assert ("상대방: 목소리 샘플의 79%가 잘린 소리라 음색이 달라져 화자 판정이 틀리기 쉽습니다. "
            "잘리지 않은 곳을 샘플로 고르세요.") in w
    assert ("녹음의 33%가 너무 커서 잘린 소리입니다. 증폭해 저장한 파일이면 증폭하기 전 원래 녹음을 "
            "등록하세요. 작은 목소리는 Truth Sound가 알아서 키웁니다.") in w
    assert not any(s.startswith("나:") for s in w)


def test_pipeline_very_short_recording(home, tmp_path):
    # 0.4초 녹음은 창이 하나뿐이고 가운데(0.3초)가 상대방 샘플 안이라 상대방으로 고정된다.
    # 그 창 안의 내 목소리는 분리 줄기로 나에게 가야 한다.
    cid = _case(tmp_path, parts=[(200, 0.2), (330, 0.2)], me=[[0, 0.2]], partner=[[0.2, 0.4]])
    _run(cid, separator=BandSeparator)
    assert case_store.load_case(cid)["status"] == "done"
    assert rms_db(_track(cid, "청취보조_나.wav")[0]) > -40
    assert rms_db(_track(cid, "청취보조_상대방.wav")[0]) > -40


def test_pipeline_44k_recording_with_odd_length(home, tmp_path):
    # 44.1kHz 0.4초(17643표본)는 16k로 6401, 8k로 3200표본이 된다. 끝 창이 줄기를 써도 처리가 끝나야 한다
    t = np.arange(17643) / 44100
    x = np.where(t < 0.2, np.sin(2 * np.pi * 200 * t), np.sin(2 * np.pi * 330 * t)) * 0.3
    sf.write(str(tmp_path / "call.wav"), x.astype(np.float32), 44100, subtype="PCM_16")
    cid = case_store.create_case(tmp_path / "call.wav", "call.wav", None)
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[0, 0.2]]},
                                  {"id": "partner", "name": "상대방", "enroll": [[0.2, 0.4]]},
                                  {"id": "bystander", "name": "옆 사람", "enroll": []}])
    _run(cid, separator=BandSeparator)
    assert case_store.load_case(cid)["status"] == "done"
    assert rms_db(_track(cid, "청취보조_나.wav")[0]) > -40


def test_track_names_unknown():
    assert _track_names([{"id": "me", "name": "나"}], with_unknown=True)["unknown"] == "청취보조_화자확인필요.wav"
    assert "unknown" not in _track_names([{"id": "me", "name": "나"}])


def test_pipeline_rejects_missing_enrollment(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]])
    with pytest.raises(ValueError):
        _run(cid)
    short = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 3.1]])  # 0.1초뿐
    with pytest.raises(ValueError):
        _run(short)
    assert case_store.load_case(cid)["status"] == "new"


def test_pipeline_accepts_very_short_enrollment(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 0.3]], partner=[[4, 4.3]])  # '네' 한마디 길이
    _run(cid)
    assert case_store.load_case(cid)["status"] == "done"


def test_pipeline_stops_on_hash_mismatch(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    d = case_store.case_dir(cid)
    orig = d / case_store.load_case(cid)["original"]["path"]
    os.chmod(orig, stat.S_IREAD | stat.S_IWRITE)
    with open(orig, "ab") as f:
        f.write(b"\0\0")
    with pytest.raises(RuntimeError):
        _run(cid)
    case = case_store.load_case(cid)
    assert case["status"] == "error"
    assert any("불일치" in x["event"] for x in case["log"])
    assert not (d / "transcript.json").exists()


class FailingTranscriber(FakeTranscriber):
    def transcribe(self, x16k, progress):
        raise RuntimeError("받아쓰기 실패")


def _tracks(d):
    return {p.name: p.read_bytes() for p in (d / "tracks").iterdir()}


def _set_enroll(cid, me, partner):
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": me},
                                  {"id": "partner", "name": "상대방", "enroll": partner},
                                  {"id": "bystander", "name": "옆 사람", "enroll": []}])


def test_failed_reprocess_keeps_previous_tracks(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    d = case_store.case_dir(cid)
    before, processing = _tracks(d), case_store.load_case(cid)["processing"]
    _set_enroll(cid, me=[[3, 5.5]], partner=[[0, 2.5]])  # 샘플을 맞바꿔 다시 처리하면 트랙 내용이 바뀐다
    with pytest.raises(RuntimeError):
        run_pipeline(cid, lambda *a: None, PassSeparator, ToneEncoder, FailingTranscriber)
    assert _tracks(d) == before
    assert case_store.load_case(cid)["processing"] == processing
    _run(cid)
    after = _tracks(d)
    assert after.keys() == before.keys() and after != before
    kept = [p for p in (d / "work").iterdir() if p.name.startswith("tracks_before_")]
    assert len(kept) == 1 and {p.name: p.read_bytes() for p in kept[0].iterdir()} == before


def test_track_names_keep_prefix_with_slash():
    names = _track_names([{"id": "me", "name": "나/본인"}, {"id": "partner", "name": "..\\상대:방"}])
    assert names["me"] == "청취보조_나_본인.wav"
    assert names["partner"].startswith("청취보조_") and names["partner"].endswith("상대_방.wav")


def test_export_speaker_table_uses_processing_snapshot(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    d = case_store.case_dir(cid)
    p = case_store.load_case(cid)["processing"]
    assert p["speakers"] == [{"id": "me", "name": "나", "enroll": [[0, 2.5]]},
                             {"id": "partner", "name": "상대방", "enroll": [[3, 5.5]]}]
    assert p["track_sha256"]["me"] == hashlib.sha256((d / p["tracks"]["me"]).read_bytes()).hexdigest()
    case_store.set_speakers(cid, [{"id": "me", "name": "김철수", "enroll": [[1, 4]]},
                                  {"id": "partner", "name": "상대방", "enroll": [[3, 5.5]]},
                                  {"id": "bystander", "name": "옆 사람", "enroll": []}])
    doc = __import__("docx").Document(str(export_docx(cid)))
    cells = [c.text for t in doc.tables for row in t.rows for c in row.cells]
    assert "김철수" in cells and "00:00:00~00:00:02" in cells and "00:00:01~00:00:04" not in cells


class OtherTranscriber(FakeTranscriber):
    def info(self):
        return {"model": "other-whisper", "device": "cpu", "compute_type": "int8"}


class SilentTranscriber(FakeTranscriber):
    def transcribe(self, x16k, progress):
        progress(1.0)
        return []


def _transcribe(cid, transcriber=FakeTranscriber):
    pipeline.run_transcribe(cid, lambda *a: None, transcriber)


def _transcript_file(cid):
    return case_store.case_dir(cid) / "transcript.json"


def test_transcribe_without_samples(home, tmp_path):
    cid = _case(tmp_path)  # 목소리 샘플이 하나도 없는 사건
    events = []
    pipeline.run_transcribe(cid, lambda stage, p, msg: events.append(stage), FakeTranscriber)
    d = case_store.case_dir(cid)
    t = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    assert t["source"] == "original" and t["entries"]
    assert {e["speaker"] for e in t["entries"]} == {"unknown"}
    case = case_store.load_case(cid)
    assert case["processing"]["tracks"] == {} and case["processing"]["speakers"] == []
    assert case["processing"]["models"]["separator"] is None
    assert case["processing"]["original_check"]["ok"] is True
    assert case["processing"]["transcribed_from_original"].keys() == {
        "started_at", "finished_at", "segments", "entries", "rejected"}
    assert case["processing"]["transcribed_from_original"]["entries"] == 1
    assert case["status"] == "done"
    assert not list((d / "tracks").iterdir())
    assert set(events) == {"확인", "준비", "받아쓰기", "정리"}
    log = [x["event"] for x in case["log"]]
    assert "받아쓰기 시작" in log and "받아쓰기 완료" in log


def test_transcribe_with_exactly_one_sample_still_transcribes_original(home, tmp_path):
    cid = _case(tmp_path, me=[[0.0, 2.0]])

    _transcribe(cid)

    transcript = json.loads(_transcript_file(cid).read_text(encoding="utf-8"))
    case = case_store.load_case(cid)
    assert transcript["entries"] and transcript["source"] == "original"
    assert {entry["speaker"] for entry in transcript["entries"]} == {"unknown"}
    assert case["speakers"][0]["enroll"] == [[0.0, 2.0]]
    assert case["processing"]["transcribed_from_original"]["entries"] == 1


def test_transcribe_uses_level_normalised_original(home, tmp_path):
    FakeTranscriber.levels.clear()
    _transcribe(_case(tmp_path))
    assert len(FakeTranscriber.levels) == 1 and abs(FakeTranscriber.levels[0] + 20) < 0.5


def test_transcribe_keeps_existing_tracks_and_backs_up_transcript(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    d = case_store.case_dir(cid)
    before = _tracks(d)
    p = case_store.load_case(cid)["processing"]
    old_transcript = _transcript_file(cid).read_bytes()
    _transcribe(cid, OtherTranscriber)
    after = case_store.load_case(cid)["processing"]
    assert _tracks(d) == before
    for key in ("tracks", "track_sha256", "assigned_seconds", "speakers", "started_at", "finished_at"):
        assert after[key] == p[key]
    assert after["models"]["transcriber"]["model"] == "other-whisper"
    assert after["models"]["separator"] == "fake-separator" and after["models"]["encoder"] == "fake-encoder"
    assert after["settings"]["separation_sr"] == p["settings"]["separation_sr"]  # 분리 설정은 그대로
    assert after["transcribed_from_original"].keys() == {
        "started_at", "finished_at", "segments", "entries", "rejected"}
    kept = [f for f in (d / "work").iterdir() if f.name.startswith("transcript_before_")]
    assert len(kept) == 1 and kept[0].read_bytes() == old_transcript
    assert json.loads(_transcript_file(cid).read_text(encoding="utf-8"))["source"] == "original"


def test_transcribe_adds_clip_warning_once(home, tmp_path):
    loud = np.clip(sine(2.5, 16000, freq=330, amp=3.0), -1, 1)
    sf.write(str(tmp_path / "loud.wav"), loud, 16000, subtype="PCM_16")
    fresh = case_store.create_case(tmp_path / "loud.wav", "loud.wav", None)
    separated = case_store.create_case(tmp_path / "loud.wav", "loud.wav", None)
    case_store.set_speakers(separated, [{"id": "me", "name": "나", "enroll": [[0, 1.0]]},
                                        {"id": "partner", "name": "상대방", "enroll": [[1.5, 2.5]]}])
    _run(separated)
    for cid in (fresh, separated):
        _transcribe(cid)
        _transcribe(cid)
        w = case_store.load_case(cid)["processing"]["warnings"]
        assert len([x for x in w if "잘린 소리입니다" in x]) == 1


def test_transcribe_stops_on_original_mismatch(home, tmp_path):
    cid = _case(tmp_path)
    d = case_store.case_dir(cid)
    orig = d / case_store.load_case(cid)["original"]["path"]
    os.chmod(orig, stat.S_IREAD | stat.S_IWRITE)
    with open(orig, "ab") as f:
        f.write(b"\0\0")
    with pytest.raises(RuntimeError):
        _transcribe(cid)
    assert not (d / "transcript.json").exists()
    assert case_store.load_case(cid)["status"] == "new"


def test_transcribe_failure_keeps_status_and_transcript(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    d = case_store.case_dir(cid)
    transcript, tracks = _transcript_file(cid).read_bytes(), _tracks(d)
    processing = case_store.load_case(cid)["processing"]
    with pytest.raises(RuntimeError):
        _transcribe(cid, FailingTranscriber)
    case = case_store.load_case(cid)
    assert case["status"] == "done" and case["processing"] == processing
    assert _transcript_file(cid).read_bytes() == transcript and _tracks(d) == tracks
    assert case["log"][-1]["event"] == "받아쓰기 실패"


def test_transcribe_silent_recording_makes_empty_transcript(home, tmp_path):
    cid = _case(tmp_path)
    _transcribe(cid, SilentTranscriber)
    t = json.loads(_transcript_file(cid).read_text(encoding="utf-8"))
    assert t["entries"] == [] and t["source"] == "original"
    case = case_store.load_case(cid)
    assert case["status"] == "done"
    assert any(w.startswith("받아쓸 수 있는 분명한 말소리를") for w in case["processing"]["warnings"])
    assert case["processing"]["transcribed_from_original"]["entries"] == 0
    export_docx(cid)
    export_txt(cid)


def test_transcribe_keeps_high_no_speech_caption_for_review(home, tmp_path):
    class Hallucinating(FakeTranscriber):
        def transcribe(self, x16k, progress):
            progress(1.0)
            return [{"start": 0.0, "end": 1.2, "text": "자막 제공 배달의민족", "no_speech": 0.75,
                     "words": [{"w": "자막", "start": 0.0, "end": 0.6, "p": 0.5},
                               {"w": "제공", "start": 0.6, "end": 0.8, "p": 0.6},
                               {"w": "배달의민족", "start": 0.8, "end": 1.2, "p": 0.88}]}]

    cid = _case(tmp_path, parts=[(330, 1.4)])
    _transcribe(cid, Hallucinating)

    transcript = json.loads(_transcript_file(cid).read_text(encoding="utf-8"))
    case = case_store.load_case(cid)
    stats = case["processing"]["transcribed_from_original"]
    assert transcript["entries"][0]["uncertain"] and not transcript["entries"][0]["excluded"]
    assert stats["segments"] == stats["entries"] == 1 and stats["rejected"] == 0
    assert case["log"][-1]["rejected"] == 0


def test_separation_after_transcribe_clears_source(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _transcribe(cid)
    _run(cid)
    t = json.loads(_transcript_file(cid).read_text(encoding="utf-8"))
    assert "source" not in t and {e["speaker"] for e in t["entries"]} == {"me", "partner"}
    p = case_store.load_case(cid)["processing"]
    assert "transcribed_from_original" not in p and set(p["tracks"]) == {"me", "partner"}


def test_transcribe_leaves_done_status_alone_while_running(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    seen = []

    class Watching(FakeTranscriber):
        def transcribe(self, x16k, progress):
            seen.append(case_store.load_case(cid)["status"])
            return super().transcribe(x16k, progress)

    _transcribe(cid, Watching)
    assert seen == ["done"] and case_store.load_case(cid)["status"] == "done"


def test_transcribe_mismatch_on_done_case_keeps_done(home, tmp_path):
    cid = _case(tmp_path, me=[[0, 2.5]], partner=[[3, 5.5]])
    _run(cid)
    d = case_store.case_dir(cid)
    transcript = _transcript_file(cid).read_bytes()
    orig = d / case_store.load_case(cid)["original"]["path"]
    os.chmod(orig, stat.S_IREAD | stat.S_IWRITE)
    with open(orig, "ab") as f:
        f.write(b"\0\0")
    with pytest.raises(RuntimeError):
        _transcribe(cid)
    assert case_store.load_case(cid)["status"] == "done" and _transcript_file(cid).read_bytes() == transcript


def test_transcribe_restores_status_on_base_exception(home, tmp_path):
    class Killed(BaseException):
        pass

    class Dying(FakeTranscriber):
        def transcribe(self, x16k, progress):
            assert case_store.load_case(cid)["status"] == "processing"  # new 사건은 도는 동안 처리 중으로 표시한다
            raise Killed()

    cid = _case(tmp_path)
    with pytest.raises(Killed):
        _transcribe(cid, Dying)
    case = case_store.load_case(cid)
    assert case["status"] == "new" and case["log"][-1]["event"] == "받아쓰기 실패"
    assert not _transcript_file(cid).exists()
