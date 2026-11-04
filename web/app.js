import {clarify,lift,wav} from './audio.js';
const $=id=>document.getElementById(id);
const clock=t=>Math.floor(t/60).toString().padStart(2,'0')+':'+(t%60).toFixed(3).padStart(6,'0');
let source=null, clipUrl='', worker=null, revision=0, offset=0;
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
  $('draft').readOnly=on;
}
function halt(message){
  worker?.terminate();worker=null;busy(false);if(message)$('asrstatus').textContent=message;
}
function revokeClip(){
  $('clip').pause();$('clip').removeAttribute('src');$('clip').load();
  if(clipUrl)URL.revokeObjectURL(clipUrl);clipUrl='';
}
let loading=false;
async function openFile(file){
  if(!file||loading)return;
  if($('draft').value.trim()&&!confirm('이 녹음의 초안을 저장하셨나요? 새 파일을 열면 현재 초안이 지워집니다.'))return;
  loading=true;$('pick').disabled=$('demo').disabled=true;
  const seq=++revision;
  halt();if(source)URL.revokeObjectURL(source.url);
  source=null;revokeClip();$('original').pause();$('original').removeAttribute('src');$('original').load();
  $('draft').value='';$('draft').disabled=$('save').disabled=$('selection').disabled=true;busy(false);
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
    source={samples:mix.getChannelData(0),url:URL.createObjectURL(file),name:file.name,
      hash:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};
    $('original').src=source.url;$('filename').textContent=file.name;
    $('endtime').textContent=clock(mix.duration);$('start').value=0;$('end').value=Math.min(10,mix.duration).toFixed(3);
    $('notice').textContent='원본 파일을 열었습니다. 녹음과 초안은 이 탭에만 있습니다.';
    $('asrstatus').textContent='녹취 범위를 선택하세요. 인식 결과는 검수 전 후보로 기록됩니다.';
    $('selection').disabled=$('draft').disabled=$('save').disabled=false;busy(false);waveform(source.samples);
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
  try{const res=await fetch('./example.wav');if(!res.ok)throw Error();await openFile(new File([await res.blob()],'합성 예제 · 네, 들려요.wav',{type:'audio/wav'}));}
  catch{$('notice').textContent='예제를 열 수 없습니다. 파일 선택을 이용하세요.';}
};
$('here').onclick=()=>{
  const d=source.samples.length/16000,a=Math.max(0,Math.min($('original').currentTime,d-0.001));
  $('start').value=a.toFixed(3);$('end').value=Math.min(d,a+10).toFixed(3);
};
$('render').onclick=async ()=>{
  try{
    const [a,b]=range(),mode=$('mode').value,x=source.samples.subarray(a,b);
    const audio=mode==='clear'?clarify(x,source.samples.subarray(Math.max(0,a-8000),b+8000)):
      mode==='lift'?lift(x):x;
    revokeClip();clipUrl=URL.createObjectURL(wav(audio));$('clip').src=clipUrl;
    $('clipstatus').textContent=clock(a/16000)+' – '+clock(b/16000)+' · '+$('mode').selectedOptions[0].text;
    $('original').pause();await $('clip').play();
  }catch(e){$('clipstatus').textContent=e.message;}
};
$('original').onplay=()=>$('clip').pause();
$('clip').onplay=()=>$('original').pause();
const rangeButton=document.createElement('button');rangeButton.id='rangeAsr';rangeButton.className='sub';
rangeButton.textContent='선택 구간만 녹취';rangeButton.disabled=true;$('asr').after(rangeButton);
function startAsr(selected){
  if(worker||!source)return;
  try{
    let bounds=selected?range():[0,source.samples.length];
    if(!selected&&$('draft').value.trim()&&!confirm('현재 초안을 전체 녹취 결과로 바꿀까요?'))return;
    offset=bounds[0]/16000;
    const raw=source.samples.subarray(...bounds);
    const useClear=selected && $('mode').value==='clear';
    const samples=useClear ? clarify(raw,source.samples.subarray(Math.max(0,bounds[0]-8000),bounds[1]+8000)) : raw.slice();
    worker=new Worker(new URL('./asr.js',import.meta.url),{type:'module'});
    let firstLine=true;
    busy(true);$('asrstatus').textContent='이 기기에서 모델을 준비합니다. 첫 실행은 시간이 걸릴 수 있습니다.';
    worker.onmessage=({data})=>{
      if(data.status)$('asrstatus').textContent=data.status;
      if(data.line){
        const {start,end,text}=data.line;
        if(firstLine&&!selected)$('draft').value='';
        firstLine=false;
        const mark=useClear?'[청취 보정 신호 · 검수 전]':'[검수 전]';
        $('draft').value+='['+clock(start+offset)+' – '+clock(end+offset)+'] '+mark+' '+text+'\n';
      }
      if(data.error)halt('녹취를 완료하지 못했습니다. '+data.error+' · 작성된 줄은 남아 있습니다.');
      if(data.done)halt('녹취 초안을 작성했습니다. 원본을 들으며 수정한 뒤 저장하세요.');
    };
    worker.onerror=e=>halt('AI 실행 오류 · '+(e.message||'최신 브라우저에서 다시 시도하세요.'));
    worker.postMessage({samples},[samples.buffer]);
  }catch(e){halt(e.message);}
}
$('asr').onclick=()=>startAsr(false);rangeButton.onclick=()=>startAsr(true);
$('stop').onclick=()=>halt('녹취를 중지했습니다. 작성된 줄은 남아 있습니다.');
$('save').onclick=()=>{
  const note=['Truth Sound · 녹취 초안',source.name,'원본 SHA-256 '+source.hash,
    '한국어 Whisper base · 시각은 원본 기준 · 화자는 직접 확인해야 합니다.',
    'AI 추정 문구는 원본과 대조하세요. 확인이 어려운 말은 [판독 불가]로 기재하세요.','',
    $('draft').value.trim()||'[기재한 발화 없음]'].join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff',note],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=source.name+'-녹취초안.txt';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
waveform(null);
