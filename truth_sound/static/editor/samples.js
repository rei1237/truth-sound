// 목소리 샘플(사람별 구간) 계산. DOM을 만지지 않는다. 입력은 바꾸지 않고 새 목록을 돌려준다.
// 아주 짧은 소리도 구분하는 것이 이 도구의 목적이라, 건드리지 않은 구간은 같은 배열 값 그대로 두고
// 새로 반올림하지도, 짧다고 지우거나 늘리지도 않는다. 사람이 고른 구간만 샘플이 된다.
export const MIN_ENROLL = 0.2; // 처리에 필요한 사람별 최소 샘플 길이(초). pipeline.MIN_ENROLL_SEC와 같다
export const GOOD_ENROLL = 2.0; // 이보다 짧아도 처리하지만 사람이 뒤바뀔 수 있어 알려 준다
export const TINY_SEC = 0.05; // 이보다 짧은 조각은 "너무 짧은 구간"으로 표시한다(지우지는 않는다)
export const CLIP_WARN_PERCENT = 1; // 지정 구간의 잘린 비율이 이 이상이면 확인을 받는다
export const OVERLAP_ERROR = '다른 사람의 샘플과 겹칩니다';

const fail = (speakers, error) => ({ speakers, error });
const validRange = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > a;

// 서버가 저장하는 정밀도(밀리초). 새로 고른 구간을 화면에서 이 값으로 맞춰 두면 저장 전후가 같다.
export const snapMs = (x) => Math.round(x * 1000) / 1000;

export const totalSeconds = (ranges) => (ranges || []).reduce((t, [a, b]) => t + (b - a), 0);

// 부동소수 오차(0.981-0.931=0.04999…)로 0.05초짜리를 짧다고 하지 않게 마이크로초에서 맞춘다.
export const isTiny = ([a, b]) => Math.round((b - a) * 1e6) / 1e6 < TINY_SEC;

// 사람 sid의 skip번째 구간(없으면 -1)을 [a,b]로 바꿔 넣는다. 같은 사람의 겹치거나 닿는 구간은 하나로 합치고,
// 다른 사람 구간과 겹치면 바꾸지 않는다. 합쳐지지 않은 구간은 원래 배열 그대로 둔다.
function place(speakers, sid, skip, a, b) {
  const me = speakers.find((s) => s.id === sid);
  if (!me) return fail(speakers, '없는 사람입니다');
  if (!validRange(a, b)) return fail(speakers, '구간이 올바르지 않습니다');
  for (const s of speakers) {
    if (s.id !== sid && (s.enroll || []).some(([c, d]) => a < d && c < b)) return fail(speakers, OVERLAP_ERROR);
  }
  // 똑같은 구간이 이미 있으면 새로 넣지 않는다(짧은 구간이 두 번 들어가는 것을 막는다). 늘이기·줄이기로 같아진 경우엔 고치던 것만 뺀다.
  const list = me.enroll || [];
  if (list.some((r, i) => i !== skip && r[0] === a && r[1] === b)) {
    if (skip < 0) return { speakers, error: null };
    return { speakers: speakers.map((s) => (s === me ? { ...s, enroll: list.filter((_, i) => i !== skip) } : s)), error: null };
  }
  // 닿는 구간은 합친다. 다만 아주 짧은 구간은 사람이 따로 고른 것이라, 합친 결과 안에 통째로 들어 있으면(가장자리에 걸쳐 있어도)
  // 합치지 않고 값 그대로 따로 둔다. 합친 결과 밖으로 삐져나온 짧은 구간만 합쳐서 그 소리가 덮이게 한다.
  const merged = []; // 합칠 구간들
  const kept = []; // 그대로 둘 구간들
  list.forEach((r, i) => { if (i === skip) return; (r[0] <= b && r[1] >= a ? merged : kept).push(r); });
  const spanOf = (skipR) => merged.reduce((sp, r) => (r === skipR ? sp : [Math.min(sp[0], r[0]), Math.max(sp[1], r[1])]), [a, b]);
  for (let moved = true; moved;) {
    moved = false;
    for (const r of merged) {
      if (!isTiny(r)) continue;
      const [x, y] = spanOf(r);
      if (r[0] >= x && r[1] <= y) { merged.splice(merged.indexOf(r), 1); kept.push(r); moved = true; break; }
    }
  }
  kept.sort((p, q) => list.indexOf(p) - list.indexOf(q)); // 원래 순서 그대로
  const [lo, hi] = spanOf(null);
  const at = kept.findIndex((r) => r[0] > lo);
  kept.splice(at < 0 ? kept.length : at, 0, [lo, hi]);
  return { speakers: speakers.map((s) => (s === me ? { ...s, enroll: kept } : s)), error: null };
}

export const addRange = (speakers, sid, a, b) => place(speakers, sid, -1, a, b);

export function resizeRange(speakers, sid, index, a, b) {
  const me = speakers.find((s) => s.id === sid);
  if (!me || !Number.isInteger(index) || index < 0 || index >= (me.enroll || []).length) return fail(speakers, '없는 구간입니다');
  return place(speakers, sid, index, a, b);
}

// undo()는 지우기 전 목록을 돌려준다. removed는 지운 구간(화면이 그 사이 바뀌었을 때 다시 넣는 데 쓴다).
export function removeRange(speakers, sid, index) {
  const me = speakers.find((s) => s.id === sid);
  if (!me || !Number.isInteger(index) || index < 0 || index >= (me.enroll || []).length) {
    return { speakers, removed: null, undo: () => speakers };
  }
  const enroll = me.enroll.filter((_, i) => i !== index);
  return { speakers: speakers.map((s) => (s === me ? { ...s, enroll } : s)), removed: me.enroll[index], undo: () => speakers };
}

// 처리를 시작하려면 2~3명이 각각 0.2초 이상이어야 한다. 되면 null.
export function enrollProblem(speakers) {
  const chosen = (speakers || []).filter((s) => s.enroll.length);
  if (chosen.length < 2 || chosen.length > 3) return `구간을 지정한 사람이 ${chosen.length}명입니다. 화자 분리는 2명 또는 3명이 필요합니다. 녹취록만 만들려면 [녹취록 만들기]를 누르세요. 샘플이 1명뿐이어도 가능합니다.`;
  const short = chosen.filter((s) => totalSeconds(s.enroll) < MIN_ENROLL);
  if (short.length) return `${short.map((s) => s.name).join(', ')}: 목소리 샘플이 ${MIN_ENROLL}초 이상 필요합니다.`;
  return null;
}

// 처리는 되지만 짧아서 사람이 뒤바뀔 수 있을 때의 조언. 없으면 null.
export function enrollAdvice(speakers) {
  const short = (speakers || []).filter((s) => s.enroll.length && totalSeconds(s.enroll) < GOOD_ENROLL);
  if (!short.length) return null;
  return `${short.map((s) => s.name).join(', ')}: 샘플이 짧습니다. 그대로 처리할 수 있지만 사람이 뒤바뀌어 배정될 수 있으니, `
    + `가능하면 ${GOOD_ENROLL}초 이상 지정하고 검수 때 확인하세요.`;
}

// 샘플 구간의 잘린 비율(원본 기준). 한 번 물은 구간은 다시 묻지 않고, 못 받으면 null(경고를 못 띄울 뿐 지정은 막지 않는다).
export function createClipCheck(api, base) {
  const done = new Map(); // "a:b" → 비율 | null
  const asking = new Map();
  const subs = new Set();
  const key = ([a, b]) => `${a}:${b}`;
  const clipped = (p) => p != null && p >= CLIP_WARN_PERCENT;
  return {
    percent: (range) => done.get(key(range)),
    isClipped: (range) => clipped(done.get(key(range))),
    ensure(range) {
      const k = key(range);
      if (done.has(k)) return Promise.resolve(done.get(k));
      if (asking.has(k)) return asking.get(k);
      const p = api.get(`${base}/analyze?track=orig&start=${range[0]}&end=${range[1]}`)
        .then((r) => (Number.isFinite(r && r.clipped_percent) ? r.clipped_percent : null), () => null)
        .then((v) => {
          done.set(k, v);
          asking.delete(k);
          for (const fn of subs) fn(range, v);
          return v;
        });
      asking.set(k, p);
      return p;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// 지운 구간을 그대로 되돌린다. 아주 짧은 구간은 다른 구간 안에 있어도 합치지 않고 값 그대로 따로 넣는다(이미 같은 값이 있으면 그대로 둔다).
// 짧지 않은 구간은 겹치는 구간과 합쳐 같은 소리를 두 번 세지 않게 한다. 다른 사람 구간과 겹치면 바꾸지 않는다.
export function restoreRange(speakers, sid, range) {
  const me = speakers.find((s) => s.id === sid);
  if (!me) return fail(speakers, '없는 사람입니다');
  const [a, b] = range || [];
  if (!validRange(a, b)) return fail(speakers, '구간이 올바르지 않습니다');
  if (!isTiny(range)) return addRange(speakers, sid, a, b);
  for (const s of speakers) {
    if (s.id !== sid && (s.enroll || []).some(([c, d]) => a < d && c < b)) return fail(speakers, OVERLAP_ERROR);
  }
  const list = me.enroll || [];
  if (list.some((r) => r[0] === a && r[1] === b)) return { speakers, error: null };
  const enroll = list.slice();
  const at = enroll.findIndex((r) => r[0] > a);
  enroll.splice(at < 0 ? enroll.length : at, 0, [a, b]);
  return { speakers: speakers.map((s) => (s === me ? { ...s, enroll } : s)), error: null };
}

// 처리 단추를 못 누르는 이유. 누를 수 있으면 null. job은 GET /api/jobs/current의 값(모르면 null).
export function processBlock({ speakers, job, caseId }) {
  return busyReason(job, caseId) || enrollProblem(speakers);
}

// [녹취록 만들기]를 못 누르는 이유. 목소리 샘플은 보지 않는다. 누를 수 있으면 null.
export const transcribeBlock = ({ job, caseId }) => busyReason(job, caseId);

function busyReason(job, caseId) {
  if (!job || job.state !== 'running') return null;
  return job.case_id === caseId ? '이 녹음을 처리하는 중입니다.' : '다른 녹음을 처리하는 중입니다. 그 처리가 끝난 뒤 시작할 수 있습니다.';
}

// 처리 단계와 전체 진행률에서 차지하는 비중(서버 pipeline의 단계 이름과 같다)
export const STAGES = [['확인', 2], ['준비', 3], ['목소리 분리', 45], ['음성 보정', 5], ['받아쓰기', 40], ['정리', 5]];
const TRANSCRIBE_STAGES = [['확인', 3], ['준비', 2], ['받아쓰기', 90], ['정리', 5]];
const DENOISE_STAGES = [['확인', 5], ['잡음 제거', 90], ['정리', 5]];
const REPAIR_STAGES = [['확인', 5], ['손상 찾기', 10], ['보완', 80], ['정리', 5]];

// 작업 종류(와 clarify의 단계 step)에 맞는 단계 목록. 종류를 모르는 옛 작업은 process로 본다.
export function stagesFor(kind = 'process', step = null) {
  if (kind === 'transcribe') return TRANSCRIBE_STAGES;
  if (kind === 'clarify') return step === 'repair' ? REPAIR_STAGES : DENOISE_STAGES;
  return STAGES;
}

// 이 종류의 작업이 도는 동안은 그 사건의 화자·녹취록을 고칠 수 없다(서버 EDIT_BLOCKING과 같다)
export const blocksEditing = (kind) => ['process', 'transcribe'].includes(kind ?? 'process');

// 이 사건의 편집을 잠가야 하는 작업이 지금 도는가. job은 GET /api/jobs/current의 값(모르면 null).
export const locksEditing = (job, caseId) => Boolean(job) && job.state === 'running' && job.case_id === caseId && blocksEditing(job.kind);

// 전체 진행률(0~100). 끝났으면 100, 아직 단계에 못 들어갔으면(대기) 0.
export function jobPercent(job) {
  const stages = stagesFor(job.kind, job.step);
  const idx = job.state === 'done' ? stages.length : stages.findIndex(([n]) => n === job.stage);
  let sum = 0;
  let done = 0;
  stages.forEach(([, w], i) => {
    sum += w;
    if (i < idx) done += w;
    else if (i === idx) done += w * job.progress;
  });
  return (done / sum) * 100;
}
