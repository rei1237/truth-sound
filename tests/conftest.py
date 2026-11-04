import numpy as np
import pytest
import soundfile as sf


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("TRUTHSOUND_HOME", str(tmp_path))
    return tmp_path


def sine(seconds, sr, freq=440.0, amp=0.5, channels=1):
    t = np.arange(int(seconds * sr)) / sr
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    if channels > 1:
        x = np.stack([x] * channels, axis=1)
    return x


def write_sine(path, seconds=2.0, sr=16000, channels=1, **kw):
    sf.write(str(path), sine(seconds, sr, channels=channels, **kw), sr, subtype="PCM_16")
    return path


def write_tones(path, parts, sr=16000, amp=0.3):
    """(주파수, 초) 조각을 이어 쓴다. 주파수가 None이면 무음."""
    x = np.concatenate([np.zeros(int(sec * sr), np.float32) if f is None else sine(sec, sr, freq=f, amp=amp)
                        for f, sec in parts])
    sf.write(str(path), x, sr, subtype="PCM_16")
    return path


class ToneEncoder:
    """200/330/500Hz 근처 크기로 특징을 만든다: 200Hz=나, 330Hz=상대방, 500Hz=샘플 없는 사람."""
    name = "fake-encoder"

    def __init__(self):
        self.calls = []

    def embed_many(self, clips):
        self.calls.append(len(clips))
        out = []
        for c in clips:
            spec = np.abs(np.fft.rfft(np.asarray(c, float)))
            f = np.fft.rfftfreq(len(c), 1 / 16000)
            v = np.array([spec[(f > fr - 20) & (f < fr + 20)].sum() for fr in (200, 330, 500)])
            n = np.linalg.norm(v)
            out.append(v / n if n > 1e-9 else v)
        return np.stack(out) if out else np.zeros((0, 3))

    def close(self):
        pass
