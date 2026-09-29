// sw.js — Highway Vocational Center
const CACHE_NAME = 'hvc-v3';
const PRECACHE = [
  './',
  './index.html'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(PRECACHE).catch(function(){});
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

// Network-first for navigation (always try fresh HTML)
// Cache-first for static assets
self.addEventListener('fetch', function(event){
  var req = event.request;

  // Only handle GET
  if(req.method !== 'GET') return;

  // Skip Supabase and cross-origin API calls
  var url = new URL(req.url);
  if(url.origin !== location.origin) return;

  // HTML / navigations → network first
  if(req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1){
    event.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); }).catch(function(){});
        return res;
      }).catch(function(){
        return caches.match(req).then(function(r){ return r || caches.match('./'); });
      })
    );
    return;
  }

  // Static assets → cache first, then network
  event.respondWith(
    caches.match(req).then(function(cached){
      if(cached) return cached;
      return fetch(req).then(function(res){
        if(res && res.status === 200 && res.type === 'basic'){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(req, copy); }).catch(function(){});
        }
        return res;
      }).catch(function(){ return cached; });
    })
  );
});