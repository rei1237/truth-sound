import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def app_home() -> Path:
    env = os.environ.get("TRUTHSOUND_HOME")
    return Path(env) if env else REPO_ROOT


def _ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def cases_dir() -> Path:
    return _ensure(app_home() / "data" / "cases")


def removed_dir() -> Path:
    """만들자마자 치운 새 사건을 옮겨 두는 곳. 지우지 않고 옮기기만 한다."""
    return _ensure(app_home() / "data" / "removed")


def models_dir() -> Path:
    return _ensure(app_home() / "models")


def setup_env() -> None:
    """모델 캐시를 앱 폴더 안에 두어 C 드라이브를 쓰지 않게 한다."""
    os.environ["HF_HOME"] = str(models_dir() / "huggingface")
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
