"""분리 조각 경계와 분리 줄기 크기 맞춤."""
import numpy as np


def chunk_bounds(n: int, chunk: int, hop: int) -> list[tuple[int, int]]:
    if n <= chunk:
        return [(0, n)]
    out, start = [], 0
    while start + chunk < n:
        out.append((start, start + chunk))
        start += hop
    out.append((max(0, n - chunk), n))  # 마지막 조각도 온전한 길이로 끝에 맞춘다
    return out


def scale_to_mixture(est: np.ndarray, mix: np.ndarray) -> np.ndarray:
    """분리 모델 출력의 임의 배율을 혼합 신호 속 실제 크기로 맞춘다."""
    num = est @ mix
    den = np.sum(est * est, axis=1)
    alpha = np.where(den > 1e-12, num / np.maximum(den, 1e-12), 0.0)
    return est * alpha[:, None]

