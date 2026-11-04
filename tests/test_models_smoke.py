"""실제 AI 모델 확인(내려받기·GPU 필요). TRUTHSOUND_MODEL_TESTS=1 일 때만 실행."""
import json
import os
import re
from difflib import SequenceMatcher

import numpy as np
import pytest
import soundfile as sf

from truth_sound import config

pytestmark = pytest.mark.skipif(os.environ.get("TRUTHSOUND_MODEL_TESTS") != "1",
                                reason="TRUTHSOUND_MODEL_TESTS=1 일 때만 실행")


@pytest.fixture(scope="module")
def call():
    config.setup_env()
    from fixtures import make_call
    return make_call()


def test_embed_many_matches_embed(call):
    # 길이가 다른 클립을 묶어도(wav_lens) 하나씩 뽑은 특징과 거의 같아야 한다
    from truth_sound.separate import SpeakerEncoder

    sr, mix = call["sr"], call["mix"]
    clips = [mix[int(1.0 * sr):int(1.6 * sr)], mix[int(2.0 * sr):int(3.0 * sr)], mix[int(0.5 * sr):int(3.5 * sr)]]
    enc = SpeakerEncoder()
    many = enc.embed_many(clips)
    one = np.stack([enc.embed(c) for c in clips])
    enc.close()
    sims = (many * one).sum(axis=1)
    print("embed_many 대 embed 코사인", np.round(sims, 4))
    assert (sims > 0.99).all()


def _cer(hyp, ref):
    norm = lambda s: re.sub(r"[^가-힣0-9]", "", s)
    return 1 - SequenceMatcher(None, norm(hyp), norm(ref)).ratio()


def test_pipeline_cer_gate(call, home, tmp_path):
    # 가짜 통화, 사람마다 샘플 1.0초(각 샘플 구간 가운데 ±0.5초)
    from fixtures import LINES
    from truth_sound import case_store
    from truth_sound.dsp import rms_db
    from truth_sound.pipeline import run_pipeline

    src = tmp_path / "통화.wav"
    sf.write(str(src), call["mix"], call["sr"], subtype="PCM_16")
    cid = case_store.create_case(src, "통화.wav", 1700000000.0)
    names = {"me": "나", "partner": "상대방", "bystander": "옆 사람"}
    enroll = {k: [[round((a + b) / 2 - 0.5, 3), round((a + b) / 2 + 0.5, 3)]]
              for k, ((a, b),) in call["enroll"].items()}
    case_store.set_speakers(cid, [{"id": k, "name": names[k], "enroll": enroll[k]} for k in names])
    run_pipeline(cid, lambda *a: None)

    d = case_store.case_dir(cid)
    p = case_store.load_case(cid)["processing"]
    entries = json.loads((d / "transcript.json").read_text(encoding="utf-8"))["entries"]
    kept = [e for e in entries if not e["excluded"]]  # 문서에 들어가는 줄만 잰다
    text = {k: " ".join(e["text"] for e in kept if e["speaker"] == k) for k in names}
    levels = {k: rms_db(sf.read(str(d / p["tracks"][k]), dtype="float32")[0]) for k in names}
    cers = {k: _cer(text[k], " ".join(LINES[k])) for k in names}
    print("판정 시간", p["assigned_seconds"], "경고", p["warnings"])
    print("자동으로 뺀 줄", [(e["speaker"], e["exclude_reason"], e["text"]) for e in entries if e["excluded"]])
    for k in names:
        print(f"{names[k]}: 트랙 {levels[k]:.1f} dB, CER {cers[k]:.2f}, {text[k]!r}")
    for k in names:
        assert levels[k] > -60, k
    assert cers["me"] <= 0.1
    assert cers["partner"] <= 0.15


def test_transcriber_korean_tts():
    config.setup_env()
    from fixtures import tts
    from truth_sound.transcribe import Transcriber

    t = Transcriber()
    segs = t.transcribe(tts("안녕하세요 오늘 날씨가 좋네요"), lambda p: None)
    info = t.info()
    t.close()
    text = "".join(s["text"] for s in segs)
    print(info, text)
    assert "안녕" in text
    assert all(0.0 <= w["p"] <= 1.0 for s in segs for w in s["words"])
