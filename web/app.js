import {createReview} from './review.js?v=speakers2';
import {createEditor,drawPeaks,peaksFrom} from './editor.js';
import {renderFull,method,readPcm} from './full-audio.js';
import {clarify,liftForListening,wav} from './audio.js?v=clarity3';
const $=id=>document.getElementById(id);
const clock=t=>Math.floor(t/60).toString().padStart(2,'0')+':'+(t%60).toFixed(3).padStart(6,'0');
let source=null, clipUrl='', worker=null, revision=0, offset=0;
let fullJob=null,activeFullPlayer='original',recognizing=false;
const review=createReview(()=>source,range,reviewAudio);
const editor=createEditor(()=>source,openFile,id=>{activeFullPlayer=id;});
function selectedAudio(current,a,b,mode){
  const raw=current.samples.subarray(a,b);
  return mode==='lift'?liftForListening(raw):clarify(raw,current.samples.subarray(Math.max(0,a-8000),b+8000));
}
async function reviewAudio(row){
  const a=Math.round(row.start*16000),b=Math.round(row.end*16000);
  if(row.variant.mode==='full')return wav(await readPcm(source.full.blob,a,b));
  const {from,to,mode}=row.variant;
  return wav(selectedAudio(source,from,to,mode).subarray(a-from,b-from));
}
function waveform(samples) {
  const canvas=$('wave');
  drawPeaks(canvas,samples?peaksFrom(samples,canvas.width):[],'#aeb6c4');
}
function busy(on){
  recognizing=on;$('asr').disabled=on||!source?.full;$('rangeAsr').disabled=on||!source;$('stop').hidden=!on;
  review.setLocked(on);
}
function halt(message){
  worker?.terminate();worker=null;busy(false);if(message)$('asrstatus').textContent=message;
}
function revokeClip(){
  $('clip').onloadedmetadata=null;
  $('clip').pause();$('clip').removeAttribute('src');$('clip').load();
  if(clipUrl)URL.revokeObjectURL(clipUrl);clipUrl='';
}
let loading=false;
function clearFull(){
  fullJob?.abort();fullJob=null;
  const player=$('enhanced');player.pause();player.removeAttribute('src');player.load();
  if(source?.full)URL.revokeObjectURL(source.full.url);
  $('fullDownload').removeAttribute('href');$('fullResult').open=false;$('fullResult').hidden=true;$('retryFull').hidden=true;
  $('fullStatus').textContent='녹음을 열면 자동 보정을 시작합니다.';activeFullPlayer='original';
}
async function prepareFull(){
  const current=source;if(!current||current.full||fullJob)return;
  const job=fullJob=new AbortController();$('retryFull').hidden=true;
  const status=$('fullStatus');status.textContent='전체 녹음의 작은 말소리를 찾는 중입니다.';
  try{
    const blob=await renderFull(current.samples,job.signal,f=>{status.textContent='전체 음성 보정 중 · '+Math.round(100*f)+'%';});
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    if(current!==source||job.signal.aborted)return;
    const url=URL.createObjectURL(blob),metadata={method,format:'PCM16 WAV · 16000 Hz · mono',
      samples:current.samples.length,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
    current.full={url,blob,metadata};review.log('전체 음성 보정 완료',metadata);
    $('enhanced').src=url;$('fullDownload').href=url;$('fullDownload').download=current.name+'-전체보정.wav';
    $('fullResult').hidden=false;status.textContent='전체 보정 완료 · 원본과 길이가 같습니다.';
    void editor.corrected(current).catch(()=>{if(source===current)status.textContent+=' 보정본 파형을 표시하지 못했습니다.';});
    if(!recognizing)$('asrstatus').textContent='전체 보정본이 준비되었습니다. 화자별 녹취를 시작하세요.';
    busy(recognizing);
  }catch(e){
    if(source===current&&!job.signal.aborted){status.textContent='전체 보정을 완료하지 못했습니다. '+e.message;$('retryFull').hidden=false;}
  }finally{if(fullJob===job)fullJob=null;}
}
$('retryFull').onclick=prepareFull;
async function openFile(file,example=false){
  if(!file||loading)return;
  if(review.hasRows()&&!confirm('이 녹음의 초안을 저장하셨나요? 새 파일을 열면 현재 초안이 지워집니다.'))return;
  loading=true;$('pick').disabled=$('demo').disabled=true;
  const seq=++revision;
  halt();clearFull();if(source)URL.revokeObjectURL(source.url);
  source=null;editor.loaded(null);review.reset();revokeClip();$('original').pause();$('original').removeAttribute('src');$('original').load();
  $('selection').disabled=true;busy(false);
  $('clipstatus').textContent='';$('filename').textContent='녹음 열기';$('endtime').textContent='--:--.---';
  waveform(null);$('notice').textContent='녹음을 기기에서 읽는 중입니다.';$('asrstatus').textContent='';
  try{
    if(file.size>160*1024*1024)throw Error('브라우저판은 파일당 160MB까지 열 수 있습니다.');
    const bytes=await file.arrayBuffer();
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    const offline=new OfflineAudioContext(1,1,16000);
    const decoded=await offline.decodeAudioData(bytes);
    if(decoded.duration>3600)throw Error('브라우저판은 1시간 이하 녹음을 지원합니다.');
    const renderer=new OfflineAudioContext(1,Math.max(1,Math.round(decoded.duration*16000)),16000);
    const node=renderer.createBufferSource();node.buffer=decoded;node.connect(renderer.destination);node.start();
    const mix=await renderer.startRendering();
    if(seq!==revision)return;
    source={samples:mix.getChannelData(0),url:URL.createObjectURL(file),name:file.name,bytes:file.size,
      hash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};
    $('original').src=source.url;$('filename').textContent=file.name;
    $('endtime').textContent=clock(mix.duration);$('start').value=0;$('end').value=Math.min(10,mix.duration).toFixed(3);
    $('notice').textContent=example
      ? '합성 예제입니다. 3.1초부터 작게 말하는 “지금 다시 확인해 주세요”를 원본과 보정본에서 비교해 보세요.'
      : '원본 파일을 열었습니다. 녹음과 초안은 이 탭에만 있습니다.';
    $('asrstatus').textContent='전체 보정본이 준비되면 녹취를 시작할 수 있습니다.';
    $('selection').disabled=false;busy(false);editor.loaded(source);waveform(source.samples);void prepareFull();
  }catch(e){$('notice').textContent='파일을 열지 못했습니다. '+(e.message||'WAV 또는 MP3 파일로 다시 시도하세요.');}
  finally{loading=false;$('pick').disabled=$('demo').disabled=false;}
}
function range(){
  const a=$('start').valueAsNumber,b=$('end').valueAsNumber, dur=source.samples.length/16000;
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>dur+.001||b-a>30.001)
    throw Error('녹음 길이 안에서 시작과 끝을 지정하세요. 한 번에 30초까지 들을 수 있습니다.');
  return [Math.round(a*16000),Math.min(source.samples.length,Math.round(b*16000))];
}
$('pick').onclick=()=>$('file').click();
$('file').onchange=async e=>{const file=e.target.files[0];e.target.value='';await openFile(file);};
$('demo').onclick=async ()=>{
  try{const res=await fetch('./example.wav?v=clarity3');if(!res.ok)throw Error();await openFile(new File([await res.blob()],'합성 예제 · 작은 문장.wav',{type:'audio/wav'}),true);}
  catch{$('notice').textContent='예제를 열 수 없습니다. 파일 선택을 이용하세요.';}
};
$('here').onclick=()=>{
  const d=source.samples.length/16000,a=Math.max(0,Math.min($('original').currentTime,d-0.001));
  $('start').value=a.toFixed(3);$('end').value=Math.min(d,a+10).toFixed(3);
  editor.refreshSelection();
  revokeClip();$('clipstatus').textContent='선택한 구간을 재생하세요.';
};
let clipBounds='';
async function renderClip(switchMode=false){
  let requestedUrl='';
  try{
    const [a,b]=range(),mode=$('mode').value,x=source.samples.subarray(a,b);
    const player=$('clip'),original=$('original'),key=a+'-'+b;
    const same=!!clipUrl && clipBounds===key;
    const playing=!player.paused || !original.paused;
    let position=switchMode && same && !player.ended ? player.currentTime : 0;
    if(switchMode && !original.paused && original.currentTime>=a/16000 && original.currentTime<b/16000){
      position=original.currentTime-a/16000;
    }
    const audio=mode==='clear'?clarify(x,source.samples.subarray(Math.max(0,a-8000),b+8000)):
      mode==='lift'?liftForListening(x):x;
    let before=0,after=0;
    for(let i=0;i<x.length;i++){before+=x[i]*x[i];after+=audio[i]*audio[i];}
    const delta=before>0 && after>0 ? 10*Math.log10(after/before) : 0;
    revokeClip();requestedUrl=clipUrl=URL.createObjectURL(wav(audio));clipBounds=key;
    if(position>0)player.onloadedmetadata=()=>{player.currentTime=Math.min(position,(b-a)/16000);};
    player.src=clipUrl;
    $('clipstatus').textContent=clock(a/16000)+' – '+clock(b/16000)+' · '+$('mode').selectedOptions[0].text+
      ' · 구간 평균 음량 '+(delta>=0?'+':'')+delta.toFixed(1)+' dB';
    if(!switchMode || playing){original.pause();await player.play();}
  }catch(e){if(!requestedUrl || requestedUrl===clipUrl)$('clipstatus').textContent=e.message;}
}
$('render').onclick=()=>renderClip();
$('mode').onchange=()=>renderClip(true);
$('repeatClip').onchange=()=>{$('clip').loop=$('repeatClip').checked;};
for(const id of ['start','end'])$(id).oninput=()=>{revokeClip();$('clipstatus').textContent='선택한 구간을 다시 재생하세요.';};
for(const id of ['original','enhanced'])$(id).onplay=()=>{
  activeFullPlayer=id;$(id==='original'?'enhanced':'original').pause();$('clip').pause();
};
$('clip').onplay=()=>{$('original').pause();$('enhanced').pause();};
$('compareFull').onclick=async()=>{
  const from=$(activeFullPlayer),to=$(activeFullPlayer==='original'?'enhanced':'original');
  const pos=from.ended?0:from.currentTime;from.pause();to.currentTime=pos;
  try{await to.play();}catch(e){$('fullStatus').textContent='재생을 시작하지 못했습니다. '+e.message;}
};
const rangeButton=document.createElement('button');rangeButton.id='rangeAsr';rangeButton.className='sub';
rangeButton.textContent='선택 구간만 녹취';rangeButton.disabled=true;$('asr').after(rangeButton);
function startAsr(selected){
  if(worker||!source||review.isEstimating())return;
  try{
    let bounds=selected?range():[0,source.samples.length];
    if(!selected&&review.hasRows()&&!confirm('현재 초안을 전체 녹취 결과로 바꿀까요?'))return;
    offset=bounds[0]/16000;
    const raw=source.samples.subarray(...bounds);
    if(!selected&&!source.full)return;
    const mode=!selected?'full':$('mode').value==='lift'?'lift':'clear';
    const variant={mode,from:bounds[0],to:bounds[1]};
    const input='dual';
    const samples=selected?selectedAudio(source,...bounds,mode):null;
    worker=new Worker(new URL('./asr.js?v=short1',import.meta.url),{type:'module'});
    const pending=!selected&&review.hasRows()?[]:null;
    review.log('녹취 시작',{rangeSeconds:bounds.map(i=>i/16000),input,selected,
      sources:['original',mode],variant,listeningProcessing:!selected?source.full.metadata:'clarity-v3 · short-window level control, max +38 dB'});
    busy(true);editor.tab('transcript');$('asrstatus').textContent='이 기기에서 모델을 준비합니다. 첫 실행은 시간이 걸릴 수 있습니다.';
    worker.onmessage=({data})=>{
      if(data.readOriginal){
        const originalPacket=source.samples.slice(...data.readOriginal);
        worker.postMessage({originalPacket},[originalPacket.buffer]);return;
      }
      if(data.passError)review.log('후보 인식 실패',{...data.passError,start:data.passError.start+offset,end:data.passError.end+offset});
      if(data.status)$('asrstatus').textContent=data.status;
      if(data.line){
        const {start,end,text}=data.line;
        const candidates=data.line.candidates;
        candidates.spans=candidates.spans.map(s=>({...s,start:s.start+offset,end:s.end+offset}));
        const args=[start+offset,end+offset,text,input,candidates,variant];
        if(pending)pending.push(args);else review.add(...args);
      }
      if(data.error)review.log('녹취 실패',{error:data.error});
      if(data.error)halt('녹취를 완료하지 못했습니다. '+data.error+' · 작성된 줄은 남아 있습니다.');
      if(data.done){
        if(pending?.length){review.replace();for(const args of pending)review.add(...args);}
        review.log(selected?'구간 녹취 완료':'전체 녹취 완료');
      }
      if(data.done && selected)halt('구간 녹취 초안을 작성했습니다. 원본을 들으며 수정한 뒤 저장하세요.');
      if(data.done && !selected){
        worker.terminate();worker=null;$('asrstatus').textContent='전체 녹취 완료 · 보정본에서 화자를 비교합니다.';
        void review.estimate(message=>halt('전체 녹취 완료 · '+message));
      }
    };
    worker.onerror=e=>halt('AI 실행 오류 · '+(e.message||'최신 브라우저에서 다시 시도하세요.'));
    if(selected){const original=raw.slice();worker.postMessage({samples,raw:original},[samples.buffer,original.buffer]);}
    else worker.postMessage({full:source.full.blob});
  }catch(e){halt(e.message);}
}
$('asr').onclick=()=>startAsr(false);rangeButton.onclick=()=>startAsr(true);
$('separate').onclick=()=>{
  if(recognizing||review.isEstimating()||!source?.full)return;
  if(!review.hasRows()){startAsr(false);return;}
  editor.tab('transcript');busy(true);
  $('asrstatus').textContent='기존 녹취의 화자를 비교합니다.';
  void review.estimate(message=>halt(message));
};
$('stop').onclick=()=>{review.cancelEstimate();review.log('녹취 중지');halt('녹취를 중지했습니다. 작성된 줄은 남아 있습니다.');};
editor.loaded(null);waveform(null);
