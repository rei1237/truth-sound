from types import SimpleNamespace

import numpy as np
import pytest

from truth_sound.transcribe import Transcriber


class CapturingModel:
    def __init__(self):
        self.kwargs = None

    def transcribe(self, audio, **kwargs):
        self.kwargs = kwargs
        return iter(()), SimpleNamespace(duration=len(audio) / 16000)


@pytest.mark.parametrize("duration, expected_vad", [(0.2, False), (1.41, False), (3.0, False), (3.01, True), (20.0, True)])
def test_short_audio_bypasses_vad_without_changing_long_recordings(duration, expected_vad):
    transcriber = Transcriber.__new__(Transcriber)
    transcriber.model = CapturingModel()

    result = transcriber._run(np.zeros(round(duration * 16000), dtype=np.float32), lambda _: None)

    assert result == []
    assert transcriber.model.kwargs["vad_filter"] is expected_vad


def test_quiet_uncovered_syllable_is_retried_and_timed():
    x = np.zeros(16000 * 5, dtype=np.float32)
    x[32000:33600] = 0.0001
    calls = []

    class Model:
        def transcribe(self, audio, **settings):
            calls.append((len(audio), float(np.max(audio)), settings))
            seg = SimpleNamespace(start=0, end=0.1, text="네", no_speech_prob=0.7, words=[])
            return iter([seg] if len(calls) == 2 else []), SimpleNamespace(duration=len(audio)/16000)

    tr = Transcriber.__new__(Transcriber)
    tr.model = Model()
    result = tr._run(x, lambda _: None)
    assert len(calls) == 2 and calls[1][1] > calls[0][1]
    assert not calls[1][2]["vad_filter"] and calls[1][2]["no_speech_threshold"] is None
    assert result[0]["text"] == "네" and result[0]["uncertain"]
    assert (result[0]["start"], result[0]["end"]) == (2, 2.1)


def test_detectable_sound_without_words_gets_review_row():
    tr = Transcriber.__new__(Transcriber)
    tr.model = CapturingModel()
    result = tr._run(np.full(1600, 0.0002, dtype=np.float32), lambda _: None)
    assert [s["text"] for s in result] == ["[판독 불가]"]
