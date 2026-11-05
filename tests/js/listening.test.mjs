import test from 'node:test';
import assert from 'node:assert/strict';
import {clarify,liftForListening} from '../../web/audio.js';

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
