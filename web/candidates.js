// Reconcile independent timestamps only within the same acoustic window.
// A long hypothesis can cover several shorter ones. Never zip by row index.
const key=text=>text?.normalize('NFC').trim().replace(/\s+/g,' ').replace(/[.。]+$/u,'').trim();
export function pairCandidates(original,enhanced){
  // A full-window failure/silence is not an utterance boundary. Keep the other
  // pass's independent utterances reviewable instead of collapsing them all.
  const unavailable=pass=>pass.length===1 && /^\[(인식 실패|판독 불가|판독 가능한 소리 없음)\]$/.test(pass[0].text);
  if(unavailable(original)&&enhanced.length>1)original=enhanced.map(({start,end})=>({start,end,text:original[0].text}));
  if(unavailable(enhanced)&&original.length>1)enhanced=original.map(({start,end})=>({start,end,text:enhanced[0].text}));
  const nodes=[...original.map(c=>({...c,side:'original'})),...enhanced.map(c=>({...c,side:'enhanced'}))];
  const roots=nodes.map((_,i)=>i);
  function root(i){while(i!==roots[i])i=roots[i];return i;}
  for(let i=0;i<original.length;i++)for(let j=original.length;j<nodes.length;j++){
    const a=nodes[i],b=nodes[j],overlap=Math.min(a.end,b.end)-Math.max(a.start,b.start);
    if(overlap>0 && overlap>=0.45*Math.min(a.end-a.start,b.end-b.start))roots[root(j)]=root(i);
  }
  const groups=new Map();
  nodes.forEach((node,i)=>{const id=root(i);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(node);});
  return [...groups.values()].map(group=>{
    const spans=group.sort((a,b)=>a.start-b.start||a.end-b.end);
    const phrase=side=>spans.filter(s=>s.side===side).map(s=>s.text).join(' ')||null;
    const original=phrase('original'),enhanced=phrase('enhanced');
    const different=key(original)!==key(enhanced);
    return {start:Math.min(...spans.map(s=>s.start)),end:Math.max(...spans.map(s=>s.end)),
      text:different?'':original,candidates:{original,enhanced,different,spans}};
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
}
