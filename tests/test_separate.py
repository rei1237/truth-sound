import numpy as np

from truth_sound.separate import SEP_SR, Separator, SpeakerEncoder


class FakeEcapa:
    """encode_batch(wavs[B,T], wav_lens) → [B,1,2] = (첫 표본 값, 1)."""

    def __init__(self):
        self.batches = []

    def encode_batch(self, wavs, wav_lens=None):
        import torch
        self.batches.append((tuple(wavs.shape), wav_lens))
        return torch.stack([wavs[:, 0], torch.ones(len(wavs), device=wavs.device)], 1)[:, None, :]


def test_embed_many_batches_only_equal_lengths_in_order():
    # 0으로 채워 긴 클립과 묶으면 짧은 클립 특징이 달라진다(실제 모델 코사인 0.98). 같은 길이끼리만 묶는다
    enc = object.__new__(SpeakerEncoder)
    enc.model = FakeEcapa()
    lens = [16000] * 65 + [1000, 24000, 16000]
    out = enc.embed_many([np.full(n, i + 1, np.float32) for i, n in enumerate(lens)])
    assert out.shape == (68, 2)
    assert np.allclose(np.linalg.norm(out, axis=1), 1)
    assert np.allclose(out[:, 0] / out[:, 1], np.arange(1, 69))  # 입력 순서 그대로
    assert sorted(b[0] for b in enc.model.batches) == [(1, 8000), (1, 24000), (2, 16000), (64, 16000)]  # 0.5초까지만 채운다
    assert all(b[1] is None for b in enc.model.batches)


def test_embed_many_does_not_copy_every_clip_up_front():
    # 1시간 녹음은 창이 1.8만 개(약 700MB)다. 클립을 묶음마다만 복사해야 한다
    import tracemalloc
    enc = object.__new__(SpeakerEncoder)
    enc.model = FakeEcapa()
    x = np.ones(2000 * 9600, np.float32)
    clips = [x[i * 9600:(i + 1) * 9600] for i in range(2000)]  # 창처럼 원본을 가리키기만 하는 조각(77MB)
    enc.embed_many(clips[:1])  # torch 불러오기·장치 준비는 한 번만 드는 비용이라 재기 전에 끝낸다
    tracemalloc.start()
    try:
        enc.embed_many(clips)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 20e6


def test_embed_many_empty():
    enc = object.__new__(SpeakerEncoder)
    enc.model = FakeEcapa()
    assert enc.embed_many([]).shape[0] == 0


class FakeSepformer:
    def __init__(self):
        self.lengths = []

    def separate_batch(self, x):
        import torch
        self.lengths.append(x.shape[1])
        return torch.stack([x[0], -x[0]], 1)[None]  # [1, T, 2]


def test_separator_run_pads_short_segment():
    sep = object.__new__(Separator)
    sep.model = FakeSepformer()
    out = sep.run(np.ones(1000))
    assert out.shape == (2, 1000) and sep.model.lengths == [SEP_SR // 2]
    assert np.allclose(out[0], 1) and np.allclose(out[1], -1)
