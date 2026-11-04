import {createReview} from './review.js';
import {clarify,liftForListening,wav} from './audio.js?v=clarity3';
const $=id=>document.getElementById(id);
const clock=t=>Math.floor(t/60).toString().padStart(2,'0')+':'+(t%60).toFixed(3).padStart(6,'0');
let source=null, clipUrl='', worker=null, revision=0, offset=0;
const review=createReview(()=>source,range);
function waveform(samples) {
  const canvas=$('wave'), ctx=canvas.getContext('2d'), w=canvas.width, h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.strokeStyle='#2f3642';ctx.beginPath();
  for(let i=0;i<=12;i++){ctx.moveTo(i*w/12,0);ctx.lineTo(i*w/12,h);}
  ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  if(!samples)return;
  const step=Math.max(1,Math.ceil(samples.length/w)), peaks=[];
  let peak=0;
  for(let a=0;a<samples.length;a+=step){
    let max=0;for(let j=a;j<Math.min(a+step,samples.length);j++)max=Math.max(max,Math.abs(samples[j]));
    peaks.push(max);peak=Math.max(peak,max);
  }
  ctx.fillStyle='#d9b777';
  peaks.forEach((p,i)=>{const height=Math.max(1,p/(peak||1)*(h-8));ctx.fillRect(i,h/2-height/2,1,height);});
}
function busy(on){
  $('asr').disabled=on||!source;$('rangeAsr').disabled=on||!source;$('stop').hidden=!on;
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
async function openFile(file,example=false){
  if(!file||loading)return;
  if(review.hasRows()&&!confirm('이 녹음의 초안을 저장하셨나요? 새 파일을 열면 현재 초안이 지워집니다.'))return;
  loading=true;$('pick').disabled=$('demo').disabled=true;
  const seq=++revision;
  halt();if(source)URL.revokeObjectURL(source.url);
  source=null;review.reset();revokeClip();$('original').pause();$('original').removeAttribute('src');$('original').load();
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
      ? '합성 예제입니다. 3.1초부터 작게 말하는 “지금 다시 확인해 주세요”를 구간 비교에서 들어보세요.'
      : '원본 파일을 열었습니다. 녹음과 초안은 이 탭에만 있습니다.';
    $('asrstatus').textContent='녹취 범위를 선택하세요. 인식 결과는 검수 전 후보로 기록됩니다.';
    $('selection').disabled=false;busy(false);waveform(source.samples);
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
$('original').onplay=()=>$('clip').pause();
$('clip').onplay=()=>$('original').pause();
const rangeButton=document.createElement('button');rangeButton.id='rangeAsr';rangeButton.className='sub';
rangeButton.textContent='선택 구간만 녹취';rangeButton.disabled=true;$('asr').after(rangeButton);
function startAsr(selected){
  if(worker||!source||review.isEstimating())return;
  try{
    let bounds=selected?range():[0,source.samples.length];
    if(!selected&&review.hasRows()&&!confirm('현재 초안을 전체 녹취 결과로 바꿀까요?'))return;
    offset=bounds[0]/16000;
    const raw=source.samples.subarray(...bounds);
    const mode=selected ? $('mode').value : 'original';
    const input=mode==='clear'?'clarified':mode==='lift'?'amplified':'original';
    const samples=mode==='clear' ? clarify(raw,source.samples.subarray(Math.max(0,bounds[0]-8000),bounds[1]+8000))
      : mode==='lift' ? liftForListening(raw) : raw.slice();
    worker=new Worker(new URL('./asr.js',import.meta.url),{type:'module'});
    const pending=!selected&&review.hasRows()?[]:null;
    review.log('녹취 시작',{rangeSeconds:bounds.map(i=>i/16000),input,selected,
      listeningProcessing:mode==='original'?null:'clarity-v3 · short-window level control, max +38 dB'});
    busy(true);$('asrstatus').textContent='이 기기에서 모델을 준비합니다. 첫 실행은 시간이 걸릴 수 있습니다.';
    worker.onmessage=({data})=>{
      if(data.status)$('asrstatus').textContent=data.status;
      if(data.line){
        const {start,end,text}=data.line;
        const args=[start+offset,end+offset,text,input];
        if(pending)pending.push(args);else review.add(...args);
      }
      if(data.error)review.log('녹취 실패',{error:data.error});
      if(data.error)halt('녹취를 완료하지 못했습니다. '+data.error+' · 작성된 줄은 남아 있습니다.');
      if(data.done){
        if(pending?.length){review.replace();for(const args of pending)review.add(...args);}
        review.log(selected?'구간 녹취 완료':'전체 녹취 완료');
      }
      if(data.done)halt('녹취 초안을 작성했습니다. 원본을 들으며 수정한 뒤 저장하세요.');
    };
    worker.onerror=e=>halt('AI 실행 오류 · '+(e.message||'최신 브라우저에서 다시 시도하세요.'));
    worker.postMessage({samples},[samples.buffer]);
  }catch(e){halt(e.message);}
}
$('asr').onclick=()=>startAsr(false);rangeButton.onclick=()=>startAsr(true);
$('stop').onclick=()=>{review.log('녹취 중지');halt('녹취를 중지했습니다. 작성된 줄은 남아 있습니다.');};
waveform(null);
