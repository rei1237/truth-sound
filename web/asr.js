import { env, pipeline } from './vendor/transformers.min.js';
import { modelBase } from './model-base.js';
import { lift } from './audio.js';
import {readPcm} from './full-audio.js';
import {speechWindows,uncoveredSpeech} from './speech-windows.js';
env.allowRemoteModels=false;
env.localModelPath=modelBase;
env.backends.onnx.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
env.backends.onnx.wasm.numThreads=1;
let model;
const candidate=text=>/[\p{L}\p{N}]/u.test(text||'')?text.trim():'[판독 불가]';
async function recognize(slice,at,full){
  const length=slice.length/16000;
  const send=(start,end,text)=>postMessage({line:{start:at+start,end:at+end,text}});
  if(!slice.some(v=>Math.abs(v)>0.00003)){
    send(0,length,'[판독 가능한 소리 없음]');return;
  }
  const result=await model(full?slice:lift(slice),{language:'korean',task:'transcribe',return_timestamps:true,do_sample:false});
  const chunks=result.chunks?.filter(c=>c.text.trim())||[];
  const spans=[];
  for(const c of chunks){
    const start=Math.max(0,Math.min(length,c.timestamp[0]??0));
    const end=Math.max(start,Math.min(length,c.timestamp[1]??length));
    send(start,end,candidate(c.text));
    spans.push([Math.round(start*16000),Math.round(end*16000)]);
  }
  if(!chunks.length)send(0,length,candidate(result.text));
  if(full && spans.length){
    for(const [a,b] of uncoveredSpeech(slice,spans)){
      let text='[판독 불가]';
      try{
        const retry=await model(slice.subarray(a,b),{language:'korean',task:'transcribe',return_timestamps:false,do_sample:false});
        const words=candidate(retry.text);if(words!=='[판독 불가]')text='[불확실] '+words;
      }catch{/* Preserve the interval for original-audio review. */}
      send(a/16000,b/16000,text);
    }
  }
}
self.onmessage=async ({data})=>{
  try {
    model ??= await pipeline('automatic-speech-recognition','Xenova/whisper-base',{
      quantized:true,progress_callback:event=>{
        if(event.status==='progress') postMessage({status:'모델 준비 중 · '+event.file+' '+Math.round(event.progress||0)+'%'});
      }});
    const sr=16000, samples=data.samples, lengthSamples=data.full?(data.full.size-44)/2:samples.length, size=sr*25;
    for(let a=0; a<lengthSamples; a+=size){
      const packet=data.full?await readPcm(data.full,a,Math.min(a+size,lengthSamples)):samples.subarray(a,a+size);
      postMessage({status:'녹취 중 · '+Math.floor(a/sr)+' / '+Math.ceil(lengthSamples/sr)+'초'});
      for(const [lo,hi] of data.full?speechWindows(packet):[[0,packet.length]]){
        await recognize(packet.subarray(lo,hi),(a+lo)/sr,!!data.full);
      }
    }
    postMessage({done:true});
  } catch(error){postMessage({error:error.message||String(error)});}
};
