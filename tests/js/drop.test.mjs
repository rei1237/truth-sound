import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_EXT, checkDrag, checkFile, createDragCounter } from '../../truth_sound/static/editor/drop.js';

test('two files are refused with the one-file message', () => {
  const r = checkDrag([{ kind: 'file', type: 'audio/mpeg' }, { kind: 'file', type: 'audio/mpeg' }]);
  assert.equal(r.ok, false);
  assert.equal(r.count, 2);
  assert.equal(r.message, '한 번에 한 파일만 넣을 수 있습니다');
});

test('image, text and pdf drags are refused as not recordings', () => {
  for (const type of ['image/png', 'text/plain', 'application/pdf']) {
    const r = checkDrag([{ kind: 'file', type }]);
    assert.equal(r.ok, false, type);
    assert.equal(r.message, '녹음 파일이 아닙니다', type);
  }
});

test('empty type passes (checked by extension after the drop)', () => {
  const r = checkDrag([{ kind: 'file', type: '' }]);
  assert.deepEqual(r, { ok: true, count: 1, message: '' });
  assert.deepEqual(checkDrag([{ kind: 'file', type: 'audio/x-m4a' }]), { ok: true, count: 1, message: '' });
});

test('non-file drag items are not counted', () => {
  assert.equal(checkDrag([{ kind: 'string', type: 'text/plain' }]).count, 0);
});

test('checkFile ignores extension case and rejects other extensions', () => {
  assert.equal(checkFile('통화.M4A', ''), null);
  assert.equal(checkFile('a.Mp3', 'audio/mpeg'), null);
  assert.equal(typeof checkFile('메모.txt', 'text/plain'), 'string');
  assert.equal(typeof checkFile('noext', ''), 'string');
  assert.ok(ACCEPT_EXT.includes('.m4a') && ACCEPT_EXT.includes('.wma') && ACCEPT_EXT.length === 10);
});

test('drag counter stays on until enters and leaves balance', () => {
  const c = createDragCounter();
  assert.equal(c.active, false);
  c.enter(); c.enter(); c.leave();
  assert.equal(c.active, true);
  c.leave();
  assert.equal(c.active, false);
  c.leave(); // 짝 없는 leave도 음수로 가지 않는다
  c.enter();
  assert.equal(c.active, true);
  c.reset();
  assert.equal(c.active, false);
});
