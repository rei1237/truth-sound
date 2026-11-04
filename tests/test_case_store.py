import os
import stat

import pytest

from truth_sound import case_store, config
from truth_sound.integrity import sha256_file
from conftest import write_sine


def _new_case(tmp_path, name="통화 녹음.wav", seconds=3.0):
    src = write_sine(tmp_path / "src.wav", seconds=seconds, sr=16000)
    return src, case_store.create_case(src, name, 1700000000.0)


def test_create_case_copies_readonly_and_hashes(home, tmp_path):
    src, cid = _new_case(tmp_path)
    d = case_store.case_dir(cid)
    orig = d / "original" / "통화 녹음.wav"
    assert orig.exists()
    assert not os.access(orig, os.W_OK)
    case = case_store.load_case(cid)
    assert case["original"]["sha256"] == sha256_file(src)
    assert case["original"]["client_mtime"] == 1700000000.0
    assert abs(case["original"]["probe"]["duration"] - 3.0) < 0.01
    assert case["status"] == "new"
    assert [s["id"] for s in case["speakers"]] == ["me", "partner", "bystander"]
    assert [s["name"] for s in case["speakers"]] == ["나", "상대방", "옆 사람"]
    assert (d / "work" / "listen.wav").exists()


def test_set_speakers_rejects_bad_ranges(home, tmp_path):
    _, cid = _new_case(tmp_path)
    ok = [{"id": "me", "name": "나", "enroll": [[0.0, 1.0]]},
          {"id": "partner", "name": "상대방", "enroll": [[1.0, 2.5]]}]
    with pytest.raises(ValueError):
        case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[2.0, 1.0]]}])
    with pytest.raises(ValueError):
        case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[1.0, 9.0]]}])
    with pytest.raises(ValueError):
        case_store.set_speakers(cid, [{"id": "me", "name": "  ", "enroll": []}])
    with pytest.raises(ValueError):
        case_store.set_speakers(cid, ok * 2)
    saved = case_store.set_speakers(cid, ok)
    assert case_store.load_case(cid)["speakers"] == saved
    assert saved[1]["enroll"] == [[1.0, 2.5]]


def test_verify_original_detects_change(home, tmp_path):
    _, cid = _new_case(tmp_path)
    assert case_store.verify_original(cid)["ok"] is True
    orig = case_store.case_dir(cid) / "original" / "통화 녹음.wav"
    os.chmod(orig, stat.S_IWRITE | stat.S_IREAD)
    orig.write_bytes(b"tampered")
    res = case_store.verify_original(cid)
    assert res["ok"] is False
    assert res["actual"] != res["expected"]


def test_list_cases_newest_first(home, tmp_path):
    _, first = _new_case(tmp_path)
    _, second = _new_case(tmp_path, name="두번째.m4a.wav")
    ids = [c["id"] for c in case_store.list_cases()]
    assert ids == [second, first]


def test_append_log_records_event(home, tmp_path):
    _, cid = _new_case(tmp_path)
    case_store.append_log(cid, "처리 시작", speakers=2)
    log = case_store.load_case(cid)["log"]
    assert log[-1]["event"] == "처리 시작"
    assert log[-1]["speakers"] == 2
    assert "at" in log[-1]


def test_set_speakers_rejects_reserved_unknown_id(home, tmp_path):
    _, cid = _new_case(tmp_path)
    with pytest.raises(ValueError, match="unknown"):
        case_store.set_speakers(cid, [{"id": "unknown", "name": "누구", "enroll": []}])


def _clipped_src(tmp_path):
    import numpy as np
    import soundfile as sf
    x = np.full(16000 * 4, 0.3, np.float32)
    x[:16000] = 1.0  # 4초 중 처음 1초는 꼭대기에 붙은 소리
    sf.write(str(tmp_path / "clip.wav"), x, 16000, subtype="PCM_16")
    return tmp_path / "clip.wav"


def test_create_case_stores_clipped_percent(home, tmp_path):
    cid = case_store.create_case(_clipped_src(tmp_path), "clip.wav", None)
    pct = case_store.load_case(cid)["original"]["clipped_percent"]
    assert abs(pct - 25.0) < 0.5
    assert pct == round(pct, 3)
    _, clean = _new_case(tmp_path)
    assert case_store.load_case(clean)["original"]["clipped_percent"] == 0.0


def test_list_cases_has_duration(home, tmp_path):
    _, cid = _new_case(tmp_path, seconds=3.0)
    item = case_store.list_cases()[0]
    assert item["id"] == cid and abs(item["duration"] - 3.0) < 0.01


def test_same_sha_finds_other_cases(home, tmp_path):
    src, first = _new_case(tmp_path)
    second = case_store.create_case(src, "다시 올림.wav", None)
    sha = case_store.load_case(second)["original"]["sha256"]
    assert case_store.same_sha(sha, second) == [first]
    assert sorted(case_store.same_sha(sha, "none")) == sorted([first, second])
    assert case_store.same_sha("0" * 64, second) == []


def test_remove_new_case_moves_to_removed(home, tmp_path):
    _, cid = _new_case(tmp_path)
    orig = case_store.case_dir(cid) / "original" / "통화 녹음.wav"
    sha = sha256_file(orig)
    dest = case_store.remove_new_case(cid)
    assert dest == config.removed_dir() / cid
    assert not case_store.case_dir(cid).exists()
    assert [c["id"] for c in case_store.list_cases()] == []
    assert sha256_file(dest / "original" / "통화 녹음.wav") == sha  # 원본은 지우지 않고 옮기기만 한다


def test_remove_refused_with_samples_or_transcript(home, tmp_path):
    _, cid = _new_case(tmp_path)
    case_store.set_speakers(cid, [{"id": "me", "name": "나", "enroll": [[0.0, 1.0]]}])
    with pytest.raises(case_store.Conflict):
        case_store.remove_new_case(cid)
    assert case_store.case_dir(cid).exists()
    _, cid2 = _new_case(tmp_path)
    (case_store.case_dir(cid2) / "transcript.json").write_text("{}", encoding="utf-8")
    with pytest.raises(case_store.Conflict):
        case_store.remove_new_case(cid2)
    assert case_store.case_dir(cid2).exists()


def test_set_speakers_rejects_orig(home, tmp_path):
    _, cid = _new_case(tmp_path)
    with pytest.raises(ValueError, match="orig"):
        case_store.set_speakers(cid, [{"id": "orig", "name": "원본", "enroll": []}])


def test_old_case_without_new_fields_lists_and_deletes_refused(home, tmp_path):
    import json
    _, cid = _new_case(tmp_path)
    f = case_store.case_dir(cid) / "case.json"
    case = json.loads(f.read_text(encoding="utf-8"))
    del case["original"]["clipped_percent"]
    del case["original"]["probe"]["duration"]
    case["speakers"][0]["enroll"] = [[0.5, 3.0], [1.0, 1.001]]
    case["status"] = "done"
    case["processing"] = {"started_at": "2026-10-31T19:00:00+09:00"}
    f.write_text(json.dumps(case, ensure_ascii=False, indent=2), encoding="utf-8")
    before = f.read_bytes()
    item = case_store.list_cases()[0]
    assert item["id"] == cid and item["duration"] is None
    with pytest.raises(case_store.Conflict):
        case_store.remove_new_case(cid)
    assert case_store.load_case(cid)["speakers"][0]["enroll"] == [[0.5, 3.0], [1.0, 1.001]]
    assert f.read_bytes() == before  # 읽기만 해서는 case.json을 다시 쓰지 않는다
