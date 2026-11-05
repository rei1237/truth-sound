const byId=id=>document.getElementById(id);
const rate=16000;
const time=seconds=>new Date(Math.round(Math.max(0,seconds||0)*1000)).toISOString().slice(11,23);

export function drawPeaks(canvas,peaks,color){
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.strokeStyle='#252a33';ctx.beginPath();
  for(let i=0;i<=8;i++){ctx.moveTo(i*w/8,0);ctx.lineTo(i*w/8,h);}
  ctx.stroke();ctx.fillStyle=color;
  peaks.forEach((peak,i)=>{const height=Math.max(1,Math.sqrt(Math.min(1,peak))*(h-8));ctx.fillRect(i,(h-height)/2,1,height);});
}
export function peaksFrom(samples,width){
  const peaks=new Float32Array(width);
  for(let i=0;i<samples.length;i++){
    const bin=Math.floor(i*width/samples.length);peaks[bin]=Math.max(peaks[bin],Math.abs(samples[i]));
  }
  return peaks;
}
// Read bounded slices of the actual saved PCM WAV. Both tracks share one display scale.
async function enhancedPeaks(blob,width,stillCurrent){
  const count=(blob.size-44)/2,peaks=new Float32Array(width);
  for(let a=0;a<count;a+=rate*30){
    if(!stillCurrent())return null;
    const block=new DataView(await blob.slice(44+2*a,44+2*Math.min(count,a+rate*30)).arrayBuffer());
    for(let i=0;i<block.byteLength/2;i++){
      const bin=Math.floor((a+i)*width/count);
      peaks[bin]=Math.max(peaks[bin],Math.abs(block.getInt16(i*2,true)/32768));
    }
  }
  return stillCurrent()?peaks:null;
}
export function createEditor(getSource,openFile,onFocus){
  const stage=byId('stage'),tracks=byId('tracks'),panel=byId('panel');
  let focus='original',drag=null,speed=1;
  const duration=()=>getSource()?.samples.length/rate||0;
  function tab(id,moveFocus=false){
    for(const button of panel.querySelectorAll('[role=tab]')){
      const name=button.getAttribute('aria-controls'),active=name===id;
      button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
      byId(name).hidden=!active;if(active&&moveFocus)button.focus();
    }
  }
  const tabs=[...panel.querySelectorAll('[role=tab]')];
  tabs.forEach((button,index)=>{
    button.onclick=()=>tab(button.getAttribute('aria-controls'));
    button.onkeydown=e=>{
      const delta={ArrowRight:1,ArrowLeft:-1}[e.key];if(!delta)return;
      e.preventDefault();tab(tabs[(index+delta+tabs.length)%tabs.length].getAttribute('aria-controls'),true);
    };
  });
  byId('exportTab').onclick=()=>tab('export',true);
  byId('pickCenter').onclick=()=>byId('pick').click();
  let dragDepth=0;
  document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
  document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){dragDepth++;document.body.classList.add('dragging');}});
  document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('dragging');}});
  document.addEventListener('drop',e=>{
    e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');
    if(e.dataTransfer.files[0])void openFile(e.dataTransfer.files[0]);
  });
  function clock(position){
    byId('clock').textContent=time(position);
    tracks.style.setProperty('--cursor',(duration()?100*position/duration():0)+'%');
  }
  function selectTrack(id){
    focus=id;onFocus(id);
    document.querySelectorAll('.choose').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.player===id)));
    byId('focusName').textContent=getSource()?(id==='original'?'원본':'보정본'):'—';
  }
  function refreshSelection(){
    const d=duration(),start=byId('start').valueAsNumber,end=byId('end').valueAsNumber;
    const valid=d&&start>=0&&end>start&&end<=d+.001;
    byId('spanLength').textContent=valid?(end-start).toFixed(3)+'초':'—';
    tracks.style.setProperty('--left',(valid?100*start/d:0)+'%');
    tracks.style.setProperty('--width',(valid?100*(end-start)/d:0)+'%');
  }
  for(const id of ['start','end'])byId(id).addEventListener('input',refreshSelection);
  function seek(id,position){
    if(id==='enhanced'&&(!getSource()?.full||getSource()?.processing))return;
    const old=byId(focus),player=byId(id),playing=!old.paused;
    if(old!==player)old.pause();selectTrack(id);player.currentTime=position;clock(position);
    if(playing&&old!==player)void player.play().catch(()=>{});
  }
  async function toggle(){
    if(!getSource()||(focus==='enhanced'&&getSource().processing))return;
    const player=byId(focus);
    if(!player.paused){player.pause();return;}
    try{await player.play();}catch{byId('notice').textContent='재생을 시작할 수 없습니다. 파일을 다시 열어 보세요.';}
  }
  byId('play').onclick=toggle;
  byId('home').onclick=()=>seek(focus,0);byId('last').onclick=()=>seek(focus,duration());
  document.addEventListener('keydown',e=>{
    if(e.code!=='Space'||e.target.closest('button,input,textarea,select,summary,a,[role=tab],audio')||!getSource())return;
    e.preventDefault();void toggle();
  });
  for(const id of ['original','enhanced']){
    const p=byId(id);
    p.addEventListener('play',()=>{selectTrack(id);byId('play').textContent='Ⅱ';byId('play').setAttribute('aria-label','일시 정지');});
    p.addEventListener('pause',()=>{if(focus===id){byId('play').textContent='▶';byId('play').setAttribute('aria-label','재생');}});
    p.addEventListener('timeupdate',()=>{if(focus===id)clock(p.currentTime);});
  }
  for(const button of byId('rates').querySelectorAll('button'))button.onclick=()=>{
    speed=Number(button.dataset.speed);
    for(const id of ['original','enhanced','clip'])byId(id).playbackRate=speed;
    byId('rates').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  };
  for(const b of document.querySelectorAll('.choose'))b.onclick=()=>{
    const id=b.dataset.player,position=byId(focus).currentTime;
    seek(id,position);if(byId(id).paused)void toggle();
  };
  function pos(e,el){const r=el.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*duration();}
  function select(a,b){
    const start=Math.min(a,b),end=Math.min(Math.max(a,b),start+30);
    byId('start').value=start.toFixed(3);byId('end').value=end.toFixed(3);
    byId('end').dispatchEvent(new Event('input'));
  }
  for(const wave of document.querySelectorAll('.wave')){
    wave.onpointerdown=e=>{
      if(e.button!==0||!getSource()||(wave.dataset.player==='enhanced'&&(!getSource().full||getSource().processing)))return;
      drag={x:e.clientX,at:pos(e,wave),moved:false};wave.setPointerCapture(e.pointerId);
    };
    wave.onpointermove=e=>{if(drag&&wave.hasPointerCapture(e.pointerId)&&Math.abs(e.clientX-drag.x)>3){drag.moved=true;select(drag.at,pos(e,wave));}};
    wave.onpointerup=e=>{
      if(!drag)return;
      if(drag.moved){select(drag.at,pos(e,wave));seek(wave.dataset.player,byId('start').valueAsNumber);}
      else seek(wave.dataset.player,pos(e,wave));
      drag=null;
    };
    wave.onpointercancel=()=>{drag=null;};
  }
  function rebuildLane(){
    const d=duration(),lane=byId('lane');lane.replaceChildren();if(!d)return;
    for(const row of byId('reviewRows').children){
      const a=Number(row.dataset.start),b=Number(row.dataset.end);
      const button=document.createElement('button');
      button.style.left=(100*a/d)+'%';button.style.width=(100*(b-a)/d)+'%';
      button.textContent=row.querySelector('textarea').value||'후보 비교';
      button.title=time(a)+' · '+button.textContent;
      button.onclick=()=>{tab('transcript');seek('original',a);row.querySelector('textarea').focus();};
      lane.append(button);
    }
  }
  new MutationObserver(rebuildLane).observe(byId('reviewRows'),{childList:true});
  byId('reviewRows').addEventListener('change',rebuildLane);
  const splitter=byId('splitter');
  function resize(w){const width=Math.max(280,Math.min(600,w,stage.clientWidth*.6));stage.style.setProperty('--panel-w',width+'px');}
  splitter.onpointerdown=e=>splitter.setPointerCapture(e.pointerId);
  splitter.onpointermove=e=>{if(splitter.hasPointerCapture(e.pointerId))resize(stage.getBoundingClientRect().right-e.clientX);};
  splitter.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();resize(panel.clientWidth+(e.key==='ArrowLeft'?16:-16));}};
  function loaded(source){
    const ready=!!source;document.body.className=ready?'editing':'empty';
    for(const id of ['transport','rates','bounds','exportTab'])byId(id).disabled=!ready;
    document.querySelector('.choose[data-player=enhanced]').disabled=true;
    selectTrack('original');clock(0);refreshSelection();tab(ready?'transcript':'analysis');drag=null;
    byId('hashBadge').hidden=!ready;byId('hashBadge').title=source?.hash||'';
    byId('ticks').replaceChildren(...Array.from({length:ready?9:0},(_,i)=>{
      const span=document.createElement('span');span.textContent=time(duration()*i/8).slice(3,8);return span;
    }));
    drawPeaks(byId('enhancedWave'),[],'#41d095');
    for(const id of ['original','enhanced','clip'])byId(id).defaultPlaybackRate=byId(id).playbackRate=speed;
  }
  async function corrected(source){
    document.querySelector('.choose[data-player=enhanced]').disabled=false;
    const canvas=byId('enhancedWave'),version=source.full;
    const peaks=await enhancedPeaks(version.blob,canvas.width,()=>getSource()===source&&source.full===version);
    if(peaks)drawPeaks(canvas,peaks,'#41d095');
  }
  return {loaded,corrected,tab,refreshSelection};
}
