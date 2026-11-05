import test from 'node:test';
import assert from 'node:assert/strict';
import {clarify,liftForListening,limitForListening} from '../../web/audio.js';

test('a loud passage does not cap the gain on a later faint syllable',()=>{
  const sr=16000;
  const x=Float32Array.from({length:sr*3},(_,i)=>{
    const tone=f=>Math.sin(2*Math.PI*f*i/sr);
    let v=0.004*tone(60);
    if(i>sr/4 && i<sr*0.75)v+=0.7*tone(350);
    if(i>sr*1.6 && i<sr*1.85)v+=0.005*tone(220)+0.002*tone(3000);
    return v;
  });
  const input=x.slice();
  const gain=(output,a,b)=>{
    const power=signal=>signal.subarray(a,b).reduce((sum,v)=>sum+v*v,0);
    return 10*Math.log10(power(output)/power(x));
  };
  const clear=clarify(x,x);
  for(const result of [clear,liftForListening(x)]){
    assert.ok(gain(result,26000,29200)>15);
    assert.ok(gain(result,6000,10240)<4);
    assert.equal(result.length,x.length);
    assert.ok(result.every(v=>Number.isFinite(v)&&Math.abs(v)<=0.941));
  }
  assert.ok(gain(clear,35000,43000)<-6);
  assert.deepEqual(x,input);
  assert.ok(clarify(new Float32Array(23),x).every(v=>v===0));
});

test('strong mode raises a sub-second quiet voice above standard while lowering steady hum',()=>{
  const x=Float32Array.from({length:48000},(_,i)=>{
    const tone=f=>Math.sin(2*Math.PI*f*i/16000);
    return .004*tone(60)+(i>4000&&i<12000?.7*tone(350):0)
      +(i>25600&&i<29600?.005*tone(220)+.002*tone(3000):0);
  });
  const original=x.slice(),standard=clarify(x,x),strong=clarify(x,x,true);
  const energy=(s,a,b)=>s.subarray(a,b).reduce((sum,v)=>sum+v*v,0);
  const gain=(a,b,start,end)=>10*Math.log10(energy(a,start,end)/energy(b,start,end));
  assert.ok(gain(strong,standard,26000,29200)>3);
  assert.ok(gain(strong,x,26000,29200)>20);
  assert.ok(gain(strong,x,35000,43000)<-10);
  assert.equal(strong.length,x.length);
  assert.ok(strong.every(v=>Number.isFinite(v)&&Math.abs(v)<.92));
  assert.deepEqual(x,original);
  for(const length of [1,23,640,16000]){
    const silent=new Float32Array(length);
    assert.deepEqual(clarify(silent,silent,true),silent);
  }
});

test('precise mode retains a brief sound and avoids saturation harmonics on a clean vowel-like tone',()=>{
  const x=new Float32Array(48000);
  for(let i=8000;i<16000;i++)x[i]=.4*Math.sin(2*Math.PI*1000*i/16000);
  for(let i=24000;i<24640;i++)x[i]=.004*Math.sin(2*Math.PI*3000*i/16000);
  const precise=clarify(x,x,'precise'),strong=clarify(x,x,'strong');
  const amplitude=(signal,hz)=>{
    let re=0,im=0;
    for(let i=10000;i<14000;i++){const phase=2*Math.PI*hz*i/16000;re+=signal[i]*Math.cos(phase);im+=signal[i]*Math.sin(phase);}
    return Math.hypot(re,im);
  };
  const harmonic=signal=>amplitude(signal,3000)/amplitude(signal,1000);
  assert.ok(harmonic(precise)<.001);
  assert.ok(harmonic(strong)>.02);
  const energy=signal=>signal.slice(24000,24640).reduce((sum,v)=>sum+v*v,0);
  assert.ok(energy(precise)>energy(x)*10);
  assert.equal(precise.length,x.length);
  assert.ok(precise.every(v=>Number.isFinite(v)&&Math.abs(v)<=.920001));
  assert.deepEqual(clarify(new Float32Array(23),new Float32Array(23),'precise'),new Float32Array(23));
});

test('maximum listening raises very faint speech while controlling sudden peaks and preserving silence',()=>{
  const x=Float32Array.from({length:48000},(_,i)=>{
    const tone=f=>Math.sin(2*Math.PI*f*i/16000);
    return .0001*tone(60)+(i>4000&&i<12000?.7*tone(350):0)
      +(i>25600&&i<29600?.0003*tone(220)+.0002*tone(3000):0);
  });
  const max=clarify(x,x,'maximum'),strong=clarify(x,x,'strong');
  const power=(s,a,b)=>s.slice(a,b).reduce((sum,v)=>sum+v*v,0);
  assert.ok(10*Math.log10(power(max,26000,29200)/power(strong,26000,29200))>5);
  assert.ok(power(max,35000,43000)<power(x,35000,43000));
  assert.ok(max.every(v=>Number.isFinite(v)&&Math.abs(v)<=.920001));
  const spikes=Float32Array.from({length:10000},(_,i)=>i%157===0?1.2:.03);
  const limited=limitForListening(spikes);
  assert.ok(limited.every(v=>v>=0&&v<=.920001));
  assert.ok(limited[0]>.8);
  assert.equal(limited.length,spikes.length);
  for(const length of [0,1,23,16000]){
    const silence=new Float32Array(length);
    assert.deepEqual(clarify(silence,silence,'maximum'),silence);
  }
});
