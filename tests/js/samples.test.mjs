import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ENROLL, GOOD_ENROLL, TINY_SEC, CLIP_WARN_PERCENT, OVERLAP_ERROR,
  addRange, resizeRange, removeRange, restoreRange, isTiny, enrollProblem, enrollAdvice, totalSeconds, snapMs, createClipCheck, processBlock, transcribeBlock, STAGES, jobPercent, stagesFor, locksEditing,
} from '../../truth_sound/static/editor/samples.js';

// 사람 셋(나·상대방·옆 사람). ranges는 id → 구간 목록
const sp = (me = [], partner = [], bystander = []) => [
  { id: 'me', name: '나', enroll: me },
  { id: 'partner', name: '상대방', enroll: partner },
  { id: 'bystander', name: '옆 사람', enroll: bystander },
];
const two = sp([[1, 2]], [[5, 6]]);
const enrollOf = (speakers, id) => speakers.find((s) => s.id === id).enroll;

test('constants', () => {
  assert.equal(MIN_ENROLL, 0.2);
  assert.equal(GOOD_ENROLL, 2.0);
  assert.equal(TINY_SEC, 0.05);
  assert.equal(CLIP_WARN_PERCENT, 1);
});

test('same speaker overlap merges', () => assert.deepEqual(addRange(sp([[1, 2]]), 'me', 1.5, 3).speakers[0].enroll, [[1, 3]]));

test('same speaker touching merges', () => {
  const r = addRange(sp([[1, 2]]), 'me', 2, 3);
  assert.equal(r.error, null);
  assert.deepEqual(r.speakers[0].enroll, [[1, 3]]);
});

test('new range bridging two ranges merges all three', () => {
  assert.deepEqual(addRange(sp([[1, 2], [3, 4]]), 'me', 1.5, 3.5).speakers[0].enroll, [[1, 4]]);
});

test('separate range is added in time order', () => {
  assert.deepEqual(addRange(sp([[1, 2], [8, 9]]), 'me', 4, 5).speakers[0].enroll, [[1, 2], [4, 5], [8, 9]]);
});

test('cross speaker overlap blocked', () => assert.equal(addRange(two, 'partner', 1.5, 1.8).error, '다른 사람의 샘플과 겹칩니다'));

test('cross speaker overlap leaves speakers unchanged', () => {
  const r = addRange(two, 'partner', 1.5, 1.8);
  assert.equal(r.speakers, two);
  assert.equal(OVERLAP_ERROR, '다른 사람의 샘플과 겹칩니다');
});

test('cross speaker that only touches is allowed', () => {
  const r = addRange(two, 'partner', 2, 3);
  assert.equal(r.error, null);
  assert.deepEqual(enrollOf(r.speakers, 'partner'), [[2, 3], [5, 6]]);
});

test('addRange leaves untouched nested tiny range as is', () => { // Review Focus 1
  const s = [{ id: 'me', name: '나', enroll: [[0.5, 3.0], [1.0, 1.001]] }, { id: 'partner', name: '상대방', enroll: [] }];
  const r = addRange(s, 'partner', 5, 6);
  assert.deepEqual(r.speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001]]);
});

test('addRange to the same speaker keeps an untouched nested tiny range', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001]]);
  const r = addRange(s, 'me', 5, 6);
  assert.deepEqual(r.speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001], [5, 6]]);
});

test('untouched speakers keep the same object, untouched ranges the same values', () => {
  const s = sp([[0.1234567, 0.2345678]], [[5, 6]]);
  const r = addRange(s, 'partner', 7, 8);
  assert.equal(r.speakers[0], s[0]); // 건드리지 않은 사람은 같은 객체
  assert.deepEqual(r.speakers[0].enroll, [[0.1234567, 0.2345678]]);
  assert.deepEqual(r.speakers[1].enroll, [[5, 6], [7, 8]]);
});

test('addRange does not mutate its input', () => {
  const s = sp([[1, 2]]);
  const copy = JSON.parse(JSON.stringify(s));
  addRange(s, 'me', 1.5, 3);
  assert.deepEqual(s, copy);
});

test('addRange does not round the new range', () => {
  assert.deepEqual(addRange(sp(), 'me', 0.1234567, 0.1234999).speakers[0].enroll, [[0.1234567, 0.1234999]]);
});

test('bad input is rejected with an error, nothing changes', () => {
  const s = sp([[1, 2]]);
  for (const [a, b] of [[3, 3], [4, 3], [NaN, 3], [1, Infinity], [undefined, 2]]) {
    const r = addRange(s, 'me', a, b);
    assert.equal(typeof r.error, 'string');
    assert.equal(r.speakers, s);
  }
  assert.equal(typeof addRange(s, 'nobody', 1, 2).error, 'string');
});

test('tiny ranges kept, flagged', () => {
  const r = addRange(sp(), 'me', 0.931, 0.932);
  assert.equal(r.error, null);
  assert.deepEqual(r.speakers[0].enroll, [[0.931, 0.932]]); // 1ms 구간도 지우거나 늘리지 않는다
  assert.equal(isTiny([0.931, 0.932]), true);
  assert.equal(isTiny([0, 0.049]), true);
  assert.equal(isTiny([0, TINY_SEC]), false);
  assert.equal(isTiny([0.931, 0.981]), false); // 부동소수 오차(0.04999…)로 잘못 짧다고 하지 않는다
  assert.equal(isTiny([1, 3]), false);
});

test('snapMs rounds to a millisecond like the server stores it', () => {
  assert.equal(snapMs(0.9314), 0.931);
  assert.equal(snapMs(0.9316), 0.932);
  assert.equal(snapMs(2), 2);
});

test('resizeRange stretches a range', () => {
  const r = resizeRange(sp([[1, 2]]), 'me', 0, 0.5, 2.5);
  assert.equal(r.error, null);
  assert.deepEqual(r.speakers[0].enroll, [[0.5, 2.5]]);
});

test('resizeRange merges with a neighbour it now touches', () => {
  const r = resizeRange(sp([[1, 2], [3, 4]]), 'me', 0, 1, 3.2);
  assert.deepEqual(r.speakers[0].enroll, [[1, 4]]);
});

test('resizeRange blocks growing into another speaker', () => {
  const r = resizeRange(two, 'me', 0, 1, 5.5);
  assert.equal(r.error, OVERLAP_ERROR);
  assert.equal(r.speakers, two);
});

test('resizeRange shrinking keeps the other ranges as they were', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001]]);
  const r = resizeRange(s, 'me', 0, 0.6, 2.9);
  assert.deepEqual(r.speakers[0].enroll, [[0.6, 2.9], [1.0, 1.001]]);
});

test('resizeRange with a bad index or a bad range is an error', () => {
  const s = sp([[1, 2]]);
  assert.equal(typeof resizeRange(s, 'me', 5, 1, 2).error, 'string');
  assert.equal(typeof resizeRange(s, 'me', 0, 2, 1).error, 'string');
  assert.equal(resizeRange(s, 'me', 0, 2, 1).speakers, s);
});

test('remove has undo', () => {
  const s = sp([[1, 2], [3, 4]]);
  const copy = JSON.parse(JSON.stringify(s));
  const r = removeRange(s, 'me', 0);
  assert.deepEqual(enrollOf(r.speakers, 'me'), [[3, 4]]);
  assert.deepEqual(r.removed, [1, 2]);
  assert.deepEqual(s, copy); // 입력은 그대로
  assert.deepEqual(r.undo(), copy);
});

test('remove of a missing range changes nothing', () => {
  const s = sp([[1, 2]]);
  const r = removeRange(s, 'me', 3);
  assert.equal(r.speakers, s);
  assert.equal(r.undo(), s);
});

test('totalSeconds adds the lengths', () => {
  assert.equal(totalSeconds([]), 0);
  assert.ok(Math.abs(totalSeconds([[1, 2], [3, 3.5]]) - 1.5) < 1e-9);
});

test('enrollProblem needs 0.2s each', () => {
  assert.match(enrollProblem(sp()), /0명/);
  assert.match(enrollProblem(sp([[1, 3]])), /1명/);
  assert.equal(enrollProblem(sp([[1, 3]], [[5, 7]])), null);
  const short = enrollProblem(sp([[1, 3]], [[5, 5.1]]));
  assert.match(short, /상대방/);
  assert.match(short, /0\.2초/);
  assert.equal(enrollProblem(sp([[1, 3]], [[5, 5.2]], [[7, 8]])), null);
  assert.equal(enrollProblem(sp([[1, 3]], [[5, 5.3]])), null);
});

test('enrollProblem counts only people who have a range', () => {
  assert.equal(enrollProblem(sp([[1, 3]], [[5, 7]], [])), null);
});

test('enrollAdvice recommends 2.0s', () => {
  assert.equal(enrollAdvice(sp([[1, 4]], [[5, 8]])), null);
  const a = enrollAdvice(sp([[1, 4]], [[5, 5.5]]));
  assert.match(a, /상대방/);
  assert.match(a, /2초/);
  assert.equal(enrollAdvice(sp()), null); // 지정한 사람이 없으면 조언할 것이 없다
});

test('clip check asks analyze on the original track and caches', async () => {
  const urls = [];
  const api = { get: async (u) => { urls.push(u); return { clipped_percent: 2.5 }; } };
  const clip = createClipCheck(api, '/api/cases/c1');
  assert.equal(clip.percent([1, 2]), undefined);
  assert.equal(await clip.ensure([1, 2]), 2.5);
  assert.equal(await clip.ensure([1, 2]), 2.5);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], '/api/cases/c1/analyze?track=orig&start=1&end=2');
  assert.equal(clip.percent([1, 2]), 2.5);
  assert.equal(clip.isClipped([1, 2]), true);
});

test('clip check: below 1% is not a warning, exactly 1% is', async () => {
  const pct = { '1:2': 0.99, '3:4': 1 };
  const clip = createClipCheck({ get: async (u) => ({ clipped_percent: pct[/start=([\d.]+)&end=([\d.]+)/.exec(u).slice(1).join(':')] }) }, '/b');
  await clip.ensure([1, 2]);
  await clip.ensure([3, 4]);
  assert.equal(clip.isClipped([1, 2]), false);
  assert.equal(clip.isClipped([3, 4]), true);
});

test('clip check tolerates a failed request and does not ask again', async () => {
  let calls = 0;
  const clip = createClipCheck({ get: async () => { calls++; throw new Error('too short'); } }, '/b');
  assert.equal(await clip.ensure([1, 1.001]), null);
  assert.equal(await clip.ensure([1, 1.001]), null);
  assert.equal(calls, 1);
  assert.equal(clip.isClipped([1, 1.001]), false); // 모르면 경고하지 않는다
});

test('clip check shares one request between simultaneous asks and notifies', async () => {
  let calls = 0;
  const clip = createClipCheck({ get: async () => { calls++; return { clipped_percent: 0 }; } }, '/b');
  let notified = 0;
  const off = clip.subscribe(() => { notified++; });
  await Promise.all([clip.ensure([1, 2]), clip.ensure([1, 2])]);
  assert.equal(calls, 1);
  assert.equal(notified, 1);
  off();
  await clip.ensure([3, 4]);
  assert.equal(notified, 1);
});

test('a tiny range inside a new bigger range is not swallowed by the merge', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001]]);
  assert.deepEqual(addRange(s, 'me', 0.9, 1.1).speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001]]);
  const t = sp([[0.931, 0.932], [4, 5]]);
  assert.deepEqual(addRange(t, 'me', 0.5, 1.5).speakers[0].enroll, [[0.5, 1.5], [0.931, 0.932], [4, 5]]);
});

test('a tiny range that sticks out of the new range is merged (nothing is lost, the audio stays covered)', () => {
  assert.deepEqual(addRange(sp([[1.9995, 2.0005]]), 'me', 1, 2).speakers[0].enroll, [[1, 2.0005]]);
});

// ---- 수정 1차: 같은 짧은 구간 중복 막기, 되돌리기는 그대로 복원 ----
test('addRange of the exact same tiny range does not duplicate it', () => {
  const s = sp([[0.931, 0.932]]);
  const r = addRange(s, 'me', 0.931, 0.932);
  assert.equal(r.error, null);
  assert.deepEqual(r.speakers[0].enroll, [[0.931, 0.932]]);
  assert.deepEqual(addRange(r.speakers, 'me', 0.931, 0.932).speakers[0].enroll, [[0.931, 0.932]]); // 두 번 눌러도 하나
});

test('addRange of the same tiny range next to a nested one keeps each once', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001]]);
  assert.deepEqual(addRange(s, 'me', 1.0, 1.001).speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001]]);
});

test('restoreRange puts a nested tiny range back as its own entry with exact values', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001], [4, 5]]);
  const gone = removeRange(s, 'me', 1);
  assert.deepEqual(gone.speakers[0].enroll, [[0.5, 3.0], [4, 5]]);
  const back = restoreRange(gone.speakers, 'me', gone.removed);
  assert.equal(back.error, null);
  assert.deepEqual(back.speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001], [4, 5]]);
  assert.equal(back.speakers[0].enroll[1][0], 1.0);
  assert.equal(back.speakers[0].enroll[1][1], 1.001);
});

test('restoreRange is a no-op when the exact range is already there', () => {
  const s = sp([[0.5, 3.0], [1.0, 1.001]]);
  assert.deepEqual(restoreRange(s, 'me', [1.0, 1.001]).speakers[0].enroll, [[0.5, 3.0], [1.0, 1.001]]);
});

test('restoreRange refuses a range that now overlaps another speaker, and changes nothing', () => {
  const s = sp([], [[1, 2]]);
  const r = restoreRange(s, 'me', [1.5, 1.6]);
  assert.equal(r.error, OVERLAP_ERROR);
  assert.equal(r.speakers, s);
});

test('restoreRange merges a normal (not tiny) range into an overlapping one so the sum is not double counted', () => {
  const s = sp([[1, 5]]);
  assert.deepEqual(restoreRange(s, 'me', [2, 3]).speakers[0].enroll, [[1, 5]]);
  assert.deepEqual(restoreRange(sp([[1, 2]]), 'me', [3, 4]).speakers[0].enroll, [[1, 2], [3, 4]]);
});

test('resizing a range onto exactly another existing range leaves one copy', () => {
  const s = sp([[0.931, 0.932], [2, 2.001]]);
  assert.deepEqual(resizeRange(s, 'me', 1, 0.931, 0.932).speakers[0].enroll, [[0.931, 0.932]]);
});

// ---- 수정 2차: 합친 구간 안에 든 짧은 구간은 가장자리에 걸쳐 있어도 따로 지킨다 ----
test('restoreRange keeps a tiny range that lies inside the merged span even if it straddles the new edge', () => {
  const s = sp([[2.5, 6], [2.9995, 3.0005]]);
  assert.deepEqual(restoreRange(s, 'me', [1, 3]).speakers[0].enroll, [[1, 6], [2.9995, 3.0005]]);
});

test('addRange keeps a tiny range that lies inside the merged span even if it straddles the new edge', () => {
  const s = sp([[2.5, 6], [2.9995, 3.0005]]);
  assert.deepEqual(addRange(s, 'me', 1, 3).speakers[0].enroll, [[1, 6], [2.9995, 3.0005]]);
});

test('resizeRange keeps a tiny range that lies inside the merged span even if it straddles the new edge', () => {
  const s = sp([[0.5, 0.9], [2.5, 6], [2.9995, 3.0005]]);
  assert.deepEqual(resizeRange(s, 'me', 0, 1, 3).speakers[0].enroll, [[1, 6], [2.9995, 3.0005]]);
});

// ---- 처리 단추: 못 누르는 이유 ----
const ready = sp([[1, 2]], [[5, 6]]);
const idle = { state: 'idle', case_id: null };

test('processBlock gives the enroll problem when a person has no sample', () => {
  const r = processBlock({ speakers: sp([[1, 2]]), job: idle, caseId: 'c1' });
  assert.equal(r, enrollProblem(sp([[1, 2]])));
  assert.match(r, /화자 분리는 2명 또는 3명/);
  assert.match(r, /녹취록만 만들려면 \[녹취록 만들기\]를 누르세요/);
  assert.match(r, /샘플이 1명뿐이어도 가능합니다/);
});

test('processBlock says another recording is being processed', () => {
  const r = processBlock({ speakers: ready, job: { state: 'running', case_id: 'other' }, caseId: 'c1' });
  assert.equal(r, '다른 녹음을 처리하는 중입니다. 그 처리가 끝난 뒤 시작할 수 있습니다.');
});

test('processBlock says this recording is already being processed', () => {
  const r = processBlock({ speakers: ready, job: { state: 'running', case_id: 'c1' }, caseId: 'c1' });
  assert.equal(r, '이 녹음을 처리하는 중입니다.');
});

test('processBlock is null when ready, also for a finished or failed job and an unknown job', () => {
  assert.equal(processBlock({ speakers: ready, job: idle, caseId: 'c1' }), null);
  assert.equal(processBlock({ speakers: ready, job: { state: 'done', case_id: 'other' }, caseId: 'c1' }), null);
  assert.equal(processBlock({ speakers: ready, job: { state: 'error', case_id: 'c1' }, caseId: 'c1' }), null);
  assert.equal(processBlock({ speakers: ready, job: null, caseId: 'c1' }), null);
});

// ---- 처리 띠: 단계 가중치로 전체 진행률 ----
test('STAGES keep the old weights', () => {
  assert.deepEqual(STAGES, [['확인', 2], ['준비', 3], ['목소리 분리', 45], ['음성 보정', 5], ['받아쓰기', 40], ['정리', 5]]);
});

test('jobPercent weights the stages and finishes at 100', () => {
  assert.equal(jobPercent({ state: 'running', stage: '대기', progress: 0 }), 0);
  assert.equal(jobPercent({ state: 'running', stage: '확인', progress: 1 }), 2);
  assert.ok(Math.abs(jobPercent({ state: 'running', stage: '목소리 분리', progress: 0.5 }) - 27.5) < 1e-9);
  assert.equal(jobPercent({ state: 'done', stage: '정리', progress: 1 }), 100);
});

test('stagesFor: kind마다 자기 단계를 고른다', () => {
  assert.deepEqual(stagesFor('process').map(([n]) => n), ['확인', '준비', '목소리 분리', '음성 보정', '받아쓰기', '정리']);
  assert.deepEqual(stagesFor('transcribe').map(([n]) => n), ['확인', '준비', '받아쓰기', '정리']);
  assert.deepEqual(stagesFor('clarify', 'denoise').map(([n]) => n), ['확인', '잡음 제거', '정리']);
  assert.deepEqual(stagesFor('clarify', 'repair').map(([n]) => n), ['확인', '손상 찾기', '보완', '정리']);
  assert.deepEqual(stagesFor(undefined), STAGES, 'kind를 모르는 옛 작업은 process로 본다');
});

test('jobPercent: transcribe의 받아쓰기 절반은 process 비중을 쓰지 않는다', () => {
  assert.ok(jobPercent({ state: 'running', kind: 'transcribe', stage: '받아쓰기', progress: 0.5 }) > 45);
  assert.ok(Math.abs(jobPercent({ state: 'running', kind: 'transcribe', stage: '받아쓰기', progress: 0.5 }) - 50) < 1e-9);
  assert.ok(Math.abs(jobPercent({ state: 'running', kind: 'clarify', step: 'denoise', stage: '잡음 제거', progress: 0.5 }) - 50) < 1e-9);
  assert.ok(Math.abs(jobPercent({ state: 'running', kind: 'clarify', step: 'repair', stage: '보완', progress: 0.5 }) - 55) < 1e-9);
  assert.equal(jobPercent({ state: 'done', kind: 'transcribe', stage: '정리', progress: 1 }), 100);
});

test('locksEditing: clarify는 잠그지 않고 process·transcribe는 잠근다', () => {
  const job = (kind, over = {}) => ({ state: 'running', case_id: 'c1', kind, ...over });
  assert.equal(locksEditing(job('process'), 'c1'), true);
  assert.equal(locksEditing(job('transcribe'), 'c1'), true);
  assert.equal(locksEditing(job('clarify'), 'c1'), false);
  assert.equal(locksEditing(job('process'), 'c2'), false, '다른 사건은 잠그지 않는다');
  assert.equal(locksEditing(job('process', { state: 'done' }), 'c1'), false);
  assert.equal(locksEditing(job(undefined), 'c1'), true, 'kind를 모르는 옛 작업은 process로 본다');
  assert.equal(locksEditing(null, 'c1'), false);
});

test('transcribeBlock: 샘플이 없어도 null, 작업 중이면 이유', () => {
  assert.equal(transcribeBlock({ job: idle, caseId: 'c1' }), null);
  assert.equal(transcribeBlock({ job: null, caseId: 'c1' }), null);
  assert.equal(transcribeBlock({ job: { state: 'done', case_id: 'c1' }, caseId: 'c1' }), null);
  assert.equal(transcribeBlock({ job: { state: 'running', case_id: 'c1' }, caseId: 'c1' }), '이 녹음을 처리하는 중입니다.');
  assert.equal(transcribeBlock({ job: { state: 'running', case_id: 'other' }, caseId: 'c1' }), '다른 녹음을 처리하는 중입니다. 그 처리가 끝난 뒤 시작할 수 있습니다.');
});
