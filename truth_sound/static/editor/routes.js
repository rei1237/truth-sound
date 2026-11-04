// 주소(#...)와 화면 상태 사이 변환. 예전 `#/case/<id>/<1~5>` 단계 주소도 받는다.
const LEGACY = {
  1: { tab: 'samples', dialog: null },
  2: { tab: 'samples', dialog: null },
  3: { tab: 'samples', dialog: null },
  4: { tab: 'transcript', dialog: null },
  5: { tab: null, dialog: 'export' },
};

// `?view=<시작>,<끝>&sel=<시작>,<끝>&spec=<줄 id>`: 처음 보기 구간(초), 처음 고른 구간(초), 주파수 그림으로 열 줄. 있고 알아볼 수 있을 때만 결과에 넣는다.
const VIEW_RE = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/;
function parseQuery(q) {
  const out = {};
  for (const part of String(q || '').split('&')) {
    const i = part.indexOf('=');
    const key = i < 0 ? part : part.slice(0, i);
    const val = i < 0 ? '' : part.slice(i + 1);
    const r = key === 'view' || key === 'sel' ? VIEW_RE.exec(val) : null;
    if (r && Number(r[2]) > Number(r[1])) out[key === 'view' ? 'range' : 'sel'] = { start: Number(r[1]), end: Number(r[2]) };
    else if (key === 'spec' && /^[\w.-]+$/.test(val)) out.spec = val;
  }
  return out;
}

export function parseRoute(hash) {
  // 빈 화면의 확인 카드: `#/?card=<id>` (카드에서 새로고침해도 카드가 남는다)
  const c = /^#\/\?card=([^/?#&]+)$/.exec(typeof hash === 'string' ? hash : '');
  if (c) return { view: 'empty', card: c[1] };
  const m = /^#\/case\/([^/?#]+)(?:\/([1-5]))?(?:\?([^#]*))?$/.exec(typeof hash === 'string' ? hash : '');
  if (!m) return { view: 'empty' };
  const old = m[2] ? LEGACY[m[2]] : { tab: null, dialog: null };
  return { view: 'case', id: m[1], tab: old.tab, dialog: old.dialog, legacy: Boolean(m[2]), ...parseQuery(m[3]) };
}

export const caseHash = (id) => `#/case/${id}`;
export const cardHash = (id) => `#/?card=${id}`;
