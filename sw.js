// Increment this version number whenever you deploy major changes to your app files
const CACHE_NAME = 'pharmapos-cache-v11.5';

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

// 4. FETCH: Network-first for JS/CSS (always get latest code),
//           Stale-while-revalidate for everything else (images, fonts, html)
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isAppCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

    if (isAppCode) {
        // Network-first: always fetch fresh JS/CSS from server.
        // Fall back to cache only if network fails (offline).
        event.respondWith(
            fetch(event.request).then((networkResponse) => {
                if (networkResponse.ok) {
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, networkResponse.clone());
                    });
                }
                return networkResponse;
            }).catch(() => caches.match(event.request))
        );
    } else {
        // Stale-while-revalidate for everything else (HTML, images, icons)
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
    }
});
