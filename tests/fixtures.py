"""Windows 한국어 음성 합성(Heami)으로 가짜 3인 통화를 만든다. 모델 스모크 테스트와 데모용."""
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt

from truth_sound.audio_io import load_audio
from truth_sound.dsp import resample

SR = 16000

LINES = {
    "me": ["여보세요, 지금 통화 괜찮으세요?", "네 알겠습니다. 그럼 내일 다시 연락드릴게요."],
    "partner": ["네, 말씀하세요. 무슨 일이신데요?", "그 돈은 이미 다 보냈다고 몇 번을 말해요."],
    "bystander": ["거기 서류는 내가 어제 다 치워 버렸어.", "아니야, 아직 한 푼도 안 보냈잖아."],
}


def tts(text: str, rate: int = 0) -> np.ndarray:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "tts.wav"
        ps = ("Add-Type -AssemblyName System.Speech; "
              "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              "$s.SelectVoice('Microsoft Heami Desktop'); "
              f"$s.Rate = {rate}; $s.SetOutputToWaveFile('{out}'); "
              f"$s.Speak('{text}'); $s.Dispose()")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, capture_output=True)
        return load_audio(out, SR)


def shift(x: np.ndarray, factor: float) -> np.ndarray:
    """factor>1이면 목소리가 높고 빨라진다. 같은 합성 음성을 다른 사람처럼 만든다."""
    return resample(x, int(SR * factor), SR)


def far_field(x: np.ndarray, db: float) -> np.ndarray:
    """멀리서 들린 목소리: 고음 감소, 약한 울림, 작은 음량."""
    y = sosfilt(butter(4, 2800, btype="lowpass", fs=SR, output="sos"), x)
    ir = np.zeros(int(0.25 * SR))
    ir[0] = 1.0
    rng = np.random.default_rng(3)
    tail = rng.standard_normal(len(ir) - 1) * np.exp(-np.arange(len(ir) - 1) / (0.05 * SR)) * 0.25
    ir[1:] = tail
    y = np.convolve(y, ir)[: len(x)]
    return (y / (np.sqrt(np.mean(y ** 2)) + 1e-12) * 10 ** (db / 20)).astype(np.float32)


def _norm(x, db):
    return (x / (np.sqrt(np.mean(x ** 2)) + 1e-12) * 10 ** (db / 20)).astype(np.float32)


def make_call(seed: int = 0) -> dict:
    """반환: mix(16k), refs{화자: 정답 신호}, enroll{화자: [[s,e]]}(초)."""
    voices = {
        "me": lambda t: _norm(shift(tts(t), 0.82), -22),
        "partner": lambda t: _norm(tts(t, rate=1), -26),
        "bystander": lambda t: far_field(shift(tts(t), 1.22), -40),
    }
    clips = {k: [voices[k](line) for line in LINES[k]] for k in voices}
    gap = int(0.4 * SR)
    timeline = []  # (화자, 시작 샘플, 신호)
    pos = int(0.3 * SR)
    for k in ("me", "partner", "bystander"):  # 각자 혼자 말하는 구간(목소리 샘플용)
        timeline.append((k, pos, clips[k][0]))
        pos += len(clips[k][0]) + gap
    overlap_start = pos  # 상대방과 옆 사람이 동시에 말함
    timeline.append(("partner", overlap_start, clips["partner"][1]))
    timeline.append(("bystander", overlap_start + int(0.5 * SR), clips["bystander"][1]))
    pos = overlap_start + max(len(clips["partner"][1]), int(0.5 * SR) + len(clips["bystander"][1])) + gap
    timeline.append(("me", pos, clips["me"][1]))
    n = pos + len(clips["me"][1]) + int(0.5 * SR)

    refs = {k: np.zeros(n, dtype=np.float32) for k in voices}
    enroll = {k: [] for k in voices}
    for k, s, x in timeline:
        refs[k][s:s + len(x)] += x
        if not enroll[k]:
            enroll[k].append([round(s / SR, 3), round((s + len(x)) / SR, 3)])
    rng = np.random.default_rng(seed)
    noise = _norm(rng.standard_normal(n), -55)
    mix = sum(refs.values()) + noise
    return {"mix": mix.astype(np.float32), "refs": refs, "enroll": enroll, "sr": SR}


def si_sdr(est: np.ndarray, ref: np.ndarray) -> float:
    n = min(len(est), len(ref))
    est, ref = est[:n] - est[:n].mean(), ref[:n] - ref[:n].mean()
    target = (est @ ref) / (ref @ ref + 1e-12) * ref
    return float(10 * np.log10((target @ target) / ((est - target) @ (est - target) + 1e-12) + 1e-12))
