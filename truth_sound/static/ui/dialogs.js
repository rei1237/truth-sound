// 윗줄 봉인(원본 SHA-256 확인)과 [내보내기]·[처리 기록] 대화창.
import { h, dialog, popover, toast, fmtDate } from './dom.js';
import { processingSummary } from '../editor/session.js';
import { speakerName } from '../speakers.js';
import { draftNotice } from './transcript_panel.js';

const NONE = '기록 없음';
const enc = encodeURIComponent;

// ---------- 윗줄 봉인 ----------
// 봉인 표시 규칙. 빨간 경고는 마지막으로 받은 결과가 ✗일 때만 켜 두고, 다시 확인하는 중이거나
// 확인 요청이 실패해도 끄지 않는다(성공한 확인이 ok를 돌려줘야 꺼진다). 배지는 그때그때 상태를 따른다.
export function sealView({ last, checking = false, failed = false }) {
  const warn = Boolean(last && !last.ok);
  if (failed) return { kind: 'unk', text: '확인 못 함', warn };
  if (checking || !last) return { kind: 'wait', text: '확인 중', warn };
  return last.ok ? { kind: 'ok', text: '✓ 원본 그대로', warn } : { kind: 'bad', text: '✗ 원본이 바뀜', warn };
}

// 내보내기 대화창의 원본 확인 줄. result는 방금 받은 결과(실패·밀림이면 null), last는 마지막으로 받은 결과.
// null이어도 마지막 결과가 있으면 그것을 그려서 ✗를 감추지 않고, 없으면 "확인하는 중…"에 멈추지 않게 알린다.
export function integrityView(result, last) {
  const c = result || last;
  if (!c) return { kind: 'warn', text: '원본을 확인하지 못했습니다 — 다시 열어 확인하세요' };
  if (c.ok) return { kind: 'ok', text: `원본 파일의 SHA-256 값이 등록 때와 같습니다. (${fmtDate(c.checked_at)} 확인)` };
  return { kind: 'error', text: `경고: 원본 파일이 등록 때와 다릅니다. 등록 때 ${c.expected} / 지금 ${c.actual || '파일 없음'}. 문서에도 이 경고가 들어갑니다.` };
}

// 사건을 열 때마다 하나 만든다. 닫을 때 destroy()로 늦게 온 응답을 버린다.
// 상태: 확인 중 / ✓ 원본 그대로 / ✗ 원본이 바뀜(빨간 경고를 윗줄에 계속 둔다) / 확인 못 함(요청 실패).
export function createSeal({ api, session, seal, state, warn }) {
  const id = session.case.id;
  const sha = (session.case.original || {}).sha256 || '';
  let last = null; // 마지막으로 받은 결과
  let inflight = null;
  let seq = 0;
  let dead = false;
  let closePop = null;
  let popBox = null;

  function paint({ checking = false, failed = false } = {}) {
    const v = sealView({ last, checking, failed });
    seal.className = `seal ${v.kind}`;
    state.textContent = v.text;
    warn.hidden = !v.warn;
    warn.textContent = v.warn ? '경고: 보관한 원본 파일이 등록 때와 다릅니다. 문서에도 이 경고가 들어갑니다.' : '';
  }

  // 새로 확인한다. 더 늦게 시작한 확인이 있으면 이 응답은 버리고 null을 돌려준다.
  function check() {
    const my = ++seq;
    paint({ checking: true });
    const p = (async () => {
      try {
        const r = await api.get(`/api/cases/${enc(id)}/integrity`);
        if (dead || my !== seq) return null;
        last = r;
        paint();
        return r;
      } catch (e) {
        if (dead || my !== seq) return null;
        paint({ failed: true });
        toast(e.message, true);
        return null;
      } finally {
        if (inflight === p) inflight = null;
        if (!dead && my === seq) refreshPop();
      }
    })();
    inflight = p;
    refreshPop();
    return p;
  }

  // 진행 중인 확인이 있으면 그 결과를, 없으면 새로 확인한다(대화창을 열 때).
  const ensure = () => inflight || check();

  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      toast('SHA-256 값을 복사했습니다.');
    } catch {
      const code = popBox && popBox.querySelector('code');
      if (code) {
        const r = document.createRange();
        r.selectNodeContents(code);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      }
      toast('선택된 값을 Ctrl+C로 복사하세요.');
    }
  }

  function popParts() {
    const bad = last && !last.ok;
    return [
      h('b', {}, '원본 SHA-256'),
      h('code', {}, sha || NONE),
      h('div', { class: 'seal-row' },
        h('button', { type: 'button', onclick: copy }, '복사'),
        h('button', { type: 'button', disabled: Boolean(inflight), onclick: () => { check(); } }, inflight ? '확인 중…' : '다시 확인')),
      bad ? h('p', { class: 'bad' }, `지금 ${last.actual || '파일 없음'}`) : null,
      h('p', { class: 'hint' }, last ? `마지막 확인 ${fmtDate(last.checked_at)}` : '아직 확인하지 못했습니다.'),
    ];
  }

  function refreshPop() {
    if (popBox && popBox.isConnected) popBox.replaceChildren(...popParts().filter(Boolean));
  }

  function onClick() {
    if (closePop && popBox && popBox.isConnected) { closePop(); closePop = popBox = null; return; }
    popBox = h('div', { class: 'seal-pop' }, popParts());
    closePop = popover(seal, popBox);
  }

  seal.addEventListener('click', onClick);
  paint({ checking: true });
  check();

  return {
    check,
    ensure,
    last: () => last, // 마지막으로 받은 결과(없으면 null)
    destroy() {
      dead = true;
      seal.removeEventListener('click', onClick);
      if (closePop) closePop();
      closePop = popBox = null;
      warn.hidden = true;
    },
  };
}

// ---------- [내보내기] ----------
// 내보내기 전에 검수 내용을 저장하지 못했을 때의 글. 저장이 409(낡은 화면)로 막힌 거면 기다려도 풀리지 않는다.
export function flushFailText(conflict) {
  return `검수 내용을 저장하지 못해 문서를 만들지 않았습니다. ${conflict ? '화면이 낡았습니다. 녹음을 다시 열어 주세요.' : '잠시 뒤 다시 누르세요.'}`;
}

const link = (href, label, name) => h('a', { href, download: name }, label, h('small', {}, name));

export function openExportDialog({ session, api, seal, onClose }) {
  const c = session.case;
  const id = c.id;
  const fileUrl = (name) => `/api/cases/${enc(id)}/files/${enc(name)}`;
  const msg = (kind, text) => h('div', { class: `dlg-msg ${kind}`, hidden: !text }, text || '');
  const integrity = msg('info', '원본을 확인하는 중…');
  const draft = msg('warn', session.transcript ? draftNotice(session.transcript.entries) : '');
  const error = msg('error', '');
  const counts = msg('info', '');
  const files = h('div', { class: 'dlg-files' });
  const go = h('button', { type: 'button', class: 'pri', disabled: !session.transcript, onclick: doExport }, '녹취록 문서 만들기');
  let closed = false;

  function show(el, kind, text) {
    el.className = `dlg-msg ${kind}`;
    el.textContent = text;
    el.hidden = !text;
  }

  function paintCheck(check) {
    const v = integrityView(check, seal.last());
    show(integrity, v.kind, v.text);
  }

  async function doExport() {
    go.disabled = true;
    go.textContent = '만드는 중…';
    error.hidden = true;
    try {
      if (!(await session.flush())) throw new Error(flushFailText(session.conflict()));
      const out = await api.post(`/api/cases/${enc(id)}/export`);
      const { reviewed, total, excluded } = out.counts;
      show(counts, 'info', `저장된 녹취록 기준: 문서에 넣은 줄 ${total - excluded}개, 뺀 줄 ${excluded}개, 검수 ${reviewed}/${total}줄`);
      const labels = { docx: '녹취록 (Word 문서)', txt: '녹취록 (텍스트)', log: '처리 기록 (JSON)' };
      files.replaceChildren(...Object.entries(out.files).map(([k, path]) => {
        const name = path.split('/').pop();
        return link(fileUrl(name), labels[k] || k, name);
      }));
      if (!closed) paintCheck(await seal.check());
    } catch (e) {
      show(error, 'error', e.message);
    } finally {
      go.disabled = !session.transcript;
      go.textContent = '녹취록 문서 만들기';
    }
  }

  const tracks = (c.processing && c.processing.tracks) || {};
  const trackLinks = Object.entries(tracks).map(([sid, path]) => {
    const name = path.split('/').pop();
    return link(fileUrl(name), `${speakerName(c.speakers, sid)} 목소리`, name);
  });
  const origPath = `data\\cases\\${id}\\${String((c.original || {}).path || '').replace(/\//g, '\\')}`;

  const body = h('div', { class: 'dlg-export' },
    h('p', { class: 'hint' }, '녹취록 문서(DOCX·TXT), 처리 기록(JSON), 사람별 분리 음성(WAV)을 내려받습니다.'),
    integrity,
    draft,
    session.transcript ? null : msg('warn', '아직 처리하지 않아 녹취록이 없습니다. 화자 분리를 먼저 하세요.'),
    h('div', { class: 'dlg-act' }, go),
    error,
    counts,
    files,
    h('h3', {}, '사람별 분리 음성 ', h('span', { class: 'sub' }, '— 청취 보조용, 원본 아님')),
    trackLinks.length ? h('div', { class: 'dlg-files' }, trackLinks) : h('p', { class: 'hint' }, NONE),
    h('h3', {}, '원본'),
    h('p', { class: 'hint' }, '원본 사본은 프로그램 폴더의 ', h('span', { class: 'path' }, origPath), '에 읽기 전용으로 보관되어 있습니다. 제출할 때는 처음 받은 원본 파일을 함께 내세요.'));

  const close = dialog('내보내기', body, () => { closed = true; if (onClose) onClose(); });
  seal.ensure().then(paintCheck);
  return close;
}

// ---------- [처리 기록] ----------
// 값 하나를 한 줄 글로. 목록은 쉼표, 사전은 "이름 값"을 가운뎃점으로 잇는다.
export function valueText(v) {
  if (v === null || v === undefined) return NONE;
  if (Array.isArray(v)) return v.length ? v.map(valueText).join(', ') : '없음';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${valueText(x)}`).join(' · ');
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}

const LOG_KEYS = {
  name: '파일', file: '파일', folder: '폴더', speakers: '화자', entries: '줄 수', duplicates_excluded: '겹쳐서 뺀 줄',
  assigned_seconds: '찾은 말(초)', short_guess_windows: '짧은 소리 추정 구간', error: '이유', expected: '등록 때', actual: '지금',
  original_ok: '원본 그대로',
};

export function openHistoryDialog({ session, onClose }) {
  const c = session.case;
  const sum = processingSummary(c);
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  const none = h('span', { class: 'none' }, NONE);
  const summary = !c.processing
    ? h('p', { class: 'hint' }, '아직 화자 분리를 하지 않았습니다. 처리 요약이 없습니다.')
    : h('dl', { class: 'hist-sum' },
      row('모델', sum.model ? valueText(sum.model) : none),
      row('샘플 밖에서 찾은 말', sum.assigned ? sum.assigned.map((a) => `${a.name} ${a.seconds.toFixed(1)}초`).join(' · ') : none),
      row('짧은 소리 추정 구간', sum.shortGuessWindows === null ? none : `${sum.shortGuessWindows}개`),
      row('경고', sum.warnings === null ? none
        : sum.warnings.length ? h('ul', { class: 'warn' }, sum.warnings.map((w) => h('li', {}, w))) : '없음'),
      row('판정 설정', sum.settings
        ? h('details', {}, h('summary', {}, '펼쳐 보기'), h('p', { class: 'cfg' }, valueText(sum.settings))) : none));
  const log = sum.log.length
    ? h('ol', { class: 'hist-log' }, sum.log.map(({ at, what, ...rest }) => h('li', {},
      h('time', {}, fmtDate(at, true)),
      h('span', { class: 'what' }, what),
      Object.keys(rest).length ? h('small', {}, Object.entries(rest).map(([k, v]) => `${LOG_KEYS[k] || k} ${valueText(v)}`).join(' · ')) : null)))
    : h('p', { class: 'hint' }, NONE);
  return dialog('처리 기록', h('div', { class: 'dlg-hist' },
    h('h3', {}, '처리 요약'), summary,
    h('h3', {}, '사건 기록'), log), onClose);
}
