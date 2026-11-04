import numpy as np
import pytest

from truth_sound.assign import chunk_bounds
from truth_sound.diarize import (
    NOT_FORCED,
    QUIET,
    UNKNOWN,
    forced_labels,
    label_windows,
    split_tracks,
    voiced_mask,
    window_levels,
    window_starts,
)
from truth_sound.dsp import resample, rms_db
from truth_sound.separate import CHUNK_SEC, OVERLAP_SEC, SEP_SR
from conftest import ToneEncoder


def _unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def test_window_starts_adds_end_aligned_window():
    st = window_starts(int(1.7 * 16000), 16000)
    assert np.allclose(st, [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.1])


def test_window_starts_exact_fit_has_no_extra_window():
    assert np.allclose(window_starts(int(1.0 * 16000), 16000), [0, 0.2, 0.4])


def test_window_starts_shorter_than_window():
    assert np.allclose(window_starts(int(0.3 * 16000), 16000), [0.0])


def test_window_levels_per_window():
    x = np.concatenate([np.full(9600, 0.1), np.zeros(9600)])
    lv = window_levels(x, 16000, np.array([0.0, 0.6]))
    assert abs(lv[0] + 20) < 0.01 and lv[1] < -200


def test_voiced_mask_short_loud_recording_has_voiced():
    # 사용자 파일처럼 짧고 전부 큰 녹음: 하위 10% + 8만 쓰면 모두 조용이 된다
    lv = np.array([-6.0, -5.0, -5.5, -7.0, -6.5])
    assert voiced_mask(lv).all()


def test_voiced_mask_quiet_gap():
    lv = np.array([-20.0] * 8 + [-60.0] * 2)
    assert voiced_mask(lv).tolist() == [True] * 8 + [False] * 2


def test_voiced_mask_digital_silence_is_quiet():
    assert not voiced_mask(np.full(5, -240.0)).any()


def test_label_threshold_and_margin_make_unknown():
    refs = np.eye(2)
    me, partner, close, weak = _unit([1, 0.05]), _unit([0.05, 1]), _unit([1, 0.98]), np.array([0.25, 0.0])
    embs = np.stack([me] * 3 + [close] * 3 + [weak] * 3 + [partner] * 3)
    lab, _ = label_windows(embs, refs, np.ones(12, bool), np.full(12, NOT_FORCED))
    assert lab.tolist() == [0] * 3 + [UNKNOWN] * 6 + [1] * 3


def test_single_person_has_no_margin_rule():
    lab, _ = label_windows(np.stack([_unit([1, 0.2])] * 3), np.eye(2)[:1], np.ones(3, bool), np.full(3, NOT_FORCED))
    assert lab.tolist() == [0, 0, 0]


def test_quiet_windows_stay_quiet():
    refs = np.eye(2)
    embs = np.stack([_unit([1, 0])] * 4)
    lab, _ = label_windows(embs, refs, np.array([True, True, False, False]), np.full(4, NOT_FORCED))
    assert lab.tolist() == [0, 0, QUIET, QUIET]


def test_forced_wins_over_judgement_and_smoothing():
    refs = np.eye(2)
    embs = np.stack([_unit([1, 0])] * 5)
    forced = np.array([NOT_FORCED, NOT_FORCED, 1, NOT_FORCED, NOT_FORCED])
    voiced = np.array([True, True, False, True, True])  # 고정은 '조용'도 이긴다
    lab, _ = label_windows(embs, refs, voiced, forced)
    assert lab.tolist() == [0, 0, 1, 0, 0]


def test_smoothing_removes_single_flicker_keeps_tie():
    refs = np.eye(3)
    a, b, c = (_unit(np.eye(3)[i] + 0.01) for i in range(3))
    lab, _ = label_windows(np.stack([a, a, b, a, a]), refs, np.ones(5, bool), np.full(5, NOT_FORCED))
    assert lab.tolist() == [0, 0, 0, 0, 0]
    lab, _ = label_windows(np.stack([a, b, c]), refs, np.ones(3, bool), np.full(3, NOT_FORCED))
    assert lab.tolist() == [0, 1, 2]  # 가운데 창: 한 표씩 동률 → 원래 판정 유지


def test_refine_moves_reference_toward_labelled_voiced_windows():
    refs = np.eye(2)
    w = _unit([0.8, 0.6])
    _, R = label_windows(np.stack([w] * 3), refs, np.ones(3, bool), np.full(3, NOT_FORCED))
    assert np.allclose(R[0], _unit(refs[0] + w))
    assert np.allclose(R[1], refs[1])  # 판정된 창이 없는 사람은 원래 기준


def test_refine_ignores_forced_quiet_windows():
    refs = np.eye(2)
    embs = np.stack([_unit([0, 1]), _unit([1, 0.1])])
    _, R = label_windows(embs, refs, np.array([False, True]), np.array([0, NOT_FORCED]))
    assert np.allclose(R[0], _unit(refs[0] + embs[1]))


def test_forced_labels_by_window_centre():
    st = np.array([0.0, 0.2, 0.4, 0.6])  # 가운데 0.3, 0.5, 0.7, 0.9
    f = forced_labels(st, [[[0.0, 0.55]], [[0.65, 1.0]]])
    assert f.tolist() == [0, 0, 1, 1]


def test_forced_labels_two_people_overlap_not_forced():
    f = forced_labels(np.array([0.0, 0.2]), [[[0.0, 0.6]], [[0.4, 1.0]]])
    assert f.tolist() == [0, NOT_FORCED]


def test_forced_labels_same_person_overlap_still_forced():
    f = forced_labels(np.array([0.3]), [[[0.57, 0.942], [0.581, 0.932]], []])
    assert f.tolist() == [0]


# --- split_tracks: 가짜 분리기·가짜 인코더 ---

SR = 16000
NOISE = np.random.default_rng(0).normal(0, 1e-4, SR * 30).astype(np.float32)


def tone(freq, seconds, amp):
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds):
    return np.zeros(int(seconds * SR), np.float32)


class OracleSeparator:
    """받은 조각이 녹음 어디인지 찾아 정답 소스를 돌려준다. 홀수 조각은 줄기 순서를 뒤집는다."""

    def __init__(self, x8, sources8):
        self.x8, self.src, self.calls = x8, sources8, 0

    def run(self, seg):
        self.calls += 1
        chunk = int(CHUNK_SEC * SEP_SR)
        for ci, (s, e) in enumerate(chunk_bounds(len(self.x8), chunk, chunk - int(OVERLAP_SEC * SEP_SR))):
            if e - s == len(seg) and np.array_equal(self.x8[s:e].astype(np.float64), np.asarray(seg, np.float64)):
                out = self.src[:, s:e].astype(np.float64)
                return out[::-1].copy() if ci % 2 else out
        raise AssertionError("모르는 조각")


def _split(parts, labels_of, forced_of=None, n_people=2):
    """parts: 소스별 16kHz 신호 목록(첫 소스에 잡음을 더해 조각마다 내용이 다르게 한다)."""
    parts = [np.asarray(p, np.float32) for p in parts]
    parts[0] = parts[0] + NOISE[:len(parts[0])]
    x16 = np.sum(parts, axis=0).astype(np.float32)
    x8 = resample(x16, SR, SEP_SR)
    src = np.stack([resample(p, SR, SEP_SR) for p in parts])
    st = window_starts(len(x16), SR)
    labels = labels_of(st)
    forced = forced_of(st) if forced_of else np.full(len(st), NOT_FORCED)
    sep, enc, prog = OracleSeparator(x8, src), ToneEncoder(), []
    tracks, added = split_tracks(x16, x8, st, labels, np.eye(3)[:n_people], forced, sep, enc, prog.append)
    return x16, st, tracks, added, sep, enc, prog


@pytest.mark.parametrize("seconds", [0.4, 1.7, 20.0])
def test_split_tracks_solo_equals_original(seconds):
    me = tone(200, seconds, 0.3)
    x16, st, tracks, added, sep, enc, prog = _split([me, silence(seconds)], lambda st: np.zeros(len(st), int))
    assert set(tracks) == {0, 1}
    assert tracks[0].shape == x16.shape
    assert np.max(np.abs(tracks[0] - x16)) < 1e-5  # 처음부터 끝까지, 가장자리 포함
    assert not tracks[1].any()
    assert added == {0: len(st), 1: 0}
    assert len(enc.calls) == sep.calls  # 조각마다 특징 묶음 한 번
    assert prog[-1] == 1.0


def test_split_tracks_overlap_window_sends_streams_to_each_person():
    # 0~3초 나(200Hz) 혼자, 3~6초 나+상대방(330Hz) 겹침
    me = tone(200, 6.0, 0.3)
    pa = np.concatenate([silence(3.0), tone(330, 3.0, 0.2)])
    x16, st, tracks, added, *_ = _split([me, pa], lambda st: np.zeros(len(st), int))
    mid = slice(int(4.0 * SR), int(5.0 * SR))
    assert rms_db(tracks[1][mid]) > rms_db(pa[mid]) - 3  # 상대방 줄기가 상대방 트랙으로
    assert rms_db(tracks[0][mid]) > rms_db(me[mid]) - 3
    assert rms_db(tracks[1][:int(2.5 * SR)]) < -80  # 혼자 말한 구간에는 상대방 없음
    assert added[1] > 0


def test_split_tracks_unmatched_stream_in_k_window_not_split_off():
    # 나 창에 아무와도 안 닮은 500Hz 줄기가 섞여도 따로 빼지 않고 원본 조각을 나에게
    x16, st, tracks, *_ = _split([tone(200, 3.0, 0.3), tone(500, 3.0, 0.05)], lambda st: np.zeros(len(st), int))
    assert UNKNOWN not in tracks
    assert np.max(np.abs(tracks[0] - x16)) < 1e-5


def test_split_tracks_unknown_window_goes_to_unknown_track():
    x16, st, tracks, added, *_ = _split([tone(500, 3.0, 0.3), silence(3.0)], lambda st: np.full(len(st), UNKNOWN))
    assert np.max(np.abs(tracks[UNKNOWN] - x16)) < 1e-5
    assert not tracks[0].any() and not tracks[1].any()
    assert added[UNKNOWN] == len(st)


def test_split_tracks_unknown_window_routes_clear_stream_to_person():
    me, other = tone(200, 3.0, 0.3), tone(500, 3.0, 0.3)
    x16, st, tracks, *_ = _split([me, other], lambda st: np.full(len(st), UNKNOWN))
    mid = slice(int(1.0 * SR), int(2.0 * SR))
    assert rms_db(tracks[0][mid]) > rms_db(me[mid]) - 3
    assert rms_db(tracks[UNKNOWN][mid]) > rms_db(other[mid]) - 3
    assert not tracks[1].any()


def test_split_tracks_quiet_windows_add_nothing():
    x16, st, tracks, added, sep, *_ = _split([tone(200, 3.0, 0.3), silence(3.0)], lambda st: np.full(len(st), QUIET))
    assert UNKNOWN not in tracks
    assert all(not v.any() for v in tracks.values())
    assert sep.calls == 0  # 조용한 창뿐인 조각은 분리하지 않는다


def test_split_tracks_forced_windows_not_counted():
    def forced(st):
        f = np.full(len(st), NOT_FORCED)
        f[:3] = 0
        return f
    x16, st, tracks, added, *_ = _split([tone(200, 1.7, 0.3), silence(1.7)], lambda st: np.zeros(len(st), int), forced)
    assert added[0] == len(st) - 3

def test_split_tracks_forced_window_still_counts_for_other_person():
    # 상대방 샘플에 고정된 창에서 줄기로 찾은 내 목소리는 '샘플 밖에서 찾은 나'로 센다(설계 5.5)
    me, pa = tone(200, 1.7, 0.3), tone(330, 1.7, 0.2)
    x16, st, tracks, added, *_ = _split([me, pa], lambda st: np.ones(len(st), int), lambda st: np.ones(len(st), int))
    assert added[0] == len(st)
    assert added[1] == 0


def test_split_tracks_k_window_does_not_pick_faint_stream_for_k():
    # 나 창: 뚜렷한 내 줄기(500Hz가 섞여 덜 닮음) + 상대방 줄기 + 창보다 40dB 작은 순수 200Hz 잔여 줄기
    # (cos라 혼합과 직교해 크기 맞춤 뒤에도 작다). 무시할 만큼 작은 줄기를 나에게 주고 실제 내 말을 버리면 안 된다
    me = tone(200, 3.0, 0.3) + tone(500, 3.0, 0.15)
    pa = tone(330, 3.0, 0.2)
    faint = (0.003 * np.cos(2 * np.pi * 200 * np.arange(3 * SR) / SR)).astype(np.float32)
    x16, st, tracks, *_ = _split([me, pa, faint], lambda st: np.zeros(len(st), int))
    mid = slice(int(1.0 * SR), int(2.0 * SR))
    assert rms_db(tracks[0][mid]) > rms_db(me[mid]) - 3
    assert rms_db(tracks[1][mid]) > rms_db(pa[mid]) - 3


def test_split_tracks_k_window_keeps_other_persons_stream_out_of_k():
    # 나 창: 내 줄기는 나와 겨우 닮고(0.32), 상대방 줄기가 오히려 나와 더 닮았다(0.55, 가장 닮은 사람은 상대방).
    # 상대방 줄기는 상대방에게, 내 줄기는 나에게 가야 한다(설계 5.3: 각 y 트랙에는 그 줄기)
    me = tone(200, 3.0, 0.1) + tone(500, 3.0, 0.3)
    pa = tone(330, 3.0, 0.3) + tone(200, 3.0, 0.2)
    x16, st, tracks, *_ = _split([me, pa], lambda st: np.zeros(len(st), int))
    mid = slice(int(1.0 * SR), int(2.0 * SR))
    assert rms_db(tracks[1][mid]) > rms_db(pa[mid]) - 3
    assert ToneEncoder().embed_many([tracks[0][mid]])[0][1] < 0.1  # 내 트랙에 상대방 330Hz가 없다


def test_split_tracks_x16_one_sample_longer_than_twice_x8():
    # 16k와 8k로 따로 디코딩하면 44.1kHz 녹음은 16k 길이가 8k의 2배보다 한 표본 길 수 있다. 끝 창이 줄기를 써도 멈추지 않아야 한다
    me, pa = tone(200, 2.0, 0.3), tone(330, 2.0, 0.2)
    x8 = resample(me + pa, SR, SEP_SR)
    x16 = np.concatenate([me + pa, np.zeros(1, np.float32)])
    src = np.stack([resample(me, SR, SEP_SR), resample(pa, SR, SEP_SR)])
    st = window_starts(len(x16), SR)
    tracks, added = split_tracks(x16, x8, st, np.zeros(len(st), int), np.eye(3)[:2], np.full(len(st), NOT_FORCED),
                                 OracleSeparator(x8, src), ToneEncoder(), lambda p: None)
    assert len(x16) == 2 * len(x8) + 1
    assert tracks[1].shape == x16.shape
    assert rms_db(tracks[1][-int(0.3 * SR):]) > rms_db(pa) - 3
