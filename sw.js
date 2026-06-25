// ============================================================
// Pharma POS — Service Worker  v29  (Ultimate Edition)
//
// Cache strategies by resource type:
//   Navigation   → Network-First (4s) → Cache → Offline page
//   JS / CSS     → Cache-First → background revalidate
//   Images       → Cache-First (long-lived, no revalidation)
//   External API → Network-Only bypass (Supabase, Dropbox, EmailJS)
//
// Extra capabilities:
//   • Inline offline fallback page (no extra file needed)
//   • BroadcastChannel → notifies app of NEW_CONTENT / offline state
//   • Background Sync  → flushes pharma-sync-queue on reconnect
//   • Cache pruning    → keeps caches from growing unbounded
//   • Safe SW swap     → only activates on SKIP_WAITING message
// ============================================================

const SW_VERSION   = 'v1.07';
const SHELL_CACHE  = 'pharmapos-cache-v1.07';
const IMAGE_CACHE  = 'pharmapos-cache-v1.07-images';

// Keep at most this many entries per cache bucket
const MAX_IMAGE_ENTRIES = 60;

// Network timeout for navigation requests (ms)
const NAV_TIMEOUT_MS = 4000;

// ── BroadcastChannel for app ↔ SW communication ─────────────
// Falls back silently in browsers without BroadcastChannel.
function _broadcast(msg) {
    try {
        const ch = new BroadcastChannel('pharmapos-sw');
        ch.postMessage(msg);
        ch.close();
    } catch (_) {}
}

// ── App shell: every local file the app needs offline ────────
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',

    // Core JS modules (Exactly 16 files verified from production)
    '/js/auditLog.js',
    '/js/auth.js',
    '/js/billing.js',
    '/js/config.js',
    '/js/credentialshare.js', // <-- Newly added credential module
    '/js/devices.js',
    '/js/dropbox.js',
    '/js/history.js',
    '/js/inventory.js',
    '/js/reporting.js',
    '/js/settings.js',
    '/js/setup.js',
    '/js/sqlgen.js',
    '/js/storage.js',
    '/js/syncHub.js',
    '/js/ui.js',

    // Stylesheets
    '/css/components.css',
    '/css/layout.css',
    '/css/print.css',
    '/css/tokens.css'
];

// Icons are cached separately (IMAGE_CACHE — long-lived)
const ICON_ASSETS = [
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/shortcut-sync.png'
];

// ── External hosts that must NEVER be intercepted ────────────
const BYPASS_HOSTS = [
    'supabase.co',           // Supabase REST / realtime / auth
    'emailjs.com',           // EmailJS SDK & API
    'jsdelivr.net',          // CDN (EmailJS browser bundle)
    'cdnjs.cloudflare.com',  // Any additional CDN assets
    'dropboxapi.com',        // Dropbox API (upload/download)
    'content.dropboxapi.com',// Dropbox file content
    'notify.dropbox.com',    // Dropbox push notifications
    'dropbox.com'            // Dropbox OAuth & web
];

function _shouldBypass(url) {
    if (url.pathname.includes('/rest/v1/'))  return true; // Supabase REST
    if (url.pathname.includes('/realtime/')) return true; // Supabase Realtime
    if (url.pathname.includes('/auth/v1/'))  return true; // Supabase Auth
    if (url.pathname.includes('/storage/'))  return true; // Supabase Storage
    return BYPASS_HOSTS.some(h => url.hostname.includes(h));
}

function _isImageRequest(request) {
    return request.destination === 'image' ||
           /\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i.test(new URL(request.url).pathname);
}

function _isShellAsset(url) {
    const p = url.pathname;
    return p.endsWith('.js') || p.endsWith('.css') ||
           p === '/' || p.endsWith('.html') || p.endsWith('.json');
}

// ── Inline offline fallback page ─────────────────────────────
// Served when navigation fails and there is no cached page.
const OFFLINE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f172a">
<title>Pharma POS — Offline</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       min-height:100vh;padding:24px;text-align:center}
  .icon{font-size:64px;margin-bottom:20px;opacity:.9}
  h1{font-size:22px;font-weight:800;color:#fff;margin-bottom:10px}
  p{font-size:14px;color:#94a3b8;line-height:1.6;max-width:340px}
  .badge{display:inline-block;margin-top:20px;background:#1e293b;border:1px solid #334155;
         border-radius:8px;padding:10px 20px;font-size:12px;color:#64748b}
  button{margin-top:24px;background:#0d9488;color:#fff;border:none;border-radius:8px;
         padding:12px 28px;font-size:14px;font-weight:700;cursor:pointer;transition:.15s}
  button:hover{background:#0f766e}
</style>
</head>
<body>
  <div class="icon">📡</div>
  <h1>You're offline</h1>
  <p>Pharma POS can't reach the network right now.<br>
     All local data and billing continue to work — reconnect to sync.</p>
  <div class="badge">🟡 Offline work mode active</div>
  <button onclick="location.reload()">Try again</button>
</body>
</html>`;

const OFFLINE_RESPONSE = new Response(OFFLINE_PAGE_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
});

// ── Cache helper: prune a cache bucket to max N entries ──────
async function _pruneCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys  = await cache.keys();
    if (keys.length > maxEntries) {
        const toDelete = keys.slice(0, keys.length - maxEntries);
        await Promise.all(toDelete.map(k => cache.delete(k)));
    }
}

// ── Network fetch with timeout ────────────────────────────────
function _fetchWithTimeout(request, ms) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), ms)
    );
    return Promise.race([fetch(request), timeout]);
}

// ============================================================
// 1. INSTALL — precache app shell + icons
// ============================================================
self.addEventListener('install', (event) => {
    console.log(`[SW ${SW_VERSION}] Installing — precaching assets…`);
    event.waitUntil((async () => {
        // Cache shell assets
        const shellCache = await caches.open(SHELL_CACHE);
        await Promise.all(
            SHELL_ASSETS.map(url =>
                fetch(url, { cache: 'reload' })
                    .then(res => {
                        if (res.ok) return shellCache.put(url, res);
                        console.warn(`[SW] Skipped shell (${res.status}):`, url);
                    })
                    .catch(err => console.warn('[SW] Skipped shell (network):', url, err.message))
            )
        );
        // Cache icon assets (separate bucket)
        const imageCache = await caches.open(IMAGE_CACHE);
        await Promise.all(
            ICON_ASSETS.map(url =>
                fetch(url, { cache: 'reload' })
                    .then(res => {
                        if (res.ok) return imageCache.put(url, res);
                        console.warn(`[SW] Skipped icon (${res.status}):`, url);
                    })
                    .catch(err => console.warn('[SW] Skipped icon (network):', url, err.message))
            )
        );
        console.log(`[SW ${SW_VERSION}] Precache complete.`);
    })());
});

// ============================================================
// 2. MESSAGE — explicit safe-swap signal + debug commands
// ============================================================
self.addEventListener('message', (event) => {
    if (!event.data) return;
    switch (event.data.type) {
        case 'SKIP_WAITING':
            console.log(`[SW ${SW_VERSION}] Safe swap granted — activating.`);
            self.skipWaiting();
            break;
        case 'CACHE_STATUS':
            (async () => {
                const keys = await caches.keys();
                const sizes = await Promise.all(
                    keys.map(async k => ({ name: k, count: (await (await caches.open(k)).keys()).length }))
                );
                event.source?.postMessage({ type: 'CACHE_STATUS_REPLY', caches: sizes });
            })();
            break;
        case 'FORCE_RECACHE':
            (async () => {
                await caches.delete(SHELL_CACHE);
                const cache = await caches.open(SHELL_CACHE);
                await Promise.all(
                    SHELL_ASSETS.map(url =>
                        fetch(url, { cache: 'reload' })
                            .then(res => { if (res.ok) cache.put(url, res); })
                            .catch(() => {})
                    )
                );
                _broadcast({ type: 'RECACHE_DONE' });
                console.log(`[SW ${SW_VERSION}] Force-recache complete.`);
            })();
            break;
    }
});

// ============================================================
// 3. ACTIVATE — delete ALL old caches, take control immediately
// ============================================================
self.addEventListener('activate', (event) => {
    console.log(`[SW ${SW_VERSION}] Activating — cleaning old caches…`);
    event.waitUntil((async () => {
        const validCaches = new Set([SHELL_CACHE, IMAGE_CACHE]);
        const allKeys     = await caches.keys();
        await Promise.all(
            allKeys
                .filter(key => !validCaches.has(key))
                .map(key => {
                    console.log('[SW] Deleted stale cache:', key);
                    return caches.delete(key);
                })
        );
        await self.clients.claim();
        _broadcast({ type: 'SW_ACTIVATED', version: SW_VERSION });
        console.log(`[SW ${SW_VERSION}] Active and controlling all clients.`);
    })());
});

// ============================================================
// 4. BACKGROUND SYNC — flush offline queue on reconnect
// ============================================================
self.addEventListener('sync', (event) => {
    if (event.tag === 'pharma-sync-queue') {
        console.log(`[SW ${SW_VERSION}] Background sync triggered — notifying app.`);
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clients => {
                    clients.forEach(c => c.postMessage({ type: 'BG_SYNC_READY' }));
                })
        );
    }
});

// ============================================================
// 5. PERIODIC BACKGROUND SYNC — poll for cloud updates
// ============================================================
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'pharma-periodic-sync') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clients => {
                    if (clients.length > 0) {
                        clients.forEach(c => c.postMessage({ type: 'PERIODIC_SYNC_TICK' }));
                    }
                })
        );
    }
});

// ============================================================
// 6. FETCH — per-resource cache strategies
// ============================================================
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // External APIs: total bypass — do not intercept
    if (_shouldBypass(url)) return;

    // ── A. Navigation: Network-First with offline fallback ──
    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const networkRes = await _fetchWithTimeout(
                    new Request(event.request.url, { credentials: 'same-origin' }),
                    NAV_TIMEOUT_MS
                );
                if (networkRes.ok) {
                    const cache = await caches.open(SHELL_CACHE);
                    cache.put(event.request, networkRes.clone());
                    return networkRes;
                }
                throw new Error(`HTTP ${networkRes.status}`);
            } catch (_) {
                const cached = await caches.match('/index.html');
                if (cached) return cached;
                return OFFLINE_RESPONSE.clone();
            }
        })());
        return;
    }

    // ── B. Images / icons: Cache-First, separate bucket ───
    if (_isImageRequest(event.request)) {
        event.respondWith((async () => {
            const imageCache = await caches.open(IMAGE_CACHE);
            const shellCache = await caches.open(SHELL_CACHE);
            const cached     = await imageCache.match(event.request, { ignoreSearch: true })
                            || await shellCache.match(event.request, { ignoreSearch: true });
            if (cached) return cached;
            try {
                const res = await fetch(event.request);
                if (res.ok) {
                    imageCache.put(event.request, res.clone());
                    _pruneCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES).catch(() => {});
                }
                return res;
            } catch (_) {
                return new Response('', { status: 408 });
            }
        })());
        return;
    }

    // ── C. App shell (JS / CSS / HTML / JSON): Cache-First + bg revalidate ──
    if (_isShellAsset(url)) {
        event.respondWith((async () => {
            const cache  = await caches.open(SHELL_CACHE);
            const cached = await cache.match(event.request, { ignoreSearch: true });
            const revalidate = fetch(event.request)
                .then(networkRes => {
                    if (!networkRes.ok) return networkRes;
                    cache.put(event.request, networkRes.clone()).catch(() => {});
                    return networkRes;
                })
                .catch(() => null);
            return cached || await revalidate || new Response('', { status: 503 });
        })());
        return;
    }

    // ── D. Everything else: Network-First with cache fallback ──
    event.respondWith((async () => {
        try {
            const res = await fetch(event.request);
            if (res.ok) {
                const cache = await caches.open(SHELL_CACHE);
                cache.put(event.request, res.clone()).catch(() => {});
            }
            return res;
        } catch (_) {
            const cached = await caches.match(event.request, { ignoreSearch: true });
            return cached || new Response('', { status: 503 });
        }
    })());
});
