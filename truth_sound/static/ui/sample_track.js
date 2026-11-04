// 타임라인의 "목소리 샘플" 줄: 사람 색 조각, 가장자리 끌기로 늘이고 줄이기, 눌러서 고르기, Delete, 선택 위 [샘플로 지정 ▾].
// 샘플 계산은 editor/samples.js, 저장은 session.setSpeakers를 쓴다. 타임라인은 줄 몸통(.wave)과 보기·선택만 넘겨 준다.
// 사람이 고른 구간만 샘플이 된다: 이 줄은 구간을 스스로 만들거나 고쳐 두지 않는다.
import { h, toast, popover, dialog, fmt } from './dom.js';
import { timeToX, xToTime } from '../editor/view.js';
import { speakerColor } from '../speakers.js';
import { addRange, resizeRange, removeRange, restoreRange, isTiny, snapMs, CLIP_WARN_PERCENT } from '../editor/samples.js';

export const LOCKED_REASON = '이 녹음을 처리하는 중이라 샘플을 바꿀 수 없습니다. 처리가 끝나면 고칠 수 있습니다.';
export const CLIP_WARNING = '잘린 소리가 섞인 구간입니다. 판정이 흔들릴 수 있습니다';
const MIN_PIECE_PX = 3; // 아무리 짧은 구간도 이만큼은 보이게 칠한다
const EDGE_PX = 7; // 가장자리 끌기 칸의 최대 폭
const MIN_SPAN = 0.001; // 끌어서 줄일 수 있는 가장 짧은 길이(서버가 저장하는 정밀도)
const same = (a, b) => a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1]);

// 고친 목록을 세션에 넣는다. 처리 중이면 이유를 알리고 넣지 않는다.
function commit(session, speakers, onChange) {
  if (session.locked) { toast(LOCKED_REASON, true); return false; }
  try { session.setSpeakers(speakers); } catch (e) { toast(e.message, true); return false; }
  onChange();
  return true;
}

// 구간 하나 지우기. 몇 초 동안 [되돌리기]가 뜬다: 그 사이 다른 고침이 있었으면 지운 구간만 다시 넣는다(충돌하면 알린다).
export function removeSample(session, sid, index, onChange) {
  const r = removeRange(session.case.speakers, sid, index);
  if (!r.removed) return false;
  if (!commit(session, r.speakers, onChange)) return false;
  const after = session.case.speakers;
  toast('샘플 구간을 지웠습니다.', false, {
    label: '되돌리기',
    run: () => {
      let back = r.undo();
      if (session.case.speakers !== after) {
        const again = restoreRange(session.case.speakers, sid, r.removed); // 지운 구간 그대로(짧은 구간은 합치지 않는다)
        if (again.error) { toast(again.error, true); return; }
        back = again.speakers;
      }
      commit(session, back, onChange);
    },
  });
  return true;
}

// 잘린 소리가 섞였다는 확인. 취소·Esc·바깥 누르기는 모두 false.
function confirmClipped(range, pct) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const close = dialog('잘린 소리가 섞인 구간', h('div', {},
      h('p', {}, CLIP_WARNING),
      h('p', { class: 'hint' }, `${fmt(range[0])} ~ ${fmt(range[1])} · 잘린 비율 ${pct.toFixed(1)}% (${CLIP_WARN_PERCENT}% 이상이면 알립니다)`),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', onclick: () => { finish(false); close(); } }, '취소'),
        h('button', { type: 'button', class: 'pri', onclick: () => { finish(true); close(); } }, '그래도 지정'))),
    () => finish(false));
  });
}

// 고른 구간 sel을 index번째 사람의 샘플로 지정한다. 겹치면 막고, 잘린 소리가 섞였으면 확인을 받는다.
export async function assignSelection({ session, clip, sel, index, select, onChange }) {
  const spk = session.case.speakers[index];
  if (!spk) { toast(`${index + 1}번째 사람이 없습니다.`, true); return; }
  if (!sel) { toast('먼저 파형에서 구간을 고르세요.'); return; }
  if (session.locked) { toast(LOCKED_REASON, true); return; }
  const range = [snapMs(sel.start), snapMs(sel.end)];
  if (!(range[1] > range[0])) { toast('1ms보다 짧은 구간은 지정할 수 없습니다. 더 넓게 고르세요.', true); return; }
  const first = addRange(session.case.speakers, spk.id, range[0], range[1]);
  if (first.error) { toast(first.error, true); return; }
  const pct = await clip.ensure(range); // 못 받으면 null: 경고만 못 띄울 뿐 지정은 막지 않는다
  if (pct != null && pct >= CLIP_WARN_PERCENT && !(await confirmClipped(range, pct))) return;
  // 기다리는 사이 샘플이 바뀌었을 수 있어 지금 목록에 다시 넣는다
  const before = session.case.speakers;
  const next = addRange(before, spk.id, range[0], range[1]);
  if (next.error) { toast(next.error, true); return; }
  const mine = (next.speakers.find((s) => s.id === spk.id).enroll).find((r) => r[0] <= range[0] && r[1] >= range[1]);
  if (same(before.find((s) => s.id === spk.id).enroll, next.speakers.find((s) => s.id === spk.id).enroll)) {
    toast(`이미 ${spk.name}의 샘플에 들어 있는 구간입니다.`);
  } else if (!commit(session, next.speakers, onChange)) return;
  select({ start: mine[0], end: mine[1], track: 'orig' });
  clip.ensure(mine);
}

// 샘플 줄. el은 타임라인 줄 몸통(.wave). 돌려주는 layout()은 타임라인이 그릴 때마다 부른다.
export function createSampleLane(el, { session, clip, getView, getDuration, getSelection, select, onChange = () => {} }) {
  const hint = h('span', { class: 'smp-empty' }, '파형에서 구간을 고르고 숫자 1·2·3 키(또는 위 단추)로 사람을 지정합니다');
  const btn = h('button', { type: 'button', class: 'smp-assign', hidden: true, 'aria-haspopup': 'menu', onclick: () => openMenu() }, '샘플로 지정 ▾');
  btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // 줄의 구간 고르기가 시작되지 않게
  const body = h('div', { class: 'smp-pieces' });
  el.append(hint, body, btn);

  let drag = null; // 가장자리 끌기 중이면 그 조각: 끌기가 끝날 때까지 다시 그리지 않는다
  let lastSpeakers = null;
  let lastSig = '';
  let clipVer = 0;
  let menuClose = null;
  const unsub = clip.subscribe(() => { clipVer++; layout(); });

  const locked = () => session.locked;
  const xOf = (t) => timeToX(getView(), t);
  const timeAt = (clientX) => {
    const v = getView();
    const x = Math.min(v.width, Math.max(0, clientX - el.getBoundingClientRect().left));
    return snapMs(Math.min(getDuration(), Math.max(0, xToTime(v, x))));
  };
  const rangeSel = (r) => ({ start: r[0], end: r[1], track: 'orig' });

  function place(node, a, b) {
    const x0 = xOf(a);
    node.style.left = `${x0}px`;
    node.style.width = `${Math.max(MIN_PIECE_PX, xOf(b) - x0)}px`;
  }

  function makePiece(speakers, s, i, r, picked) {
    const color = speakerColor(speakers, s.id);
    const tiny = isTiny(r);
    const clipped = clip.isClipped(r);
    const note = [tiny ? '너무 짧은 구간' : '', clipped ? '잘린 소리' : ''].filter(Boolean).join(' · ');
    const pc = h('div', {
      class: `smp-piece${picked ? ' pick' : ''}${tiny ? ' tiny' : ''}${clipped ? ' clip' : ''}`,
      style: `--c:${color}`,
      role: 'button',
      'aria-label': `${s.name} 샘플 ${fmt(r[0])} ~ ${fmt(r[1])}${note ? `, ${note}` : ''}`,
      title: `${s.name} · ${fmt(r[0])} ~ ${fmt(r[1])}${clipped ? `\n${CLIP_WARNING}` : ''}${tiny ? '\n0.05초보다 짧은 구간입니다. 그대로 쓰이지만 판정 근거로는 약합니다.' : ''}`,
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        select(rangeSel(r));
      },
    }, h('span', { class: 'nm' }, `${clipped ? '⚠ ' : ''}${s.name}`));
    place(pc, r[0], r[1]);
    if (tiny) {
      const tag = h('span', { class: 'smp-tag' }, note);
      pc.append(tag);
      pc.dataset.flip = xOf(r[1]) > getView().width - 150 ? '1' : '';
    }
    if (!locked()) {
      for (const edge of ['start', 'end']) {
        const hd = h('span', { class: `smp-h ${edge === 'start' ? 'l' : 'r'}`, title: edge === 'start' ? '끌어서 시작 옮기기' : '끌어서 끝 옮기기' });
        hd.addEventListener('pointerdown', (e) => beginResize(e, hd, pc, s, i, r, edge));
        hd.addEventListener('pointermove', (e) => moveResize(e));
        hd.addEventListener('pointerup', (e) => endResize(e));
        hd.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pid) { drag = null; layout(true); } });
        pc.append(hd);
      }
    }
    return pc;
  }

  function beginResize(e, hd, pc, s, i, r, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag = { pid: e.pointerId, pc, sid: s.id, name: s.name, index: i, edge, a: r[0], b: r[1], from: r, moved: false, x0: e.clientX };
    hd.setPointerCapture(e.pointerId);
    select(rangeSel(r)); // 끌기 전에 이 조각을 고른 상태로 둔다
  }

  function moveResize(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 2) return;
    drag.moved = true;
    const t = timeAt(e.clientX);
    if (drag.edge === 'start') drag.a = Math.min(t, drag.from[1] - MIN_SPAN);
    else drag.b = Math.max(t, drag.from[0] + MIN_SPAN);
    place(drag.pc, drag.a, drag.b);
    drag.pc.title = `${drag.name} · ${fmt(drag.a)} ~ ${fmt(drag.b)}`;
  }

  function endResize(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.moved && (d.a !== d.from[0] || d.b !== d.from[1])) {
      const res = resizeRange(session.case.speakers, d.sid, d.index, d.a, d.b);
      if (res.error) toast(res.error, true);
      else if (commit(session, res.speakers, onChange)) {
        const mine = res.speakers.find((s) => s.id === d.sid).enroll.find((r) => r[0] <= d.a && r[1] >= d.b);
        select(rangeSel(mine));
        clip.ensure(mine);
      }
    }
    layout(true);
  }

  function openMenu() {
    if (menuClose) menuClose();
    const speakers = session.case.speakers;
    const sel = getSelection();
    menuClose = popover(btn, h('div', { class: 'smp-menu' }, speakers.slice(0, 3).map((s, i) => h('button', {
      type: 'button', role: 'menuitem', style: `--c:${speakerColor(speakers, s.id)}`,
      onclick: () => { menuClose(); menuClose = null; assignSelection({ session, clip, sel, index: i, select, onChange }); },
    }, h('kbd', {}, String(i + 1)), h('i', {}), s.name))));
  }

  // 타임라인이 그릴 때마다 부른다. 보기·선택·사람 목록·잘린 비율이 그대로면 아무것도 하지 않는다.
  function layout(force = false) {
    if (drag) return;
    const v = getView();
    const sel = getSelection();
    const speakers = session.case.speakers || [];
    const sig = [v.start, v.secPerPx, v.width, sel && sel.start, sel && sel.end, locked(), clipVer].join('|');
    if (!force && speakers === lastSpeakers && sig === lastSig) return;
    lastSpeakers = speakers;
    lastSig = sig;

    const pieces = [];
    let any = false;
    let selPiece = false;
    speakers.forEach((s) => (s.enroll || []).forEach((r, i) => {
      any = true;
      if (clip.percent(r) === undefined) clip.ensure(r); // 열기만 해도 GET으로 잘린 비율을 확인한다
      const x0 = xOf(r[0]);
      const x1 = xOf(r[1]);
      if (x1 < -40 || x0 > v.width + 40) return;
      const picked = Boolean(sel) && sel.start === r[0] && sel.end === r[1];
      if (picked) selPiece = true;
      pieces.push(makePiece(speakers, s, i, r, picked));
    }));
    body.replaceChildren(...pieces);
    hint.hidden = any;

    // 선택 위 단추: 이미 샘플인 구간을 고른 때는 필요 없다
    btn.hidden = !sel || selPiece;
    if (sel) {
      btn.disabled = locked();
      btn.title = locked() ? LOCKED_REASON : '고른 구간을 누구의 목소리 샘플로 쓸지 정합니다 (숫자 1·2·3 키)';
      const w = btn.offsetWidth || 96;
      btn.style.left = `${Math.min(Math.max(0, xOf(sel.start)), Math.max(0, v.width - w - 2))}px`;
    }
  }

  // 키: 1·2·3은 고른 구간을 그 사람에게, Delete는 고른 샘플 조각 지우기. 처리했으면 true.
  function key(action) {
    if (action === 'assign1' || action === 'assign2' || action === 'assign3') {
      assignSelection({ session, clip, sel: getSelection(), index: Number(action.slice(-1)) - 1, select, onChange });
      return true;
    }
    if (action === 'delete') {
      const sel = getSelection();
      if (!sel) return false;
      for (const s of session.case.speakers) {
        const i = (s.enroll || []).findIndex((r) => r[0] === sel.start && r[1] === sel.end);
        if (i >= 0) {
          removeSample(session, s.id, i, onChange);
          return true;
        }
      }
    }
    return false;
  }

  return {
    layout,
    key,
    destroy() {
      unsub();
      if (menuClose) menuClose();
      drag = null;
      el.replaceChildren();
    },
  };
}
