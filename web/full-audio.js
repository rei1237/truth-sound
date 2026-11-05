// Audio processed here stays on the original 16 kHz sample clock.
import {clarify} from './audio.js?v=max1';
export const block=8*16000, overlap=4000, pad=8000;
export const method='full-clarity-v1';
export const profiles={
  standard:{method,label:'기본 보정',noiseReductionDb:13,noiseMultiplier:2.4,localGainMaxDb:38,softLimiter:false},
  strong:{method:'full-strong-v1',label:'강화 보정',noiseReductionDb:15,noiseMultiplier:3.5,localGainMaxDb:38,outputDriveDb:6.0206,softLimiter:'0.92*tanh(2*x/0.92)',presenceMaxDb:5},
  precise:{method:'full-precise-v1',label:'발음 정밀 보정',noiseReductionDb:9,noiseMultiplier:1.5,onsetNoiseMultiplier:.65,localGainMaxDb:38,
    spectralMaskSmoothing:'three-bin weighted mean',makeupMax:1.7,peakCeiling:.92,softLimiter:false,presenceMaxDb:4},
  maximum:{method:'full-maximum-v1',label:'최대 청취 보정',noiseReductionDb:9,noiseMultiplier:1.5,onsetNoiseMultiplier:.65,
    localGainMaxDb:48,targetRms:.28,levelWindowMs:30,makeupMax:2.5,peakCeiling:.92,lookaheadMs:10,releaseMs:80,
    spectralMaskSmoothing:'three-bin weighted mean',softLimiter:false,presenceMaxDb:4}
};
// A transcript keeps the processing version used when its candidates were recognized.
export function fullVersion(source,row){
  const profile=row?.variant?.profile;
  if(profile){
    if(!source.versions?.[profile])throw Error('녹취에 사용한 보정본을 찾을 수 없습니다.');
    return source.versions[profile];
  }
  return source.versions?.standard||source.full;
}
export function processBlock(samples,skip,count,tailLength,previous,profile='standard'){
  const output=clarify(samples,samples,profile).subarray(skip,skip+count+tailLength);
  if(previous)for(let i=0;i<Math.min(previous.length,count);i++){
    const t=i/overlap;
    output[i]=previous[i]*(1-t)+output[i]*t;
  }
  const pcm=new Uint8Array(2*count), view=new DataView(pcm.buffer);
  for(let i=0;i<count;i++)view.setInt16(2*i,Math.round(Math.max(-1,Math.min(1,output[i]))*32767),true);
  return {pcm,tail:output.slice(count)};
}
export function waveBlob(parts,length){
  const h=new ArrayBuffer(44),v=new DataView(h);
  const tag=(i,s)=>Array.from(s,(c,j)=>v.setUint8(i+j,c.charCodeAt(0)));
  tag(0,'RIFF');v.setUint32(4,length*2+36,true);tag(8,'WAVEfmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,length*2,true);
  return new Blob([h,...parts],{type:'audio/wav'});
}
export async function readPcm(blob,start,end){
  const v=new DataView(await blob.slice(44+start*2,44+end*2).arrayBuffer());
  return Float32Array.from({length:v.byteLength/2},(_,i)=>v.getInt16(2*i,true)/32767);
}
// Only send one padded window at a time; a long file never needs a second full float buffer.
export async function renderFull(samples,signal,progress,profile='standard'){
  if(!profiles[profile])throw Error('알 수 없는 보정 방식입니다.');
  const w=new Worker(new URL('./full-worker.js?v=max1',import.meta.url),{type:'module'});
  const aborted=()=>new DOMException('보정이 중지되었습니다.','AbortError');
  try{
    return await new Promise((resolve,reject)=>{
      const cancel=()=>reject(aborted());signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted){cancel();return;}
      const parts=[];let start=0,count=0;
      function next(){
        count=Math.min(block,samples.length-start);
        const a=Math.max(0,start-pad), tailLength=Math.min(overlap,samples.length-start-count);
        const frame=samples.slice(a,start+count+tailLength+pad);
        w.postMessage({samples:frame,skip:start-a,count,tailLength,profile},[frame.buffer]);
      }
      w.onerror=e=>reject(Error(e.message||'전체 음성 보정 실패'));
      w.onmessage=({data})=>{
        if(data.error){reject(Error(data.error));return;}
        parts.push(data.pcm);start+=count;progress(start/samples.length);
        if(start===samples.length)resolve(waveBlob(parts,start));else next();
      };
      next();
    });
  }finally{w.terminate();}
}
