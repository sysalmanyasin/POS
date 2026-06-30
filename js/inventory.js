// =========================================================================
// INDEXEDDB — INVENTORY
// Schema v4:
//   - 'inventory' store: all records now carry an explicit 'version' integer
//     (defaulting to 1). Written on every upsert in _doIDBInventoryWrite and
//     _atomicStockWriteBack. Read by billing.js during checkout capture to
//     stamp capturedVersion into the offline_sync_queue INVOICE record.
//   - 'inventory_movements' store: unchanged (indexes by_code, by_type,
//     by_synced retained from v3).
// =========================================================================
let db;
// FIX (Global Binding): masterInventoryDB is the SSOT for all inventory reads.
// Explicitly bind to window so cross-file modules (billing.js, syncHub.js) can
// safely read it without triggering a ReferenceError if inventory.js hasn't run
// its first IDB load yet.  All mutations inside this file continue to use the
// bare name (which resolves to window.masterInventoryDB in non-module scripts).
window.masterInventoryDB = window.masterInventoryDB || [];
const dbRequest = indexedDB.open('PharmaInventoryDB', 4);
dbRequest.onupgradeneeded = function(e) {
    db = e.target.result;
    // Create stores if they don't already exist
    if (!db.objectStoreNames.contains('inventory'))
        db.createObjectStore('inventory', { keyPath: 'code' });

    let movSt;
    if (!db.objectStoreNames.contains('inventory_movements')) {
        movSt = db.createObjectStore('inventory_movements', { keyPath: 'movementId' });
    } else {
        movSt = e.target.transaction.objectStore('inventory_movements');
    }
    // Ensure indexes exist (idempotent for upgrades from any prior version)
    if (!movSt.indexNames.contains('by_code'))   movSt.createIndex('by_code',   'productCode',  { unique: false });
    if (!movSt.indexNames.contains('by_type'))   movSt.createIndex('by_type',   'movementType', { unique: false });
    if (!movSt.indexNames.contains('by_synced')) movSt.createIndex('by_synced', 'synced',       { unique: false });
};
dbRequest.onsuccess = function(e) {
    db = e.target.result;
    const pending = _preDbSavePending;
    if (pending) {
        _preDbSavePending = null;
        window.masterInventoryDB = pending;
        _doIDBInventoryWrite(pending, loadInventoryFromDB);
    } else {
        loadInventoryFromDB();
    }
};
dbRequest.onerror   = function()  { showToast('⚠️ Database initialization failed.', true); };

let _invSaveLock       = false;
let _invSavePending    = null;
let _preDbSavePending  = null;
const _INV_CACHE_KEY   = '_pharma_inv_local_cache';

function _mirrorInventoryCache(data) {
    if (!Array.isArray(data) || data.length === 0) return;
    try {
        const payload = JSON.stringify(data);
        if (payload.length > 4_500_000) return;
        localStorage.setItem(_INV_CACHE_KEY, payload);
    } catch(_e) {}
}

function _restoreInventoryCache() {
    try {
        const raw = localStorage.getItem(_INV_CACHE_KEY);
        if (!raw) return null;
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch(_e) { return null; }
}

// =========================================================================
// INVENTORY PERSISTENCE
// Every record written to the 'inventory' store includes a 'version' integer
// property (defaulting to 1 for records that don't already carry one).
// This value is incremented each time a stock-affecting write is committed,
// and is read at checkout time to stamp capturedVersion onto queue records.
// =========================================================================
function saveInventoryToDB(data) {
    if (!Array.isArray(data)) return false;
    window.masterInventoryDB = data;
    if (!db) {
        _preDbSavePending = data;
        _mirrorInventoryCache(data);
        console.warn('[Inventory] DB not ready — queued save of ' + data.length + ' items');
        return false;
    }
    if (_invSaveLock) { _invSavePending = data; return true; }
    _doIDBInventoryWrite(data);
    return true;
}
function _doIDBInventoryWrite(data, onComplete) {
    _invSaveLock = true;
    if (!Array.isArray(data)) { _invSaveLock = false; _flushPendingInventorySave(); return; }
    try {
        const tx    = db.transaction(['inventory'], 'readwrite');
        const store = tx.objectStore('inventory');
        const snapshot = data.filter(item => item && typeof item === 'object' && item.code);
        const validCodes = new Set();
        // Stage version values that will be committed by this transaction.
        // SSOT Write-Through: masterInventoryDB must NOT be updated until
        // tx.oncomplete fires — writing memory before IDB commits creates a
        // dual-write split-brain where a crash leaves the stores diverged.
        const _pendingVersions = new Map(); // code → committed version
        snapshot.forEach(item => {
            const record = Object.assign({}, item);
            if (typeof record.version !== 'number' || record.version < 1) {
                record.version = 1;
            }
            store.put(record);
            validCodes.add(record.code);
            _pendingVersions.set(record.code, record.version);
        });
        store.getAllKeys().onsuccess = function(ev) {
            (ev.target.result || []).forEach(k => { if (!validCodes.has(k)) store.delete(k); });
        };
        tx.oncomplete = function() {
            // Apply staged version updates only after IDB confirms the write.
            // FIX: wrapped in try/finally — if the forEach throws for any reason
            // (e.g. bad data), _invSaveLock must still be released so future
            // saveInventoryToDB calls are not deadlocked indefinitely.
            try {
                _mirrorInventoryCache(snapshot);
                if (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB)) {
                    _pendingVersions.forEach(function(version, code) {
                        const idx = masterInventoryDB.findIndex(p => p.code === code);
                        if (idx >= 0) masterInventoryDB[idx].version = version;
                    });
                }
            } finally {
                _invSaveLock = false; _flushPendingInventorySave();
                if (typeof onComplete === 'function') {
                    try { onComplete(); } catch(_e) {}
                }
            }
        };
        tx.onerror    = function() {
            _invSaveLock = false; _flushPendingInventorySave();
            if (typeof onComplete === 'function') {
                try { onComplete(); } catch(_e) {}
            }
        };
        tx.onabort    = function() {
            _invSaveLock = false; _flushPendingInventorySave();
            if (typeof onComplete === 'function') {
                try { onComplete(); } catch(_e) {}
            }
        };
    } catch(e) { _invSaveLock = false; _flushPendingInventorySave(); }
}
function _flushPendingInventorySave() {
    if (_invSavePending !== null) {
        const pending = _invSavePending;
        _invSavePending = null;
        _doIDBInventoryWrite(pending);
    }
}

// =========================================================================
// INVENTORY MOVEMENT LEDGER — record + cloud push/pull
// =========================================================================
function _recordInvMovement(productCode, quantityChange, movementType, invoiceId, description, stockAfter) {
    if (!db || !productCode || typeof quantityChange !== 'number') return;
    const movement = {
        movementId:     _DEVICE_UUID.slice(0, 8) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6).toUpperCase(),
        productCode,
        quantityChange: Number(quantityChange),
        movementType:   movementType || 'ADJUSTMENT',
        invoiceId:      invoiceId    || null,
        description:    description  || null,
        timestamp:      Date.now(),
        deviceCode:     _getDeviceCode(),
        deviceUUID:     _DEVICE_UUID,
        // SCHEMA FIX: store stock_after (NOT NULL, no default in Supabase)
        stockAfter:     typeof stockAfter === 'number' ? stockAfter : 0,
        synced:         false
    };
    try {
        db.transaction(['inventory_movements'], 'readwrite')
          .objectStore('inventory_movements')
          .put(movement);
    } catch(e) {}
}
// FIX: explicitly bind to window so billing.js can always reach this function
// even if the service worker serves a partially-stale file bundle.
window._recordInvMovement = _recordInvMovement;

let _pushMovementsRunning = false;
async function _pushUnsyncedMovements() {
    if (!db) return;
    // FIX: in-flight guard — if two sync cycles overlap (e.g. 60-second timer
    // fires while a manual forceSyncNow is still running) both would read the
    // same unsynced movements before either marks them synced, causing duplicate
    // Supabase rows.  _dbUpsert is idempotent on movement_id so data is not
    // corrupted, but the double-push wastes bandwidth and PostgREST quota.
    if (_pushMovementsRunning) return;
    _pushMovementsRunning = true;
    // FIX (Sync Gap): push unsynced movements to the relational
    // `inventory_movements` table via _dbUpsert so all devices can pull them —
    // previously this wrote a KV blob per device which other devices never read.
    return new Promise(resolve => {
        try {
            const tx = db.transaction(['inventory_movements'], 'readonly');
            tx.objectStore('inventory_movements').getAll().onsuccess = async e => {
                const all      = e.target.result || [];
                const unsynced = all.filter(m => !m.synced);
                if (unsynced.length === 0) { resolve(); return; }
                try {
                    // Map IDB movement shape → Supabase inventory_movements columns
                    const rows = unsynced.map(m => ({
                        movement_id:    m.movementId,
                        product_code:   m.productCode,
                        // SCHEMA FIX: Supabase columns are INTEGER — round to avoid 22P02 float error
                        quantity_change: Math.round(Number(m.quantityChange) || 0),
                        stock_after:    Math.round(typeof m.stockAfter === 'number' ? m.stockAfter : 0),
                        movement_type:  m.movementType  || 'ADJUSTMENT',
                        invoice_number: m.invoiceId     || null,
                        description:    m.description   || null,
                        device_uuid:    m.deviceUUID    || _DEVICE_UUID,
                        counter_id:     m.deviceCode    || _getDeviceCode(),
                        moved_at:       m.timestamp
                            ? new Date(m.timestamp).toISOString()
                            : new Date().toISOString()
                    }));
                    // Upsert in batches of 200 to stay within PostgREST payload limits
                    const BATCH = 200;
                    let allOk = true;
                    for (let i = 0; i < rows.length; i += BATCH) {
                        const batch = rows.slice(i, i + BATCH);
                        // _dbInsertIgnore is defined in config.js — gracefully skip if unavailable
                        // inventory_movements is append-only; ignore-duplicates handles re-sync safely
                        // without requiring a UNIQUE constraint on movement_id for on_conflict upsert.
                        if (typeof _dbInsertIgnore !== 'function') { allOk = false; break; }
                        const { error } = await _dbInsertIgnore('inventory_movements', batch);
                        if (error) { allOk = false; break; }
                    }
                    if (allOk) {
                        // M2 FIX: removed legacy KV blob write — all devices now read from
                        // the relational inventory_movements table. The KV blob was vestigial
                        // dead code that only wasted Supabase KV storage.
                        // Mark movements as synced in IDB
                        const tx2 = db.transaction(['inventory_movements'], 'readwrite');
                        const st2  = tx2.objectStore('inventory_movements');
                        unsynced.forEach(m => st2.put(Object.assign({}, m, { synced: true })));
                        tx2.oncomplete = () => resolve();
                        tx2.onerror    = () => resolve();
                    } else {
                        resolve();
                    }
                } catch(err) { resolve(); }
            };
            tx.onerror = () => resolve();
        } catch(e) { resolve(); }
    }).finally(() => { _pushMovementsRunning = false; });
}

async function _pullRemoteMovements() {
    if (!db || typeof masterInventoryDB === 'undefined') return false;

    // ── FIX: Query the relational inventory_movements table directly ─────
    // The old approach read per-device KV blobs which fell behind quickly.
    // Every device now writes to the relational table via _pushUnsyncedMovements.
    // We pull movements from OTHER devices (last 48 h) and apply their stock
    // deltas to our local masterInventoryDB, then upsert into local IDB so
    // the full audit trail is available offline.

    const _appliedKey = 'pharma_applied_mov_ids';
    let appliedIds = new Set();
    try {
        const raw = StorageModule.get(_appliedKey);
        if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) appliedIds = new Set(arr); }
    } catch(e) {}

    const newlyAppliedIds = [];
    let applied = false;

    try {
        if (typeof _dbSelect !== 'function') return false;
        // M1 FIX: extended from 48 h to 7 days so devices offline up to a week
        // still receive all missed movements on reconnect.
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: remoteMovs, error } = await _dbSelect(
            'inventory_movements',
            'moved_at=gt.' + encodeURIComponent(cutoff) +
            '&device_uuid=neq.' + encodeURIComponent(_DEVICE_UUID) +
            '&order=moved_at.asc&limit=5000',
            '*'
        );

        if (error || !Array.isArray(remoteMovs) || remoteMovs.length === 0) {
            // Fallback to legacy KV blobs for older clients
            return await _pullRemoteMovementsLegacyKV(appliedIds, newlyAppliedIds);
        }

        const fresh = remoteMovs.filter(m => m.movement_id && !appliedIds.has(m.movement_id));
        if (fresh.length === 0) return false;

        // FIX: collect in-memory mutations as pending — apply them only inside
        // idbTx.oncomplete.  Previously masterInventoryDB was mutated and
        // appliedIds were persisted BEFORE the IDB transaction confirmed, so
        // a transaction failure left memory with wrong stock AND those movement
        // IDs recorded as applied — meaning they would never be re-fetched.
        const pendingMutations = []; // { prod, newStock, newVersion }
        let pendingClampedCount = 0;

        try {
            const idbTx = db.transaction(['inventory_movements'], 'readwrite');
            const idbSt = idbTx.objectStore('inventory_movements');
            fresh.forEach(m => {
                const qtyChange = Number(m.quantity_change) || 0;
                const prod = masterInventoryDB.find(p => p.code === m.product_code);
                if (prod && qtyChange !== 0) {
                    const rawStock = (Number(prod.stock) || 0) + qtyChange;
                    if (rawStock < 0) pendingClampedCount++;
                    pendingMutations.push({
                        prod,
                        newStock:   Math.max(0, rawStock),
                        newVersion: (typeof prod.version === 'number' && prod.version >= 1)
                            ? prod.version + 1 : 1
                    });
                }
                newlyAppliedIds.push(m.movement_id);
                try {
                    idbSt.put({
                        movementId:     m.movement_id,
                        productCode:    m.product_code     || '',
                        quantityChange: qtyChange,
                        stockAfter:     Number(m.stock_after)     || 0,
                        movementType:   m.movement_type    || 'ADJUSTMENT',
                        invoiceId:      m.invoice_number   || null,
                        description:    m.description      || null,
                        timestamp:      m.moved_at ? new Date(m.moved_at).getTime() : Date.now(),
                        deviceCode:     m.counter_id       || '',
                        deviceUUID:     m.device_uuid      || '',
                        synced:         true
                    });
                } catch(_e) {}
            });

            // Apply mutations and persist appliedIds only after IDB confirms
            idbTx.oncomplete = function() {
                pendingMutations.forEach(function(mut) {
                    mut.prod.stock   = mut.newStock;
                    mut.prod.version = mut.newVersion;
                });
                if (pendingClampedCount > 0 && typeof showToast === 'function') {
                    showToast('\u26a0\ufe0f ' + pendingClampedCount + ' remote movement(s) clamped stock at 0.', false);
                }
                // Persist the applied IDs and save updated inventory to IDB
                if (newlyAppliedIds.length > 0) {
                    newlyAppliedIds.forEach(id => appliedIds.add(id));
                    // M3 FIX: raised cap from 5000 to 20000 to prevent re-applying old movements
                    try { StorageModule.set(_appliedKey, JSON.stringify([...appliedIds].slice(-20000))); } catch(e) {}
                }
                if (pendingMutations.length > 0) {
                    try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
                }
            };
            // If the IDB write failed, clear newlyAppliedIds so these movements
            // are re-fetched and re-applied on the next sync cycle instead of
            // being silently dropped with wrong stock in memory.
            idbTx.onerror = function() {
                newlyAppliedIds.length = 0;
                console.warn('[DeltaSync] inventory_movements IDB write failed; movements will be re-applied next cycle.');
            };

        } catch(_idbErr) {
            newlyAppliedIds.length = 0;
        }

        applied = newlyAppliedIds.length > 0;

    } catch(e) {
        console.warn('[DeltaSync] Relational pull failed — trying legacy KV:', e);
        return await _pullRemoteMovementsLegacyKV(appliedIds, newlyAppliedIds);
    }

    return applied;
}

// ── Legacy KV fallback (backward-compat for older client builds) ───────────
async function _pullRemoteMovementsLegacyKV(appliedIds, newlyAppliedIds) {
    let applied = false;
    let knownDevices = [];
    try {
        const reg = await _supaGet('pharma_cloud_device_registry');
        if (reg) { const arr = JSON.parse(reg); if (Array.isArray(arr)) knownDevices = arr; }
    } catch(e) {}
    const myKey = _getDeviceCode() + '_' + _DEVICE_UUID.slice(0, 8);
    if (!knownDevices.includes(myKey)) {
        knownDevices = [...new Set([...knownDevices, myKey])];
        _supaSet('pharma_cloud_device_registry', JSON.stringify(knownDevices)).catch(() => {});
    }
    for (const remoteKey of knownDevices.filter(k => k !== myKey)) {
        try {
            const raw = await _supaGet('pharma_cloud_inv_movements_' + remoteKey);
            if (!raw) continue;
            const movements = JSON.parse(raw);
            if (!Array.isArray(movements) || movements.length === 0) continue;
            const fresh = movements
                .filter(m => m.movementId && !appliedIds.has(m.movementId) && typeof m.timestamp === 'number')
                .sort((a, b) => a.timestamp - b.timestamp);
            let clampedCount = 0;
            fresh.forEach(m => {
                if (!m.productCode || typeof m.quantityChange !== 'number') return;
                const prod = masterInventoryDB.find(p => p.code === m.productCode);
                if (prod) {
                    const rawStock = (Number(prod.stock) || 0) + Number(m.quantityChange);
                    if (rawStock < 0) clampedCount++;
                    prod.stock = Math.max(0, rawStock);
                    prod.version = (typeof prod.version === 'number' && prod.version >= 1)
                        ? prod.version + 1 : 1;
                }
                newlyAppliedIds.push(m.movementId);
            });
            if (clampedCount > 0 && typeof showToast === 'function') {
                showToast('\u26a0\ufe0f ' + clampedCount + ' legacy move(s) clamped at 0 from ' + remoteKey + '.', false);
            }
            applied = true;
        } catch(e) {}
    }
    if (newlyAppliedIds.length > 0) {
        newlyAppliedIds.forEach(id => appliedIds.add(id));
        try { StorageModule.set('pharma_applied_mov_ids', JSON.stringify([...appliedIds].slice(-20000))); } catch(e) {}
        if (applied) { try { saveInventoryToDB(masterInventoryDB); } catch(e) {} }
    }
    return applied;
}


function loadInventoryFromDB() {
    if (!db) return;
    const req = db.transaction(['inventory'], 'readonly').objectStore('inventory').getAll();
    req.onsuccess = function(e) {
        const result = e.target.result;
        const demoBanner = document.getElementById('demoInventoryBanner');
        if (result && result.length > 0) {
            // Backfill 'version' on records loaded from older schema versions.
            // structuredClone ensures masterInventoryDB holds fresh copies — not
            // live references into the IDB result objects — preventing callers
            // from accidentally mutating IDB-cached state via the array.
            masterInventoryDB = structuredClone(result.map(item => {
                if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                return item;
            }));
            window.masterInventoryDB = masterInventoryDB;
            if (demoBanner) demoBanner.classList.remove('visible');
        } else if (window._supabaseRemoteInventory && window._supabaseRemoteInventory.length > 0) {
            masterInventoryDB = structuredClone(window._supabaseRemoteInventory.map(item => {
                if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                return item;
            }));
            window.masterInventoryDB = masterInventoryDB;
            window._supabaseRemoteInventory = null;
            saveInventoryToDB(masterInventoryDB);
            showToast('☁️ Inventory restored from cloud (' + masterInventoryDB.length + ' items).', false);
            if (demoBanner) demoBanner.classList.remove('visible');
        } else {
            const cached = _restoreInventoryCache();
            const _isDirty = localStorage.getItem('_pharma_inv_dirty') === 'true';
            if (cached) {
                masterInventoryDB = structuredClone(cached.map(item => {
                    if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                    return item;
                }));
                window.masterInventoryDB = masterInventoryDB;
                saveInventoryToDB(masterInventoryDB);
                showToast('📦 Inventory restored from local backup (' + masterInventoryDB.length + ' items).', false);
                if (demoBanner) demoBanner.classList.remove('visible');
            } else if (_isDirty) {
                masterInventoryDB = [];
                window.masterInventoryDB = masterInventoryDB;
                if (demoBanner) demoBanner.classList.remove('visible');
                showToast('⚠️ Imported inventory was not found in local storage. Please re-import your CSV.', true);
            } else {
                masterInventoryDB = [
                    { code:'P-1002', name:'Panadol CF',    unitPrice:150, stock:120, company:'GSK',    generic:'Paracetamol', supplier:'Standard Dist.', packDetails:'10x10',  version:1 },
                    { code:'A-5541', name:'Amoxil 250mg',  unitPrice:490, stock:45,  company:'GSK',    generic:'Amoxicillin', supplier:'Standard Dist.', packDetails:'1x12',   version:1 },
                    { code:'B-2099', name:'Brufen 400mg',  unitPrice:210, stock:300, company:'Abbott', generic:'Ibuprofen',   supplier:'Alpha Pharma',   packDetails:'30Tabs', version:1 }
                ];
                window.masterInventoryDB = masterInventoryDB;
                saveInventoryToDB(masterInventoryDB);
                showToast('ℹ️ Demo stock loaded. Import CSV to replace.', false);
                if (demoBanner) demoBanner.classList.add('visible');
            }
        }
        updateHdrStats();
        // Update inventory view content immediately after data loads.
        // If _invReady=true a full report was already open — re-render it.
        // Otherwise refresh the placeholder so it shows the correct product count.
        if (typeof _invReady !== 'undefined' && _invReady) {
            if (typeof renderInventoryView === 'function') try { renderInventoryView(); } catch(_e) {}
        } else {
            if (typeof showInventoryPlaceholder === 'function') try { showInventoryPlaceholder(); } catch(_e) {}
        }
        // Startup full cloud sync — runs for ALL devices (master and client).
        // Ensures every counter is up-to-date with all movements, invoices,
        // and inventory from the cloud on each page load.
        (async function _startupFullCloudSync() {
            try {
                const _startRole = (typeof StorageModule !== 'undefined')
                    ? StorageModule.get('pharma_device_role') : null;

                // Step 1: Pull inventory snapshot (clients only)
                // Master is the inventory source of truth — it pushes, not pulls.
                if (_startRole !== 'master') {
                    try {
                        await _pullInventoryFromSupabase();
                    } catch(e) {
                        console.warn('[Startup] Inventory pull failed:', e);
                    }
                }

                // Step 2: Pull remote invoices from all other devices
                // Small delay to let the Supabase client initialise fully
                await new Promise(r => setTimeout(r, 1500));
                try {
                    if (typeof _dbSelect === 'function' && typeof _DEVICE_UUID !== 'undefined') {
                        const { data: devRows } = await _dbSelect('devices', 'is_active=eq.true', 'uuid');
                        const otherUUIDs = Array.isArray(devRows)
                            ? devRows.map(r => r.uuid).filter(u => u && u !== _DEVICE_UUID)
                            : [];
                        for (const uuid of otherUUIDs) {
                            try {
                                const { data: remInvs } = await _dbSelect(
                                    'invoices',
                                    'device_uuid=eq.' + encodeURIComponent(uuid) +
                                    '&order=billed_at.desc&limit=1000',
                                    '*,invoice_items(*)'
                                );
                                if (Array.isArray(remInvs) &&
                                    typeof StorageModule !== 'undefined' &&
                                    typeof StorageModule.putRemoteInvoice === 'function') {
                                    for (const inv of remInvs) {
                                        await StorageModule.putRemoteInvoice(inv).catch(() => {});
                                    }
                                }
                            } catch(_) {}
                        }
                    }
                } catch(e) {
                    console.warn('[Startup] Remote invoice pull failed:', e);
                }

                // Step 3: Pull remote inventory movements from all other devices
                try {
                    if (typeof _pullRemoteMovements === 'function') {
                        await _pullRemoteMovements();
                    }
                } catch(e) {
                    console.warn('[Startup] Remote movements pull failed:', e);
                }

            } catch(e) {
                console.warn('[Startup] Full cloud sync failed:', e);
            }
        })();
    };
}

// =========================================================================
// CALCULATED STOCK — async ledger utility (not used in render hot path)
// =========================================================================
async function calculateCurrentStock(productCode) {
    if (!db || !productCode) return null;
    return new Promise((resolve, reject) => {
        try {
            const tx  = db.transaction(['inventory_movements'], 'readonly');
            const idx = tx.objectStore('inventory_movements').index('by_code');
            const req = idx.getAll(IDBKeyRange.only(productCode));
            req.onsuccess = e => {
                const movements = e.target.result || [];
                const total = movements.reduce(
                    (sum, m) => sum + (typeof m.quantityChange === 'number' ? Number(m.quantityChange) : 0),
                    0
                );
                resolve(Math.max(0, total));
            };
            req.onerror = () => reject(req.error);
        } catch(e) { reject(e); }
    });
}

// =========================================================================
// FIX 5 — ROGUE MEMORY-CACHE REFERENCE LEAK PREVENTION
//
// window.PharmaInventoryEngine exposes a safe read/write gateway for
// cross-module access to masterInventoryDB:
//
//   getInMemoryCache()  — returns a structuredClone snapshot (read-only).
//                         Callers must NOT mutate the result expecting it
//                         to affect the live array.  Use writeStockToCache()
//                         for all write-back operations.
//
//   writeStockToCache() — the ONLY safe setter for mutating masterInventoryDB
//                         from outside this module (e.g. syncHub writeback).
//                         Mutates the live array directly so the next billing
//                         render sees the authoritative server values.
//
//   getDatabaseHandle() — returns the live IDBDatabase handle for inventory.
// =========================================================================
function _getInMemoryCacheSnapshot() {
    return (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB))
        ? structuredClone(masterInventoryDB)
        : [];
}

function _writeStockToCache(productCode, newQuantity, newVersion) {
    if (typeof masterInventoryDB === 'undefined' || !Array.isArray(masterInventoryDB)) return;
    const idx = masterInventoryDB.findIndex(p => p.code === productCode);
    if (idx >= 0) {
        masterInventoryDB[idx].stock   = Number(newQuantity);
        masterInventoryDB[idx].version = Number(newVersion) || 1;
    }
}

window.PharmaInventoryEngine = {
    getInMemoryCache:  _getInMemoryCacheSnapshot,
    writeStockToCache: _writeStockToCache,
    getDatabaseHandle: function() { return (typeof db !== 'undefined') ? db : null; }
};

// =========================================================================
// INVENTORY VIEW (F8) — RULE 1: INSTANTANEOUS RENDERING
// =========================================================================
let _invSortCol  = 'name';
let _invSortDir  = 1;
let _invReady    = false;
let _invFilters  = { code:'', name:'', generic:'', company:'', supplier:'', pack:'', price:'', stock:'' };
// Pagination
const _INV_PAGE_SIZE = 100;
let _invCurrentPage  = 1;
// Filter dropdown state
let _invDropFilters = { company:'', supplier:'', generic:'' };
let _invStockFilter = 'all';
let _invSearchProduct = null;
let _invGroupBy = 'none';

function _invSetGroupBy(val) { _invGroupBy = val; _invCurrentPage = 1; if (_invReady) renderInventoryView(); }

function sortInvBy(col) {
    if (_invSortCol === col) _invSortDir = -_invSortDir;
    else { _invSortCol = col; _invSortDir = 1; }
    _invCurrentPage = 1;
    if (_invReady) renderInventoryView();
}

function showInventoryPlaceholder() {
    _invReady = false;
    _invSearchProduct = null;
    const container = document.getElementById('inventoryViewContent');
    if (!container) return;
    const sb = document.getElementById('invSearchInput');
    if (sb) { sb.value = ''; }
    const tag = document.getElementById('invSearchTag');
    if (tag) tag.style.display = 'none';
    const res = document.getElementById('invSearchResults');
    if (res) res.style.display = 'none';
    const _list = Array.isArray(masterInventoryDB) ? masterInventoryDB : [];
    const _cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    let _totalValue = 0;
    let _totalUnits = 0;
    for (let i = 0; i < _list.length; i++) {
        const it = _list[i] || {};
        const s = Number(it.stock) || 0;
        const p = Number(it.unitPrice) || 0;
        _totalUnits += s;
        _totalValue += s * p;
    }
    const _valStr = _totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    container.innerHTML = `
        <div class="inv-idle-placeholder">
            <div class="inv-idle-icon">📦</div>
            <div class="inv-idle-title">${_list.length.toLocaleString()} products in catalogue</div>
            <div class="inv-idle-stock-value" style="margin-top:10px;padding:10px 16px;background:var(--surface,#f1f5f9);border:1px solid var(--border,#e2e8f0);border-radius:10px;display:inline-block;font-size:14px;color:var(--fg,#0f172a);">
                <span style="color:var(--muted-fg,#64748b);">Total stock value:</span>
                <strong style="color:var(--g600,#0e7490);font-size:16px;margin-left:6px;">${_escHtml(_cur)}${_valStr}</strong>
                <span style="color:var(--muted-fg,#64748b);margin-left:10px;">·</span>
                <span style="color:var(--muted-fg,#64748b);margin-left:10px;">${_totalUnits.toLocaleString()} units</span>
            </div>
            <div class="inv-idle-sub">Use the search bar above to find a specific product, or click the button below to view the full report.</div>
            <button class="inv-gen-btn" onclick="generateInventoryReport()">📊 Generate Full Report</button>
        </div>`;
}

function generateInventoryReport() { _invReady = true; renderInventoryView(); }

function _invSetFilter(col, val) {
    _invFilters[col] = val.trim().toLowerCase();
    _invCurrentPage = 1;
    if (_invReady) renderInventoryView();
}

function applyInvProductSearch() {
    if (!_invSearchProduct) { showToast('⚠️ Select a product from the dropdown first.', true); return; }
    _invFilters.name = (_invSearchProduct.name || '').toLowerCase();
    _invFilters.code = '';
    _invReady = true;
    _invCurrentPage = 1;
    const res = document.getElementById('invSearchResults');
    if (res) res.style.display = 'none';
    renderInventoryView();
}

function clearInvProductSearch() {
    _invSearchProduct = null;
    const sb = document.getElementById('invSearchInput');
    if (sb) sb.value = '';
    const tag = document.getElementById('invSearchTag');
    if (tag) tag.style.display = 'none';
    const res = document.getElementById('invSearchResults');
    if (res) res.style.display = 'none';
    _invFilters.name = '';
    _invCurrentPage = 1;
    if (_invReady) renderInventoryView();
}

let _invSearchTimer = null;
function _invSearchInput() {
    clearTimeout(_invSearchTimer);
    _invSearchTimer = setTimeout(_doInvDropdownSearch, 150);
}

function _doInvDropdownSearch() {
    const sb  = document.getElementById('invSearchInput');
    const res = document.getElementById('invSearchResults');
    if (!sb || !res) return;
    const val = sb.value.trim().toLowerCase();
    if (!val) { res.style.display = 'none'; return; }
    const items = Array.isArray(masterInventoryDB) ? masterInventoryDB : [];
    const matches = items.filter(it =>
        (it.name    || '').toLowerCase().includes(val) ||
        (it.code    || '').toLowerCase().includes(val) ||
        (it.generic || '').toLowerCase().includes(val)
    ).slice(0, 12);
    if (matches.length === 0) { res.style.display = 'none'; return; }
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    res.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'inv-sr-hdr';
    hdr.innerHTML = '<span>#</span><span>Product</span><span>Pack</span><span>Generic</span><span class="r">Stock</span><span class="r">Price</span>';
    res.appendChild(hdr);
    matches.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'inv-sr-row';
        const s = Number(item.stock) || 0;
        const stockCls = s <= 0 ? 'style="color:var(--red)"' : s <= 10 ? 'style="color:var(--amb)"' : '';
        row.innerHTML = `<span class="inv-sr-num">${i+1}</span>
            <div class="inv-sr-name-wrap"><div class="inv-sr-name">${_escHtml(item.name)}</div><div class="inv-sr-code">${_escHtml(item.code)}</div></div>
            <span class="inv-sr-pack">${_escHtml(item.packDetails||'—')}</span>
            <span class="inv-sr-gen">${_escHtml(item.generic||'—')}</span>
            <span class="inv-sr-stock" ${stockCls}>${s}</span>
            <span class="inv-sr-price">${_escHtml(cur)}${(Number(item.unitPrice)||0).toFixed(2)}</span>`;
        row.addEventListener('mousedown', e => { e.preventDefault(); _selectInvProduct(item); });
        res.appendChild(row);
    });
    res.style.display = 'block';
}

function _selectInvProduct(item) {
    _invSearchProduct = item;
    const sb  = document.getElementById('invSearchInput');
    const res = document.getElementById('invSearchResults');
    const tag = document.getElementById('invSearchTag');
    if (sb)  sb.value = '';
    if (res) res.style.display = 'none';
    if (tag) { tag.querySelector('.inv-tag-text').textContent = item.name + ' (' + item.code + ')'; tag.style.display = 'inline-flex'; }
}

function exportInventoryCSV() {
    const items = Array.isArray(masterInventoryDB) ? masterInventoryDB : [];
    if (items.length === 0) { showToast('⚠️ No inventory to export.', true); return; }
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const header = ['Code','Name','Generic','Company','Supplier','Pack','Unit Price','Stock'];
    const rows = items.map(it => [
        esc(it.code), esc(it.name), esc(it.generic), esc(it.company),
        esc(it.supplier), esc(it.packDetails),
        esc((Number(it.unitPrice) || 0).toFixed(2)), esc(it.stock)
    ]);
    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'inventory_' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast('📥 Inventory exported (' + items.length + ' items).');
}

function requestDeleteProduct(productCode) { requestAdminAccess('DELETE_PRODUCT', productCode); }

function _invSetDropFilter(field, val) {
    _invDropFilters[field] = val;
    _invFilters[field] = val.trim().toLowerCase();
    _invCurrentPage = 1;
    if (_invReady) renderInventoryView();
}

function _invGoToPage(page) {
    _invCurrentPage = page;
    renderInventoryView();
    // Scroll inventory content to top
    const c = document.getElementById('inventoryViewContent');
    if (c) c.scrollTop = 0;
}

function renderInventoryView() {
    const container = document.getElementById('inventoryViewContent');
    if (!container) return;

    const items = Array.isArray(masterInventoryDB) ? [...masterInventoryDB] : [];
    if (items.length === 0) {
        container.innerHTML = '<div class="inv-empty">No inventory items. Import a CSV via Data Hub to get started.</div>';
        return;
    }

    // ── Build unique lists for dropdowns ─────────────────────────────────
    const allCompanies  = [...new Set(items.map(x => x.company  || '').filter(Boolean))].sort();
    const allSuppliers  = [...new Set(items.map(x => x.supplier || '').filter(Boolean))].sort();
    const allGenerics   = [...new Set(items.map(x => x.generic  || '').filter(Boolean))].sort();

    let filtered = items.filter(it => {
        if (_invFilters.code    && !(it.code        ||'').toLowerCase().includes(_invFilters.code))    return false;
        if (_invFilters.name    && !(it.name        ||'').toLowerCase().includes(_invFilters.name))    return false;
        if (_invFilters.generic && !(it.generic     ||'').toLowerCase().includes(_invFilters.generic)) return false;
        if (_invFilters.company && !(it.company     ||'').toLowerCase().includes(_invFilters.company)) return false;
        if (_invFilters.supplier && !(it.supplier   ||'').toLowerCase().includes(_invFilters.supplier)) return false;
        if (_invFilters.pack    && !(it.packDetails ||'').toLowerCase().includes(_invFilters.pack))    return false;
        if (_invFilters.price)  { const pv = (Number(it.unitPrice)||0).toFixed(2); if (!pv.includes(_invFilters.price)) return false; }
        if (_invFilters.stock)  { const sv = String(Number(it.stock)||0); if (!sv.includes(_invFilters.stock)) return false; }
        if (_invStockFilter === 'ok')   { if (!((Number(it.stock)||0) > 10))  return false; }
        if (_invStockFilter === 'low')  { const s = Number(it.stock)||0; if (!(s > 0 && s <= 10)) return false; }
        if (_invStockFilter === 'zero') { if (!((Number(it.stock)||0) <= 0))   return false; }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="inv-empty">No items match your filters. <button style="background:none;border:none;color:var(--teal);font-weight:700;cursor:pointer;font-size:12px;" onclick="_invClearAllFilters()">Show all</button></div>';
        return;
    }

    filtered.sort((a, b) => {
        if (_invGroupBy !== 'none') {
            let gk = _invGroupBy === 'supplier' ? 'supplier' : _invGroupBy === 'generic' ? 'generic' : 'company';
            const ga = (a[gk] || '—').toLowerCase();
            const gb = (b[gk] || '—').toLowerCase();
            if (ga < gb) return -1;
            if (ga > gb) return 1;
        }
        let av, bv;
        if      (_invSortCol === 'code')     { av = a.code    || ''; bv = b.code    || ''; }
        else if (_invSortCol === 'name')     { av = a.name    || ''; bv = b.name    || ''; }
        else if (_invSortCol === 'generic')  { av = a.generic || ''; bv = b.generic || ''; }
        else if (_invSortCol === 'company')  { av = a.company || ''; bv = b.company || ''; }
        else if (_invSortCol === 'supplier') { av = a.supplier || ''; bv = b.supplier || ''; }
        else if (_invSortCol === 'pack')     { av = a.packDetails || ''; bv = b.packDetails || ''; }
        else if (_invSortCol === 'price')    { av = Number(a.unitPrice) || 0; bv = Number(b.unitPrice) || 0; }
        else if (_invSortCol === 'stock')    { av = Number(a.stock) || 0;     bv = Number(b.stock) || 0; }
        else { av = a.name || ''; bv = b.name || ''; }
        if (typeof av === 'number') return _invSortDir * (av - bv);
        return _invSortDir * String(av).localeCompare(String(bv));
    });

    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    // ── Pagination ────────────────────────────────────────────────────────
    const totalFiltered = filtered.length;
    const totalPages    = Math.max(1, Math.ceil(totalFiltered / _INV_PAGE_SIZE));
    if (_invCurrentPage > totalPages) _invCurrentPage = totalPages;
    if (_invCurrentPage < 1) _invCurrentPage = 1;
    const pageStart = (_invCurrentPage - 1) * _INV_PAGE_SIZE;
    const pageEnd   = Math.min(pageStart + _INV_PAGE_SIZE, totalFiltered);
    const pageItems = filtered.slice(pageStart, pageEnd);

    // ── Pagination bar HTML ───────────────────────────────────────────────
    const _makePagination = () => {
        if (totalPages <= 1) return '';
        let pageNums = '';
        const win = 2;
        for (let p = 1; p <= totalPages; p++) {
            const isActive = p === _invCurrentPage;
            if (p === 1 || p === totalPages || (p >= _invCurrentPage - win && p <= _invCurrentPage + win)) {
                pageNums += `<button class="inv-page-btn${isActive ? ' inv-page-btn-active' : ''}" onclick="_invGoToPage(${p})" title="Page ${p}">${p}</button>`;
            } else if (p === _invCurrentPage - win - 1 || p === _invCurrentPage + win + 1) {
                pageNums += `<span class="inv-page-ellipsis">…</span>`;
            }
        }
        return `<div class="inv-pagination-bar">
            <button class="inv-page-btn inv-page-nav" onclick="_invGoToPage(${_invCurrentPage - 1})" ${_invCurrentPage === 1 ? 'disabled' : ''} title="Previous page">‹ Prev</button>
            <div class="inv-page-nums">${pageNums}</div>
            <button class="inv-page-btn inv-page-nav" onclick="_invGoToPage(${_invCurrentPage + 1})" ${_invCurrentPage === totalPages ? 'disabled' : ''} title="Next page">Next ›</button>
            <span class="inv-page-info">${pageStart + 1}–${pageEnd} of ${totalFiltered.toLocaleString()}</span>
        </div>`;
    };

    // ── Filter dropdowns (collapsible) ────────────────────────────────────
    const _isDropExpanded = () => {
        return !!(document.getElementById('invDropFilterPanel') && document.getElementById('invDropFilterPanel').classList.contains('inv-dfp-open'));
    };
    const hasDropFilter = _invDropFilters.company || _invDropFilters.supplier || _invDropFilters.generic;
    const dropPanelOpen = hasDropFilter; // auto-open if a filter is active

    const _makeDropOption = (val, currentVal) => {
        const sel = val === currentVal ? ' selected' : '';
        return `<option value="${_escHtml(val)}"${sel}>${_escHtml(val)}</option>`;
    };
    const _makeDropSelect = (field, label, optList, currentVal) => {
        const opts = ['<option value="">All ' + label + 's</option>', ...optList.map(v => _makeDropOption(v, currentVal))].join('');
        return `<div class="inv-df-group">
            <label class="inv-df-label">${label}</label>
            <select class="inv-df-select" onchange="_invSetDropFilter('${field}',this.value)">
                ${opts}
            </select>
            ${currentVal ? `<button class="inv-df-clear" onclick="_invSetDropFilter('${field}','')">×</button>` : ''}
        </div>`;
    };

    const dropFilterHtml = `
        <div class="inv-drop-filter-wrap" id="invDropFilterWrap">
            <button class="inv-dfp-toggle" id="invDfpToggle" onclick="(function(){var p=document.getElementById('invDropFilterPanel');var t=document.getElementById('invDfpToggle');if(p.classList.toggle('inv-dfp-open')){t.classList.add('inv-dfp-toggle-open')}else{t.classList.remove('inv-dfp-toggle-open')}})()">
                <span>🔽 Filter by Company / Supplier / Generic</span>
                ${hasDropFilter ? `<span class="inv-dfp-badge">${[_invDropFilters.company, _invDropFilters.supplier, _invDropFilters.generic].filter(Boolean).length} active</span>` : ''}
                <span class="inv-dfp-arrow" id="invDfpArrow">▼</span>
            </button>
            <div class="inv-dfp-panel ${dropPanelOpen ? 'inv-dfp-open' : ''}" id="invDropFilterPanel">
                <div class="inv-df-row">
                    ${_makeDropSelect('company',  'Company',  allCompanies,  _invDropFilters.company)}
                    ${_makeDropSelect('supplier', 'Supplier', allSuppliers,  _invDropFilters.supplier)}
                    ${_makeDropSelect('generic',  'Generic',  allGenerics,   _invDropFilters.generic)}
                    ${hasDropFilter ? `<button class="inv-df-clear-all" onclick="_invClearDropFilters()">✕ Clear</button>` : ''}
                </div>
            </div>
        </div>`;

    // ── Column header builders ────────────────────────────────────────────
    const _thSF = (col, label, placeholder) => {
        const arrow = _invSortCol === col ? (_invSortDir > 0 ? '▲' : '▼') : '↕';
        const fval  = _escHtml(_invFilters[col] || '');
        const hasFilter = !!_invFilters[col];
        return `<th class="inv-th inv-th-sort${hasFilter?' inv-th-filtered':''}">
            <div class="inv-th-top" onclick="sortInvBy('${col}')" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;">
                <span>${label}</span><span class="inv-sort-arrow">${arrow}</span>
            </div>
            <div class="inv-th-filter">
                <input class="inv-filter-inp" type="text" value="${fval}" placeholder="${placeholder}"
                    oninput="_invSetFilter('${col}',this.value)" onclick="event.stopPropagation()">
                ${hasFilter ? `<button class="inv-filter-clear" onclick="_invSetFilter('${col}','');this.closest('th').querySelector('.inv-filter-inp').value=''" title="Clear">×</button>` : ''}
            </div>
        </th>`;
    };

    const stockArrow = _invSortCol === 'stock' ? (_invSortDir > 0 ? '▲' : '▼') : '↕';
    const stockFiltered = _invStockFilter !== 'all' || !!_invFilters.stock;
    const stockTh = `<th class="inv-th inv-th-sort${stockFiltered?' inv-th-filtered':''}">
        <div class="inv-th-top" onclick="sortInvBy('stock')" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;">
            <span>Stock</span><span class="inv-sort-arrow">${stockArrow}</span>
        </div>
        <div class="inv-th-filter" style="display:flex;gap:3px;">
            <input class="inv-filter-inp" style="width:48px;" type="text" value="${_escHtml(_invFilters.stock||'')}" placeholder="qty"
                oninput="_invSetFilter('stock',this.value)" onclick="event.stopPropagation()" title="Filter by quantity">
            <select class="inv-filter-sel" onchange="_invSetStockStatus(this.value)" onclick="event.stopPropagation()" title="Filter by status">
                <option value="all"  ${_invStockFilter==='all' ?'selected':''}>All</option>
                <option value="ok"   ${_invStockFilter==='ok'  ?'selected':''}>✅ OK</option>
                <option value="low"  ${_invStockFilter==='low' ?'selected':''}>⚠️ Low</option>
                <option value="zero" ${_invStockFilter==='zero'?'selected':''}>❌ Zero</option>
            </select>
        </div>
    </th>`;

    const totalCount = items.length;
    const activeFilters = Object.values(_invFilters).some(v=>v) || _invStockFilter !== 'all';

    const filterBar = activeFilters
        ? `<div class="inv-filter-bar"><span>Showing ${totalFiltered.toLocaleString()} of ${totalCount.toLocaleString()} (page ${_invCurrentPage}/${totalPages})</span><button onclick="_invClearAllFilters()">✕ Clear all filters</button><button class="inv-gen-btn" style="background:#0369a1;margin-left:auto;" onclick="deleteZeroStockItems()" title="Delete all zero-stock items from catalogue &amp; cloud">🧹 Delete Zero Stock</button><button class="inv-gen-btn" style="background:#dc2626;margin-left:6px;" onclick="openPurgeInventoryModal()" title="Purge all local inventory data (requires password)">🗑 Purge All</button></div>`
        : `<div class="inv-filter-bar inv-filter-bar-dim"><span>${totalCount.toLocaleString()} products · page ${_invCurrentPage}/${totalPages}</span><button class="inv-gen-btn" style="background:#0369a1;margin-left:auto;" onclick="deleteZeroStockItems()" title="Delete all zero-stock items from catalogue &amp; cloud">🧹 Delete Zero Stock</button><button class="inv-gen-btn" style="background:#dc2626;margin-left:6px;" onclick="openPurgeInventoryModal()" title="Purge all local inventory data (requires password)">🗑 Purge All</button></div>`;

    // ── Row builder ───────────────────────────────────────────────────────
    const _makeRow = (item, rowNum) => {
        const s = Number(item.stock) || 0;
        const stockCls = s <= 0 ? 'inv-stock-zero' : s <= 10 ? 'inv-stock-low' : 'inv-stock-ok';
        const codeEsc = _escHtml(item.code);
        return `<tr class="inv-row" onclick="openItemHistoryDrawer('${codeEsc}')" title="View movement history">
            <td class="inv-td inv-td-num">${(pageStart + rowNum + 1).toLocaleString()}</td>
            <td class="inv-td inv-td-code">${_escHtml(item.code)}</td>
            <td class="inv-td inv-td-name">${_escHtml(item.name || '—')}</td>
            <td class="inv-td inv-td-generic">${_escHtml(item.generic || '—')}</td>
            <td class="inv-td inv-td-company">${_escHtml(item.company || '—')}</td>
            <td class="inv-td inv-td-supplier">${_escHtml(item.supplier || '—')}</td>
            <td class="inv-td inv-td-pack">${_escHtml(item.packDetails || '—')}</td>
            <td class="inv-td inv-td-price">${_escHtml(cur)}${(Number(item.unitPrice) || 0).toFixed(2)}</td>
            <td class="inv-td inv-td-stock"><span class="inv-stock-badge ${stockCls}">${_escHtml(String(s))}</span></td>
            <td class="inv-td inv-td-hist" style="white-space:nowrap;">
                <button class="inv-hist-btn" onclick="openItemHistoryDrawer('${codeEsc}');event.stopPropagation();" title="Movement history">📋</button>
                <button class="inv-hist-btn" style="margin-left:4px;color:var(--red);" onclick="requestDeleteProduct('${codeEsc}');event.stopPropagation();" title="Delete product">🗑</button>
            </td>
        </tr>`;
    };

    // ── Build rows for current page (with optional group headers) ─────────
    let rows = '';
    if (_invGroupBy !== 'none') {
        const gk = _invGroupBy === 'supplier' ? 'supplier' : _invGroupBy === 'generic' ? 'generic' : 'company';
        const gLabel = _invGroupBy === 'supplier' ? '🚚 Supplier' : _invGroupBy === 'generic' ? '💊 Generic' : '🏭 Company';
        let lastGroup = null;
        pageItems.forEach((item, i) => {
            const gval = item[gk] || '—';
            if (gval !== lastGroup) {
                const groupItems = filtered.filter(x => (x[gk] || '—') === gval);
                const groupStock = groupItems.reduce((s, x) => s + (Number(x.stock)||0), 0);
                rows += `<tr class="inv-group-header">
                    <td colspan="10" class="inv-group-cell">
                        <span class="inv-group-label">${gLabel}: <strong>${_escHtml(gval)}</strong></span>
                        <span class="inv-group-meta">${groupItems.length} item${groupItems.length!==1?'s':''} · ${groupStock} units</span>
                    </td>
                </tr>`;
                lastGroup = gval;
            }
            rows += _makeRow(item, pageStart + i);
        });
    } else {
        rows = pageItems.map((item, i) => _makeRow(item, i)).join('');
    }

    const paginationBar = _makePagination();

    container.innerHTML = filterBar + dropFilterHtml + paginationBar + `
        <div class="inv-table-scroll-x">
        <table class="inv-table inv-table-full">
            <thead>
                <tr>
                    <th class="inv-th inv-th-num">#</th>
                    ${_thSF('code',     'Code',     'code…')}
                    ${_thSF('name',     'Name',     'name…')}
                    ${_thSF('generic',  'Generic',  'generic…')}
                    ${_thSF('company',  'Company',  'company…')}
                    ${_thSF('supplier', 'Supplier', 'supplier…')}
                    ${_thSF('pack',     'Pack',     'pack…')}
                    ${_thSF('price',    'Price',    'price…')}
                    ${stockTh}
                    <th class="inv-th">Actions</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        </div>` + paginationBar;
}

function _invClearDropFilters() {
    _invDropFilters = { company:'', supplier:'', generic:'' };
    _invFilters.company  = '';
    _invFilters.supplier = '';
    _invFilters.generic  = '';
    _invCurrentPage = 1;
    if (_invReady) renderInventoryView();
}

function _invSetStockStatus(val) { _invStockFilter = val; _invCurrentPage = 1; if (_invReady) renderInventoryView(); }

function _invClearAllFilters() {
    _invFilters = { code:'', name:'', generic:'', company:'', supplier:'', pack:'', price:'', stock:'' };
    _invDropFilters = { company:'', supplier:'', generic:'' };
    _invStockFilter = 'all';
    _invCurrentPage = 1;
    clearInvProductSearch();
    renderInventoryView();
}

// =========================================================================
// RULE 2: DEFERRED AUDIT TRAIL — LIGHTWEIGHT DRAWER
// =========================================================================
let _currentDrawerCode = null;

function openItemHistoryDrawer(productCode) {
    const item   = Array.isArray(masterInventoryDB) ? masterInventoryDB.find(it => it.code === productCode) : null;
    const drawer = document.getElementById('itemHistoryDrawer');
    const title  = document.getElementById('itemHistoryDrawerTitle');
    const body   = document.getElementById('itemHistoryDrawerBody');
    if (!drawer || !body) return;
    _currentDrawerCode = productCode;
    if (title) title.textContent = item
        ? (_escHtml(item.name) + '  (' + _escHtml(productCode) + ')  — Stock Ledger')
        : (_escHtml(productCode) + ' — Stock Ledger');
    body.innerHTML =
        '<div class="inv-ledger-placeholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;gap:12px;text-align:center;">' +
            '<span style="font-size:32px;">📊</span>' +
            '<p style="font-size:13px;font-weight:600;color:var(--g600);margin:0;">Click \'Generate Ledger\' to compile audit tracking sheets</p>' +
            '<p style="font-size:11px;color:var(--g400);margin:0;">Ledger computation queries the full movement history for this product.</p>' +
        '</div>';
    drawer.classList.add('open');
}

function closeItemHistoryDrawer() {
    const drawer = document.getElementById('itemHistoryDrawer');
    if (drawer) drawer.classList.remove('open');
    _currentDrawerCode = null;
}

document.addEventListener('DOMContentLoaded', function() {
    const ledgerBtn = document.getElementById('generateLedgerBtn');
    if (ledgerBtn) ledgerBtn.addEventListener('click', _compileLedgerForCurrentDrawer);
});

function _compileLedgerForCurrentDrawer() {
    const productCode = _currentDrawerCode;
    const body = document.getElementById('itemHistoryDrawerBody');
    if (!productCode || !body) return;
    // Hide export buttons while compiling
    const csvBtn = document.getElementById('ledgerExportCSVBtn');
    const pdfBtn = document.getElementById('ledgerExportPDFBtn');
    if (csvBtn) { csvBtn.style.display = 'none'; }
    if (pdfBtn) { pdfBtn.style.display = 'none'; }
    window._lastCompiledLedger = null;
    if (!db) { body.innerHTML = '<p class="inv-err" style="padding:16px;color:var(--red);">Database unavailable.</p>'; return; }
    body.innerHTML = '<div class="inv-loading" style="padding:16px;text-align:center;color:var(--g500);font-size:12px;">⏳ Compiling ledger…</div>';
    try {
        const tx  = db.transaction(['inventory_movements'], 'readonly');
        const idx = tx.objectStore('inventory_movements').index('by_code');
        const req = idx.getAll(IDBKeyRange.only(productCode));

        req.onsuccess = function(e) {
            const item = Array.isArray(masterInventoryDB) ? masterInventoryDB.find(it => it.code === productCode) : null;
            const rawMovements = e.target.result || [];

            const ascending = rawMovements.slice().sort((a, b) => {
                const ta = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
                const tb = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
                return ta - tb;
            });

            const hasOpening = ascending.some(m => m.movementType === 'OPENING');
            let augmented = ascending;
            if (!hasOpening && item) {
                const sumDeltas = ascending.reduce((acc, m) => acc + (Number(m.quantityChange) || 0), 0);
                const syntheticQty = Number(item.stock) - sumDeltas;
                const earliestTs  = ascending.length > 0
                    ? ((typeof ascending[0].timestamp === 'number' ? ascending[0].timestamp : new Date(ascending[0].timestamp).getTime()) - 1000)
                    : Date.now();
                augmented = [{
                    movementId:     'BASELINE_ESTIMATE',
                    productCode,
                    quantityChange: syntheticQty,
                    movementType:   'OPENING',
                    invoiceId:      'BASELINE',
                    description:    'Opening balance estimated from snapshot — no explicit record found',
                    timestamp:      earliestTs,
                    deviceCode:     '—',
                    _isSynthetic:   true
                }, ...ascending];
            }

            if (augmented.length === 0) {
                body.innerHTML = '<p class="inv-hist-empty" style="padding:16px;text-align:center;color:var(--g500);">No movement records found for this item.</p>';
                return;
            }

            let runningBalance = 0;
            const ledgerWithBalance = augmented.map(function(m) {
                runningBalance += Number(m.quantityChange) || 0;
                return Object.assign({}, m, { _balanceAfter: runningBalance });
            });

            const descending = ledgerWithBalance.slice().reverse();
            const finalLedgerStock = runningBalance;

            const typeLabel = { SALE:'🛒 Sale', REFUND:'↩ Refund', PARTIAL_REFUND:'↩ Partial Refund', OPENING:'📦 Opening Stock', ADJUSTMENT:'🔧 Adjustment', EDIT_RESTORE:'✏️ Edit Restore' };
            const typeClass = { SALE:'inv-mv-sale', REFUND:'inv-mv-refund', PARTIAL_REFUND:'inv-mv-refund', OPENING:'inv-mv-open', ADJUSTMENT:'inv-mv-adj', EDIT_RESTORE:'inv-mv-adj' };

            const rows = descending.map(function(m) {
                const sign    = Number(m.quantityChange) >= 0 ? '+' : '';
                const label   = typeLabel[m.movementType] || _escHtml(String(m.movementType || '—'));
                const cls     = typeClass[m.movementType] || '';
                const isSynth = !!m._isSynthetic;
                const tsRaw   = m.timestamp;
                const tsMs    = typeof tsRaw === 'number' ? tsRaw : new Date(tsRaw).getTime();
                const ts      = (tsMs && !isSynth)
                    ? _toPKT(new Date(tsMs), {year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true})
                    : (isSynth ? 'Baseline estimate' : '—');
                const dispBal  = Math.max(0, m._balanceAfter);
                const balCls   = m._balanceAfter <= 0 ? 'inv-mv-neg' : m._balanceAfter <= 10 ? 'inv-mv-low' : 'inv-mv-pos';
                const rowStyle = isSynth ? ' style="opacity:.72;font-style:italic;"' : '';
                const descText = m.description ? _escHtml(String(m.description)) : (isSynth ? '<em style="color:var(--g400);">Auto-estimated</em>' : '—');
                return '<tr' + rowStyle + '>' +
                    '<td class="inv-mv-td inv-mv-ts">'  + _escHtml(ts) + '</td>' +
                    '<td class="inv-mv-td"><span class="inv-mv-type ' + cls + '">' + label + (isSynth ? ' *' : '') + '</span></td>' +
                    '<td class="inv-mv-td inv-mv-qty '  + (Number(m.quantityChange) >= 0 ? 'inv-mv-pos' : 'inv-mv-neg') + '">' + _escHtml(sign + String(Number(m.quantityChange))) + '</td>' +
                    '<td class="inv-mv-td inv-mv-bal '  + balCls + '">' + _escHtml(String(dispBal)) + '</td>' +
                    '<td class="inv-mv-td inv-mv-inv">' + (m.invoiceId ? _escHtml(String(m.invoiceId)) : '—') + '</td>' +
                    '<td class="inv-mv-td inv-mv-dev">' + _escHtml(String(m.deviceCode || (m.deviceUUID ? m.deviceUUID.slice(0, 8) : '—'))) + '</td>' +
                    '<td class="inv-mv-td inv-mv-desc">' + descText + '</td>' +
                '</tr>';
            }).join('');

            body.innerHTML =
                '<div class="inv-hist-summary" style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 12px;background:var(--g50);border-bottom:1px solid var(--g200);font-size:12px;">' +
                    '<span class="inv-hist-count" style="font-weight:700;color:var(--teal);">' + _escHtml(String(rawMovements.length)) + ' movement' + (rawMovements.length !== 1 ? 's' : '') + '</span>' +
                    '<span class="inv-hist-ledger" style="color:var(--g700);">Computed Ledger Balance: <strong>' + _escHtml(String(finalLedgerStock)) + '</strong></span>' +
                    (item ? '<span class="inv-hist-snapshot" style="color:var(--g600);">Snapshot Stock: <strong>' + _escHtml(String(item.stock != null ? item.stock : '—')) + '</strong></span>' : '') +
                '</div>' +
                '<div style="overflow-x:auto;">' +
                '<table class="inv-mv-table" style="width:100%;border-collapse:collapse;">' +
                    '<thead><tr>' +
                        '<th class="inv-mv-th">Time</th><th class="inv-mv-th">Type</th><th class="inv-mv-th">Qty Δ</th>' +
                        '<th class="inv-mv-th">Balance</th><th class="inv-mv-th">Invoice</th>' +
                        '<th class="inv-mv-th">Device</th><th class="inv-mv-th">Description</th>' +
                    '</tr></thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table></div>';

            // Store compiled ledger for export
            window._lastCompiledLedger = {
                productCode: productCode,
                productName: item ? (item.name || productCode) : productCode,
                generic:     item ? (item.generic || '—') : '—',
                company:     item ? (item.company || '—') : '—',
                supplier:    item ? (item.supplier || '—') : '—',
                snapshotStock: item ? (item.stock != null ? item.stock : '—') : '—',
                ledgerStock:   finalLedgerStock,
                movements:     descending
            };
            // Show export buttons
            const _csv = document.getElementById('ledgerExportCSVBtn');
            const _pdf = document.getElementById('ledgerExportPDFBtn');
            if (_csv) { _csv.style.display = 'inline-flex'; }
            if (_pdf) { _pdf.style.display = 'inline-flex'; }
        };
        req.onerror = function() { body.innerHTML = '<p class="inv-err" style="padding:16px;color:var(--red);">Failed to load movement history.</p>'; };
        tx.onerror  = function() { body.innerHTML = '<p class="inv-err" style="padding:16px;color:var(--red);">Transaction error loading ledger.</p>'; };
    } catch(e) {
        body.innerHTML = '<p class="inv-err" style="padding:16px;color:var(--red);">Error: ' + _escHtml(String(e.message || e)) + '</p>';
    }
}

// =========================================================================
// LEDGER EXPORT — CSV & PDF
// =========================================================================

function exportLedgerCSV() {
    const L = window._lastCompiledLedger;
    if (!L || !L.movements || L.movements.length === 0) { showToast('⚠️ Generate ledger first.', true); return; }
    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    const storeName = bi.businessName || bi.branchName || 'Pharma POS';
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const header = ['Date/Time','Type','Qty Change','Balance After','Invoice ID','Device','Description'];
    const typeLabel = { SALE:'Sale', REFUND:'Refund', PARTIAL_REFUND:'Partial Refund', OPENING:'Opening Stock', ADJUSTMENT:'Adjustment', EDIT_RESTORE:'Edit Restore' };
    const dataRows = L.movements.map(m => {
        const tsMs = typeof m.timestamp === 'number' ? m.timestamp : new Date(m.timestamp).getTime();
        const ts = (tsMs && !m._isSynthetic) ? _toPKT(new Date(tsMs)) : 'Baseline estimate';
        const type = typeLabel[m.movementType] || m.movementType || '—';
        const sign = Number(m.quantityChange) >= 0 ? '+' : '';
        return [
            esc(ts), esc(type), esc(sign + String(Number(m.quantityChange))),
            esc(Math.max(0, m._balanceAfter)),
            esc(m.invoiceId || '—'),
            esc(m.deviceCode || (m.deviceUUID ? m.deviceUUID.slice(0,8) : '—')),
            esc(m.description || (m._isSynthetic ? 'Auto-estimated opening balance' : '—'))
        ].join(',');
    });
    const infoRows = [
        '# ' + storeName + ' — Product Ledger Export',
        '# Product: ' + L.productName + ' (' + L.productCode + ')',
        '# Generic: ' + L.generic + ' | Company: ' + L.company + ' | Supplier: ' + L.supplier,
        '# Exported: ' + _toPKT(new Date()),
        '# Ledger Balance: ' + L.ledgerStock + ' | Snapshot Stock: ' + L.snapshotStock,
        '',
        header.join(','),
        ...dataRows
    ];
    const csv = infoRows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'ledger_' + (L.productCode || 'product').replace(/[^A-Z0-9]/gi,'_') + '_' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast('📥 Ledger CSV exported (' + L.movements.length + ' movements).');
}

function exportLedgerPDF() {
    const L = window._lastCompiledLedger;
    if (!L || !L.movements || L.movements.length === 0) { showToast('⚠️ Generate ledger first.', true); return; }
    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    const storeName = bi.businessName || bi.branchName || 'Pharma POS';
    const branchName = bi.branchName || '';
    const counterId  = bi.counterId  || '';
    const typeLabel = { SALE:'Sale', REFUND:'Refund', PARTIAL_REFUND:'Partial Refund', OPENING:'Opening Stock', ADJUSTMENT:'Adjustment', EDIT_RESTORE:'Edit Restore' };
    const typeColor = { SALE:'#0f766e', REFUND:'#b91c1c', PARTIAL_REFUND:'#b91c1c', OPENING:'#1d4ed8', ADJUSTMENT:'#92400e', EDIT_RESTORE:'#6d28d9' };
    const typeBg    = { SALE:'#f0fdf9', REFUND:'#fff1f2', PARTIAL_REFUND:'#fff1f2', OPENING:'#eff6ff', ADJUSTMENT:'#fffbeb', EDIT_RESTORE:'#f5f3ff' };

    const rowsHTML = L.movements.map((m, i) => {
        const tsMs = typeof m.timestamp === 'number' ? m.timestamp : new Date(m.timestamp).getTime();
        const ts = (tsMs && !m._isSynthetic) ? _toPKT(new Date(tsMs), {year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}) : 'Baseline estimate';
        const type  = typeLabel[m.movementType] || m.movementType || '—';
        const color = typeColor[m.movementType] || '#374151';
        const bg    = typeBg[m.movementType]    || '#fff';
        const qty   = Number(m.quantityChange);
        const sign  = qty >= 0 ? '+' : '';
        const qtyColor  = qty >= 0 ? '#15803d' : '#b91c1c';
        const bal   = Math.max(0, m._balanceAfter);
        const balColor  = bal <= 0 ? '#b91c1c' : bal <= 10 ? '#b45309' : '#15803d';
        const dev   = _escHtml(String(m.deviceCode || (m.deviceUUID ? m.deviceUUID.slice(0,8) : '—')));
        const desc  = m.description ? _escHtml(String(m.description)) : (m._isSynthetic ? '<em>Auto-estimated opening balance</em>' : '—');
        const inv   = m.invoiceId ? _escHtml(String(m.invoiceId)) : '—';
        const rowBg = i % 2 === 0 ? '#f9fafb' : '#ffffff';
        const synthStyle = m._isSynthetic ? 'opacity:.75;font-style:italic;' : '';
        return `<tr style="background:${rowBg};${synthStyle}">
            <td style="padding:7px 10px;font-size:11px;color:#374151;white-space:nowrap;border-bottom:1px solid #e5e7eb;">${_escHtml(ts)}</td>
            <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;">
                <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:${bg};color:${color};">${_escHtml(type)}</span>
            </td>
            <td style="padding:7px 10px;font-size:12px;font-weight:700;color:${qtyColor};text-align:center;border-bottom:1px solid #e5e7eb;">${sign}${qty}</td>
            <td style="padding:7px 10px;font-size:12px;font-weight:800;color:${balColor};text-align:center;border-bottom:1px solid #e5e7eb;">${bal}</td>
            <td style="padding:7px 10px;font-size:10px;font-family:monospace;color:#6b7280;border-bottom:1px solid #e5e7eb;">${inv}</td>
            <td style="padding:7px 10px;font-size:10px;font-weight:600;color:#4b5563;border-bottom:1px solid #e5e7eb;">${dev}</td>
            <td style="padding:7px 10px;font-size:10px;color:#6b7280;border-bottom:1px solid #e5e7eb;max-width:200px;">${desc}</td>
        </tr>`;
    }).join('');

    const totalSales   = L.movements.filter(m => m.movementType === 'SALE').reduce((s, m) => s + Math.abs(Number(m.quantityChange)||0), 0);
    const totalRefunds = L.movements.filter(m => m.movementType === 'REFUND' || m.movementType === 'PARTIAL_REFUND').reduce((s, m) => s + Math.abs(Number(m.quantityChange)||0), 0);
    const totalAdj     = L.movements.filter(m => m.movementType === 'ADJUSTMENT').reduce((s, m) => s + (Number(m.quantityChange)||0), 0);
    const now = _toPKT(new Date(), {year:'numeric',month:'long',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true});

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Product Ledger — ${_escHtml(L.productName)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Inter',sans-serif;background:#f3f4f6;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  @page{size:A4 landscape;margin:14mm 12mm;}
  @media print{body{background:#fff;}.no-print{display:none!important;}.page-break{page-break-before:always;}}
  .wrap{max-width:1100px;margin:0 auto;padding:24px;}
  /* Header */
  .header{background:linear-gradient(135deg,#0f766e 0%,#0d9488 60%,#14b8a6 100%);border-radius:14px;padding:28px 32px;margin-bottom:20px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start;}
  .header-left{}
  .store-name{font-size:22px;font-weight:900;letter-spacing:-.3px;margin-bottom:2px;}
  .store-branch{font-size:12px;opacity:.8;font-weight:600;letter-spacing:.3px;margin-bottom:16px;}
  .doc-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;opacity:.7;margin-bottom:4px;}
  .product-name{font-size:28px;font-weight:900;letter-spacing:-.5px;line-height:1.1;}
  .product-code{font-size:13px;opacity:.75;font-weight:600;font-family:monospace;margin-top:4px;}
  .header-right{text-align:right;flex-shrink:0;}
  .export-date{font-size:10px;opacity:.7;margin-bottom:6px;}
  .device-badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 12px;font-size:11px;font-weight:700;}
  /* Meta pills */
  .meta-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;}
  .meta-pill{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 18px;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .meta-pill-label{font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px;}
  .meta-pill-value{font-size:15px;font-weight:800;color:#111827;}
  .meta-pill-sub{font-size:10px;color:#6b7280;margin-top:2px;}
  /* Stats */
  .stats-bar{display:flex;gap:10px;margin-bottom:20px;}
  .stat-card{flex:1;border-radius:10px;padding:14px 18px;text-align:center;}
  .stat-card.sold{background:#f0fdf9;border:1px solid #99f6e4;}
  .stat-card.refund{background:#fff1f2;border:1px solid #fecdd3;}
  .stat-card.adj{background:#fffbeb;border:1px solid #fde68a;}
  .stat-card.balance{background:#eff6ff;border:1px solid #bfdbfe;}
  .stat-label{font-size:9px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px;}
  .stat-value{font-size:26px;font-weight:900;}
  .stat-card.sold .stat-value{color:#0f766e;}
  .stat-card.refund .stat-value{color:#b91c1c;}
  .stat-card.adj .stat-value{color:#b45309;}
  .stat-card.balance .stat-value{color:#1d4ed8;}
  /* Table */
  .table-wrap{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.07);border:1px solid #e5e7eb;}
  .table-header{padding:14px 20px;background:#f9fafb;border-bottom:2px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;}
  .table-title{font-size:13px;font-weight:800;color:#374151;letter-spacing:.2px;}
  .table-count{font-size:11px;color:#9ca3af;font-weight:600;}
  table{width:100%;border-collapse:collapse;}
  th{padding:9px 10px;font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;text-align:left;background:#f9fafb;border-bottom:2px solid #e5e7eb;}
  th.center{text-align:center;}
  /* Footer */
  .footer{margin-top:20px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#9ca3af;}
  .footer-note{font-style:italic;}
  .print-btn{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:20px;}
  .print-btn:hover{background:#0d9488;}
</style>
</head>
<body>
<div class="wrap">
  <div class="no-print" style="margin-bottom:16px;">
    <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
    <span style="font-size:11px;color:#6b7280;margin-left:10px;">Use browser Print → Save as PDF for best results</span>
  </div>

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <div class="store-name">${_escHtml(storeName)}</div>
      <div class="store-branch">${_escHtml(branchName)}${branchName && counterId ? ' · ' : ''}${_escHtml(counterId)}</div>
      <div class="doc-title">Product Movement Ledger</div>
      <div class="product-name">${_escHtml(L.productName)}</div>
      <div class="product-code">${_escHtml(L.productCode)}</div>
    </div>
    <div class="header-right">
      <div class="export-date">Exported: ${_escHtml(now)}</div>
      <div class="device-badge">📱 ${_escHtml(counterId || 'Master Device')}</div>
    </div>
  </div>

  <!-- META PILLS -->
  <div class="meta-bar">
    <div class="meta-pill">
      <div class="meta-pill-label">Generic / Salt</div>
      <div class="meta-pill-value">${_escHtml(L.generic)}</div>
    </div>
    <div class="meta-pill">
      <div class="meta-pill-label">Company / Manufacturer</div>
      <div class="meta-pill-value">${_escHtml(L.company)}</div>
    </div>
    <div class="meta-pill">
      <div class="meta-pill-label">Supplier</div>
      <div class="meta-pill-value">${_escHtml(L.supplier)}</div>
    </div>
    <div class="meta-pill">
      <div class="meta-pill-label">Snapshot Stock</div>
      <div class="meta-pill-value">${_escHtml(String(L.snapshotStock))}</div>
      <div class="meta-pill-sub">units in database</div>
    </div>
    <div class="meta-pill">
      <div class="meta-pill-label">Ledger Balance</div>
      <div class="meta-pill-value" style="color:#0f766e;">${_escHtml(String(L.ledgerStock))}</div>
      <div class="meta-pill-sub">computed from movements</div>
    </div>
  </div>

  <!-- STATS -->
  <div class="stats-bar">
    <div class="stat-card sold">
      <div class="stat-label">Total Units Sold</div>
      <div class="stat-value">${totalSales}</div>
    </div>
    <div class="stat-card refund">
      <div class="stat-label">Units Refunded</div>
      <div class="stat-value">${totalRefunds}</div>
    </div>
    <div class="stat-card adj">
      <div class="stat-label">Net Adjustments</div>
      <div class="stat-value">${totalAdj >= 0 ? '+' : ''}${totalAdj}</div>
    </div>
    <div class="stat-card balance">
      <div class="stat-label">Total Movements</div>
      <div class="stat-value">${L.movements.length}</div>
    </div>
  </div>

  <!-- TABLE -->
  <div class="table-wrap">
    <div class="table-header">
      <div class="table-title">📋 Movement History (Newest First)</div>
      <div class="table-count">${L.movements.length} record${L.movements.length !== 1 ? 's' : ''}</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Date &amp; Time</th>
          <th>Type</th>
          <th class="center">Qty Δ</th>
          <th class="center">Balance</th>
          <th>Invoice ID</th>
          <th>Device</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="footer-note">* Baseline entries are auto-estimated and may not reflect a real recorded event.</div>
    <div>${_escHtml(storeName)} · Generated ${_escHtml(now)}</div>
  </div>
</div>
</body>
</html>`;

    const win = window.open('', '_blank');
    if (!win) { showToast('⚠️ Popup blocked — please allow popups for this site.', true); return; }
    win.document.write(html);
    win.document.close();
    showToast('🖨️ PDF preview opened — use Print → Save as PDF.');
}

// =========================================================================
// RULE 3: OPENING STOCK BASELINE — saveProductFormData
// =========================================================================
function saveProductFormData() {
    if (!db) { showToast('⚠️ Database not ready.', true); return; }

    const nameEl      = document.getElementById('prodNameInput');
    const codeEl      = document.getElementById('prodCodeInput');
    const priceEl     = document.getElementById('prodPriceInput');
    const stockEl     = document.getElementById('prodStockInput');
    const openStockEl = document.getElementById('prodOpeningStockInput');
    const genericEl   = document.getElementById('prodGenericInput');
    const companyEl   = document.getElementById('prodCompanyInput');
    const supplierEl  = document.getElementById('prodSupplierInput');
    const packEl      = document.getElementById('prodPackInput');

    const name         = (nameEl    ? nameEl.value.trim()    : '');
    const code         = (codeEl    ? codeEl.value.trim().toUpperCase() : '');
    const unitPrice    = parseFloat(priceEl ? priceEl.value : '0') || 0;
    const stock        = parseInt(stockEl ? stockEl.value : '0', 10) || 0;
    const openingStock = Number(openStockEl ? openStockEl.value : '') || Number(stockEl ? stockEl.value : '') || 0;
    const generic      = (genericEl  ? genericEl.value.trim()  : '');
    const company      = (companyEl  ? companyEl.value.trim()  : '');
    const supplier     = (supplierEl ? supplierEl.value.trim() : '');
    const packDetails  = (packEl     ? packEl.value.trim()     : '');

    if (!name || name.length < 2) { showToast('❌ Product name must be at least 2 characters.', true); return; }
    if (!code)                     { showToast('❌ Product code is required.', true); return; }
    if (unitPrice <= 0)            { showToast('❌ Unit price must be greater than 0.', true); return; }

    // Determine current version for upsert (increment on edit, 1 on new)
    const existingInMem = Array.isArray(masterInventoryDB) ? masterInventoryDB.find(p => p.code === code) : null;
    const nextVersion   = existingInMem && typeof existingInMem.version === 'number'
        ? existingInMem.version + 1 : 1;

    const productRecord = {
        code,
        name,
        unitPrice:  parseFloat(unitPrice.toFixed(2)),
        stock:      parseInt(stock, 10),
        generic,
        company,
        supplier,
        packDetails,
        version:    nextVersion
    };

    try {
        const checkTx    = db.transaction(['inventory'], 'readonly');
        const checkStore = checkTx.objectStore('inventory');
        const checkReq   = checkStore.get(code);

        checkReq.onsuccess = function(ev) {
            const existingRecord = ev.target.result;
            const isNewProduct   = !existingRecord;

            const existingInMemory = Array.isArray(masterInventoryDB)
                ? masterInventoryDB.findIndex(p => p.code === code)
                : -1;
            if (existingInMemory >= 0) {
                masterInventoryDB[existingInMemory] = productRecord;
            } else {
                if (!Array.isArray(masterInventoryDB)) masterInventoryDB = [];
                masterInventoryDB.push(productRecord);
            }

            saveInventoryToDB(masterInventoryDB);

            if (isNewProduct) {
                const openingQty = Number(openingStock) || Number(stock) || 0;
                _recordInvMovement(code, openingQty, 'OPENING', 'BASELINE', 'Initial baseline stock configuration', openingQty);
            }

            if (_invReady) renderInventoryView(); else showInventoryPlaceholder();
            closeProductModal();
            showToast('✅ Product ' + (isNewProduct ? 'added' : 'updated') + ': ' + _escHtml(name));
            updateHdrStats();
        };

        checkReq.onerror = function() { showToast('⚠️ Error checking existing product record.', true); };
    } catch(e) {
        showToast('⚠️ Error saving product: ' + _escHtml(String(e.message || e)), true);
    }
}

// =========================================================================
// PRODUCT MODAL
// =========================================================================
let _editingProductCode = null;

function openAddProductModal() {
    _editingProductCode = null;
    const modal = document.getElementById('productModal');
    if (!modal) return;
    document.getElementById('productModalTitle').textContent       = 'Add New Product';
    document.getElementById('prodNameInput').value                 = '';
    document.getElementById('prodCodeInput').value                 = '';
    document.getElementById('prodCodeInput').readOnly              = false;
    document.getElementById('prodPriceInput').value                = '';
    document.getElementById('prodStockInput').value                = '';
    document.getElementById('prodOpeningStockInput').value         = '';
    document.getElementById('prodGenericInput').value              = '';
    document.getElementById('prodCompanyInput').value              = '';
    document.getElementById('prodSupplierInput').value             = '';
    document.getElementById('prodPackInput').value                 = '';
    modal.classList.add('visible');
    setTimeout(function() { const nameEl = document.getElementById('prodNameInput'); if (nameEl) nameEl.focus(); }, 80);
}

function openEditProductModal(productCode) {
    const item = Array.isArray(masterInventoryDB) ? masterInventoryDB.find(p => p.code === productCode) : null;
    if (!item) { showToast('❌ Product not found.', true); return; }
    _editingProductCode = productCode;
    const modal = document.getElementById('productModal');
    if (!modal) return;
    document.getElementById('productModalTitle').textContent       = 'Edit Product';
    document.getElementById('prodNameInput').value                 = item.name        || '';
    document.getElementById('prodCodeInput').value                 = item.code        || '';
    document.getElementById('prodCodeInput').readOnly              = true;
    document.getElementById('prodPriceInput').value                = (Number(item.unitPrice) || 0).toFixed(2);
    document.getElementById('prodStockInput').value                = Number(item.stock) || 0;
    document.getElementById('prodOpeningStockInput').value         = '';
    document.getElementById('prodGenericInput').value              = item.generic     || '';
    document.getElementById('prodCompanyInput').value              = item.company     || '';
    document.getElementById('prodSupplierInput').value             = item.supplier    || '';
    document.getElementById('prodPackInput').value                 = item.packDetails || '';
    modal.classList.add('visible');
}

function closeProductModal() {
    const modal = document.getElementById('productModal');
    if (modal) modal.classList.remove('visible');
    _editingProductCode = null;
}

function deleteProductFromCatalogue(productCode) {
    if (!productCode) return;
    showConfirmModal(
        'Delete product ' + _escHtml(productCode) + '?\nThis removes it from the catalogue but keeps movement history.',
        function() {
            masterInventoryDB = (masterInventoryDB || []).filter(p => p.code !== productCode);
            saveInventoryToDB(masterInventoryDB);
            if (_invReady) renderInventoryView(); else showInventoryPlaceholder();
            showToast('🗑 Product ' + _escHtml(productCode) + ' deleted.');
            updateHdrStats();
        },
        null, 'Delete', true
    );
}
// window.PharmaInventoryEngine is defined earlier in this file (above the
// Inventory View section) — do not redefine here to avoid overwriting the
// structuredClone-based getInMemoryCache and writeStockToCache gateway.

// =========================================================================
// CSV IMPORT — Strict Schema Contract Enforcement
//
// Canonical CSV header → IDB field contract:
//   "Product Code"   → code         (required — row skipped if missing)
//   "Product Name"   → name         (required — row skipped if missing)
//   "Retail Price"   → unitPrice    (Float)
//   "Stock Quantity" → stock        (Int)
//   "Generic Detail" → generic      (String)
//   "Manufacturer"   → company      (String)
//   "Supplier"       → supplier     (String)
//   "Pack Size"      → packDetails  (String)
//
// Any unrecognised column is silently ignored.
// A missing required column aborts the import with a visible toast.
// =========================================================================
(function _initCsvImportListener() {
    // ── Candela RMS exact column headers (as exported from Inventory Snapshot Report)
    // 'quantity'          — Candela's live qty column (primary stock source)
    // 'manufacture'       — Candela spells it without 'r' (verified from export)
    // 'conversion factor' — Candela's pack/unit size column (maps to packDetails)
    // Legacy aliases ('stock quantity', 'manufacturer', 'pack size') are kept so
    // any previously exported CSVs with those headers continue to import cleanly.
    const _CSV_COL_MAP = {
        'product code':      'code',
        'product name':      'name',
        'retail price':      'unitPrice',
        'quantity':          'stock',         // Candela RMS primary
        'stock quantity':    'stock',         // legacy alias
        'generic detail':    'generic',
        'manufacture':       'company',       // Candela RMS (no trailing 'r')
        'manufacturer':      'company',       // legacy alias
        'supplier':          'supplier',
        'conversion factor': 'packDetails',  // Candela RMS pack/unit size
        'pack size':         'packDetails'   // legacy alias
    };

    function _splitCsvRow(line) {
        const cols = [];
        let cur = '', inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
                else inQuote = !inQuote;
            } else if (ch === ',' && !inQuote) {
                cols.push(cur.trim()); cur = '';
            } else {
                cur += ch;
            }
        }
        cols.push(cur.trim());
        return cols;
    }

    function _doCSVParse(text) {
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
        if (lines.length < 2) {
            showToast('⚠️ CSV appears empty or has no data rows.', true);
            return;
        }

        const rawHeaders = _splitCsvRow(lines[0]).map(function(h) {
            return h.replace(/^"|"$/g, '').trim().toLowerCase();
        });

        const colIndex = {};
        rawHeaders.forEach(function(h, i) {
            if (_CSV_COL_MAP[h]) colIndex[_CSV_COL_MAP[h]] = i;
        });

        if (!('code' in colIndex) || !('name' in colIndex)) {
            showToast('❌ CSV must have "Product Code" and "Product Name" columns.', true);
            return;
        }

        const imported = [];
        const skipped  = [];

        for (let r = 1; r < lines.length; r++) {
            const line = lines[r].trim();
            if (!line) continue;
            const cols = _splitCsvRow(line);

            const code = (colIndex.code !== undefined ? cols[colIndex.code] || '' : '').toUpperCase().trim();
            const name = (colIndex.name !== undefined ? cols[colIndex.name] || '' : '').trim();
            if (!code || !name) { skipped.push(r + 1); continue; }

            const unitPrice   = parseFloat(colIndex.unitPrice   !== undefined ? cols[colIndex.unitPrice]   || '0' : '0') || 0;
            const stock       = parseInt(  colIndex.stock       !== undefined ? cols[colIndex.stock]        || '0' : '0', 10) || 0;
            const generic     = (colIndex.generic     !== undefined ? cols[colIndex.generic]     || '' : '').trim();
            const company     = (colIndex.company     !== undefined ? cols[colIndex.company]     || '' : '').trim();
            const supplier    = (colIndex.supplier    !== undefined ? cols[colIndex.supplier]    || '' : '').trim();
            const packDetails = (colIndex.packDetails !== undefined ? cols[colIndex.packDetails] || '' : '').trim();

            const existingItem = Array.isArray(window.masterInventoryDB)
                ? window.masterInventoryDB.find(function(p) { return p.code === code; })
                : null;

            imported.push({
                code,
                name,
                unitPrice:   parseFloat(unitPrice.toFixed(2)),
                stock:       stock,
                generic:     generic,
                company:     company,
                supplier:    supplier,
                packDetails: packDetails,
                version: existingItem && typeof existingItem.version === 'number'
                    ? existingItem.version + 1 : 1
            });
        }

        if (imported.length === 0) {
            showToast('⚠️ No valid products found in CSV.' + (skipped.length ? ' (' + skipped.length + ' rows skipped.)' : ''), true);
            return;
        }

        // FIX (CSV Merge): merge/upsert imported rows into existing inventory
        // instead of overwriting — preserves stock for items not in CSV,
        // and preserves company/supplier for existing items when CSV lacks those columns.
        const _existingDB = Array.isArray(window.masterInventoryDB) ? window.masterInventoryDB : [];
        const _importMap = new Map(imported.map(item => [item.code, item]));
        // Overwrite existing items with imported data; keep items not in CSV
        const _mergedDB = _existingDB.map(existing => {
            const incoming = _importMap.get(existing.code);
            if (incoming) {
                // Merge: incoming wins for all fields it provides; preserve
                // company/supplier if CSV did not include those columns
                return Object.assign({}, existing, incoming,
                    { company:  incoming.company  || existing.company  || '',
                      supplier: incoming.supplier || existing.supplier || '' });
            }
            return existing; // not in CSV — keep as-is
        });
        // Add brand-new items from CSV that did not exist locally
        const _existingCodes = new Set(_existingDB.map(p => p.code));
        imported.filter(item => !_existingCodes.has(item.code)).forEach(item => _mergedDB.push(item));
        const _newCount = _mergedDB.length - _existingDB.length;
        const _updCount = imported.length - _newCount;
        window.masterInventoryDB = _mergedDB;
        try {
            saveInventoryToDB(window.masterInventoryDB);
            // Mark local inventory as dirty so the automatic startup cloud pull
            // cannot silently overwrite this freshly-imported data.
            try { localStorage.setItem('_pharma_inv_dirty', 'true'); } catch(_e) {}
            const demoBanner = document.getElementById('demoInventoryBanner');
            if (demoBanner) demoBanner.classList.remove('visible');
            if (typeof _invReady !== 'undefined' && _invReady) renderInventoryView();
            else if (typeof showInventoryPlaceholder === 'function') showInventoryPlaceholder();
            if (typeof updateHdrStats === 'function') updateHdrStats();
            const skipNote = skipped.length ? ' (' + skipped.length + ' rows skipped)' : '';
            showToast('✅ CSV imported: ' + _updCount + ' updated, ' + _newCount + ' new products.' + skipNote);
            // Show "Push Inventory to Cloud" popup so the user can decide
            // whether to replace the cloud catalogue with this import.
            _showPostCsvPushPopup(_updCount + _newCount);
        } catch(e) {
            showToast('⚠️ Error saving imported inventory: ' + (typeof _escHtml === 'function' ? _escHtml(String(e.message || e)) : String(e.message || e)), true);
        }
    }

    function _attachCsvListener() {
        const csvEl = document.getElementById('csvFile');
        if (!csvEl) return;
        csvEl.addEventListener('change', function(ev) {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            ev.target.value = ''; // reset so same file can trigger again
            const reader = new FileReader();
            reader.onload = function(e) {
                try { _doCSVParse(e.target.result || ''); }
                catch(err) {
                    showToast('❌ CSV parse error: ' +
                        (typeof _escHtml === 'function' ? _escHtml(String(err.message || err)) : String(err)), true);
                }
            };
            reader.onerror = function() { showToast('❌ Could not read the CSV file.', true); };
            reader.readAsText(file, 'utf-8');
        });
    }

})();
// =========================================================================
// BASE CATALOG LOADER — loads the bundled master product list shipped with
// the app (data/base-inventory.json) on demand. This file is committed to
// the repo so the full product catalog travels with the app/GitHub Pages
// deploy, but it is never loaded automatically — only when the operator
// explicitly triggers it from Data Hub → Load Base Catalog. Uses the same
// merge/upsert semantics as CSV import: existing items are updated in
// place, items not present in the base file are left untouched, and new
// items are appended.
// =========================================================================
async function loadBaseInventoryData() {
    showToast('⏳ Loading base product catalog…', false);
    let data;
    try {
        const url = new URL('data/base-inventory.json', document.baseURI).toString();
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
    } catch (e) {
        showToast('❌ Could not load base catalog: ' + (e && e.message ? e.message : String(e)), true);
        return;
    }

    if (!Array.isArray(data) || data.length === 0) {
        showToast('⚠️ Base catalog file was empty or invalid.', true);
        return;
    }

    // Loading the base catalog is a "start fresh" operation: purge whatever
    // local inventory/movement data already exists first, so the base
    // catalog becomes the sole source of truth rather than being merged
    // on top of old/stale records.
    try {
        if (typeof _purgeLocalInventoryData === 'function') _purgeLocalInventoryData();
    } catch (_e) {}
    window.masterInventoryDB = [];

    const imported = data.map(function(item) {
        const code = String(item.code || '').toUpperCase().trim();
        return {
            code,
            name: String(item.name || '').trim(),
            unitPrice: parseFloat((Number(item.unitPrice) || 0).toFixed(2)),
            stock: parseInt(item.stock, 10) || 0,
            generic: String(item.generic || '').trim(),
            company: String(item.company || '').trim(),
            supplier: String(item.supplier || '').trim(),
            packDetails: String(item.packDetails || '').trim(),
            version: 1
        };
    }).filter(function(item) { return item.code && item.name; });

    if (imported.length === 0) {
        showToast('⚠️ No valid products found in base catalog.', true);
        return;
    }

    window.masterInventoryDB = imported;
    try {
        saveInventoryToDB(window.masterInventoryDB);
        try { localStorage.setItem('_pharma_inv_dirty', 'true'); } catch(_e) {}
        const demoBanner = document.getElementById('demoInventoryBanner');
        if (demoBanner) demoBanner.classList.remove('visible');
        if (typeof _invReady !== 'undefined' && _invReady) renderInventoryView();
        else if (typeof showInventoryPlaceholder === 'function') showInventoryPlaceholder();
        if (typeof updateHdrStats === 'function') updateHdrStats();
        showToast('✅ Base catalog loaded fresh: ' + imported.length + ' products (previous inventory purged).');
        if (typeof _showPostCsvPushPopup === 'function') _showPostCsvPushPopup(imported.length);
    } catch(e) {
        showToast('⚠️ Error saving base catalog: ' + (e && e.message ? e.message : String(e)), true);
    }
}
window.loadBaseInventoryData = loadBaseInventoryData;
// =========================================================================
// POST-CSV IMPORT — Push Inventory to Cloud popup
// =========================================================================
function _showPostCsvPushPopup(itemCount) {
    // Remove any existing popup
    const _existing = document.getElementById('postCsvPushModal');
    if (_existing) _existing.remove();

    const modal = document.createElement('div');
    modal.id = 'postCsvPushModal';
    modal.innerHTML = `
<style>
#postCsvPushModal .pcpm-overlay{position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:9990;display:flex;align-items:center;justify-content:center;padding:16px;}
#postCsvPushModal .pcpm-card{background:#fff;width:100%;max-width:400px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;animation:pcpm-in .2s ease;}
@keyframes pcpm-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
#postCsvPushModal .pcpm-hdr{padding:16px 20px 14px;background:linear-gradient(135deg,#0f4c75,#1a6e9e);color:#fff;display:flex;align-items:center;gap:10px;}
#postCsvPushModal .pcpm-hdr-icon{font-size:24px;line-height:1;}
#postCsvPushModal .pcpm-hdr-title{font-size:15px;font-weight:900;line-height:1.2;}
#postCsvPushModal .pcpm-hdr-sub{font-size:10px;color:rgba(255,255,255,.7);margin-top:2px;}
#postCsvPushModal .pcpm-body{padding:18px 20px 14px;}
#postCsvPushModal .pcpm-info{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 13px;font-size:11px;color:#0369a1;line-height:1.6;margin-bottom:14px;}
#postCsvPushModal .pcpm-warn{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 13px;font-size:11px;color:#92400e;line-height:1.6;margin-bottom:16px;}
#postCsvPushModal .pcpm-actions{display:flex;flex-direction:column;gap:8px;}
#postCsvPushModal .pcpm-btn-push{width:100%;padding:12px 16px;background:linear-gradient(135deg,#0f4c75,#1a6e9e);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:opacity .15s;}
#postCsvPushModal .pcpm-btn-push:hover{opacity:.88;}
#postCsvPushModal .pcpm-btn-skip{width:100%;padding:9px 16px;background:#f1f5f9;color:#64748b;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;}
#postCsvPushModal .pcpm-btn-skip:hover{background:#e2e8f0;}
</style>
<div class="pcpm-overlay" onclick="if(event.target===this)document.getElementById('postCsvPushModal')?.remove()">
  <div class="pcpm-card">
    <div class="pcpm-hdr">
      <span class="pcpm-hdr-icon">📦</span>
      <div>
        <div class="pcpm-hdr-title">CSV Imported Successfully</div>
        <div class="pcpm-hdr-sub">\${itemCount} product\${itemCount !== 1 ? 's' : ''} loaded into local inventory</div>
      </div>
    </div>
    <div class="pcpm-body">
      <div class="pcpm-info">
        Push this inventory to the cloud to make it available on <b>all devices</b> (Master &amp; Client). Every device syncs inventory from the cloud on startup.
      </div>
      <div class="pcpm-warn">
        ⚠️ This will <b>replace</b> the cloud inventory catalogue for all counters. Current cloud stock will be overwritten.
      </div>
      <div class="pcpm-actions">
        <button class="pcpm-btn-push" onclick="
          document.getElementById('postCsvPushModal')?.remove();
          if(typeof forcePushInventoryToCloud==='function') forcePushInventoryToCloud();
          else if(typeof showToast==='function') showToast('❌ Push function not loaded yet.', true);
        ">
          ☁️ Push Inventory to Cloud
        </button>
        <button class="pcpm-btn-skip" onclick="document.getElementById('postCsvPushModal')?.remove()">
          Skip for now — push later via Force Sync
        </button>
      </div>
    </div>
  </div>
</div>
`;
    document.body.appendChild(modal);
}
window._showPostCsvPushPopup = _showPostCsvPushPopup;

// Note: CSV file input listener is registered in settings.js (_handleCSVImport).
// The _attachCsvListener inside this module is intentionally not auto-invoked to
// prevent double-processing when both modules are loaded on the same page.

// =========================================================================
// PURGE INVENTORY DATA — Password-protected local data wipe
// =========================================================================
// =========================================================================
// DELETE ZERO / EMPTY STOCK ITEMS
// Removes all products with stock <= 0 from IDB, in-memory cache, and
// Supabase cloud in one operation.  Safe to run at any time — movement
// history is preserved (inventory_movements is untouched).
// =========================================================================
async function deleteZeroStockItems() {
    const all     = (window.masterInventoryDB || []);
    const toKeep  = all.filter(p => (Number(p.stock) || 0) > 0);
    const toDelete = all.filter(p => (Number(p.stock) || 0) <= 0);
    const count   = toDelete.length;

    if (count === 0) {
        showToast('✅ No zero-stock items found — catalogue is clean.');
        return;
    }

    showConfirmModal(
        {
            title:    '🧹 Delete ' + count.toLocaleString() + ' Zero-Stock Items?',
            subtitle: 'Products with stock = 0 will be removed from catalogue & cloud. Movement history is kept.'
        },
        async function() {
            // ── 1. Update in-memory + IDB ──────────────────────────────────
            saveInventoryToDB(toKeep);
            showToast('⏳ Removing ' + count.toLocaleString() + ' items locally…');

            // ── 2. Delete from Supabase cloud in batches ───────────────────
            if (typeof _dbDelete === 'function') {
                // Use stock filter — deletes all rows where stock <= 0
                const { error } = await _dbDelete('inventory', 'stock=lte.0');
                if (error) {
                    console.warn('[ZeroStockClean] Cloud delete partial error:', error);
                    showToast('⚠️ Local cleaned. Cloud delete had an error — re-sync to finish.', true);
                } else {
                    showToast('✅ ' + count.toLocaleString() + ' zero-stock items removed (local + cloud).');
                }
            } else {
                showToast('✅ ' + count.toLocaleString() + ' zero-stock items removed locally.');
            }

            // ── 3. Refresh UI ──────────────────────────────────────────────
            if (typeof updateHdrStats === 'function') updateHdrStats();
            if (_invReady && typeof renderInventoryView === 'function') {
                renderInventoryView();
            } else if (typeof showInventoryPlaceholder === 'function') {
                showInventoryPlaceholder();
            }

            // ── 4. Audit log ───────────────────────────────────────────────
            if (typeof _auditWrite === 'function') {
                _auditWrite('INVENTORY', 'Deleted ' + count + ' zero-stock items from catalogue + cloud.');
            }
        },
        null, 'Delete ' + count.toLocaleString() + ' Items', true
    );
}

function openPurgeInventoryModal() {
    let modal = document.getElementById('purgeInventoryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'purgeInventoryModal';
        modal.innerHTML = `
<style>
.purge-overlay{position:fixed;inset:0;background:rgba(15,23,42,.8);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;}
.purge-card{background:#fff;width:100%;max-width:420px;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;}
.purge-hdr{padding:16px 20px;background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;display:flex;align-items:center;justify-content:space-between;}
.purge-title{font-size:16px;font-weight:900;}
.purge-close{background:rgba(255,255,255,.2);color:#fff;border:none;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;}
.purge-body{padding:20px;}
.purge-warn{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;padding:12px 14px;border-radius:8px;font-size:12px;line-height:1.6;margin-bottom:16px;}
.purge-input{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;margin-bottom:14px;box-sizing:border-box;}
.purge-actions{display:flex;gap:8px;justify-content:flex-end;}
.purge-btn{padding:9px 16px;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;}
.purge-btn-ghost{background:#f1f5f9;color:#475569;}
.purge-btn-danger{background:#dc2626;color:#fff;}
.purge-btn-danger:hover{background:#991b1b;}
.purge-status{font-size:12px;color:#64748b;margin-top:10px;min-height:20px;}
</style>
<div class="purge-overlay" onclick="if(event.target===this)closePurgeInventoryModal()">
  <div class="purge-card">
    <div class="purge-hdr">
      <div class="purge-title">🗑 Purge Inventory Data</div>
      <button class="purge-close" onclick="closePurgeInventoryModal()">×</button>
    </div>
    <div class="purge-body">
      <div class="purge-warn">
        <b>⚠️ This action cannot be undone.</b> All local inventory records, movements, and stock data will be permanently deleted.
      </div>
      <input 
        type="password" 
        id="purgePasswordInput" 
        class="purge-input" 
        placeholder="Enter master password" 
        onkeypress="if(event.key==='Enter')_executePurgeInventory()">
      <div class="purge-actions">
        <button class="purge-btn purge-btn-ghost" onclick="closePurgeInventoryModal()">Cancel</button>
        <button class="purge-btn purge-btn-danger" onclick="_executePurgeInventory()">Purge All Data</button>
      </div>
      <div class="purge-status" id="purgeStatus"></div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = '';
    document.getElementById('purgePasswordInput').focus();
}

function closePurgeInventoryModal() {
    const m = document.getElementById('purgeInventoryModal');
    if (m) m.style.display = 'none';
    const inp = document.getElementById('purgePasswordInput');
    if (inp) inp.value = '';
}

async function _executePurgeInventory() {
    const passwordInput = document.getElementById('purgePasswordInput');
    const statusEl = document.getElementById('purgeStatus');
    
    if (!passwordInput || !passwordInput.value.trim()) {
        if (statusEl) { statusEl.textContent = '❌ Password required.'; statusEl.style.color = '#dc2626'; }
        return;
    }
    
    const enteredPassword = passwordInput.value.trim();
    
    // Use the SAME verification logic as the rest of the app (auth.js _verifyPassword):
    // salted hash ('FDPP_v1_' + password), localStorage fallback, and the
    // zero-setup default of 12345678 when no password has ever been set.
    // (Previously this duplicated a plain, unsalted SHA-256 check with no
    // default-password fallback, which is why a correct 12345678 entry was
    // rejected as "Invalid password" in offline mode.)
    let isValid = false;
    try {
        if (typeof _verifyPassword === 'function') {
            isValid = await _verifyPassword(enteredPassword);
        } else {
            // Extremely defensive fallback in case auth.js failed to load
            isValid = enteredPassword === '12345678';
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ Password verification failed.'; statusEl.style.color = '#dc2626'; }
        return;
    }
    
    if (!isValid) {
        if (statusEl) { statusEl.textContent = '❌ Invalid password.'; statusEl.style.color = '#dc2626'; }
        showToast('❌ Invalid master password. Purge cancelled.', true);
        return;
    }
    
    // Password valid — proceed with purge
    if (statusEl) { statusEl.textContent = 'Purging…'; statusEl.style.color = '#64748b'; }
    
    try {
        // Call CentralSyncHub equivalent (or directly purge local inventory)
        if (typeof CentralSyncHub !== 'undefined' && typeof CentralSyncHub.purgeAllLocalData === 'function') {
            await CentralSyncHub.purgeAllLocalData();
        } else {
            // Fallback: manually purge inventory data
            _purgeLocalInventoryData();
        }
        
        if (statusEl) { statusEl.textContent = '✅ Inventory purged successfully.'; statusEl.style.color = '#059669'; }
        showToast('✅ All inventory data has been purged.', false);
        closePurgeInventoryModal();
        setTimeout(() => { location.reload(); }, 1500);
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ Purge failed: ' + (e.message || 'Unknown error'); statusEl.style.color = '#dc2626'; }
        showToast('❌ Purge failed: ' + (e.message || 'Unknown error'), true);
    }
}

function _purgeLocalInventoryData() {
    // Clear IndexedDB inventory stores
    if (typeof db !== 'undefined' && db) {
        try {
            db.transaction(['inventory'], 'readwrite').objectStore('inventory').clear();
            db.transaction(['inventory_movements'], 'readwrite').objectStore('inventory_movements').clear();
        } catch (_e) {}
    }
    
    // Reset in-memory cache
    if (typeof masterInventoryDB !== 'undefined') {
        masterInventoryDB = [];
    }
    
    // Clear inventory-related localStorage keys
    const keysToRemove = [
        'pharma_inv_counter',
        'pharma_cloud_inventory',
        'pharma_applied_mov_ids'
    ];
    keysToRemove.forEach(k => {
        try { localStorage.removeItem(k); } catch (_e) {}
    });
}

// =========================================================================
// PHASE 4 — SUPABASE INVENTORY TABLE: BOOTSTRAP PUSH + CLIENT PULL
//
// Column mapping (IDB ↔ Supabase inventory table):
//   IDB field      Supabase column    Notes
//   ─────────────  ─────────────────  ───────────────────────────────────
//   code           code               PK — unchanged
//   name           name
//   generic        generic_name
//   packDetails    pack_size
//   unitPrice      unit_price
//   stock          stock
//   version        version
//   _DEVICE_UUID   uploaded_by        FK → devices.uuid
//   (now)          uploaded_at / updated_at
//
// KNOWN GAP: 'company' (Manufacture) and 'supplier' columns exist in local
// IDB but have NO matching column in the Phase 1 Supabase inventory schema.
// They are preserved in IndexedDB only and will NOT sync across devices.
// These fields will be available in the app UI but invisible to other devices.
// Resolution: extend the inventory table schema in a future phase, or accept
// them as local-only metadata. Flagged here for Phase 9 / schema review.
// =========================================================================

/**
 * Map a local IDB inventory record to the Supabase inventory table row shape.
 * NOTE: 'company' and 'supplier' are intentionally excluded — see KNOWN GAP above.
 */
function _idbRowToSupabaseRow(item) {
    const now = new Date().toISOString();
    return {
        code:         item.code,
        name:         item.name         || '',
        generic_name: item.generic      || '',
        pack_size:    item.packDetails  || '',
        unit_price:   parseFloat((Number(item.unitPrice) || 0).toFixed(2)),
        stock:        parseInt(item.stock, 10) || 0,
        version:      (typeof item.version === 'number' && item.version >= 1) ? item.version : 1,
        uploaded_by:  _DEVICE_UUID,
        uploaded_at:  now,
        updated_at:   now
    };
}

/**
 * Map a Supabase inventory table row back to the local IDB record shape.
 * 'company' and 'supplier' are cleared on pull (not stored in Supabase).
 */
function _supabaseRowToIdbRow(row) {
    return {
        code:        row.code,
        name:        row.name         || '',
        generic:     row.generic_name || '',
        company:     '',               // not in Supabase schema — see KNOWN GAP
        supplier:    '',               // not in Supabase schema — see KNOWN GAP
        packDetails: row.pack_size    || '',
        unitPrice:   parseFloat((Number(row.unit_price) || 0).toFixed(2)),
        stock:       parseInt(row.stock, 10) || 0,
        version:     (typeof row.version === 'number' && row.version >= 1) ? row.version : 1
    };
}

/**
 * Push the full inventory to the Supabase `inventory` table.
 * Master device only. One-time bootstrap — blocked after the
 * `inventory_bootstrap_done` flag is set in the `settings` table.
 * Ongoing stock edits (billing, adjustments) are NOT blocked.
 */
async function _pushInventoryBootstrapToCloud() {
    // ── Master-only guard ─────────────────────────────────────────────────
    const _role = (typeof StorageModule !== 'undefined')
        ? StorageModule.get('pharma_device_role') : null;
    if (_role !== 'master') {
        showToast('ℹ️ Only the master device can bootstrap inventory to cloud.', false);
        return;
    }

    const items = Array.isArray(window.masterInventoryDB) ? window.masterInventoryDB : [];
    if (items.length === 0) {
        showToast('⚠️ No inventory to push.', true);
        return;
    }

    // ── One-time-only guard — check settings table ────────────────────────
    const { data: flagRows, error: flagErr } = await _dbSelect(
        'settings',
        'device_uuid=eq.' + encodeURIComponent(_DEVICE_UUID) + '&key=eq.inventory_bootstrap_done',
        'value'
    );
    if (!flagErr && flagRows && flagRows.length > 0 && flagRows[0].value === 'true') {
        showToast('ℹ️ Inventory already bootstrapped — cloud not overwritten. Delete the bootstrap flag in settings to re-run.', false);
        return;
    }

    // ── Push in batches of 500 (avoids payload / PostgREST limits) ────────
    showToast('⬆️ Bootstrapping inventory to cloud (' + items.length + ' products)…');
    const rows  = items.map(_idbRowToSupabaseRow);
    const BATCH = 500;
    let pushed  = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await _dbUpsert('inventory', batch, 'code');
        if (error) {
            console.error('[Phase4] Inventory bootstrap batch ' + (Math.floor(i / BATCH) + 1) + ' failed:', error);
            showToast('❌ Cloud bootstrap failed at batch ' + (Math.floor(i / BATCH) + 1) + '. ' + error, true);
            return;
        }
        pushed += batch.length;
    }

    // ── Write bootstrap_done flag to settings table ───────────────────────
    const now = new Date().toISOString();
    const { error: flagWriteErr } = await _dbUpsert('settings', [{
        device_uuid: _DEVICE_UUID,
        key:         'inventory_bootstrap_done',
        value:       'true',
        updated_at:  now
    }], 'device_uuid,key');

    if (flagWriteErr) {
        // Push succeeded but flag write failed — warn but don't roll back
        console.warn('[Phase4] bootstrap_done flag write failed:', flagWriteErr);
        showToast('⚠️ Inventory pushed (' + pushed + ' items) but bootstrap flag write failed. Subsequent imports may re-push.', false);
    } else {
        // FIX: also write inventory_last_updated so _checkAndPullInventoryIfUpdated
        // on client devices can detect this push via the 30s heartbeat.
        // Previously only forcePushInventoryToCloud wrote this key, meaning clients
        // only got automatic pulls after CSV-popup pushes, not Force Sync pushes.
        await _dbUpsert('settings', [{
            device_uuid: _DEVICE_UUID,
            key:         'inventory_last_updated',
            value:       now,
            updated_at:  now
        }], 'device_uuid,key').catch(e => {
            console.warn('[Phase4] inventory_last_updated write failed (non-fatal):', e);
        });
        showToast('✅ Inventory bootstrapped to cloud (' + pushed + ' products). Clients will pull on next startup.');
    }
}

/**
 * Pull the full inventory from the Supabase `inventory` table and overwrite
 * local IndexedDB. Called on startup for client devices (always-overwrite).
 *
 * Pull strategy:
 *   1. Find master device UUID from `devices` table.
 *   2. Confirm master has set `inventory_bootstrap_done` flag in `settings`.
 *   3. Fetch all rows from `inventory` table.
 *   4. Map to IDB shape and overwrite local store + in-memory cache.
 */
async function _pullInventoryFromSupabase(force) {
    // ── DIRTY-FLAG GUARD ──────────────────────────────────────────────────
    // If the user has locally imported a CSV (or otherwise modified inventory)
    // and has not yet pushed to cloud, skip automatic pulls so the freshly
    // imported data isn't silently wiped.  Explicit force=true (from manual
    // sync or the Force Sync button) bypasses this guard so the user can
    // always pull when they deliberately choose to.
    if (!force && localStorage.getItem('_pharma_inv_dirty') === 'true') {
        console.info('[Phase4] Skipping auto pull — local inventory has unpushed changes. Push to cloud first, or use Force Sync to pull anyway.');
        return false;
    }

    // ── Step 1: resolve master UUID ───────────────────────────────────────
    const { data: masterRows, error: masterErr } = await _dbSelect(
        'devices',
        'role=eq.master&is_active=eq.true',
        'uuid'
    );
    if (masterErr || !masterRows || masterRows.length === 0) {
        console.info('[Phase4] No active master device found — skipping inventory pull.');
        return false;
    }
    const masterUUID = masterRows[0].uuid;

    // ── Step 2: confirm bootstrap flag exists on master ───────────────────
    // When force=true (manual sync), skip this guard — the user explicitly
    // requested a pull even if the master hasn't set the bootstrap flag yet.
    if (!force) {
        const { data: flagRows } = await _dbSelect(
            'settings',
            'device_uuid=eq.' + encodeURIComponent(masterUUID) + '&key=eq.inventory_bootstrap_done',
            'value'
        );
        if (!flagRows || flagRows.length === 0 || flagRows[0].value !== 'true') {
            console.info('[Phase4] Master has not bootstrapped inventory yet — skipping pull.');
            return false;
        }
    }

    // ── Step 3: fetch ALL inventory rows (paginated — bypasses PostgREST 1000-row default limit)
    const { data: invRows, error: invErr } = await _dbSelectAll('inventory', '', '*');
    if (invErr) {
        console.warn('[Phase4] Inventory pull error:', invErr);
        showToast('⚠️ Cloud inventory pull failed: ' + invErr, true);
        return false;
    }
    if (!invRows || invRows.length === 0) {
        console.info('[Phase4] Cloud inventory table is empty — skipping overwrite.');
        return false;
    }

    // ── Step 4: map, overwrite IDB + in-memory cache ─────────────────────
    const mapped = invRows.map(_supabaseRowToIdbRow);
    window.masterInventoryDB = mapped;
    saveInventoryToDB(mapped);
    // Clear dirty flag — local is now in sync with cloud
    try { localStorage.removeItem('_pharma_inv_dirty'); } catch(_e) {}

    const demoBanner = document.getElementById('demoInventoryBanner');
    if (demoBanner) demoBanner.classList.remove('visible');
    if (typeof updateHdrStats === 'function') updateHdrStats();
    if (typeof _invReady !== 'undefined' && _invReady && typeof renderInventoryView === 'function') {
        renderInventoryView();
    } else if (typeof showInventoryPlaceholder === 'function') {
        showInventoryPlaceholder();
    }

    showToast('☁️ Inventory loaded from cloud (' + mapped.length + ' products).', false);
    return true;
}

// =========================================================================
// HEARTBEAT PULL — called every 30 s by syncHub.js background timer.
// Checks whether the master has pushed a newer inventory catalogue since
// our last pull, and calls _pullInventoryFromSupabase() if so.
//
// Design:
//   - Master devices: no-op (they are the source of truth, they push).
//   - Client devices: reads inventory_last_updated from the Supabase
//     settings table; compares against _pharma_inv_pull_ts in localStorage;
//     pulls only when cloud timestamp is strictly newer.
//   - Dirty-flag guard: if the user has locally imported a CSV that hasn't
//     been pushed yet, skip — _pullInventoryFromSupabase also checks this,
//     but checking here avoids an unnecessary round-trip.
//   - All errors are swallowed; this is a best-effort background operation.
// =========================================================================
async function _checkAndPullInventoryIfUpdated() {
    try {
        const role = (typeof StorageModule !== 'undefined')
            ? StorageModule.get('pharma_device_role') : null;
        // Master is the source of truth — never auto-pull
        if (role === 'master') return false;
        // Skip if there are unpushed local changes
        if (localStorage.getItem('_pharma_inv_dirty') === 'true') return false;
        if (typeof _dbSelect !== 'function') return false;

        // Read the most recently written inventory_last_updated signal from any device.
        // Only master devices write this key (via forcePushInventoryToCloud /
        // _pushInventoryBootstrapToCloud), so this is always the master's timestamp.
        const { data, error } = await _dbSelect(
            'settings',
            'key=eq.inventory_last_updated&order=updated_at.desc&limit=1',
            'value'
        );
        if (error || !Array.isArray(data) || data.length === 0) return false;
        const cloudTs = data[0].value;
        if (!cloudTs) return false;

        // Compare with the timestamp we recorded on our last successful pull
        const localTs = (typeof StorageModule !== 'undefined')
            ? StorageModule.get('_pharma_inv_pull_ts') : null;
        if (localTs && cloudTs <= localTs) return false; // Already up to date

        // Cloud has a newer catalogue — pull it
        if (typeof _pullInventoryFromSupabase !== 'function') return false;
        const result = await _pullInventoryFromSupabase(false);
        if (result !== false) {
            // Record the cloud timestamp so we don't re-pull on the next heartbeat
            try { StorageModule.set('_pharma_inv_pull_ts', cloudTs); } catch(_e) {}
            return true;
        }
    } catch(_e) { /* heartbeat — swallow all errors silently */ }
    return false;
}
window._checkAndPullInventoryIfUpdated = _checkAndPullInventoryIfUpdated;

// =========================================================================
// INVENTORY ↔ CLOUD — dedicated push / pull (inventory only)
// Used by the Push / Pull buttons in the Inventory toolbar.
// =========================================================================
async function pushInventoryToCloud() {
    if (typeof _supaSet !== 'function') {
        showToast('❌ Cloud module not loaded.', true);
        return;
    }
    if (!Array.isArray(window.masterInventoryDB)) {
        showToast('⚠️ Inventory not yet loaded.', true);
        return;
    }
    showToast('⬆️ Pushing inventory to cloud…');
    if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('syncing');
    try {
        const payload = JSON.stringify(window.masterInventoryDB);
        const ok = await _supaSet('pharma_cloud_inventory', payload);
        if (!ok) throw new Error('Cloud write rejected');

        // Local inventory is now in sync with cloud — clear the dirty flag so
        // future startup pulls are allowed to merge server-side changes.
        try { localStorage.removeItem('_pharma_inv_dirty'); } catch(_e) {}

        try {
            const arr = window.masterInventoryDB;
            if (arr.length > 0) {
                const fp = arr.length + '|' + (arr[0] ? arr[0].code : '') + '|' + (arr[arr.length - 1] ? arr[arr.length - 1].code : '');
                localStorage.setItem('_pharma_inv_fingerprint', fp);
            } else {
                localStorage.removeItem('_pharma_inv_fingerprint');
            }
        } catch(_e) {}

        if (typeof _pushUnsyncedMovements === 'function') {
            try { await _pushUnsyncedMovements(); } catch(_e) {}
        }

        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
        showToast('✅ Inventory pushed (' + window.masterInventoryDB.length + ' items). Other devices will see it on next sync.');
    } catch (e) {
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('offline');
        showToast('❌ Push failed: ' + (e.message || e), true);
    }
}

async function pullInventoryFromCloud() {
    if (typeof _supaGet !== 'function') {
        showToast('❌ Cloud module not loaded.', true);
        return;
    }
    showToast('⬇️ Pulling inventory from cloud…');
    if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('syncing');
    try {
        const raw = await _supaGet('pharma_cloud_inventory');
        if (raw === null || raw === undefined) {
            if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
            showToast('ℹ️ No inventory found in cloud yet.', true);
            return;
        }
        let cloudInv;
        try { cloudInv = JSON.parse(raw); } catch(_e) { throw new Error('Corrupt cloud payload'); }
        if (!Array.isArray(cloudInv)) throw new Error('Cloud inventory is not an array');

        // OVERWRITE local with cloud truth (Pull = authoritative remote state)
        window.masterInventoryDB = cloudInv;
        if (typeof saveInventoryToDB === 'function') saveInventoryToDB(cloudInv);

        try {
            if (cloudInv.length > 0) {
                const fp = cloudInv.length + '|' + (cloudInv[0] ? cloudInv[0].code : '') + '|' + (cloudInv[cloudInv.length - 1] ? cloudInv[cloudInv.length - 1].code : '');
                localStorage.setItem('_pharma_inv_fingerprint', fp);
            } else {
                localStorage.removeItem('_pharma_inv_fingerprint');
            }
        } catch(_e) {}

        if (typeof _invReady !== 'undefined' && _invReady && typeof renderInventoryView === 'function') {
            try { renderInventoryView(); } catch(_e) {}
        }

        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
        showToast('✅ Inventory pulled (' + cloudInv.length + ' items).');
    } catch (e) {
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('offline');
        showToast('❌ Pull failed: ' + (e.message || e), true);
    }
}

// EXPOSE TO GLOBAL WINDOW SO BUTTONS CAN CLICK THEM
window.openPurgeInventoryModal  = openPurgeInventoryModal;
window.deleteZeroStockItems      = deleteZeroStockItems;
window.closePurgeInventoryModal = closePurgeInventoryModal;
window.pushInventoryToCloud     = pushInventoryToCloud;
window.pullInventoryFromCloud   = pullInventoryFromCloud;
// Phase 4 — relational table bootstrap (master push / client pull)
window._pushInventoryBootstrapToCloud = _pushInventoryBootstrapToCloud;
window._pullInventoryFromSupabase     = _pullInventoryFromSupabase;

// ── Clear Demo Stock ──────────────────────────────────────────────────────────
// Removes the three seeded demo items by their known codes.
// Any item the user has added (even with a coincidentally similar code) is safe
// because we match on the exact code+name+company triple to be certain.
const _DEMO_ITEM_CODES = ['P-1002', 'A-5541', 'B-2099'];

window.clearDemoStock = function() {
    if (!Array.isArray(masterInventoryDB)) return;

    // Only remove items that still exactly match the seeded demo records
    const before = masterInventoryDB.length;
    masterInventoryDB = masterInventoryDB.filter(function(item) {
        return !_DEMO_ITEM_CODES.includes(item.code);
    });
    window.masterInventoryDB = masterInventoryDB;

    const removed = before - masterInventoryDB.length;
    if (removed === 0) {
        if (typeof showToast === 'function') showToast('ℹ️ No demo items found — already cleared.', false);
        return;
    }

    // Persist the cleared state and mark as intentionally empty/modified
    try { localStorage.setItem('_pharma_inv_dirty', 'true'); } catch(e) {}
    saveInventoryToDB(masterInventoryDB);

    // Hide the banner
    var banner = document.getElementById('demoInventoryBanner');
    if (banner) banner.classList.remove('visible');

    // Refresh the inventory view if open
    if (typeof renderInventoryView === 'function') {
        try { renderInventoryView(); } catch(e) {}
    }
    if (typeof showInventoryPlaceholder === 'function') {
        try { showInventoryPlaceholder(); } catch(e) {}
    }
    if (typeof updateHdrStats === 'function') updateHdrStats();

    if (typeof showToast === 'function')
        showToast('🗑️ Demo stock cleared (' + removed + ' item' + (removed !== 1 ? 's' : '') + ' removed). Ready for your inventory.', false);
};
