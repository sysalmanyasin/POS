// =========================================================================
// inventory.js — IndexedDB Inventory Engine
// Schema v4 (PharmaInventoryDB)
//   'inventory'           — stock records, keyPath: 'code', carries 'version'
//   'inventory_movements' — append-only delta ledger
//
// BUG 1 FIX:  Invoice edit delta engine — _computeEditDelta() and
//             _applyInvoiceEditDelta() allow billing.js to pass only the
//             mathematical difference between old and new line items.
// BUG 5 FIX:  Strict ledger rule — every stock mutation writes an
//             inventory_movements record AND queues a cloud push immediately.
// =========================================================================
let db;
window.masterInventoryDB = window.masterInventoryDB || [];

const dbRequest = indexedDB.open('PharmaInventoryDB', 4);
dbRequest.onupgradeneeded = function(e) {
    db = e.target.result;
    if (!db.objectStoreNames.contains('inventory'))
        db.createObjectStore('inventory', { keyPath: 'code' });

    let movSt;
    if (!db.objectStoreNames.contains('inventory_movements')) {
        movSt = db.createObjectStore('inventory_movements', { keyPath: 'movementId' });
    } else {
        movSt = e.target.transaction.objectStore('inventory_movements');
    }
    if (!movSt.indexNames.contains('by_code'))   movSt.createIndex('by_code',   'productCode',  { unique: false });
    if (!movSt.indexNames.contains('by_type'))   movSt.createIndex('by_type',   'movementType', { unique: false });
    if (!movSt.indexNames.contains('by_synced')) movSt.createIndex('by_synced', 'synced',       { unique: false });
};
dbRequest.onsuccess = function(e) { db = e.target.result; loadInventoryFromDB(); };
dbRequest.onerror   = function()  { if (typeof showToast === 'function') showToast('⚠️ Inventory database failed to open.', true); };

let _invSaveLock    = false;
let _invSavePending = null;

// =========================================================================
// INVENTORY PERSISTENCE (Write-Through SSOT)
// =========================================================================
function saveInventoryToDB(data) {
    if (!db) return;
    if (_invSaveLock) { _invSavePending = data; return; }
    _doIDBInventoryWrite(data);
}

function _doIDBInventoryWrite(data) {
    _invSaveLock = true;
    if (!Array.isArray(data)) { _invSaveLock = false; _flushPendingInventorySave(); return; }
    try {
        const tx         = db.transaction(['inventory'], 'readwrite');
        const store      = tx.objectStore('inventory');
        const snapshot   = data.filter(item => item && typeof item === 'object' && item.code);
        const validCodes = new Set();
        const _pendingVersions = new Map();

        snapshot.forEach(item => {
            const record = Object.assign({}, item);
            if (typeof record.version !== 'number' || record.version < 1) record.version = 1;
            store.put(record);
            validCodes.add(record.code);
            _pendingVersions.set(record.code, record.version);
        });

        store.getAllKeys().onsuccess = function(ev) {
            (ev.target.result || []).forEach(k => { if (!validCodes.has(k)) store.delete(k); });
        };

        tx.oncomplete = function() {
            if (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB)) {
                _pendingVersions.forEach((version, code) => {
                    const idx = masterInventoryDB.findIndex(p => p.code === code);
                    if (idx >= 0) masterInventoryDB[idx].version = version;
                });
            }
            _invSaveLock = false; _flushPendingInventorySave();
        };
        tx.onerror = function() { _invSaveLock = false; _flushPendingInventorySave(); };
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
// BUG 5 FIX — Strict Inventory Movement Ledger
// EVERY stock count change must:
//   1. Write a movement record to local IDB 'inventory_movements'
//   2. Queue an immediate cloud push to Supabase inventory_movements table
//   3. Record the delta (+X or -X), NEVER absolute final values
// =========================================================================

/**
 * Record a stock movement in the local IDB ledger and queue a cloud push.
 * @param {string} productCode     — medicine code (primary key)
 * @param {number} quantityChange  — signed delta: negative = deduction
 * @param {string} movementType    — 'SALE' | 'REFUND' | 'ADJUSTMENT' | 'EDIT' | 'VOID' | 'IMPORT'
 * @param {string} invoiceId       — linked invoice number (nullable)
 * @param {string} description     — human-readable note (nullable)
 * @param {number} stockAfter      — stock level after this movement is applied
 */
function _recordInvMovement(productCode, quantityChange, movementType, invoiceId, description, stockAfter) {
    if (!db || !productCode || typeof quantityChange !== 'number') return;

    const deviceCode = (typeof _getDeviceCode === 'function') ? _getDeviceCode() : 'DEV';

    // BUG 9: stamp with Lamport sequence so movements sort correctly cross-device
    const lamportSeq = (typeof _lamportNext === 'function') ? _lamportNext() : Date.now();

    const movement = {
        movementId:     _DEVICE_UUID.slice(0, 8) + '_' + lamportSeq + '_' + Math.random().toString(36).slice(2, 6).toUpperCase(),
        productCode,
        quantityChange: Number(quantityChange),
        movementType:   movementType || 'ADJUSTMENT',
        invoiceId:      invoiceId    || null,
        description:    description  || null,
        stockAfter:     typeof stockAfter === 'number' ? stockAfter : null,
        timestamp:      lamportSeq,
        wallClock:      new Date().toISOString(),
        deviceCode,
        deviceUUID:     _DEVICE_UUID,
        synced:         false
    };

    try {
        db.transaction(['inventory_movements'], 'readwrite')
          .objectStore('inventory_movements')
          .put(movement);
    } catch(e) {
        console.error('[inventory] Failed to write movement to IDB:', e);
    }

    // BUG 5: queue cloud push immediately (fire-and-forget, retried by sync engine)
    _queueMovementCloudPush(movement);
}

/** Queue a cloud push for an inventory movement via the Supabase relational table. */
function _queueMovementCloudPush(movement) {
    const row = {
        movement_id:     movement.movementId,
        product_code:    movement.productCode,
        device_uuid:     movement.deviceUUID,
        counter_id:      movement.deviceCode,
        invoice_number:  movement.invoiceId,
        movement_type:   movement.movementType,
        quantity_change: movement.quantityChange,
        stock_after:     movement.stockAfter !== null ? movement.stockAfter : 0,
        description:     movement.description,
        moved_at:        movement.wallClock
    };

    // Attempt immediate push; on failure it stays in IDB for batch push
    if (typeof _dbInsert === 'function') {
        _dbInsert('inventory_movements', row).then(({ error }) => {
            if (!error) {
                // Mark as synced in IDB
                try {
                    db.transaction(['inventory_movements'], 'readwrite')
                      .objectStore('inventory_movements')
                      .put(Object.assign({}, movement, { synced: true }));
                } catch(e) {}
            }
        }).catch(() => {});
    }
}

// =========================================================================
// BUG 1 FIX — Invoice Edit Delta Engine
// When an invoice is edited, billing.js computes which line items changed
// and calls _applyInvoiceEditDelta() with the deltas only.
// This function applies stock corrections and records proper movements.
// =========================================================================

/**
 * Compute the stock delta between an old invoice's line items and a new version.
 * Returns a map of { productCode → signed delta to apply to stock }
 * Positive delta = stock to ADD back (quantity reduced in new version)
 * Negative delta = stock to DEDUCT (quantity increased in new version)
 *
 * @param {Array} oldItems — line items from the original invoice snapshot
 * @param {Array} newItems — line items from the edited invoice
 * @returns {Map<string, number>}  productCode → delta
 */
function _computeEditDelta(oldItems, newItems) {
    const oldMap = new Map();
    const newMap = new Map();

    (oldItems || []).forEach(item => {
        const code = item.code || item.product_code;
        const qty  = parseInt(item.qty || item.quantity || 0, 10);
        if (code) oldMap.set(code, (oldMap.get(code) || 0) + qty);
    });

    (newItems || []).forEach(item => {
        const code = item.code || item.product_code;
        const qty  = parseInt(item.qty || item.quantity || 0, 10);
        if (code) newMap.set(code, (newMap.get(code) || 0) + qty);
    });

    const delta = new Map();
    const allCodes = new Set([...oldMap.keys(), ...newMap.keys()]);

    allCodes.forEach(code => {
        const oldQty = oldMap.get(code) || 0;
        const newQty = newMap.get(code) || 0;
        const d = oldQty - newQty; // positive = stock freed, negative = more sold
        if (d !== 0) delta.set(code, d);
    });

    return delta;
}

/**
 * Apply a computed edit delta to local inventory and log movements.
 * Called by billing.js after the delta has been computed.
 *
 * @param {Map<string, number>} delta        — from _computeEditDelta()
 * @param {string}              invoiceId    — the invoice being edited
 */
function _applyInvoiceEditDelta(delta, invoiceId) {
    if (!delta || delta.size === 0) return;

    delta.forEach((change, productCode) => {
        const prod = masterInventoryDB.find(p => p.code === productCode);
        if (!prod) {
            console.warn('[inventory] Edit delta: product not found locally:', productCode);
            return;
        }

        const before = Number(prod.stock) || 0;
        const after  = Math.max(0, before + change);

        prod.stock   = after;
        prod.version = (typeof prod.version === 'number' && prod.version >= 1) ? prod.version + 1 : 1;

        const direction = change > 0 ? '+' : '';
        const desc = 'Edit adjustment for invoice ' + invoiceId + ' (' + direction + change + ')';

        // BUG 5: strict ledger — log the movement
        _recordInvMovement(productCode, change, 'EDIT', invoiceId, desc, after);
    });

    // Persist updated stock to IDB
    saveInventoryToDB(masterInventoryDB);
}

// =========================================================================
// BATCH PUSH — sync unsynced local movements to cloud
// =========================================================================
async function _pushUnsyncedMovements() {
    if (!db) return;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(['inventory_movements'], 'readonly');
            tx.objectStore('inventory_movements').getAll().onsuccess = async e => {
                const all      = e.target.result || [];
                const unsynced = all.filter(m => !m.synced);
                if (unsynced.length === 0) { resolve(); return; }

                const rows = unsynced.map(m => ({
                    movement_id:     m.movementId,
                    product_code:    m.productCode,
                    device_uuid:     m.deviceUUID,
                    counter_id:      m.deviceCode,
                    invoice_number:  m.invoiceId,
                    movement_type:   m.movementType,
                    quantity_change: m.quantityChange,
                    stock_after:     m.stockAfter !== null && m.stockAfter !== undefined ? m.stockAfter : 0,
                    description:     m.description,
                    moved_at:        m.wallClock || new Date().toISOString()
                }));

                try {
                    const { error } = await _dbInsert('inventory_movements', rows);
                    if (!error) {
                        const tx2 = db.transaction(['inventory_movements'], 'readwrite');
                        const st2 = tx2.objectStore('inventory_movements');
                        unsynced.forEach(m => st2.put(Object.assign({}, m, { synced: true })));
                        tx2.oncomplete = () => resolve();
                        tx2.onerror    = () => resolve();
                    } else {
                        console.warn('[inventory] Batch movement push failed:', error);
                        resolve();
                    }
                } catch(err) {
                    console.warn('[inventory] Movement push network error:', err);
                    resolve();
                }
            };
            tx.onerror = () => resolve();
        } catch(e) { resolve(); }
    });
}

// =========================================================================
// BUG 7 FIX — Remote movement pull using delta application (not absolute)
// When pulling movements from other devices, apply each as a signed delta
// to local stock. Never overwrite absolute stock counts.
// =========================================================================
async function _pullRemoteMovements() {
    if (!db || typeof masterInventoryDB === 'undefined') return false;
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

    const _appliedKey = 'pharma_applied_mov_ids';
    let appliedIds = new Set();
    try {
        const raw = StorageModule.get(_appliedKey);
        if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) appliedIds = new Set(arr); }
    } catch(e) {}

    const remotes = knownDevices.filter(k => k !== myKey);
    const newlyAppliedIds = [];

    for (const remoteKey of remotes) {
        const supaKey = 'pharma_cloud_inv_movements_' + remoteKey;
        try {
            const raw = await _supaGet(supaKey);
            if (!raw) continue;
            const movements = JSON.parse(raw);
            if (!Array.isArray(movements) || movements.length === 0) continue;

            const fresh = movements
                .filter(m =>
                    m.movementId &&
                    !appliedIds.has(m.movementId) &&
                    typeof m.quantityChange === 'number'
                )
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            if (fresh.length === 0) continue;

            let _clampedCount = 0;
            fresh.forEach(m => {
                if (!m.productCode || typeof m.quantityChange !== 'number') return;
                const prod = masterInventoryDB.find(p => p.code === m.productCode);
                if (prod) {
                    // BUG 7: apply delta (+/-) not absolute value
                    const rawStock = (Number(prod.stock) || 0) + Number(m.quantityChange);
                    if (rawStock < 0) {
                        _clampedCount++;
                        console.warn('[DeltaSync] Clamp:', m.productCode, prod.stock, '+', m.quantityChange, '→ 0');
                    }
                    prod.stock   = Math.max(0, rawStock);
                    prod.version = (typeof prod.version === 'number' && prod.version >= 1) ? prod.version + 1 : 1;
                }
                newlyAppliedIds.push(m.movementId);
            });

            if (_clampedCount > 0 && typeof showToast === 'function')
                showToast('⚠️ ' + _clampedCount + ' remote delta(s) clamped at 0 for ' + remoteKey + '.', false);

            applied = true;
        } catch(e) {
            console.warn('[inventory] Remote movement pull failed for', remoteKey, e);
        }
    }

    if (newlyAppliedIds.length > 0) {
        newlyAppliedIds.forEach(id => appliedIds.add(id));
        const trimmed = [...appliedIds].slice(-5000);
        try { StorageModule.set(_appliedKey, JSON.stringify(trimmed)); } catch(e) {}
    }

    if (applied) {
        try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
    }
    return applied;
}

// =========================================================================
// ATOMIC STOCK WRITE-BACK
// Used internally when applying a deduction to a single product, returns
// updated stock value so the caller can pass it to _recordInvMovement.
// =========================================================================
function _atomicStockWriteBack(productCode, delta, movementType, invoiceId, description) {
    const prod = masterInventoryDB.find(p => p.code === productCode);
    if (!prod) return null;

    const before = Number(prod.stock) || 0;
    const after  = Math.max(0, before + delta);

    prod.stock   = after;
    prod.version = (typeof prod.version === 'number' && prod.version >= 1) ? prod.version + 1 : 1;

    // BUG 5: strict ledger rule
    _recordInvMovement(productCode, delta, movementType || 'ADJUSTMENT', invoiceId, description, after);

    return after;
}

// =========================================================================
// IDB LOAD
// =========================================================================
function loadInventoryFromDB() {
    if (!db) return;
    const req = db.transaction(['inventory'], 'readonly').objectStore('inventory').getAll();
    req.onsuccess = function(e) {
        const result    = e.target.result;
        const demoBanner = document.getElementById('demoInventoryBanner');
        if (result && result.length > 0) {
            masterInventoryDB = structuredClone(result.map(item => {
                if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                return item;
            }));
            if (demoBanner) demoBanner.classList.remove('visible');
        } else if (window._supabaseRemoteInventory && window._supabaseRemoteInventory.length > 0) {
            masterInventoryDB = structuredClone(window._supabaseRemoteInventory.map(item => {
                if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                return item;
            }));
            saveInventoryToDB(masterInventoryDB);
            if (demoBanner) demoBanner.classList.remove('visible');
        } else {
            // Load demo data if nothing in IDB
            masterInventoryDB = _getDemoInventory();
            if (demoBanner) demoBanner.classList.add('visible');
        }
        if (typeof renderInventoryTable === 'function') renderInventoryTable();
    };
    req.onerror = function() { masterInventoryDB = []; };
}

function _getDemoInventory() {
    return [
        { code: 'DEMO001', name: 'Paracetamol 500mg', generic_name: 'Paracetamol', pack_size: '10s', unit_price: 25, stock: 100, company: 'Demo', supplier: '', version: 1 },
        { code: 'DEMO002', name: 'Amoxicillin 250mg', generic_name: 'Amoxicillin',  pack_size: '14s', unit_price: 180, stock: 50, company: 'Demo', supplier: '', version: 1 },
        { code: 'DEMO003', name: 'ORS Sachet',        generic_name: 'ORS',           pack_size: '1s',  unit_price: 20,  stock: 200, company: 'Demo', supplier: '', version: 1 }
    ];
}

// =========================================================================
// CHECK & PULL INVENTORY UPDATE FROM MASTER
// Called by syncHub.js interval on client devices.
// =========================================================================
async function _checkAndPullInventoryIfUpdated() {
    const role = (typeof StorageModule !== 'undefined') ? StorageModule.get('pharma_device_role') : null;
    if (role === 'master') return; // master is the source of truth

    try {
        const raw = await _supaGet('pharma_cloud_inventory');
        if (!raw) return;
        const cloud = JSON.parse(raw);
        if (!Array.isArray(cloud) || cloud.length === 0) return;

        // Apply only if cloud version is newer for any product
        let updated = false;
        cloud.forEach(cloudProd => {
            const local = masterInventoryDB.find(p => p.code === cloudProd.code);
            if (!local) {
                masterInventoryDB.push(Object.assign({ version: 1 }, cloudProd));
                updated = true;
            } else if ((cloudProd.version || 1) > (local.version || 1)) {
                Object.assign(local, cloudProd);
                updated = true;
            }
        });

        if (updated) saveInventoryToDB(masterInventoryDB);
    } catch(e) {
        console.warn('[inventory] _checkAndPullInventoryIfUpdated error:', e);
    }
}

// =========================================================================
// INVENTORY UI HELPERS
// =========================================================================
function renderInventoryTable() {
    const tbody = document.getElementById('inventoryTableBody');
    if (!tbody) return;

    const searchVal = (document.getElementById('invSearch')?.value || '').toLowerCase().trim();
    const sortCol   = document.getElementById('invSortCol')?.value  || 'name';
    const sortDir   = document.getElementById('invSortDir')?.value  || 'asc';

    let filtered = masterInventoryDB.filter(item => {
        if (!searchVal) return true;
        return (item.name || '').toLowerCase().includes(searchVal) ||
               (item.code || '').toLowerCase().includes(searchVal) ||
               (item.generic_name || '').toLowerCase().includes(searchVal);
    });

    filtered.sort((a, b) => {
        let av = a[sortCol] !== undefined ? a[sortCol] : '';
        let bv = b[sortCol] !== undefined ? b[sortCol] : '';
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    // BUG 11: render in idle chunks so barcode scanner never lags
    tbody.innerHTML = '';
    if (typeof _renderChunked === 'function') {
        _renderChunked(filtered, 30, (chunk) => {
            chunk.forEach(item => {
                const stock  = Number(item.stock) || 0;
                const low    = stock <= 5;
                const tr     = document.createElement('tr');
                tr.className = low ? 'inv-tr inv-tr-low' : 'inv-tr';
                tr.innerHTML = `
                    <td class="inv-td inv-td-code">${_escHtml(item.code)}</td>
                    <td class="inv-td">${_escHtml(item.name)}</td>
                    <td class="inv-td">${_escHtml(item.generic_name || '')}</td>
                    <td class="inv-td">${_escHtml(item.pack_size || '')}</td>
                    <td class="inv-td">${_escHtml(item.company || '')}</td>
                    <td class="inv-td inv-td-r">${cur}${Number(item.unit_price).toFixed(2)}</td>
                    <td class="inv-td inv-td-c ${low ? 'inv-stock-low' : ''}">${stock}</td>
                    <td class="inv-td inv-td-acts">
                        <button class="inv-edit-btn" onclick="openEditItem('${_escHtml(item.code)}')">Edit</button>
                        <button class="inv-del-btn"  onclick="confirmDeleteItem('${_escHtml(item.code)}')">Del</button>
                    </td>`;
                tbody.appendChild(tr);
            });
        });
    } else {
        filtered.forEach(item => {
            const stock  = Number(item.stock) || 0;
            const low    = stock <= 5;
            const tr     = document.createElement('tr');
            tr.className = low ? 'inv-tr inv-tr-low' : 'inv-tr';
            tr.innerHTML = `
                <td class="inv-td inv-td-code">${_escHtml(item.code)}</td>
                <td class="inv-td">${_escHtml(item.name)}</td>
                <td class="inv-td">${_escHtml(item.generic_name || '')}</td>
                <td class="inv-td">${_escHtml(item.pack_size || '')}</td>
                <td class="inv-td">${_escHtml(item.company || '')}</td>
                <td class="inv-td inv-td-r">${cur}${Number(item.unit_price).toFixed(2)}</td>
                <td class="inv-td inv-td-c ${low ? 'inv-stock-low' : ''}">${stock}</td>
                <td class="inv-td inv-td-acts">
                    <button class="inv-edit-btn" onclick="openEditItem('${_escHtml(item.code)}')">Edit</button>
                    <button class="inv-del-btn"  onclick="confirmDeleteItem('${_escHtml(item.code)}')">Del</button>
                </td>`;
            tbody.appendChild(tr);
        });
    }

    const countEl = document.getElementById('invCount');
    if (countEl) countEl.textContent = filtered.length + ' products';
}
