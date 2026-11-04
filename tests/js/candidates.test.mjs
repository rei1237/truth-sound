import test from 'node:test';
import assert from 'node:assert/strict';
import {pairCandidates} from '../../web/candidates.js';
import {textReport,report} from '../../web/report.js';
const s=(start,end,text)=>({start,end,text});
test('one unavailable pass does not merge unrelated utterances on the other side',()=>{
 const rows=pairCandidates([s(0,5,'[인식 실패]')],[s(0,2,'첫째'),s(3,5,'둘째')]);
 assert.equal(rows.length,2);assert.equal(rows[1].candidates.original,'[인식 실패]');
 assert.deepEqual(rows.map(r=>r.text),['','']);
});
test('align on audio time, preserve unmatched speech, and leave disagreements undecided',()=>{
 const pairs=pairCandidates([s(0,1,'먼저'),s(2,4,'확인해 주세요'),s(5,6,'네.')],[s(2.1,4.2,'확인해 볼게요'),s(5.1,6,'네')]);
 assert.equal(pairs.length,3);
 assert.equal(pairs[0].candidates.enhanced,null);
 assert.deepEqual([pairs[1].start,pairs[1].end,pairs[1].text],[2,4.2,'']);
 assert.equal(pairs[1].candidates.original,'확인해 주세요');assert.equal(pairs[1].candidates.enhanced,'확인해 볼게요');
 assert.equal(pairs[2].candidates.different,false);
});
test('one long hypothesis is compared with both short ones once; numbers remain meaningful',()=>{
 const [row]=pairCandidates([s(0,2,'금액은 1.5')],[s(0,.8,'금액은'),s(.8,2,'15')]);
 assert.equal(row.candidates.enhanced,'금액은 15');assert.equal(row.candidates.spans.length,3);assert.equal(row.text,'');
});
test('unresolved alternatives export as a draft; corrections preserve both initial candidates',async()=>{
 const [row]=pairCandidates([s(0,1,'주세요')],[s(0,1,'볼게요')]);row.input='dual';
 const src={name:'test',samples:new Float32Array(16000),hash:'0',bytes:1};
 const before=await report(src,[row],[],{});assert.match(textReport(before),/후보 불일치/);assert.match(textReport(before),/보정본: 볼게요/);
 row.text='확인해 주세요';const after=await report(src,[row],[],{});
 assert.match(textReport(after),/확인해 주세요/);assert.equal(after.rows[0].candidates.enhanced,'볼게요');assert.equal(after.status,'검수 전 초안');
});
