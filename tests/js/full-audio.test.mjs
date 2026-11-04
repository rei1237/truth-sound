import test from 'node:test';
import assert from 'node:assert/strict';
import {block,overlap,pad,processBlock,waveBlob,readPcm} from '../../web/full-audio.js';
import {speechWindows,uncoveredSpeech,padShortSpeech} from '../../web/speech-windows.js';
test('recover a faint 80ms reply and pad short input without shifting stored timestamps',()=>{
  const x=new Float32Array(16000);x.fill(.0005,6400,7680);
  assert.deepEqual(uncoveredSpeech(x,[[0,6400],[7680,16000]]),[[6400,7680]]);
  assert.deepEqual(uncoveredSpeech(new Float32Array(16000),[]),[]);
  const short=x.slice(6400,7680),padded=padShortSpeech(short);
  assert.equal(padded.length,16000);assert.deepEqual(padded.slice(4000,5280),short);
  assert.ok(padded.slice(0,4000).every(v=>v===0));
});
test('retry audible gaps in model timestamps, leaving silence and covered speech alone',()=>{
  const x=new Float32Array(32000);x.fill(.004,11000,13400);
  assert.deepEqual(uncoveredSpeech(x,[[20000,26000],[0,8000]]),[[8000,20000]]);
});
test('pause boundaries partition the entire recording without dropping a short faint reply',()=>{
  const x=new Float32Array(16000*4);
  x.fill(.15,4000,18000);x.fill(.003,27000,32000);x.fill(.1,43000,59000);
  const spans=speechWindows(x);
  assert.equal(spans.length,3);assert.ok(spans[1][0]<27000 && spans[1][1]>32000);
  assert.equal(spans[0][0],0);assert.equal(spans.at(-1)[1],x.length);
  assert.ok(spans.every(([a],i)=>!i||a===spans[i-1][1]));
});
test('continuous render preserves the sample clock across seams and the partial final block',async()=>{
  const n=2*block+83,sr=16000;
  const raw=Float32Array.from({length:n},(_,i)=>{
    const tone=f=>Math.sin(2*Math.PI*i*f/sr);
    if(i<300||i>=2*block)return 0;
    return .003*tone(60)+(i>3000&&i<9000?.6*tone(390):0)
      +(i>block-2100 && i<block+2300?.003*tone(250)+.0015*tone(3100):0);
  });
  let tail=null,seam=null;const parts=[];
  for(let s=0;s<n;s+=block){
    const count=Math.min(block,n-s),a=Math.max(0,s-pad),t=Math.min(overlap,n-s-count);
    const out=processBlock(raw.subarray(a,s+count+t+pad),s-a,count,t,tail);
    tail=out.tail;parts.push(out.pcm);
    if(s===0)seam=tail.slice(0,32);
  }
  const blob=waveBlob(parts,n),y=await readPcm(blob,0,n);
  assert.equal(blob.size,n*2+44);assert.equal(y.length,n);
  const power=(x,a,b)=>x.subarray(a,b).reduce((s,v)=>s+v*v,0);
  const db=(a,b)=>10*Math.log10(power(y,a,b)/power(raw,a,b));
  for(const [a,b] of [[block-2000,block-300],[block+300,block+2200]])assert.ok(db(a,b)>14);
  assert.ok(db(4000,8000)<4);assert.ok(db(20000,30000)<-6);
  // The seam must follow the continuation of the previous rendering, even on a sharp consonant.
  assert.ok(Math.abs(y[block]-seam[0])<=1/32767);
  assert.ok(seam.every((v,i)=>Math.abs(y[block+i]-v)<.012));
  assert.deepEqual(await readPcm(blob,block-2,block+3),y.slice(block-2,block+3));
  assert.ok(y.every(v=>Math.abs(v)<=.941));
});
