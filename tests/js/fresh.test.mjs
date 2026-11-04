import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreshMarks } from '../../truth_sound/static/editor/fresh.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('only ids marked in this tab are fresh', () => {
  const f = createFreshMarks(memStorage());
  assert.equal(f.has('a'), false);
  f.mark('a');
  assert.equal(f.has('a'), true);
  assert.equal(f.has('b'), false);
});

test('clear makes a case no longer discardable', () => {
  const f = createFreshMarks(memStorage());
  f.mark('a');
  f.clear('a');
  assert.equal(f.has('a'), false);
});

test('marks survive a reload through storage', () => {
  const s = memStorage();
  createFreshMarks(s).mark('a');
  assert.equal(createFreshMarks(s).has('a'), true);
});

test('works in memory when storage throws or is missing', () => {
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  for (const s of [bad, null, undefined]) {
    const f = createFreshMarks(s);
    f.mark('a');
    assert.equal(f.has('a'), true);
    f.clear('a');
    assert.equal(f.has('a'), false);
  }
});

test('opening a case by any route releases its fresh mark', async () => {
  const { releaseOnOpen } = await import('../../truth_sound/static/editor/fresh.js');
  const f = createFreshMarks(memStorage());
  f.mark('x');
  f.mark('y');
  releaseOnOpen(f, { view: 'empty', card: 'x' }); // 카드 주소는 사건을 여는 것이 아니다
  assert.equal(f.has('x'), true);
  releaseOnOpen(f, { view: 'case', id: 'x', tab: 'analysis' });
  assert.equal(f.has('x'), false);
  assert.equal(f.has('y'), true);
  releaseOnOpen(f, { view: 'empty' }); // 없는 번호도 안전
  releaseOnOpen(f, null);
});
