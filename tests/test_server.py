import hashlib
import io
import json
import os
import stat
import threading
import time

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from truth_sound import case_store, config
from truth_sound.server import EncoderPool, PoolBlocked, create_app
from conftest import ToneEncoder, write_sine, write_tones


def _client(pipeline_fn=lambda cid, progress: None):
    return TestClient(create_app(pipeline_fn=pipeline_fn), base_url="http://127.0.0.1:8765")


def _upload(client, tmp_path, seconds=4.0):
    data = write_sine(tmp_path / "src.wav", seconds=seconds).read_bytes()
    r = client.post("/api/cases", files={"file": ("통화 녹음.wav", io.BytesIO(data), "audio/wav")},
                    data={"client_mtime": "1700000000.5"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _wait_job(client, states=("done", "error"), timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get("/api/jobs/current").json()
        if job["state"] in states:
            return job
        time.sleep(0.02)
    raise AssertionError(f"작업이 끝나지 않음: {job}")


def _transcript(cid, entries):
    (case_store.case_dir(cid) / "transcript.json").write_text(
        json.dumps({"entries": entries, "created_at": "t1", "models": {}}, ensure_ascii=False), encoding="utf-8")


def _entry(i, speaker, text):
    return {"id": f"e{i:04d}", "speaker": speaker, "start": float(i), "end": i + 1.0, "text": text,
            "words": [], "low": [], "reviewed": False, "source": f"track:{speaker}"}


def test_upload_and_get_case(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    case = c.get(f"/api/cases/{cid}").json()
    assert case["original"]["name"] == "통화 녹음.wav"
    assert case["original"]["client_mtime"] == 1700000000.5
    assert case["has_transcript"] is False
    assert [x["id"] for x in c.get("/api/cases").json()] == [cid]
    pk = c.get(f"/api/cases/{cid}/peaks?track=orig&n=100").json()
    assert len(pk["min"]) == 100 and abs(pk["duration"] - 4.0) < 0.05
    r = c.get(f"/api/cases/{cid}/audio/listen", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100
    assert c.get("/api/cases/20990101-000000-abcd").status_code == 404


def test_static_files_are_not_cached(home):
    c = _client()
    assert c.get("/").headers["cache-control"] == "no-store"
    assert c.get("/app.js").headers["cache-control"] == "no-store"


def test_speakers_validation_400(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    bad = c.put(f"/api/cases/{cid}/speakers", json={"speakers": [{"id": "me", "name": "나", "enroll": [[3, 9]]}]})
    assert bad.status_code == 400 and "구간" in bad.json()["detail"]
    ok = c.put(f"/api/cases/{cid}/speakers", json={"speakers": [{"id": "me", "name": "나", "enroll": [[0, 2]]},
                                                               {"id": "partner", "name": "상대", "enroll": [[2, 4]]}]})
    assert ok.status_code == 200
    assert [s["name"] for s in c.get(f"/api/cases/{cid}").json()["speakers"]] == ["나", "상대"]


def test_non_destructive_cut_updates_audio_samples_transcript_and_undo(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path, seconds=4.0)
    original = case_store.load_case(cid)
    original_path = case_store.case_dir(cid) / original["original"]["path"]
    before_hash = hashlib.sha256(original_path.read_bytes()).hexdigest()
    c.put(f"/api/cases/{cid}/speakers", json={"speakers": [
        {"id": "me", "name": "나", "enroll": [[0.5, 1.5]]},
        {"id": "partner", "name": "상대", "enroll": [[2.0, 3.0]]},
    ]})
    _transcript(cid, [
        dict(_entry(0, "me", "일부가 잘리는 줄"), start=0.5, end=1.5, reviewed=True),
        dict(_entry(1, "partner", "전부 잘리는 줄"), start=1.0, end=2.0),
        dict(_entry(2, "partner", "뒤에 남는 줄"), start=2.0, end=3.0),
    ])

    edit = c.get(f"/api/cases/{cid}").json()["edit"]
    r = c.post(f"/api/cases/{cid}/edits/cut", json={"start": 1.0, "end": 2.0,
                                                              "revision": edit["revision"]})
    assert r.status_code == 200, r.text
    case = c.get(f"/api/cases/{cid}").json()
    assert case["edit"]["duration"] == pytest.approx(3.0)
    assert case["original"]["probe"]["duration"] == pytest.approx(3.0)
    assert case["speakers"][0]["enroll"] == [[0.5, 1.0]]
    assert case["speakers"][1]["enroll"] == [[1.0, 2.0]]
    transcript = c.get(f"/api/cases/{cid}/transcript").json()["entries"]
    assert [e["text"] for e in transcript] == ["일부가 잘리는 줄", "뒤에 남는 줄"]
    assert transcript[0]["cut_review_required"] is True and transcript[0]["reviewed"] is False
    assert (transcript[1]["start"], transcript[1]["end"]) == (1.0, 2.0)
    audio = c.get(f"/api/cases/{cid}/audio/listen").content
    assert sf.info(io.BytesIO(audio)).duration == pytest.approx(3.0, abs=0.01)
    assert hashlib.sha256(original_path.read_bytes()).hexdigest() == before_hash == original["original"]["sha256"]
    assert c.get(f"/api/cases/{cid}/integrity").json()["ok"] is True

    stale = c.post(f"/api/cases/{cid}/edits/undo", json={"revision": 0})
    assert stale.status_code == 409
    rev = case["edit"]["revision"]
    assert c.post(f"/api/cases/{cid}/edits/undo", json={"revision": rev}).status_code == 200
    restored = c.get(f"/api/cases/{cid}").json()
    assert restored["edit"]["duration"] == pytest.approx(4.0)
    assert restored["speakers"][0]["enroll"] == [[0.5, 1.5]]
    assert len(c.get(f"/api/cases/{cid}/transcript").json()["entries"]) == 3
    assert c.post(f"/api/cases/{cid}/edits/redo",
                  json={"revision": restored["edit"]["revision"]}).status_code == 200


def test_process_runs_fake_pipeline(home, tmp_path):
    gate = threading.Event()

    def fake(cid, progress):
        progress("목소리 분리", 0.5, "나누는 중")
        gate.wait(5)
        _transcript(cid, [_entry(1, "me", "여보세요")])

    c = _client(fake)
    cid = _upload(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    job = _wait_job(c, states=("running",))
    assert job["case_id"] == cid
    assert c.post(f"/api/cases/{cid}/process").status_code == 409
    gate.set()
    job = _wait_job(c)
    assert job["state"] == "done" and job["case_id"] == cid
    assert c.get(f"/api/cases/{cid}").json()["has_transcript"] is True


def test_job_error_is_reported(home, tmp_path):
    def boom(cid, progress):
        raise RuntimeError("CUDA error: out of memory")

    c = _client(boom)
    cid = _upload(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    job = _wait_job(c)
    assert job["state"] == "error"
    assert "메모리가 부족" in job["message"] and "out of memory" in job["message"]


def test_transcript_put_updates_review(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요"), _entry(2, "partner", "돈은 보냈어요")])
    tr = c.get(f"/api/cases/{cid}/transcript").json()
    tr["entries"][1].update(text="돈은 안 보냈어요", reviewed=True, speaker="me", start=99.0)
    r = c.put(f"/api/cases/{cid}/transcript", json=tr)
    assert r.status_code == 200
    e = c.get(f"/api/cases/{cid}/transcript").json()["entries"][1]
    assert (e["text"], e["reviewed"], e["speaker"], e["start"]) == ("돈은 안 보냈어요", True, "me", 2.0)
    stale = dict(tr, created_at="older")
    assert c.put(f"/api/cases/{cid}/transcript", json=stale).status_code == 409


def test_integrity_endpoint_reports_mismatch(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    assert c.get(f"/api/cases/{cid}/integrity").json()["ok"] is True
    orig = case_store.case_dir(cid) / case_store.load_case(cid)["original"]["path"]
    os.chmod(orig, stat.S_IREAD | stat.S_IWRITE)
    with open(orig, "ab") as f:
        f.write(b"\0")
    assert c.get(f"/api/cases/{cid}/integrity").json()["ok"] is False


def test_export_and_download(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요")])
    out = c.post(f"/api/cases/{cid}/export").json()
    assert out["counts"] == {"reviewed": 0, "total": 1, "excluded": 0}
    for key in ("docx", "txt", "log"):
        name = out["files"][key].removeprefix("exports/")
        r = c.get(f"/api/cases/{cid}/files/{name}")
        assert r.status_code == 200 and len(r.content) > 0
    assert c.get(f"/api/cases/{cid}/files/..%2Fcase.json").status_code == 404


def test_put_transcript_accepts_excluded_and_manual_entry(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요"), _entry(2, "partner", "돈은 보냈어요")])
    manual = {"id": "m0a1b2c3d", "speaker": "bystander", "start": 1.5, "end": 3.0, "text": "작게 들린 말",
              "reviewed": True}
    body = {"created_at": "t1", "entries": [
        {"id": "e0002", "excluded": True, "exclude_reason": "bleed", "reviewed": True}, manual]}
    r = c.put(f"/api/cases/{cid}/transcript", json=body)
    assert r.status_code == 200 and r.json() == {"reviewed": 2, "total": 3, "excluded": 1}
    assert c.put(f"/api/cases/{cid}/transcript", json=body).json()["total"] == 3
    es = c.get(f"/api/cases/{cid}/transcript").json()["entries"]
    assert [e["id"] for e in es] == ["e0001", "m0a1b2c3d", "e0002"]
    m = es[1]
    assert (m["speaker"], m["start"], m["end"], m["source"], m["words"], m["low"]) == (
        "bystander", 1.5, 3.0, "manual", [], [])
    assert es[2]["excluded"] is True and es[2]["exclude_reason"] == "bleed"
    bad_reason = {"created_at": "t1", "entries": [{"id": "e0001", "excluded": True, "exclude_reason": "x"}]}
    assert c.put(f"/api/cases/{cid}/transcript", json=bad_reason).status_code == 400
    bad_time = {"created_at": "t1", "entries": [dict(manual, id="m0000000f", start=99.0)]}
    assert c.put(f"/api/cases/{cid}/transcript", json=bad_time).status_code == 400
    back = {"created_at": "t1", "entries": [{"id": "e0002", "excluded": False}]}
    e2 = [e for e in c.put(f"/api/cases/{cid}/transcript", json=back) and
          c.get(f"/api/cases/{cid}/transcript").json()["entries"] if e["id"] == "e0002"][0]
    assert e2["excluded"] is False and e2["exclude_reason"] is None


def test_rejects_foreign_host(home):
    c = TestClient(create_app(pipeline_fn=lambda cid, progress: None), base_url="http://evil.example:8765")
    assert c.get("/api/cases").status_code == 400
    assert TestClient(create_app(), base_url="http://localhost:8765").get("/api/cases").status_code == 200


def test_rejects_cross_origin_post(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/process", headers={"Origin": "http://evil.example"}).status_code == 403
    assert c.get("/api/jobs/current").json()["state"] == "idle"
    ok = c.put(f"/api/cases/{cid}/speakers", headers={"Origin": "http://127.0.0.1:8765"},
               json={"speakers": [{"id": "me", "name": "나", "enroll": [[0, 2]]}]})
    assert ok.status_code == 200


def test_put_transcript_accepts_unknown_speaker(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요"), _entry(2, "unknown", "누구세요")])
    tr = c.get(f"/api/cases/{cid}/transcript").json()
    tr["entries"][0]["speaker"] = "unknown"
    assert c.put(f"/api/cases/{cid}/transcript", json=tr).status_code == 200
    assert [e["speaker"] for e in c.get(f"/api/cases/{cid}/transcript").json()["entries"]] == ["unknown", "unknown"]
    tr = c.get(f"/api/cases/{cid}/transcript").json()
    tr["entries"][0]["speaker"] = "nobody"
    assert c.put(f"/api/cases/{cid}/transcript", json=tr).status_code == 400


def test_post_case_reports_same_sha(home, tmp_path):
    c = _client()
    first = _upload(c, tmp_path)
    data = write_sine(tmp_path / "src.wav", seconds=4.0).read_bytes()
    r = c.post("/api/cases", files={"file": ("다시.wav", io.BytesIO(data), "audio/wav")})
    assert r.status_code == 200
    assert r.json()["same"] == [first]
    assert c.post("/api/cases", files={"file": ("다른.wav", io.BytesIO(
        write_sine(tmp_path / "o.wav", seconds=2.0).read_bytes()), "audio/wav")}).json()["same"] == []


def test_delete_case_ok_and_409(home, tmp_path):
    c = _client()
    fresh = _upload(c, tmp_path)
    assert c.delete(f"/api/cases/{fresh}").json() == {"ok": True}
    assert c.get(f"/api/cases/{fresh}").status_code == 404
    assert (config.removed_dir() / fresh / "case.json").exists()
    used = _upload(c, tmp_path)
    case_store.set_speakers(used, [{"id": "me", "name": "나", "enroll": [[0.0, 1.0]]}])
    r = c.delete(f"/api/cases/{used}")
    assert r.status_code == 409 and r.json()["detail"]
    assert c.get(f"/api/cases/{used}").status_code == 200
    assert c.delete("/api/cases/20990101-000000-abcd").status_code == 404


def test_delete_case_locked_file_is_409_with_korean_detail(home, tmp_path, monkeypatch):
    # Windows: 미리 듣기가 listen.wav를 잡고 있으면 폴더 옮기기가 PermissionError. 맨 500이 아니라 설명 있는 409.
    c = _client()
    cid = _upload(c, tmp_path)

    def locked(src, dst):
        raise PermissionError(13, "다른 프로세스가 파일을 사용 중입니다")

    with monkeypatch.context() as m:
        m.setattr(os, "replace", locked)
        r = c.delete(f"/api/cases/{cid}")
    assert r.status_code == 409
    assert r.json()["detail"] == "녹음 파일을 읽는 중이라 지금은 치울 수 없습니다. 잠시 뒤 다시 누르세요."
    assert c.get(f"/api/cases/{cid}").status_code == 200  # 사건은 그대로 남아 다시 누를 수 있다
    assert c.delete(f"/api/cases/{cid}").json() == {"ok": True}


def test_delete_refused_while_job_running(home, tmp_path):
    gate = threading.Event()
    c = _client(lambda cid, progress: gate.wait(5))
    cid = _upload(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    _wait_job(c, states=("running",))
    try:
        assert c.delete(f"/api/cases/{cid}").status_code == 409
        assert case_store.case_dir(cid).exists()
    finally:
        gate.set()
        _wait_job(c)


# ---- 구간 단위 분석 API ----

def _upload_sr(client, tmp_path, seconds, sr, **kw):
    data = write_sine(tmp_path / "src.wav", seconds=seconds, sr=sr, **kw).read_bytes()
    r = client.post("/api/cases", files={"file": ("a.wav", io.BytesIO(data), "audio/wav")})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _add_track(cid, speaker, seconds, sr, amp=0.5):
    """처리 없이 분리 음성 트랙을 직접 만들어 사건에 등록한다."""
    d = case_store.case_dir(cid)
    rel = f"tracks/{speaker}.wav"
    write_sine(d / rel, seconds=seconds, sr=sr, amp=amp)
    case = case_store.load_case(cid)
    case["processing"] = {"tracks": {**((case.get("processing") or {}).get("tracks", {})), speaker: rel}}
    case_store.save_case(cid, case)
    return d / rel


def test_peaks_orig_window(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    r = c.get(f"/api/cases/{cid}/peaks?track=orig&start=1&end=2&n=50")
    assert r.status_code == 200, r.text
    pk = r.json()
    assert len(pk["min"]) == 50 and len(pk["max"]) == 50 and len(pk["clip"]) == 50
    assert pk["start"] == 1 and pk["end"] == 2 and abs(pk["duration"] - 4.0) < 0.01
    whole = c.get(f"/api/cases/{cid}/peaks?track=orig&n=10").json()  # 구간을 빼면 파일 전체
    assert whole["start"] == 0 and abs(whole["end"] - 4.0) < 0.01


def test_peaks_bad_values_400(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    base = f"/api/cases/{cid}/peaks?track=orig"
    assert c.get(f"{base}&start=2&end=1&n=10").status_code == 400
    assert c.get(f"{base}&start=1&end=1&n=10").status_code == 400
    assert c.get(f"{base}&start=0&end=1&n=0").status_code == 400
    assert c.get(f"{base}&start=0&end=1&n=20001").status_code == 400
    assert c.get(f"{base}&start=0&end=4.6&n=10").status_code == 400  # 길이 + 0.5초 넘음
    r = c.get(f"/api/cases/{cid}/peaks?track=nobody&start=0&end=1&n=10")
    assert r.status_code == 404 and "분리 음성" in r.json()["detail"]
    assert c.get(f"/api/cases/20990101-000000-abcd/peaks?track=orig&n=10").status_code == 404


def test_spectrogram_pitch_speech_analyze_ok(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    q = f"track=orig&start=0.5&end=2.5"
    sp = c.get(f"/api/cases/{cid}/spectrogram?{q}&cols=100").json()
    assert sp["cols"] == 100 and sp["rows"] == 128 and abs(sp["duration"] - 4.0) < 0.01
    pi = c.get(f"/api/cases/{cid}/pitch?{q}").json()
    assert pi["start"] == 0.5 and len(pi["f0"]) > 100 and abs(pi["duration"] - 4.0) < 0.01
    ss = c.get(f"/api/cases/{cid}/speech").json()
    assert isinstance(ss["speech"], list) and abs(ss["duration"] - 4.0) < 0.01
    an = c.get(f"/api/cases/{cid}/analyze?{q}")
    assert an.status_code == 200, an.text
    an = an.json()
    assert abs(an["duration"] - 2.0) < 0.01 and abs(an["track_duration"] - 4.0) < 0.01  # 구간 길이와 트랙 길이
    assert an["spectrum"]["db"] and an["speech_percent"] is not None
    _add_track(cid, "me", 4.0, 16000)
    an_me = c.get(f"/api/cases/{cid}/analyze?track=me&start=0&end=2")
    assert an_me.status_code == 200 and an_me.json()["speech_percent"] is not None


def test_pitch_over_60s_400(home, tmp_path):
    c = _client()
    cid = _upload_sr(c, tmp_path, 70.0, 8000)
    r = c.get(f"/api/cases/{cid}/pitch?track=orig&start=0&end=61")
    assert r.status_code == 400 and "60초" in r.json()["detail"]
    assert c.get(f"/api/cases/{cid}/pitch?track=orig&start=0&end=60").status_code == 200


def test_audio_clip_wav(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    r = c.get(f"/api/cases/{cid}/audio/clip?track=orig&start=0.5&end=1.5")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    x, sr = sf.read(io.BytesIO(r.content))
    assert abs(len(x) - sr) <= 1
    assert c.get(f"/api/cases/{cid}/audio/clip?track=orig&start=1&end=1").status_code == 400


def test_tracks_with_different_sr_align_in_seconds(home, tmp_path):
    c = _client()
    cid = _upload_sr(c, tmp_path, 3.7, 44100)
    _add_track(cid, "me", 3.3, 16000)
    a = c.get(f"/api/cases/{cid}/peaks?track=orig&start=1&end=2&n=100").json()
    b = c.get(f"/api/cases/{cid}/peaks?track=me&start=1&end=2&n=100").json()
    assert a["sr"] == 44100 and b["sr"] == 16000
    assert (a["start"], a["end"]) == (b["start"], b["end"]) == (1, 2)
    assert abs(a["duration"] - 3.7) < 0.01 and abs(b["duration"] - 3.3) < 0.01


def test_peaks_cache_refreshes_after_track_replaced(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    path = _add_track(cid, "me", 20.0, 16000, amp=0.2)
    url = f"/api/cases/{cid}/peaks?track=me&start=0&end=20&n=10"
    assert max(c.get(url).json()["max"]) < 0.25
    write_sine(path, seconds=21.0, sr=16000, amp=0.8)  # 다시 처리해 트랙이 바뀐 경우
    new = c.get(url.replace("end=20", "end=21")).json()
    assert max(new["max"]) > 0.75 and abs(new["duration"] - 21.0) < 0.01


def _case_snapshot(d):
    files = [d / "case.json", d / "transcript.json"]
    snap = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in files}
    snap["original"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (d / "original").iterdir()}
    return snap


def test_reading_does_not_change_case_files(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    _add_track(cid, "me", 4.0, 16000)
    _transcript(cid, [_entry(1, "me", "여보세요")])
    d = case_store.case_dir(cid)
    before = _case_snapshot(d)
    for track in ("orig", "me"):
        q = f"track={track}&start=0&end=3"
        for url in (f"peaks?{q}&n=30", f"spectrogram?{q}&cols=30", f"pitch?{q}", f"analyze?{q}",
                    f"audio/clip?{q}", "speech"):
            assert c.get(f"/api/cases/{cid}/{url}").status_code == 200, url
    assert _case_snapshot(d) == before


# ---- 닮음 점수 ----

def _sim_case(c, tmp_path, **encoder_kw):
    """200Hz(0~5초)·500Hz(5~10초) 녹음에 나=200Hz 구간, 상대방=500Hz 구간을 등록한 사건."""
    write_tones(tmp_path / "src.wav", [(200.0, 5.0), (500.0, 5.0)])
    r = c.post("/api/cases", files={"file": ("a.wav", io.BytesIO((tmp_path / "src.wav").read_bytes()), "audio/wav")})
    cid = r.json()["id"]
    speakers = [{"id": "me", "name": "나", "enroll": [[0.0, 4.0]]},
                {"id": "partner", "name": "상대방", "enroll": [[6.0, 9.0]]}]
    assert c.put(f"/api/cases/{cid}/speakers", json={"speakers": speakers}).status_code == 200
    return cid


def _sim_client(encoder, pipeline_fn=lambda cid, progress: None, idle=60.0):
    return TestClient(create_app(pipeline_fn=pipeline_fn, encoder_factory=lambda: encoder, encoder_idle_sec=idle),
                      base_url="http://127.0.0.1:8765")


class _SpyEncoder(ToneEncoder):
    def __init__(self):
        super().__init__()
        self.closed = 0

    def close(self):
        self.closed += 1


def test_similarity_api_and_409_while_processing(home, tmp_path):
    gate = threading.Event()
    c = TestClient(create_app(pipeline_fn=lambda cid, progress: gate.wait(5), encoder_factory=ToneEncoder),
                   base_url="http://127.0.0.1:8765")
    cid = _sim_case(c, tmp_path)
    url = f"/api/cases/{cid}/similarity"
    r = c.post(url, json={"track": "orig", "start": 6.0, "end": 8.0})
    assert r.status_code == 200, r.text
    scores = {s["id"]: s["score"] for s in r.json()["scores"]}
    assert scores["partner"] > scores["me"] and r.json()["short"] is False
    assert c.post(url, json={"track": "orig", "start": 8.0, "end": 6.0}).status_code == 400
    assert c.post(url, json={"track": "orig"}).status_code == 400
    assert c.post(url, json={"track": "ghost", "start": 1.0, "end": 2.0}).status_code == 404
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    _wait_job(c, states=("running",))
    try:
        r = c.post(url, json={"track": "orig", "start": 6.0, "end": 8.0})
        assert r.status_code == 409 and "처리 중에는 닮음 점수를 볼 수 없습니다." in r.json()["detail"]
    finally:
        gate.set()
        _wait_job(c)


def test_encoder_closed_when_job_starts(home, tmp_path):
    enc = _SpyEncoder()
    c = _sim_client(enc)
    cid = _sim_case(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0}).status_code == 200
    assert enc.closed == 0
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    _wait_job(c)
    assert enc.closed == 1


def test_encoder_closed_after_idle(home, tmp_path):
    enc = _SpyEncoder()
    c = _sim_client(enc, idle=0.05)
    cid = _sim_case(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0}).status_code == 200
    end = time.time() + 3
    while enc.closed == 0 and time.time() < end:
        time.sleep(0.02)
    assert enc.closed == 1


def test_similarity_not_saved(home, tmp_path):
    c = _sim_client(ToneEncoder())
    cid = _sim_case(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요")])
    d = case_store.case_dir(cid)
    before = _case_snapshot(d)
    assert c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0}).status_code == 200
    assert _case_snapshot(d) == before


class _SlowEncoder(_SpyEncoder):
    """embed_many가 풀어 줄 때까지 멈춘다. 계산 중에 close()가 불렸으면 실제 모델처럼 깨진다."""

    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.gate = threading.Event()

    def embed_many(self, clips):
        self.entered.set()
        self.gate.wait(5)
        if self.closed:
            raise AttributeError("model is None")
        return super().embed_many(clips)


def _similarity_in_thread(c, cid):
    out = {}
    t = threading.Thread(target=lambda: out.update(
        r=c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0})))
    t.start()
    return t, out


def test_pool_close_waits_for_running_similarity(home, tmp_path):
    enc = _SlowEncoder()
    c = _sim_client(enc)
    cid = _sim_case(c, tmp_path)
    t, out = _similarity_in_thread(c, cid)
    assert enc.entered.wait(5)
    closer = threading.Thread(target=c.app.state.encoders.close)  # 처리 시작이 부르는 것과 같다
    closer.start()
    time.sleep(0.2)
    assert enc.closed == 0  # 계산이 끝날 때까지 내리지 않는다
    enc.gate.set()
    t.join(5)
    closer.join(5)
    assert out["r"].status_code == 200 and len(out["r"].json()["scores"]) == 2
    assert enc.closed == 1


def test_idle_timer_does_not_close_during_similarity(home, tmp_path):
    enc = _SlowEncoder()
    c = _sim_client(enc, idle=0.05)
    cid = _sim_case(c, tmp_path)
    t, out = _similarity_in_thread(c, cid)
    assert enc.entered.wait(5)
    time.sleep(0.3)
    assert enc.closed == 0
    enc.gate.set()
    t.join(5)
    assert out["r"].status_code == 200 and len(out["r"].json()["scores"]) == 2
    end = time.time() + 3
    while enc.closed == 0 and time.time() < end:
        time.sleep(0.02)
    assert enc.closed == 1  # 끝난 뒤 유휴 시간이 지나면 내린다


def _counting_client(pipeline_fn=lambda cid, progress: None):
    made = []

    def factory():
        made.append(1)
        return ToneEncoder()
    c = TestClient(create_app(pipeline_fn=pipeline_fn, encoder_factory=factory), base_url="http://127.0.0.1:8765")
    return c, made


def test_similarity_does_not_load_model_while_job_running(home, tmp_path):
    gate = threading.Event()
    c, made = _counting_client(lambda cid, progress: gate.wait(5))
    cid = _sim_case(c, tmp_path)
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    _wait_job(c, states=("running",))
    try:
        r = c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0})
        assert r.status_code == 409 and made == []
    finally:
        gate.set()
        _wait_job(c)


def test_similarity_gate_crossed_between_early_check_and_use(home, tmp_path):
    gate = threading.Event()
    c, made = _counting_client(lambda cid, progress: gate.wait(5))
    cid = _sim_case(c, tmp_path)
    jobs = c.app.state.jobs
    real, calls = jobs.running, []

    def running(case_id=None):  # 처음(빠른 확인)에는 "안 돈다", 그 뒤(풀 안 확인)에는 진짜 값
        calls.append(1)
        return False if len(calls) == 1 else real(case_id)
    jobs.running = running
    assert jobs.start(cid)  # 빠른 확인과 모델 올리기 사이에 처리가 시작된 경우
    try:
        r = c.post(f"/api/cases/{cid}/similarity", json={"track": "orig", "start": 6.0, "end": 8.0})
        assert r.status_code == 409 and "처리 중에는 닮음 점수를 볼 수 없습니다." in r.json()["detail"]
        assert made == []
    finally:
        gate.set()
        jobs.running = real
        _wait_job(c)


def test_pool_refuses_use_while_exclusive_and_while_closing(home):
    made = []
    pool = EncoderPool(lambda: made.append(1) or ToneEncoder(), 60.0)
    with pool.exclusive():  # 처리 시작 중: close()와 jobs.start() 사이에도 새로 올리지 못한다
        with pytest.raises(PoolBlocked):
            with pool.use():
                pass
    assert made == []
    with pool.use():  # 풀린 뒤에는 다시 쓸 수 있다
        pass
    assert made == [1]
    # 쓰는 중에 close()가 기다리면 새 use()는 거절되어 close()가 굶지 않는다
    inside, release = threading.Event(), threading.Event()

    def hold():
        with pool.use():
            inside.set()
            release.wait(5)
    holder = threading.Thread(target=hold)
    holder.start()
    assert inside.wait(5)
    closer = threading.Thread(target=pool.close)
    closer.start()
    time.sleep(0.2)
    with pytest.raises(PoolBlocked):
        with pool.use():
            pass
    release.set()
    holder.join(5)
    closer.join(5)
    assert not closer.is_alive()


def test_pool_refuses_use_while_blocked_predicate_true(home):
    made = []
    pool = EncoderPool(lambda: made.append(1) or ToneEncoder(), 60.0, blocked=lambda: True)
    with pytest.raises(PoolBlocked):
        with pool.use():
            pass
    assert made == []


def test_process_job_reports_kind(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    assert c.get("/api/jobs/current").json()["kind"] is None
    assert c.post(f"/api/cases/{cid}/process").status_code == 202
    job = _wait_job(c)
    assert job["kind"] == "process" and job["speaker"] is None and job["step"] is None


def test_other_kind_job_does_not_block_transcript_edit(home, tmp_path):
    gate = threading.Event()
    c = _client()
    cid = _upload(c, tmp_path)
    _transcript(cid, [_entry(1, "me", "여보세요")])
    assert c.app.state.jobs.start(cid, kind="clarify", fn=lambda cid, progress: gate.wait(5), speaker="me", step="denoise")
    try:
        job = _wait_job(c, states=("running",))
        assert (job["kind"], job["speaker"], job["step"]) == ("clarify", "me", "denoise")
        tr = c.get(f"/api/cases/{cid}/transcript").json()
        assert c.put(f"/api/cases/{cid}/transcript", json=tr).status_code == 200
        assert c.put(f"/api/cases/{cid}/speakers", json={"speakers": [{"id": "me", "name": "나", "enroll": [[0, 2]]}]}).status_code == 200
        assert c.post(f"/api/cases/{cid}/process").status_code == 409
        assert c.delete(f"/api/cases/{cid}").status_code == 409
    finally:
        gate.set()
        _wait_job(c)


def test_transcribe_route_starts_job(home, tmp_path):
    seen = []

    def fake(cid, progress):
        seen.append(cid)
        _transcript(cid, [_entry(1, "unknown", "여보세요")])

    c = TestClient(create_app(transcribe_fn=fake), base_url="http://127.0.0.1:8765")
    cid = _upload(c, tmp_path)
    r = c.post(f"/api/cases/{cid}/transcribe")
    assert r.status_code == 202 and r.json()["kind"] == "transcribe" and r.json()["case_id"] == cid
    job = _wait_job(c)
    assert job["state"] == "done" and job["kind"] == "transcribe" and seen == [cid]
    assert c.get(f"/api/cases/{cid}").json()["has_transcript"] is True
    assert c.post("/api/cases/20990101-000000-abcd/transcribe").status_code == 404


def test_transcribe_route_409_when_busy(home, tmp_path):
    gate = threading.Event()
    c = TestClient(create_app(pipeline_fn=lambda cid, progress: gate.wait(5),
                              transcribe_fn=lambda cid, progress: gate.wait(5)), base_url="http://127.0.0.1:8765")
    cid = _upload(c, tmp_path)
    try:
        assert c.post(f"/api/cases/{cid}/process").status_code == 202
        assert c.post(f"/api/cases/{cid}/transcribe").status_code == 409
        gate.set()
        _wait_job(c)
        gate.clear()
        assert c.post(f"/api/cases/{cid}/transcribe").status_code == 202
        assert c.post(f"/api/cases/{cid}/process").status_code == 409
        _transcript(cid, [_entry(1, "unknown", "여보세요")])
        assert c.put(f"/api/cases/{cid}/transcript", json={"entries": []}).status_code == 409  # 도는 동안은 고칠 수 없다
    finally:
        gate.set()
        _wait_job(c)


def test_transcript_put_keeps_source(home, tmp_path):
    c = _client()
    cid = _upload(c, tmp_path)
    path = case_store.case_dir(cid) / "transcript.json"
    _transcript(cid, [_entry(1, "unknown", "여보세요")])
    data = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(dict(data, source="original"), ensure_ascii=False), encoding="utf-8")
    tr = c.get(f"/api/cases/{cid}/transcript").json()
    tr["entries"][0].update(text="여보세요?", reviewed=True)
    assert c.put(f"/api/cases/{cid}/transcript", json=tr).status_code == 200
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["source"] == "original" and saved["entries"][0]["text"] == "여보세요?"
