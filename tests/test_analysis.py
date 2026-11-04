import os

import numpy as np
import pytest
import soundfile as sf

from truth_sound import analysis
from conftest import ToneEncoder, sine, write_sine, write_tones


def _mono(path):
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return x.mean(axis=1), sr


def test_clip_level_matches_pipeline():
    from truth_sound import pipeline
    assert analysis.CLIP_LEVEL == pipeline.CLIP_LEVEL


def test_read_range_equals_full_read(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=3.0, sr=44100, channels=2)
    full, sr = _mono(p)
    part, sr2 = analysis.read_range(p, 1.25, 2.0)
    assert sr2 == 44100 and part.dtype == np.float32 and part.ndim == 1
    assert np.allclose(part, full[int(1.25 * sr):int(2.0 * sr)], atol=1e-6)
    info = analysis.audio_info(p)
    assert info["sr"] == 44100 and info["frames"] == 3 * 44100 and info["duration"] == pytest.approx(3.0)


def test_iter_chunks_covers_file_once(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=2.0, sr=16000, channels=2)
    full, sr = _mono(p)
    pieces = list(analysis.iter_chunks(p, chunk_sec=0.7))
    assert len(pieces) == 3
    pos = 0
    for start, x in pieces:
        assert start == pos and x.dtype == np.float32 and x.ndim == 1
        pos += len(x)
    assert pos == len(full)
    assert np.allclose(np.concatenate([x for _, x in pieces]), full, atol=1e-6)


def test_check_window_rejects_and_clamps():
    with pytest.raises(ValueError):
        analysis.check_window(10, 5, 5)
    with pytest.raises(ValueError):
        analysis.check_window(10, -1, 2)
    with pytest.raises(ValueError):
        analysis.check_window(10, 0, 11)  # 길이+0.5 넘음
    with pytest.raises(ValueError):
        analysis.check_window(700, 0, 650, max_span=600)
    with pytest.raises(ValueError):
        analysis.check_window(10, 10.1, 10.3)  # 길이로 자르면 빈 구간
    with pytest.raises(ValueError):
        analysis.check_window(10, 0, float("nan"))
    assert analysis.check_window(10, 9, 10.3) == (9, 10)
    assert analysis.check_window(700, 0, 600, max_span=600) == (0, 600)


def test_cache_key_changes_when_file_changes(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=1.0)
    k1 = analysis.cache_key(p)
    assert analysis.cache_key(p) == k1
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    k2 = analysis.cache_key(p)
    assert k2 != k1
    write_sine(p, seconds=1.5)
    assert analysis.cache_key(p) not in (k1, k2)
    assert analysis.cache_key(p).startswith(f"{p.stat().st_mtime_ns:x}-{p.stat().st_size:x}-")


def test_cache_key_differs_for_different_files_with_same_size_and_mtime(tmp_path):
    a = write_sine(tmp_path / "me.wav", seconds=1.0)
    b = write_sine(tmp_path / "partner.wav", seconds=1.0, freq=300.0)
    st = a.stat()
    os.utime(b, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert a.stat().st_size == b.stat().st_size and a.stat().st_mtime_ns == b.stat().st_mtime_ns
    assert analysis.cache_key(a) != analysis.cache_key(b)


def test_peaks_minmax_and_clip_bins(tmp_path):
    x = sine(4.0, 16000, amp=0.5)
    x[int(2.0 * 16000):int(2.5 * 16000)] = sine(0.5, 16000, amp=1.0)
    p = tmp_path / "c.wav"
    sf.write(str(p), x, 16000, subtype="PCM_16")
    r = analysis.peaks(p, tmp_path / "cache", 0.0, 4.0, 8)
    assert r["clip"] == [0, 0, 0, 0, 1, 0, 0, 0]
    assert r["n"] == 8 and r["sr"] == 16000 and r["start"] == 0.0 and r["end"] == 4.0
    for i in (0, 1, 2, 3, 5, 6, 7):
        assert r["max"][i] == pytest.approx(0.5, abs=0.01) and r["min"][i] == pytest.approx(-0.5, abs=0.01)
    assert r["max"][4] > 0.99 and r["min"][4] < -0.99


def _mixed(path, seconds, sr, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    x = 0.4 * np.sin(2 * np.pi * 220 * t) * np.sin(2 * np.pi * 0.3 * t) + rng.normal(0, 0.05, len(t))
    x[int(seconds * sr * 0.37):int(seconds * sr * 0.37) + 300] = 1.0  # 짧은 잘림
    sf.write(str(path), x.astype(np.float32), sr, subtype="PCM_16")
    return path


def _raw_bins(full, s0, s1, n):
    edges = s0 + (np.arange(n + 1) * (s1 - s0)) // n
    seg = [full[a:b] for a, b in zip(edges[:-1], edges[1:])]
    return (np.array([round(float(s.min()), 4) for s in seg]), np.array([round(float(s.max()), 4) for s in seg]),
            [int(np.any(np.abs(s) >= analysis.CLIP_LEVEL)) for s in seg])


def test_peaks_pyramid_matches_raw(tmp_path):
    p = _mixed(tmp_path / "m.wav", 60.0, 48000)
    full, sr = _mono(p)
    cache = tmp_path / "cache"
    # 칸 경계가 단계 칸과 어긋나는 구간도, 맞는 구간도 표본에서 바로 계산한 값과 같아야 한다
    for start, end, n in [(0.0, 60.0, 100), (3.1234, 41.777, 137), (0.0, 819200 / 48000, 100), (10.0, 10.5, 40)]:
        r = analysis.peaks(p, cache, start, end, n)
        mn, mx, cl = _raw_bins(full, round(start * sr), round(end * sr), n)
        assert len(r["min"]) == len(r["max"]) == len(r["clip"]) == n
        assert np.allclose(r["min"], mn, atol=1e-6) and np.allclose(r["max"], mx, atol=1e-6)
        assert r["clip"] == cl
    assert sum(r["clip"]) >= 0 and any(analysis.peaks(p, cache, 0.0, 60.0, 100)["clip"])


def test_peaks_more_bins_than_samples(tmp_path):
    p = write_sine(tmp_path / "s.wav", seconds=2.0, sr=8000, freq=300.0, amp=0.5)
    full, sr = _mono(p)
    r = analysis.peaks(p, tmp_path / "cache", 1.0, 1.001, 2000)
    assert len(r["min"]) == len(r["max"]) == len(r["clip"]) == 2000
    mn, mx = np.array(r["min"]), np.array(r["max"])
    assert not np.isnan(mn).any() and not np.isnan(mx).any()
    seg = full[8000:8008]
    for i in range(2000):
        v = round(float(seg[min((2 * i + 1) * 8 // 4000, 7)]), 4)
        assert mn[i] - 1e-6 <= v <= mx[i] + 1e-6


def test_peaks_cache_written_under_cache_dir_only(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    p = _mixed(src / "m.wav", 20.0, 16000)
    before = sorted(x.name for x in src.iterdir())
    cache = tmp_path / "work" / "cache"
    r1 = analysis.peaks(p, cache, 0.0, 20.0, 50)
    assert sorted(x.name for x in src.iterdir()) == before
    d = cache / f"peaks_{analysis.cache_key(p)}"
    assert sorted(x.name for x in d.iterdir()) == [f"L{k}.npy" for k in range(5)]
    assert [x.name for x in cache.iterdir()] == [d.name]  # 임시 폴더가 남지 않는다
    a = np.load(d / "L0.npy")
    assert a.shape[0] == 3 and a.dtype == np.float32 and a.shape[1] == -(-20 * 16000 // 128)
    assert analysis.peaks(p, cache, 0.0, 20.0, 50) == r1  # 캐시에서 읽어도 같다


def test_peaks_window_shorter_than_one_sample(tmp_path):
    p = write_sine(tmp_path / "s.wav", seconds=2.0, sr=16000, freq=300.0, amp=0.5)
    full, sr = _mono(p)
    for n in (1, 3):
        r = analysis.peaks(p, tmp_path / "cache", 1.0, 1.000001, n)
        assert len(r["min"]) == len(r["max"]) == len(r["clip"]) == n
        v = round(float(full[16000]), 4)
        assert all(a - 1e-6 <= v <= b + 1e-6 for a, b in zip(r["min"], r["max"]))
    r = analysis.peaks(p, tmp_path / "cache", 1.9999999, 2.3, 2)  # 끝 표본 밖으로 반올림되는 시작
    assert len(r["min"]) == 2 and not np.isnan(r["min"]).any()


def test_peaks_concurrent_fresh_cache_builds(tmp_path):
    import threading
    p = _mixed(tmp_path / "m.wav", 20.0, 16000)
    cache = tmp_path / "cache"
    results, errors = [None] * 6, []
    gate = threading.Barrier(6)

    def run(i):
        try:
            gate.wait()
            results[i] = analysis.peaks(p, cache, 0.0, 20.0, 50)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    ts = [threading.Thread(target=run, args=(i,)) for i in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors
    assert all(r == results[0] for r in results)
    assert [x.name for x in cache.iterdir()] == [f"peaks_{analysis.cache_key(p)}"]


# ---- 주파수 그림 ----

def _spec_cells(r):
    import base64
    return np.frombuffer(base64.b64decode(r["data"]), np.uint8).reshape(r["rows"], r["cols"])


def _row_hz(sr, row):
    return analysis.mel_edges(sr)[row + 1]  # 행 중심 주파수


def test_mel_edges_range():
    e = analysis.mel_edges(16000)
    assert len(e) == analysis.SPEC_ROWS + 2
    assert e[0] == pytest.approx(50) and e[-1] == pytest.approx(8000)
    assert np.all(np.diff(e) > 0)
    assert analysis.mel_edges(11025)[-1] == pytest.approx(5512.5)


def test_spectrogram_bright_rows_follow_tones(tmp_path):
    from conftest import write_tones
    p = write_tones(tmp_path / "t.wav", [(300, 2), (1200, 2)])
    r = analysis.spectrogram(p, tmp_path / "work", 0, 4, 40)
    assert (r["rows"], r["cols"], r["scale"], r["db_range"]) == (analysis.SPEC_ROWS, 40, "mel", 80)
    assert r["f_min"] == pytest.approx(50) and r["f_max"] == pytest.approx(8000)
    cells = _spec_cells(r)
    hz = [_row_hz(16000, int(np.argmax(cells[:, c]))) for c in range(40)]
    assert all(300 * 0.88 <= h <= 300 * 1.12 for h in hz[:20]), hz[:20]
    assert all(1200 * 0.88 <= h <= 1200 * 1.12 for h in hz[20:]), hz[20:]


def test_spectrogram_wide_columns_follow_tones(tmp_path):
    from conftest import write_tones
    p = write_tones(tmp_path / "t.wav", [(300, 2), (1200, 2)])
    r = analysis.spectrogram(p, tmp_path / "work", 0, 4, 20)  # 칸 0.2초: 칸 가운데 창 하나씩 읽는 길
    cells = _spec_cells(r)
    hz = [_row_hz(16000, int(np.argmax(cells[:, c]))) for c in range(20)]
    assert all(300 * 0.88 <= h <= 300 * 1.12 for h in hz[:9]), hz
    assert all(1200 * 0.88 <= h <= 1200 * 1.12 for h in hz[11:]), hz


def test_spectrogram_colour_fixed_per_file(tmp_path):
    from conftest import write_tones
    p = write_tones(tmp_path / "t.wav", [(300, 2), (1200, 2)])
    work = tmp_path / "work"
    whole = analysis.spectrogram(p, work, 0, 4, 100)
    part = analysis.spectrogram(p, work, 2, 3, 25)  # 같은 0.04초 칸
    assert whole["db_top"] == part["db_top"] and whole["db_top"] is not None
    a = _spec_cells(whole)[:, 62:68].max()  # 2.5초 근처
    b = _spec_cells(part)[:, 10:16].max()
    assert abs(int(a) - int(b)) <= 2 and a > 200


def test_spectrogram_silence_is_json_safe(tmp_path):
    import json
    p = tmp_path / "s.wav"
    sf.write(str(p), np.zeros(32000, np.float32), 16000, subtype="PCM_16")
    work = tmp_path / "work"
    assert analysis.spec_top_db(p, work) is None
    for cols in (50, 4):  # 좁은 칸과 넓은 칸 두 길 모두
        r = analysis.spectrogram(p, work, 0, 2, cols)
        assert r["db_top"] is None
        assert not _spec_cells(r).any()
        json.dumps(r, allow_nan=False)


def test_spectrogram_rejects_too_many_cols(tmp_path):
    p = write_sine(tmp_path / "a.wav")
    with pytest.raises(ValueError):
        analysis.spectrogram(p, tmp_path / "work", 0, 2, analysis.SPEC_MAX_COLS + 1)
    with pytest.raises(ValueError):
        analysis.spectrogram(p, tmp_path / "work", 0, 2, 0)
    with pytest.raises(ValueError):
        analysis.spectrogram(p, tmp_path / "work", 0, 9, 10)  # 길이를 넘은 구간


def test_spec_top_db_cached_and_matches_stream(tmp_path):
    from conftest import write_tones
    p = write_tones(tmp_path / "t.wav", [(300, 1), (None, 1), (1200, 1)])
    work = tmp_path / "work"
    top = analysis.spec_top_db(p, work)
    assert top is not None and -60 < top < 0
    f = work / f"spectop_{analysis.cache_key(p)}.json"
    assert f.exists() and analysis.spec_top_db(p, work) == top
    assert [x.name for x in work.iterdir()] == [f.name]  # 임시 파일이 남지 않는다


@pytest.mark.parametrize("sr", [8000, 16000])
def test_spectrogram_white_noise_has_no_dark_low_rows(tmp_path, sr):
    x = (0.2 * np.random.default_rng(3).standard_normal(sr * 30)).astype(np.float32)
    p = tmp_path / "n.wav"
    sf.write(str(p), x, sr, subtype="PCM_16")
    cells = _spec_cells(analysis.spectrogram(p, tmp_path / "work", 0, 30, 1000))
    db = cells.mean(axis=1) / 255 * analysis.SPEC_DB_RANGE  # 행마다 평균 밝기를 dB로
    low = np.flatnonzero(analysis.mel_edges(sr)[1:-1] < 500)
    assert len(low) > 20
    for i in low:
        around = db[max(i - 2, 0):i + 3]  # 이웃 행(자기 포함 5개) 가운데 가장 밝은 것보다 너무 어두운 줄무늬가 없어야 한다
        assert db[i] >= around.max() - 5, (sr, int(i), db[i], around)


# ---- 목소리 높이·구간 수치·구간 WAV ----

def _voiced(f0):
    return [v for v in f0 if v is not None]


def test_pitch_of_200hz_sine(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=2.0, sr=16000, freq=200.0, amp=0.3)
    r = analysis.pitch(p, 0, 2)
    v = _voiced(r["f0"])
    assert r["start"] == 0 and r["hop"] == 0.01 and abs(len(r["f0"]) - 200) <= 2
    assert len(v) > 150 and abs(float(np.median(v)) - 200) <= 5


def test_pitch_silence_is_null(tmp_path):
    import json
    p = tmp_path / "s.wav"
    sf.write(str(p), np.zeros(16000, np.float32), 16000, subtype="PCM_16")
    r = analysis.pitch(p, 0, 1)
    assert len(r["f0"]) > 90 and all(v is None for v in r["f0"])
    json.dumps(r, allow_nan=False)


def test_pitch_rejects_over_60s(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=61.0, sr=8000)
    with pytest.raises(ValueError, match="목소리 높이는 60초 이하 구간에서만 봅니다."):
        analysis.pitch(p, 0, 61)
    assert len(analysis.pitch(p, 0, 60)["f0"]) > 0


def test_pitch_works_at_44100(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=2.0, sr=44100, freq=200.0, amp=0.3)
    v = _voiced(analysis.pitch(p, 0.5, 1.5)["f0"])
    assert len(v) > 70 and abs(float(np.median(v)) - 200) <= 5


def _loud_mid(path, sr=16000, freq=200.0):
    """3초 사인(진폭 0.5) 가운데 1~1.5초는 꽉 찬 크기(±1)로 잘린 소리."""
    x = sine(3.0, sr, freq=freq, amp=0.5)
    a, b = int(1.0 * sr), int(1.5 * sr)
    x[a:b] = np.sign(sine(0.5, sr, freq=freq, amp=1.0))
    sf.write(str(path), x, sr, subtype="PCM_16")
    return path


def test_analyze_numbers(tmp_path):
    import json
    p = _loud_mid(tmp_path / "a.wav")
    r = analysis.analyze(p, 0, 3, [[0, 3]])
    assert r["duration"] == pytest.approx(3.0)
    assert r["clipped_percent"] == pytest.approx(16.7, abs=0.5)
    assert r["peak_db"] == pytest.approx(0.0, abs=0.1)
    assert -12 < r["rms_db"] < -3
    assert abs(r["pitch"]["median"] - 200) <= 5 and r["pitch"]["voiced_percent"] > 80
    assert r["pitch"]["min"] <= r["pitch"]["median"] <= r["pitch"]["max"]
    assert r["speech_percent"] == pytest.approx(100.0)
    assert len(r["spectrum"]["f"]) == 64 == len(r["spectrum"]["db"])
    assert r["spectrum"]["f"][0] >= 50 and r["spectrum"]["f"][-1] <= 8000
    # 200Hz 사인이 있는 칸이 가장 높다
    best = int(np.argmax([-999 if d is None else d for d in r["spectrum"]["db"]]))
    assert abs(r["spectrum"]["f"][best] - 200) < 40
    assert analysis.analyze(p, 0, 3, None)["speech_percent"] is None
    json.dumps(r, allow_nan=False)


def test_analyze_speech_percent_counts_20ms_cells(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=4.0)
    # 구간 1~3초: 1~1.2초와 1.5~2.0초만 말소리(구간 바깥은 무시)
    r = analysis.analyze(p, 1, 3, [[0, 1.2], [1.5, 2.0], [9, 10]])
    assert r["speech_percent"] == pytest.approx(35.0, abs=0.6)  # 1~1.2 + 1.5~2.0 = 0.7/2
    assert analysis.analyze(p, 1, 3, [])["speech_percent"] == 0.0


def test_analyze_silence_is_json_safe(tmp_path):
    import json
    p = tmp_path / "s.wav"
    sf.write(str(p), np.zeros(32000, np.float32), 16000, subtype="PCM_16")
    r = analysis.analyze(p, 0, 2, [[0, 1]])
    assert r["peak_db"] is None and r["rms_db"] is None and r["pitch"] is None
    assert r["clipped_percent"] == 0.0
    assert len(r["spectrum"]["db"]) == 64 and all(d is None for d in r["spectrum"]["db"])
    json.dumps(r, allow_nan=False)


def test_analyze_rejects_over_10min(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=601.0, sr=1000)
    with pytest.raises(ValueError, match="10분 이하로 골라 주세요."):
        analysis.analyze(p, 0, 601, None)
    with pytest.raises(ValueError, match="10분 이하로 골라 주세요."):
        analysis.clip_wav(p, 0, 601)


def test_analyze_skips_pitch_over_60s(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=70.0, sr=8000, freq=200.0, amp=0.3)
    r = analysis.analyze(p, 0, 70, None)
    assert r["pitch"] is None and r["duration"] == pytest.approx(70.0)
    assert analysis.analyze(p, 0, 60, None)["pitch"] is not None


def test_analyze_chunks_44100(tmp_path, monkeypatch):
    monkeypatch.setattr(analysis, "CHUNK_SEC", 0.7)  # 여러 조각으로 나눠도 같은 수치
    p = _loud_mid(tmp_path / "a.wav", sr=44100)
    r = analysis.analyze(p, 0, 3, None)
    assert r["clipped_percent"] == pytest.approx(16.7, abs=0.5)
    assert r["peak_db"] == pytest.approx(0.0, abs=0.1)
    assert abs(r["pitch"]["median"] - 200) <= 5


def test_boost_quiet_clip_preserves_source_and_duration(tmp_path):
    import io
    path = write_sine(tmp_path / "quiet.wav", seconds=1.0, amp=0.001)
    original = path.read_bytes()
    plain, sr = analysis.read_range(path, 0.25, 0.35)
    lifted, rate = sf.read(io.BytesIO(analysis.clip_wav(path, 0.25, 0.35, boost=True)))
    assert rate == sr and len(lifted) == len(plain)
    assert 10 < np.max(np.abs(lifted)) / np.max(np.abs(plain)) < 32
    assert path.read_bytes() == original


def test_clarify_reduces_steady_rumble_around_short_quiet_voice(tmp_path):
    import io
    sr = 16000
    t = np.arange(sr) / sr
    x = 0.002 * np.sin(2 * np.pi * 60 * t)
    x[sr//2:sr//2+1600] += 0.001 * np.sin(2 * np.pi * 1900 * t[:1600])
    path = tmp_path / "quiet.wav"
    sf.write(path, x, sr)
    original = path.read_bytes()
    def read(**mode):
        return sf.read(io.BytesIO(analysis.clip_wav(path, 0.50, 0.60, **mode)))[0]
    def ratio(y):
        freq = np.fft.rfftfreq(len(y), 1/sr)
        spectrum = np.abs(np.fft.rfft(y * np.hanning(len(y))))
        return np.max(spectrum[(freq > 1800) & (freq < 2000)]) / np.max(spectrum[freq < 150])
    enhanced = read(clarify=True)
    assert len(enhanced) == 1600 and np.max(np.abs(enhanced)) <= 0.981
    assert ratio(enhanced) > 2 * ratio(read(boost=True))
    assert path.read_bytes() == original


def test_clarify_silent_selection_does_not_import_neighbouring_voice(tmp_path):
    import io
    x = np.ones(16000, dtype=np.float32) * 0.1
    x[8000:8160] = 0
    path = tmp_path / "silent.wav"
    sf.write(path, x, 16000)
    y, sr = sf.read(io.BytesIO(analysis.clip_wav(path, 0.50, 0.51, clarify=True)))
    assert sr == 16000 and len(y) == 160 and not np.any(y)


def test_clip_wav_length_and_rate(tmp_path):
    import io
    p = write_sine(tmp_path / "a.wav", seconds=2.0, sr=22050, channels=2)
    data = analysis.clip_wav(p, 0.5, 1.75)
    info = sf.info(io.BytesIO(data))
    assert info.samplerate == 22050 and info.subtype == "PCM_16" and info.channels == 1
    assert abs(info.frames - round(1.25 * 22050)) <= 1
    whole, _ = analysis.read_range(p, 0.5, 1.75)
    got, _ = sf.read(io.BytesIO(data), dtype="float32")
    assert np.allclose(got, whole, atol=1e-4)


@pytest.mark.parametrize("freq", [100, 150, 220, 300, 390])
def test_pitch_pure_tone_has_no_octave_error(tmp_path, freq):
    # 기본음의 정수배 지연도 자기상관이 거의 같게 높아, 가장 큰 곳만 고르면 낮은 옥타브로 읽힌다
    p = write_sine(tmp_path / "a.wav", seconds=2.0, sr=16000, freq=float(freq), amp=0.3)
    v = _voiced(analysis.pitch(p, 0, 2)["f0"])
    assert len(v) > 150 and abs(float(np.median(v)) - freq) <= 5


# ---- 말소리 구간 ----

def _bursts(path, bursts, seconds=10.0, sr=16000, noise=0.001, amp=0.3):
    """바탕 잡음(±noise)에 (시작, 끝)초마다 200Hz 사인 덩어리를 얹는다."""
    rng = np.random.default_rng(5)
    x = rng.uniform(-noise, noise, int(seconds * sr)).astype(np.float32)
    for a, b in bursts:
        i, j = round(a * sr), round(b * sr)
        x[i:j] += sine((j - i) / sr, sr, freq=200.0, amp=amp)[:j - i]
    sf.write(str(path), x, sr, subtype="PCM_16")
    return path


_BURSTS = [(1.0, 2.0), (4.0, 4.2), (6.0, 6.5), (6.55, 7.0)]


def test_speech_one_interval_per_burst(tmp_path):
    p = _bursts(tmp_path / "a.wav", _BURSTS)
    r = analysis.speech_intervals(p, tmp_path / "work")
    assert len(r) == 3, r
    for (s, e), (es, ee) in zip(r, [(1.0, 2.0), (4.0, 4.2), (6.0, 7.0)]):
        assert s == pytest.approx(es, abs=0.04) and e == pytest.approx(ee, abs=0.04)
        assert s == round(s, 3) and e == round(e, 3)


@pytest.mark.parametrize("chunk", [0.7, 0.71])  # 0.71초 조각은 20ms 프레임의 배수가 아니다
def test_speech_streams_same_as_whole(tmp_path, monkeypatch, chunk):
    p = _bursts(tmp_path / "a.wav", _BURSTS)
    whole = analysis.speech_intervals(p, tmp_path / "w1")
    monkeypatch.setattr(analysis, "CHUNK_SEC", chunk)
    assert analysis.speech_intervals(p, tmp_path / "w2") == whole


def test_speech_silence_empty(tmp_path):
    import json
    p = tmp_path / "s.wav"
    sf.write(str(p), np.zeros(32000, np.float32), 16000, subtype="PCM_16")
    r = analysis.speech_intervals(p, tmp_path / "work")
    assert r == []
    json.dumps(r, allow_nan=False)


def test_speech_empty_file_is_empty(tmp_path):
    p = tmp_path / "e.wav"
    sf.write(str(p), np.zeros(0, np.float32), 16000, subtype="PCM_16")
    assert analysis.speech_intervals(p, tmp_path / "work") == []


def test_speech_cached(tmp_path, monkeypatch):
    p = _bursts(tmp_path / "a.wav", _BURSTS)
    work = tmp_path / "work"
    first = analysis.speech_intervals(p, work)
    f = work / f"speech_{analysis.cache_key(p)}.json"
    assert f.exists() and [x.name for x in work.iterdir()] == [f.name]  # 임시 파일이 남지 않는다
    monkeypatch.setattr(analysis, "_scan_speech", lambda path: pytest.fail("캐시를 읽어야 합니다"))
    assert analysis.speech_intervals(p, work) == first
    f.write_text("{깨진", "utf-8")  # 깨진 캐시는 다시 계산한다
    monkeypatch.undo()
    assert analysis.speech_intervals(p, work) == first


def test_speech_min_len_and_gap_join_constants(tmp_path):
    assert analysis.SPEECH_GAP_JOIN == 0.1 and analysis.SPEECH_MIN_LEN == 0.06
    # 0.1초 틈은 잇지 않고, 0.06초 덩어리는 남긴다
    p = _bursts(tmp_path / "a.wav", [(1.0, 1.5), (1.62, 2.0), (3.0, 3.07)], seconds=4.0)
    r = analysis.speech_intervals(p, tmp_path / "work")
    assert len(r) == 3 and r[2][1] - r[2][0] >= analysis.SPEECH_MIN_LEN - 0.001, r


def test_speech_sparse_bursts_in_long_quiet_file(tmp_path):
    # 말소리가 프레임의 10%도 안 되는 긴 파일에서도 덩어리를 잃지 않는다
    bursts = [(5.0, 5.3), (12.0, 12.2), (20.0, 20.08)]
    p = _bursts(tmp_path / "a.wav", bursts, seconds=30.0, amp=0.1)
    r = analysis.speech_intervals(p, tmp_path / "work")
    assert len(r) == 3, r
    for (s, e), (es, ee) in zip(r, bursts):
        assert s == pytest.approx(es, abs=0.04) and e == pytest.approx(ee, abs=0.04)


# ---- 닮음 점수 ----

def _sim_listen(tmp_path):
    """0~5초 200Hz, 5~10초 500Hz, 10~50초 500Hz."""
    return write_tones(tmp_path / "listen.wav", [(200.0, 5.0), (500.0, 45.0)])


_SIM_SPEAKERS = [{"id": "me", "name": "나", "enroll": [[0.0, 4.0]]},
                 {"id": "partner", "name": "상대방", "enroll": [[6.0, 9.0]]},
                 {"id": "bystander", "name": "옆 사람", "enroll": []}]


def test_similarity_prefers_matching_tone(tmp_path):
    listen = _sim_listen(tmp_path)
    r = analysis.similarity(ToneEncoder(), listen, _SIM_SPEAKERS, listen, 10.0, 12.0)
    scores = {s["id"]: s for s in r["scores"]}
    assert list(scores) == ["me", "partner"] and scores["partner"]["name"] == "상대방"  # 샘플 없는 사람은 빠진다
    assert scores["partner"]["score"] > 0.9 > 0.1 > scores["me"]["score"]
    assert r["used_seconds"] == pytest.approx(2.0) and r["short"] is False


def test_similarity_uses_first_30s_and_flags_short(tmp_path):
    listen = _sim_listen(tmp_path)
    r = analysis.similarity(ToneEncoder(), listen, _SIM_SPEAKERS, listen, 6.0, 46.0)
    assert analysis.SIM_MAX_SEC == 30.0 and r["used_seconds"] == pytest.approx(30.0) and r["short"] is False
    r = analysis.similarity(ToneEncoder(), listen, _SIM_SPEAKERS, listen, 10.0, 10.3)
    assert analysis.SIM_SHORT_SEC == 0.5 and r["short"] is True and r["used_seconds"] == pytest.approx(0.3)


def test_similarity_without_samples_raises(tmp_path):
    listen = _sim_listen(tmp_path)
    with pytest.raises(ValueError, match="샘플이 있는 사람이 없습니다."):
        analysis.similarity(ToneEncoder(), listen, [{"id": "me", "name": "나", "enroll": []}], listen, 10.0, 12.0)
