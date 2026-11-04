import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView } from '../../truth_sound/static/editor/view.js';
import { DRAG_PX, selectionFromDrag, moveEdge, formatClock, parseClock, speechStep } from '../../truth_sound/static/editor/selection.js';

const v = fitView(100, 1000);

test('drag of 3px or less is a click', () => {
  assert.equal(DRAG_PX, 3);
  assert.equal(selectionFromDrag(v, 100, 103, 'orig'), null);
  assert.deepEqual(selectionFromDrag(v, 100, 104, 'orig'), { start: 10, end: 10.4, track: 'orig' });
});

test('drag right-to-left is normalised', () => {
  assert.deepEqual(selectionFromDrag(v, 500, 200, 'orig'), { start: 20, end: 50, track: 'orig' });
});

test('drag is clamped to the file', () => {
  assert.deepEqual(selectionFromDrag(v, -50, 100, 'orig'), { start: 0, end: 10, track: 'orig' });
  assert.deepEqual(selectionFromDrag(v, 900, 5000, 'orig'), { start: 90, end: 100, track: 'orig' });
  assert.equal(selectionFromDrag(v, 2000, 3000, 'orig'), null);
});

test('moveEdge clamps and never crosses', () => {
  const sel = { start: 10, end: 20, track: 'orig' };
  assert.deepEqual(moveEdge(sel, 'start', 12, 100), { start: 12, end: 20, track: 'orig' });
  assert.deepEqual(moveEdge(sel, 'start', 25, 100), { start: 20, end: 20, track: 'orig' });
  assert.deepEqual(moveEdge(sel, 'start', -3, 100), { start: 0, end: 20, track: 'orig' });
  assert.deepEqual(moveEdge(sel, 'end', 150, 100), { start: 10, end: 100, track: 'orig' });
  assert.deepEqual(moveEdge(sel, 'end', 5, 100), { start: 10, end: 10, track: 'orig' });
  assert.equal(sel.start, 10);
});

test('clock round trip', () => {
  assert.equal(formatClock(5.05), '00:00:05.050');
  assert.equal(formatClock(3725.0004), '01:02:05.000');
  assert.equal(formatClock(-1), '00:00:00.000');
  assert.equal(parseClock('00:00:05.050'), 5.05);
  assert.equal(parseClock('5.05'), 5.05);
  assert.equal(parseClock('1:05.2'), 65.2);
  assert.equal(parseClock('00:01:05.200'), 65.2);
  assert.equal(parseClock(' 7 '), 7);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('1:2:3:4'), null);
  assert.equal(parseClock('1.5:20'), null);
  assert.equal(parseClock('-5'), null);
});

const SP = [[1, 2], [4, 4.2], [6, 7]];

test('speechStep forward picks the first speech starting after t', () => {
  assert.deepEqual(speechStep(SP, 0, 1), [1, 2]);
  assert.deepEqual(speechStep(SP, 2, 1), [4, 4.2]);
});

test('speechStep forward from inside a speech skips to the next one', () => {
  assert.deepEqual(speechStep(SP, 4.1, 1), [6, 7]);
  assert.deepEqual(speechStep(SP, 4.1, 1, true), [6, 7]);
  assert.deepEqual(speechStep(SP, 4, 1, true), [6, 7]); // 선택의 시작점에 서 있어도 그 다음
});

test('speechStep without a selection also picks a speech that starts exactly at t', () => {
  assert.deepEqual(speechStep([[0, 0.5], [1, 2]], 0, 1), [0, 0.5]); // 말소리로 시작하는 녹음의 첫 말소리
  assert.deepEqual(speechStep(SP, 4, 1), [4, 4.2]);
  assert.deepEqual(speechStep([[0, 0.5], [1, 2]], 0, 1, true), [1, 2]); // 선택이 있으면 그 선택은 건너뛴다
});

test('speechStep backward without a selection picks a speech that ends exactly at t', () => {
  assert.deepEqual(speechStep(SP, 4.2, -1), [4, 4.2]);
  assert.deepEqual(speechStep(SP, 4.2, -1, true), [1, 2]);
  assert.equal(speechStep([[0, 0.5], [1, 2]], 0, -1), null);
});

test('speechStep backward mirrors forward', () => {
  assert.deepEqual(speechStep(SP, 10, -1), [6, 7]);
  assert.deepEqual(speechStep(SP, 6, -1), [4, 4.2]);
  assert.deepEqual(speechStep(SP, 4.1, -1), [1, 2]); // 안에 있으면 그 앞의 것
});

test('speechStep returns null at the ends and for empty input', () => {
  assert.equal(speechStep(SP, 6.5, 1), null);
  assert.equal(speechStep(SP, 7, 1), null);
  assert.equal(speechStep(SP, 1, -1), null);
  assert.equal(speechStep(SP, 0.5, -1), null);
  assert.equal(speechStep([], 0, 1), null);
  assert.equal(speechStep(undefined, 0, -1), null);
});

test('speechStep copies the interval it returns', () => {
  const r = speechStep(SP, 0, 1);
  r[0] = 99;
  assert.deepEqual(SP[0], [1, 2]);
});
