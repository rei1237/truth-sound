// [구간 분석] 탭: 고른 구간(초점 트랙)의 수치, 참고용 닮음 점수, 그리고 그 구간에 걸친 "녹취록에 적힌 것".
// 수치와 점수는 저장하지 않는다: 구간이 바뀌면 지우고, 화면을 닫으면 사라진다. 점수는 판정에 쓰이지 않는다.
// 계산은 서버(GET /analyze, POST /similarity)가 하고, 이 파일은 받은 값을 보여 줄 뿐이다. 줄 찾기는 editor/lanes.js.
import { h, fmt } from './dom.js';
import { speakerColor, speakerName } from '../speakers.js';
import { entriesOverlapping } from '../editor/lanes.js';
import { totalSeconds, enrollProblem, CLIP_WARN_PERCENT } from '../editor/samples.js';
import { pieceKind, GUESS_NOTE, unknownNote } from './transcript_track.js';
import { CLIP_WARNING } from './sample_track.js';

export const REF_NOTICE = '참고용 — 판정에 쓰이지 않습니다. 원본을 듣고 판단하세요.';
export const SHORT_NOTE = '짧아서 점수가 흔들립니다';
export const TOO_LONG = '10분 이하로 골라 주세요.';
export const PITCH_LONG = '60초 이하에서 보입니다';
export const NO_SOUND = '소리 없음';
export const NO_LINES = '녹취록 줄 없음';
export const LOCKED_SIM = '처리 중에는 닮음 점수를 볼 수 없습니다.';
export const MAX_SPAN = 600; // 서버 ANALYZE_MAX_SPAN과 같다
export const PITCH_SPAN = 60; // 서버 PITCH_MAX_SPAN과 같다
const WAIT_MS = 120; // 구간을 바꾸는 동안 요청이 쌓이지 않게 잠깐 기다린다

const db = (v) => (v == null ? NO_SOUND : `${v.toFixed(1)} dB`);
const hz = (v) => `${v.toFixed(1)} Hz`;
const pct = (v, d = 1) => `${v.toFixed(d)}%`;
const hzLabel = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const sameSel = (a, b) => Boolean(a) && Boolean(b) && a.start === b.start && a.end === b.end;

// 분석할 소리: 초점이 목소리 줄이면 그 트랙, 샘플·녹취록 같은 줄이면 원본. 제목의 이름도 같은 곳에서 정해 어긋나지 않게 한다.
export const analysisSource = (focus) => (focus && focus.kind === 'audio' && focus.track ? { track: focus.track, name: focus.name } : { track: 'orig', name: '원본' });
export const analysisTrack = (focus) => analysisSource(focus).track;

// 평균 주파수 분포를 작은 선 그래프로. db에 null(소리 없음)이 섞이면 그 칸은 비운다.
function drawSpectrum(canvas, sp) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#c9a45c';
  const line = cs.getPropertyValue('--line').trim() || '#2b303a';
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const vals = sp.db.filter((v) => v != null);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (const y of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, H * y); ctx.lineTo(W, H * y); ctx.stroke(); }
  if (!vals.length) return;
  const hi = Math.max(...vals);
  const lo = Math.min(...vals, hi - 12); // 너무 평평해 보이지 않게 최소 12dB 폭
  const n = sp.db.length;
  const px = (i) => (n > 1 ? (i / (n - 1)) * (W - 2) + 1 : W / 2);
  const py = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 8);
  ctx.strokeStyle = accent;
  ctx.fillStyle = `${accent}33`;
  ctx.lineWidth = 2;
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      ctx.beginPath();
      run.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.lineTo(run[run.length - 1][0], H);
      ctx.lineTo(run[0][0], H);
      ctx.fill();
    } else if (run.length === 1) {
      ctx.fillStyle = accent;
      ctx.fillRect(run[0][0] - 1.5, run[0][1] - 1.5, 3, 3);
      ctx.fillStyle = `${accent}33`;
    }
    run = [];
  };
  sp.db.forEach((v, i) => { if (v == null) flush(); else run.push([px(i), py(v)]); });
  flush();
}

// root 안에 탭 내용을 만든다.
//  api: createApi 값.  session: 사건 묶음(speakers·transcript·locked).  focus: 처음 초점 트랙 줄 {id, name, kind, track}.
//  onEntry(key): "녹취록에 적힌 것"의 줄을 눌렀을 때(녹취록 탭의 그 카드로 가게 한다).
export function createAnalysisPanel(root, { api, session, focus = null, onEntry = () => {} }) {
  const base = `/api/cases/${encodeURIComponent(session.case.id)}`;
  const empty = h('p', { class: 'hint' }, '파형에서 구간을 고르면 여기에 분석이 나옵니다.');
  const head = h('div', { class: 'ana-head' });
  const stats = h('div', { class: 'ana-stats' });
  const sim = h('section', { class: 'ana-sim' });
  const lines = h('section', { class: 'ana-lines' });
  const body = h('div', { class: 'ana-body' }, head, stats, sim);
  root.replaceChildren(h('div', { class: 'ana' }, empty, body, lines));

  let sel = null;
  let row = focus;
  let numbers = null; // {loading}|{error}|{data}
  let score = null; // null=아직 안 봄 | {loading}|{error}|{data}. 어디에도 저장하지 않는다
  let seq = 0;
  let simSeq = 0;
  let timer = null;
  const speakers = () => session.case.speakers || [];
  const entries = () => (session.transcript && session.transcript.entries) || [];
  const track = () => analysisTrack(row);
  const span = () => (sel ? sel.end - sel.start : 0);

  // ---------- 수치 ----------
  const stat = (label, ...value) => h('div', { class: 'ana-row' }, h('dt', {}, label), h('dd', {}, ...value));

  let listenMode = 'clarify';
  function clipPlayer() {
    const player = h('audio', { controls: true, preload: 'none', 'aria-label': '선택 구간 듣기' });
    const update = () => {
      const query = new URLSearchParams({ track: track(), start: sel.start, end: sel.end });
      if (listenMode !== 'plain') query.set(listenMode, 'true');
      player.src = `${base}/audio/clip?${query}`;
    };
    const mode = h('select', { 'aria-label': '청취 방식', onchange: (event) => {
      listenMode = event.target.value;
      update();
    } }, h('option', { value: 'plain' }, '보정 전'),
    h('option', { value: 'boost' }, '작은 소리 확대'),
    h('option', { value: 'clarify' }, '잡음 줄이고 말소리 듣기'));
    mode.value = listenMode;
    update();
    return [h('label', {}, '청취 보조 ', mode), player];
  }

  function paintHead() {
    head.replaceChildren(
      h('strong', {}, analysisSource(row).name), ' · ',
      h('span', { class: 'num' }, `${fmt(sel.start)} ~ ${fmt(sel.end)}`),
      ...(span() <= 30 ? clipPlayer() : [h('span', { class: 'hint' }, '청취 보조는 30초 이하 구간을 선택하세요.')]));
  }

  function pitchRows(d) {
    if (d.duration > PITCH_SPAN) return [stat('목소리 높이', PITCH_LONG)];
    if (!d.pitch) return [stat('목소리 높이', d.peak_db == null ? NO_SOUND : '높이를 잡지 못함')];
    const p = d.pitch;
    return [
      stat('목소리 높이 가운데값', h('span', { class: 'num' }, hz(p.median))),
      stat('목소리 높이 최저 · 최고', h('span', { class: 'num' }, `${hz(p.min)} · ${hz(p.max)}`)),
      stat('높이가 잡힌 비율', h('span', { class: 'num' }, pct(p.voiced_percent))),
    ];
  }

  function paintNumbers() {
    stats.replaceChildren();
    if (!numbers || numbers.loading) { stats.append(h('p', { class: 'hint' }, '계산하는 중…')); return; }
    if (numbers.error) { stats.append(h('p', { class: 'ana-err', role: 'status' }, numbers.error)); return; }
    const d = numbers.data;
    const clipped = d.clipped_percent >= CLIP_WARN_PERCENT;
    const sp = d.spectrum;
    const canvas = h('canvas', { class: 'ana-spec', width: 600, height: 120, role: 'img', 'aria-label': '평균 주파수 분포' });
    const hasSpec = sp && sp.db.some((v) => v != null);
    stats.append(
      h('dl', { class: 'ana-list' },
        stat('길이', h('span', { class: 'num' }, fmt(d.duration))),
        stat('최고 소리 크기', h('span', { class: 'num' }, db(d.peak_db))),
        stat('평균 소리 크기', h('span', { class: 'num' }, db(d.rms_db))),
        h('div', { class: `ana-row${clipped ? ' clip' : ''}` }, h('dt', {}, '잘린 비율'),
          h('dd', {}, h('span', { class: 'num' }, pct(d.clipped_percent, 2)), clipped ? h('span', { class: 'ana-clip', role: 'alert' }, ` — ${CLIP_WARNING}`) : null)),
        ...pitchRows(d),
        stat('말소리 비율', d.speech_percent == null ? '알 수 없음' : h('span', { class: 'num' }, pct(d.speech_percent)))),
      h('div', { class: 'ana-specbox' },
        h('div', { class: 'ana-spech' }, '평균 주파수 분포'),
        hasSpec ? canvas : h('p', { class: 'hint' }, NO_SOUND),
        hasSpec ? h('div', { class: 'ana-axis' }, h('span', {}, hzLabel(sp.f[0])), h('span', {}, hzLabel(sp.f[sp.f.length - 1]))) : null));
    if (hasSpec) drawSpectrum(canvas, sp);
  }

  function load() {
    clearTimeout(timer);
    const my = ++seq;
    if (!sel) return;
    if (span() > MAX_SPAN) { numbers = { error: TOO_LONG }; paintNumbers(); return; }
    numbers = { loading: true };
    paintNumbers();
    const q = `track=${encodeURIComponent(track())}&start=${sel.start}&end=${sel.end}`;
    timer = setTimeout(async () => {
      try {
        const data = await api.get(`${base}/analyze?${q}`);
        if (my === seq) numbers = { data };
      } catch (e) {
        if (my === seq) numbers = { error: e.message }; // 서버가 준 말 그대로
      }
      if (my === seq) paintNumbers();
    }, WAIT_MS);
  }

  // ---------- 닮음 점수 ----------
  function simBlock() {
    if (session.locked) return h('p', { class: 'ana-why', role: 'status' }, LOCKED_SIM);
    if (!speakers().some((s) => totalSeconds(s.enroll) > 0)) {
      return h('p', { class: 'ana-why', role: 'status' }, `목소리 샘플이 없어 닮음 점수를 볼 수 없습니다. ${enrollProblem(speakers()) || ''}`.trim());
    }
    if (score && score.data) return result(score.data);
    if (span() > MAX_SPAN) return h('p', { class: 'ana-why', role: 'status' }, TOO_LONG); // 서버가 거절할 길이는 단추를 내지 않는다
    return h('div', { class: 'ana-simact' },
      h('button', { type: 'button', class: 'ana-simbtn', disabled: Boolean(score && score.loading), onclick: askScore }, score && score.loading ? '계산하는 중…' : '닮음 점수 보기'),
      score && score.error ? h('p', { class: 'ana-err', role: 'status' }, score.error) : null);
  }

  function result(d) {
    return h('div', { class: 'ana-score' },
      d.short ? h('p', { class: 'ana-short', role: 'status' }, SHORT_NOTE) : null,
      h('ul', { class: 'ana-bars' }, d.scores.map((s) => h('li', { style: `--c:${speakerColor(speakers(), s.id)}` },
        h('span', { class: 'nm' }, s.name),
        h('span', { class: 'bar' }, h('i', { style: `width:${Math.round(Math.max(0, Math.min(1, s.score)) * 100)}%` })),
        h('span', { class: 'num' }, s.score.toFixed(2))))),
      h('p', { class: 'hint' }, `고른 구간 앞 ${d.used_seconds.toFixed(2)}초를 비교했습니다.`));
  }

  function paintSim() {
    // 참고용 안내는 점수·단추·이유 바로 위에 늘 붙어 있다
    sim.replaceChildren(h('h3', {}, '닮음 점수'), h('p', { class: 'ana-ref' }, REF_NOTICE), simBlock());
  }

  async function askScore() {
    if (!sel || session.locked) return;
    const my = ++simSeq;
    score = { loading: true };
    paintSim();
    try {
      const data = await api.post(`${base}/similarity`, { track: track(), start: sel.start, end: sel.end });
      if (my === simSeq) score = { data };
    } catch (e) {
      if (my === simSeq) score = { error: e.message };
    }
    if (my === simSeq) paintSim();
  }

  const clearScore = () => { simSeq++; score = null; };

  // ---------- 녹취록에 적힌 것 ----------
  function line(e) {
    const kind = pieceKind(e);
    const name = speakerName(speakers(), e.speaker);
    const text = (e.text || '').trim();
    const note = kind === 'guess' ? GUESS_NOTE : kind === 'unk' ? unknownNote(session.transcript && session.transcript.source) : '';
    return h('li', {}, h('button', {
      type: 'button', class: `al ${kind}${e.excluded ? ' out' : ''}`, style: `--c:${speakerColor(speakers(), e.speaker)}`,
      title: `${note ? `${note}\n` : ''}누르면 [녹취록] 탭의 이 줄로 갑니다`,
      onclick: () => onEntry(e.id),
    },
    h('span', { class: 'al-top' },
      h('span', { class: 'al-name' }, name),
      kind === 'guess' ? h('span', { class: 'al-tag' }, '(추정)') : null,
      e.excluded ? h('span', { class: 'al-tag out' }, '문서에서 뺌') : null,
      h('span', { class: 'al-time num' }, `${fmt(e.start)} ~ ${fmt(e.end)}`)),
    h('span', { class: 'al-text' }, text || '(빈 줄)')));
  }

  function paintLines() {
    if (!sel) { lines.replaceChildren(); return; }
    const found = entriesOverlapping(entries(), sel.start, sel.end);
    lines.replaceChildren(
      h('h3', {}, '녹취록에 적힌 것', found.length ? h('span', { class: 'ana-n' }, ` ${found.length}줄`) : null),
      h('p', { class: 'hint' }, '처리 결과에 적힌 화자와 글입니다. 위의 닮음 점수와는 별개입니다.'),
      found.length ? h('ul', { class: 'ana-lines-list' }, found.map(line)) : h('p', { class: 'ana-none' }, NO_LINES));
  }

  function show() {
    empty.hidden = Boolean(sel);
    body.hidden = !sel;
    lines.hidden = !sel;
    if (!sel) return;
    paintHead();
    paintSim();
    paintLines();
  }

  show();

  return {
    // 타임라인에서 구간을 고르거나 풀면. 구간이 달라지면 점수를 지우고 수치를 다시 받는다.
    setSelection(next) {
      const s = next && next.end > next.start ? { start: next.start, end: next.end } : null;
      if (sameSel(s, sel)) return;
      sel = s;
      clearScore();
      numbers = null;
      show();
      load();
    },
    // 초점 트랙이 바뀌면 다른 소리를 보는 것이라 점수도 지운다.
    setFocus(next) {
      const was = track();
      row = next;
      if (track() === was) { if (sel) paintHead(); return; }
      clearScore();
      if (!sel) return;
      numbers = null;
      show();
      load();
    },
    // 처리 잠금·녹취록 고침: 점수는 두고 안내와 줄만 다시 그린다.
    refresh() {
      if (!sel) return;
      paintSim();
      paintLines();
    },
    // 샘플이 바뀌면 지난 점수는 맞지 않는다.
    invalidateScore() {
      clearScore();
      if (sel) paintSim();
    },
    destroy() {
      clearTimeout(timer);
      seq++;
      simSeq++;
      root.replaceChildren();
    },
  };
}
