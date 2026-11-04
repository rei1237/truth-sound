// 구간 선택·시각 표기 계산. 순수 함수, 입력은 바꾸지 않는다.
import { xToTime } from './view.js';

export const DRAG_PX = 3; // 이 이하로 끌면 그냥 클릭

// 끌기(x0→x1, 화면 픽셀)를 시각 구간으로. 오른쪽에서 왼쪽으로 끌어도 start < end. 클릭이면 null.
export function selectionFromDrag(v, x0, x1, track) {
  if (Math.abs(x1 - x0) <= DRAG_PX) return null;
  const a = Math.max(0, xToTime(v, Math.min(x0, x1)));
  const b = Math.min(v.duration, xToTime(v, Math.max(x0, x1)));
  if (!(b > a)) return null;
  return { start: a, end: b, track };
}

// edge: 'start' | 'end'. 파일 안에 두고, 반대쪽 끝을 넘지 않는다.
export function moveEdge(sel, edge, t, duration) {
  const c = Math.min(Math.max(0, t), duration);
  if (edge === 'start') return { ...sel, start: Math.min(c, sel.end) };
  return { ...sel, end: Math.max(c, sel.start) };
}

const pad = (n, w) => String(n).padStart(w, '0');

export function formatClock(sec) {
  const total = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

// "5.05", "1:05.2", "00:01:05.200" → 초. 알아볼 수 없으면 null.
export function parseClock(text) {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length > 3) return null;
  const last = parts.length - 1;
  let sec = 0;
  for (let i = 0; i <= last; i++) {
    const re = i === last ? /^\d+(\.\d+)?$/ : /^\d+$/;
    if (!re.test(parts[i])) return null;
    sec = sec * 60 + Number(parts[i]);
  }
  return Math.round(sec * 1000) / 1000;
}

// 말소리 건너뛰기. dir 1이면 t 뒤에서 시작하는 첫 말소리, -1이면 t 앞에서 끝난 마지막 말소리.
// hasSelection이면 t가 선택 가장자리이므로 그 선택(과 겹쳐 닿은 것)은 건너뛴다(엄격하게 뒤·앞).
// 선택이 없으면 t는 재생 위치라서 t에서 막 시작하는(끝나는) 말소리도 고른다: 녹음이 말소리로 시작해도 첫 말소리에 닿는다.
// 없으면 null. 돌려주는 구간은 복사본.
export function speechStep(intervals, t, dir, hasSelection = false) {
  let best = null;
  for (const iv of intervals || []) {
    const ok = dir > 0 ? (hasSelection ? iv[0] > t : iv[0] >= t) : (hasSelection ? iv[1] < t : iv[1] <= t);
    if (ok && (!best || (dir > 0 ? iv[0] < best[0] : iv[1] > best[1]))) best = iv;
  }
  return best ? [best[0], best[1]] : null;
}
