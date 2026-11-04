import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SEC_PER_PX, fitView, timeToX, xToTime, zoomAt, zoomToRange, scrollBy, clampView, visibleRange, rulerTicks, bandRects, melRow, rowToY, tileKey,
} from '../../truth_sound/static/editor/view.js';

test('fitView shows the whole file', () => {
  const v = fitView(100, 1000);
  assert.deepEqual(v, { start: 0, secPerPx: 0.1, width: 1000, duration: 100 });
  assert.deepEqual(visibleRange(v), [0, 100]);
  assert.equal(timeToX(v, 50), 500);
  assert.equal(xToTime(v, 500), 50);
});

test('zoomAt keeps time under cursor', () => {
  const v = fitView(100, 1000);
  const t = xToTime(v, 300);
  const z = zoomAt(v, 4, 300);
  assert.ok(Math.abs(xToTime(z, 300) - t) < 1e-9);
  assert.equal(z.secPerPx, 0.025);
  assert.equal(v.start, 0); // 입력은 바뀌지 않는다
});

test('zoom limit 0.1ms per px', () => {
  let v = fitView(2, 1000);
  for (let i = 0; i < 40; i++) v = zoomAt(v, 2, 500);
  assert.equal(MIN_SEC_PER_PX, 0.0001);
  assert.equal(v.secPerPx, 0.0001);
});

test('zoom out stops at whole file', () => {
  let v = zoomAt(fitView(100, 1000), 8, 100);
  v = zoomAt(v, 0.001, 100);
  assert.deepEqual(v, fitView(100, 1000));
});

test('fit and clamp stay inside file', () => {
  const v = zoomAt(fitView(100, 1000), 4, 0);
  const far = scrollBy(v, 1e9);
  assert.ok(Math.abs(far.start - (100 - 1000 * far.secPerPx)) < 1e-9);
  assert.equal(scrollBy(v, -1e9).start, 0);
  assert.equal(scrollBy(v, 100).start, 100 * v.secPerPx);
  const bad = clampView({ start: -5, secPerPx: 5, width: 1000, duration: 100 });
  assert.deepEqual(bad, fitView(100, 1000));
  const [a, b] = visibleRange(far);
  assert.ok(a >= 0 && b <= 100);
});

test('zoomToRange fills the width', () => {
  const z = zoomToRange(fitView(100, 1000), 20, 30);
  assert.equal(z.start, 20);
  assert.ok(Math.abs(z.secPerPx - 0.01) < 1e-12);
  const swapped = zoomToRange(fitView(100, 1000), 30, 20);
  assert.equal(swapped.start, 20);
});

test('ruler ticks are inside view and labelled', () => {
  const v = zoomToRange(fitView(100, 1000), 12.3, 17.9);
  const [a, b] = visibleRange(v);
  const ticks = rulerTicks(v);
  assert.ok(ticks.length > 3);
  for (const k of ticks) {
    assert.ok(k.t >= a - 1e-9 && k.t <= b + 1e-9);
    if (k.major) assert.ok(k.label.length > 0);
  }
  assert.ok(ticks.some((k) => k.major));
  assert.ok(ticks.some((k) => !k.major));
  const whole = rulerTicks(fitView(125, 1000));
  assert.ok(whole.some((k) => k.major && k.label === '00:01:00'));
});

test('ruler labels use hh:mm:ss, drop ms from 1 s steps, and never overlap', () => {
  const long = rulerTicks(fitView(7500, 1000));
  assert.ok(long.some((k) => k.major && /^01:\d\d:\d\d$/.test(k.label)));
  assert.ok(rulerTicks(zoomToRange(fitView(100, 1000), 5, 5.5)).some((k) => k.major && k.label === '00:00:05.000'));
  assert.ok(rulerTicks(zoomToRange(fitView(100, 1000), 5.05, 5.06)).some((k) => k.major && /^00:00:05\.0[5-6]\d$/.test(k.label)));
  for (const [dur, a, b, width] of [[7500, 0, 7500, 900], [100, 0, 100, 900], [100, 12.3, 17.9, 700], [3, 1, 1.5, 1200], [3, 1, 1.0905, 915], [3, 1, 1.0905, 300]]) {
    const v = zoomToRange(fitView(dur, width), a, b);
    const majors = rulerTicks(v).filter((k) => k.major);
    for (let i = 1; i < majors.length; i++) {
      const gap = (majors[i].t - majors[i - 1].t) / v.secPerPx;
      assert.ok(gap >= majors[i].label.length * 6.6, `${dur} ${a}-${b}: ${gap}px for ${majors[i].label}`);
    }
  }
});

test('bandRects draws every speech at least minPx wide, centred on its midpoint', () => {
  const v = fitView(100, 1000); // 0.1초/픽셀
  const r = bandRects([[10, 10.05], [20, 30]], v, 1000, 2);
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0].w - 2) < 1e-9);
  assert.ok(Math.abs(r[0].x + r[0].w / 2 - 100.25) < 1e-9); // 가운데 10.025초 = 100.25px
  assert.ok(Math.abs(r[1].x - 200) < 1e-9 && Math.abs(r[1].w - 100) < 1e-9);
});

test('bandRects skips what is outside the view and clips at the edges', () => {
  const v = zoomToRange(fitView(100, 1000), 10, 20); // 0.01초/픽셀
  const r = bandRects([[1, 2], [9.5, 10.5], [15, 15.001], [19.9, 25], [30, 31]], v, 1000, 2);
  assert.equal(r.length, 3);
  assert.equal(r[0].x, 0); // 왼쪽에서 잘림
  assert.ok(Math.abs(r[0].w - 50) < 1e-9);
  assert.ok(Math.abs(r[1].w - 2) < 1e-9);
  assert.ok(Math.abs(r[2].x - 990) < 1e-9 && Math.abs(r[2].w - 10) < 1e-9); // 오른쪽에서 잘림
});

test('bandRects tolerates missing input', () => {
  assert.deepEqual(bandRects(undefined, fitView(10, 100), 100, 2), []);
  assert.deepEqual(bandRects([], fitView(10, 100), 100, 2), []);
});

test('melRow maps Hz onto the spectrogram row scale', () => {
  const fMin = 50;
  const fMax = 8000;
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const m = (k) => mel(fMin) + ((mel(fMax) - mel(fMin)) * k) / 129;
  const hz = (k) => 700 * (10 ** (m(k) / 2595) - 1);
  assert.ok(Math.abs(melRow(hz(1), fMin, fMax)) < 1e-9); // 경계 1 = 0번 행 가운데
  assert.ok(Math.abs(melRow(hz(65), fMin, fMax) - 64) < 1e-9);
  assert.ok(Math.abs(melRow(hz(128), fMin, fMax) - 127) < 1e-9); // 맨 위 행 가운데
  assert.ok(Math.abs(melRow(fMin, fMin, fMax) + 1) < 1e-9);
});

test('rowToY puts row 0 at the bottom', () => {
  assert.equal(rowToY(0, 128, 128), 127.5);
  assert.equal(rowToY(127, 128, 128), 0.5);
  assert.equal(rowToY(63.5, 128, 256), 128);
});

test('tileKey differs by kind so peaks, spectrogram and pitch requests never collide', () => {
  const k = [tileKey('peaks', 'orig', 0, 2, 915), tileKey('spec', 'orig', 0, 2, 915), tileKey('pitch', 'orig', 0, 2)];
  assert.equal(new Set(k).size, 3);
  assert.equal(tileKey('spec', 'orig', 0, 2, 915), tileKey('spec', 'orig', 0, 2, 915));
  assert.notEqual(tileKey('spec', 'orig', 0, 2, 915), tileKey('spec', 'me', 0, 2, 915));
});
