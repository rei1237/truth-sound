import { env, pipeline } from './vendor/transformers.min.js';
import { lift } from './audio.js';
env.allowRemoteModels=false;
env.localModelPath=new URL('./models/',import.meta.url).href;
env.backends.onnx.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
env.backends.onnx.wasm.numThreads=1;
let model;
self.onmessage=async ({data})=>{
  try {
    model ??= await pipeline('automatic-speech-recognition','Xenova/whisper-base',{
      quantized:true,progress_callback:event=>{
        if(event.status==='progress') postMessage({status:'모델 준비 중 · '+event.file+' '+Math.round(event.progress||0)+'%'});
      }});
    const sr=16000, samples=data.samples, size=sr*25;
    for(let a=0; a<samples.length; a+=size){
      const slice=samples.subarray(a,a+size);
      postMessage({status:'녹취 중 · '+Math.floor(a/sr)+' / '+Math.ceil(samples.length/sr)+'초'});
      if (!slice.some(v=>Math.abs(v)>0.00003)) {
        postMessage({line:{start:a/sr,end:(a+slice.length)/sr,text:'[판독 가능한 소리 없음]'}});
        continue;
      }
      const result=await model(lift(slice),{language:'korean',task:'transcribe',return_timestamps:true,do_sample:false});
      const chunks=result.chunks?.filter(c=>c.text.trim())||[];
      const length=slice.length/sr;
      for(const c of chunks){
        const start=Math.max(0,Math.min(length,c.timestamp[0]??0));
        const end=Math.max(start,Math.min(length,c.timestamp[1]??length));
        postMessage({line:{start:a/sr+start,end:a/sr+end,text:c.text.trim()}});
      }
      if(!chunks.length) postMessage({line:{start:a/sr,end:a/sr+length,text:result.text?.trim()||'[판독 불가]'}});
    }
    postMessage({done:true});
  } catch(error){postMessage({error:error.message||String(error)});}
};
