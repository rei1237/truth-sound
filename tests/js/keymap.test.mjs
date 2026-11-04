import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFor } from '../../truth_sound/static/editor/keymap.js';

const k = (code, extra = {}) => actionFor({ code, key: '', target: {}, ...extra });

test('uses e.code so Korean IME still works', () => {
  assert.equal(actionFor({ code: 'KeyL', key: 'ㅣ', target: {} }), 'loop');
});

test('key table', () => {
  const table = {
    Space: 'play', Home: 'home', End: 'end', KeyL: 'loop', BracketLeft: 'prevSpeech', BracketRight: 'nextSpeech',
    Equal: 'zoomIn', NumpadAdd: 'zoomIn', Minus: 'zoomOut', NumpadSubtract: 'zoomOut', KeyF: 'fit', KeyE: 'zoomSel',
    Digit1: 'assign1', Digit2: 'assign2', Digit3: 'assign3', Numpad1: 'assign1', Numpad2: 'assign2', Numpad3: 'assign3',
    Delete: 'delete', Backspace: 'delete', Escape: 'escape',
  };
  for (const [code, action] of Object.entries(table)) assert.equal(k(code), action, code);
  assert.equal(k('KeyZ'), null);
  assert.equal(k('Digit4'), null);
  assert.equal(k('toString'), null);
});

test('ignored while typing', () => {
  assert.equal(actionFor({ code: 'Space', target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(actionFor({ code: 'KeyL', target: { tagName: 'INPUT' } }), null);
  assert.equal(actionFor({ code: 'Digit1', target: { tagName: 'SELECT' } }), null);
  assert.equal(actionFor({ code: 'Delete', target: { tagName: 'DIV', isContentEditable: true } }), null);
  assert.equal(actionFor({ code: 'Backspace', target: { tagName: 'TEXTAREA' } }), null);
});

test('escape still works in input', () => {
  assert.equal(actionFor({ code: 'Escape', target: { tagName: 'INPUT' } }), 'escape');
  assert.equal(actionFor({ code: 'Escape', target: { tagName: 'DIV', isContentEditable: true } }), 'escape');
});

test('ctrl combos ignored', () => {
  assert.equal(k('KeyL', { ctrlKey: true }), null);
  assert.equal(k('Space', { altKey: true }), null);
  assert.equal(k('KeyF', { metaKey: true }), null);
  assert.equal(k('Escape', { ctrlKey: true }), null);
});

test('undo/redo shortcuts work outside text fields', () => {
  assert.equal(k('KeyZ', { ctrlKey: true }), 'undo');
  assert.equal(k('KeyZ', { ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(k('KeyY', { ctrlKey: true }), 'redo');
  assert.equal(actionFor({ code: 'KeyZ', ctrlKey: true, target: { tagName: 'TEXTAREA' } }), null);
});

test('NumLock-off numpad Del is treated as Delete, decimal point is not', () => {
  assert.equal(actionFor({ code: 'NumpadDecimal', key: 'Delete', target: {} }), 'delete');
  assert.equal(actionFor({ code: 'NumpadDecimal', key: 'Del', target: {} }), 'delete');
  assert.equal(actionFor({ code: 'NumpadDecimal', key: '.', target: {} }), null);
});

test('missing target is fine', () => {
  assert.equal(actionFor({ code: 'Space' }), 'play');
});

test('held keys (e.repeat) are ignored', () => {
  assert.equal(k('Equal', { repeat: true }), null);
  assert.equal(k('Escape', { repeat: true }), null);
  assert.equal(k('Equal', { repeat: false }), 'zoomIn');
});

test('on a focused button only Space is left to the button; other keys and Escape still work', () => {
  assert.equal(actionFor({ code: 'Space', target: { tagName: 'BUTTON' } }), null);
  assert.equal(actionFor({ code: 'KeyF', target: { tagName: 'button' } }), 'fit');
  assert.equal(actionFor({ code: 'KeyL', target: { tagName: 'BUTTON' } }), 'loop');
  assert.equal(actionFor({ code: 'Home', target: { tagName: 'BUTTON' } }), 'home');
  assert.equal(actionFor({ code: 'Escape', target: { tagName: 'BUTTON' } }), 'escape');
});

test('text inputs swallow every key except Escape', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(actionFor({ code: 'KeyL', target: { tagName: tag } }), null);
    assert.equal(actionFor({ code: 'Space', target: { tagName: tag } }), null);
  }
});
