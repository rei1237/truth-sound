// 검수 내용 자동 저장: 고친 뒤 잠깐 기다렸다 보내고, 보내는 중에 또 고치면 끝난 뒤 한 번 더 보낸다.
export function createSaver({ send, onState = () => {}, delay = 700, retryDelay = 3000 }) {
  let dirty = false;
  let saving = null;
  let again = false;
  let timer = null;
  let gen = 0; // reset() 뒤에 끝난 이전 사건의 저장은 무시한다

  function later(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => save(), ms);
  }

  function changed() {
    dirty = true;
    onState('pending');
    later(delay);
  }

  function save(keepalive = false) {
    clearTimeout(timer);
    if (!dirty) return saving || Promise.resolve(true);
    if (saving) {
      again = true;
      return saving;
    }
    dirty = false;
    onState('saving');
    const g = gen;
    const p = send(keepalive)
      .then(() => {
        if (g === gen) onState('saved');
        return true;
      })
      .catch((err) => {
        if (g !== gen) return false;
        dirty = true;
        onState('error', err);
        if (!err.status || err.status >= 500) later(retryDelay);
        return false;
      })
      .finally(() => {
        if (saving === p) saving = null;
        if (g === gen && again) {
          again = false;
          save();
        }
      });
    saving = p;
    return p;
  }

  // 고친 내용이 모두 저장될 때까지 기다린다. 마지막 저장이 실패하면 false.
  async function flush() {
    for (;;) {
      if (saving) {
        await saving;
        continue;
      }
      if (!dirty) return true;
      if (!(await save())) return false;
    }
  }

  function reset() {
    gen += 1;
    clearTimeout(timer);
    dirty = false;
    again = false;
    saving = null;
  }

  return {
    changed, save, flush, reset,
    get pending() { return dirty || Boolean(saving); },
  };
}
