"""받아쓰기 결과를 녹취록 줄로 정리한다."""
import difflib
import re
from typing import Callable

LOW_CONF = 0.5
HALLUCINATIONS = ["시청해주셔서감사합니다", "구독과좋아요", "구독좋아요", "다음영상에서만나요",
                  "자막제공", "한글자막", "MBC뉴스"]
HALLUCINATION_VARIANT_NO_SPEECH = 0.6
NO_SPEECH_SUSPECT = 0.6  # 받아쓰기 모델이 본 '말 없음' 확률(Whisper 자체 기준값)
MAX_SYLLABLES_PER_SEC = 15  # 아주 빠른 말도 초당 10음절 남짓
TIMING_SLACK_SEC = 0.2  # 단어 시각은 이만큼 어긋날 수 있다
DUP_OVERLAP = 0.5
DUP_SIMILARITY = 0.6
AUTO_EXCLUDE_DB = 10.0  # 두 트랙 소리 차이가 이만큼 나야 작은 쪽을 자동으로 뺀다
EXCLUDE_REASONS = {"duplicate": "중복", "bleed": "다른 사람 말이 새어 듦", "noise": "잡음·지어낸 말",
                   "auto_duplicate": "자동: 중복 의심", "auto_hallucination": "자동: 지어낸 말 의심"}


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text)


def _made_up(seg: dict, text: str) -> bool:
    """말 없음 확률이 높은데 단어 시각에 비해 사람이 말할 수 없을 만큼 글자가 많으면 지어낸 말로 본다."""
    words = seg.get("words") or []
    if seg.get("no_speech", 0.0) < NO_SPEECH_SUSPECT or not words:
        return False
    span = words[-1]["end"] - words[0]["start"]
    return len(re.findall(r"[가-힣]", text)) > MAX_SYLLABLES_PER_SEC * (span + TIMING_SLACK_SEC)


def _common_hallucination(seg: dict, text: str) -> bool:
    """Whisper의 상투적인 자막 문구와, 말 없음 확률이 높은 변형 문구를 찾는다."""
    normalized = _norm(text)
    if normalized in HALLUCINATIONS:
        return True
    if seg.get("no_speech", 0.0) < HALLUCINATION_VARIANT_NO_SPEECH:
        return False
    return any(phrase in normalized for phrase in HALLUCINATIONS)


def from_segments(speaker: str, segments: list[dict]) -> list[dict]:
    """불확실한 후보도 검수 가능한 줄로 보존한다."""
    out = []
    for seg in segments:
        text = seg["text"].strip()
        if not _norm(text):
            continue
        words = [dict(w) for w in seg.get("words", [])]
        uncertain = (seg.get("uncertain", False) or _common_hallucination(seg, text)
                     or _made_up(seg, text) or seg.get("no_speech", 0) >= NO_SPEECH_SUSPECT)
        out.append({"id": "", "speaker": speaker, "start": round(float(seg["start"]), 3),
                    "end": round(float(seg["end"]), 3), "text": text, "words": words,
                    "low": [i for i, w in enumerate(words) if w["p"] < LOW_CONF],
                    "reviewed": False, "excluded": False, "uncertain": uncertain,
                    "exclude_reason": None,
                    "source": f"track:{speaker}"})
    return out


def dedupe(entries: list[dict], track_rms: Callable[[str, float, float], float]) -> tuple[list[dict], int]:
    """분리가 덜 돼 같은 말이 두 화자 트랙에 다 받아써진 경우를 표시한다. 지우지는 않는다.
    그 구간 소리 차이가 뚜렷하면 작은 쪽을 문서에서 빼 두고(검수에서 확인), 엇비슷하면 둘 다 의심 표시만 한다."""
    excluded = set()
    for i, a in enumerate(entries):
        for j in range(i + 1, len(entries)):
            b = entries[j]
            if i in excluded or j in excluded or a["speaker"] == b["speaker"]:
                continue
            s, e = max(a["start"], b["start"]), min(a["end"], b["end"])
            shorter = min(a["end"] - a["start"], b["end"] - b["start"])
            if shorter <= 0 or e - s < DUP_OVERLAP * shorter:
                continue
            if difflib.SequenceMatcher(None, _norm(a["text"]), _norm(b["text"])).ratio() < DUP_SIMILARITY:
                continue
            la, lb = track_rms(a["speaker"], s, e), track_rms(b["speaker"], s, e)
            if abs(la - lb) >= AUTO_EXCLUDE_DB:
                k = j if la > lb else i
                entries[k].update(excluded=True, exclude_reason="auto_duplicate")
                excluded.add(k)
            else:
                a["dup_suspect"] = b["dup_suspect"] = True
    return entries, len(excluded)


def mark_short_guess(entries: list[dict], spans: list[tuple[str, float, float, bool]]) -> list[dict]:
    """짧은 소리라 음색으로 추정해 정한 창이, 확실히 정한 같은 사람의 창보다 더 겹친 낱말이 있는 줄을 '화자 추정'으로 표시한다.
    받아쓰기가 떨어진 짧은 대답들을 한 줄로 묶어도 낱말 시각으로 본다(낱말 시각이 없으면 줄 전체로 본다).
    spans: 사람으로 정한 창마다 (화자, 시작, 끝, 추정 여부). 긴 말 가운데 한 창만 추정이면 앞뒤 창이 같은 만큼 덮어 표시하지 않는다."""
    guessed = [s for s in spans if s[3]]
    sure = [s for s in spans if not s[3]]

    def overlap(spk, s, t, group):
        return sum(max(0.0, min(b, t) - max(a, s)) for who, a, b, _ in group if who == spk)

    for e in entries:
        parts = [(w["start"], w["end"]) for w in e.get("words") or []] or [(e["start"], e["end"])]
        if any(overlap(e["speaker"], s, t, guessed) > overlap(e["speaker"], s, t, sure) for s, t in parts):
            e["short_guess"] = True
    return entries


def finalize(entries: list[dict]) -> list[dict]:
    out = sorted(entries, key=lambda x: (x["start"], x["end"]))
    for n, x in enumerate(out, 1):
        x["id"] = f"e{n:04d}"
    return out


def fmt_time(sec: float) -> str:
    s = int(max(0.0, sec))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"
