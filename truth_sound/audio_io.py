from pathlib import Path

import av
import numpy as np
import soundfile as sf


def probe(path: Path) -> dict:
    with av.open(str(path)) as c:
        s = c.streams.audio[0]
        cc = s.codec_context
        if c.duration is not None:
            duration = c.duration / av.time_base
        elif s.duration is not None and s.time_base is not None:
            duration = float(s.duration * s.time_base)
        else:
            duration = None
        info = {
            "duration": duration,
            "sample_rate": cc.sample_rate,
            "channels": cc.layout.nb_channels,
            "codec": cc.name,
            "format": c.format.name,
        }
    if info["duration"] is None:
        info["duration"] = len(load_audio(path, 16000)) / 16000
    return info


def load_audio(path: Path, sr: int) -> np.ndarray:
    """어떤 형식이든 모노 float32, 지정 샘플레이트로 디코딩한다."""
    chunks = []
    with av.open(str(path)) as c:
        stream = c.streams.audio[0]
        # 채널은 그대로 받아 평균한다. av의 모노 변환은 두 채널을 더해 2배가 되고 아래 ±1에서 잘렸다
        res = av.AudioResampler(format="fltp", rate=sr)
        for frame in c.decode(stream):
            for f in res.resample(frame):
                chunks.append(f.to_ndarray().mean(axis=0))
        for f in res.resample(None):
            chunks.append(f.to_ndarray().mean(axis=0))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.clip(np.concatenate(chunks), -1.0, 1.0).astype(np.float32)


def write_wav(path: Path, x: np.ndarray, sr: int, comment: str | None = None) -> None:
    with sf.SoundFile(str(path), "w", samplerate=sr, channels=1, subtype="PCM_16", format="WAV") as f:
        if comment:
            f.comment = comment
        f.write(np.clip(x, -1.0, 1.0).astype(np.float32))
