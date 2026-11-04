// 키보드 → 동작 이름. e.code로 보므로 한글 입력 상태에서도 같은 키가 듣는다.
const TABLE = {
  Space: 'play',
  Home: 'home',
  End: 'end',
  KeyL: 'loop',
  BracketLeft: 'prevSpeech',
  BracketRight: 'nextSpeech',
  Equal: 'zoomIn',
  NumpadAdd: 'zoomIn',
  Minus: 'zoomOut',
  NumpadSubtract: 'zoomOut',
  KeyF: 'fit',
  KeyE: 'zoomSel',
  Digit1: 'assign1',
  Digit2: 'assign2',
  Digit3: 'assign3',
  Numpad1: 'assign1',
  Numpad2: 'assign2',
  Numpad3: 'assign3',
  Delete: 'delete',
  Backspace: 'delete',
  Escape: 'escape',
};

// 글자를 치는 칸이면 모든 키를 양보한다.
function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

// 단추에 초점이 있을 때 Space는 단추가 누른 것이므로 여기서 또 움직이지 않는다. 나머지 키(= - F E Home End L [ ])는 그대로 듣는다.
function isButton(target) {
  return Boolean(target) && String(target.tagName || '').toUpperCase() === 'BUTTON';
}

export function actionFor(e) {
  if (e.repeat) return null; // 키를 누르고 있어서 되풀이되는 입력은 무시
  if (isTyping(e.target) && e.code !== 'Escape') return null;
  if (!e.altKey && !e.metaKey && e.ctrlKey && e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (!e.altKey && !e.metaKey && e.ctrlKey && e.code === 'KeyY') return 'redo';
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  // NumLock을 끈 숫자패드 Del은 code=NumpadDecimal, key=Delete로 들어온다.
  const action = Object.hasOwn(TABLE, e.code) ? TABLE[e.code]
    : e.code === 'NumpadDecimal' && (e.key === 'Delete' || e.key === 'Del') ? 'delete' : null;
  if (!action) return null;
  if (isButton(e.target) && e.code === 'Space') return null;
  return action;
}
