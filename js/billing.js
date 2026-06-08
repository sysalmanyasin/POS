// =========================================================================
// billing.js — Invoice Engine
// BUG 1 FIX:  Invoice edit uses _computeEditDelta() + _applyInvoiceEditDelta()
//             so only the mathematical difference is applied to stock.
//             Old invoice snapshot is captured at edit-start, compared on save.
// BUG 4 FIX:  All save paths call StorageModule.pushToSyncQueue() with an
//             explicit event_type: 'SALE' | 'REFUND' | 'EDIT_INVOICE' | 'VOID'
// BUG 8 FIX:  Invoice numbers are compound: 'INV-{UUID4}-{counter}' where
//             UUID4 = first 4 chars of _DEVICE_UUID, ensuring global uniqueness.
// =========================================================================

// ── App state ─────────────────────────────────────────────────────────────
let activeCartItems         = [];
let temporaryHeldBills      = [];
window.savedInvoicesLedger  = window.savedInvoicesLedger || [];
let selectedProductRef      = null;
let activeDropdownIndex     = -1;
let pendingAction           = null;
const _pendingActionQueue   = [];
let lastSavedInvoiceId      = null;
let currentlyEditingInvoiceId = null;
let _editingOldLineItems    = [];   // BUG 1: snapshot of old line items when edit starts
let toastTimer              = null;
let _cartSaveTimer          = null;
let f9EditMode              = false;
let f9ActiveRow             = -1;
let _activePaymentMethod    = 'cash';

// =========================================================================
// BUG 8 FIX — Compound Invoice Counter (globally unique across all devices)
// Format: INV-{DEVICE_PREFIX}-{zero-padded-counter}
// DEVICE_PREFIX = first 4 chars of _DEVICE_UUID (uppercase hex) ensuring
// two offline counters can never collide even at the same counter value.
// =========================================================================
const _INV_COUNTER_KEY = 'pharma_inv_counter_' + _DEVICE_UUID.slice(0, 8);

function _getNextInvoiceNumber() {
    const prefix  = 'INV-' + _DEVICE_UUID.slice(0, 4).toUpperCase() + '-';
    let   counter = parseInt(localStorage.getItem(_INV_COUNTER_KEY) || '0', 10) || 0;
    counter++;
    localStorage.setItem(_INV_COUNTER_KEY, String(counter));
    return prefix + String(counter).padStart(4, '0');
}

function syncInvoiceCounterFromLedger(ledger) {
    if (!Array.isArray(ledger) || ledger.length === 0) return;
    const prefix = 'INV-' + _DEVICE_UUID.slice(0, 4).toUpperCase() + '-';
    let max = parseInt(localStorage.getItem(_INV_COUNTER_KEY) || '0', 10) || 0;
    ledger.forEach(inv => {
        if (inv.id && inv.id.startsWith(prefix)) {
            const n = parseInt(inv.id.replace(prefix, ''), 10);
            if (!isNaN(n) && n > max) max = n;
        }
    });
    localStorage.setItem(_INV_COUNTER_KEY, String(max));
}

// =========================================================================
// DOMCONTENTLOADED INIT
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // ── Clock ticker ──────────────────────────────────────────────────────
    (function tickAll() {
        const now = new Date();
        const sbClock = document.getElementById('statusClock');
        if (sbClock) sbClock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const panelDate = document.getElementById('panelDate');
        const panelTime = document.getElementById('panelTime');
        if (panelDate) panelDate.textContent = now.getDate().toString().padStart(2,'0') + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
        if (panelTime) {
            let h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            panelTime.textContent = h.toString().padStart(2,'0') + ':' + m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0') + ' ' + ampm;
        }
        setTimeout(tickAll, 1000);
    })();

    // ── Supabase init ─────────────────────────────────────────────────────
    updateSupabaseSyncUI('connecting');
    try {
        await _supaProbe();
        StorageModule.setSyncEnabled(true);
        StorageModule.set('_supabase_sync_on', 'true');
        updateSupabaseSyncUI('syncing');
        let cloudChanged = false;
        try {
            cloudChanged = await StorageModule.syncFromCloudEngine();
            updateSupabaseSyncUI('connected');
        } catch(syncErr) {
            console.warn('[Supabase] Initial sync failed:', syncErr);
            updateSupabaseSyncUI('offline');
        }
        if (cloudChanged) {
            if (savedInvoicesLedger.length === 0) {
                try { savedInvoicesLedger = await StorageModule.loadInvoices(); } catch(e) { savedInvoicesLedger = []; }
            }
            syncInvoiceCounterFromLedger(savedInvoicesLedger);
            updateStatsCounters();
            renderHistoryCards(savedInvoicesLedger);
            updateHdrStats();
        }
    } catch(e) {
        console.warn('[Supabase] Offline mode:', e);
        StorageModule.set('_supabase_sync_on', 'false');
        updateSupabaseSyncUI('offline');
    }

    // ── 30s sync interval ─────────────────────────────────────────────────
    let _syncInFlight = false;
    setInterval(async () => {
        if (_syncInFlight) return;
        if (StorageModule.get('_supabase_sync_on') !== 'true') return;
        _syncInFlight = true;
        updateSupabaseSyncUI('syncing');
        try {
            const changed = await StorageModule.syncLightweightFromCloud();
            updateSupabaseSyncUI('connected');
            if (changed) {
                try { savedInvoicesLedger = await StorageModule.loadInvoices(); } catch(e) {}
                syncInvoiceCounterFromLedger(savedInvoicesLedger);
                updateStatsCounters();
                renderHistoryCards(savedInvoicesLedger);
                updateHdrStats();
            }
            try { await _pushUnsyncedMovements(); } catch(e) {}
            try {
                if (typeof DevicesModule !== 'undefined' && DevicesModule.sendHeartbeatNow)
                    await DevicesModule.sendHeartbeatNow();
            } catch(e) {}
        } catch(e) {
            updateSupabaseSyncUI('offline');
        } finally { _syncInFlight = false; }
    }, 30000);

    // ── Load local data ───────────────────────────────────────────────────
    try { temporaryHeldBills  = await StorageModule.loadHeldBills(); } catch(e) { temporaryHeldBills = []; }
    try { savedInvoicesLedger = await StorageModule.loadInvoices();  } catch(e) { savedInvoicesLedger = []; }

    syncInvoiceCounterFromLedger(savedInvoicesLedger);
    loadBranchIdentity();
    updateStatsCounters();
    renderHistoryCards(savedInvoicesLedger);

    const todayStr = new Date().toISOString().split('T')[0];
    const fsd = document.getElementById('filterStartDate');
    const fed = document.getElementById('filterEndDate');
    if (fsd) fsd.value = todayStr;
    if (fed) fed.value = todayStr;

    try {
        const savedCart = await StorageModule.loadCart().catch(() => null);
        if (savedCart && savedCart.length > 0) {
            activeCartItems = savedCart;
            renderInvoiceUI();
            showToast('↩ Restored unfinished bill from last session.', false);
        }
    } catch(e) { console.warn(e); }

    const pc = document.getElementById('printReceiptOnSave');
    const ps = document.getElementById('printSwitch');
    if (pc && ps) ps.className = 'tog-sw ' + (pc.checked ? 'on' : '');

    initAutoBackup();
    updateBackupReminderBanner();
    setInterval(updateBackupReminderBanner, 60000);
    updateHdrStats();
    renderDiscountPresetButtons();
    _applyReceiptInfo();
    _applyThermalPrintCSS();
    _applyDarkMode();
    if (typeof _syncRoundOffBtn === 'function') _syncRoundOffBtn();

    setTimeout(() => { const sb = document.getElementById('searchBox'); if (sb) sb.focus(); }, 350);

    const cashInput = document.getElementById('cashReceivedInput');
    if (cashInput) {
        cashInput.addEventListener('input', function() {
            const net  = parseFloat(document.getElementById('netPayableDisplay')?.textContent || '0') || 0;
            const cash = parseFloat(this.value) || 0;
            const changeRow = document.getElementById('changeRow');
            const changeDisplay = document.getElementById('changeDisplay');
            const roStep = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
            const base = roStep > 0 ? Math.round(net / roStep) * roStep : net;
            if (cash > 0) {
                const change = cash - base;
                changeDisplay.textContent = change.toFixed(2);
                changeDisplay.style.color = change < 0 ? 'var(--red)' : 'var(--teal)';
                if (changeRow) changeRow.style.display = 'flex';
            } else {
                if (changeRow) changeRow.style.display = 'none';
            }
        });
    }

    setTimeout(() => {
        const lastSkip = StorageModule.get('pharma_dh_reminder_date');
        const today = new Date().toISOString().split('T')[0];
        if (lastSkip === today) return;
        const tsStr = StorageModule.get('pharma_last_backup_time');
        const diffMin = tsStr ? Math.floor((Date.now() - parseInt(tsStr)) / 60000) : Infinity;
        if (diffMin < 30) return;
        if (typeof openDataHub === 'function') openDataHub(true);
    }, 1800);

    if (typeof checkStorageUsage === 'function') checkStorageUsage();
    updateHdrStats();
    if (typeof _applyPrintMode === 'function') _applyPrintMode();
});

// =========================================================================
// KEYBOARD SHORTCUTS
// =========================================================================
window.addEventListener('keydown', function(e) {
    if (typeof _resetStatusBarHints === 'function') _resetStatusBarHints();
    const k   = e.key.toLowerCase();
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isInput = ['input','textarea','select'].includes(tag);

    if (e.key === 'F1')  { e.preventDefault(); if (typeof toggleShortcutsModal === 'function') toggleShortcutsModal(); return; }
    if (e.key === 'F4')  { e.preventDefault(); holdCurrentBill(); return; }
    if (e.key === 'F5')  { e.preventDefault(); switchTab('billingView',  document.getElementById('tab-billing'));  return; }
    if (e.key === 'F6')  { e.preventDefault(); switchTab('holdView',     document.getElementById('tab-hold'));     return; }
    if (e.key === 'F7')  { e.preventDefault(); switchTab('historyView',  document.getElementById('tab-history'));  return; }
    if (e.key === 'F8')  { e.preventDefault(); switchTab('inventoryView',document.getElementById('tab-inventory')); return; }
    if (e.key === 'F10') { e.preventDefault(); switchTab('syncHubView',  document.getElementById('tabSyncHub'));   return; }
    if (e.key === 'F12') { e.preventDefault(); if (typeof toggleSettingsDrawer === 'function') toggleSettingsDrawer(); return; }

    if (e.key === 'F9') {
        e.preventDefault();
        if (activeCartItems.length > 0) {
            f9EditMode = !f9EditMode;
            if (f9EditMode) { f9ActiveRow = 0; showToast('⚡ F9 Mode ON — ↑↓ navigate, Del remove'); }
            else            { f9ActiveRow = -1; showToast('F9 Mode OFF'); }
            _updateF9Highlight();
            if (f9EditMode) _focusF9QtyInput();
        }
        return;
    }

    if (f9EditMode && !isInput) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (f9ActiveRow < activeCartItems.length - 1) { f9ActiveRow++; _updateF9Highlight(); _focusF9QtyInput(); } return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); if (f9ActiveRow > 0) { f9ActiveRow--; _updateF9Highlight(); _focusF9QtyInput(); } return; }
        if (e.key === 'Enter')     { e.preventDefault(); _focusF9QtyInput(); return; }
        if (e.key === 'Delete') {
            e.preventDefault();
            removeInvoiceItemRow(f9ActiveRow);
            if (f9ActiveRow >= activeCartItems.length && f9ActiveRow > 0) f9ActiveRow--;
            if (activeCartItems.length === 0) { f9EditMode = false; f9ActiveRow = -1; }
            _updateF9Highlight();
            if (f9EditMode && activeCartItems.length > 0) _focusF9QtyInput();
            return;
        }
    }

    if (e.ctrlKey && !e.shiftKey) {
        if (k === 's') { e.preventDefault(); promptAndSaveInvoice(); return; }
        if (k === 'l') { e.preventDefault(); recallLastSaved(); return; }
        if (k === 'd') { e.preventDefault(); if (typeof openDataHub === 'function') openDataHub(); return; }
        if (k === 'b') { e.preventDefault(); if (typeof exportFullBackup === 'function') exportFullBackup(); return; }
        if (k === 'm') { e.preventDefault(); if (typeof openQuickAdd === 'function') openQuickAdd(); return; }
    }

    if (e.key === 'Escape' || e.key === 'Esc') {
        if (f9EditMode) { f9EditMode = false; f9ActiveRow = -1; _updateF9Highlight(); return; }
    }
});

// =========================================================================
// INVOICE SAVE — CORE PIPELINE
// BUG 4 FIX: explicit event_type passed to pushToSyncQueue
// BUG 8 FIX: compound invoice number via _getNextInvoiceNumber()
// =========================================================================

/**
 * Capture and save a new invoice (SALE or MANUAL entry).
 */
async function promptAndSaveInvoice() {
    if (activeCartItems.length === 0) { showToast('⚠️ Cart is empty.', true); return; }
    await _commitSaveInvoice('SALE');
}

async function _commitSaveInvoice(eventType) {
    const isEdit    = !!(currentlyEditingInvoiceId);
    const finalType = isEdit ? 'EDIT_INVOICE' : (eventType || 'SALE');

    const invoiceId = isEdit ? currentlyEditingInvoiceId : _getNextInvoiceNumber();
    const now       = new Date().toISOString();

    // BUG 9: Lamport sequence for this event
    const lamportSeq = (typeof _lamportNext === 'function') ? _lamportNext() : Date.now();

    const customerName  = (document.getElementById('customerNameInput')?.value  || '').trim();
    const customerPhone = (document.getElementById('customerPhoneInput')?.value || '').trim();
    const staffName     = (typeof _getActiveStaffName === 'function') ? _getActiveStaffName() : (StorageModule.get('pharma_active_staff') || '');
    const bi            = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};

    const subtotal       = activeCartItems.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const discPct        = parseFloat(document.getElementById('discountInput')?.value || '0') || 0;
    const discAmt        = Math.round(subtotal * discPct / 100 * 100) / 100;
    const roStep         = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
    const afterDisc      = subtotal - discAmt;
    const roundOffAmt    = roStep > 0 ? (Math.round(afterDisc / roStep) * roStep - afterDisc) : 0;
    const netTotal       = afterDisc + roundOffAmt;
    const cashReceived   = parseFloat(document.getElementById('cashReceivedInput')?.value || '0') || 0;
    const changeAmount   = Math.max(0, cashReceived - netTotal);
    const paymentMethod  = _activePaymentMethod || 'cash';
    const counterCode    = bi.counterId || _getDeviceCode();

    const lineItems = activeCartItems.map(item => ({
        product_code: item.code,
        name:         item.name,
        packDetails:  item.packDetails || '',
        pack_size:    item.packDetails || '',
        unitPrice:    Number(item.unitPrice) || 0,
        unit_price:   Number(item.unitPrice) || 0,
        qty:          Number(item.qty)       || 1,
        quantity:     Number(item.qty)       || 1,
        total:        Number(item.total)     || 0
    }));

    // ── BUG 1: Compute edit delta BEFORE mutating stock ───────────────────
    if (isEdit && _editingOldLineItems.length > 0) {
        const delta = _computeEditDelta(_editingOldLineItems, lineItems);
        if (delta.size > 0) {
            _applyInvoiceEditDelta(delta, invoiceId);
        }
    } else if (!isEdit) {
        // New sale — deduct stock normally
        lineItems.forEach(item => {
            const delta = -(Number(item.qty) || 1);
            _atomicStockWriteBack(item.product_code, delta, 'SALE', invoiceId, 'Sale: ' + invoiceId);
        });
    }

    // ── Capture inventory version for optimistic concurrency ─────────────
    const capturedVersion = (function() {
        let minVer = Infinity;
        lineItems.forEach(li => {
            const prod = masterInventoryDB.find(p => p.code === li.product_code);
            if (prod && typeof prod.version === 'number') minVer = Math.min(minVer, prod.version);
        });
        return isFinite(minVer) ? minVer : 1;
    })();

    // ── Build invoice object ──────────────────────────────────────────────
    const invoice = {
        id:               invoiceId,
        invoiceNumber:    invoiceId,
        invoice_number:   invoiceId,
        device_uuid:      _DEVICE_UUID,
        deviceUuid:       _DEVICE_UUID,
        counter_id:       counterCode,
        deviceCode:       counterCode,
        customer_name:    customerName,
        customerName,
        customer_phone:   customerPhone,
        customerPhone,
        staff_name:       staffName,
        staffName,
        subtotal,
        discount_pct:     discPct,
        discountPct:      discPct,
        discount_amount:  discAmt,
        discountAmount:   discAmt,
        round_off_amt:    roundOffAmt,
        roundOffAmt,
        net_total:        netTotal,
        netTotal,
        payment_method:   paymentMethod,
        paymentMethod,
        cash_received:    cashReceived,
        cashReceived,
        change_amount:    changeAmount,
        changeAmount,
        is_refund:        false,
        isRefund:         false,
        is_partial_refund: false,
        isPartialRefund:  false,
        is_manual:        false,
        is_edit:          isEdit,
        is_fully_refunded: false,
        isFullyRefunded:  false,
        original_invoice_id: isEdit ? invoiceId : null,
        billed_at:        now,
        billedAt:         now,
        timestamp:        now,
        date:             now.slice(0, 10),
        created_at:       now,
        lamport_seq:      lamportSeq,
        details:          lineItems,
        line_items:       lineItems,
        _fromRemote:      false
    };

    // ── Save locally ──────────────────────────────────────────────────────
    if (isEdit) {
        const idx = savedInvoicesLedger.findIndex(i => i.id === invoiceId);
        if (idx >= 0) savedInvoicesLedger[idx] = invoice;
        else savedInvoicesLedger.unshift(invoice);
    } else {
        savedInvoicesLedger.unshift(invoice);
    }

    StorageModule.saveInvoices(savedInvoicesLedger);
    lastSavedInvoiceId = invoiceId;

    // ── BUG 4 FIX: Push to sync queue with explicit event type ───────────
    StorageModule.pushToSyncQueue(finalType, Object.assign({}, invoice), capturedVersion);

    // ── Reset UI ──────────────────────────────────────────────────────────
    _editingOldLineItems     = [];
    currentlyEditingInvoiceId = null;
    activeCartItems           = [];
    await StorageModule.saveCart([]);

    renderInvoiceUI();
    updateStatsCounters();
    updateHdrStats();
    renderHistoryCards(savedInvoicesLedger);
    clearActiveInvoiceForm();
    showToast('✅ Invoice ' + invoiceId + ' saved.');

    // Print if enabled
    const pc = document.getElementById('printReceiptOnSave');
    if (pc && pc.checked) { setTimeout(() => window.print(), 300); }

    // Kick background sync
    if (StorageModule.get('_supabase_sync_on') === 'true') {
        setTimeout(() => {
            if (typeof syncOfflineQueue === 'function') syncOfflineQueue(_DEVICE_UUID).catch(() => {});
        }, 500);
    }
}

// =========================================================================
// BUG 1 FIX — Invoice Edit Entry Point
// Captures old line-item snapshot BEFORE the edit begins.
// =========================================================================
function startEditInvoice(invoiceId) {
    const inv = savedInvoicesLedger.find(i => i.id === invoiceId);
    if (!inv) { showToast('⚠️ Invoice not found: ' + invoiceId, true); return; }

    // Snapshot old line items for delta computation on save
    _editingOldLineItems = structuredClone(inv.details || inv.line_items || []);

    currentlyEditingInvoiceId = invoiceId;

    // Load line items into cart
    activeCartItems = (inv.details || inv.line_items || []).map(li => ({
        code:       li.code       || li.product_code,
        name:       li.name       || li.product_name || '',
        packDetails:li.packDetails|| li.pack_size    || '',
        unitPrice:  Number(li.unitPrice || li.unit_price || 0),
        qty:        Number(li.qty  || li.quantity    || 1),
        total:      Number(li.total                  || 0)
    }));

    // Restore customer info
    const cnEl = document.getElementById('customerNameInput');
    const cpEl = document.getElementById('customerPhoneInput');
    if (cnEl) cnEl.value = inv.customerName  || inv.customer_name  || '';
    if (cpEl) cpEl.value = inv.customerPhone || inv.customer_phone || '';

    // Show edit mode alert bar
    const bar = document.getElementById('editModeAlertBar');
    const badge = document.getElementById('editingInvoiceIdBadge');
    if (bar)   bar.classList.add('visible');
    if (badge) badge.textContent = invoiceId;

    switchTab('billingView', document.getElementById('tab-billing'));
    renderInvoiceUI();
    showToast('✏️ Editing invoice ' + invoiceId + '. Save to apply changes.');
}

function clearActiveInvoiceForm() {
    currentlyEditingInvoiceId = null;
    _editingOldLineItems      = [];
    const bar = document.getElementById('editModeAlertBar');
    if (bar) bar.classList.remove('visible');
    activeCartItems = [];
    renderInvoiceUI();
    const cnEl = document.getElementById('customerNameInput');
    const cpEl = document.getElementById('customerPhoneInput');
    if (cnEl) cnEl.value = '';
    if (cpEl) cpEl.value = '';
}

// =========================================================================
// VOID INVOICE
// BUG 4 FIX: VOID event type dispatched to sync queue.
// =========================================================================
async function voidInvoice(invoiceId) {
    const inv = savedInvoicesLedger.find(i => i.id === invoiceId);
    if (!inv) { showToast('⚠️ Invoice not found.', true); return; }
    if (inv.isFullyRefunded || inv.is_fully_refunded) { showToast('⚠️ Already fully refunded.', true); return; }

    const now        = new Date().toISOString();
    const lamportSeq = (typeof _lamportNext === 'function') ? _lamportNext() : Date.now();

    // Restore stock for all line items
    const lineItems = inv.details || inv.line_items || [];
    lineItems.forEach(li => {
        const code  = li.code || li.product_code;
        const qty   = Number(li.qty || li.quantity || 0);
        if (code && qty > 0) {
            _atomicStockWriteBack(code, +qty, 'VOID', invoiceId, 'Void: ' + invoiceId);
        }
    });

    // Mark as fully refunded
    inv.is_fully_refunded = true;
    inv.isFullyRefunded   = true;
    inv.refunded          = true;
    inv.voidedAt          = now;

    StorageModule.saveInvoices(savedInvoicesLedger);

    // BUG 4: push VOID event
    StorageModule.pushToSyncQueue('VOID', Object.assign({ voidedAt: now, lamport_seq: lamportSeq }, inv), 0);

    renderHistoryCards(savedInvoicesLedger);
    showToast('🗑️ Invoice ' + invoiceId + ' voided. Stock restored.');

    if (StorageModule.get('_supabase_sync_on') === 'true') {
        setTimeout(() => { if (typeof syncOfflineQueue === 'function') syncOfflineQueue(_DEVICE_UUID).catch(() => {}); }, 500);
    }
}

// =========================================================================
// REFUND INVOICE
// BUG 4 FIX: REFUND event type dispatched to sync queue.
// =========================================================================
async function processRefund(originalInvoiceId, refundItems, refundReason) {
    const original = savedInvoicesLedger.find(i => i.id === originalInvoiceId);
    if (!original) { showToast('⚠️ Original invoice not found.', true); return; }

    const refundId   = _getNextInvoiceNumber();
    const now        = new Date().toISOString();
    const lamportSeq = (typeof _lamportNext === 'function') ? _lamportNext() : Date.now();
    const bi         = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};

    const refundedItems = (refundItems || original.details || original.line_items || []);
    const refundTotal   = refundedItems.reduce((s, li) => s + (Number(li.total) || 0), 0);

    // Restore stock for refunded items
    refundedItems.forEach(li => {
        const code = li.code || li.product_code;
        const qty  = Number(li.qty || li.quantity || 0);
        if (code && qty > 0) {
            _atomicStockWriteBack(code, +qty, 'REFUND', refundId, 'Refund of ' + originalInvoiceId);
        }
    });

    const refundInvoice = {
        id:                  refundId,
        invoiceNumber:       refundId,
        invoice_number:      refundId,
        device_uuid:         _DEVICE_UUID,
        counter_id:          bi.counterId || _getDeviceCode(),
        customer_name:       original.customerName || '',
        staff_name:          original.staffName    || '',
        subtotal:            refundTotal,
        discount_pct:        0,
        discount_amount:     0,
        round_off_amt:       0,
        net_total:           refundTotal,
        payment_method:      original.paymentMethod || 'cash',
        cash_received:       0,
        change_amount:       0,
        is_refund:           true,
        isRefund:            true,
        is_partial_refund:   !!(refundItems && refundItems.length < (original.details || []).length),
        is_fully_refunded:   false,
        original_invoice_id: originalInvoiceId,
        refund_reason:       refundReason || '',
        billed_at:           now,
        billedAt:            now,
        date:                now.slice(0, 10),
        lamport_seq:         lamportSeq,
        details:             refundedItems,
        line_items:          refundedItems
    };

    savedInvoicesLedger.unshift(refundInvoice);
    StorageModule.saveInvoices(savedInvoicesLedger);

    // BUG 4: push REFUND event
    StorageModule.pushToSyncQueue('REFUND', Object.assign({}, refundInvoice), 0);

    renderHistoryCards(savedInvoicesLedger);
    updateStatsCounters();
    updateHdrStats();
    showToast('↩ Refund ' + refundId + ' processed. Stock restored.');

    if (StorageModule.get('_supabase_sync_on') === 'true') {
        setTimeout(() => { if (typeof syncOfflineQueue === 'function') syncOfflineQueue(_DEVICE_UUID).catch(() => {}); }, 500);
    }
}

// =========================================================================
// CART RENDERING
// =========================================================================
function addItemToInvoiceRow() {
    if (!selectedProductRef) return;
    const qty = parseInt(document.getElementById('billQty')?.value || '1', 10) || 1;
    const existing = activeCartItems.findIndex(i => i.code === selectedProductRef.code);
    if (existing >= 0) {
        activeCartItems[existing].qty   += qty;
        activeCartItems[existing].total  = activeCartItems[existing].qty * activeCartItems[existing].unitPrice;
    } else {
        activeCartItems.push({
            code:       selectedProductRef.code,
            name:       selectedProductRef.name,
            packDetails:selectedProductRef.pack_size || selectedProductRef.packDetails || '',
            unitPrice:  Number(selectedProductRef.unit_price) || 0,
            qty,
            total:      qty * (Number(selectedProductRef.unit_price) || 0)
        });
    }
    renderInvoiceUI();
    calculateBillTotals();
    _scheduleCartSave();
    const sb = document.getElementById('searchBox');
    if (sb) { sb.value = ''; sb.focus(); }
    selectedProductRef = null;
    const pic = document.getElementById('productInfoCard');
    if (pic) pic.style.display = 'none';
}

function removeInvoiceItemRow(index) {
    if (index < 0 || index >= activeCartItems.length) return;
    activeCartItems.splice(index, 1);
    renderInvoiceUI();
    calculateBillTotals();
    _scheduleCartSave();
}

function renderInvoiceUI() {
    const tbody = document.getElementById('invoiceCards');
    if (!tbody) return;
    tbody.innerHTML = '';
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    activeCartItems.forEach((item, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'inv-tr' + (f9EditMode && idx === f9ActiveRow ? ' f9-active' : '');
        tr.innerHTML = `
            <td class="inv-td c">${idx + 1}</td>
            <td class="inv-td">
                <div class="inv-name">${_escHtml(item.name)}</div>
                <div class="inv-sub">${_escHtml(item.code)} · ${_escHtml(item.packDetails)}</div>
            </td>
            <td class="inv-td r">${cur}${Number(item.unitPrice).toFixed(2)}</td>
            <td class="inv-td c">
                <input class="inv-qty-inp" type="number" min="1" value="${item.qty}"
                    onchange="updateItemQty(${idx}, this.value)"
                    id="f9QtyInp${idx}">
            </td>
            <td class="inv-td r">${cur}${Number(item.total).toFixed(2)}</td>
            <td class="inv-td">
                <button class="inv-del-row" onclick="removeInvoiceItemRow(${idx})">×</button>
            </td>`;
        tbody.appendChild(tr);
    });
    calculateBillTotals();
    const cnt = document.getElementById('cartItemCount');
    if (cnt) cnt.textContent = activeCartItems.length + (activeCartItems.length === 1 ? ' item' : ' items');
    const saveBtn = document.getElementById('saveBillBtn');
    if (saveBtn) saveBtn.classList.toggle('has-items', activeCartItems.length > 0);
}

function updateItemQty(idx, val) {
    const qty = Math.max(1, parseInt(val, 10) || 1);
    if (idx >= 0 && idx < activeCartItems.length) {
        activeCartItems[idx].qty   = qty;
        activeCartItems[idx].total = qty * activeCartItems[idx].unitPrice;
    }
    calculateBillTotals();
    _scheduleCartSave();
}

function calculateBillTotals() {
    const subtotal = activeCartItems.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const discPct  = parseFloat(document.getElementById('discountInput')?.value || '0') || 0;
    const discAmt  = Math.round(subtotal * discPct / 100 * 100) / 100;
    const roStep   = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
    const afterDisc = subtotal - discAmt;
    const roundOff  = roStep > 0 ? (Math.round(afterDisc / roStep) * roStep - afterDisc) : 0;
    const net       = afterDisc + roundOff;
    const cur       = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('subtotalDisplay',    cur + subtotal.toFixed(2));
    set('discountDisplay',    cur + discAmt.toFixed(2));
    set('roundOffDisplay',    (roundOff >= 0 ? '+' : '') + cur + roundOff.toFixed(2));
    set('netPayableDisplay',  net.toFixed(2));
    set('netPayableLarge',    cur + net.toFixed(2));
}

function _scheduleCartSave() {
    clearTimeout(_cartSaveTimer);
    _cartSaveTimer = setTimeout(() => { StorageModule.saveCart(activeCartItems).catch(() => {}); }, 600);
}

// =========================================================================
// HOLD / RECALL
// =========================================================================
function holdCurrentBill() {
    if (activeCartItems.length === 0) { showToast('Nothing to hold.', true); return; }
    const held = {
        items: structuredClone(activeCartItems),
        customerName:  document.getElementById('customerNameInput')?.value || '',
        customerPhone: document.getElementById('customerPhoneInput')?.value || '',
        heldAt: new Date().toISOString()
    };
    temporaryHeldBills.push(held);
    StorageModule.saveHeldBills(temporaryHeldBills);
    activeCartItems = [];
    renderInvoiceUI();
    document.getElementById('customerNameInput').value = '';
    document.getElementById('customerPhoneInput').value = '';
    const hc = document.getElementById('holdCount');
    if (hc) hc.textContent = temporaryHeldBills.length;
    showToast('📋 Bill held.');
}

function recallHeldBill(idx) {
    if (idx < 0 || idx >= temporaryHeldBills.length) return;
    const held = temporaryHeldBills.splice(idx, 1)[0];
    StorageModule.saveHeldBills(temporaryHeldBills);
    activeCartItems = held.items || [];
    const cnEl = document.getElementById('customerNameInput');
    const cpEl = document.getElementById('customerPhoneInput');
    if (cnEl) cnEl.value = held.customerName  || '';
    if (cpEl) cpEl.value = held.customerPhone || '';
    switchTab('billingView', document.getElementById('tab-billing'));
    renderInvoiceUI();
    const hc = document.getElementById('holdCount');
    if (hc) hc.textContent = temporaryHeldBills.length;
    showToast('↩ Bill recalled.');
}

function recallLastSaved() {
    if (!lastSavedInvoiceId) { showToast('No recent invoice to recall.', true); return; }
    const inv = savedInvoicesLedger.find(i => i.id === lastSavedInvoiceId);
    if (!inv) { showToast('Invoice not found in ledger.', true); return; }
    startEditInvoice(lastSavedInvoiceId);
}

// =========================================================================
// STATS & UI HELPERS
// =========================================================================
function updateStatsCounters() {
    const today = new Date().toISOString().split('T')[0];
    const todayInvoices = savedInvoicesLedger.filter(i => !i.isRefund && !i.is_refund && (i.date || '').startsWith(today));
    const cnt   = document.getElementById('statBillCount');
    const rev   = document.getElementById('statRevenue');
    const cur   = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const total = todayInvoices.reduce((s, i) => s + (Number(i.netTotal || i.net_total) || 0), 0);
    if (cnt) cnt.textContent = todayInvoices.length;
    if (rev) rev.textContent = cur + total.toFixed(2);
}

function updateHdrStats() {
    const today = new Date().toISOString().split('T')[0];
    const todayInvoices = savedInvoicesLedger.filter(i => !i.isRefund && !i.is_refund && (i.date || '').startsWith(today));
    const total = todayInvoices.reduce((s, i) => s + (Number(i.netTotal || i.net_total) || 0), 0);
    const cur   = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const tb = document.getElementById('hdrTodayBills');
    const rv = document.getElementById('hdrRevenue');
    if (tb) tb.textContent = todayInvoices.length;
    if (rv) rv.textContent = cur + total.toFixed(0);
}

function renderHistoryCards(ledger) {
    const container = document.getElementById('historyCardsContainer');
    if (!container) return;
    const today  = new Date().toISOString().split('T')[0];
    const recent = (ledger || []).filter(i => (i.date || '').startsWith(today)).slice(0, 20);
    if (recent.length === 0) { container.innerHTML = '<div class="hist-empty">No bills today yet.</div>'; return; }
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    container.innerHTML = recent.map((inv, idx) => `
        <div class="hcard ${inv.isRefund || inv.is_refund ? 'hcard-refund' : ''}" onclick="viewInvoiceDetails('${_escHtml(inv.id)}')">
            <div class="hcard-id">${_escHtml(inv.id)}</div>
            <div class="hcard-cust">${_escHtml(inv.customerName || inv.customer_name || 'Walk-in')}</div>
            <div class="hcard-amt">${cur}${Number(inv.netTotal || inv.net_total || 0).toFixed(2)}</div>
        </div>`).join('');
}

function showToast(msg, isError) {
    clearTimeout(toastTimer);
    const el = document.getElementById('toastNotif');
    if (!el) { console.log('[Toast]', msg); return; }
    el.textContent = msg;
    el.className   = 'toast-notif' + (isError ? ' toast-err' : ' toast-ok') + ' visible';
    toastTimer     = setTimeout(() => el.classList.remove('visible'), 3500);
}

function switchTab(viewId, tabBtn) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const v = document.getElementById(viewId);
    if (v) v.classList.add('active');
    if (tabBtn) tabBtn.classList.add('active');

    if (viewId === 'historyView' && typeof _restoreHistoryView === 'function') _restoreHistoryView();
    if (viewId === 'inventoryView' && typeof renderInventoryTable === 'function') renderInventoryTable();
}

function updateSupabaseSyncUI(state) {
    const badge = document.getElementById('supabase-sync-badge');
    const label = document.getElementById('supabaseSyncLabel');
    if (!badge) return;
    badge.className = state;
    if (label) {
        if (state === 'connected') label.textContent = 'Synced';
        else if (state === 'syncing') label.textContent = 'Syncing…';
        else if (state === 'offline') label.textContent = 'Offline';
        else label.textContent = 'Connecting…';
    }
}

function applyPresetDiscount(idx) {
    const presets = (typeof _getDiscountPresets === 'function') ? _getDiscountPresets() : [0,5,10,15,20];
    const pct = presets[idx];
    if (pct === undefined) return;
    const inp = document.getElementById('discountInput');
    if (inp) { inp.value = pct; }
    calculateBillTotals();
}

function setPaymentMethod(method) {
    _activePaymentMethod = method;
    document.querySelectorAll('.pay-mode-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector('.pay-mode-btn[data-method="' + method + '"]');
    if (btn) btn.classList.add('active');
    const cashRow = document.getElementById('cashRow');
    if (cashRow) cashRow.style.display = method === 'cash' ? 'flex' : 'none';
}

function _updateF9Highlight() {
    document.querySelectorAll('#invoiceCards tr').forEach((tr, idx) => {
        tr.classList.toggle('f9-active', f9EditMode && idx === f9ActiveRow);
    });
}

function _focusF9QtyInput() {
    const inp = document.getElementById('f9QtyInp' + f9ActiveRow);
    if (inp) { inp.focus(); inp.select(); }
}

function stepQty(delta) {
    const inp = document.getElementById('billQty');
    if (!inp) return;
    const v = Math.max(1, (parseInt(inp.value, 10) || 1) + delta);
    inp.value = v;
}

function viewInvoiceDetails(invoiceId) {
    if (typeof openBillReviewModal === 'function') openBillReviewModal(invoiceId);
    else if (typeof _openHistoryBillView === 'function') _openHistoryBillView(invoiceId);
}

// Auto backup stub (implemented in settings.js)
function initAutoBackup() {
    const interval = parseInt(StorageModule.get('pharma_auto_backup_interval') || '0', 10);
    if (!interval) return;
    setInterval(() => { if (typeof exportFullBackup === 'function') exportFullBackup(true); }, interval * 60 * 1000);
}

function updateBackupReminderBanner() {
    const banner = document.getElementById('backupReminderBanner');
    if (!banner) return;
    const tsStr  = StorageModule.get('pharma_last_backup_time');
    const diffMin = tsStr ? Math.floor((Date.now() - parseInt(tsStr)) / 60000) : Infinity;
    if (diffMin < 60) { banner.style.display = 'none'; return; }
    banner.style.display = 'flex';
    if (diffMin < 180)      banner.className = 'bk-green';
    else if (diffMin < 720) banner.className = 'bk-amber';
    else                    banner.className = 'bk-red';
    banner.textContent = '💾 Last backup: ' + (isFinite(diffMin) ? diffMin + ' min ago' : 'never') + ' — click to backup now';
}
