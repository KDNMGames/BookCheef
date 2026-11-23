const CACHE_NAME='bookcheef-shell-v1';
const BASE='/BookCheef/';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll([BASE,BASE+'index.html'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('bookcheef-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin||!url.pathname.startsWith(BASE))return;
 if(request.mode==='navigate'){
  event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(BASE+'index.html',response.clone()));return response}).catch(()=>caches.match(BASE+'index.html').then(response=>response||caches.match(BASE))));
  return;
 }
 if(['script','style','font','image'].includes(request.destination)){
  event.respondWith(caches.match(request).then(cached=>{
   const update=fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response});
   return cached||update;
  }));
 }
});
