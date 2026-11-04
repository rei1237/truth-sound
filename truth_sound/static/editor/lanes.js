// 녹취록 줄 계산. DOM을 만지지 않는다: 라벨 트랙의 층 나누기, 줄 넣기 규칙, 듣기 구간.
export const MAX_LANES = 2; // 라벨 트랙은 최대 2층. 더 겹치면 "+N"으로 모은다
export const PRE_ROLL = 0.3; // ▶ 듣기는 줄보다 이만큼(초) 앞뒤를 더 들려 준다

const r3 = (x) => Math.round(x * 1000) / 1000;

// 줄을 시작 순으로 보며, 비어 있는 가장 낮은 층에 놓는다. 두 층이 다 차면 more에 모은다:
// 서로 겹치는 넘친 줄은 하나로 묶어 {start, end, count}. 놓인 줄은 순서대로 {key, lane}.
// 아주 짧은 줄도 버리지 않는다(맞닿기만 한 줄은 겹친 것이 아니다).
export function layoutLanes(entries) {
  const sorted = entries.map((x, i) => ({ x, i })).sort((a, b) => a.x.start - b.x.start || a.i - b.i).map((o) => o.x);
  const free = new Array(MAX_LANES).fill(-Infinity); // 층마다 마지막 줄이 끝나는 시각
  const placed = [];
  const more = [];
  for (const x of sorted) {
    const lane = free.findIndex((end) => x.start >= end);
    if (lane >= 0) {
      free[lane] = Math.max(x.start, x.end);
      placed.push({ key: x.key, lane });
      continue;
    }
    const last = more[more.length - 1];
    if (last && x.start < last.end) {
      last.end = Math.max(last.end, x.end);
      last.count++;
    } else {
      more.push({ start: x.start, end: x.end, count: 1 });
    }
  }
  return { placed, more };
}

// 줄 넣기의 화자: t 앞에서 시작한 가장 가까운 줄의 화자(예전 규칙). 첫 줄보다 앞이면 바로 뒤 줄의 화자, 줄이 없으면 null(부른 쪽이 첫 사람으로).
export function nearestSpeaker(entries, t) {
  let before = null;
  let after = null;
  for (const x of entries) {
    if (x.start <= t) {
      if (!before || x.start >= before.start) before = x;
    } else if (!after || x.start < after.start) after = x;
  }
  const near = before || after;
  return near ? near.speaker : null;
}

// t에 소리가 나고 있는 줄들의 열쇠(끝은 포함하지 않는다).
export function activeAt(entries, t) {
  const out = new Set();
  for (const x of entries) if (t >= x.start && t < x.end) out.add(x.key === undefined ? x.id : x.key);
  return out;
}

// ▶ 듣기 구간: 앞은 PRE_ROLL만큼 당기되 0 밑으로 내리지 않는다.
export function previewWindow(entry) {
  return { start: r3(Math.max(0, entry.start - PRE_ROLL)), end: r3(entry.end + PRE_ROLL) };
}

// ▶분리 음성으로 들려 줄 트랙: 그 줄의 화자 트랙, 없으면 줄이 나온 트랙(source "track:<id>"), 그것도 없으면 null.
// 화자를 나누지 않고 만든 녹취록(source "original")은 트랙 이름이 우연히 같아도 그 줄의 소리가 아니라서 null.
export function separatedTrack(entry, tracks, source) {
  if (source === 'original') return null;
  const files = tracks || {};
  if (Object.hasOwn(files, entry.speaker)) return entry.speaker;
  const from = String(entry.source || '').replace(/^track:/, '');
  return from && Object.hasOwn(files, from) ? from : null;
}

// [줄 넣기] 구간: 선택이 있으면 그 구간, 없으면 재생 위치에서 2초. 녹음 안에 둔다.
export function newLineSpan({ selection, playhead, duration }) {
  if (selection && selection.end > selection.start) {
    return { start: r3(selection.start), end: r3(Math.min(selection.end, duration)) };
  }
  let start = Math.min(Math.max(0, playhead), duration);
  let end = Math.min(start + 2, duration);
  if (!(end > start)) { start = Math.max(0, duration - 2); end = duration; }
  return { start: r3(start), end: r3(end) };
}

// [a, b)와 시간이 겹치는 줄을 시작 순으로(같으면 들어온 순서). 끝이 닿기만 한 줄은 겹친 것이 아니다. 입력은 바꾸지 않는다.
export function entriesOverlapping(entries, a, b) {
  return (entries || []).map((x, i) => ({ x, i })).filter(({ x }) => x.start < b && x.end > a)
    .sort((p, q) => p.x.start - q.x.start || p.i - q.i).map((o) => o.x);
}
