import tracemalloc

import numpy as np
import pytest

from truth_sound.dsp import enhance_speech, peaks, resample, rms_db

SR = 16000


def _noise(seconds, db, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(seconds * SR)).astype(np.float32)
    return x / np.sqrt(np.mean(x ** 2)) * 10 ** (db / 20)


def _speechlike(seconds, db):
    t = np.arange(int(seconds * SR)) / SR
    x = np.sin(2 * np.pi * 300 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))
    return (x / np.sqrt(np.mean(x ** 2)) * 10 ** (db / 20)).astype(np.float32)


def test_enhance_boosts_quiet_speech():
    x = _noise(6, -70)
    s0, s1 = 1 * SR, 5 * SR
    x[s0:s1] += _speechlike(4, -45)
    y = enhance_speech(x, SR)
    region = slice(s0 + SR // 2, s1 - SR // 2)
    assert rms_db(y[region]) >= rms_db(x[region]) + 15


def test_enhance_keeps_short_gaps_audible():
    # 말 사이 짧은 틈(약한 자음·말끝)이 말소리보다 12dB 넘게 더 깎이면 안 된다.
    x = _speechlike(4, -45)
    gap = np.zeros(len(x), dtype=bool)
    core = np.zeros(len(x), dtype=bool)
    for start in np.arange(0.5, 3.5, 0.6):
        gap[int(start * SR):int((start + 0.2) * SR)] = True
        core[int((start + 0.05) * SR):int((start + 0.15) * SR)] = True
    x[gap] = _noise(4, -76, seed=1)[gap]
    x[:SR // 2] = _noise(0.5, -82, seed=2)  # 앞쪽 무음으로 잡음 바닥을 만든다
    y = enhance_speech(x, SR)
    body = np.zeros(len(x), dtype=bool)
    body[SR // 2:int(3.5 * SR)] = True
    sp = body & ~gap
    gp = body & core
    speech_gain = rms_db(y[sp]) - rms_db(x[sp])
    gap_gain = rms_db(y[gp]) - rms_db(x[gp])
    assert gap_gain >= speech_gain - 14


def test_enhance_does_not_boost_noise_only():
    x = _noise(4, -60)
    y = enhance_speech(x, SR)
    assert rms_db(y) <= rms_db(x) + 3


def test_enhance_no_clipping():
    x = _speechlike(3, -1) * 1.3
    y = enhance_speech(np.clip(x, -1, 1), SR)
    assert np.abs(y).max() <= 0.98


@pytest.mark.parametrize("sr", [8000, 16000])
@pytest.mark.parametrize("seconds", [0.3, 0.8, 1.234, 1.49, 3.0])
def test_enhance_keeps_length_and_dtype(sr, seconds):
    x = (np.random.default_rng(0).standard_normal(int(seconds * sr)) * 0.01).astype(np.float32)
    y = enhance_speech(x, sr)
    assert len(y) == len(x) and y.dtype == np.float32


def test_enhance_ignores_digital_silence():
    # 녹음 앞의 완전 무음(0)을 잡음 바닥으로 잡으면 남은 잡음을 말소리로 보고 키운다.
    x = np.concatenate([np.zeros(6 * SR, dtype=np.float32), _noise(4, -55)])
    y = enhance_speech(x, SR)
    tail = slice(6 * SR + SR // 2, None)
    assert rms_db(y[tail]) <= rms_db(x[tail]) + 3


def test_enhance_preserves_target_to_bleed_contrast():
    # 트랙 주인 말(-35)과 새어 든 다른 사람 말(-55)의 차이를 크기 맞추기가 지우면 안 된다.
    x = _noise(10, -80)
    x[1 * SR:4 * SR] += _speechlike(3, -35)
    x[6 * SR:9 * SR] += _speechlike(3, -55)
    y = enhance_speech(x, SR)
    own, bleed = slice(int(1.5 * SR), int(3.5 * SR)), slice(int(6.5 * SR), int(8.5 * SR))
    assert rms_db(y[own]) - rms_db(y[bleed]) >= 15


def test_enhance_memory_stays_near_input_size():
    x = _noise(300, -40)  # 5분
    tracemalloc.start()
    try:
        enhance_speech(x, SR)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak <= 4 * x.nbytes


def test_peaks_length():
    assert len(peaks(np.ones(100000, dtype=np.float32), 800)) == 800
    assert len(peaks(np.ones(10, dtype=np.float32), 800)) == 800


def test_resample_length():
    assert len(resample(np.zeros(8000, dtype=np.float32), 8000, 16000)) == 16000
