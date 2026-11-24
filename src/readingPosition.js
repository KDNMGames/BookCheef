import {useCallback,useEffect,useRef,useState} from 'react';

const PREFIX='bookcheef-reading-position-v1:';
const LIMIT=120;
const memory=new Map();
const writers=new Map();
const storageKey=(owner,bookId)=>`${PREFIX}${encodeURIComponent(owner||'guest')}/${encodeURIComponent(bookId)}`;
const timestamp=value=>Date.parse(value?.updatedAt)||0;

export function cleanPosition(value) {
 if(!value||typeof value!=='object')return null;
 const out={};
 if(Number.isSafeInteger(value.pageNumber)&&value.pageNumber>0)out.pageNumber=value.pageNumber;
 if(typeof value.anchorId==='string'&&/^ch\d{3}(?:-p\d+)?$/.test(value.anchorId))out.anchorId=value.anchorId;
 if(typeof value.nodeId==='string'&&value.nodeId.length<=160)out.nodeId=value.nodeId;
 for(const key of ['scrollOffset','scrollY'])if(Number.isFinite(value[key])&&value[key]>=0)out[key]=Math.round(value[key]);
 if(!(Object.keys(out).length))return null;
 if(timestamp(value))out.updatedAt=new Date(timestamp(value)).toISOString();
 return out;
}

export function newestPosition(...values) {
 return values.map(cleanPosition).filter(Boolean).reduce((newest,value)=>!newest||timestamp(value)>=timestamp(newest)?value:newest,null);
}

function localRead(key) {
 let stored;
 try{stored=JSON.parse(localStorage.getItem(key));}catch{}
 return newestPosition(stored,memory.get(key));
}
function localWrite(key,value) {
 memory.delete(key);
 memory.set(key,value);
 if(memory.size>LIMIT)memory.delete(memory.keys().next().value);
 try{
  localStorage.setItem(key,JSON.stringify(value));
  const keys=Object.keys(localStorage).filter(k=>k.startsWith(PREFIX));
  if(keys.length>LIMIT){
   const oldest=keys.map(k=>{let date=0;try{date=timestamp(JSON.parse(localStorage.getItem(k)));}catch{}return [k,date];}).sort((a,b)=>b[1]-a[1]);
   for(const [k] of oldest.slice(LIMIT))localStorage.removeItem(k);
  }
 }catch{}
}
function clearSynced(key,value) {
 try{if(timestamp(JSON.parse(localStorage.getItem(key)))<=timestamp(value))localStorage.removeItem(key);}catch{}
}

async function writeToAccount(client,owner,bookId,value) {
 const row={user_id:owner,book_id:bookId,last_opened_at:value.updatedAt,reading_progress:value};
 const {error:insertError}=await client.from('user_reading_history').upsert(row,{onConflict:'user_id,book_id',ignoreDuplicates:true});
 if(insertError)throw insertError;
 const {error}=await client.from('user_reading_history').update({reading_progress:value,last_opened_at:value.updatedAt})
  .eq('user_id',owner).eq('book_id',bookId)
  .or(`reading_progress->>updatedAt.is.null,reading_progress->>updatedAt.lte.${value.updatedAt}`);
 if(error)throw error;
}
async function drain(key,writer) {
 if(writer.running)return;
 writer.running=true;
 try{
  while(writer.pending){
   const value=writer.pending;writer.pending=null;
   try{await writeToAccount(writer.client,writer.owner,writer.bookId,value);clearSynced(key,value);}
   catch{
    // The pending position is already in this browser. A newer write can still
    // succeed; otherwise retry when the reader comes online or reopens the book.
    if(!writer.pending)break;
   }
  }
 }finally{writer.running=false;if(writers.get(key)===writer&&!writer.pending)writers.delete(key);}
}
function queueSync(client,owner,bookId,key,value) {
 if(!client||!owner||!value?.updatedAt)return;
 const writer=writers.get(key)||{client,owner,bookId,running:false,pending:null};
 writer.pending=newestPosition(writer.pending,value);
 writers.set(key,writer);
 void drain(key,writer);
}

// The returned initial position is frozen for this opening. Scroll updates do
// not re-run restoration or reset the page while the reader is using it.
export function useReadingPosition({active,owner,bookId,client}) {
 const key=active?storageKey(owner,bookId):null;
 const [initial,setInitial]=useState(null);
 const current=useRef(null);
 useEffect(()=>{
  if(!key){setInitial(null);return;}
  const abort=new AbortController();
  const session={key,owner,bookId,value:localRead(key)};
  current.current=session;
  let alive=true;
  const ready=value=>{if(!alive)return;session.value=value;setInitial({key,value});};
  const retry=()=>{const value=localRead(key);if(value)queueSync(client,owner,bookId,key,value);};
  if(!owner||!client)ready(session.value);
  else{
   const timer=setTimeout(()=>abort.abort(),2200);
   (async()=>{
    let remote=null;
    try{
     const result=await client.from('user_reading_history').select('reading_progress').eq('user_id',owner).eq('book_id',bookId).abortSignal(abort.signal).maybeSingle();
     if(!result.error)remote=cleanPosition(result.data?.reading_progress);
    }catch{}finally{clearTimeout(timer);}
    if(!alive)return;
    const local=localRead(key);
    const latest=newestPosition(local,remote);
    if(local&&(!remote||timestamp(local)>timestamp(remote)))queueSync(client,owner,bookId,key,local);
    else if(remote)clearSynced(key,remote);
    ready(latest);
   })();
  }
  window.addEventListener('online',retry);
  return()=>{alive=false;abort.abort();window.removeEventListener('online',retry);if(current.current===session)current.current=null;};
 },[key,client,owner,bookId]);
 const save=useCallback(patch=>{
  const session=current.current;
  if(!session||session.key!==key)return;
  const value=cleanPosition({...session.value,...patch});
  if(!value)return;
  if(['pageNumber','nodeId','anchorId','scrollOffset','scrollY'].every(k=>value[k]===session.value?.[k]))return;
  value.updatedAt=new Date(Math.max(Date.now(),timestamp(session.value)+1)).toISOString();
  session.value=value;
  localWrite(key,value);
  queueSync(client,session.owner,session.bookId,key,value);
 },[client,key]);
 return {ready:!!key&&initial?.key===key,initial:initial?.key===key?initial.value:null,save};
}

export function useReadingScroll({active,identity,position,save}) {
 const record=useRef(null);
 useEffect(()=>{
  if(!active)return;
  const article=document.querySelector('.reader');
  if(!article)return;
  const area=()=>article.querySelector('.bookcheef-native-text')||article;
  let timer,frame,pendingPosition,working=false,scrollOverride=0,anchors;
  function getPosition(){
   const node=area(),r=node.getBoundingClientRect();
   const offset=Math.max(0,Math.min(Math.round(r.height-1),Math.round(16-r.top)));
   if(node===article)return {anchorId:undefined,scrollOffset:offset,scrollY:undefined};
   anchors??=[...node.querySelectorAll('h2[id],p[id]')];
   let lo=0,hi=anchors.length;
   while(lo<hi){const mid=(lo+hi)>>>1;if(anchors[mid].getBoundingClientRect().top<=24)lo=mid+1;else hi=mid;}
   const anchor=anchors[lo-1];
   if(!anchor)return {anchorId:undefined,scrollOffset:offset,scrollY:undefined};
   return {anchorId:anchor.id,scrollOffset:Math.max(0,Math.round(16-anchor.getBoundingClientRect().top)),scrollY:undefined};
  }
  const flush=()=>{if(timer){clearTimeout(timer);timer=null;save(pendingPosition);}};
  const scroll=()=>{
   if(!working||article.querySelector('[data-reader-incomplete]')||performance.now()<scrollOverride)return;
   if(timer)clearTimeout(timer);
   pendingPosition=getPosition();
   timer=setTimeout(flush,450);
  };
  const release=()=>{working=true;scrollOverride=performance.now()+200;};
  let firstApplied,loadingObserver,restoreAnchor,nextAnchor;
  const observeLoad=()=>{
   if(loadingObserver)return;
   loadingObserver=new MutationObserver(()=>{
    if(article.querySelector('[data-reader-pending]'))return;
    loadingObserver.disconnect();loadingObserver=null;
    if(!working)frame=requestAnimationFrame(restore);
   });
   loadingObserver.observe(article,{childList:true,subtree:true});
  };
  function restore(){
   if(working)return;
   const pending=article.querySelector('[data-reader-pending]');
   const now=performance.now();
   if(pending){observeLoad();return;}
   if(article.querySelector('[data-reader-incomplete]')){release();return;}
   const content=area();
   const anchor=position?.anchorId&&content!==article?content.querySelector('#'+position.anchorId):null;
   if(Number.isFinite(position?.scrollOffset)&&(!position.anchorId||anchor)){
    const r=(anchor||content).getBoundingClientRect();
    if(anchor&&restoreAnchor!==anchor){
     restoreAnchor=anchor;const items=[...content.querySelectorAll('h2[id],p[id]')];nextAnchor=items[items.indexOf(anchor)+1];
    }
    const span=anchor&&nextAnchor?Math.max(r.height,nextAnchor.getBoundingClientRect().top-r.top):r.height;
    const offset=Math.min(Math.max(0,Math.round(span)-1),position.scrollOffset||0);
    const delta=r.top+offset-16;
    if(Math.abs(delta)>1)window.scrollBy({top:delta,behavior:'instant'});
   }else if(Number.isFinite(position?.scrollY))window.scrollTo({top:position.scrollY,behavior:'instant'});
   else {release();return;}
   // Cover, subscription controls and the measured reader can settle on
   // different animation frames after navigating directly to a book.
   firstApplied??=now;
   if(now-firstApplied<450)frame=requestAnimationFrame(restore);
   else release();
  }
  const cancelRestore=()=>{if(!working){cancelAnimationFrame(frame);working=true;}};
  window.addEventListener('scroll',scroll,{passive:true});
  window.addEventListener('pagehide',flush);
  window.addEventListener('pointerdown',cancelRestore,{passive:true});
  window.addEventListener('keydown',cancelRestore);
  window.addEventListener('wheel',cancelRestore,{passive:true});
  window.addEventListener('touchstart',cancelRestore,{passive:true});
  const hidden=()=>{if(document.visibilityState==='hidden')flush();};
  document.addEventListener('visibilitychange',hidden);
  frame=requestAnimationFrame(restore);
  const reset=()=>{if(timer)clearTimeout(timer);timer=null;pendingPosition=undefined;cancelAnimationFrame(frame);working=true;scrollOverride=performance.now()+330;};
  record.current={reset,flush};
  return()=>{
   cancelAnimationFrame(frame);loadingObserver?.disconnect();flush();record.current=null;
   window.removeEventListener('scroll',scroll);window.removeEventListener('pagehide',flush);
   window.removeEventListener('pointerdown',cancelRestore);window.removeEventListener('keydown',cancelRestore);
   window.removeEventListener('wheel',cancelRestore);window.removeEventListener('touchstart',cancelRestore);
   document.removeEventListener('visibilitychange',hidden);
  };
 },[active,identity,position,save]);
 return record;
}
