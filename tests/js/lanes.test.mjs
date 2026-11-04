import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LANES, PRE_ROLL, layoutLanes, nearestSpeaker, activeAt, previewWindow, separatedTrack, newLineSpan, entriesOverlapping,
} from '../../truth_sound/static/editor/lanes.js';
import { analysisSource } from '../../truth_sound/static/ui/analysis_panel.js';
import { unknownNote, UNKNOWN_NOTE } from '../../truth_sound/static/ui/transcript_track.js';

const e = (key, start, end, speaker = 'me') => ({ key, id: key, start, end, speaker });
const laneOf = (res, key) => res.placed.find((p) => p.key === key).lane;

test('constants', () => {
  assert.equal(MAX_LANES, 2);
  assert.equal(PRE_ROLL, 0.3);
});

test('layoutLanes: lines that do not overlap all sit on lane 0', () => {
  const res = layoutLanes([e('a', 0, 1), e('b', 1, 2), e('c', 5, 6)]);
  assert.deepEqual(res.placed, [{ key: 'a', lane: 0 }, { key: 'b', lane: 0 }, { key: 'c', lane: 0 }]);
  assert.deepEqual(res.more, []);
});

test('layoutLanes: three overlapping lines use lanes 0 and 1 and the third goes to more', () => {
  const res = layoutLanes([e('a', 0, 4), e('b', 1, 5), e('c', 2, 3)]);
  assert.equal(laneOf(res, 'a'), 0);
  assert.equal(laneOf(res, 'b'), 1);
  assert.equal(res.placed.length, 2);
  assert.deepEqual(res.more, [{ start: 2, end: 3, count: 1 }]);
});

test('layoutLanes: a freed lane is reused, the lowest free lane wins', () => {
  // b(1~2)가 끝난 뒤 c는 1층이 아니라 0층이 비었으면 0층
  const res = layoutLanes([e('a', 0, 1.5), e('b', 1, 2), e('c', 1.6, 3)]);
  assert.equal(laneOf(res, 'a'), 0);
  assert.equal(laneOf(res, 'b'), 1);
  assert.equal(laneOf(res, 'c'), 0);
  assert.deepEqual(res.more, []);
});

test('layoutLanes: input order does not matter, ties keep input order', () => {
  const res = layoutLanes([e('c', 2, 3), e('a', 0, 4), e('b', 1, 5)]);
  assert.deepEqual(res.placed.map((p) => p.key), ['a', 'b']);
  assert.deepEqual(res.more, [{ start: 2, end: 3, count: 1 }]);
  const tie = layoutLanes([e('x', 0, 1), e('y', 0, 1)]);
  assert.deepEqual(tie.placed, [{ key: 'x', lane: 0 }, { key: 'y', lane: 1 }]);
});

test('layoutLanes: overflow lines that overlap each other are grouped, apart ones are separate', () => {
  const list = [e('a', 0, 10), e('b', 0, 10), e('c', 1, 2), e('d', 1.5, 3), e('f', 20, 30), e('g', 20, 30), e('h', 21, 22)];
  const res = layoutLanes(list);
  assert.deepEqual(res.more, [{ start: 1, end: 3, count: 2 }, { start: 21, end: 22, count: 1 }]);
});

test('layoutLanes: zero-length and tiny lines are still placed, never dropped', () => {
  const res = layoutLanes([e('a', 1, 1), e('b', 1, 1.001)]);
  assert.equal(res.placed.length, 2);
  assert.deepEqual(layoutLanes([]), { placed: [], more: [] });
});

test('nearestSpeaker: speaker of the last line that started at or before t', () => {
  const list = [e('a', 1, 2, 'me'), e('b', 5, 6, 'partner'), e('c', 9, 10, 'bystander')];
  assert.equal(nearestSpeaker(list, 5.5), 'partner');
  assert.equal(nearestSpeaker(list, 5), 'partner');
  assert.equal(nearestSpeaker(list, 100), 'bystander');
});

test('nearestSpeaker: before the first line uses the first line after; none at all gives null', () => {
  const list = [e('a', 3, 4, 'partner'), e('b', 6, 7, 'me')];
  assert.equal(nearestSpeaker(list, 0.5), 'partner');
  assert.equal(nearestSpeaker([], 1), null);
});

test('activeAt: keys of the lines that contain t (end excluded)', () => {
  const list = [e('a', 0, 2), e('b', 1, 3), e('c', 3, 4)];
  assert.deepEqual([...activeAt(list, 1.5)].sort(), ['a', 'b']);
  assert.deepEqual([...activeAt(list, 3)], ['c']);
  assert.equal(activeAt(list, 10).size, 0);
});

test('previewWindow: 0.3s before the start, never below 0, and 0.3s after the end', () => {
  assert.deepEqual(previewWindow({ start: 5, end: 6 }), { start: 4.7, end: 6.3 });
  assert.deepEqual(previewWindow({ start: 0.1, end: 0.2 }), { start: 0, end: 0.5 });
});

test('separatedTrack: the speaker track, else the source track, else null', () => {
  const tracks = { me: 'a.wav', unknown: 'u.wav' };
  assert.equal(separatedTrack({ speaker: 'me', source: 'asr' }, tracks), 'me');
  assert.equal(separatedTrack({ speaker: 'unknown', source: 'track:unknown' }, tracks), 'unknown');
  assert.equal(separatedTrack({ speaker: 'partner', source: 'track:me' }, tracks), 'me');
  assert.equal(separatedTrack({ speaker: 'partner', source: 'manual' }, tracks), null);
  assert.equal(separatedTrack({ speaker: 'me' }, undefined), null);
});

test('newLineSpan: the selection when there is one', () => {
  assert.deepEqual(newLineSpan({ selection: { start: 3.1234, end: 4.5678 }, playhead: 0, duration: 10 }), { start: 3.123, end: 4.568 });
  assert.deepEqual(newLineSpan({ selection: { start: 3, end: 99 }, playhead: 0, duration: 10 }), { start: 3, end: 10 });
});

test('newLineSpan: without a selection two seconds from the playhead, kept inside the recording', () => {
  assert.deepEqual(newLineSpan({ selection: null, playhead: 1.5, duration: 10 }), { start: 1.5, end: 3.5 });
  assert.deepEqual(newLineSpan({ selection: null, playhead: 9, duration: 10 }), { start: 9, end: 10 });
  assert.deepEqual(newLineSpan({ selection: null, playhead: 10, duration: 10 }), { start: 8, end: 10 });
  assert.deepEqual(newLineSpan({ selection: null, playhead: 0, duration: 1 }), { start: 0, end: 1 });
});

test('entriesOverlapping: lines that share time with the span, in start order', () => {
  const list = [e('c', 5, 6), e('a', 0, 2), e('b', 1, 3), e('d', 8, 9)];
  assert.deepEqual(entriesOverlapping(list, 1.5, 5.5).map((x) => x.key), ['a', 'b', 'c']);
  assert.deepEqual(entriesOverlapping(list, 2.5, 4).map((x) => x.key), ['b']);
  assert.deepEqual(entriesOverlapping(list, 3.5, 4.5), []);
});

test('entriesOverlapping: touching only at an edge is not an overlap', () => {
  const list = [e('a', 0, 2), e('b', 4, 6)];
  assert.deepEqual(entriesOverlapping(list, 2, 4), []); // 끝이 닿기만 함
  assert.deepEqual(entriesOverlapping(list, 6, 8), []);
  assert.deepEqual(entriesOverlapping(list, 0, 0.001).map((x) => x.key), ['a']); // 아주 짧은 구간도 겹치면 포함
  assert.deepEqual(entriesOverlapping(list, 1.999, 2.001).map((x) => x.key), ['a']);
});

test('entriesOverlapping: a very short line inside the span is kept, ties keep input order, input is not changed', () => {
  const list = [e('x', 1, 1.001), e('w', 1, 1.5), e('v', 0.5, 3)];
  const copy = list.slice();
  assert.deepEqual(entriesOverlapping(list, 0, 5).map((x) => x.key), ['v', 'x', 'w']);
  assert.deepEqual(list, copy);
  assert.deepEqual(entriesOverlapping([], 0, 5), []);
  assert.deepEqual(entriesOverlapping(undefined, 0, 5), []);
});

test('analysisSource: heading name and analyzed track come from the same row', () => {
  const audio = { id: 'me', kind: 'audio', track: 'me', name: '나' };
  assert.deepEqual(analysisSource(audio), { track: 'me', name: '나' });
  assert.deepEqual(analysisSource({ id: 'orig', kind: 'audio', track: 'orig', name: '원본' }), { track: 'orig', name: '원본' });
  // 샘플·녹취록 줄에 초점이 있어도 분석한 소리는 원본이라 제목도 원본
  assert.deepEqual(analysisSource({ id: '@samples', kind: 'samples', name: '목소리 샘플' }), { track: 'orig', name: '원본' });
  assert.deepEqual(analysisSource({ id: '@transcript', kind: 'transcript', name: '녹취록' }), { track: 'orig', name: '원본' });
  assert.deepEqual(analysisSource(null), { track: 'orig', name: '원본' });
});

test('separatedTrack: source가 original이면 unknown 트랙이 있어도 null', () => {
  assert.equal(separatedTrack({ speaker: 'unknown' }, { unknown: 't.wav' }, 'original'), null);
  assert.equal(separatedTrack({ speaker: 'me' }, { me: 't.wav' }, 'original'), null);
  assert.equal(separatedTrack({ speaker: 'me' }, { me: 't.wav' }, 'diarized'), 'me', '다른 출처는 그대로');
  assert.equal(separatedTrack({ speaker: 'me' }, { me: 't.wav' }), 'me', '출처를 모르면 그대로');
});

test('unknownNote: 출처에 따라 문구가 다르다', () => {
  assert.equal(unknownNote('original'), '화자를 나누지 않고 받아 적었습니다. 원본을 들어 화자를 고르세요.');
  assert.equal(unknownNote(undefined), UNKNOWN_NOTE);
  assert.equal(unknownNote(null), UNKNOWN_NOTE);
  assert.equal(unknownNote('diarized'), UNKNOWN_NOTE);
});
