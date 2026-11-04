// [샘플] 탭: 사람 카드(이름 고치기, 구간 목록 ▶ 듣기 · ✕ 지우기 · 누르면 그 구간 선택, 총 길이, 조언), 처리 준비 검사, 저장 표시.
// 예전 ② 단계의 카드 동작을 새 화면 모양으로 옮긴 것이다. 구간을 만들거나 고치는 계산은 editor/samples.js가 한다.
import { h, fmt } from './dom.js';
import { speakerColor } from '../speakers.js';
import { MIN_ENROLL, GOOD_ENROLL, isTiny, totalSeconds, enrollProblem, enrollAdvice } from '../editor/samples.js';
import { removeSample, assignSelection, LOCKED_REASON, CLIP_WARNING } from './sample_track.js';

const pad = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const secText = (sec) => (sec < 0.1 ? `${(sec * 1000).toFixed(0)}ms` : `${sec.toFixed(1)}초`);

// 한 사람의 길이 줄: 없음 / 0.2초 미만 / 2초 미만 / 충분
function summary(sec) {
  if (!(sec > 0)) return '지정 안 함 — 이 사람은 처리하지 않습니다';
  return `목소리 샘플 ${secText(sec)}${sec < MIN_ENROLL ? ` — ${MIN_ENROLL}초 이상 필요` : sec < GOOD_ENROLL ? ' — 짧아서 사람이 뒤바뀔 수 있음' : ''}`;
}

// root 안에 탭 내용을 만든다. select(range)는 그 구간을 타임라인에서 고르고, play(range)는 그 구간을 듣는다.
export function createSamplesPanel(root, { session, clip, select, play, getSelection, onChange = () => {} }) {
  const lock = h('p', { class: 'smp-lock', role: 'status' }, LOCKED_REASON);
  const intro = h('p', { class: 'hint' }, '파형에서 구간을 고른 뒤 숫자 1·2·3 키를 누르면 그 사람의 목소리 샘플이 됩니다. 아주 짧은 소리도 그대로 쓰입니다.');
  const cards = h('div', { class: 'smp-cards' });
  const msg = h('p', { class: 'smp-msg', role: 'status' });
  const saved = h('p', { class: 'smp-saved', 'aria-live': 'polite' });
  root.replaceChildren(h('div', { class: 'smp' }, lock, intro, cards, msg, saved));

  let chips = []; // 잘린 소리 표시를 다시 그리지 않고 고치기 위해 목록 줄마다 둔다
  const speakers = () => session.case.speakers || [];
  const changed = () => { onChange(); render(); };
  const unsub = clip.subscribe(() => paintClips());

  function paintClips() {
    for (const { range, el } of chips) {
      const on = clip.isClipped(range);
      el.hidden = !on;
      if (on) el.textContent = `잘린 소리 ${clip.percent(range).toFixed(1)}%`;
    }
  }

  // 처리 준비 검사: 문제면 warn, 조언이면 info, 괜찮으면 ok
  function paintCheck() {
    const p = enrollProblem(speakers());
    const a = !p && enrollAdvice(speakers());
    msg.className = `smp-msg ${p ? 'warn' : a ? 'info' : 'ok'}`;
    msg.textContent = p || a || '준비되었습니다. 위쪽 [화자 분리]로 처리를 시작할 수 있습니다.';
  }

  function rename(s, input) {
    const name = input.value.trim();
    input.classList.toggle('bad', !name);
    if (!name) return; // 빈 이름은 저장하지 않는다(서버도 받지 않는다). 칸을 벗어나면 원래 이름으로 돌아간다.
    session.setSpeakers(speakers().map((x) => (x.id === s.id ? { ...x, name: input.value } : x)));
    paintCheck();
    onChange();
  }

  function card(s, i) {
    const list = speakers();
    const ranges = s.enroll || [];
    const sec = totalSeconds(ranges);
    const lockedNow = session.locked;
    const name = h('input', { type: 'text', value: s.name, maxlength: 40, 'aria-label': `${i + 1}번째 사람 이름`, disabled: lockedNow });
    name.addEventListener('input', () => { try { rename(s, name); } catch (e) { name.classList.add('bad'); } });
    name.addEventListener('blur', () => { if (!name.value.trim()) { name.value = s.name; name.classList.remove('bad'); } });
    return h('div', { class: 'spk', style: `--c:${speakerColor(list, s.id)}` },
      h('div', { class: 'name' }, h('span', { class: 'dot' }), name, h('kbd', { title: `숫자 ${i + 1} 키로 고른 구간을 지정` }, String(i + 1))),
      h('div', { class: `sum${sec > 0 && sec < GOOD_ENROLL ? ' low' : ''}` }, summary(sec)),
      h('ul', {}, ranges.map((r, k) => {
        const chip = h('span', { class: 'chip clip', title: CLIP_WARNING, hidden: !clip.isClipped(r) }, '잘린 소리');
        chips.push({ range: r, el: chip });
        return h('li', {},
          h('button', {
            type: 'button', class: 'rng', title: '누르면 파형에서 이 구간을 고릅니다', onclick: () => select(r),
          }, h('span', { class: 'num' }, `${fmt(r[0])} ~ ${fmt(r[1])}`),
          h('span', { class: 'len' }, secText(r[1] - r[0]))),
          isTiny(r) ? h('span', { class: 'chip tiny', title: '0.05초보다 짧은 구간입니다. 그대로 쓰이지만 판정 근거로는 약합니다.' }, '너무 짧은 구간') : null,
          chip,
          h('button', { type: 'button', class: 'sm', title: '이 구간 듣기', 'aria-label': '이 구간 듣기', onclick: () => play(r) }, '▶'),
          h('button', {
            type: 'button', class: 'sm', title: lockedNow ? LOCKED_REASON : '이 구간 지우기', 'aria-label': '이 구간 지우기', disabled: lockedNow,
            onclick: () => removeSample(session, s.id, k, changed),
          }, '✕'));
      })),
      h('button', {
        type: 'button', class: 'pick', disabled: lockedNow, title: lockedNow ? LOCKED_REASON : `파형에서 고른 구간을 ${s.name}의 샘플로 지정 (숫자 ${i + 1} 키)`,
        onclick: () => assignSelection({ session, clip, sel: getSelection(), index: i, select, onChange: changed }),
      }, `고른 구간을 이 사람 샘플로`));
  }

  function render() {
    chips = [];
    lock.hidden = !session.locked;
    cards.replaceChildren(...speakers().map(card));
    paintCheck();
    paintClips();
    for (const s of speakers()) for (const r of s.enroll || []) if (clip.percent(r) === undefined) clip.ensure(r);
  }

  render();

  return {
    refresh: render,
    // 저장 상태: 'pending'|'saving'|'saved'|'error'
    setSaveState(state, err) {
      saved.className = `smp-saved${state === 'error' ? ' error' : ''}`;
      if (state === 'error') saved.textContent = `저장 실패: ${err && err.message}`;
      else if (state === 'saved') saved.textContent = `저장됨 ${clock()}`;
      else saved.textContent = '저장 중…';
    },
    destroy() { unsub(); root.replaceChildren(); },
  };
}
