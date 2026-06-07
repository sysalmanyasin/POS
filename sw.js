// Increment this version number whenever you deploy major changes to your app files
const CACHE_NAME = 'pharmapos-cache-v2';

// 1. INSTALL: Let the worker install, but stay in the 'waiting' room
self.addEventListener('install', (event) => {
    // We intentionally do NOT call self.skipWaiting() here.
    // The service worker will wait until app.html says it is safe to take over.
});

// 2. MESSAGE: Listen for the safety clearance from app.html
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting(); // Now it's safe to activate
    }
});

// 3. ACTIVATE: Clear out the old cache version and take control
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

// 4. FETCH: Stale-While-Revalidate (Instant serving, background updating)
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    
    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cachedResponse = await cache.match(event.request);
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse.ok) {
                    cache.put(event.request, networkResponse.clone());
                }
                return networkResponse;
            });
            return cachedResponse || fetchPromise;
        })
    );
});
