// ============================================================
// DuaPharmaPos — Service Worker
// Strategy: Cache-First for app shell, Network-bypass for
//           Supabase, EmailJS, and all external API traffic.
// ============================================================

const CACHE_NAME = 'pharmapos-cache-v19.6';
// ⚠️ CACHE_NAME is auto-updated by GitHub Actions on every deploy.
// Do NOT manually edit the version number — it will be overwritten.

// ── App shell: every file the app needs to run offline ──────
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',

    // JavaScript modules
    '/js/config.js',
    '/js/storage.js',
    '/js/auth.js',
    '/js/ui.js',
    '/js/billing.js',
    '/js/inventory.js',
    '/js/history.js',
    '/js/settings.js',
    '/js/reporting.js',
    '/js/devices.js',
    '/js/syncHub.js',
    '/js/auditLog.js',

    // Stylesheets
    '/css/tokens.css',
    '/css/layout.css',
    '/css/components.css',
    '/css/print.css',

    // Icons (fixes blank icon on Android home screen add)
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/shortcut-sync.png'
];

// ── Domains that must NEVER be intercepted by the SW ────────
// Supabase REST, realtime, auth + EmailJS CDN
const BYPASS_HOSTS = [
    'supabase.co',
    'emailjs.com',
    'jsdelivr.net'
];

// ── Helper: should this request bypass the SW? ──────────────
function shouldBypass(url) {
    if (url.pathname.includes('/rest/v1/'))   return true;
    if (url.pathname.includes('/realtime/'))  return true;
    if (url.pathname.includes('/auth/v1/'))   return true;
    return BYPASS_HOSTS.some(host => url.hostname.includes(host));
}

// ============================================================
// 1. INSTALL — cache all core assets in one shot
// ============================================================
self.addEventListener('install', (event) => {
    console.log('[SW] Installing — caching core assets...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(
                CORE_ASSETS.map(url =>
                    fetch(url, { cache: 'reload' })
                        .then(res => {
                            if (res.ok) return cache.put(url, res);
                            console.warn('[SW] Skipped (not OK):', url);
                        })
                        .catch(err => console.warn('[SW] Skipped (fetch failed):', url, err.message))
                )
            );
        })
    );
    // skipWaiting is intentionally NOT called here.
    // The app sends SKIP_WAITING only when no active transaction is open.
});

// ============================================================
// 2. MESSAGE — app signals it's safe to swap the SW
// ============================================================
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW] Safe swap signal received — activating new SW.');
        self.skipWaiting();
    }
});

// ============================================================
// 3. ACTIVATE — delete old caches, take control immediately
// ============================================================
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating — removing old caches...');
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => {
                        console.log('[SW] Deleted old cache:', key);
                        return caches.delete(key);
                    })
            ))
            .then(() => self.clients.claim())
    );
});

// ============================================================
// 4. FETCH — Cache-First with background revalidation
// ============================================================
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Let Supabase, EmailJS, and CDN traffic go directly to network
    if (shouldBypass(url)) return;

    // Navigation requests (typing URL, clicking link) → serve index.html
    // This makes the PWA work correctly as a single-page app
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.match('/index.html')
                .then(cached => cached || fetch(event.request))
                .catch(() => caches.match('/index.html'))
        );
        return;
    }

    // All other requests: serve from cache instantly, revalidate in background
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request, { ignoreSearch: true });

            // Background revalidation — silently update cache with fresh file
            const revalidate = fetch(event.request)
                .then(networkRes => {
                    if (networkRes.ok) {
                        cache.put(event.request, networkRes.clone());
                    }
                    return networkRes;
                })
                .catch(() => {
                    // Network unavailable — offline mode, cache will serve
                });

            // Return cached version immediately if available, otherwise wait for network
            return cached || revalidate;
        })
    );
});
