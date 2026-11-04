import numpy as np
from truth_sound.transcript import (EXCLUDE_REASONS, LOW_CONF, dedupe, finalize, fmt_time, from_segments,
                                   mark_short_guess)


def seg(start, end, text, ps=None):
    ws = text.split()
    ps = ps or [0.9] * len(ws)
    return {"start": start, "end": end, "text": text,
            "words": [{"w": w, "start": start, "end": end, "p": p} for w, p in zip(ws, ps)]}


def test_from_segments_flags_low_confidence():
    out = from_segments("partner", [seg(1.0, 2.0, " 돈은 이미 보냈어요", [0.9, 0.3, 0.8])])
    assert len(out) == 1
    e = out[0]
    assert e["speaker"] == "partner" and e["text"] == "돈은 이미 보냈어요"
    assert e["low"] == [1] and e["words"][1]["p"] < LOW_CONF
    assert e["reviewed"] is False and e["source"] == "track:partner"


def test_from_segments_retains_caption_candidates():
    out = from_segments("me", [seg(0, 1, "시청해 주셔서 감사합니다."), seg(1, 2, "   "),
                               seg(2, 3, "구독과 좋아요"), seg(3, 4, "네 알겠습니다")])
    assert [e["uncertain"] for e in out] == [True, True, False]


def test_from_segments_marks_high_no_speech_caption_variant():
    made_up = seg(0, 1.2, "자막 제공 배달의민족")
    made_up["no_speech"] = 0.75
    real = seg(2, 4, "자막 제공 안내를 확인했습니다")
    real["no_speech"] = 0.1

    out = from_segments("me", [made_up, real])

    assert [e["uncertain"] for e in out] == [True, False]


def test_from_segments_includes_suspect_line_for_review():
    # 실제 사례: 말 끝 0.6초 꼬리를 따로 받아쓰며 지어낸 자막 문구(말 없음 확률 0.98, 초당 29음절)
    s = seg(15.51, 16.09, "영상편집 및 자료조사 김재경 기상캐스터")
    s["no_speech"] = 0.98
    out = from_segments("partner", [s])
    assert len(out) == 1  # 지우지 않는다
    assert out[0]["uncertain"] and not out[0]["excluded"]
    assert EXCLUDE_REASONS["auto_hallucination"] == "자동: 지어낸 말 의심"


def test_from_segments_keeps_short_or_plausible_lines():
    short = seg(3.0, 3.0, "네")  # 아주 짧은 대답은 시각이 한 점이어도 남긴다
    short["no_speech"] = 0.9
    normal = seg(12.39, 13.9, "그 돈은 이미 다 보냈다고")  # 말 없음 확률이 높아도 말 속도가 사람 범위
    normal["no_speech"] = 0.98
    fast = seg(15.51, 16.09, "영상편집 및 자료조사 김재경 기상캐스터")  # 말 없음 확률이 낮으면 남긴다
    fast["no_speech"] = 0.1
    old = seg(15.51, 16.09, "영상편집 및 자료조사 김재경 기상캐스터")  # 예전 받아쓰기 결과(확률 없음)
    out = from_segments("me", [short, normal, fast, old])
    assert [e["excluded"] for e in out] == [False, False, False, False]


def test_dedupe_marks_not_deletes():
    a = from_segments("partner", [seg(5.0, 7.0, "그 돈은 이미 다 보냈다고")])
    b = from_segments("bystander", [seg(5.2, 7.1, "그 돈은 이미 다 보냈다구")])
    rms = {"partner": -20.0, "bystander": -45.0}
    kept, marked = dedupe(a + b, lambda spk, s, e: rms[spk])
    assert marked == 1 and [e["speaker"] for e in kept] == ["partner", "bystander"]
    assert kept[0]["excluded"] is False
    assert kept[1]["excluded"] is True and kept[1]["exclude_reason"] == "auto_duplicate"
    assert kept[1]["reviewed"] is False


def test_dedupe_keeps_both_when_levels_close():
    a = from_segments("partner", [seg(5.0, 7.0, "그 돈은 이미 다 보냈다고")])
    b = from_segments("bystander", [seg(5.2, 7.1, "그 돈은 이미 다 보냈다구")])
    rms = {"partner": -20.0, "bystander": -25.0}
    kept, marked = dedupe(a + b, lambda spk, s, e: rms[spk])
    assert marked == 0 and not any(e["excluded"] for e in kept)
    assert all(e["dup_suspect"] for e in kept)


def test_dedupe_keeps_different_text():
    a = from_segments("partner", [seg(5.0, 7.0, "그 돈은 이미 다 보냈다고")])
    b = from_segments("bystander", [seg(5.5, 7.0, "아니야 아직 한 푼도 안 보냈잖아")])
    kept, marked = dedupe(a + b, lambda spk, s, e: -20.0)
    assert marked == 0 and len(kept) == 2
    assert not any(e["excluded"] or e.get("dup_suspect") for e in kept)


def test_finalize_sorted_ids():
    es = from_segments("me", [seg(9.0, 10.0, "셋")]) + from_segments("partner", [seg(1.0, 2.0, "하나"),
                                                                               seg(4.0, 5.0, "둘")])
    out = finalize(es)
    assert [e["text"] for e in out] == ["하나", "둘", "셋"]
    assert [e["id"] for e in out] == ["e0001", "e0002", "e0003"]


def test_fmt_time():
    assert fmt_time(0) == "00:00:00"
    assert fmt_time(3725.9) == "01:02:05"


def test_mark_short_guess_flags_lines_mostly_from_guessed_windows():
    short = from_segments("partner", [seg(12.0, 12.4, "네")])
    long_ = from_segments("partner", [seg(3.0, 6.0, "그 돈은 이미 다 보냈다고")])
    other = from_segments("me", [seg(12.1, 12.5, "응")])
    # (화자, 시작, 끝, 추정 여부): 창이 녹음에 소리를 보태는 범위
    spans = [("partner", 11.9, 12.3, True), ("partner", 12.1, 12.5, True), ("partner", 4.0, 4.4, True)]
    spans += [("partner", 2.9 + 0.2 * i, 3.3 + 0.2 * i, False) for i in range(15)]
    out = mark_short_guess(short + long_ + other, spans)
    assert [e.get("short_guess", False) for e in out] == [True, False, False]


def test_mark_short_guess_flags_merged_line_by_word_times():
    # 실제 사례: 받아쓰기가 10초 떨어진 짧은 대답들을 한 줄로 묶었다. 추정한 '네'만 있어도 줄에 표시한다
    line = from_segments("partner", [seg(12.1, 22.5, "네. 아니요.")])
    line[0]["words"][0].update(start=12.13, end=12.33)
    line[0]["words"][1].update(start=22.18, end=22.52)
    spans = [("partner", 11.9, 12.3, True), ("partner", 12.1, 12.5, True)]
    spans += [("partner", 21.6 + 0.2 * i, 22.0 + 0.2 * i, False) for i in range(5)]
    assert mark_short_guess(line, spans)[0].get("short_guess") is True


def test_mark_short_guess_ignores_lone_guess_inside_continuous_speech():
    # 낱말 '이미'가 추정 창 하나에 걸쳐도 앞뒤 확실한 창이 같은 만큼 덮으면 같은 사람 말의 일부다
    line = from_segments("partner", [seg(3.0, 6.0, "그 돈은 이미 다 보냈다고")])
    for w, (a, b) in zip(line[0]["words"], [(3.0, 3.3), (3.4, 4.2), (4.3, 4.5), (4.6, 4.8), (4.9, 6.0)]):
        w.update(start=a, end=b)
    spans = [("partner", 4.2, 4.6, True)]
    spans += [("partner", c - 0.2, c + 0.2, False) for c in np.arange(3.0, 6.01, 0.2) if abs(c - 4.4) > 0.01]
    assert "short_guess" not in mark_short_guess(line, spans)[0]
