// =========================================================================
// MODULE: StorageModule v6 — IndexedDB primary, localStorage cache for settings
// Changelog v6:
//   - New export: putRemoteInvoice(inv) — upserts a remote invoice pulled from
//     Supabase into the local 'invoices' IDB store (keyed on invoiceNumber).
//     Called by synchub._pullRemoteInvoices() so pulled invoices survive
//     offline sessions. Idempotent: repeated calls for the same invoice_number
//     are safe (IDB put = upsert by keyPath).
// Changelog v5:
//   - IDB_VERSION bumped to 5: adds 'failed_sync_logs' object store (DLQ)
//   - saveInvoices / _doIDBInvoiceWrite accept optional onSuccess callback
//     (called on tx.oncomplete) enabling SSOT Write-Through Log pattern
//   - All read-path getters (loadInvoices, loadHeldBills, loadCart,
//     getSyncQueueOrdered) return structuredClone snapshots to prevent
//     callers from holding mutable references into cache objects
//   - New export: writeToFailedSyncLogs(record) — writes a poison-pill
//     record to the 'failed_sync_logs' IDB store for manual review
// Changelog v4 (retained):
//   - IDB_VERSION bumped to 4: adds 'offline_sync_queue' object store
//   - New exports: pushToSyncQueue(), getSyncQueueOrdered(), deleteFromSyncQueue()
//   - Legacy 'sync_queue' store (cloud-key KV queue) retained and unchanged
//   - 'offline_sync_queue' is exclusively for structured event records:
//     { queueId (auto), type, payload, capturedVersion, createdAt }
// =========================================================================
const StorageModule = (() => {
    const IDB_NAME    = 'PharmaDataDB';
    const IDB_VERSION = 6;  // v6: adds 'audit_log' store for AuditLog module
    let _idb  = null;
    let _ready = false;
    const _pending = [];

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
    // S8 FIX: SUPA_KEYS is computed at module-init time before pharma_branch_identity
    // may be set — the heldBills key would default to '_DEV' and be orphaned when the
    // real counterId is later registered. We expose a getSupaKey() getter that rebuilds
    // the heldBills key fresh on each call so it always uses the current counterId.
    const SUPA_KEYS = _buildSupaKeys();
    function getSupaKey(name) {
        if (name === 'heldBills') {
            // Always recompute so it picks up counterId even if registered after init
            let dc = 'DEV';
            try {
                const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
                const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (raw) dc = raw.slice(0, 20);
            } catch(_e) {}
            return 'pharma_cloud_held_bills_' + dc;
        }
        return SUPA_KEYS[name] || null;
    }
    let isSyncEnabled = false;

    const _req = indexedDB.open(IDB_NAME, IDB_VERSION);
    _req.onupgradeneeded = function(e) {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('kv'))
            d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('invoices'))
            d.createObjectStore('invoices',  { keyPath: 'id' });
        if (!d.objectStoreNames.contains('heldBills'))
            d.createObjectStore('heldBills', { keyPath: '_hbIdx', autoIncrement: true });
        if (!d.objectStoreNames.contains('cart'))
            d.createObjectStore('cart');
        if (!d.objectStoreNames.contains('sync_queue'))
            d.createObjectStore('sync_queue', { keyPath: 'id' });
        // v4: structured event queue for append-only event log pattern
        if (!d.objectStoreNames.contains('offline_sync_queue'))
            d.createObjectStore('offline_sync_queue', { keyPath: 'queueId', autoIncrement: true });
        // v5: dead-letter queue for poison-pill sync items that exhaust retries
        //     Shape: { id (auto), queueId, type, payload, errorContext, failedAt, retryCount }
        if (!d.objectStoreNames.contains('failed_sync_logs'))
            d.createObjectStore('failed_sync_logs', { keyPath: 'id', autoIncrement: true });
        // v6: audit_log — immutable append-only event log
        //     Shape: { id (string: ts_random), action, detail, staff, device, ts, extra }
        //     Indexed by 'ts' for chronological reads and 'action' for category filter.
        if (!d.objectStoreNames.contains('audit_log')) {
            const auditSt = d.createObjectStore('audit_log', { keyPath: 'id' });
            auditSt.createIndex('by_ts',     'ts',     { unique: false });
            auditSt.createIndex('by_action', 'action', { unique: false });
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
        if (typeof showToast === 'function') {
            showToast('⚠️ Local database unavailable. Data will use localStorage fallback only.', true);
        }
    };

    function _whenReady(fn) {
        if (_ready) { try { fn(_idb); } catch(ex) {} }
        else _pending.push(fn);
    }

    // ── KV helpers ───────────────────────────────────────────────────────────
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

    // ── Invoice persistence ──────────────────────────────────────────────────
    let _invoiceSaveLock = false;
    let _invoiceSavePending = null;

    /**
     * Save the full invoices ledger.
     * @param {Array}    ledger    - Complete array of invoice objects.
     * @param {Function} [onSuccess] - Optional callback fired on IDB tx.oncomplete,
     *                                 receives the committed ledger as argument.
     *                                 Enables the SSOT Write-Through Log pattern:
     *                                 callers update in-memory state ONLY after IDB confirms.
     */
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
                    // SSOT Write-Through: notify caller that IDB has committed
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

    // ── Cloud KV sync queue (legacy — cloud key/value pairs) ─────────────────
    const _syncQueue = [];
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
                        if (idx >= 0) { if ((entry.createdAt || 0) > (_syncQueue[idx].createdAt || 0)) _syncQueue[idx] = entry; }
                        else          { _syncQueue.push(entry); }
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
                else               { const e = _makeSyncEntry(key, value); _syncQueue.push(e); _persistQueueEntry(e); }
            });
        } else {
            const existing = _syncQueue.findIndex(i => i.key === key);
            if (existing >= 0) { _syncQueue[existing].value = value; _persistQueueEntry(_syncQueue[existing]); }
            else               { const e = _makeSyncEntry(key, value); _syncQueue.push(e); _persistQueueEntry(e); }
        }
    }

    async function _drainSyncQueue() {
        if (_syncDraining) return;
        if (_syncQueue.length === 0) return;
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
                    item.nextRetryAt = Date.now() + Math.min(Math.pow(2, item.retryCount) * 5000, 512000);
                    if (item.retryCount >= 10) {
                        console.warn('[SyncQueue] Dead-lettering entry after 10 retries:', item.key);
                        const idx = _syncQueue.indexOf(item);
                        if (idx >= 0) _syncQueue.splice(idx, 1);
                        _removeQueueEntry(item.id);
                    } else {
                        _persistQueueEntry(item);
                    }
                }
            }
        } finally {
            _syncDraining = false;
        }
    }

    function _syncQueueDepth()   { return _syncQueue.length; }
    function _syncQueueMetrics() {
        const now = Date.now();
        return {
            total:   _syncQueue.length,
            ready:   _syncQueue.filter(i => (i.nextRetryAt||0) <= now).length,
            backing: _syncQueue.filter(i => (i.nextRetryAt||0) >  now).length,
            loaded:  _queueLoaded
        };
    }

    // ── Structured offline sync queue (append-only event log records) ─────────
    // Record shape: { queueId (auto int), type, payload, capturedVersion, createdAt }
    // Supported types: "INVOICE" | "INVOICE_UPDATE" | "INVENTORY_MOVEMENT"

    /**
     * Enqueue a new event record into the offline_sync_queue store.
     * @param {"INVOICE"|"INVENTORY_MOVE"|"HEARTBEAT"} type
     * @param {Object} payload  - Arbitrary event payload.
     * @param {number} capturedVersion - The local version integer at capture time.
     * @returns {Promise<number>} Resolves to the assigned queueId.
     */
    function pushToSyncQueue(type, payload, capturedVersion) {
        return new Promise((resolve, reject) => {
            _whenReady(idb => {
                if (!idb) { reject(new Error('IDB unavailable')); return; }
                try {
                    const clockOffset = (() => {
                        try { const v = parseInt(localStorage.getItem('server_clock_offset_ms'), 10); return isNaN(v) ? 0 : v; } catch(_) { return 0; }
                    })();
                    const record = {
                        type:            type,
                        payload:         payload,
                        capturedVersion: (typeof capturedVersion === 'number' && !isNaN(capturedVersion)) ? capturedVersion : 1,
                        createdAt:       new Date(Date.now() + clockOffset).toISOString(),
                        retryCount:      0
                    };
                    const tx  = idb.transaction(['offline_sync_queue'], 'readwrite');
                    const req = tx.objectStore('offline_sync_queue').add(record);
                    req.onsuccess = e => resolve(e.target.result);
                    req.onerror   = e => reject(e.target.error);
                } catch(e) { reject(e); }
            });
        });
    }

    /**
     * Return all queued event records in insertion order (queueId ascending).
     * Returns structuredClone snapshots — callers must not mutate the returned objects
     * to update queue state; use deleteFromSyncQueue / pushToSyncQueue instead.
     * @returns {Promise<Array>}
     */
    function getSyncQueueOrdered() {
        return new Promise((resolve, reject) => {
            _whenReady(idb => {
                if (!idb) { resolve([]); return; }
                try {
                    const tx  = idb.transaction(['offline_sync_queue'], 'readonly');
                    const req = tx.objectStore('offline_sync_queue').getAll();
                    req.onsuccess = e => {
                        const rows = (e.target.result || []).slice().sort((a, b) => a.queueId - b.queueId);
                        resolve(structuredClone(rows));
                    };
                    req.onerror = e => reject(e.target.error);
                } catch(e) { reject(e); }
            });
        });
    }

    /**
     * Delete a single event record from the queue by its queueId.
     * @param {number} queueId
     * @returns {Promise<void>}
     */
    function deleteFromSyncQueue(queueId) {
        return new Promise((resolve, reject) => {
            _whenReady(idb => {
                if (!idb) { resolve(); return; }
                try {
                    const tx  = idb.transaction(['offline_sync_queue'], 'readwrite');
                    const req = tx.objectStore('offline_sync_queue').delete(queueId);
                    req.onsuccess = () => resolve();
                    req.onerror   = e => reject(e.target.error);
                } catch(e) { reject(e); }
            });
        });
    }

    /**
     * Write a poison-pill record to the failed_sync_logs dead-letter store.
     * Called when a queue item exhausts its MAX_RETRIES or receives a hard-reject
     * error code (400, 422, 23503, 23514) from the server.
     *
     * @param {Object} record - { queueId, type, payload, errorContext, retryCount }
     * @returns {Promise<number>} Resolves to the assigned id.
     */
    function writeToFailedSyncLogs(record) {
        return new Promise((resolve, reject) => {
            _whenReady(idb => {
                if (!idb) { reject(new Error('IDB unavailable')); return; }
                try {
                    const clockOffset = (() => {
                        try { const v = parseInt(localStorage.getItem('server_clock_offset_ms'), 10); return isNaN(v) ? 0 : v; } catch(_) { return 0; }
                    })();
                    const entry = {
                        queueId:      record.queueId      || null,
                        type:         record.type         || 'UNKNOWN',
                        payload:      record.payload       || null,
                        errorContext: record.errorContext  || null,
                        failedAt:     new Date(Date.now() + clockOffset).toISOString(),
                        retryCount:   record.retryCount    || 0
                    };
                    const tx  = idb.transaction(['failed_sync_logs'], 'readwrite');
                    const req = tx.objectStore('failed_sync_logs').add(entry);
                    req.onsuccess = e => resolve(e.target.result);
                    req.onerror   = e => reject(e.target.error);
                } catch(e) { reject(e); }
            });
        });
    }

    /**
     * Update the retryCount on an existing offline_sync_queue record.
     * Used by the sync engine to persist retry state without removing the item.
     * @param {number} queueId
     * @param {number} newRetryCount
     * @returns {Promise<void>}
     */
    function updateSyncQueueRetryCount(queueId, newRetryCount) {
        return new Promise((resolve) => {
            _whenReady(idb => {
                if (!idb) { resolve(); return; }
                try {
                    const tx  = idb.transaction(['offline_sync_queue'], 'readwrite');
                    const st  = tx.objectStore('offline_sync_queue');
                    const req = st.get(queueId);
                    req.onsuccess = e => {
                        const rec = e.target.result;
                        if (rec) {
                            rec.retryCount = newRetryCount;
                            st.put(rec);
                        }
                        resolve();
                    };
                    req.onerror = () => resolve();
                } catch(e) { resolve(); }
            });
        });
    }

    /**
     * Merge arbitrary fields into an existing offline_sync_queue record.
     * Used by the sync engine to persist per-item state (e.g. processedItems)
     * so partial-failure recovery survives page reloads and sync-engine restarts.
     * @param {number} queueId
     * @param {Object} updates  Plain object — keys are merged into the IDB record.
     * @returns {Promise<void>}
     */
    function updateSyncQueueRecord(queueId, updates) {
        return new Promise((resolve) => {
            _whenReady(idb => {
                if (!idb) { resolve(); return; }
                try {
                    const tx  = idb.transaction(['offline_sync_queue'], 'readwrite');
                    const st  = tx.objectStore('offline_sync_queue');
                    const req = st.get(queueId);
                    req.onsuccess = e => {
                        const rec = e.target.result;
                        if (rec) {
                            Object.assign(rec, updates);
                            st.put(rec);
                        }
                        resolve();
                    };
                    req.onerror = () => resolve();
                } catch(e) { resolve(); }
            });
        });
    }

    // ── Invoice load ──────────────────────────────────────────────────────────
    function loadInvoices() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { const s = localStorage.getItem('pharma_saved_ledger'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                    return;
                }
                try {
                    idb.transaction(['invoices'], 'readonly').objectStore('invoices').getAll().onsuccess = e => {
                        const rows = e.target.result || [];
                        if (rows.length > 0) { resolve(structuredClone(rows)); return; }
                        try { const s = localStorage.getItem('pharma_saved_ledger'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                        catch(ex) { resolve([]); }
                    };
                } catch(e) {
                    try { const s = localStorage.getItem('pharma_saved_ledger'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                }
            });
        });
    }

    // ── Held bills ────────────────────────────────────────────────────────────
    function saveHeldBills(bills) {
        // FIX (split-brain): localStorage must only be written AFTER IDB confirms.
        // Previously localStorage was updated synchronously before the IDB transaction
        // completed.  If the page closed between those two writes IDB held stale data;
        // loadHeldBills reads IDB first, so the user would silently lose the latest held
        // bill on the next boot.  Now localStorage is written inside tx.oncomplete so
        // both stores are always consistent.  The tx.onerror / catch branches still
        // write localStorage as a last-resort fallback so data is never lost on IDB failure.
        _whenReady(idb => {
            if (!idb) {
                try { localStorage.setItem('pharma_held_bills', JSON.stringify(bills)); } catch(e) {}
                return;
            }
            try {
                const tx = idb.transaction(['heldBills'], 'readwrite');
                const st = tx.objectStore('heldBills');
                st.clear().onsuccess = () => bills.forEach(b => { const copy = Object.assign({}, b); delete copy._hbIdx; st.put(copy); });
                tx.oncomplete = () => {
                    try { localStorage.setItem('pharma_held_bills', JSON.stringify(bills)); } catch(e) {}
                };
                tx.onerror = () => {
                    try { localStorage.setItem('pharma_held_bills', JSON.stringify(bills)); } catch(e) {}
                };
            } catch(e) {
                try { localStorage.setItem('pharma_held_bills', JSON.stringify(bills)); } catch(_e) {}
            }
        });
        if (isSyncEnabled) { _supaSet(getSupaKey('heldBills'), JSON.stringify(bills)).catch(() => {}); }
    }

    function loadHeldBills() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { const s = localStorage.getItem('pharma_held_bills'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                    return;
                }
                try {
                    idb.transaction(['heldBills'], 'readonly').objectStore('heldBills').getAll().onsuccess = e => {
                        const rows = e.target.result || [];
                        if (rows.length > 0) { resolve(structuredClone(rows.map(b => { const c = Object.assign({}, b); delete c._hbIdx; return c; }))); return; }
                        try { const s = localStorage.getItem('pharma_held_bills'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                        catch(ex) { resolve([]); }
                    };
                } catch(e) {
                    try { const s = localStorage.getItem('pharma_held_bills'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                }
            });
        });
    }

    // ── Cart ──────────────────────────────────────────────────────────────────
    function saveCart(items) {
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['cart'], 'readwrite').objectStore('cart').put(items, 'active'); } catch(e) {}
        });
        try { localStorage.setItem('pharma_active_cart', JSON.stringify(items)); } catch(e) {}
    }

    function loadCart() {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb) {
                    try { const s = localStorage.getItem('pharma_active_cart'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                    return;
                }
                try {
                    idb.transaction(['cart'], 'readonly').objectStore('cart').get('active').onsuccess = e => {
                        const r = e.target.result;
                        if (r && Array.isArray(r) && r.length > 0) { resolve(structuredClone(r)); return; }
                        try { const s = localStorage.getItem('pharma_active_cart'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                        catch(ex) { resolve([]); }
                    };
                } catch(e) {
                    try { const s = localStorage.getItem('pharma_active_cart'); resolve(s ? structuredClone(JSON.parse(s)) : []); }
                    catch(ex) { resolve([]); }
                }
            });
        });
    }

    function clearCart() {
        _whenReady(idb => {
            if (!idb) return;
            try { idb.transaction(['cart'], 'readwrite').objectStore('cart').delete('active'); } catch(e) {}
        });
        try { localStorage.removeItem('pharma_active_cart'); } catch(e) {}
    }

    function clearAllPrimaryStores() {
        // Clear PharmaDataDB primary stores
        _whenReady(idb => {
            if (!idb) return;
            ['invoices', 'heldBills', 'cart'].forEach(store => {
                try { idb.transaction([store], 'readwrite').objectStore(store).clear(); } catch(e) {}
            });
        });
        // FIX: Also clear the separate PharmaInventoryDB opened by inventory.js.
        // Without this, Global Purge / Data Wipe leaves all product stock intact.
        try {
            const invReq = indexedDB.open('PharmaInventoryDB');
            invReq.onsuccess = function(ev) {
                const invDb = ev.target.result;
                ['inventory', 'inventory_movements'].forEach(store => {
                    try {
                        if (invDb.objectStoreNames.contains(store)) {
                            invDb.transaction([store], 'readwrite').objectStore(store).clear();
                        }
                    } catch(e) {}
                });
            };
        } catch(e) {}
        ['pharma_saved_ledger', 'pharma_held_bills', 'pharma_active_cart',
         '_pharma_inv_fingerprint', 'pharma_applied_mov_ids'].forEach(k => {
            try { localStorage.removeItem(k); } catch(e) {}
        });
    }

    /**
     * Clear all pending sync queues and dead-letter logs from PharmaDataDB.
     * Call this during any purge to prevent stale queued writes from
     * repopulating the cloud after the purge completes.
     * Clears: sync_queue, offline_sync_queue, failed_sync_logs.
     * Also drains the in-memory _syncQueue array so _drainSyncQueue is a no-op.
     */
    function clearAllQueues() {
        // Clear in-memory queue first so _drainSyncQueue won't fire pending writes
        _syncQueue.length = 0;
        _whenReady(idb => {
            if (!idb) return;
            ['sync_queue', 'offline_sync_queue', 'failed_sync_logs'].forEach(store => {
                try {
                    if (idb.objectStoreNames.contains(store)) {
                        idb.transaction([store], 'readwrite').objectStore(store).clear();
                    }
                } catch(e) {}
            });
        });
    }

    // ── Audit Log (v6 store) ──────────────────────────────────────────────────
    /**
     * Append one entry to the 'audit_log' IDB store.
     * Non-blocking — errors are silently swallowed so audit writes
     * never interrupt normal billing flow.
     * @param {Object} entry — { id, action, detail, staff, device, ts, extra }
     */
    function writeAuditLog(entry) {
        if (!entry || !entry.id) return;
        _whenReady(idb => {
            if (!idb || !idb.objectStoreNames.contains('audit_log')) return;
            try {
                idb.transaction(['audit_log'], 'readwrite')
                   .objectStore('audit_log')
                   .put(entry);
            } catch(e) {}
        });
    }

    /**
     * Read up to `limit` audit entries, newest-first.
     * Returns a Promise that resolves to an array (may be empty on IDB error).
     * @param {number} [limit=5000]
     * @returns {Promise<Array>}
     */
    function getAuditLogs(limit = 5000) {
        return new Promise(resolve => {
            _whenReady(idb => {
                if (!idb || !idb.objectStoreNames.contains('audit_log')) {
                    resolve([]); return;
                }
                try {
                    const tx  = idb.transaction(['audit_log'], 'readonly');
                    const req = tx.objectStore('audit_log')
                                  .index('by_ts')
                                  .getAll(null, limit);
                    req.onsuccess = () => {
                        const rows = req.result || [];
                        resolve(rows.sort((a, b) => b.ts.localeCompare(a.ts)));
                    };
                    req.onerror = () => resolve([]);
                } catch(e) { resolve([]); }
            });
        });
    }

    /**
     * Purge audit entries older than `days` days from the local IDB store.
     * Called during Data Wipe / Global Purge to avoid stale audit data.
     * @param {number} [days=90]
     */
    function pruneAuditLog(days = 90) {
        _whenReady(idb => {
            if (!idb || !idb.objectStoreNames.contains('audit_log')) return;
            const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
            try {
                const tx    = idb.transaction(['audit_log'], 'readwrite');
                const store = tx.objectStore('audit_log');
                const range = IDBKeyRange.upperBound(cutoff);
                store.index('by_ts').openCursor(range).onsuccess = function(ev) {
                    const cursor = ev.target.result;
                    if (cursor) { cursor.delete(); cursor.continue(); }
                };
            } catch(e) {}
        });
    }

    function estimateUsage() {
        if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
        return Promise.resolve({ usage: 0, quota: 500 * 1024 * 1024 });
    }

    // ── Settings sync helpers ─────────────────────────────────────────────────
    const SYNC_SETTINGS_KEYS = [
        'pharma_branch_identity', 'pharma_currency',
        'pharma_max_disc', 'pharma_discount_presets', 'pharma_thermal_settings',
        'pharma_paper_mode', 'pharma_receipt_info', 'pharma_allow_overstock',
        'pharma_staff_list', 'pharma_require_staff_pin',
        // FIX: Additional settings that were missing from sync — all must round-trip
        'pharma_bill_save_pin', 'pharma_clock_offset', 'pharma_low_stock_threshold',
        'pharma_show_zero_stock', 'pharma_default_payment', 'pharma_auto_round_off',
        'pharma_partial_refund_reason', 'pharma_receipt_footer',
        'pharma_require_customer_name', 'pharma_require_customer_phone'
    ];

    function _mergeInvoices(localArr, cloudArr) {
        if (!Array.isArray(cloudArr) || cloudArr.length === 0) return { merged: localArr, hadNew: false };
        if (!Array.isArray(localArr) || localArr.length === 0) return { merged: cloudArr, hadNew: cloudArr.length > 0 };
        const localMap = new Map(localArr.map(inv => [inv.id, inv]));
        let hadNew = false;
        cloudArr.forEach(cloudInv => {
            if (!localMap.has(cloudInv.id)) {
                localMap.set(cloudInv.id, cloudInv);
                hadNew = true;
            } else {
                const local = localMap.get(cloudInv.id);
                const localEdited = !!(local.editedAt || local.refunded || local.isRefund || local.isPartialRefund);
                const cloudNewer  = cloudInv.editedAt && (!local.editedAt || cloudInv.editedAt > local.editedAt);
                if (!localEdited && cloudNewer) { localMap.set(cloudInv.id, cloudInv); hadNew = true; }
            }
        });
        const merged = [...localMap.values()].sort((a, b) => {
            const da = a.date || '', db = b.date || '';
            return da < db ? -1 : da > db ? 1 : (a.id < b.id ? -1 : 1);
        });
        return { merged, hadNew };
    }

    function _mergeInventory(localArr, cloudArr) {
        if (!Array.isArray(cloudArr) || cloudArr.length === 0) return { merged: localArr, hadNew: false };
        if (!Array.isArray(localArr) || localArr.length === 0) return { merged: cloudArr, hadNew: cloudArr.length > 0 };
        const localMap = new Map(localArr.map(p => [p.code, p]));
        let hadNew = false;
        cloudArr.forEach(cloudProd => {
            if (!localMap.has(cloudProd.code)) {
                localMap.set(cloudProd.code, cloudProd);
                hadNew = true;
            } else {
                const local = localMap.get(cloudProd.code);
                const updated = Object.assign({}, cloudProd, { stock: local.stock });
                const catalogueChanged =
                    local.name        !== cloudProd.name        ||
                    local.unitPrice   !== cloudProd.unitPrice   ||
                    local.company     !== cloudProd.company     ||
                    local.generic     !== cloudProd.generic     ||
                    local.packDetails !== cloudProd.packDetails;
                if (catalogueChanged) { localMap.set(cloudProd.code, updated); hadNew = true; }
            }
        });
        return { merged: [...localMap.values()], hadNew };
    }

    async function syncFromCloudEngine() {
        const [invRaw, hbRaw, invDbRaw, settRaw] = await Promise.all([
            _supaGet(SUPA_KEYS.invoices),
            _supaGet(getSupaKey('heldBills')),
            _supaGet(SUPA_KEYS.inventory),
            _supaGet(SUPA_KEYS.settings)
        ]);
        let changed = false;

        if (invRaw) {
            try {
                const cloudInvs = JSON.parse(invRaw);
                if (Array.isArray(cloudInvs) && cloudInvs.length > 0) {
                    const localInvs = (typeof savedInvoicesLedger !== 'undefined') ? savedInvoicesLedger : [];
                    const { merged, hadNew } = _mergeInvoices(localInvs, cloudInvs);
                    if (hadNew) {
                        saveInvoices(merged);
                        if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = merged;
                        changed = true;
                    }
                }
            } catch(e) {}
        }

        if (hbRaw)   { try { const r = JSON.parse(hbRaw);   if (Array.isArray(r) && r.length > 0 && typeof temporaryHeldBills !== 'undefined') { const localKeys = new Set(temporaryHeldBills.map(b => b.tag + '|' + b.timestamp)); const netNew = r.filter(b => !localKeys.has(b.tag + '|' + b.timestamp)); if (netNew.length > 0) { const merged = temporaryHeldBills.concat(netNew); saveHeldBills(merged); temporaryHeldBills = merged; changed = true; } } } catch(e) {} }
        if (invDbRaw && localStorage.getItem('_pharma_inv_dirty') !== 'true') { try { const r = JSON.parse(invDbRaw); if (Array.isArray(r) && r.length > 0 && typeof masterInventoryDB !== 'undefined') { const { merged, hadNew } = _mergeInventory(masterInventoryDB, r); if (hadNew) { masterInventoryDB = merged; if (typeof saveInventoryToDB === 'function') saveInventoryToDB(merged); changed = true; } } } catch(e) {} }
        if (settRaw)  { try { const r = JSON.parse(settRaw);  if (r && typeof r === 'object') { const remoteTs = r._ts || 0; const localTs = parseInt(get('_supabase_settings_ts') || '0', 10); if (remoteTs > localTs || (remoteTs > 0 && localTs === 0)) { SYNC_SETTINGS_KEYS.forEach(k => { if (r[k] === undefined) return; if (k === 'pharma_branch_identity') { try { const localBi = JSON.parse(get(k) || '{}'); const cloudBi = typeof r[k] === 'string' ? JSON.parse(r[k]) : r[k]; set(k, JSON.stringify(Object.assign({}, cloudBi, { counterId: localBi.counterId }))); } catch(_e2) {} } else { set(k, r[k]); } }); set('_supabase_settings_ts', String(Math.max(remoteTs, Date.now()))); changed = true; } } } catch(e) {} }

        try {
            if (typeof _pullRemoteMovements === 'function') {
                const movChanged = await _pullRemoteMovements();
                if (movChanged) changed = true;
            }
        } catch(e) {}
        try { if (typeof _pushUnsyncedMovements === 'function') await _pushUnsyncedMovements(); } catch(e) {}
        _drainSyncQueue().catch(() => {});
        return changed;
    }

    let _syncLightweightInFlight = false;
    async function syncLightweightFromCloud() {
        if (_syncLightweightInFlight) return false;
        _syncLightweightInFlight = true;
        try {
        const [invRaw, hbRaw, settRaw, invDbRaw] = await Promise.all([
            _supaGet(SUPA_KEYS.invoices),
            _supaGet(getSupaKey('heldBills')),
            _supaGet(SUPA_KEYS.settings),
            _supaGet(SUPA_KEYS.inventory)
        ]);
        let changed = false;

        if (invRaw) {
            try {
                const cloudInvs = JSON.parse(invRaw);
                if (Array.isArray(cloudInvs) && cloudInvs.length > 0) {
                    const localInvs = (typeof savedInvoicesLedger !== 'undefined') ? savedInvoicesLedger : [];
                    const { merged, hadNew } = _mergeInvoices(localInvs, cloudInvs);
                    if (hadNew) {
                        saveInvoices(merged);
                        if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = merged;
                        changed = true;
                    }
                }
            } catch(e) {}
        }

        if (hbRaw)   { try { const r = JSON.parse(hbRaw);   if (Array.isArray(r) && r.length > 0 && typeof temporaryHeldBills !== 'undefined') { const localKeys = new Set(temporaryHeldBills.map(b => b.tag + '|' + b.timestamp)); const netNew = r.filter(b => !localKeys.has(b.tag + '|' + b.timestamp)); if (netNew.length > 0) { const merged = temporaryHeldBills.concat(netNew); saveHeldBills(merged); temporaryHeldBills = merged; changed = true; } } } catch(e) {} }
        if (settRaw) { try { const r = JSON.parse(settRaw); if (r && typeof r === 'object') { const remoteTs = r._ts || 0; const localTs = parseInt(get('_supabase_settings_ts') || '0', 10); if (remoteTs > localTs || (remoteTs > 0 && localTs === 0)) { SYNC_SETTINGS_KEYS.forEach(k => { if (r[k] === undefined) return; if (k === 'pharma_branch_identity') { try { const localBi = JSON.parse(get(k) || '{}'); const cloudBi = typeof r[k] === 'string' ? JSON.parse(r[k]) : r[k]; set(k, JSON.stringify(Object.assign({}, cloudBi, { counterId: localBi.counterId }))); } catch(_e2) {} } else { set(k, r[k]); } }); set('_supabase_settings_ts', String(Math.max(remoteTs, Date.now()))); changed = true; } } } catch(e) {} }

                if (invDbRaw) {
            try {
                // DIRTY-FLAG GUARD: if local inventory has unpushed changes (e.g. a fresh
                // CSV import not yet pushed to cloud), never let a cloud read overwrite or
                // clear local data.  The user must push first or use Force Sync.
                const _invDirty = localStorage.getItem('_pharma_inv_dirty') === 'true';
                if (!_invDirty) {
                    const cloudInv = JSON.parse(invDbRaw);

                    // SAFETY: An empty cloud array means the cloud key was never populated
                    // (brand-new device, push hasn't happened yet). Do NOT treat this as an
                    // authoritative "wipe local" signal — that would silently destroy a
                    // freshly imported inventory. Only merge/overwrite when cloud has data.
                    if (Array.isArray(cloudInv) && cloudInv.length > 0 && typeof masterInventoryDB !== 'undefined') {
                        const remoteFingerprint = cloudInv.length + '|' + (cloudInv[0] ? cloudInv[0].code : '') + '|' + (cloudInv[cloudInv.length - 1] ? cloudInv[cloudInv.length - 1].code : '');
                        const localFingerprint  = get('_pharma_inv_fingerprint') || '';
                        if (remoteFingerprint !== localFingerprint) {
                            const { merged, hadNew } = _mergeInventory(masterInventoryDB, cloudInv);
                            const localCodes  = new Set(masterInventoryDB.map(p => p.code));
                            const cloudHasAll = cloudInv.every(p => localCodes.has(p.code));
                            if (!cloudHasAll || hadNew || cloudInv.length !== masterInventoryDB.length) {
                                masterInventoryDB = merged;
                                if (typeof saveInventoryToDB === 'function') saveInventoryToDB(merged);
                                set('_pharma_inv_fingerprint', remoteFingerprint);
                                changed = true;
                            }
                        }
                    }
                }
            } catch(e) {}
        }

        _drainSyncQueue().catch(() => {});
        return changed;
        } finally { _syncLightweightInFlight = false; }
    }

    async function purgeCloudStorageOnly() {
        updateSupabaseSyncUI('syncing');
        try {
            await Promise.all(
                Object.values(SUPA_KEYS)
                    .filter(k => k !== null)
                    .map(k => _supaDel(k))
            );
            updateSupabaseSyncUI('connected');
            if (typeof showToast === 'function') showToast('☁️ Cloud data purged. Local data is intact.');
        } catch(e) {
            updateSupabaseSyncUI('offline');
            if (typeof showToast === 'function') showToast('❌ Cloud purge failed: ' + (e.message || e), true);
        }
    }

    async function pushLocalToCloudEngine() {
        if (!isSyncEnabled) {
            try {
                await _supaProbe();
                isSyncEnabled = true;
                set('_supabase_sync_on', 'true');
            } catch(e) {
                if (typeof showToast === 'function') showToast('❌ Cloud unreachable. Check internet connection.', true);
                return;
            }
        }
        updateSupabaseSyncUI('syncing');
        try {
            const settPayload = {};
            SYNC_SETTINGS_KEYS.forEach(k => {
                const v = get(k); if (v === null) return;
                if (k === 'pharma_branch_identity') {
                    try {
                        const bi = typeof v === 'string' ? JSON.parse(v) : v;
                        const { counterId: _dropped, ...sharedBi } = bi;
                        settPayload[k] = JSON.stringify(sharedBi);
                    } catch(_e2) { settPayload[k] = v; }
                } else { settPayload[k] = v; }
            });
            settPayload._ts = Date.now();
            await Promise.all([
                (typeof savedInvoicesLedger !== 'undefined') ? _supaSet(SUPA_KEYS.invoices,  JSON.stringify(savedInvoicesLedger)) : Promise.resolve(),
                (typeof masterInventoryDB   !== 'undefined') ? _supaSet(SUPA_KEYS.inventory, JSON.stringify(masterInventoryDB))   : Promise.resolve(),
                (typeof temporaryHeldBills  !== 'undefined') ? _supaSet(getSupaKey('heldBills'), JSON.stringify(temporaryHeldBills))  : Promise.resolve(),
                Promise.resolve(),
                _supaSet(SUPA_KEYS.settings, JSON.stringify(settPayload)),
                (typeof _pushUnsyncedMovements === 'function') ? _pushUnsyncedMovements().catch(() => {}) : Promise.resolve()
            ]);
            if (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB) && masterInventoryDB.length > 0) {
                const fp = masterInventoryDB.length + '|' + (masterInventoryDB[0] ? masterInventoryDB[0].code : '') + '|' + (masterInventoryDB[masterInventoryDB.length - 1] ? masterInventoryDB[masterInventoryDB.length - 1].code : '');
                set('_pharma_inv_fingerprint', fp);
            }
            updateSupabaseSyncUI('connected');
            if (typeof showToast === 'function') showToast('☁️ Local data pushed to cloud successfully.');
        } catch(e) {
            updateSupabaseSyncUI('offline');
            if (typeof showToast === 'function') showToast('❌ Cloud push failed: ' + (e.message || e), true);
        }
    }

    function setSyncEnabled(val) { isSyncEnabled = !!val; }

    // ── Phase 7: Remote invoice persistence ──────────────────────────────────
    /**
     * Upsert a remote invoice (pulled from Supabase) into the local 'invoices'
     * IDB store so it is available for offline ledger reads in history.js.
     *
     * The incoming object uses Supabase snake_case column names.  We map to the
     * camelCase shape that history.js / savedInvoicesLedger expects, then put()
     * into IDB keyed on invoiceNumber (the store's keyPath).
     *
     * Idempotent — repeated calls for the same invoice_number are safe because
     * IDB objectStore.put() replaces any existing record with the same key.
     *
     * @param {Object} inv  Raw Supabase invoices row (snake_case).
     * @returns {Promise<void>}
     */
    function putRemoteInvoice(inv) {
        return new Promise((resolve, reject) => {
            if (!inv || !inv.invoice_number) { resolve(); return; }
            _whenReady(idb => {
                if (!idb) { reject(new Error('IDB unavailable')); return; }
                try {
                    // Map Supabase snake_case → local camelCase ledger shape.
                    // Fields not present on the remote row default to safe values
                    // so history.js never sees undefined on expected keys.
                    const record = {
                        // Primary key — must match the 'invoices' store keyPath
                        invoiceNumber:      inv.invoice_number,
                        id:                 inv.invoice_number,

                        // Device / counter identity
                        deviceUuid:         inv.device_uuid        || '',
                        deviceCode:         inv.counter_id         || '',

                        // Customer / staff
                        customerName:       inv.customer_name      || '',
                        customerPhone:      inv.customer_phone      || '',
                        staffName:          inv.staff_name          || '',

                        // Financials
                        subtotal:           Number(inv.subtotal)          || 0,
                        discountPct:        Number(inv.discount_pct)      || 0,
                        discountAmount:     Number(inv.discount_amount)   || 0,
                        roundOffAmt:        Number(inv.round_off_amt)     || 0,
                        netTotal:           Number(inv.net_total)         || 0,
                        paymentMethod:      inv.payment_method     || '',
                        cashReceived:       Number(inv.cash_received)     || 0,
                        changeAmount:       Number(inv.change_amount)     || 0,

                        // Refund flags
                        isRefund:           !!inv.is_refund,
                        isPartialRefund:    !!inv.is_partial_refund,
                        isManual:           !!inv.is_manual,
                        isFullyRefunded:    !!inv.is_fully_refunded,
                        originalInvoiceId:  inv.original_invoice_id || null,
                        refundReason:       inv.refund_reason        || '',

                        // Timestamps — keep both forms for compatibility
                        billedAt:           inv.billed_at   || inv.created_at || new Date().toISOString(),
                        timestamp:          inv.billed_at   || inv.created_at || new Date().toISOString(),
                        date:               (inv.billed_at  || inv.created_at || '').slice(0, 10),
                        createdAt:          inv.created_at  || '',

                        // Line items — populated when synchub pulls with '*,invoice_items(*)'
                        // Falls back to inv.details if already mapped upstream, then []
                        details: Array.isArray(inv.invoice_items)
                            ? inv.invoice_items.map(li => ({
                                code:        li.product_code  || '',
                                name:        li.product_name  || '',
                                packDetails: li.pack_size     || '',
                                unitPrice:   Number(li.unit_price) || 0,
                                qty:         Number(li.qty)        || 0,
                                total:       Number(li.total)      || 0
                            }))
                            : (inv.details || []),

                        // Source marker so history.js can distinguish remote rows
                        _fromRemote:        true
                    };

                    const tx  = idb.transaction(['invoices'], 'readwrite');
                    tx.objectStore('invoices').put(record);
                    tx.oncomplete = () => resolve();
                    tx.onerror    = () => reject(tx.error);
                } catch (e) { reject(e); }
            });
        });
    }

    return {
        set, get, remove,
        saveInvoices, loadInvoices,
        saveHeldBills, loadHeldBills,
        saveCart, loadCart, clearCart,
        clearAllPrimaryStores, clearAllQueues, estimateUsage,
        syncFromCloudEngine, syncLightweightFromCloud,
        purgeCloudStorageOnly, pushLocalToCloudEngine,
        setSyncEnabled,
        _syncQueueDepth,
        drainSyncQueue: _drainSyncQueue,
        syncQueueMetrics: _syncQueueMetrics,
        // ── Structured offline event queue ──────────────────────────────────
        pushToSyncQueue,
        getSyncQueueOrdered,
        deleteFromSyncQueue,
        updateSyncQueueRetryCount,
        updateSyncQueueRecord,
        // ── Dead-letter queue ────────────────────────────────────────────────
        writeToFailedSyncLogs,
        // ── Phase 7: remote invoice persistence ─────────────────────────────
        putRemoteInvoice,
        // ── Audit Log (v6) ──────────────────────────────────────────────────
        writeAuditLog,
        getAuditLogs,
        pruneAuditLog
    };
})();

// =========================================================================
// SUPABASE SYNC UI HELPER
// =========================================================================
function updateSupabaseSyncUI(state) {
    const el  = document.getElementById('supabase-sync-badge');
    const lbl = document.getElementById('supabaseSyncLabel');
    if (!el) return;
    el.className = state;
    const qDepth = (typeof StorageModule !== 'undefined' && StorageModule._syncQueueDepth) ? StorageModule._syncQueueDepth() : 0;
    const qLabel = qDepth > 0 ? ' (' + qDepth + ' pending)' : '';
    const labels = {
        connecting: 'Connecting…',
        connected:  'Synced',
        syncing:    'Syncing…',
        offline:    'Offline' + qLabel + ' — tap to retry'
    };
    if (lbl) lbl.textContent = labels[state] || state;
    el.style.cursor = (state === 'offline') ? 'pointer' : 'default';
    el.onclick = (state === 'offline') ? _supabaseReconnect : null;
    el.title = (state === 'offline') ? 'Click to reconnect to cloud' : 'Cloud Sync (Supabase)';
}

async function _supabaseReconnect() {
    updateSupabaseSyncUI('connecting');
    try {
        await _supaProbe();
        StorageModule.setSyncEnabled(true);
        StorageModule.set('_supabase_sync_on', 'true');
        updateSupabaseSyncUI('syncing');
        try {
            await StorageModule.syncFromCloudEngine();
            if (StorageModule.drainSyncQueue) StorageModule.drainSyncQueue().catch(() => {});
            updateSupabaseSyncUI('connected');
            showToast('☁️ Reconnected to cloud.');
        } catch(e) {
            updateSupabaseSyncUI('offline');
            showToast('❌ Reconnect failed. Check internet connection.', true);
        }
    } catch(e) {
        updateSupabaseSyncUI('offline');
        showToast('❌ Cannot reach cloud. Check internet connection.', true);
    }
}

let _onlineDebounceTimer = null;
function _onNetworkOnline() {
    if (_onlineDebounceTimer) clearTimeout(_onlineDebounceTimer);
    _onlineDebounceTimer = setTimeout(() => {
        _onlineDebounceTimer = null;
        if (StorageModule.get('_supabase_sync_on') !== 'false') {
            _supabaseReconnect().catch(() => {});
        }
    }, 1500);
}
function _onNetworkOffline() {
    StorageModule.setSyncEnabled(false);
    updateSupabaseSyncUI('offline');
}
window.addEventListener('online',  _onNetworkOnline);
window.addEventListener('offline', _onNetworkOffline);
