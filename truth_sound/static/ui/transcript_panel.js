// [녹취록] 탭: 주의 문구 · 처리 경고 · 줄 수와 검수 남은 수 · 거르기 · [줄 넣기] · 저장 상태, 그리고 줄마다 카드.
// 예전 ④ 검수 표(app.js 7c27522)의 동작을 새 화면 모양으로 옮긴 것이다: 화자 고르기, 포함/제외, 검수 체크, 글 고치기(여러 줄), ▶ 듣기.
// 저장은 session.changeEntry / addEntry가 한다(처리 중에는 던진다). 층 나누기·듣기 구간 같은 계산은 editor/lanes.js.
import { h, fmt, toast } from './dom.js';
import { UNKNOWN, UNKNOWN_NAME, speakerColor, assignedLine, warningsOf } from '../speakers.js';
import { nearestSpeaker, newLineSpan, separatedTrack, previewWindow } from '../editor/lanes.js';
import { pieceKind, GUESS_NOTE, unknownNote } from './transcript_track.js';

export const LOCKED_REASON = '이 녹음을 처리하는 중이라 녹취록을 바꿀 수 없습니다. 처리가 끝나면 고칠 수 있습니다.';
export const NOTICE = '이 녹취록은 Truth Sound가 AI로 받아쓴 초안을 바탕으로 작성되었습니다. 정확한 내용은 원본 녹음 파일을 직접 들어 확인해야 합니다. 함께 제공되는 분리·보정 음성은 청취 보조용이며 원본이 아닙니다.';
const PUNCT = /^[.,?!…~"'\s]+|[.,?!…~"'\s]+$/g;
const EXCLUDE = [['', '문서에 넣기'], ['duplicate', '빼기: 중복'], ['bleed', '빼기: 다른 사람 말이 새어 듦'], ['noise', '빼기: 잡음·지어낸 말']];
const AUTO_EXCLUDE = { auto_duplicate: '빼기: 자동(중복 의심)', auto_hallucination: '빼기: 자동(지어낸 말 의심)' };
const ORIGINAL_NO_SEPARATED = '화자를 나누지 않고 만든 녹취록이라 이 줄의 분리 음성이 없습니다.';
const ADD_TIP ='고른 구간(없으면 재생 위치에서 2초)에 AI가 놓친 말을 직접 적습니다';
const pad = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const emptyLines = (entries) => entries.filter((e) => !e.excluded && !e.text.trim()).length;

// 내보낼 때 문서 제목이 "(초안)"이 되는 까닭을 미리 알리는 글. 초안이 아니면 빈 글. [내보내기] 대화창도 쓴다.
export function draftNotice(entries) {
  const left = entries.filter((e) => !e.reviewed).length;
  const blank = emptyLines(entries);
  return !entries.length ? ''
    : left ? `아직 검수하지 않은 줄이 ${left}개 있어 문서 제목이 "녹취록 (초안)"으로 나가고, 자신 없는 단어 뒤에 (?)가 붙습니다.`
      : blank ? `내용이 빈 줄이 ${blank}개 있어 문서 제목이 "녹취록 (초안)"으로 나갑니다. 글을 적거나 "빼기"를 고르세요.` : '';
}

// 글 안에서 자신 없는 낱말만 <mark>로 표시한다.
function paintText(div, e) {
  div.replaceChildren();
  const text = e.text;
  if (!text) {
    div.append(h('span', { class: 'muted' }, '(빈 줄)'));
    return;
  }
  let pos = 0;
  for (const i of e.low || []) {
    const w = (e.words || [])[i];
    const core = w ? w.w.replace(PUNCT, '') : '';
    const at = core ? text.indexOf(core, pos) : -1;
    if (at < 0) continue;
    div.append(text.slice(pos, at), h('mark', { title: `자신 없는 단어 (확률 ${Math.round(w.p * 100)}%)` }, core));
    pos = at + core.length;
  }
  div.append(text.slice(pos));
}

// 카드 머리에 붙는 표시들
function flagsFor(e, source) {
  const out = [];
  if (e.exclude_reason === 'auto_hallucination') {
    out.push(h('span', { class: 'flag', title: '받아쓰기 모델이 "말이 없다"고 본 곳인데 그 짧은 시간에 말할 수 없을 만큼 글자가 많습니다. 원본을 들어 실제로 한 말이면 "문서에 넣기"를 고르세요.' }, '자동으로 뺌: 지어낸 말 의심'));
  }
  if (e.exclude_reason === 'auto_duplicate') {
    out.push(h('span', { class: 'flag', title: '같은 시각 다른 사람 줄과 같은 말이고, 이 사람 음성에서는 훨씬 작게 들립니다. 맞으면 검수 체크, 아니면 "문서에 넣기"를 고르세요.' }, '자동으로 뺌: 중복 의심'));
  }
  if (e.dup_suspect) {
    out.push(h('span', { class: 'flag', title: '같은 시각 다른 사람 줄과 같은 말입니다. 원본을 들어 누구 말인지 확인하고, 아닌 쪽은 "빼기: 중복"을 고르세요.' }, '중복 의심'));
  }
  if (e.uncertain && !e.reviewed) out.push(h('span', { class: 'flag', title: '원본을 듣고 후보 문구를 확인하세요.' }, '불확실 · 원본 확인 필요'));
  if (e.short_guess) out.push(h('span', { class: 'flag guess', title: GUESS_NOTE }, '짧은 소리: 화자 추정'));
  if (e.speaker === UNKNOWN) out.push(h('span', { class: 'flag unk', title: unknownNote(source) }, UNKNOWN_NAME));
  if (e.source === 'manual') out.push(h('span', { class: 'flag manual' }, '직접 추가한 줄'));
  if (e.cut_review_required) out.push(h('span', { class: 'flag', title: '컷이 이 줄의 일부와 겹쳤습니다. 남은 소리와 글이 맞는지 원본을 들어 다시 확인하세요.' }, '컷 이후 재검수 필요'));
  return out;
}

// root 안에 탭 내용을 만든다.
//  select(range): 그 구간을 타임라인에서 고르고 보이게 한다.  play(win, track): 구간 win을 track 하나만 들려 준다.
//  getSelection/getPlayhead/getDuration: [줄 넣기]가 쓴다.  onChange(): 줄이 바뀌었으니 라벨 트랙을 다시 그리게 한다.
export function createTranscriptPanel(root, { session, select, play, getSelection, getPlayhead, getDuration, onChange = () => {} }) {
  const lock = h('p', { class: 'trp-lock', role: 'status' }, LOCKED_REASON);
  const notice = h('p', { class: 'trp-notice' }, h('strong', {}, '주의'), NOTICE);
  const warnBox = h('div', { class: 'trp-msg warn', hidden: true });
  const assigned = h('p', { class: 'trp-msg info', hidden: true });
  const count = h('span', { class: 'trp-count' });
  const draft = h('p', { class: 'trp-msg warn', hidden: true });
  const onlyBox = h('input', { type: 'checkbox' });
  const onlyLabel = h('label', { class: 'trp-only' }, onlyBox, ' 검수 안 한 줄만');
  const unkBtn = h('button', { type: 'button', class: 'trp-unk', 'aria-pressed': 'false', hidden: true, title: '어느 목소리 샘플과도 뚜렷이 닮지 않은 줄만 봅니다. 원본을 듣고 화자를 고르세요' });
  const addBtn = h('button', { type: 'button', class: 'pri', title: ADD_TIP }, '＋ 줄 넣기');
  const saved = h('span', { class: 'trp-saved', 'aria-live': 'polite' });
  const list = h('div', { class: 'trp-list' });
  const empty = h('p', { class: 'hint', hidden: true });
  root.replaceChildren(h('div', { class: 'trp' },
    lock, notice, warnBox, assigned, draft,
    h('div', { class: 'trp-bar' },
      h('div', { class: 'trp-row' }, count, h('span', { class: 'sp' }), saved),
      h('div', { class: 'trp-row' }, onlyLabel, unkBtn, h('span', { class: 'sp' }), addBtn)),
    list, empty));

  const cards = new Map(); // 줄 열쇠 → {e, el, text, flags}  (거르기로 가려진 줄은 없다)
  let onlyUnreviewed = false;
  let onlyUnknown = false;
  let pickedKey = null;
  let playing = new Set();
  const entries = () => (session.transcript ? session.transcript.entries : []);
  const speakers = () => session.case.speakers || [];

  // 줄을 고친다. 처리 중이면 이유를 알리고 false.
  function change(e, patch) {
    try { session.changeEntry(e.id, patch); } catch (err) { toast(err.message, true); return false; }
    updateCount();
    return true;
  }

  function updateCount() {
    const es = entries();
    const done = es.filter((e) => e.reviewed).length;
    const out = es.filter((e) => e.excluded).length;
    const blank = emptyLines(es);
    const unknown = es.filter((e) => e.speaker === UNKNOWN).length;
    unkBtn.textContent = `화자 확인 필요 ${unknown}줄`;
    unkBtn.hidden = unknown === 0 && !onlyUnknown;
    const tail = out ? ` · 문서에서 뺀 줄 ${out}` : '';
    count.textContent = !es.length ? ''
      : done === es.length && !blank
        ? `모두 검수함 (${es.length}줄${tail}) — 문서 제목이 "녹취록"으로 나갑니다`
        : `검수 ${done} / ${es.length}줄${tail}${blank ? ` · 내용이 빈 줄 ${blank}개(글을 적거나 빼기)` : ''}`;
    // 내보낼 때 붙는 초안 표시를 미리 알려 준다
    draft.textContent = draftNotice(es);
    draft.hidden = !draft.textContent;
  }

  function head() {
    const p = session.case.processing;
    const ws = warningsOf(p);
    warnBox.replaceChildren(...ws.map((w) => h('p', {}, w)));
    warnBox.hidden = ws.length === 0;
    const line = session.case.status === 'done' ? assignedLine(p) : ''; // 지난 처리의 판정 시간(예전 처리 기록에는 없다)
    assigned.textContent = line;
    assigned.hidden = !line;
    lock.hidden = !session.locked;
  }

  // 글 고치기: 글 칸을 누르면 여러 줄 입력으로 바뀐다. Esc 또는 Ctrl+Enter로 끝.
  function startEdit(c) {
    if (c.el.querySelector('textarea')) return;
    if (session.locked) { toast(LOCKED_REASON, true); return; }
    const e = c.e;
    const ta = h('textarea', { class: 'edit', 'aria-label': '내용', rows: 2 });
    ta.value = e.text;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
    c.text.hidden = true;
    c.text.after(ta);
    fit();
    ta.focus();
    ta.addEventListener('input', () => { if (change(e, { text: ta.value })) fit(); });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' || (ev.key === 'Enter' && ev.ctrlKey)) ta.blur();
    });
    ta.addEventListener('blur', () => {
      ta.remove();
      c.text.hidden = false;
      paintText(c.text, e);
      paintCard(c);
      updateCount();
      onChange(); // 조각의 글도 고친 대로
    });
  }

  function paintCard(c) {
    const e = c.e;
    const kind = pieceKind(e);
    c.el.classList.toggle('reviewed', Boolean(e.reviewed));
    c.el.classList.toggle('excluded', Boolean(e.excluded));
    c.el.classList.toggle('guess', kind === 'guess');
    c.el.classList.toggle('unk', kind === 'unk');
    c.el.style.setProperty('--c', speakerColor(speakers(), e.speaker));
    c.flags.replaceChildren(...flagsFor(e, session.transcript && session.transcript.source));
    c.flags.hidden = !c.flags.childNodes.length;
  }

  function pickCard(e) {
    pickedKey = e.id;
    markPicks(null);
    select([e.start, e.end]);
  }

  // 고른 구간과 같은 구간의 카드(없으면 마지막으로 누른 카드)를 표시한다
  function markPicks(sel) {
    for (const [key, c] of cards) {
      const on = sel ? sel.start === c.e.start && sel.end === c.e.end : key === pickedKey;
      c.el.classList.toggle('pick', on);
    }
  }

  function card(e) {
    const locked = session.locked;
    const tracks = (session.case.processing && session.case.processing.tracks) || {};
    const original = Boolean(session.transcript) && session.transcript.source === 'original';
    const sep = separatedTrack(e, tracks, session.transcript && session.transcript.source);
    const c = { e };
    const sel = h('select', { 'aria-label': '화자', disabled: locked },
      speakers().map((s) => h('option', { value: s.id }, s.name)),
      h('option', { value: UNKNOWN }, UNKNOWN_NAME),
      // 화자 목록에서 빠진 사람의 줄도 그대로 보인다
      e.speaker !== UNKNOWN && !speakers().some((s) => s.id === e.speaker) ? h('option', { value: e.speaker }, e.speaker) : null);
    sel.value = e.speaker;
    sel.addEventListener('change', () => {
      if (!change(e, { speaker: sel.value })) { sel.value = e.speaker; return; }
      paintCard(c);
      updateCount();
      onChange();
    });
    const chk = h('input', { type: 'checkbox', 'aria-label': '검수 완료', disabled: locked });
    chk.checked = Boolean(e.reviewed);
    chk.addEventListener('change', () => {
      if (!change(e, { reviewed: chk.checked })) { chk.checked = Boolean(e.reviewed); return; }
      paintCard(c);
      onChange();
    });
    const opts = EXCLUDE.concat(AUTO_EXCLUDE[e.exclude_reason] ? [[e.exclude_reason, AUTO_EXCLUDE[e.exclude_reason]]] : []);
    const incl = h('select', { class: 'incl', 'aria-label': '문서에 넣을지', disabled: locked }, opts.map(([v, label]) => h('option', { value: v }, label)));
    incl.value = e.excluded ? e.exclude_reason || '' : '';
    incl.addEventListener('change', () => {
      const out = incl.value !== '';
      const patch = out ? { excluded: true, exclude_reason: incl.value, reviewed: true } : { excluded: false, exclude_reason: null };
      if (!change(e, patch)) { incl.value = e.excluded ? e.exclude_reason || '' : ''; return; }
      chk.checked = Boolean(e.reviewed);
      paintCard(c);
      onChange();
    });
    c.text = h('div', { class: 'text', tabindex: 0, title: locked ? LOCKED_REASON : '눌러서 고치기' });
    paintText(c.text, e);
    c.text.addEventListener('click', () => startEdit(c));
    c.text.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); startEdit(c); } });
    c.flags = h('div', { class: 'flags' });
    const win = previewWindow(e);
    c.el = h('div', { class: 'tc', 'data-key': e.id, onclick: (ev) => { if (!ev.target.closest('select, input, label, textarea, .tc-play')) pickCard(e); } },
      h('div', { class: 'tc-top' },
        h('span', { class: 'tc-time num', title: `${fmt(e.start)} ~ ${fmt(e.end)}` }, fmt(e.start)),
        sel,
        h('label', { class: 'tc-rev' }, chk, ' 검수')),
      c.flags, c.text,
      h('div', { class: 'tc-bot' }, incl,
        h('span', { class: 'tc-play' },
          h('button', { type: 'button', title: '원본 녹음을 이 줄 앞뒤 0.3초와 함께 듣습니다', onclick: () => play(win, 'orig') }, '▶원본'),
          h('button', {
            type: 'button', disabled: !sep, title: sep ? '분리·보정한 음성(청취 보조용)' : original ? ORIGINAL_NO_SEPARATED : '이 줄의 분리 음성이 없습니다.',
            onclick: () => play(win, sep),
          }, '▶분리 음성'))));
    paintCard(c);
    c.el.classList.toggle('playing', playing.has(e.id));
    cards.set(e.id, c);
    return c;
  }

  function render() {
    head();
    cards.clear();
    const es = entries();
    const shown = es.filter((e) => (!onlyUnreviewed || !e.reviewed) && (!onlyUnknown || e.speaker === UNKNOWN));
    list.replaceChildren(...shown.map((e) => card(e).el));
    addBtn.disabled = !session.transcript || session.locked;
    addBtn.title = session.locked ? LOCKED_REASON : ADD_TIP;
    empty.hidden = es.length > 0 && shown.length > 0;
    empty.textContent = !session.transcript ? '처리가 끝나면 녹취록이 여기에 나옵니다.'
      : !es.length && session.transcript.source === 'original'
        ? '분명하게 알아들을 수 있는 말소리를 찾지 못했습니다. 위 경고를 확인하고, 증폭 전 원본으로 다시 시도하거나 원본을 들으며 줄을 직접 추가하세요.'
        : !es.length ? '받아쓴 말이 없습니다. 목소리 샘플을 다시 지정해 처리해 보세요.'
        : '조건에 맞는 줄이 없습니다.';
    unkBtn.setAttribute('aria-pressed', String(onlyUnknown));
    onlyBox.checked = onlyUnreviewed;
    updateCount();
    markPicks(getSelection());
  }

  onlyBox.addEventListener('change', () => { onlyUnreviewed = onlyBox.checked; render(); });
  unkBtn.addEventListener('click', () => { onlyUnknown = !onlyUnknown; render(); });

  addBtn.addEventListener('click', () => {
    if (!session.transcript) return;
    if (session.locked) { toast(LOCKED_REASON, true); return; }
    const span = newLineSpan({ selection: getSelection(), playhead: getPlayhead(), duration: getDuration() });
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
    const e = {
      id: `m${hex}`, speaker: nearestSpeaker(entries(), span.start) || (speakers()[0] && speakers()[0].id) || UNKNOWN,
      start: span.start, end: span.end, text: '', words: [], low: [], reviewed: false,
      excluded: false, exclude_reason: null, source: 'manual',
    };
    try { session.addEntry(e); } catch (err) { toast(err.message, true); return; }
    onlyUnreviewed = false; // 새 줄이 거르기에 가려지지 않게
    if (e.speaker !== UNKNOWN) onlyUnknown = false;
    render();
    pickedKey = e.id;
    markPicks(null);
    select([e.start, e.end]);
    const c = cards.get(e.id);
    c.el.scrollIntoView({ block: 'center' });
    startEdit(c);
    onChange();
  });

  render();

  return {
    refresh: render,
    // 라벨 조각을 눌렀을 때: 그 줄의 카드로 가고(가려져 있으면 거르기를 풀고), edit이면 글 고치기까지.
    focusEntry(key, { edit = false } = {}) {
      let c = cards.get(key);
      if (!c) {
        if (!entries().some((e) => e.id === key)) return;
        onlyUnreviewed = false;
        onlyUnknown = false;
        render();
        c = cards.get(key);
      }
      pickedKey = key;
      markPicks(null);
      c.el.scrollIntoView({ block: 'center' });
      if (edit) startEdit(c);
    },
    // 타임라인에서 구간을 고르거나 풀면 같은 구간의 카드를 표시한다
    setSelection(sel) {
      if (!sel) pickedKey = null;
      markPicks(sel);
    },
    // 재생 중인 줄들(열쇠 모음)을 강조한다
    setPlaying(keys) {
      playing = keys;
      for (const [key, c] of cards) c.el.classList.toggle('playing', keys.has(key));
    },
    // 저장 상태: 'pending'|'saving'|'saved'|'error'
    setSaveState(state, err) {
      saved.className = `trp-saved${state === 'error' ? ' error' : ''}`;
      if (state === 'error') saved.textContent = `저장 실패: ${err && err.message}`;
      else if (state === 'saved') saved.textContent = `저장됨 ${clock()}`;
      else saved.textContent = state === 'pending' ? '저장 대기…' : '저장 중…';
    },
    destroy() { cards.clear(); root.replaceChildren(); },
  };
}
