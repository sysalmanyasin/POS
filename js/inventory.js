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
dbRequest.onsuccess = function(e) { db = e.target.result; loadInventoryFromDB(); };
dbRequest.onerror   = function()  { showToast('⚠️ Database initialization failed.', true); };

let _invSaveLock    = false;
let _invSavePending = null;

// =========================================================================
// INVENTORY PERSISTENCE
// Every record written to the 'inventory' store includes a 'version' integer
// property (defaulting to 1 for records that don't already carry one).
// This value is incremented each time a stock-affecting write is committed,
// and is read at checkout time to stamp capturedVersion onto queue records.
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
            // Apply staged version updates only after IDB confirms the write
            if (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB)) {
                _pendingVersions.forEach(function(version, code) {
                    const idx = masterInventoryDB.findIndex(p => p.code === code);
                    if (idx >= 0) masterInventoryDB[idx].version = version;
                });
            }
            _invSaveLock = false; _flushPendingInventorySave();
        };
        tx.onerror    = function() { _invSaveLock = false; _flushPendingInventorySave(); };
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
function _recordInvMovement(productCode, quantityChange, movementType, invoiceId, description) {
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
        synced:         false
    };
    try {
        db.transaction(['inventory_movements'], 'readwrite')
          .objectStore('inventory_movements')
          .put(movement);
    } catch(e) {}
}

async function _pushUnsyncedMovements() {
    if (!db) return;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(['inventory_movements'], 'readonly');
            tx.objectStore('inventory_movements').getAll().onsuccess = async e => {
                const all      = e.target.result || [];
                const unsynced = all.filter(m => !m.synced);
                if (unsynced.length === 0) { resolve(); return; }

                // FIX: Push to the relational inventory_movements table (not legacy KV blob).
                // Maps IDB camelCase → Supabase snake_case column names.
                const rows = unsynced.map(m => ({
                    movement_id:     m.movementId,
                    product_code:    m.productCode,
                    quantity_change: typeof m.quantityChange === 'number' ? m.quantityChange : 0,
                    movement_type:   m.movementType   || 'ADJUSTMENT',
                    invoice_id:      m.invoiceId      || null,
                    description:     m.description    || null,
                    moved_at:        new Date(m.timestamp || Date.now()).toISOString(),
                    device_code:     m.deviceCode     || _getDeviceCode(),
                    device_uuid:     m.deviceUUID     || _DEVICE_UUID
                }));

                try {
                    const { error } = await _dbUpsert('inventory_movements', rows, 'movement_id');
                    if (error) {
                        console.warn('[Movements] Relational push failed:', error);
                        resolve();
                        return;
                    }
                    // Mark all flushed rows as synced in IDB
                    const tx2 = db.transaction(['inventory_movements'], 'readwrite');
                    const st2 = tx2.objectStore('inventory_movements');
                    unsynced.forEach(m => st2.put(Object.assign({}, m, { synced: true })));
                    tx2.oncomplete = () => resolve();
                    tx2.onerror    = () => resolve();
                } catch(err) {
                    console.warn('[Movements] Push threw:', err);
                    resolve();
                }
            };
            tx.onerror = () => resolve();
        } catch(e) { resolve(); }
    });
}

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
                    typeof m.timestamp === 'number'
                )
                .sort((a, b) => a.timestamp - b.timestamp);
            if (fresh.length === 0) continue;

            let _clampedCount = 0;
            fresh.forEach(m => {
                if (!m.productCode || typeof m.quantityChange !== 'number') return;
                const prod = masterInventoryDB.find(p => p.code === m.productCode);
                if (prod) {
                    const rawStock = (Number(prod.stock) || 0) + Number(m.quantityChange);
                    if (rawStock < 0) {
                        _clampedCount++;
                        console.warn('[DeltaSync] Stock clamp for ' + m.productCode + ': ' + prod.stock + ' + (' + m.quantityChange + ') → clamped to 0 (raw: ' + rawStock + ').');
                    }
                    prod.stock = Math.max(0, rawStock);
                    // Bump version on remote-applied delta so subsequent captures
                    // reflect that the stock state has changed
                    prod.version = (typeof prod.version === 'number' && prod.version >= 1)
                        ? prod.version + 1 : 1;
                }
                newlyAppliedIds.push(m.movementId);
            });
            if (_clampedCount > 0) {
                showToast('⚠️ ' + _clampedCount + ' remote sale(s) clamped stock at 0. Check inventory for ' + remoteKey + '.', false);
            }
            applied = true;
        } catch(e) {}
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
            if (demoBanner) demoBanner.classList.remove('visible');
        } else if (window._supabaseRemoteInventory && window._supabaseRemoteInventory.length > 0) {
            masterInventoryDB = structuredClone(window._supabaseRemoteInventory.map(item => {
                if (typeof item.version !== 'number' || item.version < 1) item.version = 1;
                return item;
            }));
            window._supabaseRemoteInventory = null;
            saveInventoryToDB(masterInventoryDB);
            showToast('☁️ Inventory restored from cloud (' + masterInventoryDB.length + ' items).', false);
            if (demoBanner) demoBanner.classList.remove('visible');
        } else {
            masterInventoryDB = [
                { code:'P-1002', name:'Panadol CF',    unitPrice:150, stock:120, company:'GSK',    generic:'Paracetamol', supplier:'Standard Dist.', packDetails:'10x10',  version:1 },
                { code:'A-5541', name:'Amoxil 250mg',  unitPrice:490, stock:45,  company:'GSK',    generic:'Amoxicillin', supplier:'Standard Dist.', packDetails:'1x12',   version:1 },
                { code:'B-2099', name:'Brufen 400mg',  unitPrice:210, stock:300, company:'Abbott', generic:'Ibuprofen',   supplier:'Alpha Pharma',   packDetails:'30Tabs', version:1 }
            ];
            saveInventoryToDB(masterInventoryDB);
            showToast('ℹ️ Demo stock loaded. Import CSV to replace.', false);
            if (demoBanner) demoBanner.classList.add('visible');
        }
        updateHdrStats();
        // Phase 4: client devices always overwrite local IDB with Supabase inventory
        // on startup. This ensures a clean state after global purge or first registration.
        // Master devices skip this — they are the source of truth.
        const _p4role = (typeof StorageModule !== 'undefined')
            ? StorageModule.get('pharma_device_role') : null;
        if (_p4role === 'client') {
            _pullInventoryFromSupabase().catch(function(e) {
                console.warn('[Phase4] Startup inventory pull failed:', e);
            });
        }
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
let _invFilters  = { code:'', name:'', generic:'', company:'', pack:'', price:'', stock:'' };
let _invStockFilter = 'all';
let _invSearchProduct = null;

function sortInvBy(col) {
    if (_invSortCol === col) _invSortDir = -_invSortDir;
    else { _invSortCol = col; _invSortDir = 1; }
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
    if (_invReady) renderInventoryView();
}

function applyInvProductSearch() {
    if (!_invSearchProduct) { showToast('⚠️ Select a product from the dropdown first.', true); return; }
    _invFilters.name = (_invSearchProduct.name || '').toLowerCase();
    _invFilters.code = '';
    _invReady = true;
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

function renderInventoryView() {
    const container = document.getElementById('inventoryViewContent');
    if (!container) return;

    // Probe for missing Supabase columns (Generic/Company/Supplier blank fix)
    if (navigator.onLine) _checkInventoryColumnsExist().catch(() => {});

    const items = Array.isArray(masterInventoryDB) ? [...masterInventoryDB] : [];
    if (items.length === 0) {
        container.innerHTML = '<div class="inv-empty">No inventory items. Import a CSV via Data Hub to get started.</div>';
        return;
    }

    let filtered = items.filter(it => {
        if (_invFilters.code    && !(it.code        ||'').toLowerCase().includes(_invFilters.code))    return false;
        if (_invFilters.name    && !(it.name        ||'').toLowerCase().includes(_invFilters.name))    return false;
        if (_invFilters.generic && !(it.generic     ||'').toLowerCase().includes(_invFilters.generic)) return false;
        if (_invFilters.company && !(it.company     ||'').toLowerCase().includes(_invFilters.company)) return false;
        if (_invFilters.pack    && !(it.packDetails ||'').toLowerCase().includes(_invFilters.pack))    return false;
        if (_invFilters.price)  { const pv = (Number(it.unitPrice)||0).toFixed(2); if (!pv.includes(_invFilters.price)) return false; }
        if (_invFilters.stock)  { const sv = String(Number(it.stock)||0); if (!sv.includes(_invFilters.stock)) return false; }
        if (_invStockFilter === 'ok')   { if (!((Number(it.stock)||0) > 10))  return false; }
        if (_invStockFilter === 'low')  { const s = Number(it.stock)||0; if (!(s > 0 && s <= 10)) return false; }
        if (_invStockFilter === 'zero') { if (!((Number(it.stock)||0) <= 0))   return false; }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="inv-empty">No items match your filters. <button style="background:none;border:none;color:var(--teal);font-weight:700;cursor:pointer;font-size:12px;" onclick="_invClearAllFilters()" style="cursor:pointer;">Show all</button></div>';
        return;
    }

    filtered.sort((a, b) => {
        let av, bv;
        if      (_invSortCol === 'code')    { av = a.code    || ''; bv = b.code    || ''; }
        else if (_invSortCol === 'name')    { av = a.name    || ''; bv = b.name    || ''; }
        else if (_invSortCol === 'generic') { av = a.generic || ''; bv = b.generic || ''; }
        else if (_invSortCol === 'company') { av = a.company || ''; bv = b.company || ''; }
        else if (_invSortCol === 'pack')    { av = a.packDetails || ''; bv = b.packDetails || ''; }
        else if (_invSortCol === 'price')   { av = Number(a.unitPrice) || 0; bv = Number(b.unitPrice) || 0; }
        else if (_invSortCol === 'stock')   { av = Number(a.stock) || 0;     bv = Number(b.stock) || 0; }
        else { av = a.name || ''; bv = b.name || ''; }
        if (typeof av === 'number') return _invSortDir * (av - bv);
        return _invSortDir * String(av).localeCompare(String(bv));
    });

    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

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
    const shownCount = filtered.length;
    const rows = filtered.map(item => {
        const s = Number(item.stock) || 0;
        const stockCls = s < 0 ? 'inv-stock-neg' : s === 0 ? 'inv-stock-zero' : s <= 10 ? 'inv-stock-low' : 'inv-stock-ok';
        const codeEsc = _escHtml(item.code);
        return `<tr class="inv-row" onclick="openItemHistoryDrawer('${codeEsc}')" title="View movement history">
            <td class="inv-td inv-td-code">${_escHtml(item.code)}</td>
            <td class="inv-td inv-td-name">${_escHtml(item.name || '—')}</td>
            <td class="inv-td inv-td-generic">${_escHtml(item.generic || '—')}</td>
            <td class="inv-td inv-td-company">${_escHtml(item.company || '—')}</td>
            <td class="inv-td inv-td-pack">${_escHtml(item.packDetails || '—')}</td>
            <td class="inv-td inv-td-price">${_escHtml(cur)}${(Number(item.unitPrice) || 0).toFixed(2)}</td>
            <td class="inv-td inv-td-stock"><span class="inv-stock-badge ${stockCls}">${_escHtml(String(s))}</span></td>
            <td class="inv-td inv-td-hist" style="white-space:nowrap;">
                <button class="inv-hist-btn" onclick="openItemHistoryDrawer('${codeEsc}');event.stopPropagation();" title="Movement history">📋</button>
                <button class="inv-hist-btn" style="margin-left:4px;color:var(--red);" onclick="requestDeleteProduct('${codeEsc}');event.stopPropagation();" title="Delete product">🗑</button>
            </td>
        </tr>`;
    }).join('');

    const activeFilters = Object.values(_invFilters).some(v=>v) || _invStockFilter !== 'all';
    const filterBar = activeFilters
        ? `<div class="inv-filter-bar"><span>Showing ${shownCount} of ${totalCount}</span><button onclick="_invClearAllFilters()">✕ Clear all filters</button><button class="inv-gen-btn" style="background:#dc2626;margin-left:auto;" onclick="openPurgeInventoryModal()" title="Purge all local inventory data (requires password)">🗑 Purge All Inventory</button></div>`
        : `<div class="inv-filter-bar inv-filter-bar-dim"><span>${totalCount} products</span><button class="inv-gen-btn" style="background:#dc2626;margin-left:auto;" onclick="openPurgeInventoryModal()" title="Purge all local inventory data (requires password)">🗑 Purge All Inventory</button></div>`;

    container.innerHTML = filterBar + `
        <table class="inv-table inv-table-full">
            <thead>
                <tr>
                    ${_thSF('code',   'Code',    'code…')}
                    ${_thSF('name',   'Name',    'name…')}
                    ${_thSF('generic','Generic', 'generic…')}
                    ${_thSF('company','Company', 'company…')}
                    ${_thSF('pack',   'Pack',    'pack…')}
                    ${_thSF('price',  'Price',   'price…')}
                    ${stockTh}
                    <th class="inv-th">Actions</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function _invSetStockStatus(val) { _invStockFilter = val; if (_invReady) renderInventoryView(); }

function _invClearAllFilters() {
    _invFilters = { code:'', name:'', generic:'', company:'', pack:'', price:'', stock:'' };
    _invStockFilter = 'all';
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

async function _compileLedgerForCurrentDrawer() {
    const productCode = _currentDrawerCode;
    const body = document.getElementById('itemHistoryDrawerBody');
    if (!productCode || !body) return;
    body.innerHTML = '<div class="inv-loading" style="padding:16px;text-align:center;color:var(--g500);font-size:12px;">⏳ Compiling ledger…</div>';

    const item = Array.isArray(masterInventoryDB) ? masterInventoryDB.find(it => it.code === productCode) : null;

    // ── Step 1: Read local IDB movements ───────────────────────────────
    let localMovements = [];
    if (db) {
        try {
            localMovements = await new Promise((resolve, reject) => {
                const tx  = db.transaction(['inventory_movements'], 'readonly');
                const idx = tx.objectStore('inventory_movements').index('by_code');
                const req = idx.getAll(IDBKeyRange.only(productCode));
                req.onsuccess = e => resolve(e.target.result || []);
                req.onerror   = () => reject(new Error('IDB read failed'));
            });
        } catch (_e) { localMovements = []; }
    }

    // ── Step 2: Fetch cloud movements from Supabase ────────────────────
    // inventory_movements are written by deduct_inventory_atomic (server-side).
    // Client devices never get them in IDB — so we must query Supabase directly.
    let cloudMovements = [];
    if (navigator.onLine && typeof _dbSelect === 'function') {
        try {
            const filter = 'product_code=eq.' + encodeURIComponent(productCode) + '&order=moved_at.asc';
            const { data, error } = await _dbSelect('inventory_movements', filter, '*');
            if (!error && Array.isArray(data)) {
                cloudMovements = data.map(r => ({
                    movementId:     r.id              || '',
                    productCode:    r.product_code    || productCode,
                    quantityChange: Number(r.quantity_change) || 0,
                    movementType:   r.movement_type   || 'UNKNOWN',
                    invoiceId:      r.invoice_number  || '',
                    description:    r.description     || '',
                    timestamp:      r.moved_at ? new Date(r.moved_at).getTime() : 0,
                    deviceCode:     r.device_uuid     || '—',
                    _fromCloud:     true
                }));
            }
        } catch (_e) { /* non-fatal — use local only */ }
    }

    // ── Step 3: Merge — cloud authoritative; local fills any gaps ─────
    // Deduplicate: prefer cloud record if movementId matches, else keep local.
    const cloudIds = new Set(cloudMovements.map(m => m.movementId).filter(Boolean));
    const localOnly = localMovements.filter(m => {
        // Local IDB uses movementId; skip if cloud already has it
        return !m.movementId || !cloudIds.has(String(m.movementId));
    }).map(m => ({
        movementId:     String(m.movementId || ''),
        productCode:    m.productCode     || productCode,
        quantityChange: Number(m.quantityChange) || 0,
        movementType:   m.movementType    || 'UNKNOWN',
        invoiceId:      m.invoiceId       || '',
        description:    m.description     || '',
        timestamp:      typeof m.timestamp === 'number' ? m.timestamp : new Date(m.timestamp).getTime(),
        deviceCode:     m.deviceCode      || '—',
        _fromCloud:     false
    }));

    const allMovements = [...cloudMovements, ...localOnly];
    const rawCount = allMovements.length; // before adding synthetic baseline

    // ── Step 4: Sort ascending ─────────────────────────────────────────
    const ascending = allMovements.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // ── Step 5: Inject synthetic baseline if no OPENING record ────────
    const hasOpening = ascending.some(m => m.movementType === 'OPENING');
    let augmented = ascending;
    if (!hasOpening && item) {
        const sumDeltas = ascending.reduce((acc, m) => acc + (Number(m.quantityChange) || 0), 0);
        const syntheticQty = Number(item.stock) - sumDeltas;
        const earliestTs   = ascending.length > 0 ? ((ascending[0].timestamp || Date.now()) - 1000) : Date.now();
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

    // ── Step 6: Running balance ────────────────────────────────────────
    let runningBalance = 0;
    const ledgerWithBalance = augmented.map(function(m) {
        runningBalance += Number(m.quantityChange) || 0;
        return Object.assign({}, m, { _balanceAfter: runningBalance });
    });
    const descending       = ledgerWithBalance.slice().reverse();
    const finalLedgerStock = runningBalance;

    // ── Step 7: Render ─────────────────────────────────────────────────
    const typeLabel = { SALE:'🛒 Sale', REFUND:'↩ Refund', PARTIAL_REFUND:'↩ Partial Refund', OPENING:'📦 Opening Stock', ADJUSTMENT:'🔧 Adjustment', EDIT_RESTORE:'✏️ Edit Restore', UNKNOWN:'— Unknown' };
    const typeClass = { SALE:'inv-mv-sale', REFUND:'inv-mv-refund', PARTIAL_REFUND:'inv-mv-refund', OPENING:'inv-mv-open', ADJUSTMENT:'inv-mv-adj', EDIT_RESTORE:'inv-mv-adj' };

    const rows = descending.map(function(m) {
        const sign    = Number(m.quantityChange) >= 0 ? '+' : '';
        const label   = typeLabel[m.movementType] || _escHtml(String(m.movementType || '—'));
        const cls     = typeClass[m.movementType] || '';
        const isSynth = !!m._isSynthetic;
        const tsMs    = m.timestamp || 0;
        const ts      = (tsMs && !isSynth)
            ? new Date(tsMs).toLocaleString([], { year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
            : (isSynth ? 'Baseline estimate' : '—');
        const dispBal  = Math.max(0, m._balanceAfter);
        const balCls   = m._balanceAfter <= 0 ? 'inv-mv-neg' : m._balanceAfter <= 10 ? 'inv-mv-low' : 'inv-mv-pos';
        const rowStyle = isSynth ? ' style="opacity:.72;font-style:italic;"' : '';
        const descText = m.description ? _escHtml(String(m.description)) : (isSynth ? '<em style="color:var(--g400);">Auto-estimated</em>' : '—');
        const srcBadge = m._fromCloud ? '<span style="font-size:9px;color:var(--g400);margin-left:3px;">☁</span>' : '';
        return '<tr' + rowStyle + '>' +
            '<td class="inv-mv-td inv-mv-ts">'  + _escHtml(ts) + '</td>' +
            '<td class="inv-mv-td"><span class="inv-mv-type ' + cls + '">' + label + (isSynth ? ' *' : '') + '</span>' + srcBadge + '</td>' +
            '<td class="inv-mv-td inv-mv-qty '  + (Number(m.quantityChange) >= 0 ? 'inv-mv-pos' : 'inv-mv-neg') + '">' + _escHtml(sign + String(Number(m.quantityChange))) + '</td>' +
            '<td class="inv-mv-td inv-mv-bal '  + balCls + '">' + _escHtml(String(dispBal)) + '</td>' +
            '<td class="inv-mv-td inv-mv-inv">' + (m.invoiceId ? _escHtml(String(m.invoiceId)) : '—') + '</td>' +
            '<td class="inv-mv-td inv-mv-dev">' + _escHtml(String(m.deviceCode || '—')) + '</td>' +
            '<td class="inv-mv-td inv-mv-desc">' + descText + '</td>' +
        '</tr>';
    }).join('');

    const cloudNote = cloudMovements.length > 0
        ? ' <span style="font-size:10px;color:var(--g400);">(☁ ' + cloudMovements.length + ' cloud + 💾 ' + localOnly.length + ' local)</span>'
        : (navigator.onLine ? '' : ' <span style="font-size:10px;color:var(--amber);">⚠️ Offline — cloud movements not loaded</span>');

    body.innerHTML =
        '<div class="inv-hist-summary" style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 12px;background:var(--g50);border-bottom:1px solid var(--g200);font-size:12px;">' +
            '<span class="inv-hist-count" style="font-weight:700;color:var(--teal);">' + rawCount + ' movement' + (rawCount !== 1 ? 's' : '') + cloudNote + '</span>' +
            '<span>Computed Ledger Balance: <strong>' + finalLedgerStock + '</strong></span>' +
            (item ? '<span>Snapshot Stock: <strong>' + item.stock + '</strong></span>' : '') +
        '</div>' +
        '<div class="inv-hist-table-wrap" style="overflow-x:auto;">' +
        '<table class="inv-hist-table" style="width:100%;border-collapse:collapse;font-size:12px;">' +
            '<thead><tr style="background:var(--g100);">' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:left;font-weight:700;color:var(--g600);">Time</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:left;font-weight:700;color:var(--g600);">Type</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:right;font-weight:700;color:var(--g600);">Qty Δ</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:right;font-weight:700;color:var(--g600);">Balance</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:left;font-weight:700;color:var(--g600);">Invoice</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:left;font-weight:700;color:var(--g600);">Device</th>' +
                '<th class="inv-mv-th" style="padding:6px 10px;text-align:left;font-weight:700;color:var(--g600);">Description</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
        '</table></div>';
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
                _recordInvMovement(code, openingQty, 'OPENING', 'BASELINE', 'Initial baseline stock configuration');
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
        'conversion factor': 'packDetails',             // Candela RMS pack/unit size
        'conversion factor (pack size)': 'packDetails', // Candela RMS with full label
        'pack size':         'packDetails'              // legacy alias
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
        const lines = text.replace(/\uFEFF/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
        if (lines.length < 2) {
            showToast('⚠️ CSV appears empty or has no data rows.', true);
            return;
        }

        const rawHeaders = _splitCsvRow(lines[0]).map(function(h) {
            return h
                .replace(/^\u00EF\u00BB\u00BF/, '')  // UTF-8 BOM bytes if decoded as latin1
                .replace(/\uFEFF/g, '')                 // UTF-8 BOM (Excel exports)
                .replace(/\u00A0/g, ' ')                // non-breaking space → regular space
                .replace(/\u200B/g, '')                 // zero-width space
                .replace(/^\"|\"$/g, '')               // strip CSV quotes
                .trim()
                .toLowerCase();
        });

        const colIndex = {};
        rawHeaders.forEach(function(h, i) {
            if (_CSV_COL_MAP[h]) colIndex[_CSV_COL_MAP[h]] = i;
        });

        // Diagnostic: log detected mapping to browser console for debugging
        console.log('[CSV Import] Detected headers:', rawHeaders);
        console.log('[CSV Import] Column index:', JSON.stringify(colIndex));

        if (!('code' in colIndex) || !('name' in colIndex)) {
            // Show which headers WERE found to help diagnose the mismatch
            const found = rawHeaders.map((h, i) => i + ':' + JSON.stringify(h)).join(', ');
            showToast('❌ CSV must have "Product Code" and "Product Name" columns. Found: ' + found, true);
            return;
        }

        // Warn if Generic / Company / Supplier columns were not detected
        const _missingCols = [];
        if (!('generic'  in colIndex)) _missingCols.push('"Generic Detail"');
        if (!('company'  in colIndex)) _missingCols.push('"Manufacture"');
        if (!('supplier' in colIndex)) _missingCols.push('"Supplier"');
        if (_missingCols.length > 0) {
            showToast('⚠️ These columns were not found in the CSV and will be blank: ' + _missingCols.join(', '), false);
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

        // F12: Deduplicate by product code (keep last occurrence) so a CSV with
        // duplicate codes doesn't produce double entries in the in-memory array.
        const _seenCodes = new Map();
        imported.forEach(item => _seenCodes.set(item.code, item));
        const dedupedImport = [..._seenCodes.values()];
        if (dedupedImport.length < imported.length) {
            console.warn('[CSV Import] Removed', imported.length - dedupedImport.length, 'duplicate product code(s).');
            showToast('⚠️ Duplicate product codes removed during import (' + (imported.length - dedupedImport.length) + ' duplicates).', false);
        }
        window.masterInventoryDB = dedupedImport;
        try {
            saveInventoryToDB(window.masterInventoryDB);

            // FIX 1: Record an IMPORT movement for every imported product.
            // This populates inventory_movements (which was always empty after CSV import)
            // and feeds the relational push pipeline so Supabase inventory_movements table
            // receives rows. Runs synchronously before the async cloud push so movements
            // are queued in IDB before _pushUnsyncedMovementsRelational() fires.
            const _importBatchId = 'CSV_' + Date.now();
            imported.forEach(function(item) {
                if (item.code && typeof item.stock === 'number' && item.stock > 0) {
                    _recordInvMovement(
                        item.code,
                        item.stock,
                        'IMPORT',
                        _importBatchId,
                        'CSV inventory import — ' + (item.name || item.code)
                    );
                }
            });

            const demoBanner = document.getElementById('demoInventoryBanner');
            if (demoBanner) demoBanner.classList.remove('visible');
            if (typeof _invReady !== 'undefined' && _invReady) renderInventoryView();
            else if (typeof showInventoryPlaceholder === 'function') showInventoryPlaceholder();
            if (typeof updateHdrStats === 'function') updateHdrStats();
            const skipNote = skipped.length ? ' (' + skipped.length + ' rows skipped)' : '';
            // Show which columns were picked up so blank-column bugs are immediately visible
            const _detectedCols = [];
            if ('generic'     in colIndex) _detectedCols.push('Generic✓');
            if ('company'     in colIndex) _detectedCols.push('Company✓');
            if ('supplier'    in colIndex) _detectedCols.push('Supplier✓');
            if ('packDetails' in colIndex) _detectedCols.push('Pack✓');
            const _colNote = _detectedCols.length ? ' | ' + _detectedCols.join(' ') : ' | ⚠️ Generic/Company/Supplier NOT detected — check CSV headers';
            showToast('✅ CSV imported: ' + imported.length + ' products loaded.' + skipNote + _colNote);
            // Phase 4: push to Supabase inventory table (master device only).
            // Always clears the bootstrap_done flag first so every CSV import
            // re-pushes the full inventory to cloud (fixes re-import not syncing to clients).
            // Runs asynchronously so it never blocks the local import flow.
            if (typeof _pushInventoryBootstrapToCloud === 'function') {
                (async function _clearFlagThenPush() {
                    try {
                        // Clear the one-time guard so the push is never skipped
                        if (typeof _dbUpsert === 'function') {
                            await _dbUpsert('settings', [{
                                device_uuid: _DEVICE_UUID,
                                key:         'inventory_bootstrap_done',
                                value:       'false',
                                updated_at:  new Date().toISOString()
                            }], 'device_uuid,key');
                        }
                    } catch (_e) {
                        console.warn('[CSVImport] Could not clear bootstrap flag — push may be skipped:', _e);
                    }
                    await _pushInventoryBootstrapToCloud();
                })().catch(function(e) {
                    showToast('⚠️ Cloud push failed: ' + (e.message || e), true);
                });
            }
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _attachCsvListener);
    } else {
        _attachCsvListener();
    }

})();

// =========================================================================
// PURGE INVENTORY DATA — Password-protected local data wipe
// =========================================================================
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

    // F1: Use the canonical _verifyPassword() from auth.js which handles
    // the correct FDPP_v1_ prefix, Supabase-first lookup, and localStorage
    // fallback — replacing the broken custom hash that always rejected.
    let passwordOk = false;
    try {
        if (typeof _verifyPassword === 'function') {
            passwordOk = await _verifyPassword(enteredPassword);
        } else {
            if (statusEl) { statusEl.textContent = '❌ Auth module not ready.'; statusEl.style.color = '#dc2626'; }
            return;
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ Password check failed.'; statusEl.style.color = '#dc2626'; }
        return;
    }

    if (!passwordOk) {
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
// =========================================================================
// SUPABASE ROW MAPPERS
// IDB field        → Supabase column
//   code           code
//   name           name
//   generic        generic_name
//   company        company        (Manufacturer)
//   supplier       supplier
//   packDetails    pack_size
//   unitPrice      unit_price
//   stock          stock
//   version        version
//   _DEVICE_UUID   uploaded_by        FK → devices.uuid
//   (now)          uploaded_at / updated_at
// =========================================================================
// =========================================================================

// ── Column-existence probe ────────────────────────────────────────────────
// The `company` and `supplier` columns were added in a later migration.
// If they don't exist in Supabase, the push silently drops them and the
// pull returns nulls — so Generic / Company / Supplier always show blank.
// This helper probes for the column once per session and shows a persistent
// banner with the exact SQL if it's missing.
let _invColumnsChecked = false;

async function _checkInventoryColumnsExist() {
    if (_invColumnsChecked) return;
    _invColumnsChecked = true;
    try {
        // Probe: SELECT company,supplier,generic_name,pack_size,unit_price on 1 row.
        // If columns are missing, PostgREST returns a 400 with
        // "column … does not exist" in the error body.
        const r = await fetch(
            _SUPA_URL + '/rest/v1/inventory?select=company,supplier,generic_name,pack_size,unit_price&limit=1',
            { headers: _SUPA_HEADERS }
        );
        if (r.ok) return; // columns exist — nothing to do

        const errText = await r.text().catch(() => '');
        const isMissingCol = r.status === 400 &&
            (errText.includes('company') || errText.includes('supplier') ||
             errText.includes('generic_name') || errText.includes('pack_size') ||
             errText.includes('unit_price'));

        if (isMissingCol || r.status === 400) {
            _showMissingColumnsBanner();
        }
    } catch (_e) { /* offline — skip */ }
}

function _showMissingColumnsBanner() {
    if (document.getElementById('invColMigrationBanner')) return; // already shown
    const banner = document.createElement('div');
    banner.id = 'invColMigrationBanner';
    banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9990',
        'background:#7c3aed', 'color:#fff', 'padding:12px 16px',
        'font-size:12px', 'line-height:1.6', 'box-shadow:0 4px 12px rgba(0,0,0,.3)'
    ].join(';');
    banner.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:12px;">' +
        '<span style="font-size:20px;flex-shrink:0;">⚠️</span>' +
        '<div style="flex:1;">' +
        '<strong>Database migration required — Generic / Company / Supplier columns are missing from Supabase.</strong><br>' +
        'Run this SQL once in <a href="https://supabase.com/dashboard" target="_blank" ' +
        'style="color:#e9d5ff;text-decoration:underline;">Supabase → SQL Editor</a>, then re-push your inventory:<br>' +
        '<code style="display:block;margin-top:6px;padding:8px;background:rgba(0,0,0,.3);border-radius:5px;font-family:monospace;font-size:11px;white-space:pre-wrap;">' +
        'ALTER TABLE inventory\n' +
        '  ADD COLUMN IF NOT EXISTS generic_name text NOT NULL DEFAULT \'\',\n' +
        '  ADD COLUMN IF NOT EXISTS company      text NOT NULL DEFAULT \'\',\n' +
        '  ADD COLUMN IF NOT EXISTS supplier     text NOT NULL DEFAULT \'\',\n' +
        '  ADD COLUMN IF NOT EXISTS pack_size    text NOT NULL DEFAULT \'\',\n' +
        '  ADD COLUMN IF NOT EXISTS unit_price   numeric(12,2) NOT NULL DEFAULT 0;' +
        '</code>' +
        '</div>' +
        '<button onclick="document.getElementById(\'invColMigrationBanner\').remove();_invColumnsChecked=false;" ' +
        'style="flex-shrink:0;background:rgba(255,255,255,.2);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:700;">✕ Dismiss</button>' +
        '</div>';
    document.body.insertBefore(banner, document.body.firstChild);
}

/**
 * Map a local IDB inventory record to the Supabase inventory table row shape.
 */
function _idbRowToSupabaseRow(item) {
    const now = new Date().toISOString();
    return {
        code:         item.code,
        name:         item.name         || '',
        generic_name: item.generic      || '',
        company:      item.company      || '',   // FIX 5: was excluded (KNOWN GAP)
        supplier:     item.supplier     || '',   // FIX 5: was excluded (KNOWN GAP)
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
 */
function _supabaseRowToIdbRow(row) {
    return {
        code:        row.code,
        name:        row.name         || '',
        generic:     row.generic_name || '',
        company:     row.company      || '',   // FIX 5: was always cleared to ''
        supplier:    row.supplier     || '',   // FIX 5: was always cleared to ''
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

    // ── Column-existence check (Generic/Company/Supplier) ─────────────────
    // Show the migration SQL banner if columns are missing, but continue the
    // push anyway so stock values still reach Supabase.
    _invColumnsChecked = false; // force re-probe on every push
    await _checkInventoryColumnsExist().catch(() => {});

    // NOTE: The one-time-only guard has been intentionally removed.
    // The CSV import flow now clears the bootstrap_done flag before calling
    // this function, so every import always re-pushes the full inventory to
    // Supabase. The flag is still written on success so client devices can
    // confirm the master has bootstrapped before they attempt a pull.

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
        console.warn('[Phase4] bootstrap_done flag write failed:', flagWriteErr);
        showToast('⚠️ Inventory pushed (' + pushed + ' items) but bootstrap flag write failed. Subsequent imports may re-push.', false);
    } else {
        showToast('✅ Inventory synced to cloud (' + pushed + ' products). Clients will pull on next sync cycle.');
    }

    // FIX 2: Write inventory_last_updated timestamp so client devices can detect
    // that the master has pushed new inventory during their 60-second sync cycle.
    // Without this signal, clients only pull on startup — never during a session.
    try {
        await _dbUpsert('settings', [{
            device_uuid: _DEVICE_UUID,
            key:         'inventory_last_updated',
            value:       now,
            updated_at:  now
        }], 'device_uuid,key');
        console.log('[Phase4] inventory_last_updated signal written:', now);
    } catch (_sigErr) {
        console.warn('[Phase4] inventory_last_updated signal write failed (non-fatal):', _sigErr);
    }
}

// =========================================================================
// FIX 3 — CLIENT INVENTORY CHANGE DETECTOR
//
// Called by syncHub._runSyncCycle() every 60 seconds on ALL devices.
// Client devices compare the master's inventory_last_updated timestamp
// against the last value they pulled. If master has a newer timestamp,
// client pulls the full inventory from Supabase without a page reload.
//
// This replaces the "only pull on startup" limitation and gives clients
// real-time inventory updates whenever the master imports a new CSV.
// =========================================================================
async function _checkAndPullInventoryIfUpdated() {
    // Only client devices need to pull — master IS the source of truth
    const _role = (typeof StorageModule !== 'undefined')
        ? StorageModule.get('pharma_device_role') : null;
    if (_role === 'master') return false;

    // Resolve master device UUID
    let masterUUID = null;
    try {
        const { data: masterRows } = await _dbSelect(
            'devices',
            'role=eq.master&is_active=eq.true',
            'uuid'
        );
        if (!masterRows || masterRows.length === 0) return false;
        masterUUID = masterRows[0].uuid;
    } catch(_e) { return false; }

    // Read master's inventory_last_updated signal from settings
    let masterTs = null;
    try {
        const { data: flagRows } = await _dbSelect(
            'settings',
            'device_uuid=eq.' + encodeURIComponent(masterUUID) + '&key=eq.inventory_last_updated',
            'value'
        );
        if (!flagRows || flagRows.length === 0) return false;
        masterTs = flagRows[0].value;
    } catch(_e) { return false; }

    if (!masterTs) {
        // inventory_last_updated not written yet (e.g. bootstrap failed mid-way).
        // If the client has no inventory at all, do a force pull anyway.
        const localCount = Array.isArray(window.masterInventoryDB) ? window.masterInventoryDB.length : 0;
        if (localCount === 0) {
            console.log('[InvSync] No masterTs signal but client has 0 products — attempting force pull.');
            try { return await _pullInventoryFromSupabase(true); } catch(_e) { return false; }
        }
        return false;
    }

    // Compare with the timestamp we last pulled
    const _pulledKey = 'pharma_inv_last_pulled_' + masterUUID.slice(0, 8);
    const localPulledTs = (function() {
        try { return localStorage.getItem(_pulledKey) || ''; } catch(_e) { return ''; }
    })();

    if (masterTs <= localPulledTs) return false; // Already up to date

    // Master has newer inventory — pull full inventory from Supabase
    console.log('[InvSync] Master inventory updated at ' + masterTs + ' (local: ' + localPulledTs + '). Pulling…');
    try {
        const pulled = await _pullInventoryFromSupabase();
        if (pulled) {
            try { localStorage.setItem(_pulledKey, masterTs); } catch(_e) {}
            console.log('[InvSync] ✅ Inventory pulled from master.');
        }
        return pulled;
    } catch(_e) {
        console.warn('[InvSync] Pull from master failed:', _e);
        return false;
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
async function _pullInventoryFromSupabase(force = false) {
    // ── Step 1: resolve master UUID ───────────────────────────────────────
    // Probe for missing Supabase columns (Generic/Company/Supplier blank fix).
    // Reset the guard so every pull re-probes — ensures the migration banner
    // appears even on clients that haven't visited the Inventory tab yet.
    if (navigator.onLine) {
        _invColumnsChecked = false;
        _checkInventoryColumnsExist().catch(() => {});
    }

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
    // Skipped when force=true (manual Pull button) — user explicitly wants
    // inventory regardless of whether the flag was written successfully.
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

    // ── Step 3: fetch inventory rows (paginated — PostgREST default cap = 1000) ──
    // A single _dbSelect('inventory') silently returns only the first 1000 rows.
    // We page in chunks of 1000 until a page comes back smaller than the chunk size.
    const _INV_PAGE = 1000;
    let allInvRows  = [];
    let _offset     = 0;
    while (true) {
        const { data: page, error: invErr } = await _dbSelect(
            'inventory',
            'limit=' + _INV_PAGE + '&offset=' + _offset,
            '*'
        );
        if (invErr) {
            console.warn('[Phase4] Inventory pull error (offset=' + _offset + '):', invErr);
            showToast('⚠️ Cloud inventory pull failed: ' + invErr, true);
            return false;
        }
        if (!page || page.length === 0) break;          // no more rows
        allInvRows = allInvRows.concat(page);
        if (page.length < _INV_PAGE) break;              // last (partial) page
        _offset += _INV_PAGE;
    }
    if (allInvRows.length === 0) {
        console.info('[Phase4] Cloud inventory table is empty — skipping overwrite.');
        return false;
    }
    console.log('[Phase4] Inventory pull complete — ' + allInvRows.length + ' rows fetched.');

    // ── Step 4: map, overwrite IDB + in-memory cache ─────────────────────
    const mapped = allInvRows.map(_supabaseRowToIdbRow);
    window.masterInventoryDB = mapped;
    saveInventoryToDB(mapped);

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
// INVENTORY ↔ CLOUD — dedicated push / pull (inventory only)
// Used by the Push / Pull buttons in the Inventory toolbar.
// =========================================================================
async function pushInventoryToCloud() {
    // FIX 6: Was writing to the legacy pharma_sync KV key 'pharma_cloud_inventory'
    // (a single JSON blob, capped at ~5 MB, invisible to _pullInventoryFromSupabase).
    // Now delegates to _pushInventoryBootstrapToCloud() which batches 500 rows at a
    // time into the relational `inventory` table and writes the
    // inventory_last_updated signal so clients auto-pull within 60 s.
    if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('syncing');
    try {
        await _pushInventoryBootstrapToCloud();
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
    } catch(e) {
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('offline');
        showToast('❌ Push failed: ' + (e.message || e), true);
    }
}

async function pullInventoryFromCloud() {
    // FIX 6: Was reading from the legacy pharma_sync KV key 'pharma_cloud_inventory'.
    // That key is a single JSON blob written by the old pushInventoryToCloud() and
    // has nothing to do with the relational `inventory` table that the system now
    // uses.  Replaced with _pullInventoryFromSupabase(force=true) which pages through
    // the relational table in 1000-row chunks (no 5 MB size cap, no row-count cap).
    if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('syncing');
    try {
        showToast('⬇️ Pulling inventory from cloud (relational table)…');
        const ok = await _pullInventoryFromSupabase(true); // force=true skips bootstrap_done guard
        if (ok) {
            if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
            // toast is already shown inside _pullInventoryFromSupabase
        } else {
            if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');
            showToast('ℹ️ Nothing pulled — cloud inventory may be empty or master not found.', false);
        }
    } catch(e) {
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('offline');
        showToast('❌ Pull failed: ' + (e.message || e), true);
    }
}

// EXPOSE TO GLOBAL WINDOW SO BUTTONS CAN CLICK THEM
window.openPurgeInventoryModal  = openPurgeInventoryModal;
window.closePurgeInventoryModal = closePurgeInventoryModal;
window.pushInventoryToCloud     = pushInventoryToCloud;
window.pullInventoryFromCloud   = pullInventoryFromCloud;
// Phase 4 — relational table bootstrap (master push / client pull)
window._pushInventoryBootstrapToCloud = _pushInventoryBootstrapToCloud;
window._pullInventoryFromSupabase     = _pullInventoryFromSupabase;
