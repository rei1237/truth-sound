import {bundleReport,download,effectiveSpeaker,formatTime,report,textReport,wordReport} from './report.js?v=strong1';
import {readPcm,waveBlob,fullVersion} from './full-audio.js?v=max1';
const $=id=>document.getElementById(id);
const now=()=>new Date().toISOString();
function el(tag,text=''){const node=document.createElement(tag);node.textContent=text;return node;}
function button(title,action){const b=el('button',title);b.className='sub';b.type='button';b.onclick=action;return b;}
export function createReview(getSource,getRange,reviewAudio){
  let rows=[],events=[],speakerWorker=null,listening=null,locked=false,nextId=1;
  const original=$('original'), status=$('reviewStatus');
  const log=(action,data={})=>events.push({at:now(),action,...data});
  let preview=null,previewUrl='',playRevision=0,frame=0;
  function stopPreview(){
    playRevision++;if(preview){preview.pause();preview=null;}
    if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';
  }
  for(const id of ['original','enhanced','clip'])$(id).addEventListener('play',stopPreview);
  function clearPlayback(){
    stopPreview();cancelAnimationFrame(frame);
    if(listening){listening=null;original.pause();}
  }
  original.addEventListener('seeking',()=>{
    if(listening && Math.abs(original.currentTime-listening.start)>.08)clearPlayback();
  });
  function heard(){
    if(!listening || original.currentTime<listening.end-.015)return;
    const r=listening;clearPlayback();r.listenedAt=now();log('원본 구간 재생 완료',{id:r.id});
    status.textContent='원본 대조 후 이 줄의 검수 완료를 선택하세요.';
    const check=$('reviewRows').querySelector('[data-review="'+r.id+'"]');
    if(check)check.disabled=!r.text.trim()||r.excluded;
  }
  original.addEventListener('timeupdate',heard);original.addEventListener('ended',heard);
  async function listen(r){
    clearPlayback();if(r.end<=r.start){status.textContent='길이가 없는 구간입니다. 선택 구간으로 새 줄을 추가하세요.';return;}
    listening=r;original.currentTime=r.start;
    try{await original.play();const tick=()=>{if(listening!==r)return;heard();if(listening===r)frame=requestAnimationFrame(tick);};tick();}
    catch{clearPlayback();status.textContent='원본을 재생할 수 없습니다.';}
  }
  async function listenEnhanced(r){
    clearPlayback();for(const id of ['original','enhanced','clip'])$(id).pause();
    const token=playRevision;
    try{
      const blob=await reviewAudio(r);if(token!==playRevision)return;
      previewUrl=URL.createObjectURL(blob);preview=new Audio(previewUrl);preview.onended=stopPreview;
      preview.playbackRate=original.playbackRate;await preview.play();log('보정 구간 재생',{id:r.id,start:r.start,end:r.end});
    }catch{if(token===playRevision){stopPreview();status.textContent='보정 구간을 재생할 수 없습니다.';}}
  }
  function updateButtons(){
    const unavailable=!getSource()||locked||!!speakerWorker||!!getSource()?.processing;
    $('fullProfile').disabled=locked||!!speakerWorker||!!getSource()?.processing;
    for(const id of ['addLine','word','log','save','bundle'])$(id).disabled=unavailable;
    $('separate').disabled=unavailable||!getSource()?.full;
    if(!rows.length)$('word').disabled=$('bundle').disabled=true;
    $('reviewRows').disabled=locked||!!speakerWorker;
  }
  function reset(){
    clearPlayback();speakerWorker?.terminate();speakerWorker=null;rows=[];events=[];nextId=1;
    $('caseName').value=$('reviewer').value='';$('filter').value='';status.textContent=$('exportStatus').textContent='';paint();
  }
  function makeRow(start,end,text,input){
    return {id:'r'+nextId++,start,end,input,aiText:input==='manual'?null:text,text,speaker:'',suggestion:'',
      listenedAt:null,reviewedAt:null,excluded:false,createdAt:now()};
  }
  function add(start,end,text,input,candidates=null,variant=null){
    const r=makeRow(start,end,text,input);Object.assign(r,{candidates,variant});rows.push(r);
    log('발화 추가',{id:r.id,start,end,input,initialText:text,candidates,variant});paint();
  }
  function revise(r,key,value){
    if(r[key]===value)return;
    log('발화 수정',{id:r.id,field:key,before:r[key],after:value});
    r[key]=value;r.reviewedAt=null;
  }
  function split(r,caret){
    const t=Math.round(original.currentTime*1000)/1000;
    if(t<=r.start||t>=r.end){status.textContent='원본을 두 화자가 바뀌는 시각에 멈춘 뒤 다시 누르세요.';return;}
    clearPlayback();
    const child=makeRow(t,r.end,r.text.slice(caret).trim(),r.input);
    child.aiText=r.aiText;child.parentId=r.id;
    if(r.candidates){child.variant=r.variant;child.candidates=r.candidates;r.splitComparison=child.splitComparison=true;}
    log('발화 나누기',{id:r.id,childId:child.id,splitAt:t,beforeText:r.text,previousEnd:r.end,caret});
    r.end=t;r.text=r.text.slice(0,caret).trim();r.listenedAt=r.reviewedAt=null;
    rows.push(child);paint();
  }
  function labels(){
    const previous=$('filter').value, names=Array.from(new Set(rows.map(effectiveSpeaker)));
    const select=$('filter');select.replaceChildren(new Option('전체 화자',''));
    for(const name of names)select.add(new Option(name,name));select.value=names.includes(previous)?previous:'';
    $('names').replaceChildren(...names.map(n=>new Option(n)));
    const active=rows.filter(r=>!r.excluded);
    $('counts').textContent='수록 '+active.length+'줄 · 원본 대조 완료 '+active.filter(r=>r.reviewedAt).length+'줄';
  }
  function paint(){
    updateButtons();labels();
    paintSpeakerTracks();
    const select=$('filter');
    const cards=rows.slice().sort((a,b)=>a.start-b.start||a.end-b.end)
      .filter(r=>!select.value||effectiveSpeaker(r)===select.value).map(card);
    $('reviewRows').replaceChildren(...cards);
  }
  function paintSpeakerTracks(){
    const host=$('speakerTracks'),source=getSource();
    host.replaceChildren();
    if(!source?.full||!rows.some(r=>r.suggestion||r.speaker)&&!events.some(e=>['화자 추정 완료','화자 추정 대상 없음'].includes(e.action)))return;
    const groups=new Map(),duration=source.samples.length/16000;
    for(const r of rows.filter(r=>!r.excluded&&r.end>r.start).sort((a,b)=>a.start-b.start)){
      const label=effectiveSpeaker(r);
      if(!groups.has(label))groups.set(label,[]);
      groups.get(label).push(r);
    }
    for(const [name,items] of groups){
      const track=el('div');track.className='row transcriptLane';
      const controls=el('div');controls.className='ctl';
      const select=button(name+' · '+items.length+'구간',()=>{
        $('tab-transcript').click();$('filter').value=name;paint();
      });
      const save=button('구간 WAV 저장',()=>{
        const parts=[];let end=0,length=0;
        for(const r of items){
          const a=Math.max(end,Math.round(r.start*16000)),b=Math.min(source.samples.length,Math.round(r.end*16000));
          if(b<=a)continue;
          const version=r.variant?.mode==='full'?fullVersion(source,r):source.full;
          parts.push(version.blob.slice(44+a*2,44+b*2));length+=b-a;end=b;
        }
        download(waveBlob(parts,length),source.name+'-'+name+'-발화구간.wav');
        log('화자별 구간 WAV 저장',{speaker:name,rowIds:items.map(r=>r.id),
          versions:items.map(r=>({id:r.id,sha256:(r.variant?.mode==='full'?fullVersion(source,r):source.full).metadata.sha256}))});
      });
      save.title='이 화자로 추정된 보정본 구간을 이어 저장합니다. 겹친 목소리도 포함됩니다.';
      controls.append(select,save);
      const lane=el('div');lane.className='speakerLane';
      for(const r of items){
        const play=button(r.text||'후보 비교',()=>{
          $('tab-transcript').click();$('filter').value=name;paint();void listen(r);
        });
        play.style.left=(100*r.start/duration)+'%';play.style.width=(100*(r.end-r.start)/duration)+'%';
        play.title=name+' · '+formatTime(r.start)+' · 원본 구간 듣기';lane.append(play);
      }
      track.append(controls,lane);host.append(track);
    }
  }
  function card(r){
    const box=el('article');box.className='utterance';box.dataset.start=r.start;box.dataset.end=r.end;
    const head=el('div');head.className='rowhead';
    head.append(el('strong',formatTime(r.start)+' – '+formatTime(r.end)),button('▶ 원본 구간 듣기',()=>listen(r)));
    if(r.variant)head.append(button('보정 구간 듣기',()=>listenEnhanced(r)));
    const info=el('small',[r.candidates?(r.splitComparison?'나누기 전 후보 있음':r.candidates.different?'두 후보 다름':'두 후보 일치'):r.input==='manual'?'직접 작성':'AI 후보',
      r.suggestion?'자동 추정 '+r.suggestion:'',r.reviewedAt?'검수 완료':'검수 전',r.excluded?'문서 제외':''].filter(Boolean).join(' · '));
    const speaker=el('input');speaker.setAttribute('list','names');speaker.placeholder=r.suggestion||'화자 미상';speaker.value=r.speaker;
    const label=el('label','화자 이름 또는 번호');label.append(speaker);
    speaker.onchange=()=>{revise(r,'speaker',speaker.value.trim());paint();};
    const field=el('textarea');field.value=r.text;field.setAttribute('aria-label','발화 내용');field.rows=2;
    field.placeholder=r.candidates?.different?'두 후보를 듣고 선택하거나 직접 적으세요.':'발화 내용을 입력하세요.';
    field.oninput=()=>{if(r.reviewedAt){r.reviewedAt=null;review.checked=false;info.textContent='수정됨 · 재검수 필요';}
      r.text=field.value;review.disabled=!r.listenedAt||!r.text.trim()||r.excluded;labels();};
    let before=r.text;
    field.onchange=()=>{log('문구 수정',{id:r.id,before,after:r.text});before=r.text;review.disabled=!r.listenedAt||!r.text.trim()||r.excluded;};
    const check=el('label'),review=el('input');review.type='checkbox';review.checked=!!r.reviewedAt;
    review.dataset.review=r.id;
    review.disabled=!r.listenedAt||!r.text.trim()||r.excluded;
    review.onchange=()=>{if(review.checked && !r.speaker)r.speaker=effectiveSpeaker(r);r.reviewedAt=review.checked?now():null;log('검수 상태 변경',{id:r.id,reviewedAt:r.reviewedAt,speaker:effectiveSpeaker(r),text:r.text});paint();};
    check.append(review,document.createTextNode('원본 대조 검수 완료'));
    const omit=el('label'),exclude=el('input');exclude.type='checkbox';exclude.checked=r.excluded;
    exclude.onchange=()=>{revise(r,'excluded',exclude.checked);paint();};omit.append(exclude,document.createTextNode('문서에서 제외'));
    const actions=el('div');actions.className='rowactions';actions.append(check,omit,button('재생 위치에서 줄 나누기',()=>split(r,field.selectionStart)));
    box.append(head,info);
    if(r.candidates?.different&&!r.splitComparison){
      const choices=el('div');choices.className='candidatePair';
      for(const [side,name] of [['original','원본'],['enhanced','보정본']]){
        const group=el('div'),words=r.candidates[side];
        group.append(el('strong',name+' 후보'),el('p',words||'이 구간에서 인식된 문구 없음'));
        if(words){const use=button(name+' 후보 사용',()=>{
          log('후보 선택',{id:r.id,side,before:r.text,after:words});
          r.text=field.value=before=words;r.reviewedAt=null;review.checked=false;
          review.disabled=!r.listenedAt||r.excluded;labels();field.focus();
        });group.append(use);}
        choices.append(group);
      }
      box.append(choices);
    }
    box.append(label,field,actions);return box;
  }
  $('filter').onchange=paint;
  $('addLine').onclick=()=>{try{const [a,b]=getRange();add(a/16000,b/16000,'','manual');}catch(e){status.textContent=e.message;}};
  function cancelEstimate(){speakerWorker?.terminate();speakerWorker=null;updateButtons();}
  async function estimate(done=()=>{}){
    const source=getSource();
    if(speakerWorker||!source)return;
    const eligible=rows.filter(r=>!r.excluded&&!r.reviewedAt && r.end-r.start>=1.5 && !/^\[판독/.test(r.text)).sort((a,b)=>a.start-b.start);
    const usesFull=r=>r.variant?.mode==='full'||r.input==='full-clarity';
    function finish(message){cancelEstimate();status.textContent=message;paint();done(message);}
    if(!eligible.length){log('화자 추정 대상 없음');finish('자동으로 비교할 발화가 없습니다. 짧거나 불명확한 줄은 화자 미상으로 남깁니다.');return;}
    let job;
    try{
    job=speakerWorker=new Worker(new URL('./speakers.js',import.meta.url),{type:'module'});
    updateButtons();status.textContent='화자 모델을 준비하고 있습니다 (약 27MB).';
    speakerWorker.onerror=e=>finish('화자 추정 실패 · 직접 지정하거나 다시 시도하세요. '+e.message);
    speakerWorker.onmessage=({data})=>{
      if(data.progress)status.textContent='화자 비교 중 · '+data.progress;
      if(data.error)finish('화자 추정 실패 · '+data.error);
      if(data.results){
        const byId=new Map(data.results.map(x=>[x.id,x.label]));
        for(const row of rows)if(!row.reviewedAt && byId.has(row.id))row.suggestion=byId.get(row.id);
        log('화자 추정 완료',{results:data.results,inputs:eligible.map(r=>({id:r.id,input:usesFull(r)?'full-clarity':'original'}))});finish('화자별 초안을 작성했습니다. 원본을 듣고 화자와 문구를 확인하세요.');
      }
    };
    const items=[];
    for(const r of eligible){
      const center=(r.start+r.end)/2,a=Math.round(Math.max(r.start,center-2.5)*16000),b=Math.round(Math.min(r.end,center+2.5)*16000);
      const samples=usesFull(r)?await readPcm(fullVersion(source,r).blob,a,b):source.samples.slice(a,b);
      if(speakerWorker!==job)return;
      items.push({id:r.id,samples});
    }
    job.postMessage(items,items.map(i=>i.samples.buffer));
    }catch(e){if(speakerWorker===job||!job)finish('화자 추정 실패 · '+e.message);}
  }
  async function save(kind){
    const data=await report(getSource(),rows,events,{caseName:$('caseName').value.trim(),reviewer:$('reviewer').value.trim()});
    const prefix=data.original.filename+'-'+data.status;
    try{
      if(kind==='bundle')download(await bundleReport(data),prefix+'-제출자료.zip');
      if(kind==='word')download(await wordReport(data),prefix+'.docx');
      if(kind==='log')download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),prefix+'-처리기록.json');
      if(kind==='txt')download(new Blob(['\ufeff',textReport(data)],{type:'text/plain;charset=utf-8'}),prefix+'.txt');
      status.textContent=$('exportStatus').textContent=data.status+' · 파일을 생성했습니다.';
    }catch(e){status.textContent=$('exportStatus').textContent='파일을 생성하지 못했습니다. '+e.message;}
  }
  $('bundle').onclick=()=>save('bundle');$('word').onclick=()=>save('word');$('log').onclick=()=>save('log');$('save').onclick=()=>save('txt');
  return {reset,add,log,estimate,cancelEstimate,hasRows:()=>!!rows.length,isEstimating:()=>!!speakerWorker,
    setLocked(value){locked=value;updateButtons();},
    replace(){log('이전 녹취 대체',{previousRows:rows.map(r=>({...r}))});clearPlayback();rows=[];paint();}};
}
