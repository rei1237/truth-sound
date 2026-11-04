import numpy as np
import pytest

from truth_sound import editing


def test_multiple_cuts_use_edited_coordinates_and_keep_source_ranges():
    edits = editing.add_cut(None, 2, 4, 10, "t1")
    assert editing.cuts_from_edits(edits, 10) == [[2.0, 4.0]]
    assert editing.edited_duration(10, editing.cuts_from_edits(edits, 10)) == 8

    # 첫 컷 뒤 편집본 3~4초는 원본 5~6초다.
    edits = editing.add_cut(edits, 3, 4, 10, "t2")
    assert editing.cuts_from_edits(edits, 10) == [[2.0, 4.0], [5.0, 6.0]]
    assert editing.edited_duration(10, editing.cuts_from_edits(edits, 10)) == 7


def test_cut_can_cross_an_old_join_and_becomes_two_source_ranges():
    edits = editing.add_cut(None, 4, 6, 10, "t1")
    edits = editing.add_cut(edits, 3.5, 4.5, 10, "t2")
    assert edits["history"][1]["source_ranges"] == [[3.5, 4.0], [6.0, 6.5]]
    assert editing.cuts_from_edits(edits, 10) == [[3.5, 6.5]]


def test_undo_redo_and_new_cut_after_undo():
    edits = editing.add_cut(None, 1, 2, 10, "t1")
    edits = editing.add_cut(edits, 2, 3, 10, "t2")
    undone = editing.move_cursor(edits, -1)
    assert editing.cuts_from_edits(undone, 10) == [[1.0, 2.0]]
    assert editing.cuts_from_edits(editing.move_cursor(undone, 1), 10) == [[1.0, 2.0], [3.0, 4.0]]
    changed = editing.add_cut(undone, 5, 6, 10, "t3")
    assert len(changed["history"]) == 2
    assert editing.move_cursor(changed, -1)["cursor"] == 1


def test_invalid_short_and_entire_recording_cuts_are_rejected():
    with pytest.raises(ValueError, match="0.05초"):
        editing.add_cut(None, 1, 1.01, 10, "t")
    with pytest.raises(ValueError, match="전체"):
        editing.add_cut(None, 0, 10, 10, "t")


def test_source_sample_projection_splits_and_restores():
    cuts = [[3, 5]]
    assert editing.source_ranges_to_edited([[2, 6]], 10, cuts) == [[2.0, 4.0]]
    projected = editing.project_interval([[2, 6]], 10, cuts)
    assert projected["partial"] is True
    assert editing.source_ranges_to_edited([[2, 6]], 10, []) == [[2.0, 6.0]]


def test_transcript_partial_is_review_required_and_fully_cut_line_is_hidden():
    entries = [
        {"id": "a", "start": 2, "end": 6, "source_ranges": [[2, 6]], "reviewed": True},
        {"id": "b", "start": 3, "end": 4, "source_ranges": [[3, 4]], "reviewed": True},
    ]
    view = editing.project_entries(entries, 10, [[3, 5]])
    assert [e["id"] for e in view] == ["a"]
    assert (view[0]["start"], view[0]["end"]) == (2, 4)
    assert view[0]["cut_review_required"] is True
    assert view[0]["reviewed"] is False


def test_audio_cut_and_expand_preserve_source_without_mutation():
    source = np.arange(10, dtype=np.float32)
    edited = editing.cut_audio(source, 1, [[2, 4], [7, 8]])
    assert edited.tolist() == [0, 1, 4, 5, 6, 8, 9]
    expanded = editing.expand_audio(edited, 1, 10, [[2, 4], [7, 8]])
    assert expanded.tolist() == [0, 1, 0, 0, 4, 5, 6, 0, 8, 9]
    assert source.tolist() == list(range(10))


def test_old_case_without_edits_is_unchanged():
    case = {"original": {"probe": {"duration": 10}}}
    assert editing.summary(case)["duration"] == 10
    assert editing.summary(case)["revision"] == 0
