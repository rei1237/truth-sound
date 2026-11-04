// 타임라인 줄 목록과 소리 켜고 끄기 계산. DOM을 만지지 않는다.
import { UNKNOWN, speakerColor, speakerName } from '../speakers.js';

export const ORIG_COLOR = '#aeb6c4';
const ACCENT = '#c9a45c';
const TEXT_COLOR = '#8a92a0';

// 화자 id는 [a-z0-9_-]라서 '@'로 시작하는 줄 id와 겹치지 않는다.
export const SAMPLES_ID = '@samples';
export const TRANSCRIPT_ID = '@transcript';

// 줄 순서: 원본, 목소리 샘플, 처리 트랙이 있는 화자(case.json의 지금 이름), 화자 확인 필요, 녹취록.
// 처리 전(트랙 없음)에는 원본·샘플 두 줄. 예전 사건(processing·speakers 없음)도 받는다.
export function trackRows(caseData, hasTranscript) {
  const c = caseData || {};
  const speakers = c.speakers || [];
  const processing = c.processing || {};
  const files = processing.tracks || {};
  const rows = [
    { id: 'orig', kind: 'audio', track: 'orig', name: '원본', sub: '녹음 그대로', color: ORIG_COLOR },
    { id: SAMPLES_ID, kind: 'samples', name: '목소리 샘플', sub: '사람별로 고른 구간', color: ACCENT },
  ];
  // 지금 화자 순서대로, 그다음 화자 목록에서 빠졌지만 트랙이 남은 것(처리 때 이름을 쓴다)
  const sids = speakers.map((s) => s.id).filter((sid) => sid !== UNKNOWN && files[sid]);
  for (const sid of Object.keys(files)) if (sid !== UNKNOWN && sid !== 'orig' && !sids.includes(sid)) sids.push(sid);
  for (const sid of sids) {
    const list = speakers.some((s) => s.id === sid) ? speakers : processing.speakers;
    rows.push({ id: sid, kind: 'audio', track: sid, name: speakerName(list, sid), sub: '분리한 목소리', color: speakerColor(list, sid) });
  }
  if (files[UNKNOWN]) {
    rows.push({
      id: UNKNOWN, kind: 'audio', track: UNKNOWN, name: speakerName(speakers, UNKNOWN),
      sub: '누구의 소리인지 정하지 못함', color: speakerColor(speakers, UNKNOWN), hatched: true,
    });
  }
  if (hasTranscript) {
    rows.push({ id: TRANSCRIPT_ID, kind: 'transcript', name: '녹취록', sub: '받아 적은 말', color: TEXT_COLOR });
  }
  return rows;
}

// 처음에는 원본만 소리가 난다. 소리 줄(audio)만 상태를 가진다.
export function initialStates(rows) {
  return rows.filter((r) => r.kind === 'audio').map((r) => ({ id: r.id, mute: r.id !== 'orig', solo: false }));
}

// 소리 나는 줄: 끈 줄은 언제나 안 들리고(끄기가 이긴다), 단독이 하나라도 있으면 단독인 줄만 남는다.
export function audibleIds(states) {
  const anySolo = states.some((s) => s.solo);
  return new Set(states.filter((s) => (anySolo ? s.solo : true) && !s.mute).map((s) => s.id));
}

// 줄 하나의 끄기·단독을 뒤집은 새 목록. 단독을 켜면 그 줄의 끄기는 풀어서, 단독으로 고른 소리가 들리게 한다.
export function toggleState(states, id, key) {
  return states.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, [key]: !s[key] };
    if (key === 'solo' && next.solo) next.mute = false;
    return next;
  });
}

export const CLIP_MAX = 600; // 서버 audio/clip이 한 번에 주는 최대 길이(초)

// 듣는 방법: 선택이 없거나 clip 한도(600초)보다 길면 'full'(트랙마다 audio 요소로 통째로),
// 선택이 있고 1배속이면 'buffer'(Web Audio 버퍼, 반복이 끊기지 않는다), 느리게(0.75·0.5·0.25)면 'element'(구간 WAV를 audio 요소로).
// 반복 여부는 방법을 바꾸지 않는다(버퍼는 loop=true, 요소는 loop 속성).
export function playMode({ selection, speed }) {
  if (!selection || !(selection.end - selection.start > 0) || selection.end - selection.start > CLIP_MAX) return 'full';
  return speed === 1 ? 'buffer' : 'element';
}

// 소리가 끝났을 때 다시 시작할지. 통째(full) 재생의 반복은 선택(600초 넘는 것)이 있을 때만이고,
// 선택이 없으면 반복은 꺼진 것과 같다. buffer·element는 스스로 되풀이하므로 여기서 다시 시작하지 않는다.
export function shouldRestart({ loop, mode, selection }) {
  return Boolean(loop) && mode === 'full' && Boolean(selection);
}

// 소리 나야 할 트랙 중에 아직 받아 두지 않은 것이 있으면 다시 시작해야 한다(끈 것만 있으면 소리 크기만 바꾸면 된다).
export function needsReload(audible, loaded) {
  return [...audible].some((tr) => !loaded.includes(tr));
}

// 한 번만 고른 트랙(예: 녹취록 카드의 ▶분리 음성)이 있으면 그것만, 없으면 끄기·단독으로 정한 소리 나는 줄.
export const activeTracks = (only, mix) => (only && only.size ? only : mix);
