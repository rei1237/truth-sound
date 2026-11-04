// 화면 도우미. document는 함수 안에서만 읽는다(시험에서 가짜 document를 쓰기 때문).
import { formatClock } from '../editor/selection.js';

// 요소 만들기. 자식은 중첩 배열을 펴고, null·undefined·false는 건너뛴다(0은 그대로 글자로).
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

// 시각·길이 표시는 어디서나 00:00:05.050.
export const fmt = (sec) => formatClock(sec);

// 날짜·시각 표시(기록 시각 등).
export const fmtDate = (iso, seconds = false) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short' });

const layer = () => document.getElementById('overlay') || document.body;

let toastTimer = null;
// action = { label, run }이면 글 옆에 단추를 붙인다(예: [되돌리기]). 누르면 run을 부르고 알림을 닫는다.
export function toast(msg, error = false, action = null) {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    layer().append(t);
  }
  t.textContent = msg;
  if (action) {
    t.append(' ', h('button', { type: 'button', class: 'toast-act', onclick: () => { t.hidden = true; action.run(); } }, action.label));
  }
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error || action ? 7000 : 3500);
}

// 단추 아래에 뜨는 작은 상자. 바깥을 누르거나 Esc를 누르면 닫힌다.
export function popover(anchor, content) {
  const box = h('div', { class: 'popover', role: 'menu' }, content);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 240))}px`;
  box.style.top = `${r.bottom + 4}px`;
  layer().append(box);
  function close() {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
  }
  function onOutside(e) { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  return close;
}

// 가운데 대화 상자. Esc나 바깥 누르기로 닫는다. 닫는 함수를 돌려준다. onClose는 어떤 길로 닫히든 한 번 불린다.
export function dialog(title, content, onClose = () => {}) {
  const prev = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (prev && prev.focus) prev.focus();
    onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const wrap = h('div', { class: 'dialog-wrap', onpointerdown: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-head' }, h('h2', {}, title),
        h('button', { type: 'button', class: 'icon', 'aria-label': '닫기', onclick: close }, '×')),
      h('div', { class: 'dialog-body' }, content)));
  layer().append(wrap);
  document.addEventListener('keydown', onKey, true);
  const first = wrap.querySelector('button, input, select, textarea');
  if (first) first.focus();
  return close;
}
