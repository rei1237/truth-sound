"""0.6초 창마다 누가 말하는지 정하고, 그 판정대로 사람별 트랙을 만든다."""
from typing import Callable

import numpy as np

from .assign import chunk_bounds, scale_to_mixture
from .dsp import resample, rms_db
from .separate import CHUNK_SEC, OVERLAP_SEC, SEP_SR

WINDOW_SEC = 0.6
HOP_SEC = 0.2
MIN_SIMILARITY = 0.30  # 가장 닮은 사람과의 유사도가 이보다 낮으면 화자 미상
MIN_MARGIN = 0.03  # 1·2위 유사도 차이가 이보다 작으면 화자 미상
SMOOTH_WINDOWS = 3
REFINE_PASSES = 1
OVERLAP_STREAM_MIN_DB = -30.0  # 창 원본보다 이만큼 넘게 작은 분리 줄기는 무시한다
UNKNOWN = -1
QUIET = -2
NOT_FORCED = -3
VOICED_RULE = "창 크기 > max(min(하위 10% + 8dB, 최대 − 20dB), −70dB)"
TRACK_SR = 16000


def window_starts(n_samples: int, sr: int) -> np.ndarray:
    dur = n_samples / sr
    if dur <= WINDOW_SEC:
        return np.array([0.0])
    ts = np.arange(int(np.floor((dur - WINDOW_SEC) / HOP_SEC + 1e-6)) + 1) * HOP_SEC
    if dur - WINDOW_SEC - ts[-1] > 1e-6:
        ts = np.append(ts, dur - WINDOW_SEC)  # 끝에 맞춘 마지막 창
    return ts


def _span(t: float, sr: int, n: int) -> slice:
    return slice(int(t * sr), min(int((t + WINDOW_SEC) * sr), n))


def window_levels(x: np.ndarray, sr: int, starts: np.ndarray) -> np.ndarray:
    return np.array([rms_db(x[_span(t, sr, len(x))]) for t in starts])


def voiced_mask(levels_db: np.ndarray) -> np.ndarray:
    lv = np.asarray(levels_db, float)
    floor = max(min(np.percentile(lv, 10) + 8, lv.max() - 20), -70)
    return lv > floor


def forced_labels(starts: np.ndarray, enrolls: list[list[list[float]]]) -> np.ndarray:
    """창 가운데가 정확히 한 사람의 샘플 구간 안에 있으면 그 사람으로 고정한다."""
    out = np.full(len(starts), NOT_FORCED)
    for i, t in enumerate(starts):
        c = t + WINDOW_SEC / 2
        who = [k for k, ranges in enumerate(enrolls) if any(a <= c <= b for a, b in ranges)]
        if len(who) == 1:
            out[i] = who[0]
    return out


def _judge(embs, refs, voiced, forced):
    sim = embs @ refs.T
    order = np.sort(sim, axis=1)
    lab = sim.argmax(axis=1)
    unknown = order[:, -1] < MIN_SIMILARITY
    if refs.shape[0] > 1:
        unknown |= order[:, -1] - order[:, -2] < MIN_MARGIN
    lab = np.where(voiced, np.where(unknown, UNKNOWN, lab), QUIET)
    return np.where(forced != NOT_FORCED, forced, lab)


def _smooth(lab):
    out = lab.copy()
    half = SMOOTH_WINDOWS // 2
    for i, v in enumerate(lab):
        if v == QUIET:
            continue
        near = [u for u in lab[max(0, i - half):i + half + 1] if u != QUIET]
        vals, cnt = np.unique(near, return_counts=True)
        best = vals[cnt == cnt.max()]
        out[i] = v if v in best else best[0]  # 동률이면 원래 판정
    return out


def label_windows(win_embs: np.ndarray, refs: np.ndarray, voiced: np.ndarray,
                  forced: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """창 판정과 다듬은 기준 특징을 돌려준다. 사람 0..K−1, UNKNOWN, QUIET."""
    embs = np.asarray(win_embs, float)
    base = R = np.asarray(refs, float)
    voiced = np.asarray(voiced, bool)
    forced = np.asarray(forced)
    lab = _judge(embs, R, voiced, forced)
    for _ in range(REFINE_PASSES):
        rows = []
        for k in range(len(R)):
            m = (lab == k) & voiced
            r = base[k] + embs[m].mean(axis=0) if m.any() else base[k]
            rows.append(r / max(np.linalg.norm(r), 1e-12))
        R = np.stack(rows)
        lab = _judge(embs, R, voiced, forced)
    lab = _smooth(lab)
    return np.where(forced != NOT_FORCED, forced, lab), R


def _piece(i: int, starts: np.ndarray, sr: int, n: int) -> tuple[int, int, np.ndarray]:
    """창 i가 트랙에 보탤 범위와 Hann 모양 가중치. 첫 창은 0부터, 마지막 창은 끝까지 평평하게."""
    c = int((starts[i] + WINDOW_SEC / 2) * sr)
    h = int(HOP_SEC * sr)
    a = 0 if i == 0 else max(c - h, 0)
    b = n if i == len(starts) - 1 else min(c + h, n)
    t = np.arange(a, b)
    w = 0.5 + 0.5 * np.cos(np.pi * np.clip((t - c) / h, -1, 1))
    if i == 0:
        w[t < c] = 1
    if i == len(starts) - 1:
        w[t > c] = 1
    return a, b, w.astype(np.float32)


def _best_chunk(a: int, b: int, chunks: list[tuple[int, int]]) -> int:
    """조각을 통째로 품으면서 조각 가장자리에서 가장 먼 분리 조각."""
    inside = [ci for ci, (s, e) in enumerate(chunks) if s <= a and b <= e]
    if inside:
        return max(inside, key=lambda ci: min(a - chunks[ci][0], chunks[ci][1] - b))
    return max(range(len(chunks)), key=lambda ci: min(b, chunks[ci][1]) - max(a, chunks[ci][0]))


def split_tracks(x16: np.ndarray, x8: np.ndarray, starts: np.ndarray, labels: np.ndarray, refs: np.ndarray,
                 forced: np.ndarray, separator, encoder,
                 progress: Callable[[float], None]) -> tuple[dict[int, np.ndarray], dict[int, int]]:
    """혼자 말한 창은 원본을, 겹친 창은 분리 줄기를 사람별 16kHz 트랙에 더한다.

    둘째 값은 트랙마다 소리를 더한 창 수(샘플 구간에 고정된 창은 빼고 센다)."""
    n, K, up = len(x16), len(refs), TRACK_SR // SEP_SR
    R = np.asarray(refs, float)
    tracks = {k: np.zeros(n, np.float32) for k in [*range(K), UNKNOWN]}
    added = {k: 0 for k in tracks}
    wsum = np.zeros(n, np.float32)
    size = int(CHUNK_SEC * SEP_SR)
    chunks = chunk_bounds(len(x8), size, size - int(OVERLAP_SEC * SEP_SR))
    chunks16 = [(s * up, e * up) for s, e in chunks]
    todo: dict[int, list[int]] = {}
    for i in range(len(starts)):
        a, b, w = _piece(i, starts, TRACK_SR, n)
        wsum[a:b] += w
        if labels[i] != QUIET:
            todo.setdefault(_best_chunk(a, b, chunks16), []).append(i)

    for ci, (s, e) in enumerate(chunks):
        idx = todo.get(ci, [])
        if idx:
            seg = x8[s:e].astype(np.float64)
            est = scale_to_mixture(separator.run(seg), seg)
            est16 = np.stack([resample(st.astype(np.float32), SEP_SR, TRACK_SR) for st in est])
            spans8 = [(max(int(starts[i] * SEP_SR), s), min(int((starts[i] + WINDOW_SEC) * SEP_SR), e)) for i in idx]
            clips = [est16[j, (wa - s) * up:(wb - s) * up] for wa, wb in spans8 for j in range(len(est))]
            sims = (encoder.embed_many(clips) @ R.T).reshape(len(idx), len(est), K)
            for i, (wa, wb), sim in zip(idx, spans8, sims):
                got = _route(i, labels[i], sim, est[:, wa - s:wb - s], x8[wa:wb], est16, s * up, starts, x16, tracks)
                for key in got:
                    if forced[i] != key:  # 그 사람 샘플에 고정된 창만 그 사람 몫에서 뺀다
                        added[key] += 1
        progress((ci + 1) / len(chunks))

    nz = wsum > 0
    for v in tracks.values():
        v[nz] /= wsum[nz]
    if not added[UNKNOWN] and not tracks[UNKNOWN].any():
        del tracks[UNKNOWN], added[UNKNOWN]
    return tracks, added


def _route(i, k, sim, est_win, mix_win, est16, off16, starts, x16, tracks) -> set[int]:
    """창 하나의 소리를 트랙에 나눠 더하고, 소리를 받은 트랙 키를 돌려준다."""
    a, b, w = _piece(i, starts, TRACK_SR, len(x16))
    K = sim.shape[1]
    m_db = rms_db(mix_win)
    st_db = np.array([rms_db(x) for x in est_win])
    clear = st_db - m_db >= OVERLAP_STREAM_MIN_DB
    others = []  # (줄기, 사람): 이 창 판정과 다른 사람으로 뚜렷한 줄기
    for j in np.flatnonzero(clear):
        o = np.sort(sim[j])
        y = int(sim[j].argmax())
        if y != k and o[-1] >= MIN_SIMILARITY and (K < 2 or o[-1] - o[-2] >= MIN_MARGIN):
            others.append((j, y))

    def piece(j):
        seg = est16[j, a - off16:b - off16]
        return np.pad(seg, (0, b - a - len(seg))) * w  # 따로 디코딩한 8k 원본은 16k 절반보다 한 표본 짧을 수 있다

    got = set()
    moved = {j for j, _ in others}
    if k == UNKNOWN and others:
        rest = [j for j in np.flatnonzero(clear) if j not in moved]
        targets = [(j, y) for j, y in others] + [(j, UNKNOWN) for j in rest]
    elif not others:
        tracks[k][a:b] += x16[a:b] * w
        return {int(k)}
    else:
        # k 몫은 다른 사람 몫이 아닌 줄기에서, 무시할 만큼 작은 줄기보다 뚜렷한 줄기를 먼저 고른다
        pool = ([j for j in np.flatnonzero(clear) if j not in moved] or [j for j in range(len(sim)) if j not in moved]
                or list(range(len(sim))))
        main = int(max(pool, key=lambda j: sim[j, k] + 0.001 * st_db[j]))
        targets = [(main, int(k))] + [(j, y) for j, y in others if j != main]
    for j, y in targets:
        tracks[y][a:b] += piece(j)
        got.add(y)
    return got
