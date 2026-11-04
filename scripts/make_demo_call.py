"""시험용 가짜 3인 통화를 만든다(Windows 한국어 음성 'Microsoft Heami' 필요).

    uv run python scripts/make_demo_call.py [저장할 경로.wav]

나·상대방·옆 사람(작고 멀게 들림) 목소리가 섞인 WAV와, 사람마다 혼자 말하는 구간을 적은 JSON을 만든다.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from fixtures import LINES, make_call  # noqa: E402

from truth_sound import config  # noqa: E402
from truth_sound.audio_io import write_wav  # noqa: E402

NAMES = {"me": "나", "partner": "상대방", "bystander": "옆 사람"}


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else config.app_home() / "data" / "demo" / "가짜통화_3인.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    call = make_call()
    write_wav(out, call["mix"], call["sr"])
    info = {"file": out.name, "enroll": call["enroll"], "lines": LINES}
    out.with_suffix(".json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"만들었습니다: {out} ({len(call['mix']) / call['sr']:.1f}초)")
    print("② 목소리 지정에서 아래 구간을 끌어 표시하세요:")
    for k, ranges in call["enroll"].items():
        a, b = ranges[0]
        print(f"  {NAMES[k]}: {a:.1f}초 ~ {b:.1f}초")


if __name__ == "__main__":
    main()
