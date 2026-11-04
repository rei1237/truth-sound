import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../../truth_sound/static/saver.js';

const settle = () => new Promise((r) => setImmediate(r));
const fail = (status) => Object.assign(new Error('저장 실패'), { status });

// 보낸 요청을 하나씩 손으로 끝낸다. failFrom번째 요청부터는 바로 실패한다.
function fakeServer(failFrom = Infinity) {
  const calls = [];
  const send = () => {
    let done;
    const promise = new Promise((resolve, reject) => { done = { resolve, reject }; });
    calls.push(done);
    if (calls.length > failFrom) done.reject(fail(400));
    return promise;
  };
  return { calls, send };
}

test('flush waits for edits made while a save was in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const srv = fakeServer();
  const saver = createSaver({ send: srv.send });
  saver.changed();
  saver.save();
  saver.changed();
  let result = null;
  const flushed = saver.flush().then((ok) => { result = ok; });
  srv.calls[0].resolve();
  await settle();
  assert.equal(srv.calls.length, 2);
  assert.equal(result, null, '새로 고친 내용이 저장되기 전에 끝났다고 하면 안 된다');
  srv.calls[1].resolve();
  await flushed;
  assert.equal(result, true);
});

test('flush reports failure when the newest edits were not saved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const srv = fakeServer(2);
  const saver = createSaver({ send: srv.send });
  saver.changed();
  saver.save();
  saver.changed();
  const flushed = saver.flush();
  srv.calls[0].resolve();
  await settle();
  srv.calls[1].reject(fail(400));
  assert.equal(await flushed, false);
  assert.equal(saver.pending, true);
});

test('waits for a pause in editing and retries after a server error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const srv = fakeServer();
  const states = [];
  const saver = createSaver({ send: srv.send, onState: (s) => states.push(s), delay: 700, retryDelay: 3000 });
  saver.changed();
  saver.changed();
  t.mock.timers.tick(699);
  assert.equal(srv.calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(srv.calls.length, 1);
  srv.calls[0].reject(fail(503));
  await settle();
  assert.equal(states.at(-1), 'error');
  t.mock.timers.tick(3000);
  assert.equal(srv.calls.length, 2);
  srv.calls[1].resolve();
  await settle();
  assert.equal(states.at(-1), 'saved');
  assert.equal(await saver.flush(), true);
});

test('reset forgets edits of the case that was left', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const srv = fakeServer();
  const states = [];
  const saver = createSaver({ send: srv.send, onState: (s) => states.push(s) });
  saver.changed();
  saver.save();
  saver.reset();
  srv.calls[0].reject(fail(503));
  await settle();
  assert.equal(saver.pending, false);
  assert.ok(!states.includes('error'));
  t.mock.timers.tick(10000);
  assert.equal(srv.calls.length, 1);
});
