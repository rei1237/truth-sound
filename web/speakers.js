// 16 kHz PCM -> Kaldi-style 80-bin, mean-normalized log mel filterbank.
import FFT from './vendor/fft.js';
import './vendor/ort.min.js';
const ort=globalThis.ort;
const fft=new FFT(512);
const window=Float64Array.from({length:400},(_,i)=>(0.5-0.5*Math.cos(2*Math.PI*i/399))**0.85);
const mel=f=>1127*Math.log1p(f/700);
const edges=Array.from({length:82},(_,i)=>mel(20)+(mel(8000)-mel(20))*i/81);
const filters=edges.slice(0,80).map((lo,i)=>{
  const weights=[];
  for(let k=0;k<256;k++){
    const f=mel(k*16000/512),w=Math.min((f-lo)/(edges[i+1]-lo),(edges[i+2]-f)/(edges[i+2]-edges[i+1]));
    if(w>0)weights.push([k,w]);
  }
  return weights;
});
function features(x){
  const n=Math.floor((x.length-400)/160)+1, values=new Float32Array(n*80);
  const means=new Float64Array(80), frame=new Float64Array(512), spectrum=fft.createComplexArray(),pow=new Float64Array(256);
  for(let t=0;t<n;t++){
    const a=t*160;
    let mean=0;for(let i=0;i<400;i++)mean+=x[a+i]/400;
    let prev=(x[a]-mean)*32768;
    for(let i=0;i<400;i++){
      const v=(x[a+i]-mean)*32768;
      frame[i]=(v-0.97*prev)*window[i];prev=v;
    }
    fft.realTransform(spectrum,frame);
    for(let k=0;k<256;k++)pow[k]=spectrum[k*2]**2+spectrum[k*2+1]**2;
    for(let k=0;k<80;k++){
      let energy=0;for(const [bin,w] of filters[k])energy+=pow[bin]*w;
      const v=Math.log(Math.max(energy,1.192e-7));values[t*80+k]=v;means[k]+=v/n;
    }
  }
  for(let i=0;i<values.length;i++)values[i]-=means[i%80];
  return new ort.Tensor('float32',values,[1,n,80]);
}
const normalize=v=>{const norm=Math.hypot(...v);return Array.from(v,x=>x/(norm||1));};
const score=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
self.onmessage=async({data})=>{
  let session;
  try{
    ort.env.wasm.numThreads=1;
    ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
    session=await ort.InferenceSession.create(new URL('./models/wespeaker/resnet34.onnx',import.meta.url).href,{executionProviders:['wasm']});
    const centers=[],results=[];
    for(const [i,{id,samples}] of data.entries()){
      let label='';
      if(samples.length>=24000 && samples.some(v=>Math.abs(v)>0.0001)){
        const output=await session.run({[session.inputNames[0]]:features(samples)});
        const vector=normalize(output[session.outputNames[0]].data);
        const ranked=centers.map((center,k)=>({k,s:score(vector,center)})).sort((a,b)=>b.s-a.s);
        let k=-1;
        if(!ranked.length || (ranked[0].s<0.38 && centers.length<6)){
          k=centers.length;centers.push(vector);
        }else if(ranked[0].s>=0.54 && (!ranked[1]||ranked[0].s-ranked[1].s>=0.08)){
          k=ranked[0].k;
        }
        if(k>=0)label='화자 '+(k+1);
      }
      results.push({id,label});
      postMessage({progress:(i+1)+' / '+data.length});
    }
    postMessage({results});
  }catch(e){postMessage({error:String(e.message||e)});}
  finally{if(session)await session.release?.();}
};
