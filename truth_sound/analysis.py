"""편집 화면용 분석의 기초: 파일을 통째로 올리지 않고 구간만 읽고, 파형 요약을 여러 해상도로 캐시한다.

모든 함수는 original/을 읽기만 한다. 만든 캐시는 호출자가 준 cache_dir(work/ 아래) 안에만 쓴다."""
import base64
import functools
import hashlib
import io
import json
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Iterator

import numpy as np
import soundfile as sf

from . import dsp
from .short_sound import FRAME, FRAME_HOP, NFFT, PERIODIC_MIN, SR, _LAGS, _WAC, _WIN

CLIP_LEVEL = 0.99  # pipeline.CLIP_LEVEL과 같은 값: 이 크기 넘는 샘플은 잘린 소리
END_SLACK = 0.5  # 끝이 길이를 이만큼까지 넘는 요청은 길이로 잘라 받아 준다
CHUNK_SEC = 60.0  # 긴 녹음은 이 길이씩 흘려 읽는다
PEAK_BASE = 128  # 가장 촘촘한 요약 단계의 칸당 표본 수
PEAK_FACTOR = 4  # 단계마다 칸이 이만큼 거칠어진다
PEAK_LEVELS = 5  # L0..L4 = 128·512·2048·8192·32768 표본/칸
MAX_PEAK_BINS = 20000


def audio_info(path: Path) -> dict:
    info = sf.info(str(path))
    return {"sr": int(info.samplerate), "frames": int(info.frames), "duration": info.frames / info.samplerate}


def read_range(path: Path, start: float, end: float) -> tuple[np.ndarray, int]:
    """[start, end)초만 읽어 float32 모노(채널 평균)로 준다. 표본 번호는 round(초 * sr)."""
    with sf.SoundFile(str(path)) as f:
        sr = f.samplerate
        a = min(max(round(start * sr), 0), f.frames)
        b = min(max(round(end * sr), a), f.frames)
        return _read(f, a, b), sr


def _read(f: sf.SoundFile, a: int, b: int) -> np.ndarray:
    f.seek(a)
    x = f.read(b - a, dtype="float32", always_2d=True)
    return x.mean(axis=1, dtype=np.float32)


def iter_chunks(path: Path, chunk_sec: float = CHUNK_SEC) -> Iterator[tuple[int, np.ndarray]]:
    """파일을 처음부터 한 번씩 (시작 표본 번호, float32 모노) 조각으로 흘려 준다."""
    with sf.SoundFile(str(path)) as f:
        size = max(round(chunk_sec * f.samplerate), 1)
        pos = 0
        for block in f.blocks(blocksize=size, dtype="float32", always_2d=True):
            yield pos, block.mean(axis=1, dtype=np.float32)
            pos += len(block)


def cache_key(path: Path) -> str:
    """파일이 바뀌면(다시 처리해서 트랙이 바뀌면) 달라지는 캐시 이름."""
    st = Path(path).stat()
    who = hashlib.sha1(Path(path).name.encode("utf-8")).hexdigest()[:8]  # 크기·시각이 같은 다른 트랙과 섞이지 않게
    return f"{st.st_mtime_ns:x}-{st.st_size:x}-{who}"


def check_window(duration: float, start: float, end: float, max_span: float | None = None) -> tuple[float, float]:
    """요청 구간을 검사한다. 잘못되면 ValueError, 끝이 길이를 조금 넘으면 길이로 자른다."""
    if not (np.isfinite(start) and np.isfinite(end)):
        raise ValueError("구간의 시작과 끝은 숫자여야 합니다.")
    if start < 0:
        raise ValueError("구간 시작은 0초 이상이어야 합니다.")
    if end > duration + END_SLACK:
        raise ValueError("구간 끝이 녹음 길이를 넘었습니다.")
    end = min(end, duration)
    if end <= start:
        raise ValueError("구간 끝은 시작보다 뒤여야 합니다.")
    if max_span is not None and end - start > max_span:
        raise ValueError(f"한 번에 {max_span:g}초까지만 볼 수 있습니다.")
    return start, end


# ---- 파형 요약 ----
# 요약 한 칸 = (min, max, clip). 단계 L0는 128표본/칸이고 단계마다 4칸씩 묶어 거칠어진다.
# 한 파일의 요약은 cache_dir/peaks_{cache_key}/L{k}.npy, 모양 (3, 칸 수) float32(3행은 잘림 0/1).

def _group(mn: np.ndarray, mx: np.ndarray, cl: np.ndarray, size: int) -> np.ndarray:
    """표본(또는 아래 단계 칸)을 size개씩 묶은 (3, 칸 수). 마지막 칸은 모자라도 된다."""
    idx = np.arange(0, len(mn), size)
    return np.stack([np.minimum.reduceat(mn, idx), np.maximum.reduceat(mx, idx),
                     np.maximum.reduceat(cl, idx)]).astype(np.float32)


def _l0(x: np.ndarray) -> np.ndarray:
    return _group(x, x, (np.abs(x) >= CLIP_LEVEL).astype(np.float32), PEAK_BASE)


def _build_levels(path: Path) -> list[np.ndarray]:
    l0, carry = [], np.zeros(0, np.float32)
    for _, x in iter_chunks(path):
        buf = np.concatenate([carry, x]) if len(carry) else x
        whole = len(buf) // PEAK_BASE * PEAK_BASE  # 조각 경계가 128의 배수가 아니어도 칸이 어긋나지 않게
        carry = buf[whole:]
        if whole:
            l0.append(_l0(buf[:whole]))
    if len(carry):
        l0.append(_l0(carry))
    levels = [np.concatenate(l0, axis=1) if l0 else np.zeros((3, 0), np.float32)]
    while len(levels) < PEAK_LEVELS:
        mn, mx, cl = levels[-1]
        levels.append(_group(mn, mx, cl, PEAK_FACTOR) if len(mn) else levels[-1])
    return levels


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(final: Path) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(str(final), threading.Lock())


def _pyramid(path: Path, cache_dir: Path, upto: int) -> list[np.ndarray]:
    """L0..L{upto}를 돌려준다. 캐시가 없으면 파일을 한 번 흘려 만든다."""
    key = cache_key(path)
    final = Path(cache_dir) / f"peaks_{key}"
    names = [f"L{k}.npy" for k in range(PEAK_LEVELS)]
    with _lock_for(final):  # 같은 파일의 요약을 여러 요청이 동시에 만들지 않게 한다
        if not all((final / n).exists() for n in names):
            if final.exists():
                shutil.rmtree(final, ignore_errors=True)
            Path(cache_dir).mkdir(parents=True, exist_ok=True)
            tmp = Path(tempfile.mkdtemp(dir=cache_dir, prefix=f".peaks_{key}.", suffix=".tmp"))
            try:
                for n, lv in zip(names, _build_levels(path)):
                    np.save(tmp / n, lv)
                os.replace(tmp, final)  # 다 쓴 뒤 한 번에 넣어 반쯤 쓴 캐시가 남지 않는다
            except OSError:
                if not all((final / n).exists() for n in names):  # 다른 프로세스가 먼저 만든 경우가 아니면 실패
                    raise
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    return [np.load(final / n) for n in names[:upto + 1]]


def _stat(x: np.ndarray) -> tuple[float, float, float]:
    return float(x.min()), float(x.max()), float(np.any(np.abs(x) >= CLIP_LEVEL))


def peaks(path: Path, cache_dir: Path, start: float, end: float, n: int) -> dict:
    """[start, end)초를 n칸으로 줄인 min/max/clip. 칸 경계는 표본 번호 s0 + i*(s1-s0)//n."""
    if not 1 <= n <= MAX_PEAK_BINS:
        raise ValueError(f"칸 수는 1~{MAX_PEAK_BINS}개여야 합니다.")
    info = audio_info(path)
    start, end = check_window(info["duration"], start, end)
    sr = info["sr"]
    s0 = min(round(start * sr), info["frames"])
    s1 = min(round(end * sr), info["frames"])
    if s1 <= s0:  # 한 표본보다 짧은 구간도 그 시각을 덮는 표본 하나를 쓴다
        s0 = max(min(s0, info["frames"] - 1), 0)
        s1 = s0 + 1
    span = s1 - s0
    edges = s0 + np.arange(n + 1) * span // n
    mn, mx, cl = np.zeros(n), np.zeros(n), np.zeros(n, int)
    if span / n < PEAK_BASE:
        # 확대한 구간은 표본에서 바로 계산한다(최대 20000칸 x 128 = 2.56M 표본)
        x, _ = read_range(path, s0 / sr, s1 / sr)
        if len(x) >= n:
            idx = edges[:-1] - s0
            mn, mx = np.minimum.reduceat(x, idx), np.maximum.reduceat(x, idx)
            cl = np.maximum.reduceat((np.abs(x) >= CLIP_LEVEL).astype(np.int8), idx)
        else:  # 칸이 표본보다 많으면 칸마다 그 시각(칸 가운데)을 덮는 표본 하나
            pick = np.minimum((2 * np.arange(n) + 1) * len(x) // (2 * n), len(x) - 1)
            mn = mx = x[pick]
            cl = (np.abs(x[pick]) >= CLIP_LEVEL).astype(int)
    else:
        k = 0
        while k + 1 < PEAK_LEVELS and PEAK_BASE * PEAK_FACTOR ** (k + 1) <= span / n:
            k += 1
        levels = _pyramid(path, cache_dir, k)
        with sf.SoundFile(str(path)) as f:
            for i in range(n):
                mn[i], mx[i], cl[i] = _span(f, levels, k, int(edges[i]), int(edges[i + 1]))
    r = lambda v: [round(float(a), 4) for a in v]
    return {"start": start, "end": end, "sr": sr, "n": n, "min": r(mn), "max": r(mx), "clip": [int(c) for c in cl]}


def _span(f, levels, k, a, b):
    """표본 [a, b)의 min/max/clip을 정확히 구한다: 양끝 128표본 미만은 표본에서, 가운데는 요약 단계에서."""
    lo, hi = -(-a // PEAK_BASE), b // PEAK_BASE  # 통째로 들어가는 L0 칸 범위
    if lo >= hi:
        return _stat(_read(f, a, b))
    parts = []
    if a < lo * PEAK_BASE:
        parts.append(_stat(_read(f, a, lo * PEAK_BASE)))
    if hi * PEAK_BASE < b:
        parts.append(_stat(_read(f, hi * PEAK_BASE, b)))
    for lv in range(k):  # 4의 배수에 닿을 때까지 가장자리 칸을 아래 단계에서 가져온다
        arr = levels[lv]
        while lo < hi and lo % PEAK_FACTOR:
            parts.append((arr[0, lo], arr[1, lo], arr[2, lo]))
            lo += 1
        while lo < hi and hi % PEAK_FACTOR:
            hi -= 1
            parts.append((arr[0, hi], arr[1, hi], arr[2, hi]))
        if lo >= hi:
            break
        lo, hi = lo // PEAK_FACTOR, hi // PEAK_FACTOR
    else:
        if lo < hi:
            arr = levels[k][:, lo:hi]
            parts.append((arr[0].min(), arr[1].max(), arr[2].max()))
    return (min(float(p[0]) for p in parts), max(float(p[1]) for p in parts), max(float(p[2]) for p in parts))


# ---- 주파수 그림(멜 눈금 스펙트로그램) ----
# 행 0이 가장 낮은 주파수. 색은 파일 전체의 최대 dB(spec_top_db)를 기준으로 고정해 구간을 바꿔도 같은 소리는 같은 밝기다.

SPEC_ROWS = 128
SPEC_F_MIN = 50.0
SPEC_DB_RANGE = 80.0
SPEC_WIN_SEC = 0.032
SPEC_HOP_SEC = 0.008
SPEC_MAX_COLS = 4000
SPEC_NARROW_SEC = 2 * SPEC_WIN_SEC  # 칸 간격이 이 이하면 구간을 한 번 읽어 프레임 평균, 넘으면 칸마다 창 하나
SPEC_FLOOR = 1e-12  # 전력 하한(-120dB): 이 이하는 소리 없음. 무음에서 -inf가 나오지 않게 한다
SPEC_BATCH = 1024  # 한 번에 FFT하는 프레임 수


def _mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def mel_edges(sr: int) -> np.ndarray:
    """멜 눈금으로 고르게 나눈 SPEC_ROWS+2개 경계(Hz). 행 i는 경계 i, i+1, i+2를 꼭짓점으로 하는 삼각 필터."""
    f_max = min(8000.0, sr / 2)
    m = np.linspace(_mel(SPEC_F_MIN), _mel(f_max), SPEC_ROWS + 2)
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


@functools.lru_cache(maxsize=8)
def _bank(sr: int) -> tuple[np.ndarray, np.ndarray, int, float]:
    """(삼각 멜 필터 (행, 빈), Hann 창, 창 길이, 창 합)."""
    win = max(round(SPEC_WIN_SEC * sr), 2)
    nfft = 1 << (win - 1).bit_length()
    hz = np.arange(nfft // 2 + 1) * sr / nfft
    e = mel_edges(sr)
    lo, mid, hi = e[:-2, None], e[1:-1, None], e[2:, None]
    fb = np.maximum(np.minimum((hz - lo) / (mid - lo), (hi - hz) / (hi - mid)), 0.0)
    for i in np.flatnonzero(fb.max(axis=1) <= 0):  # 낮은 쪽은 필터가 빈 사이에 끼어 비기 쉽다: 가장 가까운 빈을 쓴다
        fb[i, int(np.argmin(np.abs(hz - e[i + 1])))] = 1.0
    fb /= fb.max(axis=1, keepdims=True)  # 좁은 필터가 빈 가장자리에만 걸려 행마다 이득이 들쭉날쭉해지지 않게 정점을 1로 맞춘다
    w = np.hanning(win).astype(np.float32)
    return fb.astype(np.float32), w, nfft, float(w.sum())


def _frame_power(x: np.ndarray, starts: np.ndarray, sr: int) -> np.ndarray:
    """x에서 starts 위치마다 창 하나씩 잘라 멜 전력 (행, 프레임 수)로 준다. SPEC_FLOOR 아래는 SPEC_FLOOR."""
    fb, w, nfft, wsum = _bank(sr)
    out = np.empty((SPEC_ROWS, len(starts)), np.float32)
    for b in range(0, len(starts), SPEC_BATCH):
        s = starts[b:b + SPEC_BATCH]
        frames = x[s[:, None] + np.arange(len(w))] * w
        sp = np.fft.rfft(frames, nfft, axis=1)
        out[:, b:b + len(s)] = fb @ ((sp.real ** 2 + sp.imag ** 2) / wsum ** 2).T
    return np.maximum(out, SPEC_FLOOR)


def _padded(f: sf.SoundFile, a: int, b: int) -> np.ndarray:
    """표본 [a, b)를 읽되 파일 밖은 0으로 채운다."""
    if a >= f.frames or b <= 0:
        return np.zeros(b - a, np.float32)
    lo, hi = max(a, 0), min(b, f.frames)
    return np.pad(_read(f, lo, hi), (lo - a, b - hi))


def _json_cached(final: Path, field: str, compute, valid):
    """final(JSON)의 field에 캐시한 값을 준다. 없거나 깨졌거나 valid가 거절하면 compute()로 다시 만들어 쓴다."""
    with _lock_for(final):
        try:
            value = json.loads(final.read_text("utf-8"))[field]
            if valid(value):
                return value
        except (OSError, ValueError, KeyError, TypeError):
            pass
        value = compute()
        final.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=final.parent, prefix=f".{final.stem}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({field: value}, fh, allow_nan=False)
            os.replace(tmp, final)
        except OSError:
            if not final.exists():  # 다른 프로세스가 먼저 만든 경우가 아니면 실패
                raise
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    return value


def spec_top_db(path: Path, cache_dir: Path) -> float | None:
    """트랙 전체 멜 칸의 가장 큰 dB. 소리가 전혀 없으면 None. cache_dir/spectop_{key}.json에 캐시한다."""
    final = Path(cache_dir) / f"spectop_{cache_key(path)}.json"
    return _json_cached(final, "top", lambda: _scan_top(path), lambda v: v is None or isinstance(v, (int, float)))


def _scan_top(path: Path) -> float | None:
    sr = audio_info(path)["sr"]
    win = len(_bank(sr)[1])
    hop = max(round(SPEC_HOP_SEC * sr), 1)
    peak, carry, framed = 0.0, np.zeros(0, np.float32), False
    for _, x in iter_chunks(path):
        buf = np.concatenate([carry, x]) if len(carry) else x
        if len(buf) < win:
            carry = buf
            continue
        n = (len(buf) - win) // hop + 1
        peak, framed = max(peak, float(_frame_power(buf, np.arange(n) * hop, sr).max())), True
        carry = buf[n * hop:]  # 남은 표본은 다음 조각과 이어 프레임이 조각 경계에서 끊기지 않게
    if not framed and len(carry):  # 창 하나보다 짧은 파일은 0으로 채워 한 프레임
        peak = float(_frame_power(np.pad(carry, (0, win - len(carry))), np.zeros(1, int), sr).max())
    return None if peak <= SPEC_FLOOR else round(10 * float(np.log10(peak)), 2)


def spectrogram(path: Path, cache_dir: Path, start: float, end: float, cols: int) -> dict:
    """[start, end)초를 cols칸으로 줄인 멜 스펙트로그램. 색은 파일 전체 최대 dB를 기준으로 고정한다."""
    if not 1 <= cols <= SPEC_MAX_COLS:
        raise ValueError(f"칸 수는 1~{SPEC_MAX_COLS}개여야 합니다.")
    info = audio_info(path)
    start, end = check_window(info["duration"], start, end)
    sr = info["sr"]
    s0 = min(round(start * sr), info["frames"])
    s1 = min(round(end * sr), info["frames"])
    if s1 <= s0:  # 한 표본보다 짧은 구간도 그 시각을 덮는 표본 하나를 쓴다
        s0 = max(min(s0, info["frames"] - 1), 0)
        s1 = s0 + 1
    span = s1 - s0
    win = len(_bank(sr)[1])
    top = spec_top_db(path, cache_dir)
    with sf.SoundFile(str(path)) as f:
        if (end - start) / cols <= SPEC_NARROW_SEC:
            power = _narrow(f, sr, s0, span, cols, win)
        else:
            mids = s0 + ((2 * np.arange(cols) + 1) * span) // (2 * cols)  # 칸 가운데
            x = np.concatenate([_padded(f, int(m) - win // 2, int(m) - win // 2 + win) for m in mids])
            power = _frame_power(x, np.arange(cols) * win, sr)
    if top is None:
        cells = np.zeros((SPEC_ROWS, cols), np.uint8)
    else:
        db = 10 * np.log10(power.astype(np.float64))
        cells = np.rint(np.clip((db - (top - SPEC_DB_RANGE)) / SPEC_DB_RANGE, 0, 1) * 255).astype(np.uint8)
    return {"rows": SPEC_ROWS, "cols": cols, "f_min": SPEC_F_MIN, "f_max": float(mel_edges(sr)[-1]),
            "scale": "mel", "db_top": top, "db_range": int(SPEC_DB_RANGE),
            "data": base64.b64encode(cells.tobytes()).decode("ascii")}


def _narrow(f: sf.SoundFile, sr: int, s0: int, span: int, cols: int, win: int) -> np.ndarray:
    """구간을 한 번 읽어 SPEC_HOP_SEC 간격 프레임을 만들고 칸마다 프레임 평균 전력을 낸다."""
    hop = SPEC_HOP_SEC * sr
    centers = np.round(np.arange(max(-(-span // hop), 1)) * hop).astype(int)  # 프레임 가운데(구간 시작 기준 표본)
    x = _padded(f, s0 - win // 2, s0 - win // 2 + int(centers[-1]) + win)
    p = _frame_power(x, centers, sr)
    cs = np.concatenate([np.zeros((SPEC_ROWS, 1)), np.cumsum(p, axis=1, dtype=np.float64)], axis=1)
    edges = np.arange(cols + 1) * span / cols
    lo = np.searchsorted(centers, edges[:-1], side="left")
    hi = np.searchsorted(centers, edges[1:], side="left")
    empty = hi <= lo  # 프레임이 한 개도 안 든 좁은 칸은 칸 가운데에 가장 가까운 프레임 하나
    near = np.clip(np.rint((edges[:-1] + edges[1:]) / 2 / hop), 0, len(centers) - 1).astype(int)
    lo, hi = np.where(empty, near, lo), np.where(empty, near + 1, hi)
    return np.maximum((cs[:, hi] - cs[:, lo]) / (hi - lo), SPEC_FLOOR)


# ---- 말소리 위치 구간 ----

SPEECH_GAP_JOIN = 0.1  # 이보다 짧은 틈은 이어 한 구간으로 본다(초)
SPEECH_MIN_LEN = 0.06  # 이보다 짧은 구간은 버린다(초)


def speech_intervals(path: Path, cache_dir: Path) -> list[list[float]]:
    """말소리가 있는 구간 [[시작, 끝], ...](초, 소수 3자리). 없으면 []. cache_dir/speech_{key}.json에 캐시한다."""
    final = Path(cache_dir) / f"speech_{cache_key(path)}.json"
    ok = lambda v: isinstance(v, list) and all(isinstance(p, list) and len(p) == 2 for p in v)
    return _json_cached(final, "speech", lambda: _scan_speech(path), ok)


def _scan_speech(path: Path) -> list[list[float]]:
    sr = audio_info(path)["sr"]
    hop = max(round(dsp.FRAME_SEC * sr), 1)
    levels, carry = [], np.zeros(0, np.float32)
    for _, x in iter_chunks(path, CHUNK_SEC):  # 모듈 값을 호출 때 읽는다(기본 인자는 정의 때 굳는다)
        buf = np.concatenate([carry, x]) if len(carry) else x
        whole = len(buf) // hop * hop  # 조각 경계가 프레임의 배수가 아니어도 프레임이 어긋나지 않게
        carry = buf[whole:]
        if whole:
            levels.append(dsp._frame_db(buf[:whole], hop))
    if len(carry):  # 파일 끝의 모자란 프레임은 0으로 채워 한 프레임(통째로 잰 것과 같다)
        levels.append(dsp._frame_db(carry, hop))
    if not levels:
        return []
    level = np.concatenate(levels)  # 기준(잡음 바닥)은 파일 전체 수준으로 한 번
    audible = level > dsp.SILENCE_DB
    floor = np.percentile(level[audible] if audible.any() else level, 10)  # _speech_frames와 같은 바닥
    # 말소리가 프레임의 10% 미만이면 _speech_frames가 강약 없음으로 보고 덩어리를 버린다: 바닥보다 확실히 큰 프레임은 살린다
    speech = dsp._speech_frames(level) | ((level > floor + dsp.SPEECH_ABOVE_FLOOR_DB) & (level > dsp.SPEECH_MIN_DB))
    edge = np.diff(np.concatenate([[0], speech.astype(np.int8), [0]]))
    starts, ends = np.flatnonzero(edge == 1), np.flatnonzero(edge == -1)  # 말소리 덩어리의 [시작, 끝) 프레임
    if not len(starts):
        return []
    sec = hop / sr
    joined = np.round((starts[1:] - ends[:-1]) * sec, 6) < SPEECH_GAP_JOIN  # 짧은 틈은 앞뒤를 잇는다
    starts, ends = starts[np.r_[True, ~joined]], ends[np.r_[~joined, True]]
    keep = np.round((ends - starts) * sec, 6) >= SPEECH_MIN_LEN
    duration = audio_info(path)["duration"]
    return [[round(float(a * sec), 3), round(min(float(b * sec), duration), 3)]
            for a, b in zip(starts[keep], ends[keep])]


# ---- 목소리 높이·구간 수치·구간 WAV ----

PITCH_MAX_SPAN = 60.0  # 목소리 높이는 이 길이 이하 구간만
ANALYZE_MAX_SPAN = 600.0
CLIP_MAX_SPAN = 600.0
PITCH_HOP_SEC = 0.01
PITCH_BATCH = 1000  # 한 번에 FFT하는 프레임 수
SPECTRUM_BANDS = 64
SPEECH_CELL_SEC = 0.02
DB_FLOOR = -120.0  # 이 이하는 소리 없음(None). 무음에서 -inf가 나오지 않게 한다


def _window(path: Path, start: float, end: float, max_span: float, message: str) -> tuple[dict, float, float]:
    """check_window로 구간을 검사하고, 너무 길면 화면에 보일 문장(message)으로 거절한다."""
    info = audio_info(path)
    start, end = check_window(info["duration"], start, end)
    if end - start > max_span:
        raise ValueError(message)
    return info, start, end


def _blocks(path: Path, start: float, end: float) -> Iterator[np.ndarray]:
    """[start, end)초를 CHUNK_SEC씩 float32 모노로 흘려 준다(read_range와 같은 표본 경계)."""
    with sf.SoundFile(str(path)) as f:
        sr = f.samplerate
        a = min(max(round(start * sr), 0), f.frames)
        b = min(max(round(end * sr), a), f.frames)
        step = max(round(CHUNK_SEC * sr), 1)
        for pos in range(a, b, step):
            yield _read(f, pos, min(pos + step, b))


def _db(amp: float) -> float | None:
    """진폭(1.0 = 0dB)을 dB로. DB_FLOOR 이하는 None."""
    if amp <= 0:
        return None
    v = 20 * float(np.log10(amp))
    return round(v, 2) if v > DB_FLOOR else None


def _first_peak(periodic: np.ndarray) -> np.ndarray:
    """프레임마다 가장 높은 주기성의 90% 이상인 첫 봉우리의 지연 번호. 기본음의 정수배 지연이 같게 높아도 낮은 옥타브로 읽지 않는다."""
    left = np.pad(periodic, ((0, 0), (1, 0)), constant_values=-np.inf)[:, :-1]
    right = np.pad(periodic, ((0, 0), (0, 1)), constant_values=-np.inf)[:, 1:]
    peak = (periodic >= left) & (periodic >= right) & (periodic >= 0.9 * periodic.max(axis=1, keepdims=True))
    return peak.argmax(axis=1)


def _f0(x: np.ndarray, sr: int) -> np.ndarray:
    """프레임마다 기본 주파수(Hz), 말소리가 아니면 nan. 프레임 i는 구간 시작 + i * 10ms가 가운데다."""
    x16 = dsp.resample(x, sr, SR)
    n = -(-len(x16) // FRAME_HOP)
    if n == 0:
        return np.zeros(0)
    x16 = np.pad(x16, (FRAME // 2, max((n - 1) * FRAME_HOP + FRAME - FRAME // 2 - len(x16), 0)))
    frames = np.lib.stride_tricks.sliding_window_view(x16, FRAME)[::FRAME_HOP][:n]
    out = np.full(n, np.nan)
    for a in range(0, n, PITCH_BATCH):
        fr = frames[a:a + PITCH_BATCH].astype(np.float64) * _WIN
        p = np.abs(np.fft.rfft(fr, NFFT, axis=1)) ** 2
        ac = np.fft.irfft(p, NFFT, axis=1)
        periodic = ac[:, _LAGS] / np.maximum(ac[:, :1], 1e-20) / _WAC  # short_sound.frame_features와 같은 판정
        lag = _first_peak(periodic)
        db = 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12)
        voiced = (periodic.max(axis=1) >= PERIODIC_MIN) & (db >= dsp.SPEECH_MIN_DB)
        out[a:a + len(fr)] = np.where(voiced, SR / (lag + _LAGS.start), np.nan)
    return out


def pitch(path: Path, start: float, end: float) -> dict:
    """[start, end)초의 목소리 높이. f0[i]는 start + i*hop초 프레임의 Hz, 말소리가 아니면 None."""
    _, start, end = _window(path, start, end, PITCH_MAX_SPAN, "목소리 높이는 60초 이하 구간에서만 봅니다.")
    x, sr = read_range(path, start, end)
    f0 = _f0(x, sr)
    return {"start": start, "hop": PITCH_HOP_SEC, "f0": [None if np.isnan(v) else round(float(v), 1) for v in f0]}


def _band_matrix(sr: int, nfft: int) -> tuple[np.ndarray, np.ndarray]:
    """50Hz~min(8000, sr/2)를 로그 간격 SPECTRUM_BANDS칸으로 나눈 (칸 중심 Hz, 칸별 빈 평균 행렬)."""
    edges = np.geomspace(SPEC_F_MIN, min(8000.0, sr / 2), SPECTRUM_BANDS + 1)
    hz = np.arange(nfft // 2 + 1) * sr / nfft
    m = ((hz >= edges[:-1, None]) & (hz < edges[1:, None])).astype(np.float64)
    for i in np.flatnonzero(m.sum(axis=1) == 0):  # 낮은 쪽은 칸이 빈 사이에 끼기 쉽다: 가장 가까운 빈을 쓴다
        m[i, int(np.argmin(np.abs(hz - np.sqrt(edges[i] * edges[i + 1]))))] = 1.0
    return np.sqrt(edges[:-1] * edges[1:]), m / m.sum(axis=1, keepdims=True)


def _mean_power(blocks: Iterator[np.ndarray], sr: int) -> np.ndarray | None:
    """Hann 창(SPEC_WIN_SEC, 절반 겹침) 프레임의 평균 전력 스펙트럼. 표본이 하나도 없으면 None."""
    _, w, nfft, wsum = _bank(sr)
    hop = len(w) // 2
    total, count = np.zeros(nfft // 2 + 1), 0
    for x in blocks:
        if len(x) < len(w):
            if count:
                continue  # 조각 끝의 모자란 토막은 건너뛴다
            x = np.pad(x, (0, len(w) - len(x)))
        starts = np.arange((len(x) - len(w)) // hop + 1) * hop
        for b in range(0, len(starts), SPEC_BATCH):
            s = starts[b:b + SPEC_BATCH]
            sp = np.fft.rfft(x[s[:, None] + np.arange(len(w))] * w, nfft, axis=1)
            total += ((sp.real ** 2 + sp.imag ** 2) / wsum ** 2).sum(axis=0)
        count += len(starts)
    return total / count if count else None


def _speech_percent(speech: list[list[float]], start: float, end: float) -> float:
    """[start, end]를 20ms 칸으로 나눠 speech 구간(절대 초)과 겹치는 칸의 비율(%)."""
    n = max(int(np.ceil(round((end - start) / SPEECH_CELL_SEC, 6))), 1)
    pairs = np.asarray(speech, dtype=np.float64).reshape(-1, 2)
    if not np.isfinite(pairs).all():
        raise ValueError("말한 구간은 숫자여야 합니다.")
    mark = np.zeros(n + 1, int)
    for s, e in pairs:
        if e <= s:
            continue
        lo = int(np.clip(np.floor(round((s - start) / SPEECH_CELL_SEC, 6)), 0, n))
        hi = int(np.clip(np.ceil(round((e - start) / SPEECH_CELL_SEC, 6)), 0, n))
        if hi > lo:
            mark[lo] += 1
            mark[hi] -= 1
    return round(float((np.cumsum(mark[:n]) > 0).mean() * 100), 2)


def analyze(path: Path, start: float, end: float, speech: list[list[float]] | None) -> dict:
    """[start, end)초의 수치: 크기·잘린 비율·목소리 높이·주파수 분포·말한 비율. 무음의 dB는 None."""
    info, start, end = _window(path, start, end, ANALYZE_MAX_SPAN, "10분 이하로 골라 주세요.")
    sr = info["sr"]
    peak, sq, clipped, n = 0.0, 0.0, 0, 0
    for x in _blocks(path, start, end):  # 10분 구간도 한 번에 올리지 않고 조각마다 모은다
        peak = max(peak, float(np.abs(x).max()))
        sq += float(np.sum(np.square(x, dtype=np.float64)))
        clipped += int(np.count_nonzero(np.abs(x) >= CLIP_LEVEL))
        n += len(x)
    pitch_stats = None
    if end - start <= PITCH_MAX_SPAN:
        x, _ = read_range(path, start, end)
        v = _f0(x, sr)
        ok = v[~np.isnan(v)]
        if len(ok):
            pitch_stats = {"median": round(float(np.median(ok)), 1), "min": round(float(ok.min()), 1),
                           "max": round(float(ok.max()), 1), "voiced_percent": round(len(ok) / len(v) * 100, 2)}
    f, bands = _band_matrix(sr, _bank(sr)[2])
    power = _mean_power(_blocks(path, start, end), sr)
    db = [None] * SPECTRUM_BANDS if power is None else \
        [round(10 * float(np.log10(v)), 2) if v > SPEC_FLOOR else None for v in bands @ power]
    return {"duration": end - start, "peak_db": _db(peak),
            "rms_db": _db(float(np.sqrt(sq / n))) if n else None,
            "clipped_percent": round(clipped / n * 100, 2) if n else 0.0,
            "pitch": pitch_stats,
            "spectrum": {"f": [round(float(v), 1) for v in f], "db": db},
            "speech_percent": None if speech is None else _speech_percent(speech, start, end)}


def clip_wav(path: Path, start: float, end: float, boost: bool = False, clarify: bool = False) -> bytes:
    """[start, end)초를 원래 샘플레이트의 PCM16 모노 WAV로. 조각마다 써 긴 구간도 메모리를 적게 쓴다."""
    info, start, end = _window(path, start, end, CLIP_MAX_SPAN, "10분 이하로 골라 주세요.")
    buf = io.BytesIO()
    if boost or clarify:
        check_window(info["duration"], start, end, max_span=30.0)
        x, sr = read_range(path, start, end)
        if clarify:
            context, _ = read_range(path, max(0, start - 0.5), min(info["duration"], end + 0.5))
            audio = dsp.clarify_quiet_clip(x, sr, context)
        else:
            audio = dsp.lift_quiet_clip(x)
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    with sf.SoundFile(buf, "w", samplerate=info["sr"], channels=1, format="WAV", subtype="PCM_16") as out:
        for x in _blocks(path, start, end):
            out.write(x)
    return buf.getvalue()


# ---- 닮음 점수: 참고용이다. 어디에도 저장하지 않는다 ----
SIM_MAX_SEC = 30.0  # 고른 구간의 앞 이만큼만 본다
SIM_SHORT_SEC = 0.5  # 이보다 짧으면 점수가 흔들린다고 알린다


def _sample16(path: Path, ranges: list[list[float]]) -> np.ndarray:
    """구간들을 path에서 잘라 16kHz로 이어 붙인다(처리의 sample_of와 같은 방식)."""
    parts = []
    for a, b in ranges:
        x, sr = read_range(path, a, b)
        parts.append(dsp.resample(x, sr, SR))
    return np.concatenate(parts) if parts else np.zeros(0, np.float32)


def similarity(encoder, listen: Path, speakers: list[dict], track: Path, start: float, end: float) -> dict:
    """track의 [start, end) 앞 30초가 등록된 사람 각각의 샘플과 얼마나 닮았는지(코사인)."""
    end = min(end, start + SIM_MAX_SEC)
    x, sr = read_range(track, start, end)
    target = dsp.resample(x, sr, SR)
    if not len(target):
        raise ValueError("고른 구간에 소리가 없습니다.")
    who, samples = [], []
    for s in speakers:
        sample = _sample16(listen, s.get("enroll") or [])
        if len(sample):
            who.append(s)
            samples.append(sample)
    if not who:
        raise ValueError("샘플이 있는 사람이 없습니다.")
    vecs = np.asarray(encoder.embed_many(samples + [target]), dtype=np.float64)
    vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    cos = vecs[:-1] @ vecs[-1]
    used = len(target) / SR
    return {"used_seconds": round(used, 3), "short": used < SIM_SHORT_SEC,
            "scores": [{"id": s["id"], "name": s["name"], "score": round(float(c), 4)} for s, c in zip(who, cos)]}
