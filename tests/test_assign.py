import numpy as np

from truth_sound.assign import chunk_bounds, scale_to_mixture


def test_scale_to_mixture_recovers_gain():
    t = np.arange(8000) / 8000
    s1, s2 = np.sin(2 * np.pi * 200 * t), np.sin(2 * np.pi * 330 * t)
    mix = 0.3 * s1 + 0.7 * s2
    est = np.stack([5 * s1, -2 * s2])
    out = scale_to_mixture(est, mix)
    assert np.allclose(out[0], 0.3 * s1, atol=1e-3)
    assert np.allclose(out[1], 0.7 * s2, atol=1e-3)
    assert np.all(np.isfinite(scale_to_mixture(np.zeros((2, 10)), np.ones(10))))


def test_chunk_bounds_cover_all():
    b = chunk_bounds(100, 30, 25)
    assert b[0][0] == 0 and b[-1][1] == 100
    assert all(e - s <= 30 for s, e in b)
    assert all(b[i + 1][0] < b[i][1] for i in range(len(b) - 1))
    assert chunk_bounds(20, 30, 25) == [(0, 20)]
