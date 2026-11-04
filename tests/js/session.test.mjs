import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, createSession, processingSummary } from '../../truth_sound/static/editor/session.js';
import { sealView, integrityView, flushFailText } from '../../truth_sound/static/ui/dialogs.js';

const ID = '20261031-192419-60a7';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeEntry = (id, start) => ({
  id, speaker: 'me', text: `글 ${id}`, reviewed: false, excluded: false, exclude_reason: null,
  start, end: start + 1, words: [{ w: 'x' }], low: [0], source: 'asr',
});

// 가짜 서버: 부른 요청(method, path, body)을 calls에 모은다. 응답은 routes로 정한다.
function fakeFetch(calls, { hasTranscript = true, status = 'ready', fail = {} } = {}) {
  const routes = {
    [`/api/cases/${ID}`]: {
      id: ID, status, has_transcript: hasTranscript,
      speakers: [{ id: 'me', name: '나', enroll: [[0, 5]] }],
    },
    [`/api/cases/${ID}/transcript`]: { created_at: '2026-11-01T00:00:00', entries: [makeEntry('a', 1), makeEntry('b', 5)] },
    [`/api/cases/${ID}/speech`]: { speech: [[0, 2], [4, 6]], duration: 10 },
  };
  return async (path, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined, keepalive: opts.keepalive });
    const bad = fail[`${method} ${path}`];
    if (bad) return { ok: false, status: bad.status, json: async () => ({ detail: bad.detail }) };
    return { ok: true, status: 200, json: async () => (method === 'GET' ? routes[path] : { ok: true }) };
  };
}

async function open(opts) {
  const calls = [];
  const s = createSession({ api: createApi(fakeFetch(calls, opts)), id: ID });
  await s.load();
  calls.length = 0;
  return { s, calls };
}

test('opening a case sends only GET', async () => {
  const calls = [];
  const s = createSession({ api: createApi(fakeFetch(calls)), id: ID });
  await s.load(); await s.flush(); await sleep(900);
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
  assert.deepEqual(calls.map((c) => c.path), [`/api/cases/${ID}`, `/api/cases/${ID}/transcript`, `/api/cases/${ID}/speech`]);
  assert.equal(s.case.id, ID);
  assert.equal(s.transcript.entries.length, 2);
  assert.deepEqual(s.speech, { speech: [[0, 2], [4, 6]], duration: 10 });
  assert.equal(s.pending(), false);
});

test('load skips transcript when the case has none', async () => {
  const calls = [];
  const s = createSession({ api: createApi(fakeFetch(calls, { hasTranscript: false })), id: ID });
  await s.load();
  assert.deepEqual(calls.map((c) => c.path), [`/api/cases/${ID}`, `/api/cases/${ID}/speech`]);
  assert.equal(s.transcript, null);
});

test('setSpeakers debounces one PUT after 500ms', async () => {
  const { s, calls } = await open();
  s.setSpeakers([{ id: 'me', name: ' 나 ', enroll: [[0, 5]], extra: 1 }]);
  s.setSpeakers([{ id: 'me', name: ' 나나 ', enroll: [[0, 6]], extra: 1 }]);
  assert.equal(s.pending(), true);
  await sleep(300);
  assert.equal(calls.length, 0);
  await sleep(400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, `/api/cases/${ID}/speakers`);
  assert.deepEqual(calls[0].body, { speakers: [{ id: 'me', name: '나나', enroll: [[0, 6]] }] });
  assert.equal(s.pending(), false);
});

test('flush sends pending speakers immediately', async () => {
  const { s, calls } = await open();
  s.setSpeakers([{ id: 'me', name: '나', enroll: [[0, 5]] }]);
  assert.equal(await s.flush(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/cases/${ID}/speakers`);
  assert.equal(s.pending(), false);
  await sleep(700);
  assert.equal(calls.length, 1);
});

test('entry change PUTs transcript with old payload shape', async () => {
  const { s, calls } = await open();
  s.changeEntry('a', { text: '고친 글', reviewed: true });
  assert.equal(s.pending(), true);
  await s.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, `/api/cases/${ID}/transcript`);
  assert.deepEqual(calls[0].body, {
    created_at: '2026-11-01T00:00:00',
    entries: [
      { id: 'a', speaker: 'me', text: '고친 글', reviewed: true, excluded: false, exclude_reason: null, start: 1, end: 2 },
      { id: 'b', speaker: 'me', text: '글 b', reviewed: false, excluded: false, exclude_reason: null, start: 5, end: 6 },
    ],
  });
});

test('transcript save waits 700ms', async () => {
  const { s, calls } = await open();
  s.changeEntry('b', { excluded: true, exclude_reason: '잡음' });
  await sleep(500);
  assert.equal(calls.length, 0);
  await sleep(400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.entries[1].exclude_reason, '잡음');
});

test('addEntry inserts by start time and saves', async () => {
  const { s, calls } = await open();
  s.addEntry(makeEntry('c', 3));
  assert.deepEqual(s.transcript.entries.map((e) => e.id), ['a', 'c', 'b']);
  await s.flush();
  assert.deepEqual(calls[0].body.entries.map((e) => e.id), ['a', 'c', 'b']);
});

test('changeEntry with unknown key throws and sends nothing', async () => {
  const { s, calls } = await open();
  assert.throws(() => s.changeEntry('zzz', { text: 'x' }), /줄/);
  await s.flush();
  assert.equal(calls.length, 0);
});

test('locked session refuses edits', async () => {
  const { s, calls } = await open({ status: 'processing' });
  assert.equal(s.locked, true);
  assert.throws(() => s.setSpeakers([]), { message: '처리 중에는 바꿀 수 없습니다.' });
  assert.throws(() => s.changeEntry('a', { text: 'x' }), { message: '처리 중에는 바꿀 수 없습니다.' });
  assert.throws(() => s.addEntry(makeEntry('c', 3)), { message: '처리 중에는 바꿀 수 없습니다.' });
  await s.flush(); await sleep(900);
  assert.equal(calls.length, 0);
  assert.equal(s.transcript.entries[0].text, '글 a');
});

test('setLocked overrides case status when the job state changes', async () => {
  const { s } = await open({ status: 'processing' });
  s.setLocked(false);
  assert.equal(s.locked, false);
  s.changeEntry('a', { text: 'ok' });
  s.setLocked(true);
  assert.equal(s.locked, true);
  assert.throws(() => s.changeEntry('a', { text: 'no' }), /처리 중/);
});

test('cut edit flushes first and sends the current revision', async () => {
  const { s, calls } = await open();
  s.case.edit = { revision: 4 };
  await s.edit('cut', { start: 1, end: 2 });
  assert.deepEqual(calls, [{ method: 'POST', path: `/api/cases/${ID}/edits/cut`,
    body: { start: 1, end: 2, revision: 4 }, keepalive: undefined }]);
});

test('api errors carry server detail and status', async () => {
  const calls = [];
  const api = createApi(fakeFetch(calls, { fail: { [`PUT /api/x`]: { status: 409, detail: '이미 처리 중' } } }));
  await assert.rejects(() => api.put('/api/x', {}), (e) => e.message === '이미 처리 중' && e.status === 409);
  const down = createApi(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => down.get('/api/x'), /서버에 연결할 수 없습니다/);
});

test('api put/post/del send JSON with the right method', async () => {
  const calls = [];
  const api = createApi(fakeFetch(calls));
  await api.put('/p', { a: 1 }); await api.post('/q', { b: 2 }); await api.del('/r');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['PUT', '/p', { a: 1 }], ['POST', '/q', { b: 2 }], ['DELETE', '/r', undefined]]);
});

test('onState reports save progress', async () => {
  const states = [];
  const calls = [];
  const s = createSession({ api: createApi(fakeFetch(calls)), id: ID, onState: (st) => states.push(st) });
  await s.load();
  s.changeEntry('a', { text: 'x' });
  await s.flush();
  assert.deepEqual(states, ['pending', 'saving', 'saved']);
});

// ---- 처리 기록 정리 ----
const SPK = [{ id: 'me', name: '나' }, { id: 'partner', name: '상대' }];

test('processingSummary: old case without warnings/short_guess_windows gives null for them', () => {
  const sum = processingSummary({
    speakers: SPK,
    log: [{ at: '2026-10-31T19:24:19', event: '원본 등록', name: 'a.m4a' }],
    processing: { models: { separator: 'sep' }, settings: { window_sec: 1 }, assigned_seconds: { me: 3.5, unknown: 1 } },
  });
  assert.equal(sum.warnings, null);
  assert.equal(sum.shortGuessWindows, null);
  assert.deepEqual(sum.model, { separator: 'sep' });
  assert.deepEqual(sum.settings, { window_sec: 1 });
  assert.deepEqual(sum.assigned, [{ name: '나', seconds: 3.5 }, { name: '화자 확인 필요', seconds: 1 }]);
  assert.deepEqual(sum.log, [{ at: '2026-10-31T19:24:19', what: '원본 등록', name: 'a.m4a' }]);
});

test('processingSummary: new case fills every field', () => {
  const sum = processingSummary({
    speakers: SPK,
    log: [],
    processing: {
      models: { separator: 's', encoder: 'e', transcriber: 't' }, settings: { hop_sec: 0.5 },
      assigned_seconds: { me: 10, partner: 0, unknown: 2.5 }, warnings: ['경고 하나'], short_guess_windows: 4,
    },
  });
  assert.deepEqual(sum.warnings, ['경고 하나']);
  assert.equal(sum.shortGuessWindows, 4);
  assert.deepEqual(sum.assigned.map((a) => a.name), ['나', '상대', '화자 확인 필요']);
  assert.deepEqual(sum.log, []);
});

test('processingSummary: empty warnings list stays a list, zero short guesses stays 0', () => {
  const sum = processingSummary({ speakers: SPK, log: [], processing: { warnings: [], short_guess_windows: 0 } });
  assert.deepEqual(sum.warnings, []);
  assert.equal(sum.shortGuessWindows, 0);
  assert.equal(sum.model, null);
  assert.equal(sum.assigned, null);
});

test('processingSummary: never processed case has every processing field null; log sorted by time', () => {
  const sum = processingSummary({
    speakers: SPK,
    log: [{ at: '2026-10-31T20:00:00', event: '처리 시작', speakers: ['me'] }, { at: '2026-10-31T19:00:00', event: '원본 등록', name: 'a' }],
  });
  assert.deepEqual([sum.model, sum.settings, sum.assigned, sum.warnings, sum.shortGuessWindows], [null, null, null, null, null]);
  assert.deepEqual(sum.log.map((x) => x.what), ['원본 등록', '처리 시작']);
  assert.deepEqual(processingSummary({}).log, []);
});

// ---- 봉인 표시 규칙 ----
test('sealView: tamper warning stays while re-checking and after a failed re-check', () => {
  const bad = { ok: false };
  const ok = { ok: true };
  assert.equal(sealView({ last: null, checking: true }).warn, false);
  assert.deepEqual(sealView({ last: bad, checking: false }), { kind: 'bad', text: '✗ 원본이 바뀜', warn: true });
  assert.equal(sealView({ last: bad, checking: true }).kind, 'wait');
  assert.equal(sealView({ last: bad, checking: true }).warn, true); // 다시 확인 중에도
  assert.equal(sealView({ last: bad, failed: true }).kind, 'unk');
  assert.equal(sealView({ last: bad, failed: true }).warn, true); // 확인 요청이 실패해도
  assert.deepEqual(sealView({ last: ok }), { kind: 'ok', text: '✓ 원본 그대로', warn: false }); // 성공한 ok만 지운다
  assert.equal(sealView({ last: ok, failed: true }).warn, false);
});

// ---- 내보내기 대화창의 원본 확인 표시 ----
test('integrityView: a fresh result is painted, a null result falls back to the last one, never to silence', () => {
  const ok = { ok: true, checked_at: '2026-11-01T10:00:00' };
  const bad = { ok: false, expected: 'aaa', actual: 'bbb', checked_at: '2026-11-01T10:00:00' };
  assert.equal(integrityView(ok, null).kind, 'ok');
  assert.equal(integrityView(bad, null).kind, 'error');
  // 새 확인이 null(실패·밀림)이어도 마지막 결과를 그린다: ✗를 감추지 않는다
  const kept = integrityView(null, bad);
  assert.equal(kept.kind, 'error');
  assert.match(kept.text, /등록 때 aaa \/ 지금 bbb/);
  assert.equal(integrityView(null, ok).kind, 'ok');
  // 아무 결과도 없으면 "확인하는 중…"에 멈추지 않고 못 했다고 알린다
  const none = integrityView(null, null);
  assert.equal(none.kind, 'warn');
  assert.equal(none.text, '원본을 확인하지 못했습니다 — 다시 열어 확인하세요');
  // 파일이 없을 때(actual 없음)
  assert.match(integrityView({ ...bad, actual: null }, null).text, /지금 파일 없음/);
});

// ---- 저장이 409로 막혔을 때의 안내 ----
test('session.conflict(): a 409 from a saver is a conflict, a 5xx is not, a later success clears it', async () => {
  const put = `PUT /api/cases/${ID}/transcript`;
  const { s } = await open({ fail: { [put]: { status: 409, detail: '녹취록이 새로 만들어졌습니다.' } } });
  assert.equal(s.conflict(), false);
  s.changeEntry('a', { text: 'x' });
  assert.equal(await s.flush(), false);
  assert.equal(s.conflict(), true);
  // 409가 아닌 실패(여기서는 400; 5xx는 3초마다 다시 보내는 타이머가 남는다)는 충돌이 아니다
  const { s: s4 } = await open({ fail: { [put]: { status: 400, detail: '잘못된 요청' } } });
  s4.changeEntry('a', { text: 'x' });
  assert.equal(await s4.flush(), false);
  assert.equal(s4.conflict(), false);
});

test('flushFailText: a conflict says reopen, a transient failure says try again later', () => {
  assert.match(flushFailText(false), /잠시 뒤 다시 누르세요/);
  assert.doesNotMatch(flushFailText(false), /다시 열어/);
  assert.match(flushFailText(true), /다시 열어 주세요/);
  assert.doesNotMatch(flushFailText(true), /잠시 뒤/);
});
