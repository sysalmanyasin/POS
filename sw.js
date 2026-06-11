/**
 * Dua Pharma POS - Enterprise Production Service Worker
 * Version: pharmapos-cache-v12.4 (Added syncHub.js + auditLog.js to offline cache)
 */

const CACHE_NAME = 'pharmapos-cache-v18.4';

// Explicit structural cache list to guarantee the system works offline instantly on day one
const CORE_ASSETS = [
    '/',
    '/index.html',
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
    '/js/syncHub.js',      // FIX: was missing — sync engine must be cached for offline use
    '/js/auditLog.js',     // FIX: was missing — audit log module must load offline
    '/css/tokens.css',
    '/css/layout.css',
    '/css/components.css',
    '/css/print.css',
    '/manifest.json'
];

// 1. INSTALL: Populate the cache storage instantly so it functions offline from a cold start
self.addEventListener('install', (event) => {
    console.log('[SW] Initializing structural asset capture loop...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Using map + individual puts guarantees that one missing icon won't crash the entire installation
            return Promise.all(
                CORE_ASSETS.map(url => {
                    return fetch(url, { cache: 'reload' })
                        .then(res => {
                            if (res.ok) return cache.put(url, res);
                            throw new Error(`Asset fetch rejected: ${url}`);
                        })
                        .catch(err => console.warn(`[SW Install Warning] Skipping non-critical asset entry:`, err));
                })
            );
        })
    );
    // Intentionally omitting self.skipWaiting() to honor the app's idle update checks
});

// 2. MESSAGE: Listen for the safety clearance from index.html runtime tracking
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW] Idle clearance received. Swapping execution contexts safely...');
        self.skipWaiting(); 
    }
});

// 3. ACTIVATE: Clear out old cache versions cleanly and claim client control instantly
self.addEventListener('activate', (event) => {
    console.log('[SW] System activation sequence engaged.');
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

// 4. FETCH: Intelligent Split-Strategy (Instant Cache UI + Invisible Network Revalidation)
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // CRITICAL GUARD: Completely insulate real-time Supabase replication and authentication traffic
    if (url.pathname.includes('/rest/v1/') || url.hostname.includes('supabase.co')) {
        return; 
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
            
            // Asynchronous background task: fetches fresh files from GitHub CDN and updates the cache silently
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse.ok) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            }).catch((err) => {
                console.log('[SW Network State] Terminal disconnected; running smoothly on local asset cache.', err.message);
            });

            // Return the cached file immediately for maximum counter performance. Fall back to network if missing.
            return cachedResponse || fetchPromise;
        })
    );
});
