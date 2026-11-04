// "방금 이 탭에서 올려 만든 사건" 표시. 카드가 지울 수 있는 사건은 이 표시가 있는 것뿐이다.
// 주소(#/?card=<id>)를 직접 치거나 뒤로 가기로 다시 뜬 카드의 사건은 지우지 않는다.
// 탭 저장소(sessionStorage)에도 적어 카드에서 새로고침해도 이어지고, 저장소를 못 쓰면 메모리에만 둔다.
const KEY = (id) => `truthsound.fresh.${id}`;

export function createFreshMarks(storage) {
  const mem = new Set();
  const store = (fn) => { try { return storage ? fn(storage) : undefined; } catch { return undefined; } };
  return {
    mark(id) { mem.add(id); store((s) => s.setItem(KEY(id), '1')); },
    clear(id) { mem.delete(id); store((s) => s.removeItem(KEY(id))); },
    has(id) { return mem.has(id) || store((s) => s.getItem(KEY(id))) === '1'; },
  };
}

// 탭 하나에 표시는 하나만 둔다(카드와 주소 처리가 같은 표시를 본다).
let shared = null;
export function freshMarks() {
  if (!shared) shared = createFreshMarks((() => { try { return sessionStorage; } catch { return null; } })());
  return shared;
}

// 사건이 어떤 길로든 열리면(목록, 주소, 앞으로 가기) 이미 쓰는 사건이니 카드가 더는 지울 수 없다.
export function releaseOnOpen(marks, route) {
  if (route && route.view === 'case' && route.id) marks.clear(route.id);
}
