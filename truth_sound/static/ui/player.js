// 재생: 소리 나는 트랙을 함께 들려준다. 단독·끄기는 editor/tracks.js의 audibleIds가 정하고, 여기서는 그대로 따른다.
// 듣는 방법은 editor/tracks.js의 playMode가 고른다.
//  full    : 트랙마다 audio 요소로 통째로. 40ms 넘게 어긋나면 맞춘다.
//  buffer  : 구간 clip을 decodeAudioData로 받아 같은 시각에 시작한다(1배속, 반복이 끊기지 않는다).
//  element : 구간 clip을 audio 요소로(0.75·0.5·0.25배속, preservesPitch). 반복은 loop 속성이라 되돌아갈 때 짧은 틈이 있다.
// 소리는 트랙별 GainNode → 하나로 합친 AnalyserNode(크기 막대) → 스피커로 간다. 시간 늘이기는 브라우저에 맡긴다.
import { toast } from './dom.js';
import { modalOpen } from './timeline.js';
import { actionFor } from '../editor/keymap.js';
import { audibleIds, playMode, shouldRestart, needsReload, activeTracks } from '../editor/tracks.js';

const SYNC_LIMIT = 0.04; // 요소끼리 이만큼(초) 넘게 어긋나면 맞춘다
const START_LEAD = 0.06; // 버퍼 모드: 모든 소리를 같은 시각에 시작하려고 두는 여유
const END_SLACK = 0.02; // 이만큼 끝에 가까우면 끝까지 들은 것으로 본다
export const SPEEDS = [1, 0.75, 0.5, 0.25];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function createPlayer({ caseId, getAudible, getDuration = () => 0 }) {
  const base = `/api/cases/${encodeURIComponent(caseId)}`;
  const trackUrl = (track) => (track === 'orig' ? `${base}/audio/listen` : `${base}/audio/track/${encodeURIComponent(track)}`);
  const clipUrl = (track, w) => `${base}/audio/clip?track=${encodeURIComponent(track)}&start=${r6(w.a)}&end=${r6(w.b)}`;

  let ctx = null;
  let mixGain = null;
  let analyser = null;
  let meterBuf = null;
  const gains = new Map(); // 트랙 → GainNode(소리 나면 1, 아니면 0)
  let mix = new Set(getAudible());
  let only = null; // play(sel, {tracks})로 한 번만 고른 트랙. 다음 play나 끄기·단독을 바꾸면 풀린다
  const audible = () => activeTracks(only, mix);
  let speed = 1;
  let loop = false;
  let pos = 0; // 멈춰 있을 때의 자리(초)
  let run = null; // 지금 나고 있는 소리 {mode, win, tracks, time(), stop(), ...}
  let cur = null; // 시작 중이거나 나는 중인 재생 {win, t}: 시작을 기다리는 동안의 속도·반복 바뀜을 받으려고
  let starting = false;
  let gen = 0; // 새 재생·멈춤마다 올려서 늦게 끝난 앞 시작을 버린다
  let raf = 0;
  let dead = false;
  const timeCbs = new Set();
  const stateCbs = new Set();
  // 구간 clip 캐시: 선택이 바뀌면 비우고 다시 받는다
  const clips = { key: '', blobs: new Map(), bufs: new Map(), urls: new Map() };

  const playing = () => starting || Boolean(run);
  const emitState = () => { for (const f of stateCbs) f(playing()); };
  const emitTime = (t) => { for (const f of timeCbs) f(t); };
  const fail = (e) => { if (!dead) toast(e && e.message ? e.message : String(e), true); };

  function graph() {
    if (!ctx) {
      ctx = new AudioContext();
      mixGain = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      meterBuf = new Float32Array(analyser.fftSize);
      mixGain.connect(analyser);
      analyser.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {}); // 사용자가 누른 직후라 풀린다. 기다리지는 않는다
    return ctx;
  }

  function gainFor(track) {
    let g = gains.get(track);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = audible().has(track) ? 1 : 0;
      g.connect(mixGain);
      gains.set(track, g);
    }
    return g;
  }

  function applyGains() {
    for (const [track, g] of gains) g.gain.setTargetAtTime(audible().has(track) ? 1 : 0, ctx.currentTime, 0.005); // 딱 소리가 나지 않게 살짝 부드럽게
  }

  // ---- 구간 clip ----
  function dropClips() {
    for (const u of clips.urls.values()) URL.revokeObjectURL(u);
    clips.urls.clear();
    clips.blobs.clear();
    clips.bufs.clear();
    clips.key = '';
  }

  async function fetchBlob(path, label) {
    const r = await fetch(path);
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).detail || ''; } catch { /* 본문이 없으면 번호만 */ }
      throw new Error(`${label} 소리를 불러오지 못했습니다${detail ? `: ${detail}` : ` (${r.status})`}`);
    }
    return r.blob();
  }

  function clipBlob(track, w) {
    const key = `${r6(w.a)}-${r6(w.b)}`;
    if (clips.key !== key) { dropClips(); clips.key = key; }
    let p = clips.blobs.get(track);
    if (!p) {
      p = fetchBlob(clipUrl(track, w), track === 'orig' ? '원본' : '분리');
      clips.blobs.set(track, p);
      p.catch(() => clips.blobs.delete(track)); // 실패는 남기지 않아 다시 누르면 다시 받는다
    }
    return p;
  }

  function clipBuffer(track, w) {
    const blob = clipBlob(track, w);
    let p = clips.bufs.get(track);
    if (!p) {
      p = blob.then((b) => b.arrayBuffer()).then((ab) => ctx.decodeAudioData(ab));
      clips.bufs.set(track, p);
      p.catch(() => clips.bufs.delete(track));
    }
    return p;
  }

  async function clipObjectUrl(track, w) {
    const blob = await clipBlob(track, w);
    let u = clips.urls.get(track);
    if (!u) { u = URL.createObjectURL(blob); clips.urls.set(track, u); }
    return u;
  }

  // ---- 소리 내기 ----
  async function startBuffer(my, w, t, tracks) {
    const bufs = await Promise.all(tracks.map((tr) => clipBuffer(tr, w)));
    if (my !== gen) return null;
    const len = bufs[0].duration;
    const off = clamp(t - w.a, 0, Math.max(0, len - 0.001));
    const when = ctx.currentTime + START_LEAD;
    const srcs = tracks.map((tr, i) => {
      const s = ctx.createBufferSource();
      s.buffer = bufs[i];
      s.loop = loop;
      if (loop) { s.loopStart = 0; s.loopEnd = bufs[i].duration; }
      s.connect(gainFor(tr));
      s.start(when, off);
      return s;
    });
    const r = {
      mode: 'buffer', win: w, tracks,
      time() {
        const x = Math.max(off, ctx.currentTime - when + off);
        return w.a + (loop ? x % len : Math.min(x, len));
      },
      stop() {
        for (const s of srcs) { s.onended = null; try { s.stop(); } catch { /* 이미 끝남 */ } s.disconnect(); }
      },
    };
    if (!loop) srcs[0].onended = () => { if (run === r) finish(); };
    return r;
  }

  async function startElements(my, mode, w, t, tracks) {
    const clipped = mode === 'element';
    const off = clipped ? w.a : 0; // 요소의 0초가 녹음의 몇 초인가
    const urls = await Promise.all(tracks.map((tr) => (clipped ? clipObjectUrl(tr, w) : trackUrl(tr))));
    if (my !== gen) return null;
    const items = tracks.map((tr, i) => {
      const el = new Audio();
      el.preload = 'auto';
      el.src = urls[i];
      el.defaultPlaybackRate = speed; // src를 줄 때 속도가 되돌려지므로 기본값도 같이
      el.playbackRate = speed;
      el.preservesPitch = true;
      el.loop = clipped && loop;
      const node = ctx.createMediaElementSource(el);
      node.connect(gainFor(tr));
      return { tr, el, node };
    });
    const dispose = () => {
      for (const { el, node } of items) { el.pause(); node.disconnect(); el.removeAttribute('src'); el.load(); }
    };
    try {
      await Promise.all(items.map(({ el, tr }) => new Promise((ok, no) => {
        if (el.readyState >= 3) { ok(); return; }
        el.addEventListener('canplay', ok, { once: true });
        el.addEventListener('error', () => no(new Error(`${tr === 'orig' ? '원본' : '분리'} 소리를 열지 못했습니다`)), { once: true });
      })));
      if (my !== gen) { dispose(); return null; }
      const at = Math.max(0, t - off);
      for (const { el } of items) el.currentTime = el.duration ? Math.min(at, el.duration) : at;
      await Promise.all(items.map(({ el }) => el.play()));
    } catch (e) {
      dispose();
      throw e;
    }
    if (my !== gen) { dispose(); return null; }
    const master = items[0].el;
    const r = {
      mode, win: w, tracks, ending: false,
      time: () => off + master.currentTime,
      sync() {
        const m = master.currentTime;
        for (const { el } of items) if (el !== master && !el.seeking && Math.abs(el.currentTime - m) > SYNC_LIMIT) el.currentTime = m;
      },
      // 통째 재생의 구간 끝(600초 넘는 선택)은 여기서 본다
      atEnd: () => !clipped && Boolean(w) && r.time() >= w.b,
      setRate(v) { for (const { el } of items) { el.defaultPlaybackRate = v; el.playbackRate = v; } },
      setLoop(v) { for (const { el } of items) el.loop = clipped && v; },
      stop: dispose,
    };
    master.addEventListener('ended', () => { if (run === r) onEnded(r); });
    return r;
  }

  function onEnded(r) {
    if (r.ending) return;
    r.ending = true;
    // 통째 재생의 반복은 600초 넘는 선택이 있을 때만(선택 시작부터). 선택이 없으면 반복은 꺼진 것과 같아 끝에서 멈춘다.
    if (shouldRestart({ loop, mode: r.mode, selection: r.win })) begin(r.win, r.win.a).catch(fail);
    else finish();
  }

  function halt() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (run) { const r = run; run = null; r.stop(); }
  }

  function finish() {
    const end = run && run.win ? run.win.b : getDuration();
    halt();
    pos = end;
    cur = null;
    emitTime(end);
    emitState();
  }

  function tick() {
    raf = 0;
    if (!run) return;
    if (run.sync) run.sync();
    if (run.atEnd && run.atEnd()) { onEnded(run); if (!run) return; }
    pos = run.time();
    emitTime(pos);
    raf = requestAnimationFrame(tick);
  }

  async function begin(w, t) {
    const my = ++gen;
    halt();
    cur = { win: w, t };
    const tracks = [...audible()];
    if (!tracks.length) {
      cur = null;
      emitState();
      throw new Error('소리 나는 트랙이 없습니다. [끄기]를 풀거나 [단독]을 눌러 주세요.');
    }
    starting = true;
    emitState();
    graph();
    applyGains(); // 시작하기 전에 소리 나는 트랙을 맞춘다(한 번만 고른 트랙이 처음부터 들리게)
    const mode = w ? playMode({ selection: { start: w.a, end: w.b }, speed, loop }) : 'full';
    let next = null;
    try {
      next = mode === 'buffer' ? await startBuffer(my, w, t, tracks) : await startElements(my, mode, w, t, tracks);
    } catch (e) {
      if (my === gen) { starting = false; cur = null; emitState(); }
      throw e;
    }
    if (my !== gen) { if (next) next.stop(); return; }
    starting = false;
    run = next;
    emitState();
    raf = requestAnimationFrame(tick);
    // 받는 동안 바뀐 끄기·단독을 따른다: 끈 것은 소리 크기로, 새로 켠 트랙은 받아서 현재 위치부터 다시 시작
    if (ctx) applyGains();
    if (needsReload(audible(), next.tracks)) restartHere();
  }

  // ---- 바깥에서 쓰는 것 ----
  // opts.tracks: 이 트랙만 들려 주고 구간 처음(sel.start)부터 시작한다(예: 녹취록 줄의 ▶원본 · ▶분리 음성)
  async function play(sel = null, opts = {}) {
    only = opts.tracks && opts.tracks.length ? new Set(opts.tracks) : null;
    const dur = getDuration();
    const w = sel && sel.end > sel.start ? { a: sel.start, b: dur ? Math.min(sel.end, dur) : sel.end } : null;
    let t;
    if (w) t = !only && pos >= w.a && pos < w.b - END_SLACK ? pos : w.a; // 멈춘 자리가 선택 안이면 이어서, 아니면 선택 처음부터
    else t = dur && pos >= dur - END_SLACK ? 0 : pos;
    try { await begin(w, t); } catch (e) { fail(e); }
  }

  function pause() {
    gen++; // 시작을 기다리던 것도 버린다
    if (run) pos = run.time();
    starting = false;
    cur = null;
    halt();
    emitTime(pos);
    emitState();
  }

  const here = () => (run ? run.time() : cur ? cur.t : pos);
  const restartHere = () => { if (playing() && cur) begin(cur.win, here()).catch(fail); };

  function seek(t) {
    const dur = getDuration();
    pos = dur ? clamp(t, 0, dur) : Math.max(0, t);
    if (!playing()) return;
    const w = cur && cur.win && pos >= cur.win.a && pos < cur.win.b ? cur.win : null; // 선택 밖을 누르면 거기서부터 통째로
    if (!w && dur && pos >= dur - END_SLACK) { pause(); return; }
    begin(w, pos).catch(fail);
  }

  function setSpeed(v) {
    if (!SPEEDS.includes(v)) return;
    speed = v;
    if (!playing()) return;
    const w = cur && cur.win;
    const next = w ? playMode({ selection: { start: w.a, end: w.b }, speed, loop }) : 'full';
    if (run && run.mode === next && run.setRate) run.setRate(v); // 요소는 속도만 바꾸면 된다
    else restartHere();
  }

  function setLoop(on) {
    loop = Boolean(on);
    if (!playing()) return;
    if (run && run.setLoop) run.setLoop(loop);
    else restartHere(); // 버퍼는 반복을 켜고 끄려면 다시 시작해야 시각 계산이 맞는다
  }

  function setMix(states) {
    mix = audibleIds(states);
    only = null;
    if (ctx) applyGains();
    if (run && needsReload(mix, run.tracks)) restartHere(); // 아직 받지 않은 트랙이 켜졌다
    // 받는 중(run 없음)이면 시작이 끝날 때 begin이 mix를 다시 보고 맞춘다
  }

  // 0~1: 지금 나는 소리의 가장 큰 값
  function level() {
    if (!run || !analyser) return 0;
    analyser.getFloatTimeDomainData(meterBuf);
    let p = 0;
    for (let i = 0; i < meterBuf.length; i++) p = Math.max(p, Math.abs(meterBuf[i]));
    return Math.min(1, p);
  }

  function destroy() {
    dead = true;
    gen++;
    starting = false;
    cur = null;
    halt();
    dropClips();
    timeCbs.clear();
    stateCbs.clear();
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  return {
    play, pause, seek, setSpeed, setLoop, setMix, level, destroy,
    playing,
    onTime: (cb) => { timeCbs.add(cb); return () => timeCbs.delete(cb); },
    onState: (cb) => { stateCbs.add(cb); return () => stateCbs.delete(cb); },
  };
}

// 도구 줄(처음·재생/멈춤·끝·반복, 속도, 크기 막대)과 Space·L 키를 플레이어에 잇는다.
// 시각 표시와 타임라인 재생 위치는 호출한 쪽이 player.onTime으로 이어 준다. 닫는 함수를 돌려준다.
export function bindTransport({ player, getSelection, getDuration, seekTo }) {
  const $ = (id) => document.getElementById(id);
  const playBtn = $('tbPlay');
  const loopBtn = $('tbLoop');
  const speedBtns = [...document.querySelectorAll('#toolbar .speed button')];
  const meterFill = document.querySelector('#meter i');
  const ac = new AbortController();
  const on = (el, type, fn) => el.addEventListener(type, fn, { signal: ac.signal });
  let looping = false;
  let meterRaf = 0;
  let shown = 0;

  const toggle = () => { if (player.playing()) player.pause(); else player.play(getSelection()); };
  const toggleLoop = () => {
    looping = !looping;
    loopBtn.setAttribute('aria-pressed', String(looping));
    player.setLoop(looping);
  };

  function paintSpeed(v) {
    for (const b of speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === v));
  }

  function paintMeter() {
    meterRaf = 0;
    shown = Math.max(player.level(), shown * 0.85); // 올라갈 때는 바로, 내려갈 때는 천천히
    if (meterFill) meterFill.style.transform = `scaleX(${shown.toFixed(3)})`;
    if (player.playing() || shown > 0.004) meterRaf = requestAnimationFrame(paintMeter);
    else if (meterFill) meterFill.style.transform = 'scaleX(0)';
  }

  const offState = player.onState((isPlaying) => {
    playBtn.dataset.state = isPlaying ? 'playing' : 'stopped';
    const label = isPlaying ? '멈춤 (Space)' : '재생 (Space)';
    playBtn.title = label;
    playBtn.setAttribute('aria-label', label);
    if (!meterRaf) meterRaf = requestAnimationFrame(paintMeter);
  });

  on(playBtn, 'click', toggle);
  on($('tbHome'), 'click', () => seekTo(0));
  on($('tbEnd'), 'click', () => seekTo(getDuration()));
  on(loopBtn, 'click', toggleLoop);
  for (const b of speedBtns) {
    on(b, 'click', () => {
      const v = Number(b.dataset.speed);
      player.setSpeed(v);
      paintSpeed(v);
    });
  }
  // Space·L은 타임라인 키 처리가 건너뛰는 키라 여기서 듣는다
  on(document, 'keydown', (e) => {
    const action = actionFor(e);
    if (action !== 'play' && action !== 'loop') return;
    if (modalOpen()) return;
    e.preventDefault();
    if (action === 'play') toggle(); else toggleLoop();
  });

  playBtn.dataset.state = 'stopped';
  loopBtn.setAttribute('aria-pressed', 'false');
  paintSpeed(1);

  return () => {
    ac.abort();
    offState();
    if (meterRaf) cancelAnimationFrame(meterRaf);
    if (meterFill) meterFill.style.transform = 'scaleX(0)';
  };
}
