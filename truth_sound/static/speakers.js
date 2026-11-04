// 화자 이름·판정 시간·처리 경고를 화면 글로 바꾼다. 예전 처리 기록(경고·판정 시간 없음)도 받는다.
export const UNKNOWN = 'unknown';
export const UNKNOWN_NAME = '화자 확인 필요';
export const UNKNOWN_COLOR = '#9aa0aa';
export const CLIP_COLOR = '#ff4d4f'; // 잘린 소리 표시. (추정)·화자 미상과 색이 겹치지 않게 둔다.

// 기본 화자는 id로 색을 고정하고, 직접 추가한 화자는 등록 순서대로 같은 세 색을 돌려 쓴다.
const DEFAULT_COLORS = { me: '#5ea8ff', partner: '#ffa24c', bystander: '#41d095' };
const PALETTE = [DEFAULT_COLORS.me, DEFAULT_COLORS.partner, DEFAULT_COLORS.bystander];

export function speakerName(speakers, sid) {
  if (sid === UNKNOWN) return UNKNOWN_NAME;
  const s = (speakers || []).find((x) => x.id === sid);
  return s ? s.name : sid;
}

export function speakerColor(speakers, sid) {
  if (sid === UNKNOWN) return UNKNOWN_COLOR;
  if (Object.hasOwn(DEFAULT_COLORS, sid)) return DEFAULT_COLORS[sid];
  const others = (speakers || []).filter((x) => !Object.hasOwn(DEFAULT_COLORS, x.id));
  const i = others.findIndex((x) => x.id === sid);
  return i < 0 ? UNKNOWN_COLOR : PALETTE[i % PALETTE.length];
}

export function assignedLine(processing) {
  const sec = processing && processing.assigned_seconds;
  if (!sec) return '';
  const parts = (processing.speakers || []).map((s) => `${s.name} ${(sec[s.id] || 0).toFixed(1)}초`);
  if (sec[UNKNOWN] > 0) parts.push(`확인 필요 ${sec[UNKNOWN].toFixed(1)}초`);
  return parts.length ? `샘플 밖에서 찾은 말: ${parts.join(' · ')}` : '';
}

export function warningsOf(processing) {
  return (processing && processing.warnings) || [];
}
