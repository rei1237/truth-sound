import test from 'node:test';
import assert from 'node:assert/strict';
import { speakerName, assignedLine, warningsOf, speakerColor, UNKNOWN_COLOR, CLIP_COLOR } from '../../truth_sound/static/speakers.js';

test('speakerName maps unknown', () => {
  assert.equal(speakerName([{ id: 'me', name: '나' }], 'unknown'), '화자 확인 필요');
  assert.equal(speakerName([{ id: 'me', name: '나' }], 'me'), '나');
  assert.equal(speakerName([{ id: 'me', name: '나' }], 'gone'), 'gone');
});

test('assignedLine lists people then unknown', () => {
  const p = { speakers: [{ id: 'me', name: '나' }, { id: 'partner', name: '상대방' }],
              assigned_seconds: { me: 12.4, partner: 8, unknown: 3.2 } };
  assert.equal(assignedLine(p), '샘플 밖에서 찾은 말: 나 12.4초 · 상대방 8.0초 · 확인 필요 3.2초');
  p.assigned_seconds.unknown = 0;
  assert.equal(assignedLine(p), '샘플 밖에서 찾은 말: 나 12.4초 · 상대방 8.0초');
});

test('assignedLine/warningsOf handle old processing records', () => {
  assert.equal(assignedLine({ speakers: [] }), '');
  assert.equal(assignedLine(null), '');
  assert.deepEqual(warningsOf({}), []);
  assert.deepEqual(warningsOf(null), []);
  assert.deepEqual(warningsOf({ warnings: ['a'] }), ['a']);
});

test('colors bound to default ids', () => {
  assert.equal(speakerColor([{ id: 'partner' }], 'partner'), '#ffa24c');
  assert.equal(speakerColor([{ id: 'partner' }, { id: 'me' }, { id: 'bystander' }], 'me'), '#5ea8ff');
  assert.equal(speakerColor([{ id: 'bystander' }], 'bystander'), '#41d095');
});

test('other ids use registration order', () => {
  const list = [{ id: 'me' }, { id: 'x1' }, { id: 'partner' }, { id: 'x2' }, { id: 'x3' }, { id: 'x4' }];
  assert.equal(speakerColor(list, 'x1'), '#5ea8ff');
  assert.equal(speakerColor(list, 'x2'), '#ffa24c');
  assert.equal(speakerColor(list, 'x3'), '#41d095');
  assert.equal(speakerColor(list, 'x4'), '#5ea8ff');
});

test('unknown is gray and distinct from clip red', () => {
  assert.equal(UNKNOWN_COLOR, '#9aa0aa');
  assert.equal(CLIP_COLOR, '#ff4d4f');
  assert.equal(speakerColor([{ id: 'me' }], 'unknown'), '#9aa0aa');
  assert.equal(speakerColor([{ id: 'me' }], 'gone'), '#9aa0aa');
  assert.equal(speakerColor(null, 'me'), '#5ea8ff');
});
