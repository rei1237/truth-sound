"""말소리 보정: 결정적인 신호 처리만 쓴다(없는 소리를 만들지 않는다)."""
from math import gcd

import numpy as np
from scipy.signal import butter, resample_poly, sosfilt

FRAME_SEC = 0.02
TARGET_DB = -20.0
MAX_GAIN_DB = 30.0
MIN_GAIN_DB = -20.0
GAP_ATTEN_DB = -12.0
SPEECH_ABOVE_FLOOR_DB = 9.0
SILENCE_DB = -90.0  # 이보다 작은 프레임은 디지털 무음이라 잡음 바닥 계산에서 뺀다
SPEECH_MIN_DB = -70.0  # 이보다 작은 소리는 말소리로 보지 않는다
QUIET_BELOW_DB = 15.0  # 트랙 말소리보다 이만큼 넘게 작은 구간은 따로 키우지 않는다(새어 든 소리와의 차이 유지)
PEAK_LIMIT = 0.98
BLOCK_FRAMES = 500  # 10초 남짓씩 나눠 처리해 긴 녹음도 메모리를 적게 쓴다


def resample(x: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to:
        return x.astype(np.float32)
    g = gcd(sr_from, sr_to)
    return resample_poly(x, sr_to // g, sr_from // g).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))) + 1e-12))


def peaks(x: np.ndarray, n: int) -> list[float]:
    edges = np.linspace(0, len(x), n + 1).astype(int)
    a = np.abs(x)
    return [float(a[s:e].max()) if e > s else 0.0 for s, e in zip(edges[:-1], edges[1:])]


def _peaking_sos(sr: int, f0: float, gain_db: float, q: float) -> np.ndarray:
    a = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    b = [1 + alpha * a, -2 * np.cos(w0), 1 - alpha * a]
    den = [1 + alpha / a, -2 * np.cos(w0), 1 - alpha / a]
    return np.array([[b[0] / den[0], b[1] / den[0], b[2] / den[0], 1.0, den[1] / den[0], den[2] / den[0]]])


def _filters(sr: int) -> np.ndarray:
    hp = butter(2, 80, btype="highpass", fs=sr, output="sos")
    return np.vstack([hp, _peaking_sos(sr, min(2500.0, sr * 0.3), 4.0, 0.8)])


def _moving_mean(v: np.ndarray, width: int) -> np.ndarray:
    """가운데 맞춘 이동 평균. 창이 신호보다 길어도 길이가 그대로다(바깥은 0으로 본다)."""
    width = max(1, width)
    full = np.convolve(v, np.full(width, 1.0 / width))
    start = (width - 1) // 2
    return full[start:start + len(v)]


def _frame_db(y: np.ndarray, hop: int) -> np.ndarray:
    nf = -(-len(y) // hop)
    pad = np.zeros(nf * hop)
    pad[:len(y)] = y
    return 10 * np.log10(np.mean(pad.reshape(nf, hop) ** 2, axis=1) + 1e-12)


def _frame_peak(y: np.ndarray, hop: int) -> np.ndarray:
    nf = -(-len(y) // hop)
    pad = np.zeros(nf * hop)
    pad[:len(y)] = np.abs(y)
    return pad.reshape(nf, hop).max(axis=1)


def _speech_frames(level: np.ndarray) -> np.ndarray:
    audible = level > SILENCE_DB
    ref = level[audible] if audible.any() else level
    floor = np.percentile(ref, 10)
    if np.percentile(ref, 90) - floor < SPEECH_ABOVE_FLOOR_DB:
        # 강약이 거의 없으면 전부 말소리이거나 전부 잡음이다. 절대 크기로 가른다.
        speech = np.full(len(level), np.median(ref) > -40.0)
    else:
        speech = level > floor + SPEECH_ABOVE_FLOOR_DB
    return speech & (level > SPEECH_MIN_DB)


def _gain_db(level: np.ndarray, speech: np.ndarray) -> np.ndarray:
    # 말소리 프레임만으로 약 1.5초 창의 평균 크기를 구해 음절마다 출렁이지 않게 한다.
    win = int(1.5 / FRAME_SEC)
    weight = _moving_mean(speech.astype(float), win)
    mean_level = _moving_mean(np.where(speech, level, 0.0), win) / np.maximum(weight, 1e-9)
    local = np.clip(TARGET_DB - mean_level, MIN_GAIN_DB, MAX_GAIN_DB)
    if speech.any():
        # 트랙 주인 말보다 한참 작은 구간(새어 든 다른 사람 말)은 전체 이득만 줘서 차이를 남긴다.
        ref = np.percentile(level[speech], 90)
        whole = np.clip(TARGET_DB - ref, MIN_GAIN_DB, MAX_GAIN_DB)
        local = np.where(mean_level < ref - QUIET_BELOW_DB, whole, local)
    gain_db = np.where(weight > 1e-6, local, GAP_ATTEN_DB)
    # 말 앞뒤 0.1초는 말소리로 본다(약한 자음·말끝 보호). 말 사이 틈은 말소리보다 12dB만 낮춘다.
    hang = int(0.1 / FRAME_SEC)
    near_speech = _moving_mean(speech.astype(float), 2 * hang + 1) > 1e-6
    gain_db = np.where(near_speech, gain_db, gain_db + GAP_ATTEN_DB)
    return _moving_mean(gain_db, int(0.06 / FRAME_SEC) | 1)


def lift_quiet_clip(x: np.ndarray) -> np.ndarray:
    """선택한 구간의 신호만 같은 비율로 키운다. 무음·길이·상대 크기를 보존한다."""
    peak = float(np.max(np.abs(x), initial=0))
    if peak == 0:
        return x
    gain = min(10 ** (MAX_GAIN_DB / 20), PEAK_LIMIT / peak,
               max(1.0, 10 ** ((TARGET_DB - rms_db(x)) / 20)))
    return (x * gain).astype(np.float32)


def enhance_speech(x: np.ndarray, sr: int) -> np.ndarray:
    """작은 말소리는 키우고, 말이 없는 구간의 잡음은 키우지 않는다."""
    n = len(x)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    hop = max(1, int(FRAME_SEC * sr))
    nf = -(-n // hop)
    block = BLOCK_FRAMES * hop
    blocks = [(a, min(a + block, n)) for a in range(0, n, block)]

    # 1) 음색 보정을 블록마다 이어서 걸고(필터 상태를 넘겨 전체에 한 번 건 것과 같다) 프레임 크기를 잰다.
    sos = _filters(sr)
    zi = np.zeros((sos.shape[0], 2))
    out = np.empty(n, dtype=np.float32)
    level = np.empty(nf)
    for a, b in blocks:
        y, zi = sosfilt(sos, np.asarray(x[a:b], dtype=np.float64), zi=zi)
        out[a:b] = y
        level[a // hop:a // hop + -(-(b - a) // hop)] = _frame_db(y, hop)

    gain_db = _gain_db(level, _speech_frames(level))
    centers = (np.arange(nf) + 0.5) * hop

    # 2) 이득을 곱하고 프레임 피크를 잰다. 3) 프레임 단위 피크 제한 후 안전용 최종 제한.
    fpeak = np.empty(nf)
    for a, b in blocks:
        seg = out[a:b]
        seg *= 10 ** (np.interp(np.arange(a, b), centers, gain_db) / 20)
        fpeak[a // hop:a // hop + -(-(b - a) // hop)] = _frame_peak(seg, hop)
    lim = np.minimum(1.0, PEAK_LIMIT / np.maximum(fpeak, 1e-12))
    lim = np.minimum.reduce([lim, np.roll(lim, 1), np.roll(lim, -1)])
    for a, b in blocks:
        seg = out[a:b]
        seg *= np.interp(np.arange(a, b), centers, lim)
    return np.clip(out, -PEAK_LIMIT, PEAK_LIMIT, out=out)
