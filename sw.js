/**
 * Dua Pharma POS - Enterprise Production Service Worker
 * Version: pharmapos-cache-v11.4 (Optimized for Custom Domain & Strict Offline Isolation)
 */

const CACHE_NAME = 'pharmapos-cache-v12.2';

// Explicit structural cache list to guarantee the system works offline instantly on day one
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/config.js',
    '/auth.js',
    '/ui.js',
    '/storage.js',
    '/inventory.js',
    '/billing.js',
    '/devices.js',
    '/history.js',
    '/reporting.js',
    '/settings.js',
    '/tokens.css',
    '/layout.css',
    '/components.css',
    '/print.css',
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
            const cachedResponse = await cache.match(event.request);
            
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
