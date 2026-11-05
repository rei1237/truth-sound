import test from 'node:test';
import assert from 'node:assert/strict';
import {report,bundleReport} from '../../web/report.js';
import {unzipSync,strFromU8} from '../../web/vendor/fflate.mjs';

test('same review snapshot ties DOCX to the audit; excluded speech stays only in the audit',async()=>{
  const file={name:'합성.wav',hash:'a'.repeat(64),bytes:32000,samples:new Float32Array(16000)};
  const included={id:'r1',start:0,end:0.5,speaker:'김화자',text:'수정한 발화',aiText:'원래 후보',reviewedAt:'2026-11-05T01:00:00Z',input:'original'};
  const omitted={...included,id:'r2',start:0.5,end:1,text:'제외한 발화',excluded:true};
  const make=rows=>report(file,rows,[{action:'구간 녹취 완료'}],{caseName:'합성 예제'});
  const before=await make([included,omitted]);
  assert.equal(before.status,'원본 대조 검수 완료');
  assert.equal(before.scope,'부분 녹취 또는 직접 작성');
  assert.equal((await make([included,omitted])).reviewHash,before.reviewHash);
  const zip=unzipSync(new Uint8Array(await (await bundleReport(before)).arrayBuffer()));
  const audit=JSON.parse(strFromU8(zip['처리기록.json']));
  const doc=strFromU8(unzipSync(zip['녹취록.docx'])['word/document.xml']);
  assert.ok(doc.includes(audit.reviewHash) && doc.includes(file.hash));
  assert.ok(doc.includes('김화자') && doc.includes('수정한 발화') && !doc.includes('제외한 발화'));
  assert.equal(audit.rows[0].aiText,'원래 후보');
  assert.equal(audit.rows[1].excluded,true);
  const edited=await make([{...included,text:'다시 수정',reviewedAt:null},omitted]);
  assert.equal(edited.status,'검수 전 초안');
  assert.notEqual(edited.reviewHash,audit.reviewHash);
});

test('audit keeps both enhancement hashes and the profile used for each transcript row',async()=>{
  const versions={standard:{metadata:{profile:'standard',sha256:'s'}},strong:{metadata:{profile:'strong',sha256:'l'}}};
  const file={name:'합성.wav',hash:'a',bytes:32000,samples:new Float32Array(16000),versions,full:versions.standard};
  const row={id:'r1',start:0,end:1,text:'검수 전',variant:{mode:'full',profile:'strong'}};
  const record=await report(file,[row],[],{});
  assert.equal(record.processing.fullEnhancement.profile,'standard');
  assert.equal(record.processing.enhancementVersions[record.rows[0].variant.profile].sha256,'l');
  assert.equal(record.processing.enhancementVersions.standard.sha256,'s');
});
