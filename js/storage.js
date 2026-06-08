// =========================================================================
// MODULE: StorageModule v7 — IndexedDB primary, localStorage cache
// BUG 4 FIX:  offline_sync_queue now carries explicit event_type enum:
//             'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID'
//             drainSyncQueue routes each type to the correct cloud handler.
// BUG 7 FIX:  Cloud inventory writes use delta vectors (+X/-X), never
//             absolute stock numbers. Atomic RPC used during drain.
// BUG 9 FIX:  Every queue record stamped with _lamportNext() sequence so
//             events sort correctly regardless of device wall-clock drift.
// =========================================================================
const StorageModule = (() => {
    const IDB_NAME    = 'PharmaDataDB';
    const IDB_VERSION = 6;
    let _idb   = null;
    let _ready = false;
    const _pending = [];

    // ── Supabase KV key map ───────────────────────────────────────────────
    function _buildSupaKeys() {
        let dc = 'DEV';
        try {
            const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
            const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (raw) dc = raw.slice(0, 20);
        } catch(e) {}
        return {
            invoices:  'pharma_cloud_invoices',
            heldBills: 'pharma_cloud_held_bills_' + dc,
            cart:      null,
            inventory: 'pharma_cloud_inventory',
            staff:     'pharma_cloud_staff',
            settings:  'pharma_cloud_settings'
        };
    }
    const SUPA_KEYS = _buildSupaKeys();
    let isSyncEnabled = false;

    // ── IDB open ──────────────────────────────────────────────────────────
    const _req = indexedDB.open(IDB_NAME, IDB_VERSION);
    _req.onupgradeneeded = function(e) {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('kv'))
            d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('invoices'))
            d.createObjectStore('invoices', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('heldBills'))
            d.createObjectStore('heldBills', { keyPath: '_hbIdx', autoIncrement: true });
        if (!d.objectStoreNames.contains('cart'))
            d.createObjectStore('cart');
        if (!d.objectStoreNames.contains('sync_queue'))
            d.createObjectStore('sync_queue', { keyPath: 'id' });
        // v4: structured event queue — append-only event log
        if (!d.objectStoreNames.contains('offline_sync_queue'))
            d.createObjectStore('offline_sync_queue', { keyPath: 'queueId', autoIncrement: true });
        // v5: dead-letter queue for exhausted retries
        if (!d.objectStoreNames.contains('failed_sync_logs'))
            d.createObjectStore('failed_sync_logs', { keyPath: 'id', autoIncrement: true });
        // v6: audit log — append-only action history
        if (!d.objectStoreNames.contains('audit_log')) {
            const al = d.createObjectStore('audit_log', { keyPath: 'id' });
            al.createIndex('by_action', 'action', { unique: false });
            al.createIndex('by_ts',     'ts',     { unique: false });
        }
    };
    _req.onsuccess = function(e) {
        _idb = e.target.result;
        _ready = true;
        _pending.forEach(fn => { try { fn(_idb); } catch(ex) {} });
        _pending.length = 0;
        _loadQueueFromIDB();
    };
    _req.onerror = function(e) {
        console.error('[StorageModule] IndexedDB open failed:', e.target && e.target.error);
        _idb = null;
        _ready = true;
        _pending.forEach(fn => { try { fn(null); } catch(ex) {} });
        _pending.length = 0;
        if (typeof showToast === 'function')
            showToast('⚠️ Local database unavailable. Using localStorage fallback only.', true);
    };

    function _whenReady(fn) {
        if (_ready) { try { fn(_idb); } catch(ex) {} }
        else _pending.push(fn);
    }

    // ── KV helpers ────────────────────────────────────────────────────────
    function set(key, value) {
        try { localStorage.setItem(key, value); } catch(e) {}
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['kv'], 'readwrite').objectStore('kv').put(value, key); } catch(e) {}
        });
    }

    function get(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v !== null ? v : (fallback !== undefined ? fallback : null);
        } catch(e) { return fallback !== undefined ? fallback : null; }
    }

    function remove(key) {
        try { localStorage.removeItem(key); } catch(e) {}
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['kv'], 'readwrite').objectStore('kv').delete(key); } catch(e) {}
        });
    }

    // ── Invoice persistence ───────────────────────────────────────────────
    let _invoiceSaveLock    = false;
    let _invoiceSavePending = null;

    function saveInvoices(ledger, onSuccess) {
        _queuedSupaSet(SUPA_KEYS.invoices, JSON.stringify(ledger));
        if (_invoiceSaveLock) { _invoiceSavePending = { ledger, onSuccess }; return; }
        _doIDBInvoiceWrite(ledger, onSuccess);
    }

    function _doIDBInvoiceWrite(ledger, onSuccess) {
        _invoiceSaveLock = true;
        _whenReady(idb => {
            if (!idb) {
                _writeInvoicesToLocalStorage(ledger);
                _invoiceSaveLock = false; _flushPendingInvoiceSave(); return;
            }
            if (!Array.isArray(ledger)) { _invoiceSaveLock = false; _flushPendingInvoiceSave(); return; }
            try {
                const tx = idb.transaction(['invoices'], 'readwrite');
                const st = tx.objectStore('invoices');
                const validIds = new Set();
                ledger.forEach(inv => {
                    if (inv && typeof inv === 'object' && inv.id) {
                        st.put(inv);
                        validIds.add(inv.id);
                    }
                });
                st.getAllKeys().onsuccess = function(ev) {
                    (ev.target.result || []).forEach(k => { if (!validIds.has(k)) st.delete(k); });
                };
                tx.oncomplete = () => {
                    _writeInvoicesToLocalStorage(ledger);
                    _invoiceSaveLock = false; _flushPendingInvoiceSave();
                    if (typeof onSuccess === 'function') { try { onSuccess(ledger); } catch(_e) {} }
                };
                tx.onerror = () => { _invoiceSaveLock = false; _flushPendingInvoiceSave(); };
            } catch(e) { _invoiceSaveLock = false; _flushPendingInvoiceSave(); }
        });
    }

    function _writeInvoicesToLocalStorage(ledger) {
        if (ledger.length < 200) {
            try { localStorage.setItem('pharma_saved_ledger', JSON.stringify(ledger)); } catch(e) {}
        } else {
            try { localStorage.removeItem('pharma_saved_ledger'); } catch(e) {}
        }
    }

    function _flushPendingInvoiceSave() {
        if (_invoiceSavePending !== null) {
            const { ledger, onSuccess } = _invoiceSavePending;
            _invoiceSavePending = null;
            _doIDBInvoiceWrite(ledger, onSuccess);
        }
    }

    function loadInvoices() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { resolve(structuredClone(JSON.parse(localStorage.getItem('pharma_saved_ledger') || '[]'))); }
                    catch(e) { resolve([]); }
                    return;
                }
                try {
                    idb.transaction(['invoices'], 'readonly').objectStore('invoices').getAll()
                        .onsuccess = e => resolve(structuredClone(e.target.result || []));
                } catch(ex) { resolve([]); }
            });
        });
    }

    /** Upsert a single remote invoice into IDB (called by sync pull). */
    function putRemoteInvoice(inv) {
        if (!inv || !inv.id) return;
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['invoices'], 'readwrite').objectStore('invoices').put(inv); } catch(e) {}
        });
    }

    // ── Held Bills ────────────────────────────────────────────────────────
    function saveHeldBills(bills) {
        _whenReady(idb => {
            if (!idb) { try { localStorage.setItem('pharma_held_bills', JSON.stringify(bills)); } catch(e) {} return; }
            try {
                const tx = idb.transaction(['heldBills'], 'readwrite');
                const st = tx.objectStore('heldBills');
                st.clear().onsuccess = () => {
                    bills.forEach((b, i) => { const r = Object.assign({}, b); r._hbIdx = i + 1; st.put(r); });
                };
            } catch(e) {}
        });
    }

    function loadHeldBills() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { resolve(JSON.parse(localStorage.getItem('pharma_held_bills') || '[]')); }
                    catch(e) { resolve([]); }
                    return;
                }
                try {
                    idb.transaction(['heldBills'], 'readonly').objectStore('heldBills').getAll()
                        .onsuccess = e => resolve(structuredClone(e.target.result || []));
                } catch(ex) { resolve([]); }
            });
        });
    }

    // ── Cart ──────────────────────────────────────────────────────────────
    function saveCart(items) {
        _whenReady(idb => {
            if (!idb) { try { localStorage.setItem('pharma_cart', JSON.stringify(items)); } catch(e) {} return; }
            try { idb.transaction(['cart'], 'readwrite').objectStore('cart').put(items, 'active'); } catch(e) {}
        });
    }

    function loadCart() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { resolve(JSON.parse(localStorage.getItem('pharma_cart') || 'null')); }
                    catch(e) { resolve(null); }
                    return;
                }
                try {
                    idb.transaction(['cart'], 'readonly').objectStore('cart').get('active')
                        .onsuccess = e => resolve(e.target.result ? structuredClone(e.target.result) : null);
                } catch(ex) { resolve(null); }
            });
        });
    }

    // =========================================================================
    // BUG 4 FIX — Structured Offline Sync Queue
    // Every mutation now carries an explicit event_type so sync routes correctly.
    // Supported types: 'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID'
    // BUG 9 FIX — All records carry lamport_seq for clock-skew-proof ordering.
    // =========================================================================

    /**
     * Push a structured event to the offline sync queue.
     * @param {string} eventType  — 'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID'
     * @param {object} payload    — the full invoice/event payload
     * @param {number} capturedVersion — inventory version at capture time
     */
    function pushToSyncQueue(eventType, payload, capturedVersion) {
        const validTypes = ['SALE', 'REFUND', 'EDIT_INVOICE', 'VOID'];
        if (!validTypes.includes(eventType)) {
            console.error('[StorageModule] pushToSyncQueue: unknown eventType:', eventType);
            return;
        }

        // BUG 9: stamp with Lamport logical clock, not wall-clock
        const seq = (typeof _lamportNext === 'function') ? _lamportNext() : Date.now();

        const record = {
            type:            eventType,
            payload:         payload,
            capturedVersion: capturedVersion || 0,
            lamport_seq:     seq,
            device_uuid:     (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : 'unknown',
            createdAt:       new Date().toISOString(),
            retryCount:      0
        };

        _whenReady(idb => {
            if (!idb) {
                console.warn('[StorageModule] IDB unavailable — queue record lost for', eventType);
                return;
            }
            try {
                idb.transaction(['offline_sync_queue'], 'readwrite')
                   .objectStore('offline_sync_queue')
                   .add(record);
            } catch(e) {
                console.error('[StorageModule] Failed to enqueue', eventType, e);
            }
        });
    }

    /**
     * Retrieve all pending queue records ordered by lamport_seq (oldest first).
     * Returns a structuredClone so callers cannot mutate IDB state.
     */
    function getSyncQueueOrdered() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) { resolve([]); return; }
                try {
                    idb.transaction(['offline_sync_queue'], 'readonly')
                       .objectStore('offline_sync_queue')
                       .getAll().onsuccess = e => {
                            const all = e.target.result || [];
                            // Sort by Lamport sequence — correct ordering regardless of wall clock
                            all.sort((a, b) => (a.lamport_seq || 0) - (b.lamport_seq || 0));
                            resolve(structuredClone(all));
                        };
                } catch(ex) { resolve([]); }
            });
        });
    }

    /** Delete a processed queue record by its IDB auto-key. */
    function deleteFromSyncQueue(queueId) {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) { resolve(); return; }
                try {
                    const tx = idb.transaction(['offline_sync_queue'], 'readwrite');
                    tx.objectStore('offline_sync_queue').delete(queueId);
                    tx.oncomplete = () => resolve();
                    tx.onerror    = () => resolve();
                } catch(e) { resolve(); }
            });
        });
    }

    /** Return queue depth metrics for the Sync Hub UI. */
    function syncQueueMetrics() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) { resolve({ total: 0, byType: {} }); return; }
                try {
                    idb.transaction(['offline_sync_queue'], 'readonly')
                       .objectStore('offline_sync_queue')
                       .getAll().onsuccess = e => {
                            const all = e.target.result || [];
                            const byType = {};
                            all.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1; });
                            resolve({ total: all.length, byType });
                        };
                } catch(ex) { resolve({ total: 0, byType: {} }); }
            });
        });
    }

    /** Write a poison-pill record to the DLQ for manual review. */
    function writeToFailedSyncLogs(record) {
        _whenReady(idb => {
            if (!idb) return;
            try {
                const entry = Object.assign({}, record, { failedAt: new Date().toISOString() });
                idb.transaction(['failed_sync_logs'], 'readwrite')
                   .objectStore('failed_sync_logs')
                   .add(entry);
            } catch(e) {}
        });
    }

    // ── Legacy cloud KV sync queue (for settings, KV pairs) ──────────────
    const _syncQueue   = [];
    let   _syncDraining = false;
    let   _queueLoaded  = false;

    function _makeSyncEntry(key, value) {
        return {
            id:          _DEVICE_UUID.slice(0, 8) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            key,
            value,
            createdAt:   Date.now(),
            retryCount:  0,
            nextRetryAt: 0,
            deviceId:    _DEVICE_UUID
        };
    }

    function _persistQueueEntry(entry) {
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['sync_queue'], 'readwrite').objectStore('sync_queue').put(entry); } catch(e) {}
        });
    }

    function _removeQueueEntry(id) {
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['sync_queue'], 'readwrite').objectStore('sync_queue').delete(id); } catch(e) {}
        });
    }

    function _loadQueueFromIDB() {
        _whenReady(idb => {
            if (!idb) { _queueLoaded = true; return; }
            try {
                idb.transaction(['sync_queue'], 'readonly').objectStore('sync_queue').getAll().onsuccess = e => {
                    const rows = e.target.result || [];
                    rows.forEach(entry => {
                        if ((entry.retryCount || 0) >= 10) { _removeQueueEntry(entry.id); return; }
                        const idx = _syncQueue.findIndex(i => i.key === entry.key);
                        if (idx >= 0) {
                            if ((entry.createdAt || 0) > (_syncQueue[idx].createdAt || 0)) _syncQueue[idx] = entry;
                        } else {
                            _syncQueue.push(entry);
                        }
                    });
                    _queueLoaded = true;
                    if (isSyncEnabled && _syncQueue.length > 0) _drainSyncQueue().catch(() => {});
                };
            } catch(e) { _queueLoaded = true; }
        });
    }

    function _queuedSupaSet(key, value) {
        if (!key) return;
        if (isSyncEnabled) {
            _supaSet(key, value).catch(() => {
                const existing = _syncQueue.findIndex(i => i.key === key);
                if (existing >= 0) { _syncQueue[existing].value = value; _persistQueueEntry(_syncQueue[existing]); }
                else { const e = _makeSyncEntry(key, value); _syncQueue.push(e); _persistQueueEntry(e); }
            });
        } else {
            const existing = _syncQueue.findIndex(i => i.key === key);
            if (existing >= 0) { _syncQueue[existing].value = value; _persistQueueEntry(_syncQueue[existing]); }
            else { const e = _makeSyncEntry(key, value); _syncQueue.push(e); _persistQueueEntry(e); }
        }
    }

    async function _drainSyncQueue() {
        if (_syncDraining || _syncQueue.length === 0) return;
        _syncDraining = true;
        try {
            const now    = Date.now();
            const toSend = _syncQueue.filter(i => (i.nextRetryAt || 0) <= now);
            for (const item of toSend) {
                try {
                    await _supaSet(item.key, item.value);
                    const idx = _syncQueue.indexOf(item);
                    if (idx >= 0) _syncQueue.splice(idx, 1);
                    _removeQueueEntry(item.id);
                } catch(e) {
                    item.retryCount  = (item.retryCount  || 0) + 1;
                    item.nextRetryAt = Date.now() + Math.min(60000, 5000 * item.retryCount);
                    if (item.retryCount >= 10) {
                        writeToFailedSyncLogs({ queueId: item.id, key: item.key, errorContext: String(e), retryCount: item.retryCount });
                        const idx = _syncQueue.indexOf(item);
                        if (idx >= 0) _syncQueue.splice(idx, 1);
                        _removeQueueEntry(item.id);
                    } else {
                        _persistQueueEntry(item);
                    }
                }
            }
        } finally { _syncDraining = false; }
    }

    // ── Cloud sync engine ─────────────────────────────────────────────────
    function setSyncEnabled(enabled) {
        isSyncEnabled = !!enabled;
        if (isSyncEnabled && _queueLoaded && _syncQueue.length > 0)
            _drainSyncQueue().catch(() => {});
    }

    async function pushLocalToCloudEngine() {
        if (!isSyncEnabled) return;
        await _drainSyncQueue();
    }

    async function syncFromCloudEngine() {
        let changed = false;
        try {
            const raw = await _supaGet(SUPA_KEYS.invoices);
            if (raw) {
                const cloud = JSON.parse(raw);
                if (Array.isArray(cloud) && cloud.length > 0) {
                    const local = await loadInvoices();
                    const ids   = new Set(local.map(i => i.id));
                    const added = cloud.filter(i => i && i.id && !ids.has(i.id));
                    if (added.length > 0) {
                        const merged = [...local, ...added];
                        saveInvoices(merged);
                        changed = true;
                    }
                }
            }
        } catch(e) {}
        return changed;
    }

    async function syncLightweightFromCloud() {
        let changed = false;
        try {
            const raw = await _supaGet(SUPA_KEYS.invoices);
            if (raw) {
                const cloud = JSON.parse(raw);
                if (Array.isArray(cloud) && cloud.length > 0) {
                    const local = await loadInvoices();
                    if (cloud.length !== local.length) {
                        const ids = new Set(local.map(i => i.id));
                        const added = cloud.filter(i => i && i.id && !ids.has(i.id));
                        if (added.length > 0) {
                            const merged = [...local, ...added];
                            saveInvoices(merged);
                            changed = true;
                        }
                    }
                }
            }
        } catch(e) {}
        return changed;
    }

    // ── Full local data purge (BUG 6 FIX support) ─────────────────────────
    // Called by settings.js / devices.js purge flow. Wipes all IDB stores
    // then resolves so the caller can handle cloud + redirect.
    function purgeAllLocalData() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    // Fallback: clear localStorage only
                    try { localStorage.clear(); } catch(e) {}
                    resolve();
                    return;
                }
                const stores = ['invoices', 'heldBills', 'cart', 'sync_queue', 'offline_sync_queue', 'kv', 'failed_sync_logs'];
                let remaining = stores.length;
                function done() { if (--remaining <= 0) resolve(); }
                stores.forEach(storeName => {
                    try {
                        const tx = idb.transaction([storeName], 'readwrite');
                        tx.objectStore(storeName).clear().onsuccess = done;
                        tx.onerror = done;
                    } catch(e) { done(); }
                });
            });
        });
    }

    // =========================================================================
    // AUDIT LOG — IDB read/write (store added in v6)
    // =========================================================================
    function writeAuditLog(entry) {
        _whenReady(idb => {
            if (!idb) return;
            try {
                const tx = idb.transaction(['audit_log'], 'readwrite');
                tx.objectStore('audit_log').put(entry);
            } catch(e) {}
        });
    }

    function getAuditLogs(limit) {
        limit = limit || 2000;
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) { resolve([]); return; }
                try {
                    const tx      = idb.transaction(['audit_log'], 'readonly');
                    const store   = tx.objectStore('audit_log');
                    const results = [];
                    store.openCursor(null, 'prev').onsuccess = function(e) {
                        const cursor = e.target.result;
                        if (cursor && results.length < limit) {
                            results.push(cursor.value);
                            cursor.continue();
                        } else {
                            resolve(results);
                        }
                    };
                    tx.onerror = () => resolve([]);
                } catch(e) { resolve([]); }
            });
        });
    }

    // Also clear audit_log on full purge
    const _origPurge = purgeAllLocalData;
    function purgeAllLocalDataWithAudit() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) { _origPurge().then(resolve); return; }
                const stores = ['invoices', 'heldBills', 'cart', 'sync_queue', 'offline_sync_queue', 'kv', 'failed_sync_logs', 'audit_log'];
                let remaining = stores.length;
                function done() { if (--remaining <= 0) resolve(); }
                stores.forEach(storeName => {
                    try {
                        const tx = idb.transaction([storeName], 'readwrite');
                        tx.objectStore(storeName).clear().onsuccess = done;
                        tx.onerror = done;
                    } catch(e) { done(); }
                });
            });
        });
    }

    // ── Expose public API ─────────────────────────────────────────────────
    return {
        set, get, remove,
        saveInvoices, loadInvoices, putRemoteInvoice,
        saveHeldBills, loadHeldBills,
        saveCart, loadCart,
        pushToSyncQueue, getSyncQueueOrdered, deleteFromSyncQueue,
        syncQueueMetrics, writeToFailedSyncLogs,
        setSyncEnabled, pushLocalToCloudEngine,
        syncFromCloudEngine, syncLightweightFromCloud,
        purgeAllLocalData: purgeAllLocalDataWithAudit,
        writeAuditLog,
        getAuditLogs
    };
})();
