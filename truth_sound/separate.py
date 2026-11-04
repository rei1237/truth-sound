"""AI 음성 분리(SepFormer)와 화자 특징(ECAPA) 래퍼."""
import numpy as np

from . import config

SEP_SR = 8000
EMB_SR = 16000
CHUNK_SEC = 8.0
OVERLAP_SEC = 1.0
EMBED_BATCH = 64  # 화자 특징을 한 번에 뽑는 클립 수
SEP_MODELS = {2: "speechbrain/sepformer-whamr", 3: "speechbrain/sepformer-wsj03mix"}
ENCODER_MODEL = "speechbrain/spkrec-ecapa-voxceleb"


def device() -> str:
    import torch
    return "cuda:0" if torch.cuda.is_available() else "cpu"  # speechbrain은 장치 번호까지 있어야 경고 없이 받는다


def _load(cls, source: str):
    from speechbrain.utils.fetching import LocalStrategy
    savedir = config.models_dir() / "speechbrain" / source.split("/")[-1]
    return cls.from_hparams(source=source, savedir=str(savedir), run_opts={"device": device()},
                            local_strategy=LocalStrategy.COPY)


def _free():
    import gc
    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


class SpeakerEncoder:
    name = ENCODER_MODEL

    def __init__(self):
        from speechbrain.inference.speaker import EncoderClassifier
        self.model = _load(EncoderClassifier, ENCODER_MODEL)

    def embed(self, x16k: np.ndarray) -> np.ndarray:
        import torch
        x = np.asarray(x16k, dtype=np.float32)
        if len(x) < EMB_SR // 2:
            x = np.pad(x, (0, EMB_SR // 2 - len(x)))
        with torch.no_grad():
            e = self.model.encode_batch(torch.from_numpy(x)[None].to(device()))
        v = e.squeeze().float().cpu().numpy()
        return v / max(float(np.linalg.norm(v)), 1e-12)

    def embed_many(self, clips: list[np.ndarray]) -> np.ndarray:
        """여러 클립을 한 번에 특징으로 바꾼다. 행마다 정규화.
        길이가 같은 것끼리만 묶는다: 0으로 채워 긴 클립과 묶으면 짧은 클립의 특징이 달라진다."""
        import torch
        def padded(c):  # 0.5초까지만 채운다. 묶음마다 복사해 1시간 녹음의 창 전체를 한꺼번에 복사하지 않는다
            c = np.asarray(c, np.float32)
            return np.pad(c, (0, EMB_SR // 2 - len(c))) if len(c) < EMB_SR // 2 else c

        groups = {}
        for i, c in enumerate(clips):
            groups.setdefault(max(len(c), EMB_SR // 2), []).append(i)
        rows = [None] * len(clips)
        for idx in groups.values():
            for s in range(0, len(idx), EMBED_BATCH):  # 긴 녹음은 창이 수만 개라 묶음 단위로 넣는다
                part = idx[s:s + EMBED_BATCH]
                wavs = torch.from_numpy(np.stack([padded(clips[i]) for i in part]))
                with torch.no_grad():
                    e = self.model.encode_batch(wavs.to(device()))
                for i, v in zip(part, e[:, 0, :].float().cpu().numpy()):
                    rows[i] = v
        if not rows:
            return np.zeros((0, 0), np.float32)
        v = np.stack(rows)
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)

    def close(self):
        self.model = None
        _free()


class Separator:
    def __init__(self, n_speakers: int):
        if n_speakers not in SEP_MODELS:
            raise ValueError("2명 또는 3명만 분리할 수 있습니다.")
        from speechbrain.inference.separation import SepformerSeparation
        self.n = n_speakers
        self.name = SEP_MODELS[n_speakers]
        self.model = _load(SepformerSeparation, self.name)

    def run(self, seg: np.ndarray) -> np.ndarray:
        import torch
        pad = max(0, SEP_SR // 2 - len(seg))  # 너무 짧은 조각은 0.5초까지 채운다
        x = np.pad(seg, (0, pad)).astype(np.float32)
        with torch.no_grad():
            est = self.model.separate_batch(torch.from_numpy(x)[None].to(device()))
        est = est[0].float().cpu().numpy().T  # [S, T]
        return est[:, :len(seg)].astype(np.float64)

    def close(self):
        self.model = None
        _free()
