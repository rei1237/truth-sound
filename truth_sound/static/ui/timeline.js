// 한 시간축 멀티트랙 타임라인: 눈금자 · 줄마다 조절판과 파형 · 선택/재생 위치 · 가로 스크롤 · 상태 줄.
// 보기 계산은 editor/view.js, 선택·시각 표기는 editor/selection.js, 줄 목록·소리 규칙은 editor/tracks.js를 쓴다.
import { h, toast } from './dom.js';
import { createApi } from '../editor/session.js';
import { clampView, fitView, timeToX, xToTime, zoomAt, zoomToRange, scrollBy, visibleRange, rulerTicks, bandRects, melRow, rowToY, tileKey } from '../editor/view.js';
import { DRAG_PX, selectionFromDrag, moveEdge, formatClock, parseClock, speechStep } from '../editor/selection.js';
import { actionFor } from '../editor/keymap.js';
import { CLIP_COLOR, UNKNOWN_COLOR } from '../speakers.js';
import { trackRows, initialStates, audibleIds, toggleState } from '../editor/tracks.js';
import { createClipCheck } from '../editor/samples.js';
import { createSampleLane } from './sample_track.js';
import { createTranscriptLane } from './transcript_track.js';

const CTL_W = 150; // 줄 왼쪽 조절판 폭(style.css .row와 같다)
const MAX_PEAK_BINS = 20000; // analysis.MAX_PEAK_BINS
const FETCH_DELAY = 120; // 움직이는 동안은 마지막 요청만 보낸다
const CACHE_MAX = 48;
const SPEC_MAX_COLS = 4000; // analysis.SPEC_MAX_COLS
const SPEC_CACHE_MAX = 16; // 조각마다 칸 x 128 바이트 + 그린 그림이 따라붙으므로 파형보다 적게
const PITCH_MAX_SPAN = 60; // analysis.PITCH_MAX_SPAN: 목소리 높이는 이 길이 이하 구간만
const BAND_MIN_PX = 2; // 말소리 띠에서 아무리 짧은 소리도 이만큼은 칠한다
const ZOOM_STEP = 2;
const FOLLOW_MARGIN = 0.1; // 재생 위치가 화면 밖이면 왼쪽에서 이만큼(보기 폭 비율) 떨어지게 옮긴다

const r6 = (x) => Math.round(x * 1e6) / 1e6; // 조각 열쇠가 부동소수 오차로 갈라지지 않게
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isField = (el) => Boolean(el) && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName || '');
// 확인 카드·대화 상자·말풍선·끌기 덮개가 떠 있으면 타임라인 키는 쉰다
export const modalOpen = () => document.querySelector('.attach-wrap, .dialog-wrap, .popover, .dragcover:not([hidden])') !== null;

// ---- 줄 몸통 그리기: 모드마다 한 함수 ----
// 주파수 그림: 서버가 준 uint8(행 0이 가장 낮은 소리)을 줄 색의 밝기 단계로 칠해 한 번만 그려 두고, 보기에 맞춰 늘려 붙인다.
// 열 지도: 시안(docs/superpowers/specs/2026-11-01-editor-mockup.html)의 STOPS. 줄 색과 무관하게 소리 세기만 보인다(누가 말했는지는 파형 줄 색이 말한다).
const HEAT_STOPS = [[0, [9, 8, 20]], [0.3, [80, 22, 110]], [0.58, [214, 74, 46]], [0.82, [250, 178, 40]], [1, [252, 248, 196]]];
const HEAT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    let i = 1;
    while (i < HEAT_STOPS.length - 1 && t > HEAT_STOPS[i][0]) i++;
    const [t0, c0] = HEAT_STOPS[i - 1];
    const [t1, c1] = HEAT_STOPS[i];
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = c0[c] + (c1[c] - c0[c]) * ((t - t0) / (t1 - t0));
  }
  return lut;
})();

function specImage(piece) {
  if (piece.img) return piece.img;
  const { cols, rows, cells } = piece;
  const lut = HEAT;
  const px = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 0; y < rows; y++) {
    const src = (rows - 1 - y) * cols; // 행 0이 아래
    for (let x = 0; x < cols; x++) {
      const v = cells[src + x] * 3;
      const o = (y * cols + x) * 4;
      px[o] = lut[v]; px[o + 1] = lut[v + 1]; px[o + 2] = lut[v + 2]; px[o + 3] = 255;
    }
  }
  const img = document.createElement('canvas');
  img.width = cols;
  img.height = rows;
  img.getContext('2d').putImageData(new ImageData(px, cols, rows), 0, 0);
  piece.img = img;
  return img;
}

function note(ctx, g, text, x, y) {
  ctx.font = `11px ${g.css.font}`;
  ctx.textAlign = 'left';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(12,14,18,.72)';
  ctx.fillRect(x - 5, y - 12, tw + 10, 18);
  ctx.fillStyle = g.css.ink;
  ctx.fillText(text, x, y);
}

// 목소리 높이 선: 주파수 그림과 같은 멜 눈금에 올린다. 말소리가 아닌 프레임(null)에서 끊는다.
function drawPitch(ctx, g, spec) {
  const p = g.pitch;
  if (!p || !p.f0.length) return;
  ctx.globalAlpha = g.pitchExact ? 1 : 0.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [lw, color] of [[4, 'rgba(0,0,0,.6)'], [1.8, g.css.ink]]) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < p.f0.length; i++) {
      const f = p.f0[i];
      const x = timeToX(g.view, p.start + i * p.hop);
      if (f == null || x < -4 || x > g.w + 4) { pen = false; continue; }
      const y = rowToY(melRow(f, spec.f_min, spec.f_max, spec.rows), spec.rows, g.h);
      if (!pen) ctx.moveTo(x, y);
      ctx.lineTo(x, y); // 홀로 선 프레임도 점으로 보이게
      pen = true;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSpecBody(ctx, g) {
  const { w, h: hh, piece, view, row } = g;
  if (!piece) {
    ctx.fillStyle = g.css.muted;
    ctx.font = `11px ${g.css.font}`;
    ctx.textAlign = 'center';
    ctx.fillText(g.error ? `주파수 그림을 불러오지 못했습니다: ${g.error}` : '주파수 그림을 불러오는 중…', w / 2, hh / 2 + 4);
    return;
  }
  const x0 = timeToX(view, piece.start);
  const x1 = timeToX(view, piece.end);
  ctx.globalAlpha = g.exact ? 1 : 0.5; // 새 조각이 오기 전까지는 흐리게
  ctx.drawImage(specImage(piece), x0, 0, Math.max(1, x1 - x0), hh);
  ctx.globalAlpha = 1;
  if (g.wide) note(ctx, g, '확대하면 목소리 높이 선이 보입니다', 8, 16);
  else drawPitch(ctx, g, piece);
  if (g.error) note(ctx, g, `새로 받지 못했습니다: ${g.error}`, 8, hh - 8);
}

function drawWaveBody(ctx, g) {
  const { w, h: hh, piece, view, row } = g;
  const mid = hh / 2;
  const amp = mid - 3;
  if (!piece) {
    ctx.fillStyle = g.css.muted;
    ctx.font = `11px ${g.css.font}`;
    ctx.textAlign = 'center';
    ctx.fillText(g.error ? `파형을 불러오지 못했습니다: ${g.error}` : '파형을 불러오는 중…', w / 2, mid + 4);
    return;
  }
  const n = piece.n;
  const span = piece.end - piece.start;
  const binPx = span / n / view.secPerPx; // 칸 하나가 차지하는 화면 픽셀
  ctx.globalAlpha = g.exact ? 1 : 0.5; // 새 조각이 오기 전까지는 흐리게
  let prev = null; // 앞 칸의 가운데 높이: 확대하면 칸이 점이 되므로 이어서 그린다
  for (let i = 0; i < n; i++) {
    const x0 = timeToX(view, piece.start + (i * span) / n);
    if (x0 > w) break;
    if (x0 + binPx < 0) { prev = null; continue; }
    const y1 = mid - piece.max[i] * amp;
    const y2 = mid - piece.min[i] * amp;
    let top = Math.min(y1, y2);
    let bot = Math.max(y1, y2);
    const m = (top + bot) / 2;
    if (prev !== null) { top = Math.min(top, prev); bot = Math.max(bot, prev); }
    prev = m;
    bot = Math.max(bot, top + 1); // 무음도 한 줄은 보이게
    const x = Math.floor(x0);
    const bw = Math.max(1, Math.ceil(x0 + binPx) - x);
    // 파형은 칸마다 그대로 그린다. 잘린 칸은 그 위아래 끝을 붉게 하고, 뒤에 옅은 세로 띠를 깐다(파형 모양을 가리지 않게).
    if (piece.clip[i]) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.28;
      ctx.fillStyle = CLIP_COLOR;
      ctx.fillRect(x, 0, Math.max(1, bw), hh);
      ctx.globalAlpha = a;
    }
    ctx.fillStyle = row.color;
    ctx.fillRect(x, top, bw, bot - top);
    if (piece.clip[i]) {
      ctx.fillStyle = CLIP_COLOR;
      const cap = Math.min(3, (bot - top) / 2);
      ctx.fillRect(x, top, bw, cap);
      ctx.fillRect(x, bot - cap, bw, cap);
    }
  }
  ctx.globalAlpha = 1;
  if (g.error) {
    ctx.fillStyle = g.css.muted;
    ctx.font = `11px ${g.css.font}`;
    ctx.textAlign = 'left';
    ctx.fillText(`새로 받지 못했습니다: ${g.error}`, 8, 14);
  }
}

const DRAWERS = { wave: drawWaveBody, spec: drawSpecBody };

export function createTimeline(root, { session, api = createApi((...a) => fetch(...a)), onSelect = () => {}, onSeek = () => {}, onFocusTrack = () => {}, onMix = () => {}, onSamples = () => {}, onEntry = () => {}, onEdit = async () => {}, clip = null, initial = {} } = {}) {
  const q = (sel) => root.querySelector(sel);
  const rulerEl = q('#ruler');
  const tracksEl = q('#tracks');
  const hscrollEl = q('#hscroll');
  const speechEl = q('#speechband');
  const inputs = { start: q('#selStart'), end: q('#selEnd'), len: q('#selLen') };
  const focusNameEl = q('#focusName');
  const ac = new AbortController(); // 문서·입력칸에 단 듣개를 한 번에 거둔다
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: ac.signal });

  const caseData = session.case;
  const base = `/api/cases/${encodeURIComponent(caseData.id)}`;
  const rows = trackRows(caseData, Boolean(caseData.has_transcript));
  const cs = getComputedStyle(document.documentElement);
  const css = { accent: cs.getPropertyValue('--accent').trim() || '#c9a45c', muted: cs.getPropertyValue('--muted').trim() || '#8a92a0', line: cs.getPropertyValue('--line').trim() || '#2b303a', ink: cs.getPropertyValue('--ink').trim() || '#e9ebf0', font: cs.getPropertyValue('--font').trim() || 'sans-serif', mono: cs.getPropertyValue('--mono').trim() || 'monospace' };

  // 예전 사건은 probe에 길이가 없을 수 있다: 말소리 구간 응답의 길이, 그것도 없으면 첫 파형 응답의 길이를 쓴다.
  let duration = (caseData.original && caseData.original.probe && caseData.original.probe.duration) || (session.speech && session.speech.duration) || 0;
  let view = fitView(duration, 1);
  let fitted = true;
  let pendingRange = initial.range || null; // 주소의 ?view=: 폭이 정해지면 한 번만 맞춘다
  let selection = null;
  let playhead = 0;
  let focusId = 'orig';
  let states = initialStates(rows);
  const modes = new Map(); // 줄 id → 'wave' | 'spec'
  const els = new Map(); // 줄 id → {row, el, canvas, ctx, w, h, dpr, mute, solo, mode}
  const cache = new Map(); // (track,start,end,n) → 받은 조각. 오래된 것부터 지운다
  const specCache = new Map(); // (track,start,end,cols) → 주파수 그림 조각
  const pitchCache = new Map(); // (track,start,end) → 목소리 높이 조각
  const inflight = new Set();
  const errors = new Map(); // track → 마지막 실패 메시지
  let lane = null; // 목소리 샘플 줄(ui/sample_track.js)
  let tlane = null; // 녹취록 줄(ui/transcript_track.js)
  let dpr = 1;
  let fetchTimer = 0;
  let raf = 0;
  let dead = false;

  // ---------- 조각 받기 ----------

  function want() {
    const [a, b] = visibleRange(view);
    return { a: r6(a), b: r6(b), n: clamp(Math.round(view.width), 1, MAX_PEAK_BINS), cols: clamp(Math.round(view.width * dpr), 1, SPEC_MAX_COLS) };
  }

  function pick(store, track, k) {
    const hit = store.get(k);
    if (hit) { store.delete(k); store.set(k, hit); return { piece: hit, exact: true }; }
    const [a, b] = visibleRange(view);
    let best = null;
    for (const p of store.values()) if (p.track === track && p.end > a && p.start < b) best = p; // 가장 최근 것
    return { piece: best, exact: false };
  }

  // 같은 요청은 한 번만 보내고, 받으면 store에 넣는다(넘치면 오래된 것부터 지운다).
  function load(store, max, k, track, url, make) {
    if (store.has(k) || inflight.has(k)) return;
    inflight.add(k);
    api.get(url)
      .then((p) => {
        errors.delete(track);
        store.set(k, make(p));
        while (store.size > max) store.delete(store.keys().next().value);
        if (!duration && p.duration) { duration = p.duration; applyLayout(true); }
      })
      .catch((e) => { errors.set(track, e.message); })
      .finally(() => { inflight.delete(k); schedule(); });
  }

  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  function fetchVisible() {
    if (dead || !(duration > 0)) return;
    const { a, b, n, cols } = want();
    if (!(b > a)) return;
    for (const r of rows) {
      if (r.kind !== 'audio') continue;
      const t = encodeURIComponent(r.track);
      if ((modes.get(r.id) || 'wave') === 'wave') {
        load(cache, CACHE_MAX, tileKey('peaks', r.track, a, b, n), r.track, `${base}/peaks?track=${t}&start=${a}&end=${b}&n=${n}`, (p) => ({ ...p, track: r.track }));
        continue;
      }
      load(specCache, SPEC_CACHE_MAX, tileKey('spec', r.track, a, b, cols), r.track, `${base}/spectrogram?track=${t}&start=${a}&end=${b}&cols=${cols}`,
        (p) => ({ ...p, data: null, cells: decode(p.data), track: r.track, start: a, end: Math.min(b, p.duration || b) }));
      if (b - a <= PITCH_MAX_SPAN) {
        load(pitchCache, CACHE_MAX, tileKey('pitch', r.track, a, b), r.track, `${base}/pitch?track=${t}&start=${a}&end=${b}`,
          (p) => ({ ...p, track: r.track, end: p.start + p.f0.length * p.hop }));
      }
    }
  }

  function scheduleFetch(delay = FETCH_DELAY) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchVisible, delay);
  }

  // ---------- 그리기 ----------
  function schedule() {
    if (!raf && !dead) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function prep(ctx, canvas, w, hh) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'alphabetic';
    return { w, h: hh };
  }

  function drawRuler(ticks) {
    const e = rulerCanvas;
    const { w, h: hh } = prep(e.ctx, e.canvas, e.w, e.h);
    const ctx = e.ctx;
    ctx.strokeStyle = css.muted;
    ctx.fillStyle = css.muted;
    ctx.font = `10px ${css.mono}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of ticks) {
      const x = Math.round(timeToX(view, t.t)) + 0.5;
      if (x < -50 || x > w + 50) continue;
      ctx.moveTo(x, hh - (t.major ? 10 : 5));
      ctx.lineTo(x, hh);
    }
    ctx.stroke();
    for (const t of ticks) {
      if (!t.label) continue;
      const x = Math.round(timeToX(view, t.t));
      if (x + 3 + ctx.measureText(t.label).width > w) continue; // 오른쪽 끝에서 잘릴 글자는 쓰지 않는다
      ctx.fillText(t.label, x + 3, hh - 13);
    }
  }

  // 말소리 띠: 눈금자와 같은 시간축. 누가 말하는지는 말하지 않고 "말소리가 있다"만 칠한다.
  const speechList = () => (session.speech && session.speech.speech) || [];

  function drawBand() {
    const e = bandCanvas;
    const { w, h: hh } = prep(e.ctx, e.canvas, e.w, e.h);
    e.ctx.fillStyle = css.accent;
    for (const r of bandRects(speechList(), view, w, BAND_MIN_PX)) {
      const x = Math.floor(r.x);
      e.ctx.fillRect(x, 0, Math.max(BAND_MIN_PX, Math.ceil(r.x + r.w) - x), hh);
    }
  }

  function hatch(ctx, w, hh) {
    ctx.save();
    ctx.strokeStyle = UNKNOWN_COLOR;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -hh; x < w; x += 9) { ctx.moveTo(x, hh); ctx.lineTo(x + hh, 0); }
    ctx.stroke();
    ctx.restore();
  }

  function drawRow(r, ticks, wnt) {
    const e = els.get(r.id);
    if (!e || !e.canvas || !(e.w > 0)) return;
    const { w, h: hh } = prep(e.ctx, e.canvas, e.w, e.h);
    const ctx = e.ctx;
    if (r.hatched) hatch(ctx, w, hh); // 화자 미상: 확실한 줄과 다르게 빗금
    ctx.fillStyle = 'rgba(255,255,255,.045)'; // 눈금자와 맞는 세로 격자
    for (const t of ticks) if (t.major) ctx.fillRect(Math.round(timeToX(view, t.t)), 0, 1, hh);
    const mode = modes.get(r.id) || 'wave';
    const g = { w, h: hh, row: r, view, error: errors.get(r.track), css };
    if (r.kind === 'audio') {
      if (mode === 'wave') Object.assign(g, pick(cache, r.track, tileKey('peaks', r.track, wnt.a, wnt.b, wnt.n)));
      else {
        Object.assign(g, pick(specCache, r.track, tileKey('spec', r.track, wnt.a, wnt.b, wnt.cols)));
        g.wide = wnt.b - wnt.a > PITCH_MAX_SPAN;
        if (!g.wide) { const pp = pick(pitchCache, r.track, tileKey('pitch', r.track, wnt.a, wnt.b)); g.pitch = pp.piece; g.pitchExact = pp.exact; }
      }
    }
    DRAWERS[mode](ctx, g);
  }

  function placeOverlay() {
    if (selection) {
      const x0 = timeToX(view, selection.start);
      const x1 = timeToX(view, selection.end);
      selEl.hidden = false;
      selEl.style.left = `${x0}px`;
      selEl.style.width = `${Math.max(1, x1 - x0)}px`;
    } else selEl.hidden = true;
    const x = timeToX(view, playhead);
    headEl.hidden = x < -1 || x > view.width + 1;
    headEl.style.transform = `translateX(${x}px)`;
  }

  function placeScroll() {
    const W = view.width;
    const span = view.width * view.secPerPx;
    const full = !(duration > span + 1e-9);
    const tw = full ? W : Math.max(24, (W * span) / duration);
    const left = full ? 0 : ((W - tw) * view.start) / (duration - span);
    thumb.style.width = `${tw}px`;
    thumb.style.transform = `translateX(${left}px)`;
    rail.classList.toggle('full', full);
  }

  function draw() {
    if (dead) return;
    const ticks = rulerTicks(view);
    drawRuler(ticks);
    drawBand();
    const wnt = want();
    for (const r of rows) drawRow(r, ticks, wnt);
    placeOverlay();
    placeScroll();
    if (lane) lane.layout();
    if (tlane) tlane.layout();
  }

  // ---------- 크기 ----------
  function sizeCanvas(canvas, ctxHolder, w, hh) {
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hh * dpr));
    ctxHolder.w = w;
    ctxHolder.h = hh;
  }

  function applyLayout(forceFit = false) {
    const W = Math.floor(tracksEl.clientWidth - CTL_W);
    if (!(W >= 50)) return;
    dpr = window.devicePixelRatio || 1;
    const changed = W !== view.width;
    if (fitted || forceFit) { view = fitView(duration, W); fitted = true; } else view = clampView({ ...view, width: W, duration });
    if (pendingRange && duration > 0) {
      view = zoomToRange(view, pendingRange.start, pendingRange.end);
      fitted = false;
      pendingRange = null;
    }
    rulerCanvas.canvas.style.width = `${W}px`;
    sizeCanvas(rulerCanvas.canvas, rulerCanvas, W, rulerEl.clientHeight || 24);
    bandCanvas.canvas.style.width = `${W}px`;
    sizeCanvas(bandCanvas.canvas, bandCanvas, W, speechEl.clientHeight || 5);
    rail.style.width = `${W}px`;
    for (const e of els.values()) {
      if (!e.canvas) continue;
      sizeCanvas(e.canvas, e, e.wave.clientWidth, e.wave.clientHeight);
    }
    draw();
    if (changed || forceFit) scheduleFetch(0);
  }

  // ---------- 보기 바꾸기 ----------
  function setViewState(v, keepFit = false) {
    view = clampView({ ...v, width: view.width, duration });
    if (!keepFit) fitted = false;
    schedule();
    scheduleFetch();
  }

  const zoomCenter = () => {
    const x = timeToX(view, playhead);
    return x >= 0 && x <= view.width ? x : view.width / 2; // 재생 위치가 보이면 그 자리를 기준으로
  };

  // ---------- 선택 · 상태 줄 ----------
  function paintFields() {
    for (const [key, el] of Object.entries(inputs)) {
      if (!el) continue;
      el.disabled = !selection;
      if (el === document.activeElement) continue; // 고치는 중인 칸은 건드리지 않는다
      el.value = !selection ? '' : formatClock(key === 'start' ? selection.start : key === 'end' ? selection.end : selection.end - selection.start);
    }
  }

  function setSel(sel, notify) {
    selection = sel;
    paintFields();
    schedule();
    if (notify) onSelect(sel);
  }

  function commitField(key) {
    const el = inputs[key];
    const t = parseClock(el.value);
    if (!selection || t === null) {
      toast('시각을 알아볼 수 없습니다. 예: 5.05 또는 0:05.050', true);
      paintFields();
      return;
    }
    const next = key === 'start' ? moveEdge(selection, 'start', t, duration)
      : key === 'end' ? moveEdge(selection, 'end', t, duration)
        : moveEdge(selection, 'end', selection.start + t, duration);
    if (!(next.end > next.start)) {
      toast('선택 구간의 시작은 끝보다 앞이어야 합니다.', true);
      paintFields();
      return;
    }
    setSel(next, true);
  }

  // ---------- 초점 · 소리 켜고 끄기 ----------
  function focusRow(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    focusId = id;
    for (const [rid, e] of els) e.el.classList.toggle('focus', rid === id);
    if (focusNameEl) focusNameEl.textContent = r.name;
    onFocusTrack(r);
  }

  const getMix = () => ({ states, audible: audibleIds(states) });

  function paintMix() {
    for (const s of states) {
      const e = els.get(s.id);
      if (!e) continue;
      e.mute.setAttribute('aria-pressed', String(s.mute));
      e.solo.setAttribute('aria-pressed', String(s.solo));
    }
  }

  function toggle(id, key) {
    states = toggleState(states, id, key);
    paintMix();
    onMix(getMix());
  }

  function paintMode(id) {
    const e = els.get(id);
    if (!e || !e.mode) return;
    const spec = modes.get(id) === 'spec';
    e.mode.textContent = spec ? '주파수' : '파형';
    e.wave.classList.toggle('spec', spec); // 가운데 줄은 파형에만
  }

  function setTrackMode(id, mode) {
    const r = rows.find((x) => x.id === id);
    if (!r || r.kind !== 'audio' || (mode !== 'wave' && mode !== 'spec')) return;
    modes.set(id, mode);
    paintMode(id);
    schedule();
    scheduleFetch(0);
  }

  // ---------- 줄 만들기 ----------
  const rulerCanvas = { canvas: h('canvas', { class: 'tl-canvas' }), ctx: null, w: 0, h: 0 };
  rulerCanvas.ctx = rulerCanvas.canvas.getContext('2d');
  const bandCanvas = { canvas: h('canvas', { class: 'tl-canvas' }), ctx: null, w: 0, h: 0 };
  bandCanvas.ctx = bandCanvas.canvas.getContext('2d');
  const thumb = h('div', { class: 'hs-thumb' });
  const rail = h('div', { class: 'hs-rail' }, thumb);
  const selEl = h('div', { class: 'tl-sel', hidden: true });
  const headEl = h('div', { class: 'tl-head' });

  function makeRow(r) {
    const audio = r.kind === 'audio';
    const e = { row: r, canvas: audio ? h('canvas', { class: 'tl-canvas' }) : null, w: 0, h: 0 };
    if (audio) {
      e.ctx = e.canvas.getContext('2d');
      e.mute = h('button', { type: 'button', 'aria-pressed': 'false', title: '이 트랙 소리 끄기', onclick: () => toggle(r.id, 'mute') }, '끄기');
      e.solo = h('button', { type: 'button', 'aria-pressed': 'false', title: '이 트랙만 듣기', onclick: () => toggle(r.id, 'solo') }, '단독');
      e.mode = h('button', { type: 'button', title: '파형 ↔ 주파수 그림 바꾸기', onclick: () => setTrackMode(r.id, (modes.get(r.id) || 'wave') === 'wave' ? 'spec' : 'wave') }, '파형');
    }
    e.wave = h('div', { class: 'wave' }, e.canvas);
    e.el = h('div', { class: `row tl-row ${audio ? 'audio' : 'lane'}${r.hatched ? ' hatched' : ''}`, 'data-id': r.id, 'data-kind': r.kind },
      h('div', { class: 'ctl', onclick: () => focusRow(r.id) },
        h('div', { class: 'name', title: r.name }, h('i', { style: `background:${r.color}` }), h('span', {}, r.name)),
        h('div', { class: 'sub' }, r.sub),
        audio ? h('div', { class: 'btns' }, e.mute, e.solo, e.mode) : null),
      e.wave);
    els.set(r.id, e);
    if (r.kind === 'samples') {
      lane = createSampleLane(e.wave, {
        session, clip: clip || createClipCheck(api, base), getView: () => view, getDuration: () => duration,
        getSelection: () => selection, select: (sel) => setSel(sel, true), onChange: onSamples,
      });
    }
    if (r.kind === 'transcript') {
      tlane = createTranscriptLane(e.wave, {
        session, getView: () => view, getSelection: () => selection, onEntry,
        zoomTo: (a, b) => setViewState(zoomToRange(view, a, b)),
      });
    }
    return e.el;
  }

  // 이름을 고친 뒤 줄 이름표를 맞춘다(줄은 한 번만 만들어서, 지금 화자 목록으로 이름을 다시 구한다).
  function renameRows() {
    for (const f of trackRows(session.case, Boolean(session.case.has_transcript))) {
      const r = rows.find((x) => x.id === f.id);
      const e = els.get(f.id);
      if (!r || !e || r.name === f.name) continue;
      r.name = f.name;
      const box = e.el.querySelector('.ctl .name');
      box.title = f.name;
      box.querySelector('span').textContent = f.name;
      if (focusId === f.id && focusNameEl) focusNameEl.textContent = f.name;
    }
  }

  const hasPeople = rows.some((r) => r.kind === 'audio' && r.id !== 'orig');
  const inner = h('div', { class: 'tl-inner' },
    rows.map(makeRow),
    hasPeople ? null : h('p', { class: 'tracks-hint' }, '샘플을 고르고 [화자 분리]를 누르면 사람별 트랙과 녹취록이 여기에 생깁니다.'),
    h('div', { class: 'tl-over' }, selEl, headEl));
  tracksEl.replaceChildren(inner);
  rulerEl.replaceChildren(h('div', { class: 'rl-gutter' }), rulerCanvas.canvas);
  speechEl.replaceChildren(h('div', { class: 'rl-gutter' }), bandCanvas.canvas);
  speechEl.title = '말소리가 있는 곳 · [ ] 키로 앞뒤 말소리로 건너뜁니다';
  hscrollEl.replaceChildren(h('div', { class: 'hs-gutter' }), rail);
  paintMix();
  focusRow('orig');

  // ---------- 마우스 ----------
  const waveLeft = () => inner.getBoundingClientRect().left + CTL_W;
  let drag = null;

  function beginDrag(e, trackId) {
    if (e.button !== 0) return;
    const x = clamp(e.clientX - waveLeft(), 0, view.width);
    drag = { x0: x, track: trackId, moved: false, sel: null, pid: e.pointerId, el: e.currentTarget };
    drag.el.setPointerCapture(e.pointerId);
    if (trackId !== focusId) focusRow(trackId);
  }

  on(tracksEl, 'pointerdown', (e) => {
    if (e.target.closest('.ctl')) return;
    const rowEl = e.target.closest('.tl-row');
    beginDrag(e, rowEl ? rowEl.dataset.id : focusId);
  });
  on(rulerEl, 'pointerdown', (e) => beginDrag(e, focusId));

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const x = clamp(e.clientX - waveLeft(), 0, view.width);
    if (!drag.moved && Math.abs(x - drag.x0) > DRAG_PX) drag.moved = true;
    if (!drag.moved) return;
    const sel = selectionFromDrag(view, drag.x0, x, drag.track);
    if (sel) { drag.sel = sel; setSel(sel, false); } // 끄는 동안은 화면만, 놓을 때 한 번 알린다
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      if (d.sel) onSelect(d.sel);
    } else {
      const t = clamp(xToTime(view, d.x0), 0, duration);
      setPlayhead(t);
      onSeek(t);
    }
  }

  for (const el of [tracksEl, rulerEl]) {
    on(el, 'pointermove', moveDrag);
    on(el, 'pointerup', endDrag);
    on(el, 'pointercancel', (e) => { if (drag && e.pointerId === drag.pid) drag = null; });
  }

  // 휠: 그냥 = 세로 스크롤(브라우저), Shift = 좌우, Ctrl = 마우스 기준 확대
  function onWheel(e) {
    if (!e.ctrlKey && !e.shiftKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1;
    if (e.ctrlKey) {
      const x = clamp(e.clientX - waveLeft(), 0, view.width);
      setViewState(zoomAt(view, Math.exp(-e.deltaY * unit * 0.0025), x));
    } else {
      setViewState(scrollBy(view, (e.deltaX || e.deltaY) * unit));
    }
  }
  for (const el of [tracksEl, rulerEl]) on(el, 'wheel', onWheel, { passive: false });

  // 가로 스크롤 막대: 막대를 끌거나 빈 곳을 눌러 한 화면씩
  let thumbDrag = null;
  on(thumb, 'pointerdown', (e) => {
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    thumbDrag = { x: e.clientX, start: view.start, pid: e.pointerId };
  });
  on(thumb, 'pointermove', (e) => {
    if (!thumbDrag || e.pointerId !== thumbDrag.pid) return;
    const span = view.width * view.secPerPx;
    const room = view.width - thumb.offsetWidth;
    if (!(room > 0) || !(duration > span)) return;
    setViewState({ ...view, start: thumbDrag.start + ((e.clientX - thumbDrag.x) * (duration - span)) / room });
  });
  on(thumb, 'pointerup', () => { thumbDrag = null; });
  on(thumb, 'pointercancel', () => { thumbDrag = null; });
  on(rail, 'pointerdown', (e) => {
    if (e.target === thumb) return;
    const dir = e.clientX < thumb.getBoundingClientRect().left ? -1 : 1;
    setViewState(scrollBy(view, dir * view.width * 0.9));
  });

  // ---------- 말소리 건너뛰기 ----------
  // 선택이 있으면 그 끝(앞으로) / 시작(뒤로)에서, 없으면 재생 위치에서 다음 말소리를 선택하고 화면에 보이게 한다.
  function stepSpeech(dir) {
    const t = selection ? (dir > 0 ? selection.end : selection.start) : playhead;
    const iv = speechStep(speechList(), t, dir, Boolean(selection));
    if (!iv) { toast(dir > 0 ? '이 뒤로는 말소리가 없습니다.' : '이 앞으로는 말소리가 없습니다.'); return; }
    setSel({ start: iv[0], end: iv[1], track: focusId }, true);
    const [va, vb] = visibleRange(view);
    if (iv[0] >= va && iv[1] <= vb) return;
    const span = view.width * view.secPerPx;
    const start = iv[1] - iv[0] < span ? (iv[0] + iv[1]) / 2 - span / 2 : iv[0] - span * FOLLOW_MARGIN;
    setViewState({ ...view, start });
  }

  // ---------- 키 ----------
  on(document, 'keydown', async (e) => {
    const action = actionFor(e);
    if (!action || modalOpen()) return;
    if (action === 'escape' && isField(e.target)) return; // 입력칸이 스스로 되돌린다
    e.preventDefault();
    const seek = (t) => { setPlayhead(t); onSeek(t); };
    switch (action) {
      case 'zoomIn': setViewState(zoomAt(view, ZOOM_STEP, zoomCenter())); break;
      case 'zoomOut': setViewState(zoomAt(view, 1 / ZOOM_STEP, zoomCenter())); break;
      case 'fit': fitted = true; view = fitView(duration, view.width); schedule(); scheduleFetch(); break;
      case 'zoomSel': if (!selection) return; setViewState(zoomToRange(view, selection.start, selection.end)); break;
      case 'home': seek(0); break;
      case 'end': seek(duration); break;
      case 'escape': if (!selection) return; setSel(null, true); break;
      case 'prevSpeech':
      case 'nextSpeech': stepSpeech(action === 'nextSpeech' ? 1 : -1); break;
      case 'assign1': case 'assign2': case 'assign3':
        if (!lane || !lane.key(action)) return;
        break;
      case 'delete':
        if (lane && lane.key(action)) break; // 정확히 고른 샘플 조각 삭제가 우선
        if (!selection) { toast('자를 구간을 먼저 드래그해 선택하세요.'); return; }
        await onEdit('cut', selection);
        break;
      case 'undo': await onEdit('undo'); break;
      case 'redo': await onEdit('redo'); break;
      default: return;
    }
  });

  for (const [key, el] of Object.entries(inputs)) {
    if (!el) continue;
    let cancelled = false;
    on(el, 'focus', () => { cancelled = false; }); // 아무것도 안 치고 Esc만 눌렀을 때 남은 표시가 다음 수정을 삼키지 않게
    on(el, 'change', () => { if (cancelled) cancelled = false; else commitField(key); });
    on(el, 'blur', paintFields); // 고친 값을 00:00:00.000 꼴로 다시 쓴다
    on(el, 'keydown', (e) => {
      if (e.key === 'Enter') el.blur();
      else if (e.key === 'Escape') { cancelled = true; el.blur(); }
    });
  }

  // ---------- 바깥에서 쓰는 것 ----------
  // 재생 위치. 화면 밖이면 보기가 따라간다.
  function setPlayhead(t) {
    playhead = clamp(t, 0, duration);
    const [a, b] = visibleRange(view);
    if (playhead < a || playhead > b) setViewState({ ...view, start: playhead - view.width * view.secPerPx * FOLLOW_MARGIN }, true);
    schedule();
  }

  if (initial.spec) setTrackMode(initial.spec, 'spec');
  const ro = new ResizeObserver(() => applyLayout());
  ro.observe(tracksEl);
  applyLayout();
  paintFields();

  return {
    setView: (v) => setViewState(v),
    getView: () => view,
    setSelection: (sel) => setSel(sel, false),
    redraw: draw,
    renameRows,
    refreshTranscript: () => { if (tlane) tlane.refresh(); }, // 카드에서 줄을 고치거나 넣으면 조각도 다시 그린다
    setPlaying: (keys) => { if (tlane) tlane.setPlaying(keys); }, // 재생 중인 줄 조각 강조
    setPlayhead,
    getPlayhead: () => playhead, // [줄 넣기]가 재생 위치에서 시작한다
    setTrackMode,
    getMix,
    getSelection: () => selection,
    getDuration: () => duration,
    rows,
    destroy() {
      dead = true;
      if (lane) lane.destroy();
      if (tlane) tlane.destroy();
      ac.abort();
      ro.disconnect();
      clearTimeout(fetchTimer);
      if (raf) cancelAnimationFrame(raf);
      tracksEl.replaceChildren();
      rulerEl.replaceChildren();
      speechEl.replaceChildren();
      hscrollEl.replaceChildren();
      for (const el of Object.values(inputs)) if (el) { el.value = ''; el.disabled = true; }
      if (focusNameEl) focusNameEl.textContent = '—';
    },
  };
}
