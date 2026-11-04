// 처리: [화자 분리]·[녹취록 만들기] 단추(못 누르는 이유 표시), 확인 말풍선, 처리 띠(단계 ✓ ● ○ · % · 메시지 · 걸린 시간).
// 예전 ③ 단계의 enterProcess·pollJob·renderJob을 옮긴 것이다. 단추 상태·진행률 계산은 editor/samples.js가 한다.
import { h, fmt, toast, popover } from './dom.js';
import { speakerColor, warningsOf, assignedLine } from '../speakers.js';
import { stagesFor, jobPercent, enrollAdvice, processBlock, transcribeBlock, totalSeconds, blocksEditing } from '../editor/samples.js';
import { CLIP_WARNING } from './sample_track.js';

const secText = (sec) => (sec < 0.1 ? `${(sec * 1000).toFixed(0)}ms` : `${sec.toFixed(1)}초`);
const INTERRUPTED = '지난 처리가 끝나지 못했습니다(프로그램이 닫혔을 수 있습니다). 다시 시작할 수 있습니다.';
const STALE = '처리 결과를 불러오지 못한 낡은 화면입니다. 녹음을 다시 열어 주세요.';
const OTHER_BUSY = '다른 녹음을 처리하는 중입니다. 그 처리가 끝난 뒤 시작할 수 있습니다.';

// button·transcribeButton·why·strip은 index.html의 #processBtn·#transcribeBtn·#processWhy·#procstrip.
// job은 열 때 읽은 /api/jobs/current(못 읽었으면 null). onLock()은 잠금이 바뀌었으니 화면을 다시 그리라는 뜻,
// onFinished(job)은 처리가 잘 끝났을 때(사건을 다시 읽어 줄을 새로 만드는 일은 부른 쪽이 한다). 약속(Promise)을 돌려줘도 되고,
// 다시 읽지 못했으면 이유 글을 돌려주거나 던진다(그러면 잠금을 풀고 띠에 알린다). 잘 읽었으면 null.
export function createProcessPanel({ session, api, button, transcribeButton = null, why, strip, job = null, clip = null, onLock = () => {}, onFinished = () => {} }) {
  const id = session.case.id;
  const mine = (j) => Boolean(j) && j.case_id === id && blocksEditing(j.kind); // 선명화(clarify)는 따라가지 않는다
  let current = job;
  let interrupted = session.case.status === 'processing' && !(mine(job) && job.state === 'running');
  let failure = null; // 시작하지 못한 이유(서버가 준 글 그대로)
  let reloadFailed = false; // 처리는 끝났는데 결과를 다시 읽지 못했다: 이 화면은 낡았다
  let pollError = null; // 따라가다 서버를 못 읽은 이유
  let seenAt = null;
  let timer = null;
  let starting = false;
  let destroyed = false;
  let closePop = null;
  let popKind = null; // 열려 있는 말풍선이 어느 단추 것인가('process' | 'transcribe')
  let popBox = null; // 열려 있는 말풍선 내용. popover가 Esc·바깥 누르기로 스스로 닫아도 isConnected로 안다

  const running = () => Boolean(current) && current.state === 'running' && mine(current);
  const hasTracks = () => Object.keys((session.case.processing && session.case.processing.tracks) || {}).length > 0;
  const block = (kind = 'process') => {
    if (reloadFailed) return STALE;
    return kind === 'transcribe' ? transcribeBlock({ job: current, caseId: id }) : processBlock({ speakers: session.case.speakers, job: current, caseId: id });
  };

  function paintButton() {
    const reason = block();
    button.disabled = false;
    button.textContent = hasTracks() ? '다시 처리' : '화자 분리';
    button.classList.toggle('blocked', Boolean(reason));
    button.setAttribute('aria-disabled', String(Boolean(reason)));
    why.textContent = reason || '';
    why.hidden = !reason;
    if (transcribeButton) {
      const why2 = block('transcribe');
      transcribeButton.disabled = false;
      transcribeButton.classList.toggle('blocked', Boolean(why2));
      transcribeButton.setAttribute('aria-disabled', String(Boolean(why2)));
      transcribeButton.title = why2 || '';
    }
  }

  function stagesList(j) {
    const stages = stagesFor(j.kind, j.step);
    const idx = stages.findIndex(([n]) => n === j.stage);
    return h('ul', { class: 'ps-stages' }, stages.map(([n], i) => {
      const st = i < idx ? 'done' : i === idx && j.state === 'running' ? 'now' : '';
      return h('li', { class: st },
        h('span', { class: 'mark' }, st === 'done' ? '✓' : st === 'now' ? '●' : '○'), n,
        st === 'now' ? h('span', { class: 'pct' }, `${Math.round(j.progress * 100)}%`) : null);
    }));
  }

  function paintStrip() {
    const rows = [];
    if (running()) {
      const pct = jobPercent(current);
      const elapsed = seenAt ? ` · 걸린 시간 ${fmt((Date.now() - seenAt) / 1000)}` : '';
      rows.push(
        h('div', { class: 'ps-run' },
          stagesList(current),
          h('span', { class: 'ps-pct' }, `${Math.round(pct)}%`),
          h('span', { class: 'ps-msg' }, `${pollError || current.message}${elapsed}`)),
        h('div', { class: 'ps-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) },
          h('i', { style: `width:${pct}%` })));
    } else {
      if (mine(current) && current.state === 'error') rows.push(h('p', { class: 'ps-note err' }, `처리하지 못했습니다: ${current.message}`));
      if (failure) rows.push(h('p', { class: 'ps-note err' }, failure));
      if (current && current.state === 'running') rows.push(h('p', { class: 'ps-note' }, OTHER_BUSY));
      if (interrupted) rows.push(h('p', { class: 'ps-note' }, INTERRUPTED));
    }
    strip.hidden = rows.length === 0;
    strip.replaceChildren(...rows);
  }

  function paint() { paintButton(); paintStrip(); }

  // ---- 확인 말풍선 ----
  function dismiss() {
    if (closePop) closePop();
    closePop = null;
    popBox = null;
    popKind = null;
  }

  function confirmBox() {
    const again = hasTracks();
    const list = session.case.speakers || [];
    const chosen = list.filter((s) => (s.enroll || []).length);
    const advice = enrollAdvice(list);
    const clipped = clip && chosen.some((s) => s.enroll.some((r) => clip.isClipped(r)));
    const prev = again ? warningsOf(session.case.processing) : [];
    const line = again ? assignedLine(session.case.processing) : '';
    return h('div', { class: 'ps-pop' },
      h('b', {}, again ? '다시 처리할까요?' : '화자 분리를 시작할까요?'),
      h('ul', { class: 'ps-who' }, chosen.map((s) => h('li', { style: `--c:${speakerColor(list, s.id)}` },
        h('i'), h('span', { class: 'nm' }, s.name), h('span', { class: 'len' }, `샘플 ${secText(totalSeconds(s.enroll))}`)))),
      advice ? h('p', { class: 'warn' }, advice) : null,
      clipped ? h('p', { class: 'warn' }, CLIP_WARNING) : null,
      prev.length ? h('p', { class: 'hint' }, '지난 처리에서 나온 경고') : null,
      prev.map((w) => h('p', { class: 'warn' }, w)),
      line ? h('p', { class: 'hint' }, line) : null,
      h('p', { class: 'hint' }, '처음 한 번은 AI 모델 약 3.5GB를 내려받습니다. 처리에는 몇 분 이상 걸릴 수 있습니다.'),
      session.case.has_transcript ? h('p', { class: 'warn' }, '지금 녹취록과 고친 내용이 새 결과로 바뀝니다.') : null,
      h('div', { class: 'ps-actions' },
        h('button', { type: 'button', class: 'pri', onclick: () => { dismiss(); start('process'); } }, '시작'),
        h('button', { type: 'button', onclick: dismiss }, '취소')));
  }

  // 샘플 없이 원본에서 바로 받아쓰는 [녹취록 만들기]의 확인 말풍선. 이미 있는 트랙은 건드리지 않는다.
  function transcribeBox() {
    return h('div', { class: 'ps-pop' },
      h('b', {}, '녹취록을 만들까요?'),
      h('p', { class: 'hint' }, '원본 녹음에서 바로 받아씁니다. 샘플을 몇 명 지정했는지와 관계없이 사람별 화자 분리는 하지 않습니다.'),
      h('p', { class: 'warn' }, '겹쳐 말한 곳은 화자 분리를 했을 때보다 더 틀리거나 빠질 수 있습니다.'),
      h('p', { class: 'hint' }, '처음 한 번은 받아쓰기 모델 약 3GB를 내려받습니다.'),
      session.case.has_transcript ? h('p', { class: 'warn' }, '지금 녹취록과 고친 내용이 새 결과로 바뀝니다. 이전 녹취록은 보관됩니다.') : null,
      hasTracks() ? h('p', { class: 'hint' }, '분리한 트랙은 그대로 둡니다.') : null,
      h('div', { class: 'ps-actions' },
        h('button', { type: 'button', class: 'pri', onclick: () => { dismiss(); start('transcribe'); } }, '시작'),
        h('button', { type: 'button', onclick: dismiss }, '취소')));
  }

  function onClick(kind, anchor) {
    if (closePop && popBox && popBox.isConnected && popKind === kind) { dismiss(); return; }
    dismiss(); // 스스로 닫힌 낡은 말풍선 정보를 비우고, 다른 단추의 말풍선이 열려 있었다면 닫는다
    const reason = block(kind);
    if (reason) { toast(reason, true); return; }
    const box = kind === 'transcribe' ? transcribeBox() : confirmBox();
    closePop = popover(anchor, box);
    popBox = box;
    popKind = kind;
    // 단추가 오른쪽 끝에 있어서 말풍선은 단추의 오른쪽 끝에 맞춘다
    if (box.parentElement) box.parentElement.style.left = `${Math.max(8, anchor.getBoundingClientRect().right - 378)}px`;
    const go = box.querySelector('.pri');
    if (go) go.focus();
  }

  // ---- 시작과 따라가기 ----
  async function start(kind) {
    if (starting || block(kind)) return;
    starting = true;
    failure = null;
    session.setLocked(true); // 보내는 동안 샘플을 바꾸지 못하게 먼저 잠근다
    onLock();
    try {
      if (!(await session.flush())) throw new Error('검수 내용을 저장하지 못해 처리를 시작하지 않았습니다.');
      const started = await api.post(`/api/cases/${encodeURIComponent(id)}/${kind === 'transcribe' ? 'transcribe' : 'process'}`);
      if (destroyed) return;
      current = started;
      interrupted = false;
      seenAt = Date.now();
      follow();
      paint();
    } catch (e) {
      if (destroyed) return;
      session.setLocked(false);
      onLock();
      failure = e.message;
      toast(e.message, true);
      paint();
    } finally {
      starting = false;
    }
  }

  function follow() {
    if (timer) return;
    if (!seenAt) seenAt = Date.now();
    timer = setInterval(tick, 1000);
    tick();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  async function tick() {
    let j;
    try {
      j = await api.get('/api/jobs/current');
      pollError = null;
    } catch (e) {
      pollError = e.message; // 서버가 잠깐 못 받아도 계속 따라간다
      if (!destroyed) paintStrip();
      return;
    }
    if (destroyed) return;
    if (!mine(j) || j.state === 'idle') {
      // 서버가 다시 켜졌거나 다른 작업이 들어왔다: 따라갈 작업이 없다
      stop();
      current = j;
      interrupted = true;
      session.setLocked(false);
      onLock();
      paint();
      return;
    }
    current = j;
    paint();
    if (j.state === 'running') return;
    stop();
    if (j.state === 'done') {
      toast(j.kind === 'transcribe' ? '녹취록을 만들었습니다. 검수하세요.' : '처리가 끝났습니다. 녹취록을 검수하세요.');
      let failed = null;
      try { failed = await onFinished(j); } catch (e) { failed = e.message || '알 수 없는 오류'; }
      if (destroyed || failed == null) return;
      // 결과를 다시 읽지 못했다: 낡은 화면이 잠긴 채 남지 않게 풀고, 사라지지 않는 띠에 알린다
      session.setLocked(false);
      onLock();
      reloadFailed = true;
      failure = `처리는 끝났지만 결과를 불러오지 못했습니다: ${failed} 녹음을 다시 열어 주세요.`;
      paint();
    } else {
      session.setLocked(false);
      onLock();
      toast(`처리하지 못했습니다: ${j.message}`, true);
      paint();
    }
  }

  const onProcess = () => onClick('process', button);
  const onTranscribe = () => onClick('transcribe', transcribeButton);
  button.addEventListener('click', onProcess);
  if (transcribeButton) transcribeButton.addEventListener('click', onTranscribe);
  if (running()) { session.setLocked(true); follow(); }
  paint();

  return {
    reloadFailed: () => reloadFailed,
    refresh: paint, // 샘플이 바뀌면 단추 옆 이유도 바뀐다
    destroy() {
      destroyed = true;
      stop();
      dismiss();
      button.removeEventListener('click', onProcess);
      button.disabled = true;
      button.classList.remove('blocked');
      button.textContent = '화자 분리';
      if (transcribeButton) {
        transcribeButton.removeEventListener('click', onTranscribe);
        transcribeButton.disabled = true;
        transcribeButton.classList.remove('blocked');
        transcribeButton.title = '';
      }
      why.textContent = '';
      why.hidden = true;
      strip.hidden = true;
      strip.replaceChildren();
    },
  };
}
