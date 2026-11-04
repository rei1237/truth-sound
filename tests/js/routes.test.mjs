import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, caseHash } from '../../truth_sound/static/editor/routes.js';

const ID = '20261031-192419-60a7';

test('plain case route', () => {
  assert.deepEqual(parseRoute(`#/case/${ID}`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false });
  assert.equal(caseHash(ID), `#/case/${ID}`);
});

test('legacy steps 1-3 open samples tab', () => {
  for (const n of [1, 2, 3]) {
    assert.deepEqual(parseRoute(`#/case/${ID}/${n}`),
      { view: 'case', id: ID, tab: 'samples', dialog: null, legacy: true });
  }
});

test('legacy step 4 opens transcript tab', () => assert.deepEqual(parseRoute('#/case/20261031-192419-60a7/4'),
  { view: 'case', id: '20261031-192419-60a7', tab: 'transcript', dialog: null, legacy: true }));

test('legacy step 5 opens export dialog', () => assert.deepEqual(parseRoute(`#/case/${ID}/5`),
  { view: 'case', id: ID, tab: null, dialog: 'export', legacy: true }));

test('bad hash is empty view', () => {
  for (const h of ['', '#', '#/', '#/case', '#/case/', `#/case/${ID}/9`, `#/case/${ID}/x`, '#/other', null, undefined]) {
    assert.deepEqual(parseRoute(h), { view: 'empty' }, String(h));
  }
});

test('empty view carries card id only when the hash has it', () => {
  assert.deepEqual(parseRoute(`#/?card=${ID}`), { view: 'empty', card: ID });
  assert.deepEqual(parseRoute('#/?card='), { view: 'empty' });
  assert.deepEqual(parseRoute('#/'), { view: 'empty' });
});

test('view and spec appear only when the hash has them', () => {
  assert.deepEqual(parseRoute(`#/case/${ID}?view=1.5,11.5&spec=orig`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false, range: { start: 1.5, end: 11.5 }, spec: 'orig' });
  assert.deepEqual(parseRoute(`#/case/${ID}?spec=me`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false, spec: 'me' });
  assert.deepEqual(parseRoute(`#/case/${ID}?view=0,2`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false, range: { start: 0, end: 2 } });
  assert.deepEqual(parseRoute(`#/case/${ID}/3?spec=orig`),
    { view: 'case', id: ID, tab: 'samples', dialog: null, legacy: true, spec: 'orig' });
});

test('bad view or spec values are left out', () => {
  for (const q of ['view=5,5', 'view=5,2', 'view=-1,3', 'view=a,b', 'view=1', 'view=1,2,3', 'view=', 'spec=', 'spec=a%20b', 'foo=bar']) {
    assert.deepEqual(parseRoute(`#/case/${ID}?${q}`),
      { view: 'case', id: ID, tab: null, dialog: null, legacy: false }, q);
  }
});

test('sel is read like view and left out when bad', () => {
  assert.deepEqual(parseRoute(`#/case/${ID}?sel=0.2,1.4`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false, sel: { start: 0.2, end: 1.4 } });
  assert.deepEqual(parseRoute(`#/case/${ID}?view=1,9&sel=2,3&spec=orig`),
    { view: 'case', id: ID, tab: null, dialog: null, legacy: false, range: { start: 1, end: 9 }, sel: { start: 2, end: 3 }, spec: 'orig' });
  for (const q of ['sel=5,5', 'sel=5,2', 'sel=-1,3', 'sel=a,b', 'sel=1', 'sel=1,2,3', 'sel=']) {
    assert.deepEqual(parseRoute(`#/case/${ID}?${q}`),
      { view: 'case', id: ID, tab: null, dialog: null, legacy: false }, q);
  }
});
