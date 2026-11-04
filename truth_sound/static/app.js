// 편집 화면 껍데기. 주소(#...)에 따라 빈 화면 또는 편집 화면을 띄운다.
// 트랙·재생·패널 내용은 이어지는 작업(12~19)에서 채운다.
import { parseRoute, caseHash } from './editor/routes.js';
import { createApi, createSession } from './editor/session.js';
import { checkDrag, createDragCounter } from './editor/drop.js';
import { freshMarks, releaseOnOpen } from './editor/fresh.js';
import { h, fmt, fmtDate, toast } from './ui/dom.js';
import { initAttach, startAttach, syncAttach } from './ui/attach.js';
import { createSeal, openExportDialog, openHistoryDialog } from './ui/dialogs.js';
import { createTimeline } from './ui/timeline.js';
import { createPlayer, bindTransport } from './ui/player.js';
import { createSamplesPanel } from './ui/samples_panel.js';
import { createTranscriptPanel } from './ui/transcript_panel.js';
import { createAnalysisPanel } from './ui/analysis_panel.js';
import { activeAt } from './editor/lanes.js';
import { createProcessPanel } from './ui/process_panel.js';
import { createClipCheck, locksEditing } from './editor/samples.js';
import { visibleRange } from './editor/view.js';

const $ = (id) => document.getElementById(id);
const api = createApi((...args) => fetch(...args));

const STATUS = { new: '새 녹음', processing: '처리 중', done: '처리 끝', error: '오류' };
const TABS = ['analysis', 'transcript', 'samples'];
const PANEL_KEY = 'truthsound.panelWidth';
const PANEL_MIN = 280;
const PANEL_MAX = 600;
const PANEL_DEFAULT = 330;

let session = null; // 지금 열린 사건의 묶음. 빈 화면이면 null
let timeline = null; // 지금 열린 사건의 타임라인
let player = null; // 지금 열린 사건의 플레이어
let samplesPanel = null; // [샘플] 탭 내용
let transcriptPanel = null; // [녹취록] 탭 내용
let analysisPanel = null; // [구간 분석] 탭 내용
let focusTrack = null; // 타임라인의 초점 트랙 줄(분석할 소리)
let clipCheck = null; // 샘플 구간의 잘린 비율(확인 말풍선도 쓴다)
let processPanel = null; // [화자 분리] 단추·확인 말풍선·처리 띠
let seal = null; // 윗줄 봉인(원본 SHA-256 확인)
let dialogClose = null; // 열려 있는 [내보내기]·[처리 기록] 대화창을 닫는 함수
let unbindTransport = null; // 도구 줄·Space·L 키 연결을 거두는 함수
let openId = null;
let mountSeq = 0; // 불러오는 동안 주소가 또 바뀌면 앞 작업을 버리기 위한 번호

// ---------- 오른쪽 패널: 폭 · 탭 ----------
function setPanelWidth(px, remember = true) {
  const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, px)));
  document.documentElement.style.setProperty('--panel-w', `${w}px`);
  $('splitter').setAttribute('aria-valuenow', String(w));
  if (remember) {
    try { localStorage.setItem(PANEL_KEY, String(w)); } catch { /* 저장소를 못 쓰면 이번만 */ }
  }
  return w;
}

function initPanel() {
  let saved = PANEL_DEFAULT;
  try {
    const n = Number(localStorage.getItem(PANEL_KEY));
    if (Number.isFinite(n) && n > 0) saved = n;
  } catch { /* 기본 폭 */ }
  setPanelWidth(saved, false);

  const sp = $('splitter');
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('drag');
    const move = (ev) => setPanelWidth(window.innerWidth - ev.clientX, false);
    const up = (ev) => {
      sp.classList.remove('drag');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
      setPanelWidth(window.innerWidth - ev.clientX);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('keydown', (e) => {
    const now = Number(sp.getAttribute('aria-valuenow')) || PANEL_DEFAULT;
    if (e.key === 'ArrowLeft') setPanelWidth(now + 20);
    else if (e.key === 'ArrowRight') setPanelWidth(now - 20);
    else return;
    e.preventDefault();
  });

  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
}

function setTab(tab) {
  const t = TABS.includes(tab) ? tab : TABS[0];
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const p of document.querySelectorAll('.panes [data-pane]')) p.hidden = p.dataset.pane !== t;
}

// ---------- 빈 화면 ----------
async function mountEmpty() {
  const seq = ++mountSeq;
  session = null;
  openId = null;
  closeEditor(); // 열려 있던 사건의 소리도 함께 멈춘다
  document.body.className = 'empty';
  for (const id of ['caseInfo', 'historyBtn', 'exportBtn', 'procstrip']) $(id).hidden = true;
  $('historyBtn').disabled = $('exportBtn').disabled = true;
  $('openBtn').hidden = false;
  $('tracks').replaceChildren();
  $('toolbar').classList.add('dim');
  $('ruler').classList.add('dim');
  $('fileInfo').textContent = '';
  try {
    const list = await api.get('/api/cases');
    if (seq !== mountSeq) return;
    $('recentList').replaceChildren(...list.map((c) => h('li', {},
      h('button', { type: 'button', onclick: () => { location.hash = caseHash(c.id); } },
        h('span', { class: 'nm' }, c.name),
        h('span', { class: 'when' }, fmtDate(c.created_at)),
        // 예전 사건은 길이가 없을 수 있다
        h('span', { class: 'len' }, c.duration == null ? '—' : fmt(c.duration)),
        h('em', { class: `st-${c.status}` }, STATUS[c.status] || c.status)))));
    $('recentEmpty').hidden = list.length > 0;
  } catch (e) {
    if (seq === mountSeq) toast(e.message, true);
  }
}

// ---------- 편집 화면 ----------
function fillCaseInfo(c) {
  const o = c.original || {};
  const p = o.probe || {};
  $('caseName').textContent = o.name || c.id;
  $('caseHash').textContent = o.sha256 ? `SHA-256 ${o.sha256.slice(0, 12)}…` : '';
  $('caseSeal').title = o.sha256 ? `원본 SHA-256 ${o.sha256}` : '';
  const ch = p.channels === 1 ? '모노' : p.channels === 2 ? '스테레오' : p.channels ? `${p.channels}채널` : '';
  const hz = p.sample_rate ? `${(p.sample_rate / 1000).toFixed(1)} kHz` : '';
  // 숫자·시각·코덱 이름만 고정폭, 한글은 화면 글꼴(고정폭 글꼴에는 한글이 없다)
  const parts = [[p.duration == null ? '' : fmt(p.duration), true], [p.codec, true], [ch, false], [hz, true]].filter(([text]) => text);
  const info = $('fileInfo');
  info.textContent = '';
  parts.forEach(([text, mono], i) => {
    if (i) info.append(' · ');
    const span = document.createElement('span');
    if (mono) span.className = 'num';
    span.textContent = text;
    info.append(span);
  });
}

// 다른 사건으로 바꿀 때는 앞 사건의 소리부터 멈추고 타임라인의 키·크기 듣개를 거둔다.
function closeEditor() {
  if (dialogClose) dialogClose();
  if (seal) seal.destroy();
  seal = null;
  if (unbindTransport) unbindTransport();
  if (player) player.destroy();
  if (timeline) timeline.destroy();
  if (samplesPanel) samplesPanel.destroy();
  if (transcriptPanel) transcriptPanel.destroy();
  if (analysisPanel) analysisPanel.destroy();
  if (processPanel) processPanel.destroy();
  processPanel = null;
  unbindTransport = null;
  player = null;
  timeline = null;
  samplesPanel = null;
  transcriptPanel = null;
  analysisPanel = null;
  $('tbUndo').onclick = $('tbRedo').onclick = $('tbCut').onclick = null;
  $('tbUndo').disabled = $('tbRedo').disabled = $('tbCut').disabled = true;
  focusTrack = null;
  $('analysisBody').replaceChildren(h('p', { class: 'hint' }, '파형에서 구간을 고르면 여기에 분석이 나옵니다.'));
  $('samplesBody').replaceChildren(h('p', { class: 'hint' }, '목소리 샘플을 여기에서 고릅니다.'));
  $('transcriptBody').replaceChildren(h('p', { class: 'hint' }, '처리가 끝나면 녹취록이 여기에 나옵니다.'));
}

// [샘플] 탭에서 구간을 누르면 타임라인에서 그 구간을 고르고, 화면 밖이면 그쪽으로 옮긴다(확대 정도는 그대로).
function showRange(range) {
  if (!timeline) return;
  const sel = { start: range[0], end: range[1], track: 'orig' };
  timeline.setSelection(sel);
  if (analysisPanel) analysisPanel.setSelection(sel); // 타임라인은 이 길로 고른 구간을 알리지 않는다
  const v = timeline.getView();
  const [va, vb] = visibleRange(v);
  if (range[0] < va || range[1] > vb) timeline.setView({ ...v, start: (range[0] + range[1]) / 2 - (v.width * v.secPerPx) / 2 });
}

function fillTracks(s, initial = {}) {
  closeEditor();
  focusTrack = null;
  $('clock').textContent = fmt(0);
  const mine = createPlayer({
    caseId: s.case.id,
    getAudible: () => (timeline ? timeline.getMix().audible : new Set(['orig'])),
    getDuration: () => (timeline ? timeline.getDuration() : 0),
  });
  // 재생 위치가 걸친 줄을 라벨 조각과 카드에 강조한다(바뀔 때만)
  let playingNow = '';
  const markPlaying = (t) => {
    const keys = activeAt(s.transcript ? s.transcript.entries : [], t);
    const sig = [...keys].join('|');
    if (sig === playingNow) return;
    playingNow = sig;
    if (timeline) timeline.setPlaying(keys);
    if (transcriptPanel) transcriptPanel.setPlaying(keys);
  };
  const seekTo = (t) => { timeline.setPlayhead(t); $('clock').textContent = fmt(t); mine.seek(t); markPlaying(t); };
  player = mine;
  let editing = false;
  const applyEdit = async (kind, range = null) => {
    if (editing) { toast('편집을 저장하는 중입니다.'); return; }
    editing = true;
    $('tbUndo').disabled = $('tbRedo').disabled = $('tbCut').disabled = true;
    mine.pause();
    try {
      await s.edit(kind, range);
      toast(kind === 'cut' ? '선택 구간을 잘랐습니다. Ctrl+Z로 되돌릴 수 있습니다.'
        : kind === 'undo' ? '마지막 컷을 되돌렸습니다.' : '컷을 다시 적용했습니다.');
      await mountEditor(s.case.id);
    } catch (e) {
      toast(e.message, true);
      editing = false;
      const state = s.case.edit || {};
      $('tbUndo').disabled = !state.can_undo || s.locked;
      $('tbRedo').disabled = !state.can_redo || s.locked;
      $('tbCut').disabled = !timeline || !timeline.getSelection() || s.locked;
    }
  };
  const clip = clipCheck = createClipCheck(api, `/api/cases/${encodeURIComponent(s.case.id)}`); // 샘플 구간의 잘린 비율(줄과 탭이 함께 쓴다)
  timeline = createTimeline($('app'), {
    session: s,
    api,
    clip,
    initial,
    onSamples: () => { if (samplesPanel) samplesPanel.refresh(); if (processPanel) processPanel.refresh(); if (analysisPanel) analysisPanel.invalidateScore(); }, // 줄에서 샘플을 고치면 카드도 따라간다
    onSeek: (t) => { $('clock').textContent = fmt(t); mine.seek(t); markPlaying(t); }, // 눌러서 옮기기·Home·End
    onMix: ({ states }) => mine.setMix(states),
    onSelect: (sel) => { $('tbCut').disabled = !sel || s.locked; if (transcriptPanel) transcriptPanel.setSelection(sel); if (analysisPanel) analysisPanel.setSelection(sel); }, // 고른 구간과 같은 줄의 카드 표시, 구간 분석
    onFocusTrack: (row) => { focusTrack = row; if (analysisPanel) analysisPanel.setFocus(row); }, // 분석할 소리
    // 라벨 조각을 누르면 [녹취록] 탭의 그 카드로(두 번 누르면 글 고치기까지)
    onEntry: (key, { edit = false } = {}) => {
      const e = s.transcript && s.transcript.entries.find((x) => x.id === key);
      if (!e || !transcriptPanel) return;
      setTab('transcript');
      showRange([e.start, e.end]);
      transcriptPanel.focusEntry(key, { edit });
    },
    onEdit: applyEdit,
  });
  const edit = s.case.edit || {};
  $('tbUndo').disabled = !edit.can_undo || s.locked;
  $('tbRedo').disabled = !edit.can_redo || s.locked;
  $('tbCut').disabled = !timeline.getSelection() || s.locked;
  $('tbUndo').onclick = () => applyEdit('undo');
  $('tbRedo').onclick = () => applyEdit('redo');
  $('tbCut').onclick = () => { const sel = timeline && timeline.getSelection(); if (sel) applyEdit('cut', sel); };
  // 재생 중에는 타임라인의 재생 위치와 큰 시각 표시가 소리를 따라간다
  mine.onTime((t) => { if (timeline) timeline.setPlayhead(t); $('clock').textContent = fmt(t); markPlaying(t); });
  unbindTransport = bindTransport({ player: mine, getSelection: () => timeline.getSelection(), getDuration: () => timeline.getDuration(), seekTo });
  samplesPanel = createSamplesPanel($('samplesBody'), {
    session: s,
    clip,
    getSelection: () => (timeline ? timeline.getSelection() : null),
    select: showRange,
    play: (r) => mine.play({ start: r[0], end: r[1] }),
    onChange: () => { if (timeline) { timeline.renameRows(); timeline.redraw(); timeline.refreshTranscript(); } if (processPanel) processPanel.refresh(); if (transcriptPanel) transcriptPanel.refresh(); if (analysisPanel) { analysisPanel.invalidateScore(); analysisPanel.refresh(); } }, // 카드에서 고치면 줄도 다시 그리고, 이름을 바꿨으면 트랙 이름표도 맞춘다
  });
  transcriptPanel = createTranscriptPanel($('transcriptBody'), {
    session: s,
    select: showRange,
    play: (win, track) => mine.play({ start: win.start, end: win.end }, { tracks: [track] }), // 그 사람 소리(또는 원본)만 0.3초 앞부터
    getSelection: () => (timeline ? timeline.getSelection() : null),
    getPlayhead: () => (timeline ? timeline.getPlayhead() : 0),
    getDuration: () => (timeline ? timeline.getDuration() : 0),
    onChange: () => { if (timeline) timeline.refreshTranscript(); if (analysisPanel) analysisPanel.refresh(); }, // 카드에서 줄을 고치거나 넣으면 조각도 다시 그린다
  });
  analysisPanel = createAnalysisPanel($('analysisBody'), {
    api,
    session: s,
    focus: focusTrack,
    // 줄을 누르면 [녹취록] 탭의 그 카드로(고른 구간은 그대로 둔다)
    onEntry: (key) => { if (!transcriptPanel) return; setTab('transcript'); transcriptPanel.focusEntry(key); },
  });
  // 주소의 ?sel=: 그 구간을 처음부터 골라 둔다(녹음 길이 안으로만)
  const dur = timeline.getDuration();
  if (initial.sel && initial.sel.start < dur) {
    const sel = { start: initial.sel.start, end: Math.min(initial.sel.end, dur), track: 'orig' };
    timeline.setSelection(sel);
    transcriptPanel.setSelection(sel);
    analysisPanel.setSelection(sel);
  }
}

// 열었으면 null, 못 열었으면 사용자에게 보인 이유 글을 돌려준다(처리가 끝난 뒤 다시 열 때 호출한 쪽이 잠금을 풀고 알리는 데 쓴다).
async function mountEditor(id, { tab = null, dialog = null, range = null, spec = null, sel = null } = {}) {
  const seq = ++mountSeq;
  try {
    const next = createSession({ api, id, onState: onSaveState });
    await next.load();
    if (seq !== mountSeq) return null;
    // 처리 중 표시가 낡았을 수 있다(프로그램이 죽은 뒤 status만 processing). 실제 작업 기준으로 잠근다.
    let job = null;
    try { job = await api.get('/api/jobs/current'); } catch { /* 작업 상태를 못 읽으면 사건 상태를 따른다 */ }
    if (seq !== mountSeq) return null;
    if (job) next.setLocked(locksEditing(job, id));
    session = next;
    openId = id;
    document.body.className = 'editing';
    $('caseInfo').hidden = false;
    $('historyBtn').hidden = false;
    $('exportBtn').hidden = false;
    $('openBtn').hidden = true;
    $('toolbar').classList.remove('dim');
    $('ruler').classList.remove('dim');
    fillCaseInfo(next.case);
    fillTracks(next, { range, spec, sel });
    $('historyBtn').disabled = $('exportBtn').disabled = false;
    seal = createSeal({ api, session: next, seal: $('caseSeal'), state: $('sealState'), warn: $('sealWarn') });
    // [화자 분리] 단추·처리 띠: 진행 중인 작업이 이 녹음 것이면 따라가고, 끝나면 사건을 다시 읽어 줄을 새로 만든 뒤 [녹취록] 탭을 연다.
    processPanel = createProcessPanel({ session: next, api, job, clip: clipCheck, button: $('processBtn'), transcribeButton: $('transcribeBtn'), why: $('processWhy'), strip: $('procstrip'), onLock: () => { if (timeline) { timeline.redraw(); timeline.refreshTranscript(); } if (samplesPanel) samplesPanel.refresh(); if (transcriptPanel) transcriptPanel.refresh(); if (analysisPanel) analysisPanel.refresh(); }, onFinished: async () => {
      const failed = await mountEditor(id, { tab: 'transcript' });
      if (failed != null && session === next) $('exportBtn').disabled = true; // 낡은 화면에서는 내보내지 못한다(다시 열면 풀린다)
      return failed;
    } });
    setTab(tab);
    if (dialog === 'export') openDialog('export'); // 예전 주소 #/case/<id>/5
    return null;
  } catch (e) {
    if (seq !== mountSeq) return null;
    if (e.status === 404) {
      history.replaceState(null, '', '#/');
      await mountEmpty();
      toast('사건을 찾을 수 없습니다.', true);
    } else {
      // 열지 못했으면 화면과 주소를 어긋나게 두지 않는다: 열려 있던 사건 주소로, 없으면 빈 화면으로 되돌린다.
      if (session) {
        history.replaceState(null, '', caseHash(openId));
      } else {
        history.replaceState(null, '', '#/');
        await mountEmpty();
      }
      toast(e.message, true);
    }
    return e.status === 404 ? '사건을 찾을 수 없습니다.' : e.message;
  }
}

// [내보내기]·[처리 기록] 대화창. 하나만 열어 둔다.
function openDialog(kind) {
  if (!session || !seal) return;
  if (dialogClose) dialogClose();
  const onClose = () => { dialogClose = null; };
  dialogClose = kind === 'export'
    ? openExportDialog({ session, api, seal, onClose })
    : openHistoryDialog({ session, onClose });
}

function onSaveState(state, err, scope) {
  if (scope === 'speakers' && samplesPanel) samplesPanel.setSaveState(state, err);
  if (scope === 'transcript' && transcriptPanel) transcriptPanel.setSaveState(state, err);
  const el = $('saveState');
  if (state === 'error') el.textContent = `저장 실패: ${err && err.message}`;
  else if (state === 'saved') el.textContent = `저장됨 ${new Date().toLocaleTimeString('ko-KR')}`;
  else if (state === 'saving' || state === 'pending') el.textContent = '저장 중…';
}

// ---------- 주소 ----------
async function route() {
  const r = parseRoute(location.hash);
  releaseOnOpen(freshMarks(), r); // 어떤 길로든 열린 사건은 확인 카드가 더는 지울 수 없다
  if (r.view === 'case' && r.legacy) history.replaceState(null, '', caseHash(r.id));

  // 같은 사건이면 다시 불러오지 않는다(불러오면 저장 전 고침이 사라진다).
  if (r.view === 'case' && session && openId === r.id) {
    setTab(r.tab);
    if (r.dialog === 'export') openDialog('export');
    return;
  }
  // 다른 화면으로 가기 전에 고친 내용을 먼저 보낸다. 못 보냈으면 물어본다.
  if (session && !(await session.flush())) {
    if (!confirm('저장하지 못한 변경이 있습니다. 그래도 이동할까요?')) {
      history.replaceState(null, '', caseHash(openId));
      return;
    }
  }
  if (r.view === 'case') await mountEditor(r.id, { tab: r.tab, dialog: r.dialog, range: r.range, spec: r.spec, sel: r.sel });
  else await mountEmpty();
  // 빈 화면 주소에 카드 번호가 있으면 확인 카드를 위에 띄우고, 없으면 빈 화면 쪽 카드를 닫는다.
  syncAttach(r.view === 'empty' ? r.card : null);
}

// ---------- 파일 넣기 ----------
// 편집 중에 넣어도 새 녹음으로 만든다. 열린 사건은 그대로 두고 카드만 위에 뜬다.
function receiveFiles(files) {
  if (files.length > 1) { toast('한 번에 한 파일만 넣을 수 있습니다', true); return; }
  startAttach(files[0]);
}

// 창 전체에 깔리는 끌기 덮개. 끌고 있는 동안은 파일 개수·종류만 보인다(이름·크기는 카드에서).
function createCover() {
  const title = h('h2');
  const sub = h('p');
  const el = h('div', { class: 'dragcover', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'dc-box' },
      h('div', { class: 'dc-icon' }),
      title, sub));
  // 아이콘은 고정된 조각이라 빈 화면의 것과 같은 모양을 쓴다(SVG는 이름공간이 달라 h()로 못 만든다).
  const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ic.setAttribute('viewBox', '0 0 24 24');
  ic.innerHTML = '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>';
  el.querySelector('.dc-icon').append(ic);
  $('overlay').append(el);
  return {
    show(v) {
      el.classList.toggle('bad', !v.ok);
      title.textContent = v.ok ? '놓으면 파일을 확인합니다' : v.message;
      sub.textContent = !v.ok ? '놓아도 올라가지 않습니다.'
        : session ? '열려 있는 녹음은 그대로 두고 새 녹음으로 엽니다.' : `파일 ${v.count || 1}개 · 원본은 바뀌지 않고 그대로 보관됩니다.`;
      el.hidden = false;
    },
    hide() { el.hidden = true; },
  };
}

function initDrop() {
  initAttach({ api, isEditing: () => session !== null, pick: () => $('fileInput').click() });
  $('pickBtn').addEventListener('click', () => $('fileInput').click());
  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    if ($('fileInput').files.length) receiveFiles($('fileInput').files);
    $('fileInput').value = '';
  });

  const counter = createDragCounter();
  let cover = null;
  let verdict = { ok: true, count: 0, message: '' };
  const hasFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes('Files');
  const reset = () => { counter.reset(); if (cover) cover.hide(); };

  // 창 어디에 놓아도 브라우저가 그 파일을 열어 버리지 않게 막는다.
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!hasFiles(e)) return;
    counter.enter();
    verdict = checkDrag(Array.from(e.dataTransfer.items || [], (it) => ({ kind: it.kind, type: it.type })));
    cover = cover || createCover();
    cover.show(verdict);
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (hasFiles(e)) e.dataTransfer.dropEffect = verdict.ok ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (e) => {
    counter.leave(); // 짝 없는 leave는 카운터가 0 아래로 내려가지 않게 막는다
    if (!counter.active && cover) cover.hide();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    reset();
    if (e.dataTransfer && e.dataTransfer.files.length) receiveFiles(e.dataTransfer.files);
  });
}

window.addEventListener('beforeunload', (e) => {
  if (session && session.pending()) {
    session.saveNow();
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('hashchange', route);

// 마우스로 단추를 누른 뒤에는 초점을 거둔다: 그대로 두면 Space가 그 단추를 다시 눌러 재생 키로 듣지 못한다. 키보드로 누른 단추(detail 0)는 초점을 지킨다.
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('#toolbar button, #tracks button') : null;
  if (b && e.detail > 0) b.blur();
});

$('exportBtn').addEventListener('click', () => openDialog('export'));
$('historyBtn').addEventListener('click', () => openDialog('history'));
initPanel();
initDrop();
setTab(null);
route();
