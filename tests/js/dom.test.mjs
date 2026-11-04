import test from 'node:test';
import assert from 'node:assert/strict';

// 가짜 document: 요소는 tag·props·자식만 모은다. dom.js는 document를 함수 안에서만 읽는다.
class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; }
  append(...kids) { this.children.push(...kids); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
}
globalThis.Node = FakeEl;
globalThis.document = {
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (s) => String(s),
};

const { h, fmt } = await import('../../truth_sound/static/ui/dom.js');

test('h flattens nested arrays into children', () => {
  const [a, b, c] = [h('i'), h('b'), h('u')];
  const el = h('div', {}, a, [b, [c]]);
  assert.equal(el.children.length, 3);
  assert.deepEqual(el.children, [a, b, c]);
});

test('h skips null, undefined and false, keeps 0 and text', () => {
  const el = h('p', {}, null, false, undefined, 0, '글');
  assert.deepEqual(el.children, ['0', '글']);
});

test('h props: class, boolean, listeners, false/null skipped', () => {
  const fn = () => {};
  const el = h('button', { class: 'x', hidden: true, disabled: false, title: null, onclick: fn, id: 'a' });
  assert.equal(el.className, 'x');
  assert.equal(el.attrs.hidden, '');
  assert.equal('disabled' in el.attrs, false);
  assert.equal('title' in el.attrs, false);
  assert.equal(el.listeners.click, fn);
  assert.equal(el.attrs.id, 'a');
});

test('fmt shows time as 00:00:05.050', () => {
  assert.equal(fmt(0), '00:00:00.000');
  assert.equal(fmt(5.05), '00:00:05.050');
  assert.equal(fmt(2.115918), '00:00:02.116');
  assert.equal(fmt(3725.5), '01:02:05.500');
  assert.equal(fmt(null), '00:00:00.000');
});
