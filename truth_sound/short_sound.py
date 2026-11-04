"""화자 특징 모델이 못 알아보는 아주 짧은 소리(네·응, 0.2~0.3초)를 10ms 프레임의 음색으로 다시 판정한다.

같은 녹음에서 사람마다 판정된 구간의 음색을 배워, 화자 미상 창 가운데 말소리이고 한 사람과 뚜렷이 닮은
창만 그 사람으로 정한다. 샘플 없는 사람이 길게 말한 곳은 '그 밖의 목소리'로 따로 배워, 그 사람의 짧은 소리가
엉뚱한 사람에게 가지 않게 한다. 다시 정한 창은 녹취록에서 '화자 추정'으로 표시해 검수에서 확인하게 한다."""
import numpy as np

from .diarize import HOP_SEC, QUIET, UNKNOWN, WINDOW_SEC

SR = 16000
FRAME = 400  # 25ms
FRAME_HOP = 160  # 10ms
NFFT = 1024
N_MELS = 30
N_CEPS = 16  # c0(크기)는 빼서 소리 크기와 상관없이 음색만 본다
MEL_HZ = (100, 7600)
PITCH_HZ = (75, 400)
PERIODIC_MIN = 0.5  # 이 정도 이상 주기적인(목소리가 울리는) 프레임만 말소리로 본다
SPEECH_BAND_HZ = (150, 4000)  # 250Hz로 두면 높은 목소리의 기본음이 빠져 짧은 응을 놓쳤다
SPEECH_BAND_MIN = 0.5  # 소리 에너지의 절반 이상이 말소리 대역에 있어야 한다
CORE_SEC = HOP_SEC / 2  # 창 가운데 ±0.1초: 창마다 겹치지 않는 몫
MIN_CORE_FRAMES = 5
MIN_CLASS_FRAMES = 15  # 한 사람이라도 말소리 프레임이 이보다 적으면 다시 보지 않는다(0.4초 샘플이면 넘는다)
BLOB_GAP_FRAMES = 20  # 0.2초 넘게 끊기면 다른 말 덩어리
OTHER_BLOB_SEC = 1.0
LLR_MIN = 2.0  # 가장 닮은 사람과 그다음의 프레임 평균 로그우도 차이
ABS_FACTOR = 3.0  # 그 사람 보통 창보다 이 배수 넘게 덜 닮으면 버린다
SHRINK = 0.2
CHUNK_FRAMES = 6000  # 60초씩 나눠 계산해 긴 녹음도 메모리를 적게 쓴다
SETTINGS = {"method": "frame_timbre_gaussian", "frame_sec": FRAME / SR, "frame_hop_sec": FRAME_HOP / SR,
            "core_sec": CORE_SEC, "periodic_min": PERIODIC_MIN, "speech_band_min": SPEECH_BAND_MIN,
            "min_class_frames": MIN_CLASS_FRAMES, "other_blob_sec": OTHER_BLOB_SEC, "llr_min": LLR_MIN,
            "abs_factor": ABS_FACTOR}

_WIN = np.hanning(FRAME)
_BINS = np.fft.rfftfreq(NFFT, 1 / SR)
_LAGS = slice(SR // PITCH_HZ[1], SR // PITCH_HZ[0] + 1)
_BAND = (_BINS >= SPEECH_BAND_HZ[0]) & (_BINS <= SPEECH_BAND_HZ[1])


def _mel_bank() -> np.ndarray:
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    edges = 700 * (10 ** (np.linspace(mel(MEL_HZ[0]), mel(MEL_HZ[1]), N_MELS + 2) / 2595) - 1)
    fb = np.zeros((N_MELS, len(_BINS)))
    for j in range(N_MELS):
        lo, c, hi = edges[j:j + 3]
        fb[j] = np.clip(np.minimum((_BINS - lo) / (c - lo), (hi - _BINS) / (hi - c)), 0, None)
    return fb


_FB = _mel_bank()
_DCT = np.cos(np.pi / N_MELS * (np.arange(N_MELS)[None, :] + 0.5) * np.arange(1, N_CEPS + 1)[:, None])
_WAC = np.fft.irfft(np.abs(np.fft.rfft(_WIN, NFFT)) ** 2, NFFT)
_WAC = _WAC[_LAGS] / _WAC[0]  # 창 모양 때문에 지연이 길수록 줄어드는 몫을 되돌린다


def frame_features(x: np.ndarray, chunk_frames: int = CHUNK_FRAMES) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """16kHz 소리의 프레임마다 (음색 특징: 켑스트럼 16 + 변화량 16, 크기 dB, 말소리 여부)."""
    x = np.asarray(x, np.float32)
    if len(x) < FRAME:
        x = np.pad(x, (0, FRAME - len(x)))
    frames = np.lib.stride_tricks.sliding_window_view(x, FRAME)[::FRAME_HOP]
    ceps, energy, speech = [], [], []
    for a in range(0, len(frames), chunk_frames):
        fr = frames[a:a + chunk_frames].astype(np.float64) * _WIN
        p = np.abs(np.fft.rfft(fr, NFFT)) ** 2
        ceps.append(np.log(p @ _FB.T + 1e-10) @ _DCT.T)
        energy.append(10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12))
        ac = np.fft.irfft(p, NFFT)
        periodic = (ac[:, _LAGS] / np.maximum(ac[:, :1], 1e-20) / _WAC).max(axis=1) >= PERIODIC_MIN
        band = p[:, _BAND].sum(axis=1) / np.maximum(p.sum(axis=1), 1e-20) >= SPEECH_BAND_MIN
        speech.append(periodic & band)
    cep = np.concatenate(ceps)
    delta = np.gradient(cep, axis=0) if len(cep) > 1 else np.zeros_like(cep)
    return np.hstack([cep, delta]).astype(np.float32), np.concatenate(energy), np.concatenate(speech)


def _other_voice(loud: np.ndarray, flab: np.ndarray) -> np.ndarray:
    """1초 넘는 말 덩어리 가운데 절반 넘게 화자 미상인 곳: 샘플 없는 사람의 목소리로 배운다."""
    other = np.zeros(len(loud), bool)
    on = np.flatnonzero(loud)
    if not len(on):
        return other
    cut = np.flatnonzero(np.diff(on) > BLOB_GAP_FRAMES)
    for s, e in zip(on[np.r_[0, cut + 1]], on[np.r_[cut, len(on) - 1]] + 1):
        if (e - s) * FRAME_HOP / SR < OTHER_BLOB_SEC:
            continue
        m = loud[s:e]
        if np.mean(flab[s:e][m] == UNKNOWN) > 0.5:
            other[s:e] |= m & (flab[s:e] == UNKNOWN)
    return other


def rejudge(x16: np.ndarray, starts: np.ndarray, labels: np.ndarray, n_people: int) -> tuple[np.ndarray, np.ndarray]:
    """화자 미상 창을 프레임 음색으로 다시 보고 (새 판정, 다시 정한 창 표시)를 돌려준다.

    샘플 구간에 고정된 창은 이미 그 사람으로 판정돼 있어 화자 미상 창이 될 수 없다."""
    labels = np.asarray(labels).copy()
    guessed = np.zeros(len(labels), bool)
    if not np.any(labels == UNKNOWN):
        return labels, guessed
    feat, energy, speech = frame_features(x16)
    loud = energy > max(min(np.percentile(energy, 10) + 10, energy.max() - 30), -75)
    use = loud & speech
    if not use.any():
        return labels, guessed
    f = (feat - feat[use].mean(axis=0)) / (feat[use].std(axis=0) + 1e-9)
    ft = (np.arange(len(f)) * FRAME_HOP + FRAME / 2) / SR
    cores = [slice(*np.searchsorted(ft, [c - CORE_SEC, c + CORE_SEC])) for c in np.asarray(starts) + WINDOW_SEC / 2]
    flab = np.full(len(f), QUIET)
    for i, s in enumerate(cores):
        flab[s] = labels[i]
    other = _other_voice(loud, flab)
    masks = [use & (flab == k) for k in range(n_people)]
    if min(m.sum() for m in masks) < MIN_CLASS_FRAMES:
        return labels, guessed
    if (use & other).sum() >= MIN_CLASS_FRAMES:
        masks.append(use & other)

    means = [f[m].mean(axis=0) for m in masks]
    pooled = np.cov(np.vstack([f[m] - mu for m, mu in zip(masks, means)]).T)
    inv = np.linalg.pinv((1 - SHRINK) * pooled + SHRINK * np.diag(np.diag(pooled)))
    ll = np.full((len(f), len(masks)), np.nan)
    d = [f[use] - mu for mu in means]
    ll[use] = np.stack([-0.5 * np.einsum("ij,jk,ik->i", di, inv, di) for di in d], axis=1)

    def score(s):
        v = ll[s][use[s]]
        return v.mean(axis=0) if len(v) >= MIN_CORE_FRAMES else None

    typical = []
    for k in range(n_people):
        own = [sc[k] for i, s in enumerate(cores) if labels[i] == k and (sc := score(s)) is not None]
        if not own:
            return labels, guessed
        typical.append(float(np.median(own)))

    for i, s in enumerate(cores):
        if labels[i] != UNKNOWN or other[s].sum() > loud[s].sum() / 2:
            continue
        sc = score(s)
        if sc is None:
            continue
        order = np.argsort(sc)
        y = int(order[-1])
        if y < n_people and sc[y] - sc[order[-2]] >= LLR_MIN and sc[y] >= ABS_FACTOR * typical[y]:
            labels[i], guessed[i] = y, True
    return labels, guessed
