"""받아쓰기(faster-whisper) 래퍼."""
import gc
import os
import sys
from pathlib import Path
from typing import Callable

import numpy as np

from . import config
from .dsp import lift_quiet_clip

SETTINGS = {"language": "ko", "beam_size": 5, "word_timestamps": True, "vad_filter": True,
            "condition_on_previous_text": False}
SHORT_AUDIO_VAD_THRESHOLD_SEC = 3.0


def _uncovered_audio(x, segments):
    """이미 적힌 단어 사이에서 무음이 아닌 짧은 구간을 찾아 15초 이하로 나눈다."""
    rate, hop = 16000, 320
    if not len(x):
        return
    peaks = np.maximum.reduceat(np.abs(x), np.arange(0, len(x), hop))
    active = peaks > 0.00003
    covered = np.zeros(len(active), dtype=bool)
    for seg in segments:
        for part in seg.get("words") or [seg]:
            a = max(0, int(part["start"] * rate) // hop)
            b = max(a + 1, int(np.ceil(part["end"] * rate / hop)))
            covered[a:b] = True
    indices = np.flatnonzero(active & ~covered)
    if not len(indices):
        return
    groups = np.split(indices, np.flatnonzero(
        (np.diff(indices) > 12) |
        (np.diff(np.cumsum(covered)[indices]) > 0)) + 1)
    for group in groups:
        start = int(group[0]) * hop
        stop = min(len(x), (int(group[-1]) + 1) * hop)
        for a in range(start, stop, 15 * rate):
            yield a, min(stop, a + 15 * rate)


def _add_cuda_dlls():
    """Windows에서 ctranslate2가 torch에 들어 있는 cuBLAS·cuDNN을 찾게 한다."""
    if sys.platform != "win32":
        return
    import torch
    lib = Path(torch.__file__).parent / "lib"
    if lib.is_dir():
        os.add_dll_directory(str(lib))
        os.environ["PATH"] = str(lib) + os.pathsep + os.environ.get("PATH", "")


ATTEMPTS = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]


class Transcriber:
    def __init__(self, model: str = "large-v3"):
        self.model_name = model
        self.model = None
        self.device = self.compute_type = None
        try:
            import torch
            cuda = torch.cuda.is_available()
        except Exception:
            cuda = False
        if cuda:
            _add_cuda_dlls()
        self._attempts = [a for a in ATTEMPTS if cuda or a[0] == "cpu"]
        self._next()

    def _next(self):
        """다음 실행 방식으로 모델을 올린다. 메모리가 모자라면 더 가벼운 방식으로 내려간다."""
        from faster_whisper import WhisperModel
        last = None
        while self._attempts:
            device, compute_type = self._attempts.pop(0)
            self.model = None
            gc.collect()
            try:
                self.model = WhisperModel(self.model_name, device=device, compute_type=compute_type,
                                          download_root=str(config.models_dir() / "whisper"))
                self.device, self.compute_type = device, compute_type
                return
            except Exception as e:
                last = e
        raise last

    def _run(self, x: np.ndarray, progress: Callable[[float], None]) -> list[dict]:
        settings = SETTINGS.copy()
        # VAD는 아주 짧은 발화를 통째로 무음으로 오판할 수 있다. 짧은 입력은
        # 잘라내지 않고 전체를 Whisper에 전달하고, 긴 녹음은 기존 VAD를 유지한다.
        if len(x) / 16000 <= SHORT_AUDIO_VAD_THRESHOLD_SEC:
            settings["vad_filter"] = False
        segments, info = self.model.transcribe(x, **settings)
        total = max(float(info.duration), 1e-6)
        out = []
        for seg in segments:
            out.append({"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip(),
                        "no_speech": float(seg.no_speech_prob),
                        "words": [{"w": w.word.strip(), "start": float(w.start), "end": float(w.end),
                                   "p": float(w.probability)} for w in (seg.words or [])]})
            progress(0.7 * min(1.0, float(seg.end) / total))
        # 첫 인식에서 빠진 소리만 개별 증폭해 VAD·무음 확률 필터 없이 다시 듣는다.
        first_pass = out.copy()
        retry = dict(settings, vad_filter=False, no_speech_threshold=None)
        for a, b in _uncovered_audio(x, first_pass):
            clip = lift_quiet_clip(x[a:b])
            recovered, _ = self.model.transcribe(clip, **retry)
            def stamp(t):
                return (a + min(max(0, t * 16000), b - a)) / 16000
            found = False
            for seg in recovered:
                if not seg.text.strip():
                    continue
                found = True
                out.append({"start": stamp(seg.start), "end": stamp(seg.end), "text": seg.text.strip(),
                            "no_speech": float(seg.no_speech_prob), "uncertain": True,
                            "words": [{"w": w.word.strip(), "start": stamp(w.start), "end": stamp(w.end),
                                       "p": float(w.probability)} for w in seg.words or []]})
            if not found:
                out.append({"start": a / 16000, "end": b / 16000, "text": "[판독 불가]",
                            "words": [], "uncertain": True})
            progress(0.7 + 0.3 * b / len(x))
        progress(1.0)
        return sorted(out, key=lambda seg: seg["start"])

    def transcribe(self, x16k: np.ndarray, progress: Callable[[float], None]) -> list[dict]:
        x = np.asarray(x16k, dtype=np.float32)
        while True:
            try:
                return self._run(x, progress)
            except Exception:
                if not self._attempts:
                    raise
                self._next()

    def info(self) -> dict:
        return {"model": self.model_name, "gap_retry": "local_gain_max_30dB_no_vad", "device": self.device, "compute_type": self.compute_type}

    def close(self):
        self.model = None
        gc.collect()
