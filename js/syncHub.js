// =========================================================================
// CENTRAL CLOUD SYNC HUB — syncHub.js   (Phase 2, Rule 5 + v2 Sync Engine)
// =========================================================================
// Load-order dependencies (enforced by index.html script tags):
//   config.js    — _supaGet(), _supaSet(), _DEVICE_UUID, _escHtml(), supabase
//   storage.js   — StorageModule (getSyncQueueOrdered, deleteFromSyncQueue,
//                  drainSyncQueue, syncQueueMetrics)
//   inventory.js — global `db` (PharmaInventoryDB handle)
//                  global _pushUnsyncedMovements(), saveInventoryToDB()
// =========================================================================

// ── Constants ──────────────────────────────────────────────────────────────
const SYNC_HUB_PRUNE_DAYS  = 7;       // devices older than this are hidden
const SYNC_HUB_ACTIVE_SEC  = 120;     // < 120 s → 🟢 Active Now
const SYNC_HUB_REFRESH_MS  = 30_000;  // auto-refresh interval

let _syncHubRefreshTimer    = null;
let _forceSyncRunning       = false;  // guard against concurrent runs

// =========================================================================
// SECTION A — OFFLINE QUEUE DRAIN ENGINE  (syncOfflineQueue)
// =========================================================================
// Drains the 'offline_sync_queue' store created in storage.js (PharmaDataDB
// v4).  Each record has the shape:
//   { queueId, type, payload, capturedVersion, createdAt }
//
// Currently handled types:
//   "INVOICE" — posts the core invoice to Supabase 'invoices', then calls
//               the deduct_inventory_atomic RPC for every line item.
//
// Concurrency guard  : _forceSyncRunning (shared with forceSyncNow)
// Network triggers   : window 'online' event  +  setInterval (60 s)
// =========================================================================

// ── A1: Background auto-trigger wiring ────────────────────────────────────
window.addEventListener('online', () => {
    // Small debounce — let the browser settle connectivity before we hammer
    setTimeout(() => {
        if (navigator.onLine) {
            syncOfflineQueue(_DEVICE_UUID).catch(() => {});
        }
    }, 2000);
});

// Run the queue check every 60 seconds as a background safety net
setInterval(() => {
    if (navigator.onLine && !_forceSyncRunning) {
        syncOfflineQueue(_DEVICE_UUID).catch(() => {});
        // FIX: also let clients auto-pull master inventory updates.
        // _checkAndPullInventoryIfUpdated() is defined in inventory.js and
        // is a no-op on the master device.
        if (typeof _checkAndPullInventoryIfUpdated === 'function') {
            _checkAndPullInventoryIfUpdated().catch(() => {});
        }
    }
}, 60_000);

// ── A2: Core execution function ───────────────────────────────────────────
/**
 * syncOfflineQueue(deviceUuid)
 *
 * Drains offline_sync_queue oldest-first.  Handles INVOICE records
 * by posting to Supabase and calling deduct_inventory_atomic per line item.
 *
 * @param {string} deviceUuid  — _DEVICE_UUID from config.js
 */
async function syncOfflineQueue(deviceUuid) {
    // ── Execution guard ──────────────────────────────────────────────────
    if (_forceSyncRunning) return;
    _forceSyncRunning = true;

    try {
        // ── B1: Pull queue oldest-first ──────────────────────────────────
        let queueItems;
        try {
            queueItems = await StorageModule.getSyncQueueOrdered();
        } catch (e) {
            console.warn('[SyncEngine] getSyncQueueOrdered failed:', e);
            return;
        }

        if (!Array.isArray(queueItems) || queueItems.length === 0) {
            return; // Nothing pending — exit cleanly
        }

        // Process items sequentially to preserve chronological order
        for (const item of queueItems) {
            try {
                await _processQueueItem(item, deviceUuid);
            } catch (itemErr) {
                // One item failing must not block the rest
                console.error('[SyncEngine] Unhandled error on queueId', item.queueId, itemErr);
            }
        }

    } finally {
        _forceSyncRunning = false;

        // Refresh hub UI if it is currently visible
        if (document.getElementById('syncHubView')?.classList.contains('active')) {
            _renderPendingQueueWidget().catch(() => {});
            _stampRefreshTime();
        }
    }
}

// ── A3: Route a single queue record by type ───────────────────────────────
async function _processQueueItem(item, deviceUuid) {
    switch (item.type) {
        case 'INVOICE':
            await _processInvoiceItem(item, deviceUuid);
            break;
        // SCHEMA FIX: INVOICE_UPDATE type — patches a single column on an existing
        // invoice row (e.g. is_fully_refunded=true after processFullRefund).
        // Payload must include invoice_number + the column(s) to patch.
        case 'INVOICE_UPDATE': {
            const upd = item.payload;
            if (upd && upd.invoice_number && typeof _dbUpsert === 'function') {
                try {
                    const { error } = await _dbUpsert('invoices', [upd], 'invoice_number');
                    if (!error) {
                        await StorageModule.deleteFromSyncQueue(item.queueId);
                    } else {
                        console.warn('[SyncEngine] INVOICE_UPDATE upsert failed:', error);
                    }
                } catch (e) {
                    console.warn('[SyncEngine] INVOICE_UPDATE error:', e);
                }
            } else {
                await StorageModule.deleteFromSyncQueue(item.queueId);
            }
            break;
        }
        // FIX: INVENTORY_MOVEMENT type — directly upsert to inventory_movements table.
        // These are pushed by _pushUnsyncedMovements when movements accumulate offline.
        case 'INVENTORY_MOVEMENT': {
            const mv = item.payload;
            if (mv && mv.movement_id && typeof _dbUpsert === 'function') {
                try {
                    const { error } = await _dbUpsert('inventory_movements', [mv], 'movement_id');
                    if (!error) {
                        await StorageModule.deleteFromSyncQueue(item.queueId);
                    } else {
                        console.warn('[SyncEngine] INVENTORY_MOVEMENT upsert failed:', error);
                    }
                } catch (e) {
                    console.warn('[SyncEngine] INVENTORY_MOVEMENT error:', e);
                }
            } else {
                // Malformed — discard
                await StorageModule.deleteFromSyncQueue(item.queueId);
            }
            break;
        }
        default:
            // Unknown types: log and discard so they don't jam the queue
            console.warn('[SyncEngine] Unknown queue type:', item.type, '— discarding queueId', item.queueId);
            await StorageModule.deleteFromSyncQueue(item.queueId);
    }
}

// =========================================================================
// SECTION B — INVOICE PROCESSING PIPELINE
// =========================================================================

/**
 * _processInvoiceItem(item, deviceUuid)
 *
 * 1. POST core invoice record to Supabase 'invoices' table (upsert).
 *    Duplicate-key (23505) → already synced, remove from queue and skip.
 * 2. Loop line items → call deduct_inventory_atomic RPC sequentially.
 * 3. Handle RPC result: success / OCC-rebase / oversell.
 * 4. On full completion, delete the parent queue record.
 */
async function _processInvoiceItem(item, deviceUuid) {
    const payload = item.payload || {};
    const {
        invoice_number,
        line_items = [],
        ...coreInvoiceFields
    } = payload;

    if (!invoice_number) {
        console.warn('[SyncEngine] INVOICE record missing invoice_number — discarding queueId', item.queueId);
        await StorageModule.deleteFromSyncQueue(item.queueId);
        return;
    }

    // ── F8: Idempotency guard — skip RPC if this invoice was already fully ──
    // processed in a previous run (connectivity dropped after invoice upsert
    // but before queue delete, so the item was retried). The synced set is
    // stored in localStorage as a JSON array of invoice_numbers.
    const _syncedKey = 'pharma_synced_invoices';
    let _syncedSet;
    try { _syncedSet = new Set(JSON.parse(localStorage.getItem(_syncedKey) || '[]')); }
    catch(_) { _syncedSet = new Set(); }
    if (_syncedSet.has(invoice_number)) {
        console.log('[SyncEngine] Idempotency: invoice', invoice_number, 'already processed — removing from queue.');
        await StorageModule.deleteFromSyncQueue(item.queueId);
        return;
    }

    // ── B1: POST core invoice ────────────────────────────────────────────
    // F6: Use raw _dbUpsert (no SDK). Payload from billing.js is already
    // snake_case so no key translation needed. Strip local-only fields that
    // have no matching Supabase column (date, timestamp, line_items).
    try {
        const { date: _d, timestamp: _ts, line_items: _li, ...serverFields } = coreInvoiceFields;
        const { error: invoiceError } = await _dbUpsert(
            'invoices',
            { invoice_number, device_uuid: deviceUuid, ...serverFields },
            'invoice_number'
        );

        if (invoiceError) {
            // Duplicate key / conflict — treat as already synced and discard
            if (String(invoiceError).includes('23505') || String(invoiceError).includes('duplicate')) {
                console.log('[SyncEngine] Invoice', invoice_number, 'already exists on server — removing from queue.');
                await StorageModule.deleteFromSyncQueue(item.queueId);
                return;
            }
            // Any other server error — leave in queue to retry next cycle
            console.error('[SyncEngine] Invoice upsert failed for', invoice_number, invoiceError);
            return;
        }
    } catch (netErr) {
        console.error('[SyncEngine] Network error posting invoice', invoice_number, netErr);
        return; // Leave in queue for the next network-triggered cycle
    }

    // ── B1b: Write invoice_items rows ────────────────────────────────────
    // This populates the invoice_items table so that history.js can render
    // full receipt details (item name, qty, price) on any device via the
    // '*,invoice_items(*)' join query.  Without this step every invoice had
    // details: [] — breaking the receipt modal, medicine filter, and CSV export.
    // Uses upsert on (invoice_number, product_code) so re-syncing is safe.
    //
    // F13 / Finding 1.26: The conflict key is (invoice_number, product_code).
    // If the same product_code appears more than once in line_items (e.g. the
    // pharmacist added 5 units, reduced to 3, then re-added 2 as a separate
    // cart row), the second upsert would silently overwrite the first, losing
    // one row entirely.  Pre-aggregate by product_code — sum qty and total,
    // keep the first-seen unit_price / name — before building itemRows so
    // every upserted row is unique on (invoice_number, product_code).
    if (Array.isArray(line_items) && line_items.length > 0) {
        // Aggregate duplicate product_codes within this invoice
        const _aggMap = new Map();
        line_items
            .filter(li => li.product_code)
            .forEach(li => {
                const key = li.product_code;
                if (_aggMap.has(key)) {
                    const existing = _aggMap.get(key);
                    existing.qty   += parseInt(li.quantity || li.qty || 0, 10);
                    existing.total += parseFloat(li.total || 0);
                } else {
                    _aggMap.set(key, {
                        invoice_number: invoice_number,
                        product_code:   li.product_code,
                        product_name:   li.name        || '',
                        pack_size:      li.packDetails || li.pack_size || '',
                        unit_price:     parseFloat(li.unitPrice  || li.unit_price  || 0),
                        qty:            parseInt(li.quantity     || li.qty         || 0, 10),
                        total:          parseFloat(li.total      || 0)
                    });
                }
            });
        const itemRows = [..._aggMap.values()];

        if (itemRows.length > 0) {
            try {
                const { error: iiErr } = await _dbUpsert(
                    'invoice_items',
                    itemRows,
                    'invoice_number,product_code'
                );
                if (iiErr) {
                    // Non-fatal: log but continue — inventory deduction still proceeds
                    console.warn('[SyncEngine] invoice_items upsert failed for', invoice_number, iiErr);
                } else {
                    console.log('[SyncEngine] invoice_items written:', itemRows.length, 'rows for', invoice_number);
                }
            } catch (iiNetErr) {
                console.warn('[SyncEngine] invoice_items network error for', invoice_number, iiNetErr);
            }
        }
    }

    // ── B2: Loop line items sequentially ─────────────────────────────────
    let allLineItemsHandled = true;

    for (const lineItem of line_items) {
        const { product_code, quantity, expected_version } = lineItem;
        if (!product_code || !quantity) continue;

        // FIX: pass movement_type from line item (REFUND / PARTIAL_REFUND / SALE)
        // so the RPC records the correct movement type in inventory_movements table.
        const _movementType = lineItem.movement_type || null;

        const handled = await _processLineItem(
            product_code,
            quantity,
            expected_version ?? item.capturedVersion ?? 1,
            deviceUuid,
            invoice_number,
            _movementType
        );

        if (!handled) {
            allLineItemsHandled = false;
        }
    }

    // ── B3: Cleanup — remove parent queue record once all items handled ───
    if (allLineItemsHandled) {
        // F8b: Mark invoice as fully processed before deleting from queue
        try {
            const _sk = 'pharma_synced_invoices';
            const _ss = new Set(JSON.parse(localStorage.getItem(_sk) || '[]'));
            _ss.add(invoice_number);
            // Cap set size at 500 to avoid unbounded growth
            const _ssArr = [..._ss];
            if (_ssArr.length > 500) _ssArr.splice(0, _ssArr.length - 500);
            localStorage.setItem(_sk, JSON.stringify(_ssArr));
        } catch(_) {}
        try {
            await StorageModule.deleteFromSyncQueue(item.queueId);
        } catch (e) {
            console.error('[SyncEngine] Could not delete queueId', item.queueId, e);
        }
    }
}

// =========================================================================
// SECTION C — LINE ITEM PROCESSING + OCC / OVERSELL RESOLUTION
// =========================================================================

/**
 * _processLineItem(productCode, quantity, expectedVersion, deviceUuid, invoiceNumber)
 *
 * Calls deduct_inventory_atomic.  Parses the returned row and dispatches:
 *   success == true           → writeback to IDB + in-memory array
 *   success == false, "OCC"   → auto-rebase and retry once with fresh version
 *   success == false, "Insuf" → oversell resolution (deduct to zero + debt record)
 *
 * @returns {boolean} true if the item was handled (success or safe mitigation),
 *                    false if a retriable error occurred (leaves parent in queue).
 */
async function _processLineItem(productCode, quantity, expectedVersion, deviceUuid, invoiceNumber, movementType) {
    try {
        const rpcResult = await _callDeductInventoryAtomic(
            productCode, quantity, deviceUuid, invoiceNumber, expectedVersion, movementType
        );

        if (!rpcResult) {
            console.error('[SyncEngine] RPC returned no data for', productCode);
            return false;
        }

        const { success, message, new_version, new_quantity } = rpcResult;

        // ── C1: SUCCESS ──────────────────────────────────────────────────
        if (success) {
            _writeBackStockLocally(productCode, new_quantity, new_version);
            return true;
        }

        // ── C2: OCC CONFLICT — rebase and retry once ─────────────────────
        if (typeof message === 'string' && message.includes('OCC conflict')) {
            return await _handleOccConflict(
                productCode, quantity, deviceUuid, invoiceNumber
            );
        }

        // ── C3: INSUFFICIENT STOCK — oversell resolution ──────────────────
        if (typeof message === 'string' && message.includes('Insufficient stock')) {
            return await _handleOversell(
                productCode, quantity, deviceUuid, invoiceNumber, message
            );
        }

        // Unknown failure message — log and treat as retriable
        console.error('[SyncEngine] Unrecognised RPC failure for', productCode, ':', message);
        return false;

    } catch (e) {
        console.error('[SyncEngine] Exception in _processLineItem for', productCode, e);
        return false;
    }
}

// ── C4: Call the Supabase RPC ─────────────────────────────────────────────
async function _callDeductInventoryAtomic(productCode, quantity, deviceUuid, invoiceNumber, expectedVersion, movementType) {
    // RPC fix: no Supabase JS SDK in this app — use raw fetch POST to /rpc endpoint
    const _rpcBody = {
        p_product_code:     productCode,
        p_quantity:         quantity,
        p_device_uuid:      deviceUuid,
        p_invoice_number:   invoiceNumber,
        p_expected_version: expectedVersion
    };
    // FIX: pass movement_type to RPC so it records REFUND/PARTIAL_REFUND correctly
    if (movementType) _rpcBody.p_movement_type = movementType;
    const response = await fetch(
        (typeof _SUPA_URL !== 'undefined' ? _SUPA_URL : '') + '/rest/v1/rpc/deduct_inventory_atomic',
        {
            method:  'POST',
            headers: typeof _SUPA_HEADERS !== 'undefined'
                ? Object.assign({}, _SUPA_HEADERS, { 'Content-Type': 'application/json' })
                : { 'Content-Type': 'application/json' },
            body: JSON.stringify(_rpcBody)
        }
    );

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        console.error('[SyncEngine] deduct_inventory_atomic RPC error:', errText);
        throw new Error('RPC error: ' + errText);
    }

    const data = await response.json();
    // The stored procedure returns a table; PostgREST wraps it as an array
    return Array.isArray(data) ? data[0] : data;
}

// ── C5: OCC (Optimistic Concurrency Control) rebase ──────────────────────
/**
 * Fetches fresh server state for the product.
 * If server has enough stock, retries the RPC with the fresh version.
 * If server lacks stock, falls through to oversell resolution.
 */
async function _handleOccConflict(productCode, quantity, deviceUuid, invoiceNumber) {
    console.log('[SyncEngine] OCC conflict on', productCode, '— fetching fresh server state…');

    let serverRow;
    try {
        const { data, error } = await _dbSelect(
            'inventory',
            'stock, version',
            'code=eq.' + productCode
        );

        if (error) throw error;
        serverRow = Array.isArray(data) ? data[0] : data;
    } catch (e) {
        console.error('[SyncEngine] Could not fetch server inventory for OCC rebase:', e);
        return false; // Retriable next cycle
    }

    const serverQty     = Number(serverRow?.stock ?? 0);
    const serverVersion = Number(serverRow?.version ?? 1);

    // Server has enough stock → retry with the fresh version
    if (serverQty >= quantity) {
        try {
            const rpcResult = await _callDeductInventoryAtomic(
                productCode, quantity, deviceUuid, invoiceNumber, serverVersion
            );

            if (!rpcResult) return false;

            const { success, message: msg2, new_version: nv, new_quantity: nq } = rpcResult;
            if (success) {
                _writeBackStockLocally(productCode, nq, nv);
                return true;
            }
            // If still failing after rebase, fall through to oversell
            if (typeof msg2 === 'string' && msg2.includes('Insufficient stock')) {
                return await _handleOversell(productCode, quantity, deviceUuid, invoiceNumber, msg2);
            }
            console.error('[SyncEngine] OCC retry still failed:', msg2);
            return false;
        } catch (e) {
            console.error('[SyncEngine] OCC retry threw:', e);
            return false;
        }
    }

    // Server doesn't have enough stock after rebase → treat as oversell
    return await _handleOversell(
        productCode, quantity, deviceUuid, invoiceNumber,
        'Insufficient stock after OCC rebase (server qty=' + serverQty + ')'
    );
}

// ── C6: Oversell resolution ───────────────────────────────────────────────
/**
 * Revenue is real.  Invoice row is kept in the cloud.
 * Deducts available server stock to zero.
 * Logs a debt ADJUSTMENT in inventory_movements.
 * Inserts a sync_conflicts record for MANUAL_REVIEW.
 * Alerts the pharmacist via showToast.
 */
async function _handleOversell(productCode, quantity, deviceUuid, invoiceNumber, originalMessage) {
    console.warn('[SyncEngine] Oversell detected for', productCode, '—', originalMessage);

    // ── Fetch current server stock ─────────────────────────────────────
    let availableQty = 0;
    let serverVersion = 1;
    try {
        const { data, error } = await _dbSelect(
            'inventory',
            'stock, version',
            'code=eq.' + productCode
        );

        if (!error && data) {
            const row = Array.isArray(data) ? data[0] : data;
            availableQty  = Math.max(0, Number(row?.stock ?? 0));
            serverVersion = Number(row?.version ?? 1);
        }
    } catch (e) {
        console.error('[SyncEngine] Could not fetch server stock for oversell mitigation:', e);
    }

    const shortfall = quantity - availableQty;

    // ── Deduct whatever is available (down to zero) ────────────────────
    if (availableQty > 0) {
        try {
            const rpcResult = await _callDeductInventoryAtomic(
                productCode, availableQty, deviceUuid, invoiceNumber, serverVersion
            );
            if (rpcResult?.success) {
                _writeBackStockLocally(productCode, rpcResult.new_quantity, rpcResult.new_version);
            }
        } catch (e) {
            console.error('[SyncEngine] Failed to deduct remaining stock in oversell:', e);
        }
    } else {
        // Nothing to deduct — ensure local stock is zeroed
        _writeBackStockLocally(productCode, 0, serverVersion);
    }

    // ── Log debt ADJUSTMENT in inventory_movements (remote) ───────────
    try {
        const movId =
            (typeof _DEVICE_UUID !== 'undefined' ? _DEVICE_UUID.slice(0, 8) : 'UNKNOWN') +
            '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();

        // F4: Use correct schema column names and raw _dbInsert (no SDK)
        await _dbInsert('inventory_movements', {
            product_code:   productCode,
            quantity_change: -shortfall,      // schema col: quantity_change (not quantity_delta)
            movement_type:  'ADJUSTMENT',
            invoice_number: invoiceNumber,
            device_uuid:    deviceUuid,
            description:    'Oversell debt — requested ' + quantity +
                            ', available ' + availableQty +
                            ', shortfall ' + shortfall,
            moved_at:       new Date().toISOString() // schema col: moved_at (not created_at)
            // id is auto-PK — omitted
        });
    } catch (e) {
        console.error('[SyncEngine] Failed to insert debt ADJUSTMENT movement:', e);
    }

    // ── Push MANUAL_REVIEW record to sync_conflicts ────────────────────
    try {
        // F1.23: sync_conflicts may not exist in schema — wrapped in try/catch,
        // errors are logged but do not block the oversell resolution flow.
        await _dbInsert('sync_conflicts', {
            product_code:      productCode,
            invoice_number:    invoiceNumber,
            device_uuid:       deviceUuid,
            requested_qty:     quantity,
            available_qty:     availableQty,
            shortfall:         shortfall,
            resolution_state:  'MANUAL_REVIEW',
            conflict_reason:   originalMessage || 'Insufficient stock',
            created_at:        new Date().toISOString()
        });
    } catch (e) {
        console.error('[SyncEngine] Failed to insert sync_conflicts record:', e);
    }

    // ── Alert pharmacist ───────────────────────────────────────────────
    if (typeof showToast === 'function') {
        showToast(
            '⚠️ Stock variance: ' + productCode +
            ' — Sold ' + quantity + ' but only ' + availableQty +
            ' available. Shortfall of ' + shortfall + ' logged for MANUAL REVIEW.',
            true
        );
    }

    // Treated as "safely mitigated" — parent queue record will be removed
    return true;
}

// ── C7: Atomic local writeback ────────────────────────────────────────────
/**
 * Writes authoritative server quantity + version back to:
 *   - PharmaInventoryDB 'inventory' store  (via _atomicStockWriteBack if
 *     available, otherwise direct IDB transaction)
 *   - masterInventoryDB in-memory array
 */
function _writeBackStockLocally(productCode, newQuantity, newVersion) {
    const qty = Number(newQuantity);
    const ver = Number(newVersion) || 1;

    // ── Update in-memory array (via safe gateway) ──────────────────────
    // NOTE: getInMemoryCache() returns a structuredClone — mutating it has
    // no effect on the live array. writeStockToCache() directly mutates
    // masterInventoryDB in inventory.js and is the only correct setter.
    if (window.PharmaInventoryEngine && typeof window.PharmaInventoryEngine.writeStockToCache === 'function') {
        window.PharmaInventoryEngine.writeStockToCache(productCode, qty, ver);
    } else if (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB)) {
        const idx = masterInventoryDB.findIndex(p => p.code === productCode);
        if (idx >= 0) {
            masterInventoryDB[idx].stock   = qty;
            masterInventoryDB[idx].version = ver;
        }
    }

    // ── Persist to PharmaInventoryDB ───────────────────────────────────
    // Prefer the dedicated atomic helper from inventory.js if it exists
    if (typeof _atomicStockWriteBack === 'function') {
        try { _atomicStockWriteBack(productCode, qty, ver); } catch (e) {}
        return;
    }

    // Fallback: direct IDB write (via safe gateway)
    const idb = (window.PharmaInventoryEngine && typeof window.PharmaInventoryEngine.getDatabaseHandle === 'function')
        ? window.PharmaInventoryEngine.getDatabaseHandle()
        : ((typeof db !== 'undefined') ? db : null);
    if (!idb) return;

    try {
        const tx    = idb.transaction(['inventory'], 'readwrite');
        const store = tx.objectStore('inventory');
        const req   = store.get(productCode);
        req.onsuccess = function (e) {
            const existing = e.target.result;
            if (!existing) return; // Product not found locally — nothing to update
            const updated = Object.assign({}, existing, {
                stock:   qty,
                version: ver
            });
            store.put(updated);
        };
    } catch (e) {
        console.error('[SyncEngine] IDB writeback failed for', productCode, e);
    }
}

// =========================================================================
// ENTRY POINT — called by _doSwitchTab when user enters Cloud Sync Hub tab
// =========================================================================
async function renderSyncHubView() {
    const container = document.getElementById('syncHubView');
    if (!container) return;

    // ── Inject full skeleton (styles + markup) ────────────────────────────
    container.innerHTML = `
<style>
/* ── Sync Hub — scoped stylesheet ─────────────────────────────────────── */
.sh-root{padding:20px;max-width:1100px;margin:0 auto;font-family:var(--font,system-ui,sans-serif);}

/* Header */
.sh-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap;}
.sh-hdr-left{display:flex;align-items:center;gap:14px;}
.sh-hdr-icon{font-size:32px;line-height:1;}
.sh-hdr-title{font-size:20px;font-weight:800;color:var(--g800,#1e293b);}
.sh-hdr-sub{font-size:11px;color:var(--g400,#94a3b8);margin-top:2px;}
.sh-hdr-actions{display:flex;align-items:center;gap:8px;}

/* Buttons */
.sh-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:6px;font-size:12px;font-weight:800;cursor:pointer;transition:opacity .15s;}
.sh-btn:hover{opacity:.85;}
.sh-btn:active{opacity:.65;}
.sh-btn:disabled{opacity:.45;cursor:not-allowed;}
.sh-btn-teal{background:var(--teal,#0d9488);color:#fff;}
.sh-btn-orange{background:#ea580c;color:#fff;}
.sh-btn-purge{background:#7f1d1d;color:#fff;border:1px solid #ef4444;box-shadow:0 0 0 1px rgba(239,68,68,.25);}
.sh-btn-purge:hover{background:#991b1b;}
.sh-btn-spin{animation:sh-spin .7s linear infinite;display:inline-block;}
@keyframes sh-spin{to{transform:rotate(360deg);}}

/* Metric cards row */
.sh-metrics-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin-bottom:24px;}
.sh-card{background:var(--white,#fff);border:1px solid var(--g200,#e2e8f0);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:6px;}
.sh-card-primary{border-left:4px solid var(--teal,#0d9488);}
.sh-card-lbl{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--g400,#94a3b8);}
.sh-card-big{font-size:40px;font-weight:900;color:var(--teal,#0d9488);line-height:1;min-height:48px;transition:color .25s;}
.sh-card-big.pending{color:var(--red,#dc2626);}
.sh-card-big.clear{color:var(--teal,#0d9488);}
.sh-card-hint{font-size:10px;color:var(--g400,#94a3b8);line-height:1.4;}
.sh-card-field{font-size:15px;font-weight:700;color:var(--g700,#334155);margin-top:4px;}
.sh-card-uuid{font-size:10px;font-family:monospace;color:var(--g400,#94a3b8);word-break:break-all;}
.sh-card-role{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;background:rgba(13,148,136,.1);color:var(--teal,#0d9488);}
.sh-card-sub-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;}
.sh-pill{font-size:10px;padding:3px 8px;background:var(--g100,#f1f5f9);border-radius:10px;color:var(--g600,#475569);font-weight:700;}
.sh-pill-warn{background:rgba(245,158,11,.12);color:#b45309;}

/* Force-sync progress bar */
.sh-progress-wrap{margin-top:8px;display:none;}
.sh-progress-wrap.visible{display:block;}
.sh-progress-bar-track{height:4px;background:var(--g100,#f1f5f9);border-radius:4px;overflow:hidden;}
.sh-progress-bar-fill{height:100%;background:var(--teal,#0d9488);width:0%;transition:width .35s ease;border-radius:4px;}
.sh-progress-label{font-size:10px;color:var(--g500,#64748b);margin-top:4px;font-style:italic;}

/* Matrix section */
.sh-section{background:var(--white,#fff);border:1px solid var(--g200,#e2e8f0);border-radius:10px;overflow:hidden;}
.sh-section-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--g100,#f1f5f9);background:var(--g50,#f8fafc);gap:8px;flex-wrap:wrap;}
.sh-section-title{font-size:13px;font-weight:800;color:var(--g700,#334155);}
.sh-section-sub{font-size:11px;color:var(--g400,#94a3b8);}
.sh-matrix-wrap{padding:10px 14px 16px;overflow-x:auto;}

/* Device table */
.sh-device-table{width:100%;border-collapse:collapse;min-width:540px;}
.sh-th{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--g400,#94a3b8);padding:8px 12px;border-bottom:1px solid var(--g100,#f1f5f9);text-align:left;white-space:nowrap;}
.sh-device-row{border-bottom:1px solid var(--g100,#f1f5f9);transition:background .1s;}
.sh-device-row:hover{background:var(--g50,#f8fafc);}
.sh-device-row:last-child{border-bottom:none;}
.sh-td{padding:10px 12px;font-size:12px;color:var(--g700,#334155);vertical-align:middle;}
.sh-td-name{font-weight:700;font-size:13px;}
.sh-td-uuid{font-family:monospace;font-size:10px;color:var(--g400,#94a3b8);}
.sh-td-role{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:2px 8px;border-radius:10px;background:rgba(13,148,136,.09);color:var(--teal,#0d9488);display:inline-block;}
.sh-status-active{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:800;color:#059669;background:#d1fae5;padding:3px 10px;border-radius:10px;}
.sh-status-offline{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#b45309;background:#fef3c7;padding:3px 10px;border-radius:10px;}
.sh-ago{font-size:11px;font-family:monospace;color:var(--g500,#64748b);}

/* State placeholders */
.sh-loading,.sh-empty,.sh-error{padding:32px;text-align:center;font-size:13px;color:var(--g400,#94a3b8);}
.sh-error{color:#dc2626;}

/* Footer */
.sh-footer{margin-top:14px;font-size:10px;color:var(--g400,#94a3b8);text-align:right;}

@media(max-width:600px){
  .sh-metrics-row{grid-template-columns:1fr;}
  .sh-section-hdr{flex-direction:column;align-items:flex-start;}
}
</style>

<div class="sh-root">

  <!-- ── Header ─────────────────────────────────────────────────────────── -->
  <div class="sh-hdr">
    <div class="sh-hdr-left">
      <span class="sh-hdr-icon">☁️</span>
      <div>
        <div class="sh-hdr-title">Central Cloud Sync Hub</div>
        <div class="sh-hdr-sub">Real-time outbound telemetry &amp; multi-device network matrix</div>
      </div>
    </div>
    <div class="sh-hdr-actions">
      <button class="sh-btn sh-btn-teal" id="shRefreshBtn" onclick="refreshSyncHub()">
        <span id="shRefreshIcon">↺</span> Refresh
      </button>
      <button class="sh-btn sh-btn-teal" id="shOccSimBtn"
              onclick="window.PharmaOCCTest && window.PharmaOCCTest.runSimulation()"
              title="Fire two overlapping checkouts against the same captured version and verify OCC integrity.">
        🧪 OCC Simulation
      </button>
      <button class="sh-btn sh-btn-purge" id="shGlobalPurgeBtn" onclick="openGlobalPurgeModal()"
              title="Wipe all data on every connected device. Requires email OTP + master PIN.">
        ☢️ Global Purge
      </button>
      <button class="sh-btn" id="shCloudPurgeBtn" onclick="openCloudPurgeModal()"
              style="background:#7c3aed;color:#fff;border:1px solid #a78bfa;box-shadow:0 0 0 1px rgba(167,139,250,.25);"
              title="Delete all invoices, inventory and settings from the cloud. Devices stay registered. Requires email OTP + master PIN.">
        🌩️ Cloud Purge
      </button>
    </div>
  </div>

  <!-- ── Metric cards ──────────────────────────────────────────────────── -->
  <div class="sh-metrics-row">

    <!-- PENDING OUTBOUND QUEUE — primary card (Rule 5B) -->
    <div class="sh-card sh-card-primary">
      <div class="sh-card-lbl">⏳ Pending Outbound Movements</div>
      <div class="sh-card-big" id="syncPendingCount">…</div>
      <div class="sh-card-hint">Inventory mutations not yet pushed to Supabase from this counter</div>

      <!-- Breakdown pills -->
      <div class="sh-card-sub-row">
        <span class="sh-pill" id="syncQueueReadyPill">Ready: …</span>
        <span class="sh-pill sh-pill-warn" id="syncQueueBackPill">Backing-off: …</span>
      </div>

      <!-- Force Sync Now button -->
      <button class="sh-btn sh-btn-orange" id="forceSyncBtn"
              onclick="forceSyncNow()" style="margin-top:10px;width:100%;justify-content:center;">
        <span id="forceSyncIcon">⚡</span> Force Sync Now
      </button>

      <!-- Inline progress bar -->
      <div class="sh-progress-wrap" id="shProgressWrap">
        <div class="sh-progress-bar-track">
          <div class="sh-progress-bar-fill" id="shProgressFill"></div>
        </div>
        <div class="sh-progress-label" id="shProgressLabel">Preparing…</div>
      </div>
    </div>

    <!-- THIS-DEVICE CARD -->
    <div class="sh-card">
      <div class="sh-card-lbl">🖥️ This Counter Station</div>
      <div class="sh-card-field" id="shMyDeviceName">…</div>
      <div class="sh-card-uuid"  id="shMyDeviceUUID">…</div>
      <div class="sh-card-role"  id="shMyDeviceRole">…</div>
    </div>

    <!-- LIVE ACTIVE COUNT CARD -->
    <div class="sh-card">
      <div class="sh-card-lbl">📡 Active Stations</div>
      <div class="sh-card-big" id="shActiveCount">…</div>
      <div class="sh-card-hint">Counters with a heartbeat within the last ${SYNC_HUB_ACTIVE_SEC} seconds</div>
    </div>

    <!-- FORCE INVENTORY PULL CARD -->
    <div class="sh-card">
      <div class="sh-card-lbl">⬇️ Force Inventory Pull</div>
      <div class="sh-card-hint" style="margin-bottom:6px;">
        Pulls the latest inventory snapshot and remote invoices/movements from the cloud.
        Your local invoice ledger is preserved — only new remote records are merged in.
      </div>
      <button class="sh-btn sh-btn-teal" id="forcePullBtn"
              onclick="forceInventoryPull()" style="margin-top:6px;width:100%;justify-content:center;">
        <span id="forcePullIcon">⬇️</span> Pull Inventory From Cloud
      </button>
      <div class="sh-progress-wrap" id="shPullProgressWrap">
        <div class="sh-progress-bar-track">
          <div class="sh-progress-bar-fill" id="shPullProgressFill"></div>
        </div>
        <div class="sh-progress-label" id="shPullProgressLabel">Preparing…</div>
      </div>
    </div>

    <!-- PUSH INVENTORY TO CLOUD CARD — Master only -->
    <div class="sh-card" id="shPushInvCard">
      <div class="sh-card-lbl">⬆️ Push Inventory to Cloud</div>
      <div class="sh-card-hint" style="margin-bottom:6px;">
        Pushes the full local inventory catalogue to Supabase so all
        devices can pull the latest stock and product list.
      </div>
      <button class="sh-btn sh-btn-teal" id="forcePushInvBtn"
              onclick="forcePushInventoryToCloud()" style="margin-top:6px;width:100%;justify-content:center;">
        <span id="forcePushInvIcon">⬆️</span> Push Inventory to Cloud
      </button>
      <div class="sh-progress-wrap" id="shPushInvProgressWrap">
        <div class="sh-progress-bar-track">
          <div class="sh-progress-bar-fill" id="shPushInvProgressFill"></div>
        </div>
        <div class="sh-progress-label" id="shPushInvProgressLabel">Preparing…</div>
      </div>
    </div>

  </div>

  <!-- ── Multi-device network matrix (Rule 5C) ─────────────────────────── -->
  <div class="sh-section">
    <div class="sh-section-hdr">
      <span class="sh-section-title">🌐 Multi-Device Counter Log Matrix</span>
      <span class="sh-section-sub">Showing counters active within the last ${SYNC_HUB_PRUNE_DAYS} days</span>
    </div>
    <div id="syncDeviceMatrix" class="sh-matrix-wrap">
      <div class="sh-loading">⟳ Fetching device registry from Supabase…</div>
    </div>
  </div>

  <!-- ── Footer ─────────────────────────────────────────────────────────── -->
  <div class="sh-footer">
    Auto-refreshes every ${SYNC_HUB_REFRESH_MS / 1000} s &nbsp;·&nbsp;
    <span id="shLastRefreshTs">Never refreshed</span>
  </div>

</div>`;

    // My-device card reads from localStorage — synchronous, instant
    _renderMyDeviceCard();

    // Kick off async data in parallel
    await Promise.all([
        _renderPendingQueueWidget(),
        populateSyncHubNetworkGrid()
    ]);
    _stampRefreshTime();

    // ── Auto-refresh loop ──────────────────────────────────────────────────
    if (_syncHubRefreshTimer) clearInterval(_syncHubRefreshTimer);
    _syncHubRefreshTimer = setInterval(() => {
        const view = document.getElementById('syncHubView');
        if (view && view.classList.contains('active')) {
            // Don't disturb widgets mid-force-sync
            if (!_forceSyncRunning) {
                _renderPendingQueueWidget();
                populateSyncHubNetworkGrid();
                _stampRefreshTime();
            }
        } else {
            clearInterval(_syncHubRefreshTimer);
            _syncHubRefreshTimer = null;
        }
    }, SYNC_HUB_REFRESH_MS);
}

// ── Manual Refresh (header button) ────────────────────────────────────────
async function refreshSyncHub() {
    if (_forceSyncRunning) return;
    const btn  = document.getElementById('shRefreshBtn');
    const icon = document.getElementById('shRefreshIcon');
    if (btn)  btn.disabled = true;
    if (icon) icon.className = 'sh-btn-spin';
    await Promise.all([
        _renderPendingQueueWidget(),
        populateSyncHubNetworkGrid()
    ]);
    _stampRefreshTime();
    if (icon) icon.className = '';
    if (btn)  btn.disabled = false;
}

// =========================================================================
// MY-DEVICE CARD — synchronous (localStorage only)
// =========================================================================
function _renderMyDeviceCard() {
    const nameEl = document.getElementById('shMyDeviceName');
    const uuidEl = document.getElementById('shMyDeviceUUID');
    const roleEl = document.getElementById('shMyDeviceRole');
    if (!nameEl) return;

    const myName = (typeof StorageModule !== 'undefined' ? StorageModule.get('pharma_device_name') : null)
                   || 'This Device';
    const myUUID = (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : '—';
    const myRole = (typeof StorageModule !== 'undefined' ? StorageModule.get('pharma_device_role') : null)
                   || 'client';

    nameEl.textContent = myName;
    uuidEl.textContent = myUUID;
    roleEl.textContent = myRole.charAt(0).toUpperCase() + myRole.slice(1);

    // Push Inventory card visible to all registered devices
    const pushCard = document.getElementById('shPushInvCard');
    if (pushCard) pushCard.style.display = '';
}

// =========================================================================
// PENDING OUTBOUND QUEUE WIDGET (Rule 5B)
// Source A: PharmaInventoryDB  inventory_movements / by_synced index
// Source B: StorageModule.syncQueueMetrics()  (general Supabase queue)
// =========================================================================
async function _renderPendingQueueWidget() {
    const countEl   = document.getElementById('syncPendingCount');
    const readyPill = document.getElementById('syncQueueReadyPill');
    const backPill  = document.getElementById('syncQueueBackPill');
    if (!countEl) return;

    // ── Source A: movement-level unsynced count ───────────────────────────
    const movPending = await _countUnsyncedMovements();
    countEl.textContent = movPending.toLocaleString();
    countEl.className   = 'sh-card-big ' + (movPending > 0 ? 'pending' : 'clear');

    // ── Source B: StorageModule general queue (correct public name) ───────
    if (typeof StorageModule !== 'undefined' &&
        typeof StorageModule.syncQueueMetrics === 'function') {
        const m = StorageModule.syncQueueMetrics();
        if (readyPill) readyPill.textContent = 'Ready: '       + (Number(m.ready)   || 0);
        if (backPill)  backPill.textContent  = 'Backing-off: ' + (Number(m.backing)  || 0);
    } else {
        if (readyPill) readyPill.textContent = 'Ready: n/a';
        if (backPill)  backPill.textContent  = 'Backing-off: n/a';
    }
}

// IDB count — reads 'by_synced' index created in PharmaInventoryDB v3 upgrade (inventory.js)
function _countUnsyncedMovements() {
    return new Promise(resolve => {
        const idb = (window.PharmaInventoryEngine && typeof window.PharmaInventoryEngine.getDatabaseHandle === 'function')
            ? window.PharmaInventoryEngine.getDatabaseHandle()
            : ((typeof db !== 'undefined') ? db : null);
        if (!idb) { resolve(0); return; }
        try {
            const tx  = idb.transaction(['inventory_movements'], 'readonly');
            const idx = tx.objectStore('inventory_movements').index('by_synced');
            const req = idx.count(IDBKeyRange.only(false));
            req.onsuccess = () => resolve(Number(req.result) || 0);
            req.onerror   = () => resolve(0);
            tx.onerror    = () => resolve(0);
        } catch (e) { resolve(0); }
    });
}

// =========================================================================
// FORCE SYNC NOW
// =========================================================================
// Step sequence:
//   1. Validate cloud reachability (10 %)
//   2. _pushUnsyncedMovements()  — flush inventory_movements synced==false (45%)
//   3. StorageModule.drainSyncQueue() — flush general Supabase outbound queue (70%)
//   4. syncOfflineQueue()  — drain the structured offline_sync_queue (INVOICE etc.) (85%)
//   5. Refresh widget + grid                                                    (100%)
// =========================================================================
async function forceSyncNow() {
    if (_forceSyncRunning) {
        if (typeof showToast === 'function') showToast('⚠️ Sync already in progress — please wait.', true);
        return;
    }
    _forceSyncRunning = true;

    // ── UI: lock button, reveal progress bar ──────────────────────────────
    const btn       = document.getElementById('forceSyncBtn');
    const icon      = document.getElementById('forceSyncIcon');
    const refBtn    = document.getElementById('shRefreshBtn');
    const progWrap  = document.getElementById('shProgressWrap');
    const progFill  = document.getElementById('shProgressFill');
    const progLabel = document.getElementById('shProgressLabel');

    function _setProgress(pct, label) {
        if (progFill)  progFill.style.width  = pct + '%';
        if (progLabel) progLabel.textContent = label;
    }

    if (btn)     { btn.disabled = true; }
    if (icon)    { icon.textContent = '⟳'; icon.className = 'sh-btn-spin'; }
    if (refBtn)  { refBtn.disabled = true; }
    if (progWrap){ progWrap.classList.add('visible'); }
    _setProgress(5, 'Initialising sync…');

    let totalFlushed  = 0;
    let queueFlushed  = 0;
    let offlineFlushed = 0;
    let errorOccurred = false;

    try {

        // ── STEP 1: Probe cloud reachability ──────────────────────────────
        _setProgress(10, 'Step 1/4 — Checking cloud connectivity…');
        if (typeof showToast === 'function') showToast('☁️ Sync started — checking connection…');

        if (typeof StorageModule !== 'undefined' &&
            StorageModule.get('_supabase_sync_on') !== 'true') {
            try {
                if (typeof _supaGet === 'function') await _supaGet('pharma_cloud_settings');
                StorageModule.setSyncEnabled(true);
                StorageModule.set('_supabase_sync_on', 'true');
            } catch (_probeErr) {
                throw new Error('Cloud unreachable — check internet connection.');
            }
        } else if (typeof StorageModule !== 'undefined') {
            StorageModule.setSyncEnabled(true);
        }

        // ── STEP 2: Flush unsynced inventory movements ────────────────────
        _setProgress(20, 'Step 2/4 — Pushing inventory movements…');
        if (typeof showToast === 'function') showToast('⬆️ Pushing unsynced inventory movements…');

        const preSyncCount = await _countUnsyncedMovements();

        if (typeof _pushUnsyncedMovements === 'function') {
            await _pushUnsyncedMovements();
        }

        const postSyncCount = await _countUnsyncedMovements();
        totalFlushed = Math.max(0, preSyncCount - postSyncCount);
        _setProgress(40, 'Step 2/4 — ' + totalFlushed + ' movement' + (totalFlushed !== 1 ? 's' : '') + ' pushed.');
        if (typeof showToast === 'function') {
            showToast('✅ ' + totalFlushed + ' inventory movement' + (totalFlushed !== 1 ? 's' : '') + ' pushed to Supabase.');
        }

        // ── STEP 2b: Push inventory catalogue (Master only) ───────────────
        // forceSyncNow previously never called _pushInventoryBootstrapToCloud(), so
        // the relational `inventory` table was only populated by the Push button or
        // CSV import — never by Force Sync. Clients would therefore never receive
        // catalogue updates on demand. This step closes that gap.
        const _fsRole = (typeof StorageModule !== 'undefined')
            ? StorageModule.get('pharma_device_role') : null;
        if (_fsRole === 'master' && typeof _pushInventoryBootstrapToCloud === 'function') {
            _setProgress(45, 'Step 2b — Pushing inventory catalogue…');
            if (typeof showToast === 'function') showToast('⬆️ Pushing inventory catalogue to cloud…');
            try {
                await _pushInventoryBootstrapToCloud();
            } catch(_invPushErr) {
                console.warn('[ForceSyncNow] Inventory push failed (non-fatal):', _invPushErr);
            }
        }
        _setProgress(50, 'Step 3/4 — Draining outbound queue…');
        if (typeof showToast === 'function') showToast('⬆️ Draining outbound sync queue…');

        const preMetrics = (typeof StorageModule !== 'undefined' &&
                            typeof StorageModule.syncQueueMetrics === 'function')
                           ? StorageModule.syncQueueMetrics()
                           : { total: 0 };
        const preQueueTotal = Number(preMetrics.total) || 0;

        if (typeof StorageModule !== 'undefined' &&
            typeof StorageModule.drainSyncQueue === 'function') {
            await StorageModule.drainSyncQueue();
        }

        const postMetrics = (typeof StorageModule !== 'undefined' &&
                             typeof StorageModule.syncQueueMetrics === 'function')
                            ? StorageModule.syncQueueMetrics()
                            : { total: 0 };
        const postQueueTotal = Number(postMetrics.total) || 0;
        queueFlushed = Math.max(0, preQueueTotal - postQueueTotal);

        _setProgress(65, 'Step 3/4 — ' + queueFlushed + ' queued item' + (queueFlushed !== 1 ? 's' : '') + ' sent.');
        if (typeof showToast === 'function') {
            showToast('✅ ' + queueFlushed + ' queued item' + (queueFlushed !== 1 ? 's' : '') + ' sent to Supabase.');
        }

        // ── STEP 4: Drain structured offline_sync_queue (INVOICE records) ─
        _setProgress(70, 'Step 4/4 — Syncing offline invoice queue…');
        if (typeof showToast === 'function') showToast('⬆️ Syncing offline invoice queue…');

        let preOfflineItems = [];
        try { preOfflineItems = await StorageModule.getSyncQueueOrdered(); } catch (_e) {}
        const preOfflineCount = preOfflineItems.length;

        // Release the guard so syncOfflineQueue can run; we hold UI lock via btn.disabled
        _forceSyncRunning = false;
        await syncOfflineQueue(
            (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : 'UNKNOWN'
        );
        _forceSyncRunning = true; // reclaim guard for the rest of forceSyncNow

        let postOfflineItems = [];
        try { postOfflineItems = await StorageModule.getSyncQueueOrdered(); } catch (_e) {}
        offlineFlushed = Math.max(0, preOfflineCount - postOfflineItems.length);

        _setProgress(85, 'Step 4/4 — ' + offlineFlushed + ' offline item' + (offlineFlushed !== 1 ? 's' : '') + ' synced.');
        if (typeof showToast === 'function') {
            showToast('✅ ' + offlineFlushed + ' offline invoice item' + (offlineFlushed !== 1 ? 's' : '') + ' synced.');
        }

        // Update the sync badge if it exists in the DOM
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('connected');

        // ── STEP 5: Pull latest inventory from master (FIX 3) ─────────────
        // forceSyncNow() previously skipped _checkAndPullInventoryIfUpdated() —
        // it only ran in the 60-second background timer. This meant a Force Sync
        // immediately after a CSV import on master would NOT update client inventory.
        _setProgress(88, 'Step 5/5 — Checking for inventory updates…');
        if (typeof showToast === 'function') showToast('⬇️ Checking for inventory updates from master…');
        try {
            if (typeof _checkAndPullInventoryIfUpdated === 'function') {
                await _checkAndPullInventoryIfUpdated();
                if (typeof showToast === 'function') showToast('✅ Inventory check complete.');
            }
        } catch (_invErr) {
            // Non-fatal — inventory pull failure should not abort the sync summary
            console.warn('[ForceSyncNow] Inventory pull failed:', _invErr);
        }

    } catch (err) {
        errorOccurred = true;
        _setProgress(100, '❌ ' + ((err && err.message) ? _escHtml(err.message) : 'Sync failed'));
        if (typeof showToast === 'function') {
            showToast('❌ Force sync failed: ' + ((err && err.message) ? err.message : String(err)), true);
        }
        if (typeof updateSupabaseSyncUI === 'function') updateSupabaseSyncUI('offline');
    }

    // ── STEP 6: Refresh widget counts ─────────────────────────────────────
    _setProgress(95, 'Refreshing metrics…');
    await _renderPendingQueueWidget();
    await populateSyncHubNetworkGrid();
    _stampRefreshTime();
    const grandTotal = totalFlushed + queueFlushed + offlineFlushed;
    _setProgress(100, errorOccurred
        ? '❌ Sync incomplete — see toasts above'
        : '✅ All done — ' + grandTotal + ' item' + (grandTotal !== 1 ? 's' : '') + ' synced.'
    );

    // ── UI: restore button, hide progress bar after 3 s ───────────────────
    setTimeout(() => {
        if (icon)    { icon.className = ''; icon.textContent = '⚡'; }
        if (btn)     { btn.disabled = false; }
        if (refBtn)  { refBtn.disabled = false; }
        if (progWrap){ progWrap.classList.remove('visible'); }
        _forceSyncRunning = false;
    }, 3000);
}

// =========================================================================
// FORCE INVENTORY PULL — client-side on-demand cloud refresh
// -------------------------------------------------------------------------
// Pulls the latest inventory snapshot from Supabase and merges any remote
// invoices / inventory_movements from OTHER devices into the local stores.
// IMPORTANT: the local invoice ledger is NEVER cleared — only new remote
// records are merged in, exactly like the background auto-sync does.
// =========================================================================
async function forceInventoryPull() {
    if (_forceSyncRunning) {
        if (typeof showToast === 'function') showToast('⚠️ A sync is already running — please wait.', true);
        return;
    }
    _forceSyncRunning = true;

    const btn       = document.getElementById('forcePullBtn');
    const icon      = document.getElementById('forcePullIcon');
    const progWrap  = document.getElementById('shPullProgressWrap');
    const progFill  = document.getElementById('shPullProgressFill');
    const progLabel = document.getElementById('shPullProgressLabel');

    function _setProg(pct, label) {
        if (progFill)  progFill.style.width  = pct + '%';
        if (progLabel) progLabel.textContent = label;
    }

    if (btn)      btn.disabled = true;
    if (icon)   { icon.textContent = '⟳'; icon.className = 'sh-btn-spin'; }
    if (progWrap) progWrap.classList.add('visible');
    _setProg(5, 'Starting cloud pull…');

    let invPulled       = 0;
    let invoicesMerged  = 0;
    let movementsMerged = 0;
    let errorOccurred   = false;

    try {
        // ── STEP 1: Inventory snapshot ────────────────────────────────────
        _setProg(15, 'Step 1/3 — Pulling inventory snapshot…');
        if (typeof showToast === 'function') showToast('⬇️ Pulling inventory from cloud…');
        if (typeof _pullInventoryFromSupabase === 'function') {
            const ok = await _pullInventoryFromSupabase(true); // force=true: skip bootstrap_done guard
            if (ok && Array.isArray(window.masterInventoryDB)) {
                invPulled = window.masterInventoryDB.length;
            }
        }
        _setProg(45, 'Step 1/3 — ' + invPulled + ' product' + (invPulled !== 1 ? 's' : '') + ' loaded.');

        // ── STEP 2: Merge remote invoices from other devices ──────────────
        _setProg(55, 'Step 2/3 — Merging remote invoices…');
        try {
            const { data: devRows } = await _dbSelect('devices', 'is_active=eq.true', 'uuid');
            const otherUUIDs = (devRows || []).map(d => d.uuid).filter(u => u && u !== _DEVICE_UUID);

            for (const uuid of otherUUIDs) {
                try {
                    const { data: invoices } = await _dbSelect(
                        'invoices',
                        'device_uuid=eq.' + encodeURIComponent(uuid) + '&order=billed_at.desc&limit=200',
                        '*,invoice_items(*)'
                    );
                    if (!Array.isArray(invoices)) continue;
                    for (const inv of invoices) {
                        try {
                            if (typeof StorageModule !== 'undefined' &&
                                typeof StorageModule.putRemoteInvoice === 'function') {
                                await StorageModule.putRemoteInvoice(inv);
                                invoicesMerged++;
                            }
                        } catch(_e) {}
                    }
                } catch(_e) {}
            }
        } catch(_e) { /* non-fatal */ }
        _setProg(75, 'Step 2/3 — ' + invoicesMerged + ' remote invoice' + (invoicesMerged !== 1 ? 's' : '') + ' merged.');

        // ── STEP 3: Merge remote inventory_movements (audit trail only) ───
        _setProg(80, 'Step 3/3 — Merging movement audit log…');
        try {
            const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: movs } = await _dbSelect(
                'inventory_movements',
                'moved_at=gt.' + encodeURIComponent(cutoff) + '&order=moved_at.desc&limit=2000',
                '*'
            );
            if (Array.isArray(movs) && movs.length > 0) {
                const idb = (window.PharmaInventoryEngine &&
                             typeof window.PharmaInventoryEngine.getDatabaseHandle === 'function')
                    ? window.PharmaInventoryEngine.getDatabaseHandle()
                    : ((typeof db !== 'undefined') ? db : null);
                if (idb) {
                    try {
                        const tx = idb.transaction(['inventory_movements'], 'readwrite');
                        const st = tx.objectStore('inventory_movements');
                        for (const m of movs) {
                            if (!m || !m.movement_id) continue;
                            if (m.device_uuid === _DEVICE_UUID) continue; // skip our own
                            // SCHEMA FIX: IDB keyPath is 'movementId' (camelCase) —
                            // must map all Supabase snake_case fields to IDB camelCase
                            try { st.put({
                                movementId:     m.movement_id,
                                productCode:    m.product_code,
                                quantityChange: Number(m.quantity_change) || 0,
                                stockAfter:     typeof m.stock_after === 'number' ? m.stock_after : 0,
                                movementType:   m.movement_type   || 'ADJUSTMENT',
                                invoiceId:      m.invoice_number  || null,
                                description:    m.description     || null,
                                timestamp:      m.moved_at ? new Date(m.moved_at).getTime() : Date.now(),
                                deviceCode:     m.counter_id      || '',
                                deviceUUID:     m.device_uuid     || '',
                                synced:         true
                            }); movementsMerged++; } catch(_e) {}
                        }
                    } catch(_e) {}
                }
            }
        } catch(_e) { /* non-fatal */ }

        _setProg(95, 'Refreshing UI…');
        if (typeof renderInventoryView === 'function') {
            try { renderInventoryView(); } catch(_e) {}
        }
        if (typeof showToast === 'function') {
            showToast('✅ Pulled ' + invPulled + ' products, ' + invoicesMerged +
                      ' invoices, ' + movementsMerged + ' movement record' +
                      (movementsMerged !== 1 ? 's' : '') + '.');
        }
    } catch (err) {
        errorOccurred = true;
        if (typeof showToast === 'function') {
            showToast('❌ Pull failed: ' + ((err && err.message) ? err.message : String(err)), true);
        }
    }

    _setProg(100, errorOccurred ? '❌ Pull incomplete — see toasts above'
                                : '✅ Pull complete.');

    setTimeout(() => {
        if (icon)    { icon.className = ''; icon.textContent = '⬇️'; }
        if (btn)     { btn.disabled = false; }
        if (progWrap){ progWrap.classList.remove('visible'); }
        _forceSyncRunning = false;
    }, 2500);
}


// =========================================================================
// FORCE PUSH INVENTORY TO CLOUD — Master device only
// Pushes full local inventory to the Supabase `inventory` table and writes
// the inventory_last_updated signal so clients auto-pull within 60 seconds.
// =========================================================================
async function forcePushInventoryToCloud() {
    if (_forceSyncRunning) {
        if (typeof showToast === 'function') showToast('⚠️ A sync is already running — please wait.', true);
        return;
    }

    const items = Array.isArray(window.masterInventoryDB) ? window.masterInventoryDB : [];
    if (items.length === 0) {
        if (typeof showToast === 'function') showToast('⚠️ No local inventory to push. Import a CSV first.', true);
        return;
    }

    _forceSyncRunning = true;

    const btn       = document.getElementById('forcePushInvBtn');
    const icon      = document.getElementById('forcePushInvIcon');
    const progWrap  = document.getElementById('shPushInvProgressWrap');
    const progFill  = document.getElementById('shPushInvProgressFill');
    const progLabel = document.getElementById('shPushInvProgressLabel');

    function _setProg(pct, label) {
        if (progFill)  progFill.style.width  = pct + '%';
        if (progLabel) progLabel.textContent = label;
    }

    if (btn)      btn.disabled = true;
    if (icon)   { icon.textContent = '⟳'; icon.className = 'sh-btn-spin'; }
    if (progWrap) progWrap.classList.add('visible');
    _setProg(5, 'Preparing inventory batch…');

    let pushed = 0;
    let errorOccurred = false;

    try {
        if (typeof showToast === 'function')
            showToast('⬆️ Pushing ' + items.length + ' products to cloud…');

        // Map IDB rows to Supabase shape
        const rows = items.map(function(item) {
            const now = new Date().toISOString();
            return {
                code:         item.code,
                name:         item.name         || '',
                generic_name: item.generic      || '',
                company:      item.company      || '',
                supplier:     item.supplier     || '',
                pack_size:    item.packDetails  || '',
                unit_price:   parseFloat((Number(item.unitPrice) || 0).toFixed(2)),
                stock:        parseInt(item.stock, 10) || 0,
                version:      (typeof item.version === 'number' && item.version >= 1) ? item.version : 1,
                uploaded_by:  _DEVICE_UUID,
                uploaded_at:  now,
                updated_at:   now
            };
        });

        // Push in batches of 500
        const BATCH = 500;
        const totalBatches = Math.ceil(rows.length / BATCH);

        for (let i = 0; i < rows.length; i += BATCH) {
            const batchNum = Math.floor(i / BATCH) + 1;
            _setProg(5 + Math.round((batchNum / totalBatches) * 80),
                     'Batch ' + batchNum + ' / ' + totalBatches + '…');

            const batch = rows.slice(i, i + BATCH);
            const { error } = await _dbUpsert('inventory', batch, 'code');
            if (error) {
                if (typeof showToast === 'function')
                    showToast('❌ Push failed at batch ' + batchNum + ': ' + error, true);
                errorOccurred = true;
                break;
            }
            pushed += batch.length;
        }

        if (!errorOccurred) {
            // Write bootstrap_done + inventory_last_updated signals
            const now = new Date().toISOString();
            await _dbUpsert('settings', [{
                device_uuid: _DEVICE_UUID,
                key:         'inventory_bootstrap_done',
                value:       'true',
                updated_at:  now
            }], 'device_uuid,key');
            await _dbUpsert('settings', [{
                device_uuid: _DEVICE_UUID,
                key:         'inventory_last_updated',
                value:       now,
                updated_at:  now
            }], 'device_uuid,key');

            _setProg(100, '✅ ' + pushed + ' products pushed to cloud.');
            if (typeof showToast === 'function')
                showToast('✅ Inventory pushed (' + pushed + ' products). Clients will auto-pull within 60 s.');
        }

    } catch (err) {
        errorOccurred = true;
        if (typeof showToast === 'function')
            showToast('❌ Push failed: ' + ((err && err.message) ? err.message : String(err)), true);
        _setProg(100, '❌ Push failed — check connection.');
    }

    setTimeout(function() {
        if (icon)    { icon.className = ''; icon.textContent = '⬆️'; }
        if (btn)     { btn.disabled = false; }
        if (progWrap){ progWrap.classList.remove('visible'); }
        _forceSyncRunning = false;
    }, 2500);
}
window.forcePushInventoryToCloud = forcePushInventoryToCloud;

// =========================================================================
// MULTI-DEVICE COUNTER LOG MATRIX (Rule 5C)
// =========================================================================
async function populateSyncHubNetworkGrid() {
    const grid          = document.getElementById('syncDeviceMatrix');
    const activeCountEl = document.getElementById('shActiveCount');
    if (!grid) return;

    grid.innerHTML = '<div class="sh-loading">⟳ Fetching device registry from Supabase…</div>';

    // ── Fetch from relational `devices` table (Phase 1) ───────────────────
    // (Migrated from legacy pharma_sync KV blob 'pharma_devices', which is no
    //  longer written by devices.js — heartbeats go straight to the table.)
    let devices = [];
    try {
        const { data, error } = await _dbSelect('devices', 'order=last_seen_at.desc', '*');
        if (error) throw new Error(error);
        const rows = Array.isArray(data) ? data : [];
        devices = rows.map(r => ({
            uuid:     r.uuid,
            name:     r.name        || '—',
            role:     r.role        || 'client',
            lastSeen: r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0,
            status:   (r.is_active === false) ? 'archived' : 'active',
            counter_id: r.counter_id || ''
        }));
    } catch (e) {
        grid.innerHTML = '<div class="sh-error">⚠️ Could not reach Supabase — ' + _escHtml(e.message || 'check connection') + '</div>';
        if (activeCountEl) activeCountEl.textContent = '—';
        return;
    }

    const now    = Date.now();
    const cutoff = now - SYNC_HUB_PRUNE_DAYS * 24 * 60 * 60 * 1000;

    // ── Fix 9: Diagnostic banner when Supabase returned only 1 device ─────
    // This usually means the second device's row was never written (silent
    // registration failure) OR Supabase RLS is blocking cross-device reads.
    if (devices.length === 1) {
        const _diagEl = document.createElement('div');
        _diagEl.style.cssText = 'background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:10px;font-size:12px;color:#92400e;line-height:1.5;';
        _diagEl.innerHTML = '<strong>⚠️ Only 1 device row found in Supabase.</strong> '
            + 'If a second device is enrolled, its registration may have failed silently, '
            + 'or Supabase RLS is restricting reads to own row only.<br>'
            + '<strong>Diagnostic steps:</strong> '
            + '(1) On the missing device open Sync Hub → tap <em>Refresh</em> to force a heartbeat. '
            + '(2) Check Supabase → Table Editor → <code style="font-family:monospace;">devices</code> — '
            + 'both devices should have <code style="font-family:monospace;">is_active = true</code> and recent <code style="font-family:monospace;">last_seen_at</code>. '
            + '(3) If only one row exists, check RLS policy: <code style="font-family:monospace;">anon</code> role must have SELECT on all rows.';
        if (grid.parentNode) grid.parentNode.insertBefore(_diagEl, grid);
    }

    // ── Prune devices not seen in the last 7 days ──────────────────────────
    const liveDevices = devices.filter(d => d && (Number(d.lastSeen) || 0) >= cutoff);

    // Active-now count (< 120 s)
    const activeNow = liveDevices.filter(
        d => (now - (Number(d.lastSeen) || 0)) < SYNC_HUB_ACTIVE_SEC * 1000
    ).length;
    if (activeCountEl) activeCountEl.textContent = String(activeNow);

    if (liveDevices.length === 0) {
        const _prunedHint = devices.length > 0
            ? ' (' + devices.length + ' device' + (devices.length !== 1 ? 's' : '') + ' exist in Supabase but have not sent a heartbeat in ' + SYNC_HUB_PRUNE_DAYS + ' days — use Refresh on each device to restore visibility.)'
            : '';
        grid.innerHTML = '<div class="sh-empty">📭 No device profiles found within the last ' +
                         SYNC_HUB_PRUNE_DAYS + ' days.' + _prunedHint + '</div>';
        return;
    }

    // Sort: most recent heartbeat first
    liveDevices.sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));

    // Split into active and archived/purged sections
    const activeDevices   = liveDevices.filter(d => d.status !== 'archived' && d.status !== 'purged');
    const archivedDevices = liveDevices.filter(d => d.status === 'archived' || d.status === 'purged');

    function _buildDeviceRow(d, isArchive = false) {
        const lastSeen = Number(d.lastSeen) || 0;
        const ageSec   = Math.floor((now - lastSeen) / 1000);
        const isActive = ageSec < SYNC_HUB_ACTIVE_SEC;
        const statusHtml = isActive
            ? '<span class="sh-status-active">🟢 Active Now</span>'
            : '<span class="sh-status-offline">🟡 Offline</span>';
        let agoLabel;
        if      (ageSec <   60) { agoLabel = ageSec + 's ago'; }
        else if (ageSec < 3600) { agoLabel = Math.floor(ageSec / 60) + ' min ago'; }
        else if (ageSec < 86400){ agoLabel = Math.floor(ageSec / 3600) + ' hr ago'; }
        else { const d2 = Math.floor(ageSec / 86400); agoLabel = d2 + ' day' + (d2 !== 1 ? 's' : '') + ' ago'; }
        const roleLabel = d.role ? (d.role.charAt(0).toUpperCase() + d.role.slice(1)) : 'Client';
        const uuidRaw  = String(d.uuid || '—');
        const uuidShow = uuidRaw.length > 16 ? uuidRaw.slice(0, 8) + '…' + uuidRaw.slice(-4) : uuidRaw;
        const statusBadge = d.status === 'archived' ? ' <span style="font-size:10px;font-weight:800;color:var(--g500);background:var(--g100);border-radius:3px;padding:1px 5px;margin-left:4px;">ARCHIVED</span>' :
                            d.status === 'purged'   ? ' <span style="font-size:10px;font-weight:800;color:var(--red);background:#fee2e2;border-radius:3px;padding:1px 5px;margin-left:4px;">PURGED</span>' : '';
        const deleteBtn = isArchive
            ? `<td class="sh-td" style="text-align:center;"><button onclick="DevicesModule._deleteDevice('${_escHtml(d.uuid)}')" title="Permanently delete from registry" style="padding:3px 8px;background:#7f1d1d;color:#fff;border:none;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">🗑 Delete</button></td>`
            : '';
        return `<tr class="sh-device-row">
  <td class="sh-td sh-td-name">${_escHtml(d.name || '—')}${statusBadge}</td>
  <td class="sh-td sh-td-uuid" title="${_escHtml(uuidRaw)}">${_escHtml(uuidShow)}</td>
  <td class="sh-td"><span class="sh-td-role">${_escHtml(roleLabel)}</span></td>
  <td class="sh-td">${statusHtml}</td>
  <td class="sh-td sh-ago">${_escHtml(agoLabel)}</td>${deleteBtn}
</tr>`;
    }

    const theadHtml = `<thead><tr>
      <th class="sh-th">Counter Station Name</th>
      <th class="sh-th">Hardware ID</th>
      <th class="sh-th">Role</th>
      <th class="sh-th">Live Status</th>
      <th class="sh-th">Cloud Sync Delta</th>
    </tr></thead>`;

    const archiveTheadHtml = `<thead><tr>
      <th class="sh-th">Counter Station Name</th>
      <th class="sh-th">Hardware ID</th>
      <th class="sh-th">Role</th>
      <th class="sh-th">Live Status</th>
      <th class="sh-th">Cloud Sync Delta</th>
      <th class="sh-th">Action</th>
    </tr></thead>`;

    let html = `<table class="sh-device-table" aria-label="Device Network Matrix">
  ${theadHtml}
  <tbody>${activeDevices.map(d => _buildDeviceRow(d, false)).join('')}</tbody>
</table>`;

    if (archivedDevices.length > 0) {
        const archId = 'sh-arch-' + Date.now();
        html += `<details class="sh-arch-section" style="margin-top:12px;border:1px solid var(--g200);border-radius:6px;overflow:hidden;">
  <summary style="padding:8px 14px;cursor:pointer;font-size:11px;font-weight:800;color:var(--g600);background:var(--g50);user-select:none;">
    🗄 Archived / Purged Devices (${archivedDevices.length})
  </summary>
  <table class="sh-device-table" id="${_escHtml(archId)}" style="border-top:1px solid var(--g200);">
    ${archiveTheadHtml}
    <tbody>${archivedDevices.map(d => _buildDeviceRow(d, true)).join('')}</tbody>
  </table>
</details>`;
    }

    grid.innerHTML = html;
}

// =========================================================================
// UTILITIES
// =========================================================================
function _stampRefreshTime() {
    const el = document.getElementById('shLastRefreshTs');
    if (!el) return;
    const t  = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    el.textContent = 'Last updated: ' + hh + ':' + mm + ':' + ss;
}

// =========================================================================
// ☢️ GLOBAL PURGE — wipes all data from every active device + cloud.
// Double verification:
//   1. 8-digit OTP emailed via EmailJS to RESET_EMAIL_ADDRESS
//   2. 8-digit Admin PIN (existing _verifyPassword)
// Any registered device can initiate. Both factors required.
// Spec keys:
//   - pharma_global_purge_otp  : { pin, expiresAt }  (consumed on use)
//   - pharma_global_purge_cmd  : { issuedAt, expiresAt, issuedBy }
// =========================================================================

const _GP_OTP_KEY  = 'pharma_global_purge_otp';
const _GP_CMD_KEY  = 'pharma_global_purge_cmd';
const _GP_OTP_TTL  = 10 * 60 * 1000;   // 10 min
const _GP_CMD_TTL  =  5 * 60 * 1000;   // 5 min broadcast window

let _gpOtpEntered = '';
let _gpPinEntered = '';

async function openGlobalPurgeModal() {
    _gpOtpEntered = '';
    _gpPinEntered = '';
    let modal = document.getElementById('gpModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'gpModal';
        modal.innerHTML = `
<style>
.gp-overlay{position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}
.gp-card{background:#fff;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;border-radius:14px;border:2px solid #7f1d1d;box-shadow:0 30px 80px rgba(0,0,0,.45);}
.gp-hdr{padding:16px 20px;background:linear-gradient(135deg,#7f1d1d,#991b1b);color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;}
.gp-hdr-title{font-size:16px;font-weight:900;letter-spacing:.4px;}
.gp-hdr-sub{font-size:11px;opacity:.85;margin-top:2px;}
.gp-x{background:rgba(255,255,255,.15);color:#fff;border:none;width:30px;height:30px;border-radius:50%;font-size:18px;cursor:pointer;font-weight:800;}
.gp-body{padding:20px;}
.gp-step-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#7f1d1d;margin-bottom:10px;}
.gp-warn{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.55;margin-bottom:14px;}
.gp-dev-list{border:1px solid #e2e8f0;border-radius:8px;max-height:200px;overflow-y:auto;margin-bottom:14px;}
.gp-dev-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;}
.gp-dev-row:last-child{border-bottom:none;}
.gp-dev-name{font-weight:700;color:#334155;}
.gp-dev-uuid{font-family:monospace;font-size:10px;color:#94a3b8;}
.gp-stat-on{font-size:10px;font-weight:800;color:#059669;background:#d1fae5;padding:2px 8px;border-radius:10px;}
.gp-stat-off{font-size:10px;font-weight:800;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:10px;}
.gp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;}
.gp-btn{padding:9px 16px;border:none;border-radius:6px;font-size:12px;font-weight:800;cursor:pointer;}
.gp-btn-ghost{background:#f1f5f9;color:#475569;}
.gp-btn-primary{background:#7f1d1d;color:#fff;}
.gp-btn-primary:disabled{opacity:.5;cursor:not-allowed;}
.gp-status{font-size:12px;color:#64748b;margin-top:8px;min-height:18px;}
.gp-dots{display:flex;gap:8px;justify-content:center;margin:14px 0;}
.gp-dot{width:18px;height:18px;border-radius:50%;border:2px solid #cbd5e1;background:#fff;transition:all .15s;}
.gp-dot.filled{background:#7f1d1d;border-color:#7f1d1d;}
.gp-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:280px;margin:0 auto;}
.gp-key{padding:14px 0;font-size:18px;font-weight:800;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;color:#334155;}
.gp-key:hover{background:#e2e8f0;}
.gp-key-back{background:#fef3c7;color:#b45309;}
.gp-progress{font-family:monospace;font-size:11px;background:#0f172a;color:#86efac;padding:12px;border-radius:8px;white-space:pre-wrap;max-height:240px;overflow-y:auto;}
</style>
<div class="gp-overlay" onclick="if(event.target===this)closeGlobalPurgeModal()">
  <div class="gp-card">
    <div class="gp-hdr">
      <div>
        <div class="gp-hdr-title">☢️ Global Purge</div>
        <div class="gp-hdr-sub">Irreversibly wipe all data from every device and the cloud</div>
      </div>
      <button class="gp-x" onclick="closeGlobalPurgeModal()">×</button>
    </div>
    <div class="gp-body" id="gpBody"></div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = '';
    await _gpRenderStep1();
}

function closeGlobalPurgeModal() {
    const m = document.getElementById('gpModal');
    if (m) m.style.display = 'none';
    _gpOtpEntered = '';
    _gpPinEntered = '';
}

// ── STEP 1: pre-flight + send OTP ────────────────────────────────────────
async function _gpRenderStep1() {
    const body = document.getElementById('gpBody');
    if (!body) return;
    body.innerHTML = `
<div class="gp-step-title">Step 1 / 3 — Pre-flight Check</div>
<div class="gp-warn">
  <b>⚠️ This action is irreversible.</b> All invoices, inventory, history, settings,
  and cloud KV data will be permanently deleted on <b>every device</b> currently
  registered. Offline devices will be purged the moment they reconnect (up to 5 min).
</div>
<div id="gpDevList" class="gp-dev-list">Loading device registry…</div>
<div class="gp-actions">
  <button class="gp-btn gp-btn-ghost" onclick="closeGlobalPurgeModal()">Cancel</button>
  <button class="gp-btn gp-btn-primary" id="gpSendOtpBtn" onclick="_gpSendOtp()" disabled>
    📧 Send Purge OTP to Email
  </button>
</div>
<div class="gp-status" id="gpStatus"></div>`;

    // Fetch live device registry
    const listEl = document.getElementById('gpDevList');
    const btn = document.getElementById('gpSendOtpBtn');
    try {
        const { data: rows, error: derr } = await _dbSelect('devices', 'order=last_seen_at.desc', '*');
        if (derr) throw new Error(derr);
        const now = Date.now();
        const cutoff = now - SYNC_HUB_PRUNE_DAYS * 24 * 60 * 60 * 1000;
        let devices = (Array.isArray(rows) ? rows : [])
            .map(r => ({
                uuid: r.uuid,
                name: r.name || '—',
                lastSeen: r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0,
                status: (r.is_active === false) ? 'archived' : 'active'
            }))
            .filter(d => d.lastSeen >= cutoff)
            .filter(d => d.status !== 'archived' && d.status !== 'purged');

        if (devices.length === 0) {
            listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#94a3b8;font-size:12px;">No active devices found.</div>';
        } else {
            let offlineCount = 0;
            const rowsHtml = devices.map(d => {
                const age = now - (Number(d.lastSeen) || 0);
                const active = age < SYNC_HUB_ACTIVE_SEC * 1000;
                if (!active) offlineCount++;
                const uuidShow = String(d.uuid || '').slice(0, 8) + '…';
                return `<div class="gp-dev-row">
                  <div>
                    <div class="gp-dev-name">${_escHtml(d.name || '—')}</div>
                    <div class="gp-dev-uuid">${_escHtml(uuidShow)}</div>
                  </div>
                  ${active ? '<span class="gp-stat-on">🟢 Active Now</span>' : '<span class="gp-stat-off">🟡 Offline</span>'}
                </div>`;
            }).join('');
            listEl.innerHTML = rowsHtml;
            if (offlineCount > 0) {
                const s = document.getElementById('gpStatus');
                if (s) { s.textContent = '⚠️ ' + offlineCount + ' device(s) offline — they will purge on reconnect (within 5 min).'; s.style.color = '#b45309'; }
            }
        }
        if (btn) btn.disabled = false;
    } catch (e) {
        listEl.innerHTML = '<div style="padding:14px;text-align:center;color:#dc2626;font-size:12px;">❌ Could not reach cloud. Check your connection.</div>';
    }
}

async function _gpSendOtp() {
    const btn = document.getElementById('gpSendOtpBtn');
    const status = document.getElementById('gpStatus');
    if (!RESET_EMAIL_ADDRESS || RESET_EMAIL_ADDRESS.includes('YOUR_')) {
        status.textContent = '❌ Reset email not configured in config.js.'; status.style.color = '#dc2626'; return;
    }
    if (typeof emailjs === 'undefined') {
        status.textContent = '❌ EmailJS library not loaded.'; status.style.color = '#dc2626'; return;
    }
    btn.disabled = true; btn.textContent = 'Sending…';
    status.style.color = '#64748b'; status.textContent = 'Generating OTP…';

    const otp = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = Date.now() + _GP_OTP_TTL;

    try {
        const ok = await _supaSet(_GP_OTP_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Cloud write failed');
    } catch (e) {
        status.textContent = '❌ Could not save OTP to cloud.'; status.style.color = '#dc2626';
        btn.disabled = false; btn.textContent = '📧 Send Purge OTP to Email'; return;
    }

    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  (bi.businessName || bi.branchName || 'Pharma POS') + ' — ☢️ GLOBAL PURGE',
            counter_id: bi.counterId || '',
            expires_in: '10 minutes'
        }, EMAILJS_PUBLIC_KEY);
        status.textContent = '✅ OTP sent. Check your inbox.'; status.style.color = '#059669';
        setTimeout(_gpRenderStep2, 800);
    } catch (err) {
        try { await _supaDel(_GP_OTP_KEY); } catch (_e) {}
        status.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown error');
        status.style.color = '#dc2626';
        btn.disabled = false; btn.textContent = '📧 Send Purge OTP to Email';
    }
}

// ── STEP 2: OTP entry ────────────────────────────────────────────────────
function _gpRenderStep2() {
    _gpOtpEntered = '';
    const body = document.getElementById('gpBody');
    if (!body) return;
    body.innerHTML = `
<div class="gp-step-title">Step 2 / 3 — Enter Purge OTP</div>
<div class="gp-warn">Enter the 8-digit code emailed to <b>${_escHtml(RESET_EMAIL_ADDRESS)}</b>.</div>
<div class="gp-dots" id="gpOtpDots">
  ${[0,1,2,3,4,5,6,7].map(i => `<div class="gp-dot" id="gpOtpDot${i}"></div>`).join('')}
</div>
<div class="gp-pad">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="gp-key" onclick="_gpOtpKey('${n}')">${n}</button>`).join('')}
  <button class="gp-key gp-key-back" onclick="_gpOtpBack()">⌫</button>
  <button class="gp-key" onclick="_gpOtpKey('0')">0</button>
  <button class="gp-key gp-key-back" onclick="_gpOtpClear()">C</button>
</div>
<div class="gp-actions">
  <button class="gp-btn gp-btn-ghost" onclick="closeGlobalPurgeModal()">Cancel</button>
</div>
<div class="gp-status" id="gpStatus"></div>`;
}
function _gpOtpKey(d) {
    if (_gpOtpEntered.length >= 8) return;
    _gpOtpEntered += d;
    _gpUpdateDots('gpOtpDot', _gpOtpEntered.length);
    if (_gpOtpEntered.length === 8) setTimeout(_gpVerifyOtp, 180);
}
function _gpOtpBack()  { _gpOtpEntered = _gpOtpEntered.slice(0, -1); _gpUpdateDots('gpOtpDot', _gpOtpEntered.length); }
function _gpOtpClear() { _gpOtpEntered = ''; _gpUpdateDots('gpOtpDot', 0); }

async function _gpVerifyOtp() {
    const status = document.getElementById('gpStatus');
    status.textContent = 'Verifying…'; status.style.color = '#64748b';
    try {
        const raw = await _supaGet(_GP_OTP_KEY);
        if (!raw) throw new Error('No OTP found. Please request a new one.');
        const stored = JSON.parse(raw);
        if (!stored || !stored.pin) throw new Error('Invalid OTP record.');
        if (Date.now() > Number(stored.expiresAt || 0)) throw new Error('OTP expired. Request a new one.');
        if (String(stored.pin) !== String(_gpOtpEntered)) throw new Error('Incorrect OTP.');
        // Consume immediately (one-time)
        try { await _supaDel(_GP_OTP_KEY); } catch (_e) {}
        status.textContent = '✅ OTP verified.'; status.style.color = '#059669';
        setTimeout(_gpRenderStep3, 500);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || 'Verification failed.');
        status.style.color = '#dc2626';
        _gpOtpClear();
    }
}

// ── STEP 3: Master Auth PIN ──────────────────────────────────────────────
function _gpRenderStep3() {
    _gpPinEntered = '';
    const body = document.getElementById('gpBody');
    if (!body) return;
    body.innerHTML = `
<div class="gp-step-title">Step 3 / 3 — Admin PIN</div>
<div class="gp-warn">Enter your 8-digit Admin PIN to confirm and execute the global purge.</div>
<div class="gp-dots" id="gpPinDots">
  ${[0,1,2,3,4,5,6,7].map(i => `<div class="gp-dot" id="gpPinDot${i}"></div>`).join('')}
</div>
<div class="gp-pad">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="gp-key" onclick="_gpPinKey('${n}')">${n}</button>`).join('')}
  <button class="gp-key gp-key-back" onclick="_gpPinBack()">⌫</button>
  <button class="gp-key" onclick="_gpPinKey('0')">0</button>
  <button class="gp-key gp-key-back" onclick="_gpPinClear()">C</button>
</div>
<div class="gp-actions">
  <button class="gp-btn gp-btn-ghost" onclick="closeGlobalPurgeModal()">Cancel</button>
</div>
<div class="gp-status" id="gpStatus"></div>`;
}
function _gpPinKey(d) {
    if (_gpPinEntered.length >= 8) return;
    _gpPinEntered += d;
    _gpUpdateDots('gpPinDot', _gpPinEntered.length);
    if (_gpPinEntered.length === 8) setTimeout(_gpVerifyPinAndExecute, 180);
}
function _gpPinBack()  { _gpPinEntered = _gpPinEntered.slice(0, -1); _gpUpdateDots('gpPinDot', _gpPinEntered.length); }
function _gpPinClear() { _gpPinEntered = ''; _gpUpdateDots('gpPinDot', 0); }

async function _gpVerifyPinAndExecute() {
    const status = document.getElementById('gpStatus');
    status.textContent = 'Verifying Admin PIN…'; status.style.color = '#64748b';
    try {
        const ok = (typeof _verifyPassword === 'function')
            ? await _verifyPassword(_gpPinEntered)
            : false;
        if (!ok) throw new Error('Incorrect Admin PIN.');
        status.textContent = '✅ Authenticated. Beginning purge…'; status.style.color = '#059669';
        setTimeout(_gpExecuteNetworkPurge, 400);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || 'PIN verification failed.');
        status.style.color = '#dc2626';
        _gpPinClear();
    }
}

function _gpUpdateDots(prefix, len) {
    for (let i = 0; i < 8; i++) {
        const el = document.getElementById(prefix + i);
        if (el) el.classList.toggle('filled', i < len);
    }
}

// ── EXECUTE ──────────────────────────────────────────────────────────────
async function _gpExecuteNetworkPurge() {
    const body = document.getElementById('gpBody');
    if (body) {
        body.innerHTML = `
<div class="gp-step-title">☢️ Executing Global Purge…</div>
<div class="gp-progress" id="gpProgress">Starting…\n</div>`;
    }
    const log = (msg) => {
        const el = document.getElementById('gpProgress');
        if (el) { el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; }
        try { console.log('[GlobalPurge]', msg); } catch (_e) {}
    };

    // 1. Broadcast GLOBAL_PURGE command to all devices via cloud key (5-min window).
    try {
        const issuedAt = Date.now();
        const cmd = { issuedAt, expiresAt: issuedAt + _GP_CMD_TTL, issuedBy: _DEVICE_UUID };
        await _supaSet(_GP_CMD_KEY, JSON.stringify(cmd));
        log('✅ Broadcast GLOBAL_PURGE command to all devices (5-min window).');
    } catch (e) { log('⚠️ Could not broadcast command: ' + (e.message || e)); }

    // 2. Delete cloud KV keys (invoices, inventory, settings, staff, registry, per-device movement keys).
    const staticCloudKeys = [
        'pharma_cloud_invoices', 'pharma_cloud_inventory', 'pharma_cloud_settings',
        'pharma_cloud_staff', 'pharma_cloud_held_bills', 'pharma_devices',
        'pharma_commands', 'pharma_cloud_device_registry',
        'pharma_branch_identity', 'pharma_currency', 'pharma_max_disc',
        'pharma_discount_presets', 'pharma_thermal_settings', 'pharma_paper_mode',
        'pharma_receipt_info', 'pharma_allow_overstock', 'pharma_staff_list',
        // FIX 7: Also clear the master password hash from the cloud KV table.
        // Without this, after a purge the cloud hash survives and _migrateSecretsOnStartup
        // takes the "cloud has it" branch — silently skipping the EmailJS PIN flow and
        // Admin PIN reset that are supposed to run on the first post-purge registration.
        'pharma_master_password_hash',
        // Also clear the master PIN setup key so the EmailJS flow re-runs correctly.
        'pharma_master_setup_pin',
        // FIX: Clean up the purge broadcast keys themselves so they don't linger
        // in pharma_sync and cause confusion on the next purge cycle.
        'pharma_global_purge_cmd',
        'pharma_global_purge_otp',
    ];
    // FIX: Snapshot device list BEFORE deleting pharma_devices from KV.
    // Previously this read happened AFTER the loop that deleted pharma_devices,
    // so it always returned [] and per-device movement/held-bill/counter keys
    // were orphaned in pharma_sync on every purge.
    let _knownDevices = [];
    try {
        const _devRaw = await _supaGet('pharma_devices');
        _knownDevices = _devRaw ? JSON.parse(_devRaw) : [];
        if (!Array.isArray(_knownDevices)) _knownDevices = [];
        log('📋 Snapshotted ' + _knownDevices.length + ' device(s) for per-device key cleanup.');
    } catch (_e) {}

    for (const k of staticCloudKeys) {
        try { await _supaDel(k); log('☁️  deleted cloud key: ' + k); }
        catch (e) { log('⚠️ cloud delete failed: ' + k); }
    }
    // Per-device movement / held-bill / counter keys — uses pre-snapshotted list
    try {
        const prefixes = ['pharma_cloud_inv_movements_', 'pharma_cloud_held_bills_', 'pharma_inv_counter_'];
        for (const d of _knownDevices) {
            for (const p of prefixes) {
                try { await _supaDel(p + d.uuid); } catch (_e) {}
            }
        }
        log('☁️  deleted per-device cloud keys for ' + _knownDevices.length + ' device(s).');
    } catch (_e) {}

    // 2b. Delete ALL rows from the relational tables (Phase-1 schema).
    //     Requires anon/authenticated DELETE GRANT on each table. If grants
    //     are missing the server returns 401/403; we log + continue so the
    //     rest of the purge still proceeds.
    const relationalTables = [
        'invoice_items', 'invoices', 'inventory_movements',
        'inventory', 'sync_log', 'settings', 'devices'
    ];
    // Use confirmed PK column names per table (avoids 42703 "column does not exist" errors).
    const tableFilterMap = {
        'invoice_items':       'invoice_number=not.is.null',
        'invoices':            'invoice_number=not.is.null',
        'inventory_movements': 'movement_id=not.is.null',
        'inventory':           'code=not.is.null',
        'sync_log':            'device_uuid=not.is.null',
        'settings':            'key=not.is.null',
        'devices':             'uuid=not.is.null'
    };
    for (const t of relationalTables) {
        const f = tableFilterMap[t] || 'id=not.is.null';
        try {
            const r = await fetch(_SUPA_URL + '/rest/v1/' + t + '?' + f, {
                method: 'DELETE', headers: _SUPA_HEADERS
            });
            if (r.ok) log('🗑  cleared relational table: ' + t);
            else log('⚠️ could not clear ' + t + ' — ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
        } catch (e) { log('⚠️ ' + t + ': ' + (e.message || e)); }
    }

    // 2c. Pause sync engine to prevent any in-flight writes during wipe
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.setSyncEnabled === 'function') {
            StorageModule.setSyncEnabled(false);
            log('⏸  sync engine paused.');
        }
    } catch (_e) {}

    // 3. Wipe local IndexedDB stores via StorageModule.
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.clearAllPrimaryStores === 'function') {
            StorageModule.clearAllPrimaryStores();
            log('🗄  cleared local IDB (invoices, heldBills, cart).');
        }
    } catch (_e) {}
    // 3b. Clear sync queues — prevents stale queued writes from repopulating cloud
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.clearAllQueues === 'function') {
            StorageModule.clearAllQueues();
            log('🗄  cleared sync queues (sync_queue, offline_sync_queue, failed_sync_logs).');
        }
    } catch (_e) {}

    // 4. Wipe PharmaInventoryDB (inventory + inventory_movements).
    try {
        if (typeof db !== 'undefined' && db) {
            try { db.transaction(['inventory'], 'readwrite').objectStore('inventory').clear(); } catch (_e) {}
            try { db.transaction(['inventory_movements'], 'readwrite').objectStore('inventory_movements').clear(); } catch (_e) {}
            log('🗄  cleared PharmaInventoryDB (inventory + movements).');
        }
    } catch (_e) {}

    // 5. Remove localStorage keys (keep only minimal device id for recovery).
    try {
        const keep = new Set(['pharma_device_id']);
        const keys = Object.keys(localStorage);
        // FIX: explicitly wipe all pharma_/sys_/tracking keys.
        // pharma_device_registered is cleared so every device must re-register.
        // pharma_applied_mov_ids cleared so movements replay correctly.
        // pharma_synced_invoices cleared so invoices sync fresh.
        keys.forEach(k => {
            if (keep.has(k)) return;
            if (k.startsWith('pharma_') || k.startsWith('sys_') ||
                k === '_pharma_inv_fingerprint' || k === '_supabase_sync_on' ||
                k === '_supabase_settings_ts' || k === 'pharma_applied_mov_ids' ||
                k === 'pharma_synced_invoices') {
                try { localStorage.removeItem(k); } catch (_e) {}
            }
        });
        log('💾 cleared localStorage (' + keys.length + ' keys scanned).');
    } catch (_e) {}

        // 6. Reset in-memory globals so any pending writes don't repopulate.
    try {
        if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = [];
        if (typeof temporaryHeldBills    !== 'undefined') temporaryHeldBills = [];
        if (typeof masterInventoryDB     !== 'undefined') masterInventoryDB = [];
        if (typeof activeCartItems       !== 'undefined') activeCartItems = [];
    } catch (_e) {}

    // FIX: Clear inventory synchronization sync-locks and timestamps
    try {
        localStorage.removeItem('_pharma_inv_fingerprint');
        localStorage.removeItem('_supabase_settings_ts');
        log('🧹 Cleared cloud sync inventory tracking fingerprints.');
    } catch (_e) {}

    // Set post-purge flag BEFORE reload. _registerOrUpdateDevice() checks this on
    // next boot and forces the registration modal even if the Supabase devices table
    // DELETE silently failed (e.g. missing RLS policy for the anon role).
    try { localStorage.setItem('pharma_post_purge', '1'); } catch (_e) {}

    log('✅ Purge complete. Reloading in 2 s…');
    setTimeout(() => { try { window.location.reload(); } catch (_e) {} }, 2000);
}

// =========================================================================
// 🌩️ CLOUD PURGE — wipes cloud data + local data (keeps device identity).
// Does NOT broadcast to other devices. Does NOT delete auth keys or devices table.
// Same double-verification as Global Purge: Email OTP + Admin PIN.
// Any registered device can initiate.
// Deletes:
//   KV  : invoices, inventory, settings, staff, held bills
//   SQL : invoices, invoice_items, inventory, inventory_movements, sync_log
//   Local: localStorage + IndexedDB (keeps pharma_device_id/name/role/counter_id)
// =========================================================================

const _CP_OTP_KEY = 'pharma_cloud_purge_otp';
const _CP_OTP_TTL = 10 * 60 * 1000; // 10 min

let _cpOtpEntered = '';
let _cpPinEntered = '';

async function openCloudPurgeModal() {
    _cpOtpEntered = '';
    _cpPinEntered = '';
    let modal = document.getElementById('cpModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'cpModal';
        modal.innerHTML = `
<style>
.cp-overlay{position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}
.cp-card{background:#fff;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;border-radius:14px;border:2px solid #7c3aed;box-shadow:0 30px 80px rgba(0,0,0,.45);}
.cp-hdr{padding:16px 20px;background:linear-gradient(135deg,#6d28d9,#7c3aed);color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;}
.cp-hdr-title{font-size:16px;font-weight:900;letter-spacing:.4px;}
.cp-hdr-sub{font-size:11px;opacity:.85;margin-top:2px;}
.cp-x{background:rgba(255,255,255,.15);color:#fff;border:none;width:30px;height:30px;border-radius:50%;font-size:18px;cursor:pointer;font-weight:800;}
.cp-body{padding:20px;}
.cp-step-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#7c3aed;margin-bottom:10px;}
.cp-warn{background:#f5f3ff;border:1px solid #c4b5fd;color:#5b21b6;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.55;margin-bottom:14px;}
.cp-safe{background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.55;margin-bottom:14px;}
.cp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;}
.cp-btn{padding:9px 16px;border:none;border-radius:6px;font-size:12px;font-weight:800;cursor:pointer;}
.cp-btn-ghost{background:#f1f5f9;color:#475569;}
.cp-btn-primary{background:#7c3aed;color:#fff;}
.cp-btn-primary:disabled{opacity:.5;cursor:not-allowed;}
.cp-status{font-size:12px;color:#64748b;margin-top:8px;min-height:18px;}
.cp-dots{display:flex;gap:8px;justify-content:center;margin:14px 0;}
.cp-dot{width:18px;height:18px;border-radius:50%;border:2px solid #cbd5e1;background:#fff;transition:all .15s;}
.cp-dot.filled{background:#7c3aed;border-color:#7c3aed;}
.cp-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:280px;margin:0 auto;}
.cp-key{padding:14px 0;font-size:18px;font-weight:800;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;color:#334155;}
.cp-key:hover{background:#e2e8f0;}
.cp-key-back{background:#f5f3ff;color:#7c3aed;}
.cp-progress{font-family:monospace;font-size:11px;background:#0f172a;color:#c4b5fd;padding:12px;border-radius:8px;white-space:pre-wrap;max-height:240px;overflow-y:auto;}
</style>
<div class="cp-overlay" onclick="if(event.target===this)closeCloudPurgeModal()">
  <div class="cp-card">
    <div class="cp-hdr">
      <div>
        <div class="cp-hdr-title">🌩️ Cloud Purge</div>
        <div class="cp-hdr-sub">Delete cloud + local data. Devices stay registered.</div>
      </div>
      <button class="cp-x" onclick="closeCloudPurgeModal()">×</button>
    </div>
    <div class="cp-body" id="cpBody"></div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = '';
    _cpRenderStep1();
}

function closeCloudPurgeModal() {
    const m = document.getElementById('cpModal');
    if (m) m.style.display = 'none';
    _cpOtpEntered = '';
    _cpPinEntered = '';
}

// ── STEP 1: Warning + Send OTP ───────────────────────────────────────────
function _cpRenderStep1() {
    const body = document.getElementById('cpBody');
    if (!body) return;
    body.innerHTML = `
<div class="cp-step-title">Step 1 / 3 — Confirm Scope</div>
<div class="cp-warn">
  <b>⚠️ This will permanently delete:</b><br>
  • All invoices, invoice items, inventory, movements &amp; sync logs from the cloud<br>
  • All KV data (settings, staff, held bills) from the cloud<br>
  • Local IndexedDB + localStorage on <b>this device</b> (data only)
</div>
<div class="cp-safe">
  <b>✅ These are preserved:</b><br>
  • Device registrations — no re-registration needed<br>
  • Master password &amp; auth keys — you stay logged in<br>
  • Other devices are <b>not</b> affected remotely
</div>
<div class="cp-actions">
  <button class="cp-btn cp-btn-ghost" onclick="closeCloudPurgeModal()">Cancel</button>
  <button class="cp-btn cp-btn-primary" id="cpSendOtpBtn" onclick="_cpSendOtp()">
    📧 Send Purge OTP to Email
  </button>
</div>
<div class="cp-status" id="cpStatus"></div>`;
}

async function _cpSendOtp() {
    const btn = document.getElementById('cpSendOtpBtn');
    const status = document.getElementById('cpStatus');
    if (!RESET_EMAIL_ADDRESS || RESET_EMAIL_ADDRESS.includes('YOUR_')) {
        status.textContent = '❌ Reset email not configured in config.js.'; status.style.color = '#dc2626'; return;
    }
    if (typeof emailjs === 'undefined') {
        status.textContent = '❌ EmailJS library not loaded.'; status.style.color = '#dc2626'; return;
    }
    btn.disabled = true; btn.textContent = 'Sending…';
    status.style.color = '#64748b'; status.textContent = 'Generating OTP…';

    const otp = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = Date.now() + _CP_OTP_TTL;

    try {
        const ok = await _supaSet(_CP_OTP_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Cloud write failed');
    } catch (e) {
        status.textContent = '❌ Could not save OTP to cloud.'; status.style.color = '#dc2626';
        btn.disabled = false; btn.textContent = '📧 Send Purge OTP to Email'; return;
    }

    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  (bi.businessName || bi.branchName || 'Pharma POS') + ' — 🌩️ CLOUD PURGE',
            counter_id: bi.counterId || '',
            expires_in: '10 minutes'
        }, EMAILJS_PUBLIC_KEY);
        status.textContent = '✅ OTP sent. Check your inbox.'; status.style.color = '#059669';
        setTimeout(_cpRenderStep2, 800);
    } catch (err) {
        try { await _supaDel(_CP_OTP_KEY); } catch (_e) {}
        status.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown error');
        status.style.color = '#dc2626';
        btn.disabled = false; btn.textContent = '📧 Send Purge OTP to Email';
    }
}

// ── STEP 2: OTP entry ────────────────────────────────────────────────────
function _cpRenderStep2() {
    _cpOtpEntered = '';
    const body = document.getElementById('cpBody');
    if (!body) return;
    body.innerHTML = `
<div class="cp-step-title">Step 2 / 3 — Enter Purge OTP</div>
<div class="cp-warn">Enter the 8-digit code emailed to <b>${_escHtml(RESET_EMAIL_ADDRESS)}</b>.</div>
<div class="cp-dots" id="cpOtpDots">
  ${[0,1,2,3,4,5,6,7].map(i => `<div class="cp-dot" id="cpOtpDot${i}"></div>`).join('')}
</div>
<div class="cp-pad">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="cp-key" onclick="_cpOtpKey('${n}')">${n}</button>`).join('')}
  <button class="cp-key cp-key-back" onclick="_cpOtpBack()">⌫</button>
  <button class="cp-key" onclick="_cpOtpKey('0')">0</button>
  <button class="cp-key cp-key-back" onclick="_cpOtpClear()">C</button>
</div>
<div class="cp-actions">
  <button class="cp-btn cp-btn-ghost" onclick="closeCloudPurgeModal()">Cancel</button>
</div>
<div class="cp-status" id="cpStatus"></div>`;
}
function _cpOtpKey(d) {
    if (_cpOtpEntered.length >= 8) return;
    _cpOtpEntered += d;
    _cpUpdateDots('cpOtpDot', _cpOtpEntered.length);
    if (_cpOtpEntered.length === 8) setTimeout(_cpVerifyOtp, 180);
}
function _cpOtpBack()  { _cpOtpEntered = _cpOtpEntered.slice(0, -1); _cpUpdateDots('cpOtpDot', _cpOtpEntered.length); }
function _cpOtpClear() { _cpOtpEntered = ''; _cpUpdateDots('cpOtpDot', 0); }

async function _cpVerifyOtp() {
    const status = document.getElementById('cpStatus');
    status.textContent = 'Verifying…'; status.style.color = '#64748b';
    try {
        const raw = await _supaGet(_CP_OTP_KEY);
        if (!raw) throw new Error('No OTP found. Please request a new one.');
        const stored = JSON.parse(raw);
        if (!stored || !stored.pin) throw new Error('Invalid OTP record.');
        if (Date.now() > Number(stored.expiresAt || 0)) throw new Error('OTP expired. Request a new one.');
        if (String(stored.pin) !== String(_cpOtpEntered)) throw new Error('Incorrect OTP.');
        try { await _supaDel(_CP_OTP_KEY); } catch (_e) {}
        status.textContent = '✅ OTP verified.'; status.style.color = '#059669';
        setTimeout(_cpRenderStep3, 500);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || 'Verification failed.');
        status.style.color = '#dc2626';
        _cpOtpClear();
    }
}

// ── STEP 3: Master Auth PIN ──────────────────────────────────────────────
function _cpRenderStep3() {
    _cpPinEntered = '';
    const body = document.getElementById('cpBody');
    if (!body) return;
    body.innerHTML = `
<div class="cp-step-title">Step 3 / 3 — Admin PIN</div>
<div class="cp-warn">Enter your 8-digit Admin PIN to execute the cloud purge.</div>
<div class="cp-dots" id="cpPinDots">
  ${[0,1,2,3,4,5,6,7].map(i => `<div class="cp-dot" id="cpPinDot${i}"></div>`).join('')}
</div>
<div class="cp-pad">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="cp-key" onclick="_cpPinKey('${n}')">${n}</button>`).join('')}
  <button class="cp-key cp-key-back" onclick="_cpPinBack()">⌫</button>
  <button class="cp-key" onclick="_cpPinKey('0')">0</button>
  <button class="cp-key cp-key-back" onclick="_cpPinClear()">C</button>
</div>
<div class="cp-actions">
  <button class="cp-btn cp-btn-ghost" onclick="closeCloudPurgeModal()">Cancel</button>
</div>
<div class="cp-status" id="cpStatus"></div>`;
}
function _cpPinKey(d) {
    if (_cpPinEntered.length >= 8) return;
    _cpPinEntered += d;
    _cpUpdateDots('cpPinDot', _cpPinEntered.length);
    if (_cpPinEntered.length === 8) setTimeout(_cpVerifyPinAndExecute, 180);
}
function _cpPinBack()  { _cpPinEntered = _cpPinEntered.slice(0, -1); _cpUpdateDots('cpPinDot', _cpPinEntered.length); }
function _cpPinClear() { _cpPinEntered = ''; _cpUpdateDots('cpPinDot', 0); }

async function _cpVerifyPinAndExecute() {
    const status = document.getElementById('cpStatus');
    status.textContent = 'Verifying Admin PIN…'; status.style.color = '#64748b';
    try {
        const ok = (typeof _verifyPassword === 'function') ? await _verifyPassword(_cpPinEntered) : false;
        if (!ok) throw new Error('Incorrect Admin PIN.');
        status.textContent = '✅ Authenticated. Beginning cloud purge…'; status.style.color = '#059669';
        setTimeout(_cpExecute, 400);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || 'PIN verification failed.');
        status.style.color = '#dc2626';
        _cpPinClear();
    }
}

function _cpUpdateDots(prefix, len) {
    for (let i = 0; i < 8; i++) {
        const el = document.getElementById(prefix + i);
        if (el) el.classList.toggle('filled', i < len);
    }
}

// ── EXECUTE ──────────────────────────────────────────────────────────────
async function _cpExecute() {
    const body = document.getElementById('cpBody');
    if (body) {
        body.innerHTML = `
<div class="cp-step-title">🌩️ Executing Cloud Purge…</div>
<div class="cp-progress" id="cpProgress">Starting…\n</div>`;
    }
    const log = (msg) => {
        const el = document.getElementById('cpProgress');
        if (el) { el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; }
        try { console.log('[CloudPurge]', msg); } catch (_e) {}
    };


    // 0. Pause sync engine so no in-flight writes repopulate cloud during purge
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.setSyncEnabled === 'function') {
            StorageModule.setSyncEnabled(false);
            log('⏸  sync engine paused.');
        }
    } catch (_e) {}

    // 0b. Broadcast DATA_WIPE to all other devices (5-min window).
    //     Other devices wipe local data + queues and reload. Stay registered.
    try {
        const issuedAt = Date.now();
        await _supaSet('pharma_cloud_wipe_cmd', JSON.stringify({
            issuedAt,
            expiresAt: issuedAt + 5 * 60 * 1000,
            issuedBy:  _DEVICE_UUID
        }));
        log('📡 DATA_WIPE broadcast sent to all devices (5-min window).');
    } catch (e) { log('⚠️  Could not broadcast DATA_WIPE: ' + (e.message || e)); }

    // 1. Delete KV keys from Supabase pharma_sync table
    const kvKeys = [
        'pharma_cloud_invoices', 'pharma_cloud_inventory', 'pharma_cloud_settings',
        'pharma_cloud_staff', 'pharma_cloud_held_bills',
        'pharma_branch_identity', 'pharma_currency', 'pharma_max_disc',
        'pharma_discount_presets', 'pharma_thermal_settings', 'pharma_paper_mode',
        'pharma_receipt_info', 'pharma_allow_overstock', 'pharma_staff_list',
        'pharma_commands', 'pharma_cloud_device_registry'
    ];
    for (const k of kvKeys) {
        try { await _supaDel(k); log('☁️  deleted KV key: ' + k); }
        catch (e) { log('⚠️  could not delete KV key: ' + k); }
    }

    // 2. Delete relational table rows (keep: devices, settings auth)
    const relTableMap = {
        'invoice_items':       'invoice_number=not.is.null',
        'invoices':            'invoice_number=not.is.null',
        'inventory_movements': 'movement_id=not.is.null',
        'inventory':           'code=not.is.null',
        'sync_log':            'device_uuid=not.is.null'
    };
    for (const [t, f] of Object.entries(relTableMap)) {
        try {
            const r = await fetch(_SUPA_URL + '/rest/v1/' + t + '?' + f, {
                method: 'DELETE', headers: _SUPA_HEADERS
            });
            if (r.ok) log('🗑  cleared relational table: ' + t);
            else log('⚠️  could not clear ' + t + ' — ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 80));
        } catch (e) { log('⚠️  ' + t + ': ' + (e.message || e)); }
    }

    // 3. Wipe local IndexedDB (keep device identity keys)
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.clearAllPrimaryStores === 'function') {
            StorageModule.clearAllPrimaryStores();
            log('🗄  cleared local IDB (invoices, heldBills, cart).');
        }
    } catch (_e) {}
    // 3b. Clear sync queues — prevents stale queued writes from repopulating cloud after reload
    try {
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.clearAllQueues === 'function') {
            StorageModule.clearAllQueues();
            log('🗄  cleared sync queues (sync_queue, offline_sync_queue, failed_sync_logs).');
        }
    } catch (_e) {}
    try {
        if (typeof db !== 'undefined' && db) {
            try { db.transaction(['inventory'], 'readwrite').objectStore('inventory').clear(); } catch (_e) {}
            try { db.transaction(['inventory_movements'], 'readwrite').objectStore('inventory_movements').clear(); } catch (_e) {}
            log('🗄  cleared PharmaInventoryDB (inventory + movements).');
        }
    } catch (_e) {}

    // 4. Wipe localStorage — keep device identity + auth keys
    try {
        const keepKeys = new Set([
            'pharma_device_id', 'pharma_device_name',
            'pharma_device_role', 'pharma_device_counter_id',
            'pharma_device_registered',
            'sys_admin_pass_hash', 'sys_has_password', '_supabase_sync_on'
        ]);
        // FIX: also explicitly remove sync tracking keys that can re-populate cloud
        ['pharma_applied_mov_ids', '_pharma_inv_fingerprint', '_supabase_settings_ts',
         'pharma_synced_invoices', 'pharma_last_sync_time',
         'pharma_inv_counter', 'pharma_cloud_inventory'].forEach(k => {
            try { localStorage.removeItem(k); } catch (_e) {}
        });
        Object.keys(localStorage).forEach(k => {
            if (keepKeys.has(k)) return;
            if (k.startsWith('pharma_') || k.startsWith('sys_') ||
                k === '_pharma_inv_fingerprint' || k === '_supabase_settings_ts') {
                try { localStorage.removeItem(k); } catch (_e) {}
            }
        });
        log('💾  cleared localStorage (device identity + auth preserved).');
    } catch (_e) {}

    // 5. Reset in-memory globals
    try {
        if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = [];
        if (typeof temporaryHeldBills    !== 'undefined') temporaryHeldBills = [];
        if (typeof masterInventoryDB     !== 'undefined') masterInventoryDB = [];
        if (typeof activeCartItems       !== 'undefined') activeCartItems = [];
    } catch (_e) {}

    log('✅ Cloud purge complete. Reloading in 2 s…');
    setTimeout(() => { try { window.location.reload(); } catch (_e) {} }, 2000);
}

// =========================================================================
// OCC SIMULATION — window.PharmaOCCTest
// =========================================================================
// Fires two overlapping deduct_inventory_atomic RPC calls against the same
// capturedVersion on the same product to prove the OCC conflict path works.
// Safe: uses the first product in masterInventoryDB with stock > 0.
// Shows results in a floating panel over the Sync Hub.
// =========================================================================
window.PharmaOCCTest = (() => {
    function _pickProduct() {
        const inv = (typeof masterInventoryDB !== 'undefined' && Array.isArray(masterInventoryDB))
            ? masterInventoryDB : [];
        return inv.find(p => (Number(p.stock) || 0) > 1) || null;
    }

    function _showPanel(html) {
        let panel = document.getElementById('occSimPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'occSimPanel';
            panel.style.cssText = [
                'position:fixed', 'top:50%', 'left:50%',
                'transform:translate(-50%,-50%)',
                'z-index:99999', 'background:#0f172a',
                'border:2px solid #38bdf8', 'border-radius:12px',
                'padding:20px 24px', 'min-width:340px', 'max-width:480px',
                'font-family:monospace', 'font-size:12px', 'color:#e2e8f0',
                'box-shadow:0 8px 32px rgba(0,0,0,.7)'
            ].join(';');
            document.body.appendChild(panel);
        }
        panel.innerHTML = html;
        panel.style.display = 'block';
    }

    function _log(msg, color) {
        const el = document.getElementById('occSimLog');
        if (!el) return;
        const line = document.createElement('div');
        line.style.color = color || '#e2e8f0';
        line.style.marginBottom = '3px';
        line.textContent = msg;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    }

    async function runSimulation() {
        const prod = _pickProduct();
        if (!prod) {
            if (typeof showToast === 'function') showToast('⚠️ OCC Sim: no product with stock > 1 found. Import inventory first.', true);
            return;
        }

        _showPanel(`
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                <span style="color:#38bdf8;font-size:14px;font-weight:700;">🧪 OCC Simulation</span>
                <button onclick="document.getElementById('occSimPanel').style.display='none'"
                        style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;">✕</button>
            </div>
            <div style="color:#94a3b8;margin-bottom:10px;font-size:11px;">
                Product: <span style="color:#fbbf24">${prod.code}</span> — ${prod.name || ''}
                &nbsp;|&nbsp; Stock: <span style="color:#34d399">${prod.stock}</span>
                &nbsp;|&nbsp; Version: <span style="color:#a78bfa">${prod.version || 1}</span>
            </div>
            <div id="occSimLog" style="background:#020617;border-radius:6px;padding:10px;min-height:160px;max-height:260px;overflow-y:auto;"></div>
            <div style="margin-top:10px;color:#64748b;font-size:10px;">Two calls fire simultaneously with the same capturedVersion. Only one should succeed; the other should OCC-conflict and auto-rebase.</div>
        `);

        const staleVersion = prod.version || 1;
        const deviceUuid   = (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : 'SIM_DEVICE';
        const simInvoice   = 'SIM_' + Date.now();

        _log('▶ Firing 2 concurrent RPC calls with capturedVersion=' + staleVersion + '…', '#38bdf8');
        _log('  Call A: deduct 1 unit (capturedVersion=' + staleVersion + ')');
        _log('  Call B: deduct 1 unit (capturedVersion=' + staleVersion + ')');

        const callA = _callDeductInventoryAtomic(prod.code, 1, deviceUuid, simInvoice + '_A', staleVersion);
        const callB = _callDeductInventoryAtomic(prod.code, 1, deviceUuid, simInvoice + '_B', staleVersion);

        let resA, resB, errA, errB;
        [
            [resA, errA],
            [resB, errB]
        ] = await Promise.all([
            callA.then(r => [r, null]).catch(e => [null, e]),
            callB.then(r => [r, null]).catch(e => [null, e])
        ]);

        _log('');
        _log('── Results ──────────────────────────────', '#64748b');

        const _fmt = (res, err, label) => {
            if (err) {
                _log(label + ': ❌ threw — ' + (err.message || String(err)), '#f87171');
                return;
            }
            if (!res) { _log(label + ': ❌ no response', '#f87171'); return; }
            if (res.success) {
                _log(label + ': ✅ SUCCESS — new_qty=' + res.new_quantity + ', new_ver=' + res.new_version, '#34d399');
            } else if (res.message && res.message.includes('OCC')) {
                _log(label + ': ⚡ OCC CONFLICT detected — rebase triggered', '#fbbf24');
                _log('   message: ' + res.message, '#94a3b8');
            } else {
                _log(label + ': ⚠️ ' + (res.message || JSON.stringify(res)), '#f97316');
            }
        };
        _fmt(resA, errA, 'Call A');
        _fmt(resB, errB, 'Call B');

        const bothSucceeded = resA && resA.success && resB && resB.success;
        const oneOcc = (resA && !resA.success && resA.message && resA.message.includes('OCC')) ||
                       (resB && !resB.success && resB.message && resB.message.includes('OCC'));

        _log('');
        if (bothSucceeded) {
            _log('⚠️  BOTH calls succeeded — OCC not triggered. Check stored procedure.', '#f97316');
        } else if (oneOcc) {
            _log('✅  OCC working correctly — exactly one call conflicted.', '#34d399');
            _log('    Rebase would retry with the fresh server version.', '#94a3b8');
        } else {
            _log('ℹ️  Unexpected result. Check Supabase logs.', '#94a3b8');
        }

        _log('');
        _log('⚠️  Note: simulation debits were sent to Supabase. Run a manual', '#64748b');
        _log('    stock adjustment to restore the deducted unit if needed.', '#64748b');
    }

    return { runSimulation };
})();
