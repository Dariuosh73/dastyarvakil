// Network-first for the app shell: each host update reaches users; cache is only the offline fallback.
// laws.json is stale-while-revalidate: it is large (~2.7MB) and changes only with a release, so a
// returning user gets it instantly from cache while a fresh copy loads quietly in the background.
const C='vakil-v4.6';
const FILES=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./privacy.html'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(FILES.map(f=>c.add(f).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);if(u.origin!==location.origin||u.pathname.endsWith('version.json'))return;
  if(u.pathname.endsWith('laws.json')){
    e.respondWith(caches.open(C).then(c=>c.match(e.request).then(cached=>{
      const upd=fetch(e.request,{cache:'no-cache'}).then(r=>{if(r&&r.ok)c.put(e.request,r.clone());return r}).catch(()=>null);
      return cached||upd||fetch(e.request);
    })));
    return;
  }
  e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html')||caches.match('./'))));
});
