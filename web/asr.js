import { env, pipeline } from './vendor/transformers.min.js';
import { modelBase } from './model-base.js';
import {pairCandidates} from './candidates.js';
import {readPcm} from './full-audio.js';
import {speechWindows,uncoveredSpeech} from './speech-windows.js';
env.allowRemoteModels=false;
env.localModelPath=modelBase;
env.backends.onnx.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
env.backends.onnx.wasm.numThreads=1;
let model;
const candidate=text=>/[\p{L}\p{N}]/u.test(text||'')?text.trim():'[판독 불가]';
async function recognize(slice,at,recoverGaps){
  const length=slice.length/16000;
  const lines=[];
  const send=(start,end,text)=>lines.push({start:at+start,end:at+end,text});
  if(!slice.some(v=>Math.abs(v)>0.00003)){
    send(0,length,'[판독 가능한 소리 없음]');return lines;
  }
  const options={language:'korean',task:'transcribe',do_sample:false};
  // Bound decoding on near-silent windows; the recognizer can otherwise repeat text far beyond their duration.
  const tokenLimit=seconds=>Math.min(300,Math.max(32,Math.ceil(seconds*14)+12));
  const result=await model(slice,{...options,return_timestamps:true,max_new_tokens:tokenLimit(length)});
  const chunks=result.chunks?.filter(c=>c.text.trim())||[];
  const spans=[];
  for(const c of chunks){
    const start=Math.max(0,Math.min(length,c.timestamp[0]??0));
    const end=Math.max(start,Math.min(length,c.timestamp[1]??length));
    if(end>start){send(start,end,candidate(c.text));spans.push([Math.round(start*16000),Math.round(end*16000)]);}
  }
  if(!spans.length)send(0,length,candidate(result.text));
  if(recoverGaps && spans.length){
    for(const [a,b] of uncoveredSpeech(slice,spans)){
      let text='[판독 불가]';
      try{
        const retry=await model(slice.subarray(a,b),{...options,return_timestamps:false,max_new_tokens:tokenLimit((b-a)/16000)});
        const words=candidate(retry.text);if(words!=='[판독 불가]')text='[불확실] '+words;
      }catch{/* Preserve the interval for original-audio review. */}
      send(a/16000,b/16000,text);
    }
  }
  return lines;
}
let receiveOriginal;
function originalPacket(a,b){
  return new Promise(resolve=>{receiveOriginal=resolve;postMessage({readOriginal:[a,b]});});
}
self.onmessage=async ({data})=>{
  if(data.originalPacket){receiveOriginal?.(data.originalPacket);receiveOriginal=null;return;}
  try {
    model ??= await pipeline('automatic-speech-recognition','Xenova/whisper-base',{
      quantized:true,progress_callback:event=>{
        if(event.status==='progress') postMessage({status:'모델 준비 중 · '+event.file+' '+Math.round(event.progress||0)+'%'});
      }});
    const sr=16000, samples=data.samples, lengthSamples=data.full?(data.full.size-44)/2:samples.length, size=sr*25;
    for(let a=0; a<lengthSamples; a+=size){
      const packet=data.full?await readPcm(data.full,a,Math.min(a+size,lengthSamples)):samples.subarray(a,a+size);
      const raw=data.full?await originalPacket(a,a+packet.length):data.raw.subarray(a,a+packet.length);
      for(const [lo,hi] of speechWindows(packet)){
        const at=(a+lo)/sr,until=(a+hi)/sr, passes=[];
        for(const [label,samples] of [['원본',raw],['보정본',packet]]){
          postMessage({status:label+' 인식 중 · '+Math.floor(at)+' / '+Math.ceil(lengthSamples/sr)+'초'});
          try{passes.push(await recognize(samples.subarray(lo,hi),at,label==='보정본'));}
          catch(e){passes.push(null);postMessage({passError:{side:label,start:at,end:until,message:String(e.message||e)}});}
        }
        if(passes.every(pass=>pass===null))throw Error('두 음성 모두 인식에 실패했습니다.');
        const missing=[{start:at,end:until,text:'[인식 실패]'}];
        for(const line of pairCandidates(passes[0]??missing,passes[1]??missing))postMessage({line});
      }
    }
    postMessage({done:true});
  } catch(error){postMessage({error:error.message||String(error)});}
};
