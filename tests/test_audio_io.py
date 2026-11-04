import numpy as np
import soundfile as sf

from truth_sound.audio_io import load_audio, probe, write_wav
from conftest import write_sine


def test_load_audio_stereo_resamples(tmp_path):
    p = write_sine(tmp_path / "st.wav", seconds=1.5, sr=48000, channels=2)
    x = load_audio(p, 16000)
    assert x.ndim == 1
    assert x.dtype == np.float32
    assert abs(len(x) - 24000) <= 1
    assert 0.3 < np.abs(x).max() <= 1.0


def test_load_audio_averages_stereo_without_clipping(tmp_path):
    # 실제 사례: 두 채널을 더해 봉우리가 2배가 된 뒤 ±1에서 잘려, 원본에 없던 잘린 소리가 생겼다
    p = write_sine(tmp_path / "st.wav", seconds=1.0, sr=44100, channels=2, amp=0.8)
    x = load_audio(p, 16000)
    assert abs(np.abs(x).max() - 0.8) < 0.02
    assert not np.any(np.abs(x) >= 0.99)


def test_write_wav_has_comment(tmp_path):
    p = tmp_path / "out.wav"
    write_wav(p, np.zeros(1600, dtype=np.float32), 16000, comment="청취 보조용 - 원본 아님")
    data = p.read_bytes()
    assert b"ICMT" in data
    assert "청취 보조용 - 원본 아님".encode("utf-8") in data
    y, sr = sf.read(str(p))
    assert sr == 16000 and len(y) == 1600


def test_probe_reports_duration(tmp_path):
    p = write_sine(tmp_path / "two.wav", seconds=2.0, sr=16000)
    info = probe(p)
    assert abs(info["duration"] - 2.0) < 0.01
    assert info["channels"] == 1
    assert info["sample_rate"] == 16000
