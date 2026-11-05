import FFT from './vendor/fft.js';
const RATE = 16000;
export function lift(x) {
  let peak = 0, energy = 0;
  for (const v of x) { peak = Math.max(peak, Math.abs(v)); energy += v * v; }
  if (!peak) return x.slice();
  const gain = Math.min(31.62, 0.98 / peak, Math.max(1, 0.1 / Math.sqrt(energy / x.length)));
  return x.map(v => v * gain);
}

// Local level control for listening. One loud syllable must not limit every quieter one.
export function liftForListening(x, speechEvidence) {
  if (!x.length) return x.slice();
  const hop=160, count=Math.ceil(x.length/hop);
  const energy=new Float64Array(count+1), peaks=new Float64Array(count);
  for(let i=0;i<x.length;i++){
    const k=Math.floor(i/hop);
    energy[k+1]+=x[i]*x[i]; peaks[k]=Math.max(peaks[k],Math.abs(x[i]));
  }
  for(let k=0;k<count;k++)energy[k+1]+=energy[k];
  const gains=new Float64Array(count);
  for(let k=0;k<count;k++){
    const left=Math.max(0,k-3), right=Math.min(count,k+4);
    const rms=Math.sqrt((energy[right]-energy[left])/(Math.min(right*hop,x.length)-left*hop));
    const confidence=speechEvidence ? speechEvidence[Math.min(speechEvidence.length-1,Math.floor(k*hop/256)+1)] : 1;
    // Reduce gain in background-only frames. A raised noise floor obscures word endings.
    const wanted=confidence*Math.min(38,Math.max(0,20*Math.log10(0.14/Math.max(rms,1e-9))));
    gains[k]=10**(wanted/20);
  }
  const safe=gains.map((gain,k)=>{
    const peak=Math.max(peaks[k],peaks[Math.max(0,k-1)],peaks[Math.min(k+1,count-1)]);
    return Math.min(gain,0.94/Math.max(1e-9,peak));
  });
  return x.map((v,i)=>{
    const k=Math.floor(i/hop), t=(i%hop)/hop;
    return v*(safe[k]+(safe[Math.min(count-1,k+1)]-safe[k])*t);
  });
}

export function clarify(x, context, profile='standard') {
  const strong=profile===true||profile==='strong',precise=profile==='precise';
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
    if(Number.isFinite(sum)) power.forEach((v,k) => powers[k].push(v));
  }
  const floor=powers.map(values => values.length<6 ? 0 : values.sort((a,b)=>a-b)[Math.floor(values.length*0.25)]);
  const result=new Float32Array(x.length), weight=new Float32Array(x.length);
  const bands=precise
    ? [[0,-24],[70,-18],[140,-4],[300,-1],[800,0],[1600,2],[3000,4],[4800,3],[6500,0],[8000,-6]]
    : strong
    ? [[0,-30],[85,-22],[140,-12],[300,-5],[700,-1],[1500,4],[3000,5],[4500,3],[6200,-2],[8000,-12]]
    : [[0,-22],[70,-18],[140,-6],[300,-2],[800,0],[1600,3],[3200,6],[4800,4],[6500,1],[8000,-3]];
  const eq=floor.map((_,k)=>{
    const f=k*RATE/n, right=bands.findIndex(([hz])=>hz>=f);
    if(right<=0) return 10**(bands[0][1]/20);
    const [a,lo]=bands[right-1], [b,hi]=bands[right];
    return 10**((lo+(hi-lo)*(f-a)/(b-a))/20);
  });
  const evidence=[],previousPower=new Float64Array(hop+1),masks=new Float64Array(hop+1);
  for(let pos=-hop;pos<x.length;pos+=hop) {
    analyze(x,pos);
    let voicePower=0, noisePower=0;
    for(let k=0;k<=hop;k++){
      const p=spectrum[2*k]**2+spectrum[2*k+1]**2;
      if(k>=6 && k<=170){voicePower+=p;noisePower+=floor[k];}
      // Protect brief spectral onsets; do not reconstruct or synthesize missing phonemes.
      const onset=precise&&p>2*previousPower[k]&&p>4*floor[k];
      const subtraction=precise?(onset?0.65:1.5):(strong?3.5:2.4);
      masks[k]=Math.max(precise?10**(-9/10):strong?10**(-15/10):0.05,1-subtraction*floor[k]/Math.max(p,1e-15));
      previousPower[k]=p;
    }
    for(let k=0;k<=hop;k++){
      const mask=precise?(masks[Math.max(0,k-1)]+2*masks[k]+masks[Math.min(hop,k+1)])/4:masks[k];
      const gain=Math.sqrt(mask)*eq[k];
      spectrum[2*k]*=gain; spectrum[2*k+1]*=gain;
    }
    const ratio=voicePower/Math.max(noisePower*3.2,1e-12);
    evidence.push(Math.max(0,Math.min(1,(ratio-1.1)/1.8)));
    fft.completeSpectrum(spectrum); fft.inverseTransform(inverse,spectrum);
    for(let i=Math.max(0,-pos);i<Math.min(n,x.length-pos);i++){
      result[pos+i]+=inverse[2*i]*window[i]; weight[pos+i]+=window[i]**2;
    }
  }
  const leveled=liftForListening(result.map((v,i)=>v/Math.max(weight[i],1e-10)),evidence);
  if(precise){
    let peak=0;for(const value of leveled)peak=Math.max(peak,Math.abs(value));
    // Linear makeup avoids the extra harmonics of the stronger mode's soft saturation.
    const makeup=Math.min(1.7,.92/Math.max(peak,1e-12));
    return leveled.map(value=>value*makeup);
  }
  return strong?leveled.map(v=>0.92*Math.tanh(2*v/0.92)):leveled;
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
