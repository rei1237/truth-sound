import {bundleReport,download,effectiveSpeaker,formatTime,report,textReport,wordReport} from './report.js';
const $=id=>document.getElementById(id);
const now=()=>new Date().toISOString();
function el(tag,text=''){const node=document.createElement(tag);node.textContent=text;return node;}
function button(title,action){const b=el('button',title);b.className='sub';b.type='button';b.onclick=action;return b;}
export function createReview(getSource,getRange){
  let rows=[],events=[],speakerWorker=null,listening=null,locked=false,nextId=1;
  const original=$('original'), status=$('reviewStatus');
  const log=(action,data={})=>events.push({at:now(),action,...data});
  function clearPlayback(){
    if(listening){listening=null;original.pause();}
  }
  original.addEventListener('seeking',()=>{
    if(listening && Math.abs(original.currentTime-listening.start)>.08)clearPlayback();
  });
  function heard(){
    if(!listening || original.currentTime<listening.end-.015)return;
    const r=listening;clearPlayback();r.listenedAt=now();log('원본 구간 재생 완료',{id:r.id});
    status.textContent='원본 대조 후 이 줄의 검수 완료를 선택하세요.';paint();
  }
  original.addEventListener('timeupdate',heard);original.addEventListener('ended',heard);
  async function listen(r){
    clearPlayback();if(r.end<=r.start){status.textContent='길이가 없는 구간입니다. 선택 구간으로 새 줄을 추가하세요.';return;}
    listening=r;original.currentTime=r.start;
    try{await original.play();}catch{clearPlayback();status.textContent='원본을 재생할 수 없습니다.';}
  }
  function updateButtons(){
    const unavailable=!getSource()||locked||!!speakerWorker;
    for(const id of ['addLine','estimate','word','log','save','bundle'])$(id).disabled=unavailable;
    if(!rows.length)$('estimate').disabled=$('word').disabled=$('bundle').disabled=true;
    $('reviewRows').disabled=locked||!!speakerWorker;
  }
  function reset(){
    clearPlayback();speakerWorker?.terminate();speakerWorker=null;rows=[];events=[];nextId=1;
    $('caseName').value=$('reviewer').value='';$('filter').value='';status.textContent='';paint();
  }
  function makeRow(start,end,text,input){
    return {id:'r'+nextId++,start,end,input,aiText:input==='manual'?null:text,text,speaker:'',suggestion:'',
      listenedAt:null,reviewedAt:null,excluded:false,createdAt:now()};
  }
  function add(start,end,text,input){
    const r=makeRow(start,end,text,input);rows.push(r);log('발화 추가',{id:r.id,start,end,input,initialText:text});paint();
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
    const select=$('filter');
    const cards=rows.slice().sort((a,b)=>a.start-b.start||a.end-b.end)
      .filter(r=>!select.value||effectiveSpeaker(r)===select.value).map(card);
    $('reviewRows').replaceChildren(...cards);
  }
  function card(r){
    const box=el('article');box.className='utterance';
    const head=el('div');head.className='rowhead';
    head.append(el('strong',formatTime(r.start)+' – '+formatTime(r.end)),button('▶ 원본 구간 듣기',()=>listen(r)));
    const info=el('small',[r.input==='clarified'?'발음 선명화 후보':r.input==='amplified'?'작은 말소리 확대 후보':r.input==='manual'?'직접 작성':'AI 후보',
      r.suggestion?'자동 추정 '+r.suggestion:'',r.reviewedAt?'검수 완료':'검수 전',r.excluded?'문서 제외':''].filter(Boolean).join(' · '));
    const speaker=el('input');speaker.setAttribute('list','names');speaker.placeholder=r.suggestion||'화자 미상';speaker.value=r.speaker;
    const label=el('label','화자 이름 또는 번호');label.append(speaker);
    speaker.onchange=()=>{revise(r,'speaker',speaker.value.trim());review.checked=false;info.textContent='화자 수정 · 재검수 필요';labels();};
    const field=el('textarea');field.value=r.text;field.setAttribute('aria-label','발화 내용');field.rows=2;
    field.oninput=()=>{if(r.reviewedAt){r.reviewedAt=null;review.checked=false;info.textContent='수정됨 · 재검수 필요';}
      r.text=field.value;labels();};
    let before=r.text;
    field.onchange=()=>{log('문구 수정',{id:r.id,before,after:r.text});before=r.text;review.disabled=!r.listenedAt||!r.text.trim()||r.excluded;};
    const check=el('label'),review=el('input');review.type='checkbox';review.checked=!!r.reviewedAt;
    review.disabled=!r.listenedAt||!r.text.trim()||r.excluded;
    review.onchange=()=>{if(review.checked && !r.speaker)r.speaker=effectiveSpeaker(r);r.reviewedAt=review.checked?now():null;log('검수 상태 변경',{id:r.id,reviewedAt:r.reviewedAt,speaker:effectiveSpeaker(r),text:r.text});paint();};
    check.append(review,document.createTextNode('원본 대조 검수 완료'));
    const omit=el('label'),exclude=el('input');exclude.type='checkbox';exclude.checked=r.excluded;
    exclude.onchange=()=>{revise(r,'excluded',exclude.checked);paint();};omit.append(exclude,document.createTextNode('문서에서 제외'));
    const actions=el('div');actions.className='rowactions';actions.append(check,omit,button('재생 위치에서 줄 나누기',()=>split(r,field.selectionStart)));
    box.append(head,info,label,field,actions);return box;
  }
  $('filter').onchange=paint;
  $('addLine').onclick=()=>{try{const [a,b]=getRange();add(a/16000,b/16000,'','manual');}catch(e){status.textContent=e.message;}};
  $('estimate').onclick=()=>{
    const source=getSource();
    const items=rows.filter(r=>!r.excluded).sort((a,b)=>a.start-b.start).map(r=>{
      const center=(r.start+r.end)/2,a=Math.max(r.start,center-2.5),b=Math.min(r.end,center+2.5);
      return {id:r.id,samples:source.samples.slice(Math.round(a*16000),Math.round(b*16000))};
    });
    if(!items.some(i=>i.samples.length>=24000)){status.textContent='화자 추정에는 1.5초 이상 발화가 필요합니다. 짧은 줄은 직접 지정하세요.';return;}
    speakerWorker=new Worker(new URL('./speakers.js',import.meta.url),{type:'module'});
    updateButtons();status.textContent='화자 모델을 준비하고 있습니다 (약 27MB).';
    function finish(message){speakerWorker?.terminate();speakerWorker=null;status.textContent=message;paint();}
    speakerWorker.onerror=e=>finish('화자 추정 실패 · 직접 지정하거나 다시 시도하세요. '+e.message);
    speakerWorker.onmessage=({data})=>{
      if(data.progress)status.textContent='화자 비교 중 · '+data.progress;
      if(data.error)finish('화자 추정 실패 · '+data.error);
      if(data.results){
        const byId=new Map(data.results.map(x=>[x.id,x.label]));
        for(const row of rows)if(!row.reviewedAt && byId.has(row.id))row.suggestion=byId.get(row.id);
        log('화자 추정 완료',{results:data.results});finish('화자 번호는 음색 추정입니다. 원본을 듣고 이름을 확인하세요.');
      }
    };
    speakerWorker.postMessage(items,items.map(i=>i.samples.buffer));
  };
  async function save(kind){
    const data=await report(getSource(),rows,events,{caseName:$('caseName').value.trim(),reviewer:$('reviewer').value.trim()});
    const prefix=data.original.filename+'-'+data.status;
    try{
      if(kind==='bundle')download(await bundleReport(data),prefix+'-제출자료.zip');
      if(kind==='word')download(await wordReport(data),prefix+'.docx');
      if(kind==='log')download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),prefix+'-처리기록.json');
      if(kind==='txt')download(new Blob(['\ufeff',textReport(data)],{type:'text/plain;charset=utf-8'}),prefix+'.txt');
      status.textContent=data.status+' · 파일을 생성했습니다.';
    }catch(e){status.textContent='파일을 생성하지 못했습니다. '+e.message;}
  }
  $('bundle').onclick=()=>save('bundle');$('word').onclick=()=>save('word');$('log').onclick=()=>save('log');$('save').onclick=()=>save('txt');
  return {reset,add,log,hasRows:()=>!!rows.length,isEstimating:()=>!!speakerWorker,
    setLocked(value){locked=value;updateButtons();},
    replace(){log('이전 녹취 대체',{previousRows:rows.map(r=>({...r}))});clearPlayback();rows=[];paint();}};
}
