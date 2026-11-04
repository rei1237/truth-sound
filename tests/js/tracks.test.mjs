import test from 'node:test';
import assert from 'node:assert/strict';
import { trackRows, audibleIds, initialStates, playMode, toggleState, shouldRestart, needsReload, activeTracks } from '../../truth_sound/static/editor/tracks.js';
import { UNKNOWN_COLOR } from '../../truth_sound/static/speakers.js';

const SPEAKERS = [
  { id: 'me', name: '나', enroll: [[0.2, 0.5]] },
  { id: 'partner', name: '상대방', enroll: [[0.6, 0.9]] },
  { id: 'bystander', name: '옆 사람', enroll: [] },
];
const before = { speakers: SPEAKERS, processing: null };
const after = {
  speakers: SPEAKERS,
  processing: { tracks: { unknown: 'tracks/u.wav', me: 'tracks/me.wav', partner: 'tracks/p.wav' } },
};
const ids = (rows) => rows.map((r) => r.id);

test('before processing: original and samples only', () => {
  const rows = trackRows(before, false);
  assert.deepEqual(rows.map((r) => r.kind), ['audio', 'samples']);
  assert.equal(rows[0].track, 'orig');
});

test('after processing: orig, samples, speakers with a track, unknown, transcript', () => {
  const rows = trackRows(after, true);
  assert.deepEqual(rows.map((r) => r.kind), ['audio', 'samples', 'audio', 'audio', 'audio', 'transcript']);
  assert.deepEqual(rows.filter((r) => r.kind === 'audio').map((r) => r.track), ['orig', 'me', 'partner', 'unknown']);
});

test('speaker without a processed track (bystander) gets no row', () => {
  assert.equal(trackRows(after, true).some((r) => r.id === 'bystander'), false);
});

test('no transcript row without a transcript', () => {
  assert.equal(trackRows(after, false).some((r) => r.kind === 'transcript'), false);
});

test('row names follow the current speaker names, colors follow the id', () => {
  const renamed = { ...after, speakers: [{ ...SPEAKERS[0], name: '민수' }, SPEAKERS[1], SPEAKERS[2]] };
  const me = trackRows(renamed, true).find((r) => r.id === 'me');
  assert.equal(me.name, '민수');
  assert.equal(me.color, '#5ea8ff');
  assert.equal(trackRows(renamed, true).find((r) => r.id === 'partner').color, '#ffa24c');
});

test('unknown row is hatched and gray, confirmed speakers are not hatched', () => {
  const rows = trackRows(after, true);
  const u = rows.find((r) => r.track === 'unknown');
  assert.equal(u.hatched, true);
  assert.equal(u.color, UNKNOWN_COLOR);
  assert.ok(!rows.find((r) => r.id === 'me').hatched);
});

test('custom speakers take the palette in registration order', () => {
  const sp = [{ id: 'a', name: 'A', enroll: [] }, { id: 'b', name: 'B', enroll: [] }];
  const rows = trackRows({ speakers: sp, processing: { tracks: { a: 'x', b: 'y' } } }, false);
  assert.deepEqual(rows.filter((r) => r.track === 'a' || r.track === 'b').map((r) => r.color), ['#5ea8ff', '#ffa24c']);
});

test('old case without processing/speakers fields still gives two rows', () => {
  assert.equal(trackRows({}, false).length, 2);
  assert.equal(trackRows({ speakers: null, processing: { tracks: null } }, false).length, 2);
});

test('a track whose speaker was later removed is still listed', () => {
  const c = { speakers: [SPEAKERS[0]], processing: { tracks: { me: 'a', partner: 'b' }, speakers: [SPEAKERS[0], SPEAKERS[1]] } };
  const rows = trackRows(c, false);
  assert.deepEqual(rows.filter((r) => r.kind === 'audio').map((r) => r.track), ['orig', 'me', 'partner']);
  assert.equal(rows.find((r) => r.track === 'partner').name, '상대방');
});

test('row ids cannot collide with a speaker id', () => {
  const sp = [{ id: 'samples', name: 'S', enroll: [] }, { id: 'transcript', name: 'T', enroll: [] }];
  const rows = trackRows({ speakers: sp, processing: { tracks: { samples: 'a', transcript: 'b' } } }, true);
  assert.equal(new Set(ids(rows)).size, rows.length);
});

test('initial states: only the original is audible', () => {
  const rows = trackRows(after, true);
  const st = initialStates(rows);
  assert.deepEqual(st.map((s) => s.id), ['orig', 'me', 'partner', 'unknown']); // 소리 나는 줄만
  assert.deepEqual([...audibleIds(st)], ['orig']);
});

test('audibleIds: no solo -> everything not muted', () => {
  const st = [{ id: 'a', mute: false, solo: false }, { id: 'b', mute: true, solo: false }, { id: 'c', mute: false, solo: false }];
  assert.deepEqual([...audibleIds(st)].sort(), ['a', 'c']);
});

test('audibleIds: any solo -> only solo tracks that are not muted (mute always wins)', () => {
  const st = [{ id: 'a', mute: false, solo: true }, { id: 'b', mute: false, solo: false }, { id: 'c', mute: true, solo: true }];
  assert.deepEqual([...audibleIds(st)], ['a']);
});

test('toggleState: turning solo on clears the row mute so the soloed track is heard', () => {
  const st = [{ id: 'a', mute: true, solo: false }, { id: 'b', mute: true, solo: false }];
  const next = toggleState(st, 'a', 'solo');
  assert.deepEqual(next[0], { id: 'a', mute: false, solo: true });
  assert.deepEqual(next[1], st[1]); // 다른 줄은 그대로
  assert.deepEqual([...audibleIds(next)], ['a']);
  assert.equal(st[0].solo, false); // 원래 배열은 바꾸지 않는다
});

test('toggleState: solo off keeps mute as is, mute toggles alone', () => {
  const on = [{ id: 'a', mute: false, solo: true }];
  assert.deepEqual(toggleState(on, 'a', 'solo')[0], { id: 'a', mute: false, solo: false });
  assert.deepEqual(toggleState(on, 'a', 'mute')[0], { id: 'a', mute: true, solo: true });
  assert.deepEqual([...audibleIds(toggleState(on, 'a', 'mute'))], []); // 단독이어도 끄면 안 들린다
});

test('audibleIds: all muted -> nothing', () => {
  assert.equal(audibleIds([{ id: 'a', mute: true, solo: false }]).size, 0);
});

test('playMode: no selection -> full', () => {
  assert.equal(playMode({ selection: null, speed: 1, loop: false }), 'full');
});

test('playMode: selection over 600 s -> full, exactly 600 s is still clipped', () => {
  assert.equal(playMode({ selection: { start: 0, end: 601 }, speed: 1, loop: false }), 'full');
  assert.equal(playMode({ selection: { start: 10, end: 610 }, speed: 1, loop: false }), 'buffer');
});

test('playMode: 1x selection -> buffer (loop or not)', () => {
  assert.equal(playMode({ selection: { start: 5, end: 9 }, speed: 1, loop: false }), 'buffer');
  assert.equal(playMode({ selection: { start: 5, end: 9 }, speed: 1, loop: true }), 'buffer');
});

test('playMode: 0.75x selection -> element', () => {
  assert.equal(playMode({ selection: { start: 5, end: 9 }, speed: 0.75, loop: false }), 'element');
});

test('playMode: 0.5x selection with loop -> element', () => {
  assert.equal(playMode({ selection: { start: 5, end: 9 }, speed: 0.5, loop: true }), 'element');
});

test('playMode: 0.25x selection -> element', () => {
  assert.equal(playMode({ selection: { start: 5, end: 9 }, speed: 0.25, loop: false }), 'element');
});

test('playMode: slow but no selection or too long -> still full', () => {
  assert.equal(playMode({ selection: null, speed: 0.5, loop: true }), 'full');
  assert.equal(playMode({ selection: { start: 0, end: 700 }, speed: 0.5, loop: true }), 'full');
});

test('shouldRestart: no selection -> loop is as good as off (full play ends)', () => {
  assert.equal(shouldRestart({ loop: true, mode: 'full', selection: null }), false);
});

test('shouldRestart: >600 s selection played in full mode restarts only with loop on', () => {
  const sel = { start: 0, end: 700 };
  assert.equal(shouldRestart({ loop: true, mode: 'full', selection: sel }), true);
  assert.equal(shouldRestart({ loop: false, mode: 'full', selection: sel }), false);
});

test('shouldRestart: buffer/element loop on their own, never restart here', () => {
  const sel = { start: 5, end: 9 };
  assert.equal(shouldRestart({ loop: true, mode: 'buffer', selection: sel }), false);
  assert.equal(shouldRestart({ loop: true, mode: 'element', selection: sel }), false);
});

test('needsReload: an audible track that is not loaded yet forces a restart', () => {
  assert.equal(needsReload(new Set(['orig', 'me']), ['orig']), true);
  assert.equal(needsReload(new Set(['orig']), ['orig', 'me']), false); // 껐을 뿐이면 소리 크기만 바꾼다
  assert.equal(needsReload(new Set(), ['orig']), false);
});

test('activeTracks: a one-off chosen list wins over the mix, an empty one does not', () => {
  const mix = new Set(['orig']);
  assert.deepEqual([...activeTracks(new Set(['partner']), mix)], ['partner']);
  assert.equal(activeTracks(null, mix), mix);
  assert.equal(activeTracks(new Set(), mix), mix);
});
