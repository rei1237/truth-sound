import test from 'node:test';
import assert from 'node:assert/strict';

// 가짜 document: 요소는 자식과 연결 여부만 갖는다. popover가 스스로 닫히는 길(Esc)을 시험하려고 문서 듣개를 모아 둔다.
class FakeEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {};
    this.parentElement = null; this.hidden = false; this.disabled = false; this.className = ''; this.textContent = '';
    this.cls = {};
    this.classList = { toggle: (c, on) => { this.cls[c] = on; }, remove: (c) => { this.cls[c] = false; } };
  }
  get isConnected() { return this === overlay || Boolean(this.parentElement && this.parentElement.isConnected); }
  append(...kids) { for (const k of kids) { if (k instanceof FakeEl) k.parentElement = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); this.parentElement = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { this.listeners[k] = f; }
  removeEventListener(k) { delete this.listeners[k]; }
  contains(n) { return n === this || this.children.some((c) => c instanceof FakeEl && c.contains(n)); }
  getBoundingClientRect() { return { left: 900, right: 1200, bottom: 40 }; }
  querySelector(sel) {
    const cls = sel.slice(1);
    for (const c of this.children) {
      if (!(c instanceof FakeEl)) continue;
      if (c.className === cls) return c;
      const r = c.querySelector(sel);
      if (r) return r;
    }
    return null;
  }
  focus() {}
}
const overlay = new FakeEl('div');
const docListeners = {};
globalThis.Node = FakeEl;
globalThis.window = { innerWidth: 1280 };
globalThis.document = {
  createElement: (t) => new FakeEl(t),
  getElementById: (id) => (id === 'overlay' ? overlay : null),
  body: overlay,
  addEventListener: (k, f) => { docListeners[k] = f; },
  removeEventListener: (k) => { delete docListeners[k]; },
};

const { createProcessPanel } = await import('../../truth_sound/static/ui/process_panel.js');

const text = (e) => (e instanceof FakeEl ? [e.textContent, ...e.children.map(text)].join(' ') : String(e));
const popovers = () => overlay.children.filter((c) => c.className === 'popover');
const speakers = [{ id: 'me', name: '나', enroll: [[1, 2]] }, { id: 'partner', name: '상대방', enroll: [[5, 6]] }];

function setup({ job = { state: 'idle' }, api = {}, onFinished, caseOver = {} } = {}) {
  const lock = [];
  const session = { case: { id: 'c1', status: 'new', speakers, has_transcript: false, ...caseOver }, setLocked: (v) => lock.push(v), flush: async () => true };
  const els = { button: new FakeEl('button'), transcribeButton: new FakeEl('button'), why: new FakeEl('span'), strip: new FakeEl('div') };
  let locks = 0;
  const panel = createProcessPanel({ session, api, ...els, job, onLock: () => { locks++; }, onFinished });
  return { panel, lock, locksOf: () => locks, ...els };
}

test('after the bubble closes itself with Esc, one click opens it again', () => {
  overlay.children = [];
  const { button, panel } = setup();
  button.listeners.click();
  assert.equal(popovers().length, 1);
  docListeners.keydown({ key: 'Escape', stopPropagation() {} }); // popover가 스스로 닫는다
  assert.equal(popovers().length, 0);
  button.listeners.click();
  assert.equal(popovers().length, 1, 'one click reopens');
  button.listeners.click(); // 열려 있을 때 누르면 닫힌다
  assert.equal(popovers().length, 0);
  panel.destroy();
});

test('a failed re-mount after a finished run releases the lock and tells the user', async () => {
  overlay.children = [];
  const api = { get: async () => ({ state: 'done', case_id: 'c1', stage: '정리', progress: 1, message: '끝' }) };
  const { strip, lock, locksOf, panel } = setup({
    job: { state: 'running', case_id: 'c1', stage: '정리', progress: 0.5, message: '' },
    api,
    onFinished: async () => '서버가 응답하지 않습니다.',
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lock, [true, false]);
  assert.ok(locksOf() >= 1);
  assert.match(text(strip), /서버가 응답하지 않습니다\./);
  assert.match(text(strip), /다시 열어/);
  panel.destroy();
});

test('a throwing re-mount also releases the lock with its message', async () => {
  overlay.children = [];
  const api = { get: async () => ({ state: 'done', case_id: 'c1', stage: '정리', progress: 1, message: '끝' }) };
  const { strip, lock, panel } = setup({
    job: { state: 'running', case_id: 'c1', stage: '정리', progress: 0.5, message: '' },
    api,
    onFinished: async () => { throw new Error('열지 못했습니다'); },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lock, [true, false]);
  assert.match(text(strip), /열지 못했습니다/);
  panel.destroy();
});

test('a successful re-mount leaves the lock to the new session', async () => {
  overlay.children = [];
  const api = { get: async () => ({ state: 'done', case_id: 'c1', stage: '정리', progress: 1, message: '끝' }) };
  const { lock, panel } = setup({
    job: { state: 'running', case_id: 'c1', stage: '정리', progress: 0.5, message: '' },
    api,
    onFinished: async () => null,
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lock, [true]);
  panel.destroy();
});

test('after a failed re-mount, 화자 분리 is refused and the panel reports the stale screen', async () => {
  overlay.children = [];
  const api = { get: async () => ({ state: 'done', case_id: 'c1', stage: '정리', progress: 1, message: '끝' }) };
  const { button, why, panel } = setup({
    job: { state: 'running', case_id: 'c1', stage: '정리', progress: 0.5, message: '' },
    api,
    onFinished: async () => '서버가 응답하지 않습니다.',
  });
  assert.equal(panel.reloadFailed(), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(panel.reloadFailed(), true);
  assert.match(why.textContent, /다시 열어/);
  assert.equal(why.hidden, false);
  button.listeners.click(); // 확인 말풍선도 열리지 않는다
  assert.equal(popovers().length, 0);
  panel.destroy();
});

test('같은 사건의 clarify 완료에 녹취록 검수 알림을 띄우지 않는다', async () => {
  overlay.children = [];
  const api = { get: async () => ({ state: 'done', case_id: 'c1', kind: 'clarify', speaker: 'me', step: 'denoise', stage: '정리', progress: 1, message: '끝' }) };
  let finished = 0;
  const { lock, panel } = setup({
    job: { state: 'running', case_id: 'c1', kind: 'process', stage: '정리', progress: 0.5, message: '' },
    api,
    onFinished: async () => { finished++; return null; },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finished, 0);
  assert.ok(!overlay.children.some((c) => /녹취록을 검수/.test(text(c))), 'no review toast');
  assert.deepEqual(lock, [true, false]);
  panel.destroy();
});

test('같은 사건의 clarify가 도는 동안 처리 단추는 이 녹음을 처리하는 중이라고 막는다', () => {
  overlay.children = [];
  const { why, lock, panel } = setup({ job: { state: 'running', case_id: 'c1', kind: 'clarify', speaker: 'me', step: 'denoise', stage: '잡음 제거', progress: 0.2, message: '' } });
  assert.equal(why.textContent, '이 녹음을 처리하는 중입니다.');
  assert.deepEqual(lock, [], 'clarify는 편집을 잠그지 않는다');
  panel.destroy();
});

const withTracks = { has_transcript: true, processing: { tracks: { me: 'me.wav' } } };
const transcriptOnly = { has_transcript: true, processing: { tracks: {} } };
const transcribeJob = (over = {}) => ({ state: 'running', case_id: 'c1', kind: 'transcribe', stage: '확인', progress: 0, message: '', ...over });

test('process button: 녹취록만 있고 트랙이 없으면 이름은 화자 분리, 말풍선에 덮어쓰기 경고', () => {
  overlay.children = [];
  const { button, panel } = setup({ caseOver: transcriptOnly });
  assert.equal(button.textContent, '화자 분리');
  button.listeners.click();
  assert.match(text(popovers()[0]), /화자 분리를 시작할까요\?/);
  assert.match(text(popovers()[0]), /지금 녹취록과 고친 내용이 새 결과로 바뀝니다\./);
  panel.destroy();
});

test('process button: 트랙이 있으면 다시 처리', () => {
  overlay.children = [];
  const { button, panel } = setup({ caseOver: withTracks });
  assert.equal(button.textContent, '다시 처리');
  button.listeners.click();
  assert.match(text(popovers()[0]), /다시 처리할까요\?/);
  panel.destroy();
});

test('process button: 녹취록도 트랙도 없으면 덮어쓰기 경고가 없다', () => {
  overlay.children = [];
  const { button, panel } = setup({ caseOver: { has_transcript: false, processing: null } });
  assert.equal(button.textContent, '화자 분리');
  button.listeners.click();
  assert.doesNotMatch(text(popovers()[0]), /새 결과로 바뀝니다/);
  panel.destroy();
});

test('transcribe button: 샘플이 없어도 눌리고 말풍선 안내가 나온다', () => {
  overlay.children = [];
  const { transcribeButton, panel } = setup({ caseOver: { speakers: [{ id: 'me', name: '나', enroll: [] }] } });
  assert.equal(transcribeButton.disabled, false);
  assert.equal(transcribeButton.cls.blocked, false);
  transcribeButton.listeners.click();
  const t = text(popovers()[0]);
  assert.match(t, /녹취록을 만들까요\?/);
  assert.match(t, /샘플을 몇 명 지정했는지와 관계없이 사람별 화자 분리는 하지 않습니다\./);
  assert.match(t, /겹쳐 말한 곳은 화자 분리를 했을 때보다 더 틀리거나 빠질 수 있습니다\./);
  assert.match(t, /처음 한 번은 받아쓰기 모델 약 3GB를 내려받습니다\./);
  assert.doesNotMatch(t, /이전 녹취록은 보관됩니다/);
  assert.doesNotMatch(t, /분리한 트랙은 그대로 둡니다/);
  panel.destroy();
});

test('transcribe button: 한 사람에게 샘플이 있어도 /transcribe를 호출한다', async () => {
  overlay.children = [];
  const calls = [];
  const api = { post: async (u) => { calls.push(u); return transcribeJob(); }, get: async () => transcribeJob() };
  const { transcribeButton, panel } = setup({
    caseOver: { speakers: [{ id: 'me', name: '나', enroll: [[1, 2]] }] }, api,
  });
  assert.equal(transcribeButton.disabled, false);
  assert.equal(transcribeButton.cls.blocked, false);
  transcribeButton.listeners.click();
  popovers()[0].querySelector('.pri').listeners.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, ['/api/cases/c1/transcribe']);
  panel.destroy();
});
test('transcribe button: 트랙이 있어도 트랙을 건드리지 않는다는 안내와 /transcribe 호출', async () => {
  overlay.children = [];
  const calls = [];
  const api = { post: async (u) => { calls.push(u); return transcribeJob(); }, get: async () => transcribeJob() };
  const { transcribeButton, lock, panel } = setup({ caseOver: withTracks, api });
  transcribeButton.listeners.click();
  const t = text(popovers()[0]);
  assert.match(t, /지금 녹취록과 고친 내용이 새 결과로 바뀝니다\. 이전 녹취록은 보관됩니다\./);
  assert.match(t, /분리한 트랙은 그대로 둡니다\./);
  popovers()[0].querySelector('.pri').listeners.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, ['/api/cases/c1/transcribe']);
  assert.deepEqual(lock, [true]);
  panel.destroy();
});

test('process button: 화자 분리는 /process를 부른다', async () => {
  overlay.children = [];
  const calls = [];
  const running = { ...transcribeJob(), kind: 'process' };
  const { button, panel } = setup({ api: { post: async (u) => { calls.push(u); return running; }, get: async () => running } });
  button.listeners.click();
  popovers()[0].querySelector('.pri').listeners.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, ['/api/cases/c1/process']);
  panel.destroy();
});

test('받아쓰기 작업이 도는 동안 띠는 받아쓰기 단계만 보이고 두 단추가 모두 막힌다', () => {
  overlay.children = [];
  const { strip, why, button, transcribeButton, panel } = setup({ job: transcribeJob({ stage: '받아쓰기', progress: 0.5, message: '받아쓰는 중' }) });
  const t = text(strip);
  for (const n of ['확인', '준비', '받아쓰기', '정리']) assert.match(t, new RegExp(n));
  assert.doesNotMatch(t, /목소리 분리/);
  assert.equal(why.textContent, '이 녹음을 처리하는 중입니다.');
  assert.equal(transcribeButton.cls.blocked, true);
  assert.equal(button.cls.blocked, true);
  transcribeButton.listeners.click();
  assert.equal(popovers().length, 0);
  panel.destroy();
});

test('받아쓰기가 끝나면 녹취록을 만들었다는 알림', async () => {
  overlay.children = [];
  const api = { get: async () => transcribeJob({ state: 'done', stage: '정리', progress: 1, message: '끝' }) };
  const { panel } = setup({ job: transcribeJob({ stage: '정리', progress: 0.5 }), api, onFinished: async () => null });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(overlay.children.some((c) => /녹취록을 만들었습니다\. 검수하세요\./.test(text(c))));
  assert.ok(!overlay.children.some((c) => /처리가 끝났습니다/.test(text(c))));
  panel.destroy();
});
