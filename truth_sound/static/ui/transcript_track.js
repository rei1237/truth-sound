// 타임라인의 "녹취록" 줄: 줄마다 사람 색 조각 + 글 앞부분, 최대 2층, 더 겹치면 "+N".
// 층 나누기는 editor/lanes.js, 줄 고치기는 [녹취록] 탭(ui/transcript_panel.js)이 한다. 이 줄은 보여 주고 누른 것을 알리기만 한다.
// 확실하지 않은 줄은 조각 모양이 다르다: 짧은 소리 화자 추정은 빗금 + "(추정)", 화자 확인 필요는 회색 빗금.
import { h, fmt } from './dom.js';
import { timeToX } from '../editor/view.js';
import { UNKNOWN, speakerColor, speakerName } from '../speakers.js';
import { layoutLanes } from '../editor/lanes.js';

export const GUESS_NOTE = '아주 짧은 소리라 목소리 특징만으로는 누구인지 확실하지 않아, 음색이 가장 닮은 사람으로 추정했습니다. 원본을 들어 확인하세요.';
export const UNKNOWN_NOTE = '어느 목소리 샘플과도 뚜렷이 닮지 않아 누구의 말인지 정하지 못했습니다. 원본을 들어 화자를 고르세요.';
const ORIGINAL_NOTE = '화자를 나누지 않고 받아 적었습니다. 원본을 들어 화자를 고르세요.';
// 화자를 나누지 않고 만든 녹취록(source "original")은 화자 확인 필요의 까닭이 다르다.
export const unknownNote = (source) => (source === 'original' ? ORIGINAL_NOTE : UNKNOWN_NOTE);
const MIN_PIECE_PX = 4; // 아무리 짧은 줄도 이만큼은 보이고 눌리게 칠한다
const NARROW_PX = 14; // 이보다 좁은 조각에는 글을 넣지 않는다
const LANE_TOP = [17, 44]; // 층마다 조각의 위 간격(px). 맨 위 띠(0~15)는 "+N" 자리
const DOUBLE_MS = 450; // 같은 조각을 이 안에 두 번 누르면 글 고치기

// 줄 하나가 어떤 모양으로 그려지는지. 시험 없이도 읽히게 한 곳에 모은다.
export function pieceKind(entry) {
  if (entry.speaker === UNKNOWN) return 'unk';
  return entry.short_guess ? 'guess' : 'sure';
}

export function createTranscriptLane(el, { session, getView, getSelection, onEntry = () => {}, zoomTo = () => {} }) {
  const body = h('div', { class: 'tr-pieces' });
  const hint = h('span', { class: 'tr-empty' }, '받아쓴 말이 없습니다');
  el.append(hint, body);

  let lastSig = '';
  let playing = new Set();
  let last = null; // 마지막으로 누른 조각 {key, at}
  const nodes = new Map(); // 줄 열쇠 → 조각
  const xOf = (t) => timeToX(getView(), t);
  const entries = () => (session.transcript && session.transcript.entries) || [];

  function press(e, key) {
    if (e.button !== 0) return;
    e.stopPropagation(); // 줄의 구간 고르기가 시작되지 않게
    const now = performance.now();
    const edit = Boolean(last) && last.key === key && now - last.at < DOUBLE_MS;
    last = edit ? null : { key, at: now };
    onEntry(key, { edit });
  }

  function makePiece(e, lane) {
    const speakers = session.case.speakers || [];
    const kind = pieceKind(e);
    const x0 = xOf(e.start);
    const w = Math.max(MIN_PIECE_PX, xOf(e.end) - x0);
    const name = speakerName(speakers, e.speaker);
    const text = (e.text || '').trim();
    const note = kind === 'guess' ? GUESS_NOTE : kind === 'unk' ? unknownNote(session.transcript && session.transcript.source) : '';
    const flags = [kind === 'guess' ? '화자 추정' : '', e.excluded ? '문서에서 뺌' : '', e.reviewed ? '검수함' : ''].filter(Boolean).join(' · ');
    const label = `${name} ${fmt(e.start)} ~ ${fmt(e.end)}${flags ? `, ${flags}` : ''}: ${text || '(빈 줄)'}`;
    const pc = h('div', {
      class: `tr-piece ${kind}${e.excluded ? ' out' : ''}${e.reviewed ? ' done' : ''}${w < NARROW_PX ? ' narrow' : ''}`,
      style: `--c:${speakerColor(speakers, e.speaker)};left:${x0}px;width:${w}px;top:${LANE_TOP[lane]}px`,
      role: 'button',
      'aria-label': label,
      title: `${label}${note ? `\n${note}` : ''}\n눌러서 카드로, 두 번 눌러서 글 고치기`,
      onpointerdown: (ev) => press(ev, e.id),
      onmousedown: (ev) => ev.preventDefault(), // 눌러서 초점이 옮겨 가면 막 연 입력칸이 바로 닫힌다
    },
    e.reviewed ? h('span', { class: 'ck' }, '✓') : null,
    kind === 'guess' ? h('span', { class: 'gs' }, '(추정)') : null,
    kind === 'unk' ? h('span', { class: 'gs' }, '화자 확인 필요') : null,
    h('span', { class: 'tx' }, text || '(빈 줄)'));
    nodes.set(e.id, pc);
    return pc;
  }

  function makeMore(m) {
    const x0 = xOf(m.start);
    const w = Math.max(24, xOf(m.end) - x0);
    return h('button', {
      type: 'button', class: 'tr-more', style: `left:${x0}px;width:${w}px`,
      title: `${fmt(m.start)} ~ ${fmt(m.end)}에 줄이 ${m.count}개 더 겹쳐 있습니다. 누르면 이 구간을 확대합니다`,
      'aria-label': `겹친 줄 ${m.count}개 더, 누르면 확대`,
      onpointerdown: (ev) => { if (ev.button !== 0) return; ev.stopPropagation(); zoomTo(m.start, m.end); },
    }, `+${m.count}`);
  }

  // 조각 위의 표시(고른 줄·재생 중인 줄)만 고친다: 다시 만들지 않는다.
  function paint() {
    const sel = getSelection();
    for (const e of entries()) {
      const n = nodes.get(e.id);
      if (!n) continue;
      n.classList.toggle('pick', Boolean(sel) && sel.start === e.start && sel.end === e.end);
      n.classList.toggle('playing', playing.has(e.id));
    }
  }

  // 타임라인이 그릴 때마다 부른다. 보기·줄 목록이 그대로면 조각을 다시 만들지 않는다.
  function layout(force = false) {
    const v = getView();
    const list = entries();
    const sig = [v.start, v.secPerPx, v.width, list.length].join('|');
    if (!force && sig === lastSig) { paint(); return; }
    lastSig = sig;
    nodes.clear();
    const byId = new Map(list.map((e) => [e.id, e]));
    const res = layoutLanes(list.map((e) => ({ key: e.id, start: e.start, end: e.end })));
    const seen = (a, b) => xOf(b) >= -40 && xOf(a) <= v.width + 40;
    // 긴 줄을 먼저 그리고 짧은 줄을 위에 얹는다: 아주 짧은 줄이 긴 줄에 묻히지 않고 눌린다
    const shown = res.placed.map((p) => ({ e: byId.get(p.key), lane: p.lane })).filter((o) => seen(o.e.start, o.e.end))
      .sort((a, b) => (b.e.end - b.e.start) - (a.e.end - a.e.start));
    body.replaceChildren(...shown.map((o) => makePiece(o.e, o.lane)), ...res.more.filter((m) => seen(m.start, m.end)).map(makeMore));
    hint.hidden = list.length > 0;
    paint();
  }

  return {
    layout,
    refresh: () => layout(true),
    setPlaying(keys) { playing = keys; paint(); },
    destroy() { nodes.clear(); el.replaceChildren(); },
  };
}
