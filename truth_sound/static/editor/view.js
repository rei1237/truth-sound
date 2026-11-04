// 시간축 보기 계산. 보기 상태 {start, secPerPx, width, duration}는 바꾸지 않고 새 객체로 돌려준다.
import { formatClock } from './selection.js';

export const MIN_SEC_PER_PX = 0.0001; // 가장 많이 확대: 픽셀 하나가 0.1ms

const num = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

// 시작을 0~끝, 확대를 MIN_SEC_PER_PX~전체 보기 안으로 맞춘다.
export function clampView(v) {
  const width = Math.max(1, num(v.width, 1));
  const duration = Math.max(0, num(v.duration));
  const fitSpp = Math.max(MIN_SEC_PER_PX, duration / width);
  const secPerPx = Math.min(fitSpp, Math.max(MIN_SEC_PER_PX, num(v.secPerPx, fitSpp)));
  const start = Math.min(Math.max(0, duration - width * secPerPx), Math.max(0, num(v.start)));
  return { start, secPerPx, width, duration };
}

export function fitView(duration, width) {
  return clampView({ start: 0, secPerPx: Infinity, width, duration });
}

export const timeToX = (v, t) => (t - v.start) / v.secPerPx;
export const xToTime = (v, x) => v.start + x * v.secPerPx;

// factor > 1이면 확대. x 아래의 시각이 제자리에 남는다.
export function zoomAt(v, factor, x) {
  const t = xToTime(v, x);
  const secPerPx = Math.max(MIN_SEC_PER_PX, v.secPerPx / factor);
  return clampView({ ...v, secPerPx, start: t - x * secPerPx });
}

export function zoomToRange(v, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return clampView({ ...v, start: lo, secPerPx: (hi - lo) / v.width });
}

// dx는 화면 픽셀. 양수면 오른쪽(뒤쪽 시간)으로 간다.
export function scrollBy(v, dx) {
  return clampView({ ...v, start: v.start + dx * v.secPerPx });
}

export function visibleRange(v) {
  return [v.start, Math.min(v.duration, v.start + v.width * v.secPerPx)];
}

const MINOR_PER_MAJOR = 5;

function steps() {
  const out = [];
  for (let k = -4; k <= 6; k++) for (const m of [1, 2, 5]) out.push(m * 10 ** k);
  return out;
}

// 시:분:초.밀리초 꼴(formatClock). 큰 눈금 간격이 1초 이상이면 밀리초는 뺀다.
function tickLabel(t, step) {
  const full = formatClock(t);
  return step >= 1 ? full.slice(0, 8) : full;
}

// 글자 하나의 가로 픽셀(10px 고정폭)과 글자 사이 여백: 큰 눈금 간격은 글자 폭보다 넓게 잡는다.
const CHAR_PX = 6.6;
const LABEL_GAP_PX = 16;
const labelPx = (step) => (step >= 1 ? 8 : 12) * CHAR_PX + LABEL_GAP_PX;

// 눈금: 큰 눈금(글자 있음)과 그 사이 작은 눈금. 보이는 구간 안의 것만.
export function rulerTicks(v) {
  const [a, b] = visibleRange(v);
  const step = steps().find((s) => s / v.secPerPx >= labelPx(s)) || steps().pop();
  const minor = step / MINOR_PER_MAJOR;
  const ticks = [];
  for (let i = Math.ceil(a / minor - 1e-9); i * minor <= b + minor * 1e-9; i++) {
    const t = Number((i * minor).toPrecision(12));
    const major = i % MINOR_PER_MAJOR === 0;
    ticks.push({ t, major, label: major ? tickLabel(t, step) : '' });
  }
  return ticks;
}

// 말소리 띠의 막대. 구간마다 minPx 이상 폭으로 가운데에 맞춰, 아주 짧은 소리도 멀리서 보이게 한다.
// 화면 밖은 빼고 [0, widthPx]에 맞춰 자른다. 돌려주는 값: [{x, w}] (화면 픽셀).
export function bandRects(intervals, v, widthPx, minPx) {
  const out = [];
  for (const [a, b] of intervals || []) {
    const w = Math.max(minPx, (b - a) / v.secPerPx);
    const x = timeToX(v, (a + b) / 2) - w / 2;
    if (x + w <= 0 || x >= widthPx) continue;
    const x0 = Math.max(0, x);
    out.push({ x: x0, w: Math.min(widthPx, x + w) - x0 });
  }
  return out;
}

const melOf = (f) => 2595 * Math.log10(1 + f / 700);

// Hz → 주파수 그림의 (소수) 행 번호. 행 i의 가운데가 멜 눈금 경계 i+1(경계는 rows+2개)이다. analysis.mel_edges와 같다.
export function melRow(f, fMin, fMax, rows = 128) {
  return ((melOf(f) - melOf(fMin)) / (melOf(fMax) - melOf(fMin))) * (rows + 1) - 1;
}

// 행 번호 → 캔버스 y. 행 0이 맨 아래.
export const rowToY = (row, rows, h) => h - ((row + 0.5) * h) / rows;

// 받아 온 조각의 열쇠. 요청 중 표시(inflight)는 파형·주파수 그림·목소리 높이가 한 모음이라 종류를 앞에 붙여 서로 가리지 않게 한다.
export const tileKey = (kind, track, a, b, n = '') => `${kind}|${track}|${a}|${b}|${n}`;
