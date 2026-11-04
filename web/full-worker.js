import {processBlock} from './full-audio.js';
let previous=null;
self.onmessage=({data:{samples,skip,count,tailLength}})=>{
  try{
    const {pcm,tail}=processBlock(samples,skip,count,tailLength,previous);previous=tail;
    postMessage({pcm},[pcm.buffer]);
  }catch(e){postMessage({error:e.message||String(e)});}
};
