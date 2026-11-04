// 녹음 넣기: 올리기 → 확인 카드. 빈 화면이든 편집 화면이든 같은 카드가 위에 뜬다.
// 빈 화면에서는 주소(#/?card=<id>)가 카드를 기억하고, 편집 중에는 주소를 건드리지 않아 열린 사건이 그대로 남는다.
import { h, fmt, toast } from './dom.js';
import { checkFile } from '../editor/drop.js';
import { caseHash, cardHash } from '../editor/routes.js';
import { freshMarks } from '../editor/fresh.js';

let deps = null; // { api, isEditing(), pick() }
let cur = null; // 지금 떠 있는 카드의 상태. 없으면 null

// 카드가 치울 수 있는 사건은 이 탭에서 방금 올려 만든(아직 시작하지 않은) 것뿐이다.
// 표시는 지울 때마다 다시 확인한다(주소 처리 쪽에서 사건이 열려 표시가 풀렸을 수 있다).
const marks = freshMarks;

export function initAttach(d) { deps = d; }

const SAME_KEY = (id) => `truthsound.same.${id}`;
const layer = () => document.getElementById('overlay') || document.body;

// 같은 녹음 목록은 올릴 때만 서버가 알려 준다. 카드에서 새로고침해도 알림이 남게 탭에만 적어 둔다.
function rememberSame(id, same) {
  try { sessionStorage.setItem(SAME_KEY(id), JSON.stringify(same)); } catch { /* 저장소를 못 쓰면 이번만 */ }
}
function recallSame(id) {
  try {
    const v = JSON.parse(sessionStorage.getItem(SAME_KEY(id)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fmtPct = (v) => `${Math.round(v * 10) / 10}`;

// probe.format은 "mov,mp4,m4a,3gp,3g2,mj2"처럼 후보가 줄줄이 온다. 파일 확장자와 겹치는 것을, 없으면 첫 번째를 보인다.
function containerName(format, name) {
  const toks = String(format || '').split(',').map((s) => s.trim()).filter(Boolean);
  const dot = String(name || '').lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return (toks.includes(ext) ? ext : toks[0] || '').toUpperCase();
}

function formatLine(o) {
  const p = o.probe || {};
  const ch = p.channels === 1 ? '모노' : p.channels === 2 ? '스테레오' : p.channels ? `${p.channels}채널` : '';
  const hz = p.sample_rate ? `${(p.sample_rate / 1000).toFixed(1)} kHz` : '';
  return [String(p.codec || '').toUpperCase(), ch, hz, containerName(p.format, o.name)].filter(Boolean).join(' · ');
}

// 고정된 SVG 조각만 쓴다(파일 이름·서버 글은 여기에 들어오지 않는다).
const PATHS = {
  note: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  err: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/>',
};
function svg(viewBox, size, inner, stroke) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  if (stroke) {
    for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  } else {
    s.setAttribute('fill', 'currentColor');
  }
  s.innerHTML = inner;
  return s;
}
const icon = (name, size = 16) => svg('0 0 24 24', size, PATHS[name], true);
const playIcon = (playing) => svg('0 0 16 16', 14, playing ? '<path d="M4 3h3v10H4zM9 3h3v10H9z"/>' : '<path d="M4.5 2.5v11L13.5 8z"/>', false);

// ---------- 카드 뼈대 ----------
function mount(st) {
  const card = h('div', { class: 'attach-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '녹음 확인' });
  st.card = card;
  st.wrap = h('div', { class: 'attach-wrap' }, card);
  layer().append(st.wrap);
}

function head(name, sub) {
  return h('div', { class: 'at-head' },
    h('div', { class: 'at-tile' }, icon('note', 20)),
    h('div', { class: 'at-title' },
      h('span', { class: 'at-eyebrow' }, '녹음 확인'),
      h('b', { title: name }, name),
      sub ? h('span', { class: 'at-sub' }, sub) : null));
}

function setView(st, ...parts) { st.card.replaceChildren(...parts.flat()); }

// 미리 듣기 스트림을 놓는다. Windows에서는 listen.wav를 브라우저가 읽는 중이면 사건 폴더를 옮길 수 없어서
// (치우기 DELETE가 실패한다) 치우기 전에 먼저 부른다.
function releaseAudio(st) {
  const a = st.audio;
  if (!a) return;
  a.pause();
  a.removeAttribute('src');
  a.load();
}

// 앞 카드에서 쓰지 않고 남은 사건(새 올리기가 끝나기를 기다리던 것)을 치운다. 한 번만.
function retire(st) {
  const id = st.retireId;
  if (!id) return;
  st.retireId = null;
  const still = marks().has(id);
  marks().clear(id);
  if (still) deps.api.del(`/api/cases/${id}`).catch(() => {});
}

export function closeAttach() {
  if (!cur) return;
  const st = cur;
  cur = null;
  if (st.xhr) {
    if (st.sent) {
      // 다 올라간 뒤에는 서버가 이미 사건을 만들고 있을 수 있다. 끊지 않고 끝까지 받은 뒤 치운다.
      st.cancelled = true;
    } else {
      st.xhr.onload = null;
      st.xhr.onerror = null;
      st.xhr.abort();
    }
  }
  releaseAudio(st); // 이 카드의 사건은 곧(새 올리기가 끝난 뒤) 치워질 수 있다. 스트림을 먼저 놓는다.
  retire(st);
  if (st.raf) cancelAnimationFrame(st.raf);
  st.wrap.remove();
}

// ---------- 올리는 중 ----------
function uploadingView(st) {
  const bar = h('i');
  const pct = h('span', { class: 'at-pct' }, '0%');
  const msg = h('span', {}, '올리는 중…');
  const track = h('div', { class: 'at-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bar);
  st.ui = { bar, pct, msg, track };
  setView(st,
    head(st.name, st.size != null ? fmtSize(st.size) : ''),
    h('div', { class: 'at-body' }, track, h('div', { class: 'at-progline' }, msg, pct)),
    h('div', { class: 'at-foot' },
      h('button', { type: 'button', onclick: () => { closeAttach(); } }, '취소')));
}

function setProgress(st, loaded, total) {
  const f = total ? Math.min(1, loaded / total) : 0;
  st.ui.bar.style.width = `${f * 100}%`;
  if (f >= 1) {
    st.sent = true;
    // 다 올라간 뒤 서버가 원본을 보관하고 지문을 계산한다. 얼마나 걸릴지 모르니 끝을 모르는 막대로 바꾼다.
    st.ui.track.classList.add('busy');
    st.ui.track.removeAttribute('aria-valuenow');
    st.ui.msg.textContent = '원본을 보관하고 지문(SHA-256)을 계산하는 중…';
    st.ui.pct.textContent = '';
  } else {
    st.ui.track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    st.ui.pct.textContent = `${Math.round(f * 100)}%`;
  }
}

// ---------- 오류 ----------
function errorView(st, message) {
  st.phase = 'error';
  if (st.xhr) { st.xhr = null; }
  // 사건은 만들어졌는데 카드를 못 채운 경우(방금 올린 것만) 남기지 않고 바로 치운다.
  if (st.id && st.fresh) {
    st.fresh = false;
    const still = marks().has(st.id);
    marks().clear(st.id);
    if (still) releaseAudio(st);
    if (still) deps.api.del(`/api/cases/${st.id}`).catch(() => {});
  }
  const pick = h('button', { type: 'button', class: 'pri', onclick: () => {
    deps.pick(); // 파일 창은 누르는 순간에만 열 수 있다
    discardOnly(st);
  } }, '다른 파일 고르기');
  setView(st,
    head(st.name || '녹음 파일', st.size != null ? fmtSize(st.size) : ''),
    h('div', { class: 'at-body' },
      h('div', { class: 'at-warn at-err', role: 'alert' }, icon('err', 16), h('span', {}, message))),
    h('div', { class: 'at-foot' }, pick));
  pick.focus();
}

// 카드를 닫고, 빈 화면이면 주소도 처음으로. 사건을 만들지 않았거나 이미 치웠을 때 쓴다.
function discardOnly(st) {
  if (cur !== st) return;
  closeAttach();
  if (st.mode === 'route' && location.hash !== '#/') location.hash = '#/';
}

// ---------- 확인 카드 ----------
// 미리보기라 가장 큰 소리가 높이를 채우게 맞춘다. 잘린 칸은 빨갛게.
function drawWave(canvas, pk) {
  const c = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const mid = H / 2;
  const n = pk.min.length;
  let top = 0;
  for (let i = 0; i < n; i += 1) top = Math.max(top, Math.abs(pk.min[i]), Math.abs(pk.max[i]));
  const amp = (mid - 6) / Math.max(top, 0.02);
  const bw = W / n;
  const cs = getComputedStyle(document.documentElement);
  const ink = cs.getPropertyValue('--c-orig').trim() || '#aeb6c4';
  const clip = cs.getPropertyValue('--clip').trim() || '#ff4d4f';
  c.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i += 1) {
    const y0 = mid - pk.max[i] * amp;
    const y1 = mid - pk.min[i] * amp;
    c.fillStyle = pk.clip && pk.clip[i] ? clip : ink;
    c.fillRect(i * bw, y0, Math.max(1, bw - 0.6), Math.max(2, y1 - y0));
  }
}

function playerBox(st, duration) {
  const play = h('button', { type: 'button', class: 'at-play', 'aria-label': '듣기', title: '듣기' }, playIcon(false), h('span', {}, '듣기'));
  const line = h('i', { class: 'at-playhead' });
  const box = h('div', { class: 'at-wave', title: '눌러서 그 위치부터 듣기' }, line);
  if (st.peaks && st.peaks.min && st.peaks.min.length) {
    const canvas = h('canvas', { width: '1200', height: '152', 'aria-hidden': 'true' });
    box.prepend(canvas);
    drawWave(canvas, st.peaks);
  } else {
    box.prepend(h('span', { class: 'at-nowave' }, '파형을 불러오지 못했습니다'));
  }

  const audio = new Audio(`/api/cases/${st.id}/audio/listen`);
  audio.preload = 'none';
  st.audio = audio;
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration || 0);
  const tick = () => {
    line.style.left = `${total() ? Math.min(100, (audio.currentTime / total()) * 100) : 0}%`;
    if (!audio.paused) st.raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    play.replaceChildren(playIcon(!audio.paused), h('span', {}, audio.paused ? '듣기' : '멈춤'));
    play.setAttribute('aria-label', audio.paused ? '듣기' : '멈춤');
    box.classList.toggle('playing', !audio.paused);
    tick();
  };
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', () => { audio.currentTime = 0; sync(); });
  audio.addEventListener('error', () => { toast('미리 들을 수 없습니다.', true); sync(); });
  play.addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
  box.addEventListener('click', (e) => {
    const r = box.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const go = () => { audio.currentTime = t * total(); audio.play().catch(() => {}); };
    if (audio.readyState === 0) { audio.addEventListener('loadedmetadata', go, { once: true }); audio.load(); } else go();
  });
  return h('div', { class: 'at-player' }, box, play);
}

// 방금 만든 사건을 치운다(지우지 않고 removed로 옮겨진다). 못 치웠으면 이유를 알리고 false.
// 이 탭에서 방금 올린 사건이 아니면(주소로 다시 뜬 카드 등) 건드리지 않고 true로 넘어간다.
async function discardCase(st) {
  if (!st.fresh || !marks().has(st.id)) return true;
  releaseAudio(st);
  try {
    await deps.api.del(`/api/cases/${st.id}`);
    marks().clear(st.id);
    return true;
  } catch (e) {
    toast(e.status === 409 ? '이미 처리를 시작한 녹음이라 치울 수 없습니다.' : e.message, true);
    return false;
  }
}

function readyView(st) {
  const o = st.case.original || {};
  const p = o.probe || {};
  const sha = o.sha256 || '';
  const clipped = Number(o.clipped_percent) || 0;
  let busy = false;

  const copy = h('button', { type: 'button', class: 'at-copy', title: 'SHA-256 전체를 복사' }, icon('copy', 12), h('span', {}, '복사'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sha);
      copy.lastChild.textContent = '복사됨';
      setTimeout(() => { copy.lastChild.textContent = '복사'; }, 1600);
    } catch { toast('복사하지 못했습니다. 브라우저가 클립보드를 막고 있습니다.', true); }
  });

  // 같은 녹음 알림은 방금 올린 사건에만 의미가 있다(이미 시작한 사건의 카드에는 띄우지 않는다).
  const sameBox = st.fresh && st.same.length
    ? h('div', { class: 'at-same', role: 'status' },
      h('span', {}, h('b', {}, '이미 연 녹음입니다'), ' — 같은 원본(SHA-256이 같음)이 이미 있습니다.'),
      h('span', { class: 'acts' },
        h('button', { type: 'button', onclick: async () => {
          if (busy) return;
          busy = true;
          // 방금 만든 사건은 치우고 예전 사건을 연다
          if (await discardCase(st)) {
            const prev = st.same[0];
            closeAttach();
            location.hash = caseHash(prev);
          } else busy = false;
        } }, '그 녹음 열기'),
        h('button', { type: 'button', onclick: () => sameBox.remove() }, '새로 계속')))
    : null;

  const auto = st.fresh && !st.case.has_transcript && st.case.status === 'new';
  const go = h('button', { type: 'button', class: 'pri', onclick: async () => {
    if (busy) return;
    busy = true;
    if (auto) {
      try { await deps.api.post(`/api/cases/${encodeURIComponent(st.id)}/transcribe`); }
      catch (e) { busy = false; toast(`녹취록을 시작하지 못했습니다. ${e.message}`, true); return; }
      if (cur !== st) return;
    }
    marks().clear(st.id); // 시작한 사건은 더 이상 카드가 치울 수 없다
    closeAttach();
    location.hash = caseHash(st.id);
  } }, auto ? '녹취록 작성 시작' : '이 녹음으로 시작');
  const other = h('button', { type: 'button', onclick: async () => {
    if (busy) return;
    busy = true;
    if (await discardCase(st)) discardOnly(st); else busy = false;
  } }, '다른 파일');

  setView(st,
    head(o.name || st.name || '녹음 파일', o.size != null ? fmtSize(o.size) : ''),
    h('div', { class: 'at-body' },
      playerBox(st, p.duration),
      h('dl', { class: 'at-kv' },
        h('dt', {}, '길이'), h('dd', { class: 'mono' }, p.duration == null ? '—' : fmt(p.duration)),
        h('dt', {}, '형식'), h('dd', {}, formatLine(o) || '—')),
      h('div', { class: 'at-seal' },
        h('span', { class: 'at-check' }, h('b', {}, 'SHA-256'), ' ✓ 보관됨'),
        h('code', { title: sha }, sha.slice(0, 12)),
        copy),
      h('p', { class: 'at-note' }, icon('lock', 12), '원본은 읽기 전용으로 따로 보관되어 바뀌지 않습니다.'),
      clipped >= 1
        ? h('div', { class: 'at-warn', role: 'alert' }, icon('warn', 16),
          h('span', {}, `소리가 잘린 곳이 ${fmtPct(clipped)}% 있습니다. 증폭하기 전 원본이 있으면 그 파일을 쓰세요.`))
        : null,
      sameBox),
    h('div', { class: 'at-foot' }, other, go));
  go.focus();
}

// ---------- 흐름 ----------
// 사건이 만들어진 뒤: 사건·파형을 읽어 카드를 채운다.
async function loadReady(st) {
  const pkP = deps.api.get(`/api/cases/${st.id}/peaks?track=orig&n=600`).catch(() => null);
  let c;
  try {
    c = await deps.api.get(`/api/cases/${st.id}`);
  } catch (e) {
    // 파형을 읽는 요청이 끝나기 전에 사건을 치우면 윈도우가 폴더를 못 옮긴다(파일이 열려 있음). 끝난 뒤에 알린다.
    await pkP;
    throw e;
  }
  const pk = await pkP;
  if (cur !== st) return;
  st.case = c;
  st.peaks = pk;
  st.phase = 'ready';
  readyView(st);
}

// 주소의 카드 번호로 카드를 띄운다(새로고침·뒤로 가기). 이미 그 카드면 그대로 둔다.
export async function showCard(id) {
  if (cur && cur.id === id) return;
  closeAttach();
  const st = { mode: 'route', id, name: '', same: recallSame(id), phase: 'loading', fresh: marks().has(id) };
  cur = st;
  mount(st);
  setView(st, head('불러오는 중…'), h('div', { class: 'at-body' }, h('div', { class: 'at-bar busy' }, h('i'))));
  try {
    await loadReady(st);
  } catch (e) {
    if (cur === st) errorView(st, e.status === 404 ? '이 녹음을 찾을 수 없습니다. 이미 치웠거나 지워졌습니다.' : e.message);
  }
}

// 주소가 카드를 가리키지 않게 되면(뒤로 가기 등) 빈 화면 쪽 카드를 닫는다. 편집 중에 띄운 카드는 주소와 무관하다.
export function syncAttach(cardId) {
  if (cardId) { showCard(cardId); return; }
  if (cur && cur.mode === 'route') closeAttach();
}

export function startAttach(file) {
  if (cur && cur.phase === 'uploading') { toast('지금 올리는 중입니다. 끝나면 다음 파일을 넣어 주세요.', true); return; }
  // 확인 중이던 카드의 사건이 방금 올린 것(시작 전)이면 새 올리기가 끝난 뒤 치운다(removed로 옮겨진다).
  // 올리기 전에 치우면 같은 파일을 또 넣었을 때 서버가 "같은 녹음"을 알아보지 못한다.
  const retireId = cur && cur.fresh && cur.id && cur.phase === 'ready' && marks().has(cur.id) ? cur.id : null;
  closeAttach();

  const st = { mode: deps.isEditing() ? 'modal' : 'route', name: file.name, size: file.size, same: [], phase: 'uploading', id: null, fresh: false, retireId };
  cur = st;
  mount(st);
  const bad = checkFile(file.name, file.type);
  if (bad) { errorView(st, bad); return; }
  uploadingView(st);

  const fd = new FormData();
  fd.append('file', file, file.name);
  if (file.lastModified) fd.append('client_mtime', String(file.lastModified / 1000));
  const xhr = new XMLHttpRequest();
  st.xhr = xhr;
  xhr.open('POST', '/api/cases');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(st, e.loaded, e.total); };
  xhr.onload = () => {
    st.xhr = null;
    let d = {};
    try { d = JSON.parse(xhr.responseText); } catch { /* 본문 없음 */ }
    if (st.cancelled) {
      // 사용자가 다 올라간 뒤에 취소했다: 서버가 만든 사건은 쓰지 않고 치운다.
      if (d.id) deps.api.del(`/api/cases/${d.id}`).catch(() => {});
      return;
    }
    if (xhr.status !== 200 || !d.id) { retire(st); errorView(st, d.detail || `올리기 실패 (${xhr.status})`); return; }
    st.id = d.id;
    st.fresh = true;
    marks().mark(d.id);
    // 앞 카드의 쓰지 않은 사건은 이제 치우고, 같은 녹음 목록에서도 뺀다(곧 사라질 사건이므로).
    st.same = (d.same || []).filter((i) => i !== st.retireId);
    retire(st);
    rememberSame(d.id, st.same);
    // 빈 화면에서는 주소에 카드를 적어 새로고침해도 남게 한다. 뒤로 가면 처음 화면으로 돌아온다.
    if (st.mode === 'route') history.pushState(null, '', cardHash(d.id));
    loadReady(st).catch((e) => { if (cur === st) errorView(st, e.message); });
  };
  xhr.onerror = () => { if (st.cancelled) return; retire(st); errorView(st, '서버에 연결할 수 없습니다. Truth Sound 창이 켜져 있는지 확인하세요.'); };
  xhr.send(fd);
}
