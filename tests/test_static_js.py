"""화면 쪽 모듈(static/*.js)의 node 테스트를 pytest에서 함께 돌린다."""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node가 없어 화면 쪽 테스트를 건너뜀")
def test_static_js():
    tests = sorted(str(p) for p in (Path(__file__).parent / "js").glob("*.test.mjs"))
    r = subprocess.run([NODE, "--test", *tests], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stdout + r.stderr
