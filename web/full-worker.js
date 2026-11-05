import {processBlock} from './full-audio.js?v=strong1';
let previous=null;
self.onmessage=({data:{samples,skip,count,tailLength,profile}})=>{
  try{
    const {pcm,tail}=processBlock(samples,skip,count,tailLength,previous,profile);previous=tail;
    postMessage({pcm},[pcm.buffer]);
  }catch(e){postMessage({error:e.message||String(e)});}
};
