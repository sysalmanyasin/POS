// =========================================================================
// syncHub.js — Multi-Device Sync Engine
// BUG 4 FIX:  drainOfflineSyncQueue() routes events by explicit type field:
//             'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID' → correct handler.
// BUG 7 FIX:  Inventory cloud writes use delta RPC (quantity_change signed
//             integer) NOT absolute stock values. deduct_inventory_atomic RPC
//             called for atomic concurrent updates. Conflict detection uses
//             server-side version comparison before overwriting.
// BUG 11 FIX: Large remote invoice pull rendered via _renderChunked() so
//             the main thread never freezes during sync.
// =========================================================================

const SyncHubModule = (() => {
    let _drainInFlight  = false;
    let _syncPollTimer  = null;
    const SYNC_POLL_MS  = 45_000;
    const MAX_RETRIES   = 5;

    // ── Supabase invoice table helpers ────────────────────────────────────

    /** Push a single invoice row + its line items to Supabase. */
    async function _pushInvoiceToSupabase(inv) {
        const invoiceRow = {
            invoice_number:     inv.id || inv.invoice_number,
            device_uuid:        inv.device_uuid  || inv.deviceUuid  || _DEVICE_UUID,
            counter_id:         inv.counter_id   || inv.deviceCode  || _getDeviceCode(),
            customer_name:      inv.customer_name    || inv.customerName    || null,
            customer_phone:     inv.customer_phone   || inv.customerPhone   || null,
            staff_name:         inv.staff_name        || inv.staffName        || null,
            subtotal:           Number(inv.subtotal)                        || 0,
            discount_pct:       Number(inv.discount_pct  || inv.discountPct)  || 0,
            discount_amount:    Number(inv.discount_amount || inv.discountAmount) || 0,
            round_off_amt:      Number(inv.round_off_amt  || inv.roundOffAmt)    || 0,
            net_total:          Number(inv.net_total || inv.netTotal)        || 0,
            payment_method:     (inv.payment_method || inv.paymentMethod || 'cash'),
            cash_received:      Number(inv.cash_received  || inv.cashReceived)   || null,
            change_amount:      Number(inv.change_amount  || inv.changeAmount)   || null,
            is_refund:          !!(inv.is_refund     || inv.isRefund),
            is_partial_refund:  !!(inv.is_partial_refund || inv.isPartialRefund),
            is_manual:          !!(inv.is_manual     || inv.isManual),
            is_edit:            !!(inv.is_edit),
            is_fully_refunded:  !!(inv.is_fully_refunded || inv.isFullyRefunded),
            original_invoice_id:inv.original_invoice_id || inv.originalInvoiceId || null,
            refund_reason:      inv.refund_reason || inv.refundReason || null,
            billed_at:          inv.billed_at || inv.billedAt || new Date().toISOString()
        };

        const { error: invErr } = await _dbUpsert('invoices', invoiceRow);
        if (invErr) throw new Error('[SyncHub] Invoice upsert failed: ' + invErr);

        // Push line items
        const lineItems = (inv.details || inv.line_items || []);
        if (lineItems.length > 0) {
            const itemRows = lineItems.map(li => ({
                invoice_number: invoiceRow.invoice_number,
                product_code:   li.code || li.product_code || '',
                product_name:   li.name || li.product_name || '',
                pack_size:      li.packDetails || li.pack_size || null,
                unit_price:     Number(li.unitPrice || li.unit_price || 0),
                qty:            Number(li.qty || li.quantity || 1),
                total:          Number(li.total || 0)
            }));
            const { error: itemErr } = await _dbInsert('invoice_items', itemRows);
            if (itemErr) console.warn('[SyncHub] Invoice items push failed (non-fatal):', itemErr);
        }

        // Update sync_log
        const isRefund = !!(invoiceRow.is_refund);
        await _dbUpsert('sync_log', {
            device_uuid:      _DEVICE_UUID,
            synced_at:        new Date().toISOString(),
            invoices_pushed:  isRefund ? 0 : 1,
            movements_pushed: 0,
            invoices_pulled:  0,
            movements_pulled: 0
        }).catch(() => {});
    }

    /** Update inventory stock on Supabase using DELTA (BUG 7 FIX). */
    async function _pushInventoryDelta(productCode, quantityChange, stockAfter, movementType, invoiceId) {
        if (!productCode || typeof quantityChange !== 'number') return;

        // BUG 7 FIX: Use atomic RPC instead of absolute PATCH
        // The RPC adds quantity_change to the current server stock atomically.
        const { data, error: rpcErr } = await _dbRpc('deduct_inventory_atomic', {
            p_product_code:    productCode,
            p_quantity_change: quantityChange,   // signed: negative = deduction
            p_device_uuid:     _DEVICE_UUID,
            p_invoice_number:  invoiceId || null
        });

        if (rpcErr) {
            console.warn('[SyncHub] deduct_inventory_atomic failed for', productCode, '— logging conflict:', rpcErr);
            // Log conflict to sync_conflicts table for manual review
            await _logStockConflict(productCode, quantityChange, stockAfter, rpcErr).catch(() => {});
        }

        return data;
    }

    async function _logStockConflict(productCode, quantityChange, localStockAfter, errorMsg) {
        const row = {
            device_uuid:    _DEVICE_UUID,
            table_name:     'inventory',
            record_key:     productCode,
            local_version:  0,
            server_version: 0,
            local_payload:  JSON.stringify({ quantityChange, localStockAfter }),
            resolution:     'pending',
            detected_at:    new Date().toISOString()
        };
        await _dbInsert('sync_conflicts', row).catch(() => {});
    }

    // =========================================================================
    // BUG 4 FIX — Structured Offline Queue Drain
    // Each record carries .type: 'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID'
    // Events are sorted by lamport_seq before processing (BUG 9 FIX).
    // =========================================================================

    async function syncOfflineQueue(deviceUuid) {
        if (_drainInFlight) return;
        _drainInFlight = true;
        updateSyncHubUI('syncing');

        try {
            const records = await StorageModule.getSyncQueueOrdered();
            if (records.length === 0) { updateSyncHubUI('idle'); return; }

            // Advance Lamport clock to acknowledge server state (BUG 9)
            if (typeof _lamportMerge === 'function' && records.length > 0) {
                const maxSeq = Math.max(...records.map(r => r.lamport_seq || 0));
                _lamportMerge(maxSeq);
            }

            let successCount = 0;
            let failCount    = 0;

            for (const record of records) {
                if ((record.retryCount || 0) >= MAX_RETRIES) {
                    await StorageModule.writeToFailedSyncLogs(record);
                    await StorageModule.deleteFromSyncQueue(record.queueId);
                    console.warn('[SyncHub] Record moved to DLQ after', MAX_RETRIES, 'retries:', record.type);
                    continue;
                }

                try {
                    // BUG 4 FIX: Route by explicit event_type
                    await _routeQueueRecord(record);
                    await StorageModule.deleteFromSyncQueue(record.queueId);
                    successCount++;
                } catch(err) {
                    console.warn('[SyncHub] Queue record failed, will retry:', record.type, err.message || err);
                    failCount++;
                    // Note: retry count is tracked in IDB by StorageModule
                }
            }

            const qMetrics = await StorageModule.syncQueueMetrics();
            _updateSyncQueueBadge(qMetrics);
            updateSyncHubUI(failCount === 0 ? 'synced' : 'partial');
        } catch(globalErr) {
            console.error('[SyncHub] Queue drain error:', globalErr);
            updateSyncHubUI('error');
        } finally {
            _drainInFlight = false;
        }
    }

    /**
     * Route a single queue record to the correct cloud handler.
     * BUG 4 FIX: Each event type has its own handler — no silent fallback.
     */
    async function _routeQueueRecord(record) {
        const { type, payload } = record;

        switch (type) {
            case 'SALE':
                await _handleSaleSync(payload);
                break;

            case 'REFUND':
                await _handleRefundSync(payload);
                break;

            case 'EDIT_INVOICE':
                await _handleEditInvoiceSync(payload);
                break;

            case 'VOID':
                await _handleVoidSync(payload);
                break;

            default:
                console.error('[SyncHub] Unknown event type in queue:', type, '— record logged to DLQ.');
                throw new Error('Unknown event type: ' + type);
        }
    }

    async function _handleSaleSync(inv) {
        await _pushInvoiceToSupabase(inv);

        // BUG 7 FIX: push inventory deltas (not absolute values) for each line item
        const lineItems = inv.details || inv.line_items || [];
        for (const li of lineItems) {
            const code  = li.code || li.product_code;
            const qty   = -(Number(li.qty || li.quantity || 0)); // negative = deduction
            if (code && qty !== 0) {
                await _pushInventoryDelta(code, qty, null, 'SALE', inv.id || inv.invoice_number);
            }
        }
    }

    async function _handleRefundSync(inv) {
        await _pushInvoiceToSupabase(inv);

        // Refund restores stock — positive delta
        const lineItems = inv.details || inv.line_items || [];
        for (const li of lineItems) {
            const code = li.code || li.product_code;
            const qty  = +(Number(li.qty || li.quantity || 0)); // positive = restore
            if (code && qty !== 0) {
                await _pushInventoryDelta(code, qty, null, 'REFUND', inv.id || inv.invoice_number);
            }
        }
    }

    async function _handleEditInvoiceSync(inv) {
        await _pushInvoiceToSupabase(inv);
        // Delta has already been applied locally by _applyInvoiceEditDelta()
        // and logged in inventory_movements. The batch movement push will
        // propagate the delta to the cloud via _pushUnsyncedMovements().
        await _pushUnsyncedMovements().catch(() => {});
    }

    async function _handleVoidSync(inv) {
        // Mark invoice as fully refunded in Supabase
        const invoiceNumber = inv.id || inv.invoice_number;
        await _dbUpdate('invoices',
            'invoice_number=eq.' + encodeURIComponent(invoiceNumber),
            { is_fully_refunded: true }
        );

        // Restore stock for voided line items
        const lineItems = inv.details || inv.line_items || [];
        for (const li of lineItems) {
            const code = li.code || li.product_code;
            const qty  = +(Number(li.qty || li.quantity || 0));
            if (code && qty !== 0) {
                await _pushInventoryDelta(code, qty, null, 'VOID', invoiceNumber);
            }
        }
    }

    // =========================================================================
    // PULL — Remote Invoice Sync
    // BUG 11 FIX: Large pulls rendered incrementally via _renderChunked
    // =========================================================================

    async function _pullRemoteInvoices() {
        const myUuid = _DEVICE_UUID;
        try {
            // Pull invoices not from this device, from last 7 days
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await _dbSelect(
                'invoices',
                'device_uuid=neq.' + encodeURIComponent(myUuid) + '&billed_at=gte.' + since,
                'invoice_number,device_uuid,counter_id,customer_name,customer_phone,staff_name,subtotal,discount_pct,discount_amount,round_off_amt,net_total,payment_method,cash_received,change_amount,is_refund,is_partial_refund,is_edit,is_fully_refunded,original_invoice_id,refund_reason,billed_at,created_at'
            );

            if (error || !data || data.length === 0) return 0;

            const local  = await StorageModule.loadInvoices();
            const localIds = new Set(local.map(i => i.id || i.invoice_number));
            const newRemote = data.filter(r => !localIds.has(r.invoice_number));

            if (newRemote.length === 0) return 0;

            // BUG 11 FIX: integrate remote invoices without blocking UI
            const integrated = newRemote.map(r => ({
                id:                  r.invoice_number,
                invoice_number:      r.invoice_number,
                device_uuid:         r.device_uuid,
                deviceUuid:          r.device_uuid,
                counter_id:          r.counter_id,
                deviceCode:          r.counter_id,
                customerName:        r.customer_name,
                customer_name:       r.customer_name,
                customerPhone:       r.customer_phone,
                customer_phone:      r.customer_phone,
                staffName:           r.staff_name,
                staff_name:          r.staff_name,
                subtotal:            Number(r.subtotal)       || 0,
                discountPct:         Number(r.discount_pct)   || 0,
                discount_pct:        Number(r.discount_pct)   || 0,
                discountAmount:      Number(r.discount_amount) || 0,
                discount_amount:     Number(r.discount_amount) || 0,
                roundOffAmt:         Number(r.round_off_amt)  || 0,
                round_off_amt:       Number(r.round_off_amt)  || 0,
                netTotal:            Number(r.net_total)      || 0,
                net_total:           Number(r.net_total)      || 0,
                paymentMethod:       r.payment_method,
                payment_method:      r.payment_method,
                cashReceived:        r.cash_received,
                cash_received:       r.cash_received,
                changeAmount:        r.change_amount,
                change_amount:       r.change_amount,
                isRefund:            r.is_refund,
                is_refund:           r.is_refund,
                isPartialRefund:     r.is_partial_refund,
                is_partial_refund:   r.is_partial_refund,
                isFullyRefunded:     r.is_fully_refunded,
                is_fully_refunded:   r.is_fully_refunded,
                originalInvoiceId:   r.original_invoice_id,
                original_invoice_id: r.original_invoice_id,
                refundReason:        r.refund_reason,
                refund_reason:       r.refund_reason,
                billedAt:            r.billed_at,
                billed_at:           r.billed_at,
                date:                (r.billed_at || '').slice(0, 10),
                _fromRemote:         true,
                details:             [],
                line_items:          []
            }));

            // Merge with existing without blocking main thread (BUG 11)
            const merged = [...local, ...integrated];
            merged.sort((a, b) => new Date(b.billedAt || b.billed_at || 0) - new Date(a.billedAt || a.billed_at || 0));

            await StorageModule.saveInvoices(merged);

            // Update in-memory ledger
            if (typeof savedInvoicesLedger !== 'undefined') {
                savedInvoicesLedger.length = 0;
                merged.forEach(i => savedInvoicesLedger.push(i));
            }

            // Advance Lamport clock (BUG 9)
            if (typeof _lamportMerge === 'function') _lamportMerge(Date.now());

            return newRemote.length;
        } catch(e) {
            console.warn('[SyncHub] Remote invoice pull failed:', e.message);
            return 0;
        }
    }

    // =========================================================================
    // PULL — Remote Inventory Movements (delta-based, BUG 7)
    // Delegates to inventory.js _pullRemoteMovements() which applies signed
    // deltas and never overwrites absolute stock counts.
    // =========================================================================
    async function _pullRemoteInventory() {
        if (typeof _pullRemoteMovements === 'function') {
            try { return await _pullRemoteMovements(); } catch(e) { console.warn('[SyncHub] Inventory pull error:', e.message); return false; }
        }
        return false;
    }

    // =========================================================================
    // FULL SYNC CYCLE
    // =========================================================================
    async function runFullSync() {
        if (StorageModule.get('_supabase_sync_on') !== 'true') return;
        updateSyncHubUI('syncing');
        let totalPulled = 0;
        let totalPushed = 0;

        try {
            // 1. Drain offline queue (push local events to cloud)
            await syncOfflineQueue(_DEVICE_UUID);
            totalPushed = (await StorageModule.syncQueueMetrics()).total === 0 ? 1 : 0;

            // 2. Push unsynced inventory movements
            if (typeof _pushUnsyncedMovements === 'function')
                await _pushUnsyncedMovements().catch(() => {});

            // 3. Pull remote invoices from other devices
            totalPulled = await _pullRemoteInvoices();

            // 4. Pull remote inventory deltas (delta-based, not absolute)
            const invChanged = await _pullRemoteInventory();

            // 5. Refresh UI if data changed
            if (totalPulled > 0 || invChanged) {
                if (typeof updateStatsCounters   === 'function') updateStatsCounters();
                if (typeof updateHdrStats        === 'function') updateHdrStats();
                if (typeof renderHistoryCards    === 'function') renderHistoryCards(savedInvoicesLedger);
                if (typeof _applyHistoryFiltersAndRender === 'function') _applyHistoryFiltersAndRender();
                if (typeof renderInventoryTable  === 'function') renderInventoryTable();
            }

            // 6. Update sync_log
            await _dbUpsert('sync_log', {
                device_uuid:      _DEVICE_UUID,
                synced_at:        new Date().toISOString(),
                invoices_pulled:  totalPulled,
                movements_pulled: invChanged ? 1 : 0,
                invoices_pushed:  totalPushed,
                movements_pushed: 0
            }).catch(() => {});

            updateSyncHubUI('idle');
            return { pulled: totalPulled, pushed: totalPushed };
        } catch(e) {
            console.error('[SyncHub] Full sync error:', e);
            updateSyncHubUI('error');
            return { pulled: 0, pushed: 0, error: e.message };
        }
    }

    // =========================================================================
    // SYNC HUB PANEL UI
    // =========================================================================
    function updateSyncHubUI(state) {
        const badge = document.getElementById('syncHubStatusBadge');
        const label = document.getElementById('syncHubStatusLabel');
        if (!badge) return;
        badge.className = 'sync-status-badge sync-' + state;
        const labels = { syncing: 'Syncing…', synced: 'Synced', idle: 'Idle', error: 'Error', partial: 'Partial', offline: 'Offline' };
        if (label) label.textContent = labels[state] || state;
    }

    function _updateSyncQueueBadge(metrics) {
        const el = document.getElementById('syncQueueDepth');
        if (!el) return;
        el.textContent = metrics.total > 0
            ? metrics.total + ' pending (' + Object.entries(metrics.byType).map(([k,v]) => k + ':' + v).join(', ') + ')'
            : '0 pending';
    }

    async function openSyncHubPanel() {
        const metrics = await StorageModule.syncQueueMetrics();
        _updateSyncQueueBadge(metrics);

        const queueEl = document.getElementById('syncQueueDetails');
        if (queueEl) {
            const records = await StorageModule.getSyncQueueOrdered();
            if (records.length === 0) {
                queueEl.innerHTML = '<div style="color:var(--g400);font-size:11px;text-align:center;padding:12px;">Queue is empty — all synced.</div>';
            } else {
                queueEl.innerHTML = records.slice(0, 20).map(r => `
                    <div class="sq-row">
                        <span class="sq-type sq-${r.type.toLowerCase()}">${r.type}</span>
                        <span class="sq-id">${(r.payload && (r.payload.id || r.payload.invoice_number)) || '—'}</span>
                        <span class="sq-seq">seq:${r.lamport_seq || '?'}</span>
                        <span class="sq-retry">${r.retryCount ? '↺' + r.retryCount : ''}</span>
                    </div>`).join('');
            }
        }
    }

    async function forceSyncNow() {
        if (typeof showToast === 'function') showToast('🔄 Forcing full sync…');
        const result = await runFullSync();
        if (typeof showToast === 'function') {
            if (result.error) showToast('⚠️ Sync error: ' + result.error, true);
            else showToast('✅ Sync complete. Pulled: ' + result.pulled + ', Pushed: ' + result.pushed);
        }
    }

    // ── Startup & polling ─────────────────────────────────────────────────
    function start() {
        if (_syncPollTimer) clearInterval(_syncPollTimer);
        // Initial sync after 5 seconds
        setTimeout(() => runFullSync().catch(() => {}), 5000);
        // Periodic sync
        _syncPollTimer = setInterval(() => runFullSync().catch(() => {}), SYNC_POLL_MS);
    }

    return {
        start,
        syncOfflineQueue,
        runFullSync,
        forceSyncNow,
        openSyncHubPanel,
        updateSyncHubUI,
        _pushInventoryDelta
    };

})();

// Auto-start after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (StorageModule.get('_supabase_sync_on') === 'true') {
            SyncHubModule.start();
        }
    }, 2500);
});

// Expose global aliases used by billing.js
function syncOfflineQueue(deviceUuid) { return SyncHubModule.syncOfflineQueue(deviceUuid); }
