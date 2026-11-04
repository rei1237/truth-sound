import numpy as np
import pytest
from scipy.signal import lfilter

from truth_sound.diarize import QUIET, UNKNOWN, WINDOW_SEC, window_starts
from truth_sound.short_sound import _other_voice, frame_features, rejudge

SR = 16000
A = (120, (600, 1200, 2600))  # 나: 낮은 목소리
B = (210, (350, 2000, 2900))  # 상대방: 높은 목소리
C = (160, (800, 1500, 3400))  # 샘플 없는 사람


def voice(who, sec, db=-26.0, seed=0):
    """기본음 + 배음을 포먼트 공진으로 거른 모음 비슷한 소리."""
    f0, formants = who
    t = np.arange(int(sec * SR)) / SR
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.03 * np.sin(2 * np.pi * 5 * t))) / SR
    y = sum(np.sin(h * ph) / h for h in range(1, int(7000 / f0)))
    for fc in formants:
        r = np.exp(-np.pi * 100 / SR)
        y = lfilter([1 - r], [1, -2 * r * np.cos(2 * np.pi * fc / SR), r * r], y)
    y *= 0.7 + 0.3 * np.sin(2 * np.pi * 3 * t + seed)
    return (y * 10 ** (db / 20) / np.sqrt(np.mean(y ** 2))).astype(np.float32)


def noise(sec, db=-26.0):
    y = np.random.default_rng(1).standard_normal(int(round(sec * SR)))
    return (y * 10 ** (db / 20)).astype(np.float32)


def call(parts):
    """(소리 또는 쉬는 초, 창 판정) 조각을 잇고, 창 가운데가 그 조각에 든 창에 판정을 붙인다."""
    xs, spans, t = [], [], 0.0
    for clip, lab in parts:
        clip = np.zeros(int(clip * SR), np.float32) if isinstance(clip, float) else clip
        spans.append((t, t + len(clip) / SR, lab))
        xs.append(clip)
        t += len(clip) / SR
    x = np.concatenate(xs)
    x = x + noise(len(x) / SR, -70)
    starts = window_starts(len(x), SR)
    labels = np.full(len(starts), QUIET)
    for i, st in enumerate(starts):
        c = st + WINDOW_SEC / 2
        for a, b, lab in spans:
            if lab is not None and a - 0.05 <= c < b + 0.05:
                labels[i] = lab
    return x, starts, labels


def _base(*tail):
    return [(voice(A, 3.0), 0), (0.5, None), (voice(B, 3.0, seed=1), 1), (0.6, None), *tail, (0.6, None)]


@pytest.mark.parametrize("who, k", [(A, 0), (B, 1)])
def test_short_unknown_sound_goes_to_matching_voice(who, k):
    x, starts, labels = call(_base((voice(who, 0.25, seed=2), UNKNOWN)))
    new, guessed = rejudge(x, starts, labels, 2)
    assert guessed.any() and np.all(labels[guessed] == UNKNOWN) and np.all(new[guessed] == k)
    assert np.array_equal(new[~guessed], labels[~guessed])


def test_noise_burst_stays_unknown():
    x, starts, labels = call(_base((noise(0.25), UNKNOWN)))
    new, guessed = rejudge(x, starts, labels, 2)
    assert np.array_equal(new, labels) and not guessed.any()


@pytest.mark.parametrize("talked_long", [True, False])
def test_short_sound_of_unenrolled_talker_stays_unknown(talked_long):
    long_part = [(voice(C, 1.5, seed=3), UNKNOWN), (0.6, None)] if talked_long else []
    x, starts, labels = call(_base(*long_part, (voice(C, 0.25, seed=4), UNKNOWN)))
    new, guessed = rejudge(x, starts, labels, 2)
    assert np.array_equal(new, labels) and not guessed.any()


def test_long_unknown_speech_is_learned_as_other_voice():
    # 프레임 100개 = 1초. 0~150 화자 미상 긴 말, 200~230 짧은 미상 소리, 300~450 사람 0의 긴 말
    loud = np.zeros(500, bool)
    loud[0:150] = loud[200:230] = loud[300:450] = True
    flab = np.full(500, QUIET)
    flab[0:150] = flab[200:230] = UNKNOWN
    flab[300:450] = 0
    other = _other_voice(loud, flab)
    assert other[0:150].all() and not other[150:].any()


def _short_samples(tail):
    # 사람마다 0.4초: 실제 사건에서 고른 목소리 샘플 길이
    return [(voice(A, 0.4), 0), (0.5, None), (voice(B, 0.4, seed=1), 1), (0.6, None), (tail, UNKNOWN), (0.6, None)]


@pytest.mark.parametrize("who, k", [(A, 0), (B, 1)])
def test_short_voice_samples_still_rejudge(who, k):
    x, starts, labels = call(_short_samples(voice(who, 0.25, seed=2)))
    new, guessed = rejudge(x, starts, labels, 2)
    assert guessed.any() and np.all(new[guessed] == k)
    assert np.array_equal(new[~guessed], labels[~guessed])


@pytest.mark.parametrize("tail", [voice(C, 0.25, seed=4), noise(0.25)], ids=["unenrolled", "noise"])
def test_short_voice_samples_keep_other_sounds_unknown(tail):
    x, starts, labels = call(_short_samples(tail))
    new, guessed = rejudge(x, starts, labels, 2)
    assert np.array_equal(new, labels) and not guessed.any()


def test_skips_when_a_person_has_too_little_voice():
    x, starts, labels = call([(voice(A, 3.0), 0), (0.5, None), (voice(B, 0.12, seed=1), 1), (0.6, None),
                                      (voice(B, 0.25, seed=2), UNKNOWN), (0.6, None)])
    new, guessed = rejudge(x, starts, labels, 2)
    assert np.array_equal(new, labels) and not guessed.any()


def test_frame_features_same_in_chunks():
    x = voice(A, 1.0)
    whole = frame_features(x)
    parts = frame_features(x, chunk_frames=7)
    assert len(whole[0]) == 1 + (len(x) - 400) // 160
    for a, b in zip(whole, parts):
        assert np.allclose(a, b, atol=1e-4)


def test_frame_features_marks_voice_not_noise():
    _, _, speech = frame_features(np.concatenate([voice(B, 0.5), noise(0.5)]))
    half = len(speech) // 2
    assert speech[:half - 3].mean() > 0.9 and speech[half + 3:].mean() < 0.1
