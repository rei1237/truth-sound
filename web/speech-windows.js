// Soft boundaries for ASR: preserve every input sample, including very quiet speech.
// Cut near the middle of sustained low-energy gaps, never gate audio out.
export function speechWindows(x){
  const hop=320,levels=[];
  for(let a=0;a<x.length;a+=hop){
    let sum=0;const b=Math.min(x.length,a+hop);
    for(let i=a;i<b;i++)sum+=x[i]*x[i];
    levels.push(Math.sqrt(sum/(b-a)));
  }
  const sorted=[...levels].sort((a,b)=>a-b);
  const floor=sorted[Math.floor(sorted.length*.15)]||0;
  const threshold=Math.min(.012,Math.max(.00045,3.5*floor));
  const ends=[];let quiet=-1,last=0;
  for(let i=0;i<levels.length;i++){
    if(levels[i]<=threshold){if(quiet<0)quiet=i;continue;}
    if(quiet>0 && i-quiet>=15 && quiet*hop-last>=.48*16000 && x.length-i*hop>.24*16000){
      last=Math.floor((quiet+i)*hop/2);ends.push(last);
    }
    quiet=-1;
  }
  ends.push(x.length);
  return ends.map((end,i)=>[i?ends[i-1]:0,end]);
}

// Timestamped decoding can skip a faint reply even after level correction.
export function uncoveredSpeech(samples,spans){
  const gaps=[];let cursor=0;
  function inspect(end){
    if(end-cursor<960)return;
    let voiced=0;
    for(let a=cursor;a+320<=end;a+=320){
      let power=0;for(let i=a;i<a+320;i++)power+=samples[i]**2;
      if(power/320>0.0003**2)voiced++;
    }
    if(voiced>=2)gaps.push([cursor,end]);
  }
  for(const [a,b] of spans.slice().sort((x,y)=>x[0]-y[0])){
    inspect(a);cursor=Math.max(cursor,b);
  }
  inspect(samples.length);return gaps;
}

export function padShortSpeech(samples){
  if(samples.length>=16000)return samples;
  const padded=new Float32Array(Math.max(16000,samples.length+8000));
  padded.set(samples,4000);
  return padded;
}
