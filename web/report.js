export const formatTime=t=>{
  const ms=Math.max(0,Math.round(t*1000)),s=Math.floor(ms/1000);
  return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(v=>String(v).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');
};
export const effectiveSpeaker=r=>r.speaker||r.suggestion||'화자 미상';
export function download(blob,name){
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function report(source,rows,events,details){
  const ordered=rows.map(row=>({...row})).sort((a,b)=>a.start-b.start||a.end-b.end);
  const included=ordered.filter(row=>!row.excluded);
  const record={
    schema:'truth-sound-review/1',createdAt:new Date().toISOString(),details,
    original:{filename:source.name,bytes:source.bytes,durationSeconds:source.samples.length/16000,sha256:source.hash},
    status:included.length && included.every(r=>r.reviewedAt&&r.text.trim())?'원본 대조 검수 완료':'검수 전 초안',
    processing:{transcription:'Xenova/whisper-base · 한국어 · 브라우저',modelRevision:'64da57285918e20ea79ea5c88eed7197933abaa8',
      clock:'원본 시작 기준 초',sampleRate:16000,fullEnhancement:source.full?.metadata??null,
      speakerEstimation:events.some(e=>e.action==='화자 추정 완료')?'WeSpeaker ResNet34-LM f0c48c298fd835726c27956a5d617bad7115627e · 구간별 음색 유사도 추정':null},
    rows:structuredClone(ordered),events:structuredClone(events)
  };
  record.scope=events.some(e=>e.action==='전체 녹취 완료')?'전체 녹음에 대한 인식 실행':'부분 녹취 또는 직접 작성';
  const {createdAt,...state}=record;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(state)));
  record.reviewHash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  return record;
}
export function textReport(record){
  const rows=record.rows.filter(r=>!r.excluded);
  return ['Truth Sound 녹취록 · '+record.status,record.original.filename,'SHA-256 '+record.original.sha256,'',
    ...rows.map(r=>'['+formatTime(r.start)+' – '+formatTime(r.end)+'] '+effectiveSpeaker(r)+' · '+(r.reviewedAt?'검수 완료':'검수 전')+' · '+(r.text||'[판독 불가]'))].join('\r\n');
}
export async function bundleReport(record){
  const {zipSync,strToU8}=await import('./vendor/fflate.mjs');
  const doc=await wordReport(record);
  const bytes=zipSync({'녹취록.docx':new Uint8Array(await doc.arrayBuffer()),
    '처리기록.json':strToU8(JSON.stringify(record,null,2))},{level:0});
  return new Blob([bytes],{type:'application/zip'});
}
export async function wordReport(record){
  const {Document,Packer,Paragraph,TextRun,PageNumber,Footer,AlignmentType,HeadingLevel}=await import('./vendor/docx.mjs');
  const {original:o,details,rows}=record, included=rows.filter(r=>!r.excluded);
  const p=(text,opts={})=>new Paragraph({text,...opts});
  const line=(label,value)=>new Paragraph({children:[new TextRun({text:label+'  ',bold:true}),new TextRun(String(value))]});
  const body=[p(record.status==='검수 전 초안'?'녹취록 검수 전 초안':'녹취록',{heading:HeadingLevel.TITLE}),
    p('원본 녹음의 시간 순서대로 기재한 녹취록입니다. 인공지능이 생성한 후보를 바탕으로 작성한 줄과 직접 작성한 줄의 이력은 처리 기록에서 확인할 수 있습니다.')];
  if(details.caseName)body.push(line('사건명 또는 사건번호',details.caseName));
  if(details.reviewer)body.push(line('검수자 (직접 입력)',details.reviewer));
  body.push(line('원본 파일',o.filename),line('원본 길이',formatTime(o.durationSeconds)),line('원본 SHA-256',o.sha256),
    line('검수본 식별값 (SHA-256)',record.reviewHash),line('녹취 범위',record.scope),line('문서 작성 시각',record.createdAt),line('검수 상태',record.status+' · 수록 '+included.length+'줄 중 '+included.filter(r=>r.reviewedAt).length+'줄 원본 대조'),
    line('화자 표기',Array.from(new Set(included.map(effectiveSpeaker))).join(', ')||'없음'),
    p('녹취 내용',{heading:HeadingLevel.HEADING_1}));
  for(const r of included){
    const origin=r.input==='full-clarity'?' · 전체 보정본 인식':r.input==='clarified'?' · 발음 선명화 신호 인식':r.input==='amplified'?' · 확대 신호 인식':'';
    body.push(p(formatTime(r.start)+' – '+formatTime(r.end)+'   '+effectiveSpeaker(r)+'   · '+(r.reviewedAt?'검수 완료':'검수 전')+origin,{keepNext:true}),
      ...((r.text.trim()||'[판독 불가]').split(/\r?\n/).map(t=>p(t,{spacing:{after:140}}))));
  }
  if(!included.length)body.push(p('[수록된 발화 없음]'));
  body.push(p('작성 기준',{heading:HeadingLevel.HEADING_1}),p('시각은 원본 녹음의 시작을 기준으로 합니다. 화자 이름은 사용자의 기재 또는 음색에 따른 추정입니다. 확실히 식별하기 어려운 내용은 [판독 불가]로 표시할 수 있습니다.'),
    p('검수 완료는 해당 줄의 원본을 재생한 뒤 사용자가 확인했다는 뜻입니다. 제외된 줄과 수정 이력은 별도 JSON 처리 기록에 남습니다.'));
  const doc=new Document({creator:'Truth Sound',title:'녹취록',styles:{default:{document:{run:{font:'맑은 고딕',size:22},paragraph:{spacing:{after:90}}}}},
    sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1250,bottom:1250,left:1350,right:1350}}},
      footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({children:['녹취록  ·  ',PageNumber.CURRENT]})]})]})},children:body}]});
  return Packer.toBlob(doc);
}
