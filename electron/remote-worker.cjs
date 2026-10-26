"use strict";

/** Browser credentials live in origin-scoped IndexedDB, not cookies (which
 * would also be sent to unrelated HTTPS ports on this Tailscale hostname).
 * The worker authenticates full-page navigation, assets, fetch, and SSE. */
const remoteWorker = `
const database = () => new Promise((resolve,reject) => {
  const request=indexedDB.open('learnharness-remote',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('session');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
async function session(value) {
  const db=await database();
  try { return await new Promise((resolve,reject)=>{
    const transaction=db.transaction('session',value===undefined?'readonly':'readwrite');
    const store=transaction.objectStore('session');
    const request=value===undefined?store.get('token'):store.put(value,'token');
    let result;request.onsuccess=()=>{result=request.result};
    transaction.oncomplete=()=>resolve(result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
  }); } finally { db.close(); }
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
  if(event.data?.type!=='pair'||!event.source?.url||new URL(event.source.url).origin!==self.location.origin||!/^[\\w-]{43}$/.test(event.data.token))return;
  event.waitUntil(session(event.data.token).then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname==='/_lh/remote/sw.js')return;
  event.respondWith((async()=>{
    const token=await session().catch(()=>null);
    if(!token)return fetch(event.request);
    const headers=new Headers(event.request.headers);headers.set('x-learnharness-remote',token);
    // Browser stylesheet/script/image requests often use no-cors, whose
    // header guard drops our credential. These URLs were checked above.
    return fetch(new Request(event.request,{headers,mode:'same-origin'}));
  })());
});
`;

module.exports = { remoteWorker };
