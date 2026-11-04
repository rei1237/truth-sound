import FFT from './vendor/fft.js';
const RATE = 16000;
export function lift(x) {
  let peak = 0, energy = 0;
  for (const v of x) { peak = Math.max(peak, Math.abs(v)); energy += v * v; }
  if (!peak) return x.slice();
  const gain = Math.min(31.62, 0.98 / peak, Math.max(1, 0.1 / Math.sqrt(energy / x.length)));
  return x.map(v => v * gain);
}

export function clarify(x, context) {
  const n = 512, hop = n / 2, fft = new FFT(n);
  const window = Float64Array.from({length:n}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  const frame = new Float64Array(n), spectrum = fft.createComplexArray(), inverse = fft.createComplexArray();
  function analyze(data, start) {
    for (let i=0; i<n; i++) frame[i] = (data[start+i] || 0) * window[i];
    fft.realTransform(spectrum, frame);
  }
  const powers = Array.from({length:hop+1}, () => []);
  // Sample at most 128 frames to estimate background without growing memory on longer clips.
  const stride = Math.max(hop, Math.ceil(context.length / (128 * hop)) * hop);
  for (let pos=-hop; pos<context.length; pos+=stride) {
    analyze(context,pos);
    let sum=0;
    const power = powers.map((_,k) => spectrum[2*k]**2+spectrum[2*k+1]**2);
    for (const v of power) sum+=v;
    if(sum>1e-7) power.forEach((v,k) => powers[k].push(v));
  }
  const floor=powers.map(values => values.length<6 ? 0 : values.sort((a,b)=>a-b)[Math.floor(values.length*0.25)]);
  const result=new Float32Array(x.length), weight=new Float32Array(x.length);
  const bands=[[0,-12],[65,-10],[180,0],[800,0],[1800,2.5],[3500,2.5],[6000,0],[8000,-2]];
  const eq=floor.map((_,k)=>{
    const f=k*RATE/n, right=bands.findIndex(([hz])=>hz>=f);
    if(right<=0) return 10**(bands[0][1]/20);
    const [a,lo]=bands[right-1], [b,hi]=bands[right];
    return 10**((lo+(hi-lo)*(f-a)/(b-a))/20);
  });
  for(let pos=-hop;pos<x.length;pos+=hop) {
    analyze(x,pos);
    for(let k=0;k<=hop;k++){
      const p=spectrum[2*k]**2+spectrum[2*k+1]**2;
      const gain=Math.sqrt(Math.max(0.13,1-1.4*floor[k]/Math.max(p,1e-15)))*eq[k];
      spectrum[2*k]*=gain; spectrum[2*k+1]*=gain;
    }
    fft.completeSpectrum(spectrum); fft.inverseTransform(inverse,spectrum);
    for(let i=Math.max(0,-pos);i<Math.min(n,x.length-pos);i++){
      result[pos+i]+=inverse[2*i]*window[i]; weight[pos+i]+=window[i]**2;
    }
  }
  return lift(result.map((v,i)=>v/Math.max(weight[i],1e-10)));
}

export function wav(x) {
  const buf=new ArrayBuffer(44+2*x.length), view=new DataView(buf);
  const tag=(i,s)=>{for(let j=0;j<s.length;j++)view.setUint8(i+j,s.charCodeAt(j));};
  tag(0,'RIFF'); view.setUint32(4,36+2*x.length,true); tag(8,'WAVE');tag(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,RATE,true);view.setUint32(28,2*RATE,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  tag(36,'data');view.setUint32(40,2*x.length,true);
  x.forEach((v,i)=>view.setInt16(44+2*i,Math.round(Math.max(-1,Math.min(1,v))*32767),true));
  return new Blob([buf],{type:'audio/wav'});
}
