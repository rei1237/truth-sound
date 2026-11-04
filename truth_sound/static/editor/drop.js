// 녹음 넣기: 끌어다 놓는 동안의 검사. DOM을 만지지 않는다.
export const ACCEPT_EXT = ['.m4a', '.amr', '.3gp', '.aac', '.mp3', '.wav', '.ogg', '.opus', '.flac', '.wma'];

const NOT_AUDIO = '녹음 파일이 아닙니다';
const NOT_AUDIO_TYPE = /^(image\/|text\/|application\/pdf$)/;

// 끌고 있는 동안은 items[].kind·type만 보인다(이름·크기는 놓은 뒤에야 안다).
// 종류가 비었거나 소리처럼 보이면 막지 않고, 놓은 뒤 확장자로 다시 본다.
export function checkDrag(items) {
  const files = Array.from(items || []).filter((it) => it && it.kind === 'file');
  const count = files.length;
  if (count >= 2) return { ok: false, count, message: '한 번에 한 파일만 넣을 수 있습니다' };
  if (files.some((it) => NOT_AUDIO_TYPE.test(it.type || ''))) return { ok: false, count, message: NOT_AUDIO };
  return { ok: true, count, message: '' };
}

// 놓은 파일 하나를 이름·종류로 본다. 쓸 수 있으면 null, 아니면 이유.
export function checkFile(name, type) {
  const dot = String(name || '').lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  if (ACCEPT_EXT.includes(ext)) return null;
  if (String(type || '').startsWith('audio/')) return null; // 이름은 낯설어도 소리 종류면 서버가 열어 본다
  return `${NOT_AUDIO}${ext ? ` (${ext})` : ''}`;
}

// dragenter/dragleave는 자식 요소를 지날 때마다 짝으로 오므로, 횟수가 0이 될 때만 끈다.
export function createDragCounter() {
  let n = 0;
  return {
    enter() { n += 1; },
    leave() { n = Math.max(0, n - 1); },
    reset() { n = 0; },
    get active() { return n > 0; },
  };
}
