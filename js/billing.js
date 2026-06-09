// =========================================================================
// APP STATE
// =========================================================================
let activeCartItems = [];
let temporaryHeldBills = [];
// FIX (Global Binding): bind to window so syncHub.js and history.js can reach
// the ledger across file boundaries without a ReferenceError.  All assignments
// inside this file (e.g. savedInvoicesLedger = await StorageModule.loadInvoices())
// implicitly update window.savedInvoicesLedger in non-module browser scripts.
window.savedInvoicesLedger = window.savedInvoicesLedger || [];
let selectedProductRef = null;
let activeDropdownIndex = -1;
let pendingAction = null;
const _pendingActionQueue = [];
let lastSavedInvoiceId = null;
let currentlyEditingInvoiceId = null;
let toastTimer = null;
let _cartSaveTimer = null;
let f9EditMode = false;
let f9ActiveRow = -1;
// Phase 5: payment method state — 'cash' | 'card' | 'online'. Defaults to 'cash'.
let _activePaymentMethod = 'cash';

// =========================================================================
// DOMCONTENTLOADED INIT
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    (function tickAll() {
        const now = new Date();
        const sbClock = document.getElementById('statusClock');
        if (sbClock) sbClock.textContent = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
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

    updateSupabaseSyncUI('connecting');
    try {
        await _supaProbe();
        console.log('[Supabase] Cloud sync ready.');
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
        console.warn('[Supabase] Cloud unreachable — running in offline/local mode:', e);
        StorageModule.set('_supabase_sync_on', 'false');
        updateSupabaseSyncUI('offline');
    }

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
        } finally {
            _syncInFlight = false;
        }
    }, 30000);

    try { temporaryHeldBills  = await StorageModule.loadHeldBills(); } catch(e) { temporaryHeldBills = []; }
    try { savedInvoicesLedger = await StorageModule.loadInvoices();  } catch(e) { savedInvoicesLedger = []; }

    syncInvoiceCounterFromLedger(savedInvoicesLedger);
    loadBranchIdentity();
    updateStatsCounters();
    renderHistoryCards(savedInvoicesLedger);

    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('filterStartDate').value = todayStr;
    document.getElementById('filterEndDate').value   = todayStr;

    try {
        const savedCart = await StorageModule.loadCart().catch(() => null);
        if (savedCart && savedCart.length > 0) {
            activeCartItems = savedCart;
            renderInvoiceUI();
            showToast('↩ Restored unfinished bill from last session.', false);
        }
    } catch(e) { console.warn(e); }

    const pc = document.getElementById('printReceiptOnSave');
    document.getElementById('printSwitch').className = 'tog-sw ' + (pc.checked ? 'on' : '');

    initAutoBackup();
    updateBackupReminderBanner();
    setInterval(updateBackupReminderBanner, 60000);
    updateHdrStats();
    renderDiscountPresetButtons();
    _applyReceiptInfo();
    _applyThermalPrintCSS();
    _applyDarkMode();
    if (typeof _syncRoundOffBtn === 'function') _syncRoundOffBtn();
    if (roundOffStep > 0) {
        const roRowInit = document.getElementById('roundOffRow');
        if (roRowInit) roRowInit.style.display = 'block';
    }

    setTimeout(() => searchBox && searchBox.focus(), 350);

    const cashInput = document.getElementById('cashReceivedInput');
    if (cashInput) {
        cashInput.addEventListener('input', function() {
            const net = parseFloat(document.getElementById('netPayableDisplay').textContent) || 0;
            const cash = parseFloat(this.value) || 0;
            const changeRow = document.getElementById('changeRow');
            const changeDisplay = document.getElementById('changeDisplay');
            const roStep = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
            const base = roStep > 0 ? Math.round(net / roStep) * roStep : net;
            if (cash > 0) {
                const change = cash - base;
                changeDisplay.textContent = change.toFixed(2);
                changeDisplay.style.color = change < 0 ? 'var(--red)' : 'var(--teal)';
                changeRow.style.display = 'flex';
            } else {
                changeRow.style.display = 'none';
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
        openDataHub(true);
    }, 1800);

    checkStorageUsage();
    updateHdrStats();
    _applyPrintMode();
});

// =========================================================================
// KEYBOARD SHORTCUTS
// =========================================================================
window.addEventListener('keydown', function(e) {
    _resetStatusBarHints();
    const k   = e.key.toLowerCase();
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isInput = ['input','textarea','select'].includes(tag);

    if (e.key === 'F1')  { e.preventDefault(); toggleShortcutsModal(); return; }
    if (e.key === 'F4')  { e.preventDefault(); holdCurrentBill(); return; }
    if (e.key === 'F5')  { e.preventDefault(); switchTab('billingView',  document.getElementById('tab-billing'));  return; }
    if (e.key === 'F6')  { e.preventDefault(); switchTab('holdView',     document.getElementById('tab-hold'));     return; }
    if (e.key === 'F7')  { e.preventDefault(); switchTab('historyView',   document.getElementById('tab-history'));   return; }
    if (e.key === 'F8')  { e.preventDefault(); switchTab('inventoryView', document.getElementById('tab-inventory')); return; }
    if (e.key === 'F10') {
        e.preventDefault();
        switchTab('syncHubView', document.getElementById('tabSyncHub'));
        return;
    }
    if (e.key === 'F12') { e.preventDefault(); toggleSettingsDrawer(); return; }

    if (e.key === 'F9') {
        e.preventDefault();
        if (activeCartItems.length > 0) {
            f9EditMode = !f9EditMode;
            if (f9EditMode) {
                f9ActiveRow = 0;
                showToast('⚡ F9 Mode ON — ↑↓ navigate rows, Del remove row');
            } else {
                f9ActiveRow = -1;
                showToast('F9 Mode OFF');
            }
            _updateF9Highlight();
            _updateF9StatusHint();
            if (f9EditMode) _focusF9QtyInput();
        }
        return;
    }

    if (f9EditMode && !isInput) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (f9ActiveRow < activeCartItems.length - 1) { f9ActiveRow++; _updateF9Highlight(); _updateF9StatusHint(); _focusF9QtyInput(); }
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (f9ActiveRow > 0) { f9ActiveRow--; _updateF9Highlight(); _updateF9StatusHint(); _focusF9QtyInput(); }
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); _focusF9QtyInput(); return; }
        if (e.key === 'Delete') {
            e.preventDefault();
            removeInvoiceItemRow(f9ActiveRow);
            if (f9ActiveRow >= activeCartItems.length && f9ActiveRow > 0) f9ActiveRow--;
            if (activeCartItems.length === 0) { f9EditMode = false; f9ActiveRow = -1; }
            _updateF9Highlight(); _updateF9StatusHint();
            if (f9EditMode && activeCartItems.length > 0) _focusF9QtyInput();
            return;
        }
    }

    if (e.ctrlKey && !e.shiftKey) {
        if (k === 's') { e.preventDefault(); promptAndSaveInvoice(); return; }
        if (k === 'i') { e.preventDefault(); document.getElementById('customerNameInput').focus(); return; }
        if (k === 'l') { e.preventDefault(); recallLastSaved(); return; }
        if (k === 'd') { e.preventDefault(); openDataHub(); return; }
        if (k === 'b') { e.preventDefault(); exportFullBackup(); return; }
        if (k === 'm') { e.preventDefault(); openQuickAdd(); return; }
        if (k === '1') { e.preventDefault(); applyPresetDiscount(0); return; }
        if (k === '2') { e.preventDefault(); applyPresetDiscount(1); return; }
        if (k === '3') { e.preventDefault(); applyPresetDiscount(2); return; }
        if (k === '4') { e.preventDefault(); applyPresetDiscount(3); return; }
        if (k === '5') { e.preventDefault(); applyPresetDiscount(4); return; }
    }

    if (e.key === 'Escape' || e.key === 'Esc') {
        if (f9EditMode) { f9EditMode = false; f9ActiveRow = -1; _updateF9Highlight(); _updateF9StatusHint(); return; }
        if (document.getElementById('partialRefundModal').classList.contains('visible')) { e.stopImmediatePropagation(); window.closePartialRefundModal(); return; }
        if (document.getElementById('customConfirmModal').classList.contains('visible')) { document.getElementById('customConfirmModal').classList.remove('visible'); return; }
        if (document.getElementById('shortcutsModal').classList.contains('visible'))     { toggleShortcutsModal(); return; }
        if (document.getElementById('authModal').classList.contains('visible'))          { closeAuthModal(); return; }
        if (document.getElementById('holdLabelModal').classList.contains('visible'))     { cancelHoldBill(); return; }
        if (document.getElementById('purgeOldModal').classList.contains('visible'))      { closePurgeOldModal(); return; }
        if (document.getElementById('purgeConfirmModal').classList.contains('visible'))  { cancelPurgeConfirm(); return; }
        if (document.getElementById('receiptViewModal').classList.contains('visible'))   { closeReceiptModal(); return; }
        if (document.getElementById('quickAddModal').classList.contains('visible'))      { closeQuickAdd(); return; }
        if (document.getElementById('dataHubModal').classList.contains('visible'))       { closeDataHub(false); return; }
        if (document.getElementById('billSavePinModal').style.display === 'flex')       { closeBillSavePinModal(); return; }
        if (document.getElementById('staffPinChangeModal').style.display === 'flex')    { closeStaffPinChangeModal(); return; }
        if (document.getElementById('ownerPinChangeModal').style.display === 'flex')    { _closeOwnerPinChangeModal(); return; }
        if (document.getElementById('staffLoginModal').style.display === 'flex')        { closeStaffLogin(); return; }
        const srModal = document.getElementById('staffReportModal');
        if (srModal && srModal.style.display === 'flex')                                 { closeStaffSalesReport(); return; }
        const activeViewEl = document.querySelector('.view.active');
        if (activeViewEl) {
            if (activeViewEl.id === 'settingsView')  { switchTab('billingView', document.getElementById('tab-billing')); return; }
            if (activeViewEl.id === 'inventoryView') {
                const drawer = document.getElementById('itemHistoryDrawer');
                if (drawer && drawer.classList.contains('open')) { if (typeof closeItemHistoryDrawer === 'function') closeItemHistoryDrawer(); return; }
                switchTab('billingView', document.getElementById('tab-billing')); return;
            }
            if (activeViewEl.id === 'historyView') { return; }
            if (activeViewEl.id === 'holdView')    { return; }
            if (activeViewEl.id === 'billingView') { e.preventDefault(); clearActiveInvoiceForm(); return; }
        }
        return;
    }

    if ((e.key === 'F2' || k === '/') && !isInput) { e.preventDefault(); focusSearch(); return; }
    if (e.key === 'F3') { e.preventDefault(); openQuickAdd(); return; }
    if (e.key === 'F5' || (e.ctrlKey && k === 'r')) { e.preventDefault(); }
}, true);

let _statusBarHideTimer = null;
function _resetStatusBarHints() {
    document.querySelectorAll('.sb-hint').forEach(function(el) {
        if (el.id === 'statusClock' || el.id === 'f9StatusHint') return;
        el.style.opacity = '1';
    });
    clearTimeout(_statusBarHideTimer);
    _statusBarHideTimer = setTimeout(function() {
        document.querySelectorAll('.sb-hint').forEach(function(el) {
            if (el.id === 'statusClock' || el.id === 'f9StatusHint') return;
            el.style.opacity = '0';
        });
    }, 20000);
}

function _focusF9QtyInput() {
    setTimeout(() => {
        const rows = document.querySelectorAll('.cart-card');
        if (rows[f9ActiveRow]) {
            const qinp = rows[f9ActiveRow].querySelector('.cc-qinp');
            if (qinp) { qinp.focus(); qinp.select(); rows[f9ActiveRow].scrollIntoView({ block:'nearest' }); }
        }
    }, 30);
}
function _updateF9Highlight() {
    document.querySelectorAll('.cart-card').forEach((row, i) => {
        row.classList.toggle('f9-active', f9EditMode && i === f9ActiveRow);
    });
}
function _updateF9StatusHint() {
    const el = document.getElementById('f9StatusHint');
    const el2 = document.getElementById('invF9Hint');
    if (f9EditMode && activeCartItems.length > 0) {
        const txt = '⚡ F9 EDIT MODE — Row ' + (f9ActiveRow + 1) + '/' + activeCartItems.length;
        if (el) { el.textContent = txt; el.style.display = 'block'; }
        if (el2) { el2.textContent = txt; el2.classList.add('on'); }
    } else {
        if (el) el.style.display = 'none';
        if (el2) el2.classList.remove('on');
    }
}

// =========================================================================
// BILLING HELPERS
// =========================================================================
function _getDiscountPresets() {
    try { const saved = JSON.parse(StorageModule.get('pharma_discount_presets') || 'null'); if (Array.isArray(saved) && saved.length === 5) return saved; } catch(e) { console.warn(e); }
    return [1, 2, 3, 4, 5];
}
function _getInvPrefix() { return StorageModule.get('pharma_inv_prefix', 'Inv-'); }
function _getDeviceCode() {
    try {
        const bi = _getBranchIdentity();
        const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return raw.slice(0, 6) || 'DEV';
    } catch(e) { return 'DEV'; }
}
function _getMaxDiscount() { const v = parseInt(StorageModule.get('pharma_max_disc', '0'), 10); return isNaN(v) ? 0 : v; }
function _getAllowOverstock() { return StorageModule.get('pharma_allow_overstock') === 'true'; }

// =========================================================================
// FIX 4 — CLOCK-OFFSET COMPENSATION ENGINE
// Reads server_clock_offset_ms from localStorage (written by syncHub.js when
// a successful Supabase upsert returns a server-side created_at timestamp).
// All ISOString timestamps written to invoices / queue records are adjusted
// by this offset so local clocks that drift from server time still produce
// timestamps that land in the correct chronological order on the server.
// =========================================================================
function _getClockOffset() {
    try {
        const v = parseInt(localStorage.getItem('server_clock_offset_ms'), 10);
        return isNaN(v) ? 0 : v;
    } catch(_e) { return 0; }
}

const searchBox = document.getElementById('searchBox');
const resultsPanel = document.getElementById('searchResults');
const qtyInput = document.getElementById('billQty');
const discountInput = document.getElementById('globalDiscountPercent');

searchBox.addEventListener('input', function() {
    const val = this.value.toLowerCase().trim();
    document.getElementById('searchClearBtn').style.display = val ? 'flex' : 'none';
    activeDropdownIndex = -1;
    const noResultsEl = document.getElementById('searchNoResults');
    if (!val) { resultsPanel.style.display = 'none'; if (noResultsEl) { noResultsEl.classList.remove('visible'); noResultsEl.textContent = ''; } return; }

    const matches = masterInventoryDB.filter(item =>
        item.name.toLowerCase().includes(val) || item.code.toLowerCase().includes(val) ||
        (item.generic && item.generic.toLowerCase().includes(val))
    ).slice(0, 12);

    const existingRows = resultsPanel.querySelectorAll('.sr-row');
    existingRows.forEach(r => r.remove());

    if (matches.length > 0) {
        const cur = _getCurrency();
        matches.forEach((item, i) => {
            const tr = document.createElement('div');
            tr.className = 'sr-row sr-item';
            const numEl   = document.createElement('span'); numEl.className = 'sr-num'; numEl.textContent = i + 1;
            const nameWrap = document.createElement('div'); nameWrap.className = 'sr-name-wrap';
            const nameEl  = document.createElement('div'); nameEl.className = 'sr-name'; nameEl.textContent = item.name;
            const codeEl  = document.createElement('div'); codeEl.className = 'sr-code'; codeEl.textContent = item.code;
            nameWrap.appendChild(nameEl); nameWrap.appendChild(codeEl);
            const packEl  = document.createElement('span'); packEl.className = 'sr-pack'; packEl.textContent = item.packDetails || '—';
            const genEl   = document.createElement('span'); genEl.className = 'sr-generic'; genEl.textContent = item.generic || '—';
            const isLow = Number(item.stock) <= 5;
            const stockEl = document.createElement('span'); stockEl.className = 'sr-stock' + (isLow ? ' low' : ''); stockEl.textContent = Number(item.stock);
            const priceEl = document.createElement('span'); priceEl.className = 'sr-price'; priceEl.textContent = cur + (parseFloat(item.unitPrice) || 0).toFixed(2);
            tr.appendChild(numEl); tr.appendChild(nameWrap); tr.appendChild(packEl); tr.appendChild(genEl); tr.appendChild(stockEl); tr.appendChild(priceEl);
            if (isLow) tr.classList.add('sr-row-low');
            tr.addEventListener('click', () => triggerProductSelection(item));
            resultsPanel.appendChild(tr);
        });
        resultsPanel.style.display = 'block';
        if (noResultsEl) noResultsEl.classList.remove('visible');
    } else {
        resultsPanel.style.display = 'none';
        if (noResultsEl) {
            noResultsEl.textContent = 'No products found for "' + this.value.trim() + '"';
            noResultsEl.classList.add('visible');
        }
    }
});

resultsPanel.addEventListener('mousedown', function(e) { e.preventDefault(); });

searchBox.addEventListener('keydown', function(e) {
    const items = resultsPanel.getElementsByClassName('sr-item');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (activeDropdownIndex < items.length - 1) {
            if (activeDropdownIndex >= 0) items[activeDropdownIndex].classList.remove('selected');
            activeDropdownIndex++;
            items[activeDropdownIndex].classList.add('selected');
            items[activeDropdownIndex].scrollIntoView({ block:'nearest' });
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeDropdownIndex > 0) {
            items[activeDropdownIndex].classList.remove('selected');
            activeDropdownIndex--;
            items[activeDropdownIndex].classList.add('selected');
            items[activeDropdownIndex].scrollIntoView({ block:'nearest' });
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedProductRef && resultsPanel.style.display === 'none') { addItemToInvoiceRow(); return; }
        const typed = this.value.trim();
        if (!typed) return;
        const exact = masterInventoryDB.find(p => p.code === typed.toUpperCase());
        if (exact) { triggerProductSelection(exact); return; }
        if (activeDropdownIndex >= 0 && items[activeDropdownIndex]) { items[activeDropdownIndex].click(); }
        else if (items.length > 0) { items[0].click(); }
        else if (selectedProductRef) { addItemToInvoiceRow(); }
    }
});

qtyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addItemToInvoiceRow(); }
});

discountInput.addEventListener('input', () => {
    const typed = parseFloat(discountInput.value) || 0;
    const maxDisc = _getMaxDiscount();
    if (maxDisc > 0 && typed > maxDisc) {
        discountInput.value = maxDisc;
        showToast('⚠️ Discount capped at ' + maxDisc + '% (admin limit).', true);
    }
    calculateBillTotals();
    syncDiscountPresetButtons(parseFloat(discountInput.value) || 0);
});

function calculateBillTotals() {
    const subtotal = activeCartItems.reduce((a, c) => a + (parseFloat(c.total) || 0), 0);
    let disc = parseFloat(discountInput.value) || 0;
    if (disc > 100) disc = 100;
    if (disc < 0) disc = 0;
    const deduction = (subtotal * disc) / 100;
    const net = subtotal - deduction;

    document.getElementById('subtotalDisplay').textContent = subtotal.toFixed(2);
    document.getElementById('discountDeductionDisplay').textContent = deduction.toFixed(2);
    document.getElementById('netPayableDisplay').textContent = net.toFixed(2);
    document.getElementById('discPctLabel').textContent = disc;

    const cashInput = document.getElementById('cashReceivedInput');
    if (cashInput && cashInput.value) {
        const cash = parseFloat(cashInput.value) || 0;
        const roStep = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
        const base = roStep > 0 ? Math.round(net / roStep) * roStep : net;
        if (cash > 0 && subtotal > 0) {
            const change = cash - base;
            const changeDisplay = document.getElementById('changeDisplay');
            changeDisplay.textContent = change.toFixed(2);
            changeDisplay.style.color = change < 0 ? 'var(--red)' : 'var(--teal)';
            document.getElementById('changeRow').style.display = 'flex';
        } else { document.getElementById('changeRow').style.display = 'none'; }
    } else { document.getElementById('changeRow').style.display = 'none'; }

    const roRow = document.getElementById('roundOffRow');
    if (typeof roundOffStep !== 'undefined' && roundOffStep > 0 && roRow) {
        const rounded = Math.round(net / roundOffStep) * roundOffStep;
        const adj = rounded - net;
        roRow.style.display = 'block';
        document.getElementById('roundOffDisplay').textContent = (adj >= 0 ? '+ ' : '− ') + (Math.abs(adj).toFixed(2));
        document.getElementById('roundedTotalDisplay').textContent = rounded.toFixed(2);
    } else if (roRow) { roRow.style.display = 'none'; }
}

function renderDiscountPresetButtons() {
    const presets = _getDiscountPresets();
    const row = document.getElementById('discountPresetRow');
    if (!row) return;
    const btns = row.querySelectorAll('.disc-preset-btn');
    btns.forEach((btn, i) => { btn.textContent = presets[i] + '%'; });
    syncDiscountPresetButtons(parseFloat(discountInput.value) || 0);
}

function applyPresetDiscount(idx) {
    const presets = _getDiscountPresets();
    const pct = presets[idx];
    if (pct === undefined) return;
    const cur = parseFloat(discountInput.value) || 0;
    const newVal = (cur === pct) ? 0 : pct;
    const maxDisc = _getMaxDiscount();
    if (maxDisc > 0 && newVal > maxDisc) { requestAdminAccess('APPLY_HIGH_DISCOUNT', null, newVal); return; }
    discountInput.value = newVal;
    calculateBillTotals();
    syncDiscountPresetButtons(newVal);
}

function syncDiscountPresetButtons(activePct) {
    document.querySelectorAll('.disc-preset-btn').forEach(btn => {
        btn.classList.toggle('active-preset', parseFloat(btn.textContent) === activePct && activePct > 0);
    });
}

function triggerProductSelection(item) {
    selectedProductRef = item;
    searchBox.value = item.name;
    document.getElementById('searchClearBtn').style.display = 'flex';
    resultsPanel.style.display = 'none';
    document.getElementById('infoName').textContent    = item.name;
    document.getElementById('infoCode').textContent    = item.code;
    document.getElementById('infoGeneric').textContent = item.generic || '—';
    document.getElementById('infoCompany').textContent = item.company || '—';
    document.getElementById('infoPack').textContent    = item.packDetails || '—';
    document.getElementById('infoPrice').textContent   = _getCurrency() + (parseFloat(item.unitPrice) || 0).toFixed(2);
    const sb = document.getElementById('infoStockBadge');
    sb.textContent = Number(item.stock) + ' left';
    sb.className = 'pic-badge' + (Number(item.stock) <= 5 ? ' low' : '');
    document.getElementById('productInfoCard').style.display = 'block';
    qtyInput.value = 1;
    qtyInput.focus(); qtyInput.select();
}

function clearSearch(skipFocus = false) {
    searchBox.value = '';
    document.getElementById('searchClearBtn').style.display = 'none';
    resultsPanel.style.display = 'none';
    const noResultsEl = document.getElementById('searchNoResults');
    if (noResultsEl) { noResultsEl.classList.remove('visible'); noResultsEl.textContent = ''; }
    activeDropdownIndex = -1;
    document.getElementById('infoName').textContent    = '—';
    document.getElementById('infoCode').textContent    = '—';
    document.getElementById('infoGeneric').textContent = '—';
    document.getElementById('infoCompany').textContent = '—';
    document.getElementById('infoPack').textContent    = '—';
    document.getElementById('infoPrice').textContent   = '—';
    document.getElementById('infoStockBadge').textContent  = '— left';
    document.getElementById('infoStockBadge').className    = 'pic-badge';
    document.getElementById('productInfoCard').style.display = 'none';
    selectedProductRef = null;
    if (!skipFocus) searchBox.focus();
}

function focusSearch() {
    switchTab('billingView', document.getElementById('tab-billing'));
    setTimeout(() => { searchBox.focus(); searchBox.select(); }, 50);
}

function addItemToInvoiceRow() {
    if (!selectedProductRef) { showToast('❌ Select a product first.', true); return; }
    const qty = parseInt(qtyInput.value, 10) || 0;
    if (qty <= 0) { showToast('❌ Enter a valid quantity.', true); return; }
    const existing = activeCartItems.find(i => i.code === selectedProductRef.code);
    const existingIndex = existing ? activeCartItems.indexOf(existing) : -1;
    const accQty = existing ? (parseInt(existing.qty, 10) + qty) : qty;
    if (!_getAllowOverstock() && accQty > Number(selectedProductRef.stock)) {
        showToast('⛔ Stock limit: only ' + Number(selectedProductRef.stock) + ' available.', true); return;
    }
    if (existing) { existing.qty = accQty; existing.total = Number((parseFloat(existing.unitPrice) * accQty).toFixed(2)); }
    else {
        activeCartItems.push({ code:selectedProductRef.code, name:selectedProductRef.name,
            unitPrice:parseFloat(selectedProductRef.unitPrice), qty:qty,
            total:Number((parseFloat(selectedProductRef.unitPrice) * qty).toFixed(2)) });
    }
    renderInvoiceUI();
    setTimeout(function() {
        const rows = document.querySelectorAll('#invoiceCards tr');
        const flashRow = existing ? rows[existingIndex] : document.querySelector('#invoiceCards tr:last-child');
        if (flashRow) { flashRow.classList.add('row-flash'); setTimeout(function() { flashRow.classList.remove('row-flash'); }, 550); }
    }, 0);
    clearSearch();
    qtyInput.value = 1;
    setTimeout(() => searchBox.focus(), 50);
}

function modifyItemQty(index, delta) {
    const item = activeCartItems[index];
    const newQty = parseInt(item.qty, 10) + parseInt(delta, 10);
    if (newQty <= 0) { removeInvoiceItemRow(index); return; }
    const prod = masterInventoryDB.find(p => p.code === item.code);
    const stockLimit = prod ? Number(prod.stock) : 0;
    if (delta > 0 && !_getAllowOverstock() && newQty > stockLimit) { showToast('❌ Stock limit reached.', true); return; }
    item.qty = newQty;
    item.total = Number((parseFloat(item.unitPrice) * newQty).toFixed(2));
    const rows = document.querySelectorAll('.cart-card');
    if (rows[index]) {
        const qi = rows[index].querySelector('.cc-qinp');
        if (qi) qi.value = newQty;
        const pt = rows[index].querySelector('.cc-total');
        const cur = _getCurrency();
        if (pt) pt.textContent = cur + item.total.toFixed(2);
    }
    if (f9EditMode) _updateF9StatusHint();
    calculateBillTotals();
    debounceCartSave();
}

function setCartItemQty(index, val) {
    const newQty = parseInt(val, 10) || 0;
    if (newQty < 1) { renderInvoiceUI(); return; }
    const item = activeCartItems[index]; if (!item) return;
    const prod = masterInventoryDB.find(p => p.code === item.code);
    const stockLimit = prod ? Number(prod.stock) : 0;
    if (!_getAllowOverstock() && newQty > stockLimit) {
        showToast('⛔ Only ' + stockLimit + ' in stock.', true);
        const rows = document.querySelectorAll('.cart-card');
        if (rows[index]) { const qi = rows[index].querySelector('.cc-qinp'); if (qi) qi.value = item.qty; }
        return;
    }
    item.qty = newQty;
    item.total = Number((parseFloat(item.unitPrice) * newQty).toFixed(2));
    const rows = document.querySelectorAll('.cart-card');
    if (rows[index]) {
        const pt = rows[index].querySelector('.cc-total');
        const cur = _getCurrency();
        if (pt) pt.textContent = cur + item.total.toFixed(2);
    }
    calculateBillTotals();
    debounceCartSave();
}

function removeInvoiceItemRow(index) {
    const rows = document.querySelectorAll('.cart-card');
    const rowEl = rows[index];
    if (rowEl) {
        rowEl.classList.add('removing');
        setTimeout(() => {
            activeCartItems.splice(index, 1);
            if (f9EditMode) {
                if (f9ActiveRow >= activeCartItems.length && f9ActiveRow > 0) f9ActiveRow--;
                if (activeCartItems.length === 0) { f9EditMode = false; f9ActiveRow = -1; }
            }
            renderInvoiceUI();
        }, 220);
    } else {
        activeCartItems.splice(index, 1);
        if (f9EditMode) {
            if (f9ActiveRow >= activeCartItems.length && f9ActiveRow > 0) f9ActiveRow--;
            if (activeCartItems.length === 0) { f9EditMode = false; f9ActiveRow = -1; }
        }
        renderInvoiceUI();
    }
}

function debounceCartSave() {
    clearTimeout(_cartSaveTimer);
    _cartSaveTimer = setTimeout(() => {
        try { StorageModule.saveCart(activeCartItems); } catch(e) { console.warn(e); }
    }, 300);
}

function renderInvoiceUI() {
    const tbody    = document.getElementById('invoiceCards');
    const editBar  = document.getElementById('editModeAlertBar');
    const summaryCard = document.getElementById('billSummaryCard');
    const cashSection = document.getElementById('cashSection');
    const countEl  = document.getElementById('cartItemCount');

    if (currentlyEditingInvoiceId !== null) {
        editBar.classList.add('visible');
        document.getElementById('editingInvoiceIdBadge').textContent = currentlyEditingInvoiceId;
    } else { editBar.classList.remove('visible'); }

    countEl.textContent = activeCartItems.length + ' item' + (activeCartItems.length !== 1 ? 's' : '');

    const saveBtn = document.querySelector('.act-save');
    if (saveBtn) { if (activeCartItems.length > 0) saveBtn.classList.add('has-items'); else saveBtn.classList.remove('has-items'); }
    if (activeCartItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-cart"><div class="empty-cart-ico">🧾</div><div class="empty-cart-txt">Invoice is empty</div><div class="empty-cart-sub">Search a medicine above to begin</div></div></td></tr>';
        if (summaryCard) summaryCard.style.display = 'none';
        if (cashSection) cashSection.style.display = 'none';
        const roundOffRow = document.getElementById('roundOffRow');
        if (roundOffRow) roundOffRow.style.display = 'none';
        f9EditMode = false; f9ActiveRow = -1; _updateF9StatusHint();
    } else {
        const frag = document.createDocumentFragment();
        const cur  = _getCurrency();
        activeCartItems.forEach((item, index) => {
            const tr = document.createElement('tr');
            tr.className = 'inv-tr cart-card';
            if (f9EditMode && index === f9ActiveRow) tr.classList.add('f9-active');

            const tdSr = document.createElement('td'); tdSr.className = 'tc-sr'; tdSr.textContent = index + 1;
            const tdNm = document.createElement('td'); tdNm.className = 'tc-name';
            const nmDiv = document.createElement('div'); nmDiv.className = 'cc-name'; nmDiv.textContent = item.name;
            const cdDiv = document.createElement('div'); cdDiv.className = 'cc-code'; cdDiv.textContent = item.code;
            tdNm.appendChild(nmDiv); tdNm.appendChild(cdDiv);
            const tdUp = document.createElement('td'); tdUp.className = 'tc-price'; tdUp.textContent = cur + (parseFloat(item.unitPrice) || 0).toFixed(2);
            const tdQt = document.createElement('td'); tdQt.className = 'tc-qty';
            const qWrap = document.createElement('div'); qWrap.className = 'cc-qwrap';
            const qMinus = document.createElement('button'); qMinus.className = 'cc-qbtn'; qMinus.textContent = '−'; qMinus.onclick = () => modifyItemQty(index, -1);
            const qInp = document.createElement('input'); qInp.type = 'number'; qInp.className = 'cc-qinp'; qInp.value = item.qty; qInp.min = 1;
            qInp.addEventListener('focus', function() { this.select(); });
            qInp.addEventListener('change', function() { setCartItemQty(index, this.value); });
            qInp.addEventListener('blur', function() { setCartItemQty(index, this.value); });
            const qPlus = document.createElement('button'); qPlus.className = 'cc-qbtn'; qPlus.textContent = '+'; qPlus.onclick = () => modifyItemQty(index, 1);
            qWrap.appendChild(qMinus); qWrap.appendChild(qInp); qWrap.appendChild(qPlus); tdQt.appendChild(qWrap);
            const tdTt = document.createElement('td'); tdTt.className = 'tc-total cc-total'; tdTt.textContent = cur + (parseFloat(item.total) || 0).toFixed(2);
            const tdAc = document.createElement('td'); tdAc.className = 'tc-act';
            const delBtn = document.createElement('button'); delBtn.className = 'cc-del'; delBtn.textContent = '✕'; delBtn.onclick = () => removeInvoiceItemRow(index);
            tdAc.appendChild(delBtn);
            tr.appendChild(tdSr); tr.appendChild(tdNm); tr.appendChild(tdUp); tr.appendChild(tdQt); tr.appendChild(tdTt); tr.appendChild(tdAc);
            frag.appendChild(tr);
        });
        tbody.innerHTML = '';
        tbody.appendChild(frag);
        if (summaryCard) summaryCard.style.display = '';
        if (cashSection) cashSection.style.display = '';
        calculateBillTotals();
        debounceCartSave();
    }
}

function clearActiveInvoiceForm() {
    if (currentlyEditingInvoiceId !== null) {
        showConfirmModal('Cancel editing Invoice ' + _escHtml(currentlyEditingInvoiceId) + '?\nStock changes from loading this bill will be reversed.',
            _doCancelEditBill, null, 'Cancel Edit', true, 'Keep Editing');
        return;
    }
    if (activeCartItems.length === 0) return;
    showConfirmModal('Clear the current bill?\nThis cannot be undone.', _doClearBill, null, 'Clear Bill', true);
}
// =========================================================================
// PHASE 5 — PAYMENT METHOD SELECTOR
// =========================================================================
// Tracks which payment mode the cashier selected (cash / card / online).
// Called by the three pay-mode-btn buttons injected into cashSection in app.html.
// - For 'cash': shows cashReceivedInput row so the cashier can enter amount received.
// - For 'card' / 'online': hides cashReceivedInput and changeRow (not applicable).
// _activePaymentMethod is read at checkout time and written into the queue payload.
function setPaymentMode(mode) {
    _activePaymentMethod = mode;
    // Update button active states
    ['cash','card','online'].forEach(m => {
        const btn = document.getElementById('payMode' + m.charAt(0).toUpperCase() + m.slice(1));
        if (btn) btn.classList.toggle('active', m === mode);
    });
    // Show cash received row only for cash payments
    const cashRow = document.getElementById('cashReceivedRow');
    const changeRow = document.getElementById('changeRow');
    if (cashRow) cashRow.style.display = (mode === 'cash') ? '' : 'none';
    if (changeRow && mode !== 'cash') changeRow.style.display = 'none';
    if (mode !== 'cash') {
        const inp = document.getElementById('cashReceivedInput');
        if (inp) inp.value = '';
    }
}

function _doClearBill() {
    activeCartItems = []; selectedProductRef = null;
    discountInput.value = '0';
    document.getElementById('customerNameInput').value  = '';
    document.getElementById('customerPhoneInput').value = '';
    document.getElementById('cashReceivedInput').value  = '';
    document.getElementById('changeRow').style.display  = 'none';
    StorageModule.clearCart();
    f9EditMode = false; f9ActiveRow = -1;
    // Reset payment mode to cash default on bill clear
    _activePaymentMethod = 'cash';
    setPaymentMode('cash');
    renderInvoiceUI();
    clearSearch(true);
    showToast('Bill cleared.');
}
function _doCancelEditBill() {
    if (currentlyEditingInvoiceId) {
        const inv = savedInvoicesLedger.find(i => i.id === currentlyEditingInvoiceId);
        if (inv) {
            activeCartItems.forEach(item => {
                const prod = masterInventoryDB.find(p => p.code === item.code);
                if (prod) {
                    prod.stock = Number(prod.stock) + parseInt(item.qty, 10);
                    _recordInvMovement(item.code, parseInt(item.qty, 10), 'EDIT_RESTORE', currentlyEditingInvoiceId, null, Number(prod.stock));
                    _atomicStockWriteBack(item.code, Number(prod.stock));
                }
            });
            try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
        }
    }
    currentlyEditingInvoiceId = null;
    _doClearBill();
}

function holdCurrentBill() {
    if (activeCartItems.length === 0) { showToast('❌ Cart is empty — nothing to hold.', true); return; }
    document.getElementById('holdLabelInput').value = '';
    document.getElementById('holdLabelModal').classList.add('visible');
    setTimeout(() => document.getElementById('holdLabelInput').focus(), 100);
}
function cancelHoldBill() { document.getElementById('holdLabelModal').classList.remove('visible'); document.getElementById('holdLabelInput').value = ''; }
function confirmHoldBill() {
    const tag = (document.getElementById('holdLabelInput').value || '').trim() || ('Bill #' + (temporaryHeldBills.length + 1));
    const bill = { tag, timestamp: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), items: JSON.parse(JSON.stringify(activeCartItems)), discountPct: parseFloat(discountInput.value) || 0, customerName: document.getElementById('customerNameInput').value.trim(), customerPhone: document.getElementById('customerPhoneInput').value.trim() };
    temporaryHeldBills.push(bill);
    StorageModule.saveHeldBills(temporaryHeldBills);
    activeCartItems = []; selectedProductRef = null; discountInput.value = '0';
    document.getElementById('customerNameInput').value = ''; document.getElementById('customerPhoneInput').value = ''; document.getElementById('cashReceivedInput').value = ''; document.getElementById('changeRow').style.display = 'none';
    StorageModule.clearCart();
    cancelHoldBill(); renderInvoiceUI(); updateStatsCounters();
    showToast('📋 Bill held as "' + _escHtml(tag) + '"');
}
document.getElementById('holdLabelInput').addEventListener('keydown', e => { if (e.key === 'Enter') confirmHoldBill(); if (e.key === 'Escape') cancelHoldBill(); });
document.getElementById('holdLabelModal').addEventListener('click', e => { if (e.target === document.getElementById('holdLabelModal')) cancelHoldBill(); });

function recallHeldBill(index) {
    if (activeCartItems.length > 0) {
        showConfirmModal('Recalling this held bill will replace your current unsaved bill. Continue?', () => _doRecallHeld(index), null, 'Recall', true);
        return;
    }
    _doRecallHeld(index);
}
function _doRecallHeld(index) {
    const bill = temporaryHeldBills[index];
    activeCartItems = JSON.parse(JSON.stringify(bill.items));
    discountInput.value = bill.discountPct || 0;
    document.getElementById('customerNameInput').value  = bill.customerName  || '';
    document.getElementById('customerPhoneInput').value = bill.customerPhone || '';
    temporaryHeldBills.splice(index, 1);
    StorageModule.saveHeldBills(temporaryHeldBills);
    updateStatsCounters(); renderHeldBillsTable();
    syncDiscountPresetButtons(parseFloat(discountInput.value) || 0);
    switchTab('billingView', document.getElementById('tab-billing'));
    renderInvoiceUI();
    showToast('↩ Bill "' + _escHtml(bill.tag) + '" recalled.');
}

// =========================================================================
// PHASE 5 — Invoice number management
// Format: {COUNTER_ID}-{YYYYMMDD}-{SEQ}   e.g. C01-20260606-0042
//   COUNTER_ID  : alphanumeric, max 6 chars, uppercased (from branch identity)
//   YYYYMMDD    : local calendar date of the sale
//   SEQ         : 4-digit zero-padded monotonic counter, resets to 0001 each day
//
// Storage keys (localStorage via StorageModule):
//   pharma_inv_counter_{DEVICE}-{YYYYMMDD}  → current daily SEQ integer
//   pharma_inv_counter_date_{DEVICE}        → last date string, used to detect day rollover
// =========================================================================
function _getTodayDateString() {
    // Returns YYYYMMDD for the current local date, clock-offset adjusted.
    const now = new Date(Date.now() + _getClockOffset());
    const y   = now.getFullYear();
    const m   = String(now.getMonth() + 1).padStart(2, '0');
    const d   = String(now.getDate()).padStart(2, '0');
    return y + m + d;
}

function _getNextInvoiceNumber() {
    const device  = _getDeviceCode();                               // e.g. "C01"
    const today   = _getTodayDateString();                          // e.g. "20260606"
    const dateKey = 'pharma_inv_counter_date_' + device;           // tracks last-used date
    const seqKey  = 'pharma_inv_counter_' + device + '-' + today;  // daily SEQ store

    const lastDate = StorageModule.get(dateKey) || '';
    let counter = (lastDate === today)
        ? parseInt(StorageModule.get(seqKey) || '0', 10)
        : 0;  // day rolled over — reset SEQ

    counter++;
    StorageModule.set(seqKey,  String(counter));
    StorageModule.set(dateKey, today);

    return device + '-' + today + '-' + String(counter).padStart(4, '0');
}
function getNextInvoiceNumber() { return _getNextInvoiceNumber(); }

// Scans the loaded ledger to ensure the in-memory SEQ counter is never
// behind the highest invoice number already committed for today.
// Called on startup (DOMContentLoaded) after loadInvoices().
function syncInvoiceCounterFromLedger(ledger) {
    if (!Array.isArray(ledger) || ledger.length === 0) return;
    const device  = _getDeviceCode();
    const today   = _getTodayDateString();
    const prefix  = device + '-' + today + '-';               // e.g. "C01-20260606-"
    const seqKey  = 'pharma_inv_counter_' + device + '-' + today;
    const dateKey = 'pharma_inv_counter_date_' + device;

    let maxNum = parseInt(StorageModule.get(seqKey) || '0', 10);
    ledger.forEach(inv => {
        const id = inv.id || '';
        if (id.startsWith(prefix)) {
            // SEQ is the 3rd segment (index 2) after splitting on '-'
            // Format: DEVICE-YYYYMMDD-NNNN — but DEVICE itself may contain hyphens
            // so we strip only the known prefix and parse what remains.
            const seqStr = id.slice(prefix.length);
            const num    = parseInt(seqStr, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }
    });
    StorageModule.set(seqKey,  String(maxNum));
    StorageModule.set(dateKey, today);
}

// =========================================================================
// HELPER: Atomic per-item IDB stock write-back.
// =========================================================================
function _atomicStockWriteBack(productCode, newStockValue, newVersion) {
    if (!db || !productCode) return;
    try {
        const tx    = db.transaction(['inventory'], 'readwrite');
        const store = tx.objectStore('inventory');
        const getReq = store.get(productCode);
        getReq.onsuccess = function(ev) {
            const record = ev.target.result;
            if (record) {
                record.stock = Math.max(0, Number(newStockValue));
                // F7: persist the authoritative server version so OCC stamps are fresh
                if (newVersion !== undefined) record.version = Number(newVersion) || record.version || 1;
                store.put(record);
            }
        };
        getReq.onerror = function() {
            console.warn('[IDB] Stock write-back failed for code: ' + productCode);
        };
    } catch(e) {
        console.warn('[IDB] Atomic write-back exception for ' + productCode + ':', e);
    }
}

// =========================================================================
// HELPER: Read a single item's live 'version' integer from the IDB
//         'inventory' store. Returns a Promise<number> — resolves to the
//         stored version, or 1 as the safe default if absent.
// =========================================================================
function _readItemVersionFromIDB(productCode) {
    return new Promise(resolve => {
        if (!db || !productCode) { resolve(1); return; }
        try {
            const req = db.transaction(['inventory'], 'readonly')
                          .objectStore('inventory')
                          .get(productCode);
            req.onsuccess = e => {
                const rec = e.target.result;
                resolve((rec && typeof rec.version === 'number') ? rec.version : 1);
            };
            req.onerror = () => resolve(1);
        } catch(e) { resolve(1); }
    });
}

function promptAndSaveInvoice() {
    if (activeCartItems.length === 0) { showToast('❌ Cart is empty.', true); return; }
    const staffRequired = StorageModule.get('pharma_require_staff_pin') === 'true';
    if (staffRequired) { promptBillSavePinConfirm(); return; }
    finalizeAndPrintBill();
}

// =========================================================================
// CHECKOUT CAPTURE — finalizeAndPrintBill
//
// Refactored for the Append-Only Event Log backend:
//
//   1. For every line item in the cart, read its live 'version' integer
//      from the local IDB 'inventory' store via _readItemVersionFromIDB().
//   2. Assemble an atomic INVOICE payload that bundles each sold item
//      with its capturedVersion at the moment of sale.
//   3. Commit the payload to the offline sync queue via
//      StorageModule.pushToSyncQueue('INVOICE', payload, maxVersion)
//      so the background worker can later call deduct_inventory_atomic.
//   4. Also continue writing the local ledger snapshot (savedInvoicesLedger)
//      so History, receipts, and refund paths remain fully functional.
//   5. All local stock cache mutations and atomic IDB write-backs are
//      preserved exactly as before — the queue is additive, not replacing.
// =========================================================================
function validateAndSanitizeCart(cartItems) {
    if (!Array.isArray(cartItems) || cartItems.length === 0) throw new Error("Operational cart is currently empty.");
    return cartItems.map(item => {
        const parsedQty = parseInt(item.qty, 10);
        const parsedPrice = parseFloat(item.unitPrice);
        if (isNaN(parsedQty) || parsedQty <= 0) throw new Error("Invalid item quantity found for " + item.code);
        if (isNaN(parsedPrice) || parsedPrice < 0) throw new Error("Malformed unit price found for " + item.code);
        return { ...item, qty: parsedQty, unitPrice: parsedPrice, version: item.version || 1 };
    });
}

async function finalizeAndPrintBill() {
    if (activeCartItems.length === 0) { showToast('❌ Cart is empty.', true); return; }
    try {
        activeCartItems = validateAndSanitizeCart(activeCartItems);
    } catch (vErr) {
        showToast('❌ ' + (vErr && vErr.message ? vErr.message : 'Cart validation failed.'), true);
        return;
    }
    try {
    const isEdit = currentlyEditingInvoiceId !== null;
    let invoiceID = currentlyEditingInvoiceId || null;
    let originalTimestamp = null, originalDeviceCode = null;

    if (isEdit) {
        // Stock was already restored (EDIT_RESTORE) when the invoice was loaded
        // into edit mode (_doRecallLastSaved / _doLoad / _doUpdateBill).
        // Do NOT restore again here — that caused a double-restore bug where
        // every edit permanently inflated stock by the original invoice qty.
        const orig = savedInvoicesLedger.find(inv => inv.id === currentlyEditingInvoiceId);
        if (orig) { originalTimestamp = orig.timestamp; originalDeviceCode = orig.deviceCode; }
        savedInvoicesLedger = savedInvoicesLedger.filter(inv => inv.id !== invoiceID);
        currentlyEditingInvoiceId = null;
    } else { invoiceID = getNextInvoiceNumber(); }

    const nowStr = new Date().toLocaleString([], { year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const timestamp = (isEdit && originalTimestamp) ? originalTimestamp : nowStr;

    // ── STEP 1: Read capturedVersion for every cart line from IDB ─────────
    // All reads run in parallel; Promise.all waits for every item before
    // the payload is assembled, so no item is missing its version.
    const versionReads = activeCartItems.map(item =>
        _readItemVersionFromIDB(item.code).then(v => ({ code: item.code, capturedVersion: v }))
    );
    const versionMap = {};
    try {
        const results = await Promise.all(versionReads);
        results.forEach(r => { versionMap[r.code] = r.capturedVersion; });
    } catch(e) {
        console.warn('[Checkout] Version read failed, defaulting all to 1:', e);
        activeCartItems.forEach(item => { versionMap[item.code] = 1; });
    }

    // ── STEP 2: Build finalDetails (same structure as before) ─────────────
    let finalDetails = [];
    activeCartItems.forEach(item => {
        if ((parseInt(item.qty, 10) || 0) > 0) {
            const itemCopy = JSON.parse(JSON.stringify(item));
            const prod = masterInventoryDB.find(p => p.code === item.code);
            itemCopy.stockSnapshot   = prod ? Number(prod.stock) : 0;
            // Attach capturedVersion so the local ledger also carries it
            itemCopy.capturedVersion = versionMap[item.code] || 1;
            finalDetails.push(itemCopy);
        }
    });

    const subtotal  = finalDetails.reduce((a, c) => a + (parseFloat(c.total) || 0), 0);
    const disc      = parseFloat(discountInput.value) || 0;
    const deduction = (subtotal * disc) / 100;
    const net       = subtotal - deduction;
    const roStep    = (typeof roundOffStep !== 'undefined') ? roundOffStep : 0;
    const rounded   = roStep > 0 ? Math.round(net / roStep) * roStep : net;
    const roundOffAmt = rounded - net;

    const custName     = document.getElementById('customerNameInput').value.trim();
    const custPhone    = document.getElementById('customerPhoneInput').value.trim();
    // FIX (Staff Name): fall back to settings operatorName when no staff PIN login active,
    // so the invoice always carries a meaningful staff/operator name.
    const _settingsStaffName = (function() {
        try {
            const bi = JSON.parse(StorageModule.get('pharma_branch_identity') || '{}');
            return bi.operatorName || '';
        } catch(_e) { return ''; }
    })();
    const staffNameTag = (typeof activeStaff !== 'undefined' && activeStaff && activeStaff.name)
        ? activeStaff.name
        : _settingsStaffName;
    const _hasManual   = finalDetails.some(d => (d.code || '').startsWith('MANUAL'));

    // ── STEP 3: Write local ledger snapshot (History / refund paths) ──────
    // SSOT Write-Through Log: build the full new ledger without mutating
    // savedInvoicesLedger yet. The in-memory array is updated only inside the
    // saveInvoices oncomplete callback — this prevents a dual-write split-brain
    // where a crash between the push and the IDB commit leaves the stores diverged.

    // ── PHASE 5: Capture payment fields from DOM ──────────────────────────
    // _activePaymentMethod is set by setPaymentMode() (buttons in cashSection).
    // cash_received / change_amount are only meaningful for cash payments;
    // for card/online they are stored as null (no physical cash exchange).
    const _paymentMethod = _activePaymentMethod || 'cash';
    const _cashReceivedRaw = parseFloat(document.getElementById('cashReceivedInput').value) || 0;
    const _cashReceived  = (_paymentMethod === 'cash' && _cashReceivedRaw > 0) ? _cashReceivedRaw : null;
    const _changeAmount  = (_paymentMethod === 'cash' && _cashReceived !== null)
        ? parseFloat((_cashReceived - rounded).toFixed(2))
        : null;

    const _newInvoice = Object.assign(
        { id:invoiceID, deviceCode: (isEdit && originalDeviceCode) ? originalDeviceCode : _getDeviceCode(),
          date:new Date(Date.now() + _getClockOffset()).toISOString().split('T')[0], timestamp,
          customerName:custName, customerPhone:custPhone, itemCount:finalDetails.length,
          netTotal:rounded, staffName:staffNameTag, discountPct:disc,
          roundOffAmt: roStep > 0 ? roundOffAmt : 0, details:finalDetails,
          // Phase 5: payment fields mirrored onto local ledger so History/receipts display correctly
          paymentMethod: _paymentMethod,
          cashReceived:  _cashReceived,
          changeAmount:  _changeAmount },
        _hasManual ? { isManual: true } : {}, isEdit ? { editedAt: nowStr } : {}
    );
    const _newLedger = savedInvoicesLedger.concat([_newInvoice]);
    try {
        StorageModule.saveInvoices(_newLedger, function(committedLedger) {
            savedInvoicesLedger = committedLedger; // memory updated only on IDB success
        });
    } catch(e) {
        showToast('⚠️ Storage full! Export a backup from Data Hub to free space.', true);
    }

    // ── STEP 4: Assemble the atomic queue payload ─────────────────────────
    // FIX (RPC Payload Compiler): deduct_inventory_atomic JSONB parser demands
    // strict snake_case keys.  We compile every line item to the required
    // contract shape here so syncHub.js can pass them through without
    // further transformation:
    //   code            → product_code   (RPC: p_product_code)
    //   item.qty        → quantity       (RPC: p_quantity)
    //   capturedVersion → expected_version (RPC: p_expected_version)
    // The display-only fields (name, unitPrice, total) are retained for IDB
    // history and receipt rendering.
    const queueLineItems = finalDetails.map(item => ({
        product_code:     item.code,
        name:             item.name,
        unitPrice:        parseFloat(item.unitPrice) || 0,
        quantity:         parseInt(item.qty, 10)     || 0,
        total:            parseFloat(item.total)     || 0,
        expected_version: item.capturedVersion        || 1
    }));

    // maxCapturedVersion is used as the top-level capturedVersion for the
    // queue record so the sync worker can quickly compare freshness.
    const maxCapturedVersion = queueLineItems.reduce(
        (max, l) => Math.max(max, l.expected_version), 1
    );

    // ── PHASE 5: Build Supabase-ready queue payload ───────────────────────
    // Key contract (synchub.js destructures these exact names):
    //   invoice_number  → PK on `invoices` table; used by _processInvoiceItem
    //   line_items      → array consumed by _processLineItem per item
    //   billed_at       → ISO 8601 timestamptz; best-effort clock-offset adjusted
    //   counter_id      → maps to `invoices.counter_id` column
    //   device_uuid     → FK to `devices.uuid`; injected by synchub.js on upsert
    //
    // HANDOFF NOTE — synchub.js (_processInvoiceItem):
    //   The spread `...coreInvoiceFields` passes every key except `invoice_number`
    //   and `line_items` straight into the Supabase upsert.  Ensure the `invoices`
    //   table accepts: billed_at, counter_id, customer_name, customer_phone,
    //   staff_name, discount_pct, subtotal, net_total, round_off_amt, is_edit,
    //   is_manual, payment_method, cash_received, change_amount.
    //   camelCase keys (discountPct, netTotal etc.) will be silently ignored by
    //   PostgREST — they must match snake_case column names exactly.
    //   → synchub.js must add an explicit column-mapping step inside
    //     _processInvoiceItem that translates the payload keys to the exact
    //     snake_case column names before the upsert call (see handoff doc).
    const _billedAt = new Date(Date.now() + _getClockOffset()).toISOString();
    const invoiceQueuePayload = {
        invoice_number:  invoiceID,
        counter_id:      _getDeviceCode(),
        device_uuid:     (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : '',
        billed_at:       _billedAt,
        // date is retained for local ledger compatibility; billed_at is the
        // authoritative timestamptz sent to Supabase.
        date:            _billedAt.split('T')[0],
        timestamp,
        customer_name:   custName,
        customer_phone:  custPhone,
        staff_name:      staffNameTag,
        discount_pct:    disc,
        // SCHEMA FIX: invoices.discount_amount NOT NULL, must be explicit
        discount_amount: parseFloat(deduction.toFixed(2)),
        subtotal:        parseFloat(subtotal.toFixed(2)),
        net_total:       parseFloat(rounded.toFixed(2)),
        round_off_amt:   roStep > 0 ? parseFloat(roundOffAmt.toFixed(2)) : 0,
        payment_method:  _paymentMethod,
        cash_received:   _cashReceived,
        change_amount:   _changeAmount,
        line_items:      queueLineItems,
        is_edit:         isEdit,
        is_manual:       _hasManual
    };

    // ── STEP 5: Push to offline_sync_queue ────────────────────────────────
    // pushToSyncQueue is async and non-blocking for the UI; failures are
    // handled inside StorageModule — the invoice is already safely written
    // to the local ledger above, so data is never lost even if this throws.
    try {
        await StorageModule.pushToSyncQueue('INVOICE', invoiceQueuePayload, maxCapturedVersion);
    } catch(qErr) {
        console.warn('[Checkout] pushToSyncQueue failed (non-fatal):', qErr);
    }

    // ── STEP 6: Local cache mutations — identical to previous behaviour ───
    finalDetails.forEach(item => {
        const prod = masterInventoryDB.find(p => p.code === item.code);
        if (prod) {
            const soldQty  = parseInt(item.qty, 10) || 0;
            const newStock = Math.max(0, Number(prod.stock) - soldQty);
            const deducted = Number(prod.stock) - newStock;
            prod.stock = newStock;
            _recordInvMovement(item.code, -deducted, 'SALE', invoiceID, null, newStock);
            _atomicStockWriteBack(item.code, newStock);
        }
    });

    try { saveInventoryToDB(masterInventoryDB); } catch(e) { showToast('⚠️ Inventory save failed.', true); }
    StorageModule.clearCart();

    // ── STEP 7: DOM receipt population ───────────────────────────────────
    const cur = _getCurrency();
    document.getElementById('printInvId').textContent      = _escHtml(invoiceID);
    document.getElementById('printDate').textContent       = _escHtml(timestamp);
    document.getElementById('printSubtotal').textContent   = cur + subtotal.toFixed(2);
    document.getElementById('printDiscPerc').textContent   = disc;
    document.getElementById('printDiscValue').textContent  = cur + deduction.toFixed(2);
    document.getElementById('printNetPayable').textContent = cur + rounded.toFixed(2);
    const printRoRow = document.getElementById('printRoundOffRow');
    const printRoAmt = document.getElementById('printRoundOffAmt');
    if (roStep > 0 && printRoRow && printRoAmt) { printRoRow.style.display = ''; printRoAmt.textContent = (roundOffAmt >= 0 ? '+' : '-') + cur + Math.abs(roundOffAmt).toFixed(2); } else if (printRoRow) { printRoRow.style.display = 'none'; }
    const printOpEl = document.getElementById('printOperatorId');
    if (printOpEl && staffNameTag) printOpEl.textContent = _escHtml(staffNameTag);
    if (custName || custPhone) {
        document.getElementById('printCustomerName').textContent  = _escHtml(custName || '—');
        document.getElementById('printCustomerPhone').textContent = _escHtml(custPhone);
        document.getElementById('printCustomerRow').style.display = '';
    } else { document.getElementById('printCustomerRow').style.display = 'none'; }

    let printHTML = '';
    const _tsPrint = _getThermalSettings();
    finalDetails.forEach(item => {
        printHTML += '<div class="item-print-block"><div class="item-desc-row">' + _escHtml(item.name) + '</div><div class="item-meta-row">' + (_tsPrint.showUnitPrice ? '<span>' + _escHtml(String(parseInt(item.qty, 10))) + ' Pcs × ' + _escHtml(cur) + (parseFloat(item.unitPrice) || 0).toFixed(2) + '</span>' : '<span>' + _escHtml(String(parseInt(item.qty, 10))) + ' Pcs</span>') + '<span>' + _escHtml(cur) + (parseFloat(item.total) || 0).toFixed(2) + '</span></div></div>';
    });
    document.getElementById('printReceiptItemsContainer').innerHTML = printHTML;

    // ── STEP 8: UI teardown & clear ───────────────────────────────────────
    lastSavedInvoiceId = invoiceID;
    activeCartItems = []; selectedProductRef = null;
    discountInput.value = '0';
    document.getElementById('customerNameInput').value  = '';
    document.getElementById('customerPhoneInput').value = '';
    document.getElementById('cashReceivedInput').value  = '';
    document.getElementById('changeRow').style.display  = 'none';
    f9EditMode = false; f9ActiveRow = -1;
    // Phase 5: reset payment mode to cash default after successful save
    _activePaymentMethod = 'cash';
    setPaymentMode('cash');
    renderInvoiceUI();
    clearSearch(true);
    updateHdrStats();
    renderHistoryCards(_newLedger); // render from local snapshot; savedInvoicesLedger commits async via oncomplete
    const rpInv = document.getElementById('rpInvLabel');
    if (rpInv) rpInv.textContent = _escHtml(invoiceID);

    if (document.getElementById('printReceiptOnSave').checked) {
        setTimeout(() => window.print(), 120);
    }
    showToast('✅ Bill ' + _escHtml(invoiceID) + ' saved!');
    } catch (checkoutErr) {
        console.error('[Checkout] Failed:', checkoutErr);
        showToast('❌ Checkout failed: ' + (checkoutErr && checkoutErr.message ? checkoutErr.message : 'Unknown error'), true);
    }
}

function recallLastSaved() {
    if (!lastSavedInvoiceId) { showToast('❌ No recent bill to recall.', true); return; }
    const inv = savedInvoicesLedger.find(i => i.id === lastSavedInvoiceId);
    if (!inv) { showToast('❌ Last invoice not found.', true); return; }
    if (inv.refunded) { showToast('⚠️ This invoice has been fully refunded.', true); return; }
    if (activeCartItems.length > 0) {
        showConfirmModal('Recalling the last invoice will replace your current unsaved bill. Continue?',
            () => _doRecallLastSaved(inv), null, 'Recall', true);
        return;
    }
    _doRecallLastSaved(inv);
}
function _doRecallLastSaved(inv) {
    currentlyEditingInvoiceId = inv.id;
    activeCartItems = (inv.details || []).map(d => ({
        code:      d.code,
        name:      d.name,
        unitPrice: parseFloat(d.unitPrice) || 0,
        qty:       parseInt(d.qty, 10) || 0,
        total:     parseFloat(d.total) || 0
    }));
    activeCartItems.forEach(item => {
        const prod = masterInventoryDB.find(p => p.code === item.code);
        if (prod) {
            prod.stock = Number(prod.stock) + parseInt(item.qty, 10);
            _recordInvMovement(item.code, parseInt(item.qty, 10), 'EDIT_RESTORE', inv.id, null, Number(prod.stock));
            _atomicStockWriteBack(item.code, prod.stock);
        }
    });
    try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
    discountInput.value = inv.discountPct || 0;
    document.getElementById('customerNameInput').value  = inv.customerName  || '';
    document.getElementById('customerPhoneInput').value = inv.customerPhone || '';
    syncDiscountPresetButtons(parseFloat(discountInput.value) || 0);
    switchTab('billingView', document.getElementById('tab-billing'));
    renderInvoiceUI();
    showToast('✏️ Editing Invoice ' + _escHtml(inv.id) + '.');
}

// ── _doUpdateBill(invoiceId) ──────────────────────────────────────────────
// Called by auth.js after UPDATE_BILL admin access is granted.
// Loads any ledger invoice (by ID) into the billing cart for editing.
// Identical flow to _doRecallLastSaved but looks up by explicit ID.
async function _doUpdateBill(invoiceId) {
    let inv = savedInvoicesLedger.find(i => i.id === invoiceId);

    // If details are empty, try fetching from Supabase (same as View Bill)
    if (inv && (!Array.isArray(inv.details) || inv.details.length === 0)) {
        if (navigator.onLine && typeof _dbSelect === 'function') {
            try {
                const { data, error } = await _dbSelect(
                    'invoices',
                    'invoice_number=eq.' + encodeURIComponent(invoiceId),
                    '*,invoice_items(*)'
                );
                if (!error && Array.isArray(data) && data.length > 0) {
                    const row = data[0];
                    inv.details = Array.isArray(row.invoice_items)
                        ? row.invoice_items.map(li => ({
                            code:       li.product_code || '',
                            name:       li.product_name || '',
                            packDetails: li.pack_size   || '',
                            unitPrice:  Number(li.unit_price) || 0,
                            qty:        Number(li.qty)        || 0,
                            total:      Number(li.total)      || 0
                        }))
                        : [];
                    // F18: persist patched details so they survive page reload
                    try { StorageModule.saveInvoices(savedInvoicesLedger); } catch(_se) {}
                }
            } catch (_e) { /* proceed with whatever details we have */ }
        }
    }

    if (!inv) { showToast('❌ Invoice ' + _escHtml(invoiceId) + ' not found. Try syncing first.', true); return; }
    if (inv.refunded)  { showToast('⚠️ This invoice has been fully refunded and cannot be edited.', true); return; }
    if (inv.isRefund)  { showToast('⚠️ Refund records cannot be edited.', true); return; }
    if (!Array.isArray(inv.details) || inv.details.length === 0) {
        showToast('⚠️ Invoice details missing — cannot load into editor. Try syncing first.', true); return;
    }

    function _doLoad() {
        currentlyEditingInvoiceId = inv.id;
        activeCartItems = inv.details.map(d => ({
            code:      d.code,
            name:      d.name,
            unitPrice: parseFloat(d.unitPrice) || 0,
            qty:       parseInt(d.qty, 10) || 0,
            total:     parseFloat(d.total) || 0
        }));
        // Restore stock temporarily so the edit checkout re-deducts correctly
        activeCartItems.forEach(item => {
            const prod = masterInventoryDB.find(p => p.code === item.code);
            if (prod) {
                prod.stock = Number(prod.stock) + parseInt(item.qty, 10);
                _recordInvMovement(item.code, parseInt(item.qty, 10), 'EDIT_RESTORE', inv.id, null, Number(prod.stock));
                _atomicStockWriteBack(item.code, prod.stock);
            }
        });
        try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
        discountInput.value = inv.discountPct || 0;
        document.getElementById('customerNameInput').value  = inv.customerName  || '';
        document.getElementById('customerPhoneInput').value = inv.customerPhone || '';
        syncDiscountPresetButtons(parseFloat(discountInput.value) || 0);
        switchTab('billingView', document.getElementById('tab-billing'));
        renderInvoiceUI();
        showToast('✏️ Editing Invoice ' + _escHtml(inv.id) + '.');
    }

    if (activeCartItems.length > 0) {
        showConfirmModal(
            'Loading invoice ' + _escHtml(invoiceId) + ' for editing will replace your current unsaved bill. Continue?',
            _doLoad, null, 'Load for Edit', true
        );
    } else {
        _doLoad();
    }
}

// =========================================================================
// FULL REFUND — processFullRefund
// =========================================================================
function processFullRefund(invoiceId) {
    const original = savedInvoicesLedger.find(i => i.id === invoiceId);
    if (!original) { showToast('❌ Invoice not found.', true); return; }
    if (original.isRefund || original.isPartialRefund) { showToast('⚠️ Cannot refund a refund record.', true); return; }
    if (original.refunded) { showToast('⚠️ This invoice has already been fully refunded.', true); return; }
    const hasPartialRefund = savedInvoicesLedger.some(inv => inv.isPartialRefund && inv.originalId === invoiceId);
    if (hasPartialRefund) { showToast('⚠️ A partial refund already exists for this invoice. Use partial refund to process the remainder.', true); return; }
    original.refunded = true;

    (original.details || []).forEach(item => {
        const prod = masterInventoryDB.find(p => p.code === item.code);
        const returnQty = parseInt(item.qty, 10) || 0;
        if (prod) {
            _recordInvMovement(item.code, returnQty, 'REFUND', invoiceId, null, Number(prod.stock) + returnQty);
            prod.stock = Number(prod.stock) + returnQty;
            _atomicStockWriteBack(item.code, prod.stock);
        }
    });

    try { saveInventoryToDB(masterInventoryDB); } catch(e) { showToast('⚠️ Inventory save failed.', true); }

    const refId = 'REF-' + invoiceId + '-' + Date.now().toString(36).toUpperCase().slice(-4);
    const refInvoice = {
        id: refId, deviceCode: _getDeviceCode(),
        date: new Date(Date.now() + _getClockOffset()).toISOString().split('T')[0],
        timestamp: new Date().toLocaleString([], { year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }),
        customerName: original.customerName || '', customerPhone: original.customerPhone || '',
        staffName: original.staffName || '', itemCount: original.itemCount,
        netTotal: -(Number(original.netTotal) || 0),
        details: (original.details || []).map(i => Object.assign({}, i, { qty: -(parseInt(i.qty, 10) || 0), total: -(parseFloat(i.total) || 0) })),
        refunded: false, isRefund: true, isManual: original.isManual || false, originalId: invoiceId
    };
    // SSOT Write-Through Log: build updated ledger without mutating savedInvoicesLedger yet.
    // The in-memory array is committed only in the saveInvoices oncomplete callback.
    const _refLedger = savedInvoicesLedger.concat([refInvoice]);
    try {
        StorageModule.saveInvoices(_refLedger, function(committedLedger) {
            savedInvoicesLedger = committedLedger; // memory updated only on IDB success
        });
    } catch(e) { showToast('⚠️ Storage full!', true); }

    // ── PHASE 5: Push full refund to offline_sync_queue ───────────────────
    // Refund invoices use is_refund=true on the Supabase `invoices` row.
    // deduct_inventory_atomic is called with POSITIVE qty (returning stock).
    // The RPC movement_type will be 'REFUND' — this is handled by synchub.js
    // _processInvoiceItem, which already spreads coreInvoiceFields into the upsert.
    //
    // HANDOFF NOTE — synchub.js:
    //   _processInvoiceItem must pass p_movement_type='REFUND' to the RPC for
    //   refund line items (positive qty).  Currently the RPC call in
    //   _callDeductInventoryAtomic does not send p_movement_type — add it, and
    //   derive it from a `movement_type` field on each line_item in the payload.
    (function _pushFullRefundToQueue() {
        try {
            const _refBilledAt = new Date(Date.now() + _getClockOffset()).toISOString();
            const refLineItems = (original.details || []).map(i => ({
                product_code:     i.code,
                name:             i.name             || '',
                unitPrice:        parseFloat(i.unitPrice) || 0,
                // Positive qty — returning stock back to inventory
                quantity:         Math.abs(parseInt(i.qty, 10) || 0),
                total:            Math.abs(parseFloat(i.total) || 0),
                expected_version: i.capturedVersion  || 1,
                movement_type:    'REFUND'
            }));
            const maxVer = refLineItems.reduce((mx, l) => Math.max(mx, l.expected_version), 1);
            const refPayload = {
                invoice_number:   refId,
                counter_id:       _getDeviceCode(),
                device_uuid:      (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : '',
                billed_at:        _refBilledAt,
                date:             _refBilledAt.split('T')[0],
                customer_name:    original.customerName  || '',
                customer_phone:   original.customerPhone || '',
                staff_name:       original.staffName     || '',
                discount_pct:     original.discountPct   || 0,
                discount_amount:  0,  // full refund — no further discount computed
                subtotal:         Number(original.netTotal) || 0,
                net_total:        Number(original.netTotal) || 0,
                round_off_amt:    original.roundOffAmt   || 0,
                payment_method:   null,
                cash_received:    null,
                change_amount:    null,
                is_refund:        true,
                is_partial_refund: false,
                is_manual:        original.isManual || false,
                original_invoice_id: invoiceId,
                refund_reason:    'full_refund',
                line_items:       refLineItems
            };
            StorageModule.pushToSyncQueue('INVOICE', refPayload, maxVer).catch(e => {
                console.warn('[FullRefund] pushToSyncQueue failed (non-fatal):', e);
            });
            // SCHEMA FIX: mark original invoice as is_fully_refunded=true in Supabase.
            // Push a minimal INVOICE_UPDATE so syncHub can patch the original row.
            // Uses is_edit:true so the upsert path runs without touching line_items.
            StorageModule.pushToSyncQueue('INVOICE_UPDATE', {
                invoice_number:    invoiceId,
                is_fully_refunded: true
            }, 1).catch(e => {
                console.warn('[FullRefund] is_fully_refunded update push failed (non-fatal):', e);
            });
        } catch(qErr) {
            console.warn('[FullRefund] Queue payload assembly failed (non-fatal):', qErr);
        }
    })();

    updateHdrStats(); renderHistoryCards(_refLedger);
    showToast('↩ Refund ' + _escHtml(refId) + ' created. Stock restored.');
}

function updateStatsCounters() {
    const badge = document.getElementById('holdCount');
    if (badge) badge.textContent = temporaryHeldBills.length;
}

function switchTab(tabId, btn) {
    const onBilling = document.getElementById('billingView') && document.getElementById('billingView').classList.contains('active');
    if (onBilling && tabId !== 'billingView' && typeof activeCartItems !== 'undefined' && activeCartItems.length > 0) {
        showConfirmModal(
            { title: 'Leave this bill?', subtitle: 'You have unsaved items. Switching tabs will not clear your bill — it stays until you save or discard it.' },
            function() { _doSwitchTab(tabId, btn); },
            null, 'Continue', false, 'Stay', 'amber'
        );
        return;
    }
    _doSwitchTab(tabId, btn);
}
function _doSwitchTab(tabId, btn) {
    document.querySelectorAll('.view').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    btn.classList.add('active');
    const rp = document.getElementById('rightPanel');
    if (rp) {
        const isMobile = window.innerWidth <= 800;
        rp.style.display = (tabId === 'billingView') ? (isMobile ? 'block' : 'flex') : 'none';
    }
    if (tabId === 'holdView')      renderHeldBillsTable();
    if (tabId === 'historyView')   _restoreHistoryView();
    if (tabId === 'settingsView')  _loadSettingsForm();
    if (tabId === 'inventoryView') { if (typeof showInventoryPlaceholder === 'function') showInventoryPlaceholder(); }
    if (tabId === 'syncHubView')   { if (typeof renderSyncHubView     === 'function') renderSyncHubView();  }
    if (tabId === 'billingView')  setTimeout(() => searchBox.focus(), 50);
}
function _restoreHistoryView() {
    _populateDeviceDropdown();
    // FIX: Always refresh from Supabase when history tab opens so invoices
    // from other devices (and any new synced records) are always visible.
    // _loadLedgerCloud is defined in history.js and merges cloud + local.
    if (typeof _loadLedgerCloud === 'function') {
        _loadLedgerCloud().catch(() => {
            // Offline fallback: render what we have locally
            const startEl = document.getElementById('filterStartDate');
            if (startEl && startEl.value) { applyDateLedgerFilters(); }
            else { resetLedgerFilters(); }
        });
    } else {
        const startEl = document.getElementById('filterStartDate');
        if (startEl && startEl.value) { applyDateLedgerFilters(); }
        else { resetLedgerFilters(); }
    }
}

function toggleShortcutsModal() { document.getElementById('shortcutsModal').classList.toggle('visible'); }
document.getElementById('shortcutsModal').addEventListener('click', e => { if (e.target === document.getElementById('shortcutsModal')) toggleShortcutsModal(); });

function showToast(message, isError = false) {
    const toast = document.getElementById('alertToast');
    toast.style.background = isError ? 'var(--red-mid)' : 'var(--grn)';
    document.getElementById('toastIcon').textContent = isError ? '✕' : '✓';
    document.getElementById('toastMsg').textContent  = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function togglePrint() {
    const cb = document.getElementById('printReceiptOnSave');
    cb.checked = !cb.checked;
    document.getElementById('printSwitch').className = 'tog-sw ' + (cb.checked ? 'on' : '');
}

function openQuickAdd() { document.getElementById('quickAddModal').classList.add('visible'); setTimeout(() => document.getElementById('qaName').focus(), 100); }
function closeQuickAdd() {
    document.getElementById('quickAddModal').classList.remove('visible');
    ['qaName','qaPrice'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('qaQty').value = '1';
}
function _nextManualCode() { const count = activeCartItems.filter(i => (i.code || '').startsWith('MANUAL')).length; return 'MANUAL-' + String(count + 1).padStart(3, '0'); }
function confirmQuickAdd() {
    const name     = document.getElementById('qaName').value.trim();
    const priceRaw = document.getElementById('qaPrice').value.trim();
    const qtyRaw   = document.getElementById('qaQty').value.trim();
    const price    = parseFloat(priceRaw);
    const qty      = parseInt(qtyRaw, 10);
    if (!name || name.length < 2)                { showToast('❌ Enter a valid medicine name (at least 2 characters).', true); return; }
    if (isNaN(price) || price <= 0)              { showToast('❌ Price must be a number greater than 0.', true); return; }
    if (isNaN(qty) || qty < 1 || String(qty) !== qtyRaw.replace(/\.0+$/, '').trim()) { showToast('❌ Quantity must be a whole number ≥ 1.', true); return; }
    activeCartItems.push({ code:_nextManualCode(), name, unitPrice:price, qty, total:Number((price*qty).toFixed(2)) });
    renderInvoiceUI(); closeQuickAdd();
    switchTab('billingView', document.getElementById('tab-billing'));
    showToast('✅ ' + _escHtml(name) + ' added manually.');
}
document.getElementById('qaQty').addEventListener('keydown',   e => { if (e.key === 'Enter') confirmQuickAdd(); });
document.getElementById('qaName').addEventListener('keydown',  e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('qaPrice').focus(); } });
document.getElementById('qaPrice').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmQuickAdd(); } });
document.getElementById('quickAddModal').addEventListener('click', e => { if (e.target === document.getElementById('quickAddModal')) closeQuickAdd(); });

window.addEventListener('beforeunload', function(e) {
    if (typeof activeCartItems !== 'undefined' && activeCartItems.length > 0) { e.preventDefault(); e.returnValue = ''; return ''; }
});

// =========================================================================
// SEARCH 2 — Double Filter Engine
// =========================================================================
function toggleSearch2() {
    const row = document.getElementById('search2Row'); if (!row) return;
    const btn = document.getElementById('search2Toggle'); if (!btn) return;
    const isOpen = row.style.display !== 'none' && row.style.display !== '';
    if (isOpen) {
        row.style.display = 'none'; btn.classList.remove('active');
        clearSearch2Filter(); clearSearch2Input();
    } else {
        row.style.display = 'block'; btn.classList.add('active');
        const s2 = document.getElementById('search2Box'); if (s2) setTimeout(() => s2.focus(), 80);
    }
}
function clearSearch2Filter() {
    const s2Box = document.getElementById('search2Box');
    const s2Tag = document.getElementById('s2TagText');
    const s2Res = document.getElementById('search2Results');
    const s2None= document.getElementById('search2NoResults');
    if (s2Box)  { s2Box.value = ''; }
    if (s2Tag)  s2Tag.textContent = 'Filter 1: —';
    if (s2Res)  { const rows = s2Res.querySelectorAll('.s2r-row'); rows.forEach(r => r.remove()); s2Res.style.display = 'none'; }
    if (s2None) { s2None.textContent = ''; s2None.classList.remove('visible'); }
}
function clearSearch2Input() {
    const s2Box = document.getElementById('search2Box');
    const s2Res = document.getElementById('search2Results');
    const s2None= document.getElementById('search2NoResults');
    if (s2Box) { s2Box.value = ''; }
    if (s2Res) { const rows = s2Res.querySelectorAll('.s2r-row'); rows.forEach(r => r.remove()); s2Res.style.display = 'none'; }
    if (s2None){ s2None.textContent = ''; s2None.classList.remove('visible'); }
}

(function _wireSearch2() {
    const s2Box  = document.getElementById('search2Box');
    const s2Res  = document.getElementById('search2Results');
    const s2None = document.getElementById('search2NoResults');
    const s2Tag  = document.getElementById('s2TagText');
    if (!s2Box) return;

    let _s2ActiveIdx = -1;
    let _s2BaseSet   = [];

    const _origToggle = window.toggleSearch2;
    window.toggleSearch2 = function() {
        _origToggle();
        const row = document.getElementById('search2Row');
        const isNowOpen = row && row.style.display !== 'none' && row.style.display !== '';
        if (isNowOpen) {
            const f1 = (searchBox ? searchBox.value.trim().toLowerCase() : '');
            _s2BaseSet = f1
                ? masterInventoryDB.filter(p =>
                    p.name.toLowerCase().includes(f1) ||
                    p.code.toLowerCase().includes(f1) ||
                    (p.generic && p.generic.toLowerCase().includes(f1))
                  )
                : masterInventoryDB.slice();
            if (s2Tag) s2Tag.textContent = f1 ? 'Filter 1: ' + f1 : 'Filter 1: all items';
            _runSearch2('');
        }
    };

    function _renderS2Rows(matches) {
        s2Res.querySelectorAll('.s2r-row').forEach(r => r.remove());
        _s2ActiveIdx = -1;
        if (matches.length === 0) {
            s2Res.style.display = 'none';
            if (s2None) { s2None.textContent = 'No products found.'; s2None.classList.add('visible'); }
            return;
        }
        if (s2None) { s2None.textContent = ''; s2None.classList.remove('visible'); }
        const cur = _getCurrency();
        matches.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 's2r-row';
            row.dataset.idx = i;

            const numEl  = document.createElement('span'); numEl.className = 's2r-num'; numEl.textContent = i + 1;
            const nameWrap = document.createElement('div'); nameWrap.className = 's2r-name-wrap';
            const nameEl = document.createElement('div'); nameEl.className = 's2r-name'; nameEl.textContent = item.name;
            const codeEl = document.createElement('div'); codeEl.className = 's2r-code'; codeEl.textContent = item.code;
            nameWrap.appendChild(nameEl); nameWrap.appendChild(codeEl);
            const packEl  = document.createElement('span'); packEl.className = 's2r-pack';  packEl.textContent = item.packDetails || '—';
            const genEl   = document.createElement('span'); genEl.className = 's2r-gen';   genEl.textContent = item.generic || '—';
            const isLow   = Number(item.stock) <= 5;
            const stockEl = document.createElement('span'); stockEl.className = 's2r-stock' + (isLow ? ' low' : ''); stockEl.textContent = Number(item.stock);
            const priceEl = document.createElement('span'); priceEl.className = 's2r-price'; priceEl.textContent = cur + (parseFloat(item.unitPrice) || 0).toFixed(2);

            row.appendChild(numEl); row.appendChild(nameWrap); row.appendChild(packEl);
            row.appendChild(genEl); row.appendChild(stockEl); row.appendChild(priceEl);

            row.addEventListener('mousedown', e => e.preventDefault());
            row.addEventListener('click', () => {
                triggerProductSelection(item);
                clearSearch2Input();
                s2Box.blur();
                if (typeof searchBox !== 'undefined' && searchBox) {
                    searchBox.value = '';
                    const _sr = document.getElementById('searchResults');
                    if (_sr) { _sr.querySelectorAll('.sr-row').forEach(r => r.remove()); _sr.style.display = 'none'; }
                    const _snr = document.getElementById('searchNoResults');
                    if (_snr) { _snr.textContent = ''; _snr.classList.remove('visible'); }
                    const _scb = document.getElementById('searchClearBtn');
                    if (_scb) _scb.style.display = 'none';
                }
            });
            s2Res.appendChild(row);
        });
        s2Res.style.display = 'block';
    }

    function _runSearch2(val) {
        const q    = val.toLowerCase().trim();
        const pool = _s2BaseSet.length ? _s2BaseSet : masterInventoryDB;
        const matches = (q
            ? pool.filter(p =>
                p.name.toLowerCase().includes(q) ||
                p.code.toLowerCase().includes(q) ||
                (p.generic && p.generic.toLowerCase().includes(q))
              )
            : pool
        ).slice(0, 14);
        _renderS2Rows(matches);
    }

    s2Box.addEventListener('input', function() {
        _runSearch2(this.value);
        const clrBtn = document.getElementById('search2ClearBtn');
        if (clrBtn) clrBtn.style.display = this.value ? 'flex' : 'none';
    });

    s2Box.addEventListener('keydown', function(e) {
        const rows = s2Res.querySelectorAll('.s2r-row');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (_s2ActiveIdx < rows.length - 1) {
                if (_s2ActiveIdx >= 0) rows[_s2ActiveIdx].classList.remove('selected');
                _s2ActiveIdx++;
                rows[_s2ActiveIdx].classList.add('selected');
                rows[_s2ActiveIdx].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (_s2ActiveIdx > 0) {
                rows[_s2ActiveIdx].classList.remove('selected');
                _s2ActiveIdx--;
                rows[_s2ActiveIdx].classList.add('selected');
                rows[_s2ActiveIdx].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (_s2ActiveIdx >= 0 && rows[_s2ActiveIdx]) { rows[_s2ActiveIdx].click(); }
            else if (rows.length > 0) { rows[0].click(); }
        } else if (e.key === 'Escape') {
            clearSearch2Input();
            _runSearch2('');
        }
    });

    s2Box.addEventListener('blur', function() {
        setTimeout(() => {
            const focused = document.activeElement;
            const row = document.getElementById('search2Row');
            if (row && !row.contains(focused)) {
                s2Res.querySelectorAll('.s2r-row').forEach(r => r.remove());
                s2Res.style.display = 'none';
                if (s2None) { s2None.textContent = ''; s2None.classList.remove('visible'); }
            }
        }, 150);
    });
})();

// =========================================================================
// STEP QTY
// =========================================================================
function stepQty(delta) {
    const inp = document.getElementById('billQty'); if (!inp) return;
    const cur  = parseInt(inp.value, 10) || 1;
    const next = Math.max(1, cur + parseInt(delta, 10));
    inp.value  = next;
}

// =========================================================================
// PARTIAL REFUND
// =========================================================================
let _prfInvoiceId = null;
let _prfMode      = 'partial';

function openPartialRefundModal(invoiceId) {
    const inv = savedInvoicesLedger.find(i => i.id === invoiceId);
    if (!inv) { showToast('❌ Invoice not found.', true); return; }

    _prfInvoiceId = invoiceId;
    _prfMode      = 'partial';

    const modal = document.getElementById('partialRefundModal'); if (!modal) return;
    document.getElementById('prfInvLabel').textContent   = 'Invoice ' + _escHtml(invoiceId);
    document.getElementById('prfCustName').textContent   = _escHtml(inv.customerName || '—');
    document.getElementById('prfOrigTotal').textContent  = _getCurrency() + (Number(inv.netTotal) || 0).toFixed(2);
    document.getElementById('prfDate').textContent       = _escHtml(inv.timestamp || '—');

    const wrap = document.getElementById('prfItemsWrap'); if (!wrap) return;
    wrap.innerHTML = '';
    const alreadyRefundedQtyMap = {};
    (inv.partialRefunds || []).forEach(pr => {
        const prInv = savedInvoicesLedger.find(i => i.id === pr.refId);
        (prInv?.details || []).forEach(d => {
            if (d.code) alreadyRefundedQtyMap[d.code] = (alreadyRefundedQtyMap[d.code] || 0) + Math.abs(parseInt(d.qty, 10) || 0);
        });
    });
    (inv.details || []).forEach((item, idx) => {
        const alreadyQty   = alreadyRefundedQtyMap[item.code] || 0;
        const remainingQty = Math.max(0, (parseInt(item.qty, 10) || 0) - alreadyQty);
        const row = document.createElement('div'); row.className = 'prf-item-row'; row.dataset.idx = idx;
        row.dataset.remaining = remainingQty;
        if (remainingQty === 0) row.classList.add('prf-item-fully-refunded');
        row.innerHTML =
            '<label class="prf-item-chk-wrap">' +
              '<input type="checkbox" class="prf-item-cb" data-idx="' + idx + '"' + (remainingQty > 0 ? ' checked' : ' disabled') + ' onchange="_prfUpdateTotals()">' +
            '</label>' +
            '<span class="prf-item-name">' + _escHtml(item.name) + (remainingQty === 0 ? ' <span class="prf-refunded-tag">Fully Refunded</span>' : '') + '</span>' +
            '<span class="prf-item-uprice">' + _getCurrency() + (parseFloat(item.unitPrice) || 0).toFixed(2) + '</span>' +
            '<span class="prf-item-origqty">' + (parseInt(item.qty, 10) || 0) + (alreadyQty > 0 ? ' <span class="prf-already-refunded">(-' + alreadyQty + ' refunded)</span>' : '') + '</span>' +
            '<input type="number" class="prf-item-qinp" data-idx="' + idx + '" value="' + remainingQty + '" min="0" max="' + remainingQty + '" step="1"' + (remainingQty === 0 ? ' disabled' : '') + ' oninput="_prfUpdateTotals()">' +
            '<span class="prf-item-refamt" data-idx="' + idx + '">' + _getCurrency() + (remainingQty * (parseFloat(item.unitPrice) || 0)).toFixed(2) + '</span>';
        wrap.appendChild(row);
    });

    _syncPrfModeBtns();
    _prfUpdateTotals();
    document.getElementById('prfSelAllCb').checked = true;
    modal.classList.add('visible');
}

function closePartialRefundModal() {
    const modal = document.getElementById('partialRefundModal');
    if (modal) modal.classList.remove('visible');
    _prfInvoiceId = null;
}

function setPrfMode(mode) {
    _prfMode = mode;
    _syncPrfModeBtns();
    const selAllRow = document.getElementById('prfSelAllRow');
    const wrap      = document.getElementById('prfItemsWrap');
    if (mode === 'full') {
        if (wrap) wrap.querySelectorAll('.prf-item-cb').forEach(cb => { cb.checked = true; });
        if (wrap) wrap.querySelectorAll('.prf-item-qinp').forEach(inp => { inp.value = inp.max; });
        if (selAllRow) selAllRow.style.display = 'none';
    } else {
        if (selAllRow) selAllRow.style.display = '';
    }
    _prfUpdateTotals();
}

function _syncPrfModeBtns() {
    const pBtn = document.getElementById('prfModePartial');
    const fBtn = document.getElementById('prfModeFull');
    if (pBtn) pBtn.classList.toggle('active', _prfMode === 'partial');
    if (fBtn) fBtn.classList.toggle('active', _prfMode === 'full');
}

function prfToggleAll(checked) {
    const wrap = document.getElementById('prfItemsWrap'); if (!wrap) return;
    wrap.querySelectorAll('.prf-item-cb').forEach(cb => { cb.checked = checked; });
    _prfUpdateTotals();
}

function _prfUpdateTotals() {
    const inv = _prfInvoiceId ? savedInvoicesLedger.find(i => i.id === _prfInvoiceId) : null;
    if (!inv) return;
    const wrap = document.getElementById('prfItemsWrap'); if (!wrap) return;
    const discountPct    = typeof inv.discountPct === 'number' ? inv.discountPct : 0;
    const discountFactor = 1 - (discountPct / 100);
    let totalAmt = 0, totalItems = 0, totalUnits = 0;
    wrap.querySelectorAll('.prf-item-row').forEach((row, idx) => {
        const cb    = row.querySelector('.prf-item-cb');
        const qinp  = row.querySelector('.prf-item-qinp');
        const amtEl = row.querySelector('.prf-item-refamt');
        const item  = (inv.details || [])[idx];
        if (!item || !cb || !qinp || !amtEl) return;
        const checked      = cb.checked && !cb.disabled;
        const maxRemaining = parseInt(row.dataset.remaining != null ? row.dataset.remaining : qinp.max) || (parseInt(item.qty, 10) || 0);
        const qty = checked ? Math.max(0, Math.min(parseInt(qinp.value, 10) || 0, maxRemaining)) : 0;
        const amt = qty * (parseFloat(item.unitPrice) || 0) * discountFactor;
        amtEl.textContent = _getCurrency() + amt.toFixed(2);
        if (checked && qty > 0) { totalAmt += amt; totalItems++; totalUnits += qty; }
        qinp.disabled = !checked || maxRemaining === 0;
    });
    const warnEl    = document.getElementById('prfWarn');
    const warnMsg   = document.getElementById('prfWarnMsg');
    const submitBtn = document.getElementById('prfSubmitBtn');
    if (totalAmt <= 0) {
        if (warnEl)    warnEl.style.visibility  = 'visible';
        if (warnMsg)   warnMsg.textContent       = 'Select at least one item with quantity > 0.';
        if (submitBtn) submitBtn.disabled        = true;
    } else {
        if (warnEl)    warnEl.style.visibility  = 'hidden';
        if (submitBtn) submitBtn.disabled        = false;
    }
    const sumItems = document.getElementById('prfSumItems');
    const sumUnits = document.getElementById('prfSumUnits');
    const sumAmt   = document.getElementById('prfSumAmt');
    if (sumItems) sumItems.textContent = totalItems;
    if (sumUnits) sumUnits.textContent = totalUnits + ' units';
    if (sumAmt)   sumAmt.textContent   = _getCurrency() + totalAmt.toFixed(2);
}

function submitPartialRefund() {
    const inv = _prfInvoiceId ? savedInvoicesLedger.find(i => i.id === _prfInvoiceId) : null;
    if (!inv) { showToast('❌ Invoice not found.', true); return; }
    const wrap = document.getElementById('prfItemsWrap'); if (!wrap) return;

    const discountPct    = typeof inv.discountPct === 'number' ? inv.discountPct : 0;
    const discountFactor = 1 - (discountPct / 100);

    const alreadyRefundedQtyMap = {};
    (inv.partialRefunds || []).forEach(pr => {
        const prInv = savedInvoicesLedger.find(i => i.id === pr.refId);
        (prInv?.details || []).forEach(d => {
            if (d.code) alreadyRefundedQtyMap[d.code] = (alreadyRefundedQtyMap[d.code] || 0) + Math.abs(parseInt(d.qty, 10) || 0);
        });
    });

    const refundLines = [];
    let overRefundDetected = false;
    wrap.querySelectorAll('.prf-item-row').forEach((row, idx) => {
        const cb   = row.querySelector('.prf-item-cb');
        const qinp = row.querySelector('.prf-item-qinp');
        const item = (inv.details || [])[idx];
        if (!item || !cb || !cb.checked || cb.disabled) return;
        const alreadyQty   = alreadyRefundedQtyMap[item.code] || 0;
        const maxRemaining = Math.max(0, (parseInt(item.qty, 10) || 0) - alreadyQty);
        const returnQty    = Math.max(0, Math.min(parseInt(qinp.value, 10) || 0, maxRemaining));
        if (returnQty <= 0) return;
        if (returnQty > maxRemaining) { overRefundDetected = true; return; }
        const refAmt = returnQty * (parseFloat(item.unitPrice) || 0) * discountFactor;
        refundLines.push({
            code:      item.code,
            name:      item.name,
            unitPrice: parseFloat(item.unitPrice) || 0,
            qty:       -returnQty,
            total:     -Number(refAmt.toFixed(2)),
            returnQty
        });
    });

    if (overRefundDetected) { showToast('⚠️ Return quantity exceeds available refundable quantity.', true); return; }
    if (refundLines.length === 0) { showToast('⚠️ No valid refund lines selected.', true); return; }

    const reason      = document.getElementById('prfReason')?.value || 'customer_return';
    const refAmt      = refundLines.reduce((s, l) => s + Math.abs(parseFloat(l.total) || 0), 0);
    const seq         = (inv.partialRefunds || []).length + 1;
    const refId       = (_prfMode === 'full')
        ? ('RF-' + _prfInvoiceId)
        : ('PRF-' + _prfInvoiceId + (seq > 1 ? '-' + seq : ''));

    refundLines.forEach(line => {
        const prod      = masterInventoryDB.find(p => p.code === line.code);
        const returnQty = parseInt(line.returnQty, 10) || 0;
        if (prod) {
            _recordInvMovement(line.code, returnQty, 'PARTIAL_REFUND', refId, null, Number(prod.stock) + returnQty);
            prod.stock = Number(prod.stock) + returnQty;
            _atomicStockWriteBack(line.code, prod.stock);
        }
    });

    try { saveInventoryToDB(masterInventoryDB); } catch(e) { showToast('⚠️ Inventory save error.', true); }

    const refInvoice = {
        id:           refId,
        deviceCode:   _getDeviceCode(),
        date:         new Date().toISOString().split('T')[0],
        timestamp:    new Date().toLocaleString([], { year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }),
        customerName: inv.customerName  || '',
        customerPhone:inv.customerPhone || '',
        staffName:    inv.staffName     || '',
        itemCount:    refundLines.length,
        netTotal:     -Number(refAmt.toFixed(2)),
        details:      refundLines.map(l => ({ code:l.code, name:l.name, unitPrice:l.unitPrice, qty:l.qty, total:l.total })),
        refunded:     false,
        isPartialRefund: (_prfMode !== 'full'),
        isRefund:     (_prfMode === 'full'),
        isManual:     inv.isManual || false,
        originalId:   _prfInvoiceId,
        refundReason: reason
    };

    // F10: SSOT write-through — never mutate savedInvoicesLedger before IDB commit.
    // Build the new ledger as a concat snapshot; update the live reference only
    // inside the saveInvoices onSuccess callback so IDB and in-memory stay in sync.
    if (!inv.partialRefunds) inv.partialRefunds = [];
    inv.partialRefunds.push({ refId, amount: refAmt, date: refInvoice.date });

    const totalOrigQty   = (inv.details || []).reduce((s, d) => s + (parseInt(d.qty, 10) || 0), 0);
    const totalRefundedQ = (inv.partialRefunds || []).reduce((s, pr) => {
        const prInv = savedInvoicesLedger.find(i => i.id === pr.refId);
        return s + (prInv?.details || []).reduce((ss, d) => ss + Math.abs(parseInt(d.qty, 10) || 0), 0);
    }, 0);
    if (totalRefundedQ >= totalOrigQty) inv.refunded = true;

    const _refLedger = savedInvoicesLedger.concat([refInvoice]);
    try {
        StorageModule.saveInvoices(_refLedger, function(committedLedger) {
            savedInvoicesLedger = committedLedger || _refLedger;
        });
    } catch(e) { showToast('⚠️ Storage full!', true); }

    // ── PHASE 5: Push partial refund to offline_sync_queue ────────────────
    // is_partial_refund=true on the Supabase `invoices` row.
    // deduct_inventory_atomic called with POSITIVE qty per refundLine (returning stock).
    // movement_type='PARTIAL_REFUND' on each line item — synchub.js must pass this
    // through to the RPC as p_movement_type when that parameter is wired up.
    //
    // HANDOFF NOTE — synchub.js:
    //   Same as full refund: _callDeductInventoryAtomic needs a p_movement_type
    //   param derived from line_item.movement_type to correctly record PARTIAL_REFUND
    //   movements in the inventory_movements table.
    (function _pushPartialRefundToQueue() {
        try {
            const _prfBilledAt = new Date(Date.now() + _getClockOffset()).toISOString();
            const isFullViaModal = (_prfMode === 'full');
            const prfLineItems = refundLines.map(l => {
                // Lookup capturedVersion from the original invoice detail
                const origDetail = (inv.details || []).find(d => d.code === l.code);
                return {
                    product_code:     l.code,
                    name:             l.name             || '',
                    unitPrice:        parseFloat(l.unitPrice) || 0,
                    // Positive qty — returning stock
                    quantity:         Math.abs(parseInt(l.returnQty, 10) || 0),
                    total:            Math.abs(parseFloat(l.total) || 0),
                    expected_version: (origDetail && origDetail.capturedVersion) || 1,
                    movement_type:    'PARTIAL_REFUND'
                };
            });
            const maxVer = prfLineItems.reduce((mx, l) => Math.max(mx, l.expected_version), 1);
            const prfPayload = {
                invoice_number:      refId,
                counter_id:          _getDeviceCode(),
                device_uuid:         (typeof _DEVICE_UUID !== 'undefined') ? _DEVICE_UUID : '',
                billed_at:           _prfBilledAt,
                date:                _prfBilledAt.split('T')[0],
                customer_name:       inv.customerName  || '',
                customer_phone:      inv.customerPhone || '',
                staff_name:          inv.staffName     || '',
                discount_pct:        discountPct,
                // SCHEMA FIX: discount_amount column must be explicit
                discount_amount:     0,  // partial refund — no additional discount applied
                subtotal:            Number(refAmt.toFixed(2)),
                net_total:           Number(refAmt.toFixed(2)),
                round_off_amt:       0,
                payment_method:      null,
                cash_received:       null,
                change_amount:       null,
                is_refund:           isFullViaModal,
                is_partial_refund:   !isFullViaModal,
                is_manual:           inv.isManual || false,
                original_invoice_id: _prfInvoiceId,
                refund_reason:       reason,
                line_items:          prfLineItems
            };
            StorageModule.pushToSyncQueue('INVOICE', prfPayload, maxVer).catch(e => {
                console.warn('[PartialRefund] pushToSyncQueue failed (non-fatal):', e);
            });
        } catch(qErr) {
            console.warn('[PartialRefund] Queue payload assembly failed (non-fatal):', qErr);
        }
    })();

    updateHdrStats();
    renderHistoryCards(savedInvoicesLedger);
    closePartialRefundModal();
    showToast('↩ Partial refund ' + _escHtml(refId) + ' — ' + _getCurrency() + refAmt.toFixed(2) + ' credited. Stock restored.');
}
