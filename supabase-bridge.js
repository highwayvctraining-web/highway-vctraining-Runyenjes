/* ================================================================
   supabase-bridge.js — Highway Vocational Center
   Production bridge: Supabase-backed KV store, settings, counters,
   storage uploads, realtime sync, with in-memory cache + dedupe.
   ================================================================ */
(function(){
'use strict';

/* ════════════════════════════════════════════════════════════════
   CONFIG — Highway Vocational Center production keys
   ════════════════════════════════════════════════════════════════ */
var SUPABASE_URL      = 'https://nqpinzqlmplbbjdqxyss.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xcGluenFsbXBsYmJqZHF4eXNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1NjE2NTksImV4cCI6MjEwNjEzNzY1OX0.NTliIEDe2TqeOybZW7iqSxaQHabKj9NinH7j-vXq2To';
var BUCKET = 'hvc-media';
/* ════════════════════════════════════════════════════════════════ */

/* ---------- FALLBACK: supabase-js library missing ---------- */
function installFallback(reason){
  console.error('[sb] ' + reason);
  console.error('[sb] Make sure this loads BEFORE supabase-bridge.js:');
  console.error('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/dist/umd/supabase.js"><\/script>');

  var noopAsync = function(){ return Promise.resolve(false); };

  window.SB = {
    ready: Promise.resolve(),
    get: function(k, f){ return Promise.resolve(f === undefined ? null : f); },
    set: noopAsync,
    remove: noopAsync,
    getSync: function(k, f){ return f === undefined ? null : f; },
    setSoon: function(){},
    getSetting: function(k, f){ return Promise.resolve(f); },
    setSetting: noopAsync,
    query: function(){ return Promise.resolve([]); },
    nextCounter: function(){ return Promise.resolve(1); },
    client: null,
    _offline: true
  };
  window.SBStorage = {
    upload: function(d){ return Promise.resolve(d); },
    uploadFile: function(){ return Promise.resolve(null); }
  };
}

if(!window.supabase || !window.supabase.createClient){
  installFallback('Supabase library missing.');
  return;
}

/* ---------- CLIENT ---------- */
var sb;
try {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth:     { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
    global:   { headers: { 'x-application-name': 'hvc-web' } }
  });
} catch(e){
  installFallback('Failed to create Supabase client: ' + e.message);
  return;
}
window.__sb = sb;

/* ================================================================
   IN-MEMORY CACHE (zero re-fetch after first read)
   ================================================================ */
var MEM_CACHE = Object.create(null);
var CACHE_TTL = 60 * 60 * 1000; // 1 hour
var FETCH_INFLIGHT = Object.create(null);

function cacheGet(key){
  var e = MEM_CACHE[key];
  if(!e) return undefined;
  if(Date.now() - e.t > CACHE_TTL){ delete MEM_CACHE[key]; return undefined; }
  return e.v;
}
function cacheSet(key, v){ MEM_CACHE[key] = { v: v, t: Date.now() }; }
function cacheDelete(key){ delete MEM_CACHE[key]; }

/* ================================================================
   KV STORE
   ================================================================ */
async function fetchKey(key){
  if(FETCH_INFLIGHT[key]) return FETCH_INFLIGHT[key];

  var p = (async function(){
    try {
      var r = await sb.from('kv_store').select('value').eq('key', key).maybeSingle();
      if(r.error) throw r.error;
      var v = r.data ? r.data.value : null;
      cacheSet(key, v);
      return v;
    } catch(e){
      console.warn('[sb] fetch failed for "' + key + '":', e.message);
      var c = cacheGet(key);
      return c !== undefined ? c : null;
    } finally {
      delete FETCH_INFLIGHT[key];
    }
  })();

  FETCH_INFLIGHT[key] = p;
  return p;
}

async function upsertKey(key, value){
  cacheSet(key, value);
  try {
    var r = await sb.from('kv_store').upsert(
      { key: key, value: value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if(r.error){
      console.error('[sb] upsert FAILED "' + key + '":', r.error.message);
      return false;
    }
    return true;
  } catch(e){
    console.error('[sb] upsert EXCEPTION "' + key + '":', e.message);
    return false;
  }
}

async function deleteKey(key){
  cacheDelete(key);
  try {
    var r = await sb.from('kv_store').delete().eq('key', key);
    if(r.error) throw r.error;
    return true;
  } catch(e){
    console.warn('[sb] delete failed for "' + key + '":', e.message);
    return false;
  }
}

/* ================================================================
   PRELOAD ALL KEYS ONCE
   ================================================================ */
var ALL_LOADED = false;
var ALL_LOADING = null;
function preloadAll(){
  if(ALL_LOADED) return Promise.resolve();
  if(ALL_LOADING) return ALL_LOADING;

  ALL_LOADING = (async function(){
    try {
      var r = await sb.from('kv_store').select('key,value');
      if(r.error) throw r.error;
      (r.data || []).forEach(function(row){ cacheSet(row.key, row.value); });
      ALL_LOADED = true;
      console.log('%c[sb] ✓ preloaded ' + (r.data || []).length + ' keys', 'color:#0a6b3b;font-weight:bold;');
    } catch(e){
      console.warn('[sb] preload failed:', e.message);
      console.warn('[sb] → Did you create the "kv_store" table and disable RLS?');
    } finally {
      ALL_LOADING = null;
    }
  })();

  return ALL_LOADING;
}

/* ================================================================
   PUBLIC API
   ================================================================ */
window.SB = {
  ready: preloadAll(),

  /* ---------- KV ---------- */
  get: async function(key, fallback){
    var c = cacheGet(key);
    if(c !== undefined) return c;
    var v = await fetchKey(key);
    if(v === null || v === undefined){
      return (fallback === undefined ? null : fallback);
    }
    return v;
  },

  set: function(key, value){ return upsertKey(key, value); },

  remove: function(key){ return deleteKey(key); },

  getSync: function(key, fallback){
    var v = cacheGet(key);
    return v === undefined ? (fallback === undefined ? null : fallback) : v;
  },

  setSoon: function(key, value){
    // Fire-and-forget write. Cache updated instantly.
    cacheSet(key, value);
    upsertKey(key, value).catch(function(){});
  },

  /* ---------- SETTINGS (passwords etc.) ---------- */
  getSetting: async function(key, fallback){
    try {
      var r = await sb.from('admin_settings').select('value').eq('key', key).maybeSingle();
      if(r.error || !r.data) return fallback;
      return r.data.value;
    } catch(e){
      return fallback;
    }
  },

  setSetting: async function(key, value){
    try {
      var r = await sb.from('admin_settings').upsert(
        { key: key, value: String(value), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if(r.error) throw r.error;
      return true;
    } catch(e){
      console.warn('[sb] setSetting failed for "' + key + '":', e.message);
      return false;
    }
  },

  /* ---------- QUERY HELPER ---------- */
  query: async function(table, filters){
    try {
      var q = sb.from(table).select('*');
      (filters || []).forEach(function(f){ q = q.eq(f[0], f[1]); });
      var r = await q;
      if(r.error){ console.warn('[sb] query', table, r.error.message); return []; }
      return r.data || [];
    } catch(e){
      return [];
    }
  },

  /* ---------- COUNTERS ---------- */
  nextCounter: async function(name){
    try {
      var r = await sb.rpc('next_counter', { counter_name: name });
      if(r.error) throw r.error;
      var n = Number(r.data);
      if(!n || n < 1) throw new Error('Invalid counter value');
      return n;
    } catch(e){
      console.warn('[sb] nextCounter("' + name + '") failed:', e.message);
      // Deterministic-ish fallback so IDs don't collide on retry
      return Date.now() + Math.floor(Math.random() * 1000);
    }
  },

  /* ---------- RAW CLIENT ---------- */
  client: sb
};

/* ================================================================
   STORAGE (public bucket, CDN-cached 1 year)
   ================================================================ */
function dataUrlToBlob(dataUrl){
  var parts = dataUrl.split(',');
  var mimeMatch = parts[0].match(/:(.*?);/);
  var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  var bin = atob(parts[1]);
  var arr = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return { blob: new Blob([arr], { type: mime }), mime: mime };
}

function mimeToExt(mime){
  var ext = (mime || '').split('/')[1] || 'jpg';
  if(ext === 'jpeg') ext = 'jpg';
  if(ext === 'svg+xml') ext = 'svg';
  return ext;
}

function randomPath(folder, ext){
  return (folder || 'misc') + '/' +
         Date.now() + '_' +
         Math.random().toString(36).slice(2, 8) + '.' + ext;
}

window.SBStorage = {
  /* Deterministic upload — same slot = same path = old file overwritten. */
  uploadSlot: async function(dataUrl, folder, slot){
    try {
      if(!dataUrl || dataUrl.indexOf('data:') !== 0) return dataUrl;
      var parsed = dataUrlToBlob(dataUrl);
      var ext  = mimeToExt(parsed.mime);
      var safe = String(slot || 'file').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      var path = (folder || 'misc') + '/' + safe + '.' + ext;
      var up = await sb.storage.from(BUCKET).upload(path, parsed.blob, {
        contentType: parsed.mime,
        cacheControl: '3600',
        upsert: true
      });
      if(up.error) throw up.error;
      var pub = sb.storage.from(BUCKET).getPublicUrl(path);
      if(!pub || !pub.data || !pub.data.publicUrl) throw new Error('No public URL returned');
      return pub.data.publicUrl + '?v=' + Date.now();
    } catch(e){
      console.warn('[sb] storage.uploadSlot failed:', e.message);
      return dataUrl;
    }
  },

  /* Upload a data URL. Returns public URL, or the original dataUrl on failure. */
  upload: async function(dataUrl, folder){
    try {
      if(!dataUrl || dataUrl.indexOf('data:') !== 0) return dataUrl;
      var parsed = dataUrlToBlob(dataUrl);
      var path = randomPath(folder, mimeToExt(parsed.mime));

      var up = await sb.storage.from(BUCKET).upload(path, parsed.blob, {
        contentType: parsed.mime,
        cacheControl: '31536000',
        upsert: false
      });
      if(up.error) throw up.error;

      var pub = sb.storage.from(BUCKET).getPublicUrl(path);
      if(!pub || !pub.data || !pub.data.publicUrl) throw new Error('No public URL returned');
      return pub.data.publicUrl;
    } catch(e){
      console.warn('[sb] storage.upload failed:', e.message);
      return dataUrl; // graceful fallback: keep the data URL
    }
  },

  /* Upload a File object. Returns public URL, or null on failure. */
  uploadFile: async function(file, folder){
    try {
      if(!file) return null;
      var safeName = (file.name || 'file').replace(/[^a-z0-9.]/gi, '_');
      var path = (folder || 'misc') + '/' + Date.now() + '_' + safeName;

      var up = await sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '31536000',
        upsert: false
      });
      if(up.error) throw up.error;

      var pub = sb.storage.from(BUCKET).getPublicUrl(path);
      if(!pub || !pub.data || !pub.data.publicUrl) throw new Error('No public URL returned');
      return pub.data.publicUrl;
    } catch(e){
      console.warn('[sb] storage.uploadFile failed:', e.message);
      return null;
    }
  }
};

/* ================================================================
   REALTIME — single channel, dispatches CustomEvents
   ================================================================ */
try {
  sb.channel('hvc-all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv_store' }, function(p){
      try {
        if(p.eventType === 'DELETE'){
          if(p.old && p.old.key) cacheDelete(p.old.key);
        } else if(p.new && p.new.key){
          cacheSet(p.new.key, p.new.value);
        }
        window.dispatchEvent(new CustomEvent('sb:kv-change', { detail: p }));
      } catch(e){}
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, function(p){
      window.dispatchEvent(new CustomEvent('sb:students-change', { detail: p }));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, function(p){
      window.dispatchEvent(new CustomEvent('sb:payments-change', { detail: p }));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, function(p){
      window.dispatchEvent(new CustomEvent('sb:applications-change', { detail: p }));
    })
    .subscribe(function(status){
      if(status === 'SUBSCRIBED'){
        console.log('%c[sb] realtime subscribed', 'color:#0a6b3b;');
      } else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'){
        console.warn('[sb] realtime status:', status);
      }
    });
} catch(e){
  console.warn('[sb] realtime setup failed:', e.message);
}

/* ================================================================
   KICK OFF PRELOAD + ONLINE/OFFLINE NOTICES
   ================================================================ */
preloadAll();

window.addEventListener('online', function(){
  console.log('%c[sb] back online', 'color:#0a6b3b;');
});
window.addEventListener('offline', function(){
  console.warn('[sb] offline — changes will queue in memory only');
});

console.log('%c[Supabase Bridge] Ready', 'color:#0a6b3b;font-weight:bold;');
console.log('%cConnected to: ' + SUPABASE_URL, 'color:#c9a227;');
})();