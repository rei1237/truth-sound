// 사건 불러오기·저장 묶음. DOM을 만지지 않는다. 사건을 열기만 해서는 GET만 보내고, 사용자가 고쳤을 때만 PUT을 보낸다.
import { createSaver } from '../saver.js';
import { speakerName } from '../speakers.js';

const LOCKED_MESSAGE = '처리 중에는 바꿀 수 없습니다.';

// fetch를 감싼 얇은 클라이언트. 실패하면 서버가 준 detail을 메시지로 한 Error(status 포함)를 던진다.
export function createApi(fetchFn) {
  async function request(method, path, body, opts = {}) {
    const init = { method, ...opts };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new Error('서버에 연결할 수 없습니다. Truth Sound 창이 켜져 있는지 확인하세요.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (!res.ok) {
      const err = new Error((data && data.detail) || `요청 실패 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return {
    get: (path) => request('GET', path),
    // opts는 창을 닫는 중에도 보내야 할 때 { keepalive: true }
    put: (path, body, opts) => request('PUT', path, body, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    del: (path) => request('DELETE', path),
  };
}

// 예전 app.js가 녹취록 PUT에 싣던 줄 모양 그대로.
const entryBody = ({ id, speaker, text, reviewed, excluded, exclude_reason: reason, start, end }) => (
  { id, speaker, text, reviewed, excluded: !!excluded, exclude_reason: reason || null, start, end });

export function createSession({ api, id, onState = () => {} }) {
  const base = `/api/cases/${encodeURIComponent(id)}`;
  let lockOverride = null; // null이면 사건 상태(processing)를 따른다
  // 저장이 409로 막혔는지(낡은 화면). 409는 기다려도 풀리지 않으니 안내가 "다시 열어 주세요"여야 한다.
  const conflicts = { speakers: false, transcript: false };
  const track = (scope, notify) => (state, err) => {
    if (state === 'error') conflicts[scope] = Boolean(err && err.status === 409);
    else if (state === 'saved') conflicts[scope] = false;
    notify(state, err, scope);
  };

  const session = {
    case: null,
    transcript: null,
    speech: null,
  };

  // 목소리 지정: 500ms 뒤 한 번 보낸다.
  const speakersSaver = createSaver({
    delay: 500,
    onState: track('speakers', onState),
    send: (keepalive) => api.put(`${base}/speakers`, {
      speakers: session.case.speakers.map(({ id: sid, name, enroll }) => ({ id: sid, name: name.trim(), enroll })),
    }, { keepalive }),
  });

  // 녹취록: 700ms 뒤 한 번, 실패하면 3초 뒤 다시.
  const transcriptSaver = createSaver({
    onState: track('transcript', onState),
    send: (keepalive) => {
      if (!session.transcript) return Promise.resolve();
      return api.put(`${base}/transcript`, {
        created_at: session.transcript.created_at,
        entries: session.transcript.entries.map(entryBody),
      }, { keepalive });
    },
  });

  function assertEditable() {
    if (session.locked) throw new Error(LOCKED_MESSAGE);
  }

  // GET만 부른다: 사건, (있으면) 녹취록, 말소리 구간.
  session.load = async function load() {
    speakersSaver.reset();
    transcriptSaver.reset();
    conflicts.speakers = conflicts.transcript = false;
    session.case = await api.get(base);
    session.transcript = session.case.has_transcript ? await api.get(`${base}/transcript`) : null;
    session.speech = await api.get(`${base}/speech`);
    return session;
  };

  // 처리 중이면 true. 작업 상태가 바뀌면 화면이 setLocked로 알린다(null이면 사건 상태로 되돌아간다).
  Object.defineProperty(session, 'locked', {
    get: () => (lockOverride === null ? Boolean(session.case && session.case.status === 'processing') : lockOverride),
  });
  session.setLocked = (value) => { lockOverride = value === null ? null : Boolean(value); };

  session.edit = async function edit(kind, range = null) {
    assertEditable();
    if (!(await session.flush())) throw new Error('저장 중인 변경을 먼저 확인해 주세요.');
    const revision = (session.case.edit && session.case.edit.revision) || 0;
    const body = range ? { start: range.start, end: range.end, revision } : { revision };
    return api.post(`${base}/edits/${kind}`, body);
  };

  session.setSpeakers = function setSpeakers(speakers) {
    assertEditable();
    session.case.speakers = speakers;
    speakersSaver.changed();
  };

  session.changeEntry = function changeEntry(key, patch) {
    assertEditable();
    const entry = session.transcript && session.transcript.entries.find((e) => e.id === key);
    if (!entry) throw new Error('없는 줄입니다.');
    Object.assign(entry, patch);
    transcriptSaver.changed();
    return entry;
  };

  // 시작 시각 순서에 맞춰 끼워 넣는다.
  session.addEntry = function addEntry(entry) {
    assertEditable();
    if (!session.transcript) throw new Error('녹취록이 없습니다.');
    const list = session.transcript.entries;
    const at = list.findIndex((x) => x.start > entry.start);
    list.splice(at < 0 ? list.length : at, 0, entry);
    transcriptSaver.changed();
    return entry;
  };

  // 고친 내용이 모두 나갈 때까지 기다린다. 하나라도 실패하면 false.
  session.flush = async function flush() {
    const [a, b] = await Promise.all([speakersSaver.flush(), transcriptSaver.flush()]);
    return a && b;
  };

  session.conflict = () => conflicts.speakers || conflicts.transcript;

  session.pending = () => speakersSaver.pending || transcriptSaver.pending;

  // 창을 닫는 중: 기다리지 않고 바로 보낸다(keepalive).
  session.saveNow = function saveNow() {
    speakersSaver.save(true);
    transcriptSaver.save(true);
  };

  return session;
}

// [처리 기록] 대화창에 보일 요약. 사건 JSON의 processing·log를 읽기 좋게 고른다.
// 없는 필드(예전 사건, 아직 처리 안 한 사건)는 null이고 화면이 "기록 없음"으로 보인다.
export function processingSummary(caseData) {
  const c = caseData || {};
  const p = c.processing || {};
  const has = (k) => p[k] !== undefined && p[k] !== null;
  const assigned = has('assigned_seconds')
    ? Object.entries(p.assigned_seconds).map(([sid, seconds]) => ({ name: speakerName(c.speakers, sid), seconds }))
    : null;
  const log = (Array.isArray(c.log) ? c.log : [])
    .map(({ at, event, ...details }) => ({ at, what: event, ...details }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // 같은 시각이면 기록된 순서 그대로(정렬이 안정적)
  return {
    model: has('models') ? p.models : null,
    settings: has('settings') ? p.settings : null,
    assigned,
    warnings: has('warnings') ? p.warnings : null,
    shortGuessWindows: has('short_guess_windows') ? p.short_guess_windows : null,
    log,
  };
}
