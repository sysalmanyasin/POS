// =========================================================================
// HISTORY — CLOUD INTEGRATION (Phase 7 Step 2)
// =========================================================================
// Primary source: Supabase invoices table (all devices, ordered by billed_at DESC)
// Offline fallback: local IDB via savedInvoicesLedger (populated by billing.js init)
// =========================================================================

/**
 * Render the stale-device banner above the ledger table.
 * Yellow  = any device unseen for >10 min
 * Red     = any device unseen for >30 min
 * Hidden  = all devices recently active, or offline / DevicesModule unavailable
 */
async function _renderLedgerStaleBanner() {
    const container = document.getElementById('histStaleBanner');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = 'none';

    if (typeof DevicesModule === 'undefined' || typeof DevicesModule._fetchAllDevices !== 'function') return;

    let devices;
    try { devices = await DevicesModule._fetchAllDevices(); } catch(_e) { return; }
    if (!Array.isArray(devices) || devices.length === 0) return;

    const now = Date.now();
    const stale10 = [];
    const stale30 = [];

    devices.forEach(d => {
        if (!d.last_seen_at) return;
        const diffMins = (now - new Date(d.last_seen_at).getTime()) / 60000;
        const label = d.name || d.counter_id || d.uuid.slice(0,8);
        if (diffMins >= 30) stale30.push(label);
        else if (diffMins >= 10) stale10.push(label);
    });

    if (stale30.length === 0 && stale10.length === 0) return;

    const isCrit   = stale30.length > 0;
    const names    = [...stale30, ...stale10].join(', ');
    const icon     = isCrit ? '🔴' : '⚠️';
    const severity = isCrit ? 'Critical' : 'Warning';
    const color    = isCrit ? 'var(--red)' : '#b45309';
    const bg       = isCrit ? 'var(--red-lt,#fff1f2)' : '#fefce8';
    const border   = isCrit ? 'var(--red)' : '#fbbf24';

    container.style.display = 'block';
    container.style.cssText += ';margin-bottom:6px;padding:7px 12px;border-radius:4px;' +
        'font-size:11px;font-weight:600;border:1px solid ' + border + ';background:' + bg + ';color:' + color + ';';
    container.textContent = icon + ' ' + severity + ': Device(s) not synced recently — ' + names +
        '. Ledger may be incomplete for these counters.';
}

/**
 * Update the "as of last sync" label rendered inside the grand-total bar.
 */
function _renderAsOfSyncLabel() {
    const el = document.getElementById('histAsOfSync');
    if (!el) return;
    try {
        const key = (typeof window._LAST_SYNC_KEY !== 'undefined')
            ? window._LAST_SYNC_KEY
            : ('pharma_last_sync_time_' + (typeof _DEVICE_UUID !== 'undefined' ? _DEVICE_UUID.slice(0,8) : ''));
        const raw = localStorage.getItem(key);
        if (!raw) { el.textContent = ''; return; }
        const d   = new Date(raw);
        const pad = n => String(n).padStart(2, '0');
        el.textContent = '⏱ As of last sync: ' +
            d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch(_e) { el.textContent = ''; }
}

/**
 * Load the ledger — cloud primary, local fallback.
 *  1. Try Supabase: SELECT * FROM invoices ORDER BY billed_at DESC
 *  2. Map snake_case → camelCase and overwrite savedInvoicesLedger
 *  3. Offline/error: keep whatever savedInvoicesLedger already holds (IDB data from billing.js init)
 *  4. Render stale banner + "as of" label
 *  5. Populate device dropdown from DevicesModule (cloud) or local scan (fallback)
 *  6. Apply current filters or reset to today
 */
async function _loadLedgerCloud() {
    let cloudOk = false;

    if (navigator.onLine && typeof _dbSelect === 'function') {
        try {
            // Limit to 500 most-recent invoices to avoid PostgREST default cap (1 000).
            // A pharmacy doing 100 bills/day can see 5 days of history; Force-Sync
            // keeps the relational table complete for reporting.
            const { data, error } = await _dbSelect(
                'invoices',
                'order=billed_at.desc&limit=500',
                '*,invoice_items(*)'
            );
            if (!error && Array.isArray(data) && data.length > 0) {
                // Merge any local-only invoices (not yet flushed to cloud) so
                // pending bills stay visible until they appear in Supabase.
                const _cloudIds  = new Set(data.map(r => r.invoice_number));
                const _localOnly = (Array.isArray(savedInvoicesLedger) ? savedInvoicesLedger : [])
                    .filter(inv => !inv._fromCloud && !_cloudIds.has(inv.id));

                savedInvoicesLedger = data.map(row => ({
                    id:                row.invoice_number,
                    invoiceNumber:     row.invoice_number,
                    deviceUuid:        row.device_uuid         || '',
                    deviceCode:        row.counter_id          || '',
                    customerName:      row.customer_name       || '',
                    customerPhone:     row.customer_phone      || '',
                    staffName:         row.staff_name          || '',
                    subtotal:          Number(row.subtotal)         || 0,
                    discountPct:       Number(row.discount_pct)     || 0,
                    discountAmount:    Number(row.discount_amount)  || 0,
                    roundOffAmt:       Number(row.round_off_amt)    || 0,
                    netTotal:          Number(row.net_total)        || 0,
                    paymentMethod:     row.payment_method       || '',
                    cashReceived:      Number(row.cash_received)    || 0,
                    changeAmount:      Number(row.change_amount)    || 0,
                    isRefund:          !!row.is_refund,
                    isPartialRefund:   !!row.is_partial_refund,
                    isEdit:            !!row.is_edit,
                    isManual:          !!row.is_manual,
                    isFullyRefunded:   !!row.is_fully_refunded,
                    refunded:          !!row.is_fully_refunded,
                    originalId:        row.original_invoice_id  || null,
                    originalInvoiceId: row.original_invoice_id  || '',
                    refundReason:      row.refund_reason         || '',
                    billedAt:          row.billed_at             || '',
                    timestamp:         row.billed_at             || '',
                    date:              row.billed_at ? row.billed_at.slice(0, 10) : '',
                    createdAt:         row.created_at            || '',
                    details:           Array.isArray(row.invoice_items)
                        ? row.invoice_items.map(li => ({
                            code:        li.product_code   || '',
                            name:        li.product_name   || '',
                            packDetails: li.pack_size      || '',
                            unitPrice:   Number(li.unit_price) || 0,
                            qty:         Number(li.qty)        || 0,
                            total:       Number(li.total)      || 0
                        }))
                        : [],
                    _fromRemote: true,
                    _fromCloud:  true
                })).concat(_localOnly);

                if (_localOnly.length > 0) {
                    console.log('[history] Preserved', _localOnly.length, 'unsynced local invoice(s).');
                }
                if (data.length >= 500 && typeof showToast === 'function') {
                    showToast('ℹ️ Showing latest 500 invoices. Use date filters or Reporting for older records.', false);
                }
                cloudOk = true;
            }
        } catch(_e) {
            console.warn('[history] Cloud invoice fetch failed — using local fallback:', _e);
        }
    }

    // Offline fallback: reload from IDB if in-memory ledger is empty
    if (!cloudOk) {
        if ((!savedInvoicesLedger || savedInvoicesLedger.length === 0) &&
            typeof StorageModule !== 'undefined' && typeof StorageModule.loadInvoices === 'function') {
            try { savedInvoicesLedger = await StorageModule.loadInvoices(); } catch(_e) { savedInvoicesLedger = []; }
        }
    }

    // Stale banner + "as of" label
    await _renderLedgerStaleBanner();
    _renderAsOfSyncLabel();

    // Device dropdown (cloud-aware)
    await _populateDeviceDropdownCloud();

    // Apply active filters or reset to today
    const startEl = document.getElementById('filterStartDate');
    if (startEl && startEl.value) {
        applyDateLedgerFilters();
    } else {
        resetLedgerFilters();
    }
}

/**
 * Populate the device filter dropdown.
 * Primary: DevicesModule._fetchAllDevices() — includes every registered device,
 *          even ones that haven't billed yet today.
 * Fallback: scan savedInvoicesLedger (original behaviour).
 */
async function _populateDeviceDropdownCloud() {
    const sel = document.getElementById('historyDeviceFilter');
    if (!sel) return;
    const current = sel.value;
    let codes = [];

    if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._fetchAllDevices === 'function') {
        try {
            const devices = await DevicesModule._fetchAllDevices();
            if (Array.isArray(devices) && devices.length > 0) {
                codes = devices.map(d => d.counter_id || '').filter(Boolean).sort();
            }
        } catch(_e) { /* fall through */ }
    }

    // Local scan fallback
    if (codes.length === 0) {
        codes = [...new Set(savedInvoicesLedger.map(inv => inv.deviceCode || '').filter(Boolean))].sort();
    }

    sel.innerHTML = '<option value="">All Devices</option>';
    codes.forEach(code => {
        const opt = document.createElement('option');
        opt.value = code; opt.textContent = code;
        sel.appendChild(opt);
    });
    if (current) sel.value = current;
}

/**
 * Override _restoreHistoryView (originally defined in billing.js — loaded earlier).
 * history.js loads last so this definition wins.
 * Shows immediate local data while the async cloud fetch runs in the background.
 */
function _restoreHistoryView() { // eslint-disable-line no-redeclare
    // Immediate render from whatever is in memory (snappy UX)
    const startEl = document.getElementById('filterStartDate');
    if (startEl && startEl.value) { applyDateLedgerFilters(); }
    else { resetLedgerFilters(); }
    // Non-blocking cloud refresh — updates ledger, banner, and dropdown on completion
    _loadLedgerCloud().catch(e => console.warn('[history] _loadLedgerCloud error:', e));
}

// =========================================================================
// HISTORY TABLE — pagination, filters, hold view, header stats
// =========================================================================
let _histPage = 1;
const _HIST_PAGE_SIZE = 50;
let _histCurrentDataset = [];
let _histSortCol = null;
let _histSortDir = 1;

function sortHistBy(col) {
    if (_histSortCol === col) _histSortDir = -_histSortDir;
    else { _histSortCol = col; _histSortDir = 1; }
    _histPage = 1;
    _renderHistPageData();
    document.querySelectorAll('.hist-table thead th[data-sort-col]').forEach(th => {
        const c = th.dataset.sortCol;
        const base = th.textContent.replace(/\s*[↕▲▼]$/, '').trim();
        th.textContent = base + ' ' + (c === _histSortCol ? (_histSortDir > 0 ? '▲' : '▼') : '↕');
        th.classList.toggle('hist-th-sorted', c === _histSortCol);
    });
}

function _sortedHistDataset(dataset) {
    if (!_histSortCol) return [...dataset].reverse();
    return [...dataset].sort((a, b) => {
        let av, bv;
        if      (_histSortCol === 'id')    { av = a.id || '';              bv = b.id || ''; }
        else if (_histSortCol === 'dev')   { av = a.deviceCode || '';      bv = b.deviceCode || ''; }
        else if (_histSortCol === 'date')  { av = a.date || '';            bv = b.date || ''; }
        else if (_histSortCol === 'cust')  { av = a.customerName || '';    bv = b.customerName || ''; }
        else if (_histSortCol === 'staff') { av = a.staffName || '';       bv = b.staffName || ''; }
        else if (_histSortCol === 'total') { av = Number(a.netTotal) || 0; bv = Number(b.netTotal) || 0; }
        else return 0;
        if (typeof av === 'number') return _histSortDir * (av - bv);
        return _histSortDir * String(av).localeCompare(String(bv));
    });
}

function renderHistoryCards(dataset) {
    _histCurrentDataset = dataset || [];
    _histPage = 1;
    _renderHistPageData();
}
function goHistPage(page) {
    const totalPages = Math.max(1, Math.ceil(_histCurrentDataset.length / _HIST_PAGE_SIZE));
    _histPage = Math.max(1, Math.min(page, totalPages));
    _renderHistPageData();
    const wrap = document.querySelector('.hist-table-wrap');
    if (wrap) wrap.scrollTop = 0;
}
function _renderHistPageData() {
    const dataset = _histCurrentDataset;
    const tbody = document.getElementById('historyCards');
    if (!tbody) return;
    let total = 0; tbody.innerHTML = '';
    if (dataset.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7" style="text-align:center;padding:32px;color:var(--g400);"><div style="font-size:26px;margin-bottom:6px">📊</div><div style="font-size:12px;font-weight:600">No history yet</div></td>';
        tbody.appendChild(tr);
        document.getElementById('ledgerGrandTotalDisplay').textContent = '0.00';
        const cnt = document.getElementById('ledgerBillCountDisplay'); if (cnt) cnt.textContent = '0 invoices';
        const bar = document.getElementById('histPagination'); if (bar) bar.style.display = 'none';
        return;
    }
    const totalPages = Math.max(1, Math.ceil(dataset.length / _HIST_PAGE_SIZE));
    _histPage = Math.max(1, Math.min(_histPage, totalPages));
    const sorted = _sortedHistDataset(dataset);
    const startIdx = (_histPage - 1) * _HIST_PAGE_SIZE;
    const pageItems = sorted.slice(startIdx, startIdx + _HIST_PAGE_SIZE);
    sorted.forEach(inv => { total += (Number(inv.netTotal) || 0); });
    const cur = _getCurrency();
    const frag = document.createDocumentFragment();
    pageItems.forEach(inv => {
        const tr = document.createElement('tr');
        if (inv.isRefund) tr.style.opacity = '0.75';
        if (inv.refunded) tr.style.textDecoration = 'line-through';
        tr.ondblclick = () => launchInvoiceIsolatedWindow(inv.id);
        tr.title = 'Double-click to view receipt';
        const tdId = document.createElement('td'); tdId.className = 'ht-id'; tdId.textContent = inv.id;
        if (inv.isManual)       { const mb = document.createElement('span'); mb.className = 'ht-badge ht-badge-manual';  mb.textContent = 'MANUAL';  tdId.appendChild(mb); }
        if (inv.isEdit || inv.editedAt) { const eb = document.createElement('span'); eb.className = 'ht-badge ht-badge-edited'; eb.textContent = 'EDITED'; tdId.appendChild(eb); }
        if (inv.isRefund)       { const rb = document.createElement('span'); rb.className = 'ht-badge ht-badge-refund';  rb.textContent = 'REFUND';  tdId.appendChild(rb); }
        if (inv.isPartialRefund){ const pb = document.createElement('span'); pb.className = 'ht-badge ht-badge-refund';  pb.textContent = 'PART-REF'; tdId.appendChild(pb); }
        if (inv.refunded)       { const fb = document.createElement('span'); fb.className = 'ht-badge ht-badge-manual';  fb.textContent = 'REFUNDED'; tdId.appendChild(fb); }
        if (inv.isRefund || inv.isPartialRefund) tdId.style.color = 'var(--red)';
        const tdTs  = document.createElement('td'); tdTs.className = 'ht-ts'; tdTs.textContent = inv.timestamp;
        const tdCu  = document.createElement('td');
        if (inv.customerName) { tdCu.className = 'ht-cust'; tdCu.textContent = '👤 ' + inv.customerName; }
        else { tdCu.textContent = '—'; tdCu.style.color = 'var(--g300)'; }
        const tdSt  = document.createElement('td'); tdSt.className = 'ht-staff-cell'; tdSt.textContent = inv.staffName || '—';
        const _nt   = Number(inv.netTotal) || 0;
        const tdTt  = document.createElement('td'); tdTt.className = 'ht-tot'; tdTt.textContent = cur + _nt.toFixed(2);
        if (_nt < 0) tdTt.style.color = 'var(--red)';
        const tdAc  = document.createElement('td'); tdAc.className = 'ht-acts';
        const vBtn  = document.createElement('button'); vBtn.className = 'ht-btn ht-view'; vBtn.textContent = '👁 View';
        vBtn.onclick = e => { e.stopPropagation(); launchInvoiceIsolatedWindow(inv.id); };
        const eBtn  = document.createElement('button'); eBtn.className = 'ht-btn ht-edit'; eBtn.textContent = '✏️ Edit';
        eBtn.onclick = e => { e.stopPropagation(); requestAdminAccess('UPDATE_BILL', inv.id); };
        tdAc.appendChild(vBtn);
        if (!inv.isRefund) {
            tdAc.appendChild(eBtn);
            const isPartiallyRefunded = Array.isArray(inv.partialRefunds) && inv.partialRefunds.length > 0 && !inv.refunded;
            if (inv.refunded) {
                const refTag = document.createElement('span'); refTag.className = 'ht-badge ht-badge-refund'; refTag.textContent = 'REFUNDED'; tdAc.appendChild(refTag);
            } else if (isPartiallyRefunded) {
                const prTag = document.createElement('span'); prTag.className = 'ht-badge ht-badge-partial'; prTag.textContent = 'PART. REFUNDED'; tdAc.appendChild(prTag);
                const prBtn2 = document.createElement('button'); prBtn2.className = 'ht-btn ht-btn-refund'; prBtn2.textContent = '↩ More Refund';
                prBtn2.onclick = e => { e.stopPropagation(); requestAdminAccess('REFUND_INVOICE', inv.id); };
                tdAc.appendChild(prBtn2);
            } else {
                const rBtn = document.createElement('button'); rBtn.className = 'ht-btn ht-btn-refund'; rBtn.textContent = '↩ Refund';
                rBtn.onclick = e => { e.stopPropagation(); requestAdminAccess('REFUND_INVOICE', inv.id); };
                tdAc.appendChild(rBtn);
            }
        }
        const tdDev = document.createElement('td'); tdDev.className = 'ht-dev-cell';
        const _devCode = inv.deviceCode || '—'; const _opName = inv.staffName || '';
        if (_opName) {
            const _devSpan = document.createElement('span'); _devSpan.className = 'ht-dev-line'; _devSpan.textContent = _devCode;
            const _opSpan  = document.createElement('span'); _opSpan.className = 'ht-dev-op';  _opSpan.textContent = _opName;
            tdDev.appendChild(_devSpan); tdDev.appendChild(_opSpan);
        } else { tdDev.textContent = _devCode; }
        tr.appendChild(tdId); tr.appendChild(tdDev); tr.appendChild(tdTs); tr.appendChild(tdCu); tr.appendChild(tdSt); tr.appendChild(tdTt); tr.appendChild(tdAc);
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    document.getElementById('ledgerGrandTotalDisplay').textContent = total.toFixed(2);
    document.querySelectorAll('.cur-lbl').forEach(el => el.textContent = cur);
    const cntEl = document.getElementById('ledgerBillCountDisplay');
    if (cntEl) cntEl.textContent = dataset.length + ' invoice' + (dataset.length !== 1 ? 's' : '');
    const bar = document.getElementById('histPagination'); if (!bar) return;
    if (dataset.length <= _HIST_PAGE_SIZE) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const dispStart = startIdx + 1, dispEnd = Math.min(startIdx + _HIST_PAGE_SIZE, dataset.length);
    bar.innerHTML =
        '<button class="hist-pg-btn" onclick="goHistPage(1)"' + (_histPage === 1 ? ' disabled' : '') + '>«</button>' +
        '<button class="hist-pg-btn" onclick="goHistPage(' + (_histPage - 1) + ')"' + (_histPage <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
        '<span class="hist-pg-info">Page ' + _histPage + ' / ' + totalPages + ' &nbsp;·&nbsp; ' + dispStart + '–' + dispEnd + ' of ' + dataset.length + '</span>' +
        '<button class="hist-pg-btn" onclick="goHistPage(' + (_histPage + 1) + ')"' + (_histPage >= totalPages ? ' disabled' : '') + '>Next ›</button>' +
        '<button class="hist-pg-btn" onclick="goHistPage(' + totalPages + ')"' + (_histPage === totalPages ? ' disabled' : '') + '>»</button>';
}

// =========================================================================
// HISTORY DUAL MEDICINE FILTER
// =========================================================================
(function() {
    let _med1 = null, _med2 = null, _m1DropIdx = -1, _m2DropIdx = -1;
    const _g = id => document.getElementById(id);

    function _buildDropdownRows(items, dropEl, onSelect) {
        while (dropEl.children.length > 1) dropEl.removeChild(dropEl.lastChild);
        if (items.length === 0) return false;
        const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
        const frag = document.createDocumentFragment();
        items.slice(0, 12).forEach((item, i) => {
            const row = document.createElement('div'); row.className = 's2r-row'; row._hItem = item;
            row.innerHTML =
                '<span class="s2r-num">' + (i+1) + '</span>' +
                '<div><div class="s2r-name">' + _escHtml(item.name) + '</div><div class="s2r-code">' + _escHtml(item.code) + '</div></div>' +
                '<span class="s2r-stock' + (item.stock <= 5 ? ' low' : '') + '">' + _escHtml(String(item.stock)) + '</span>' +
                '<span class="s2r-price">' + _escHtml(cur) + item.unitPrice.toFixed(2) + '</span>';
            row.addEventListener('mouseenter', function() { this.classList.add('s2r-sel'); });
            row.addEventListener('mouseleave', function() { if (!this._sel) this.classList.remove('s2r-sel'); });
            row.addEventListener('mousedown',  function(e) { e.preventDefault(); onSelect(item); });
            frag.appendChild(row);
        });
        dropEl.appendChild(frag); return true;
    }
    function _setNavHighlight(dropEl, idx) {
        const rows = Array.from(dropEl.children).slice(1);
        rows.forEach((r, i) => { r.style.background = i === idx ? 'var(--teal-lt)' : 'white'; r._sel = i === idx; });
    }
    function _renderMed1Drop(q) {
        const drop = _g('histMed1Dropdown'), noRes = _g('histMed1NoResults'); if (!drop) return;
        if (!q) { drop.style.display = 'none'; if (noRes) noRes.style.display = 'none'; return; }
        const ql = q.toLowerCase();
        const matches = (typeof masterInventoryDB !== 'undefined' ? masterInventoryDB : []).filter(it =>
            it.name.toLowerCase().includes(ql) || it.code.toLowerCase().includes(ql) ||
            (it.generic && it.generic.toLowerCase().includes(ql))
        );
        _m1DropIdx = -1;
        const had = _buildDropdownRows(matches, drop, _selectMed1);
        drop.style.display = had ? 'block' : 'none';
        if (noRes) noRes.style.display = had ? 'none' : 'block';
    }
    function _renderMed2Drop(q) {
        const drop = _g('histMed2Dropdown'), noRes = _g('histMed2NoResults'); if (!drop) return;
        if (!q) { drop.style.display = 'none'; if (noRes) noRes.style.display = 'none'; return; }
        const ql = q.toLowerCase();
        const matches = (typeof masterInventoryDB !== 'undefined' ? masterInventoryDB : []).filter(it =>
            it.name.toLowerCase().includes(ql) || it.code.toLowerCase().includes(ql) ||
            (it.generic && it.generic.toLowerCase().includes(ql))
        );
        _m2DropIdx = -1;
        const had = _buildDropdownRows(matches, drop, _selectMed2);
        drop.style.display = had ? 'block' : 'none';
        if (noRes) noRes.style.display = had ? 'none' : 'block';
    }
    function _selectMed1(item) {
        _med1 = item; _m1DropIdx = -1;
        const drop = _g('histMed1Dropdown'), noRes = _g('histMed1NoResults');
        if (drop) drop.style.display = 'none'; if (noRes) noRes.style.display = 'none';
        const inp = _g('histMed1Input'); if (inp) inp.value = '';
        const cb = _g('histMed1ClearBtn'); if (cb) cb.style.display = 'none';
        const tagText = _g('histMed1TagText'); if (tagText) tagText.textContent = item.name;
        const f1Row = _g('histF1Row'), f2Row = _g('histF2Row');
        if (f1Row) f1Row.style.display = 'none';
        if (f2Row) { f2Row.style.display = 'flex'; f2Row.style.flexDirection = 'column'; }
        _med2 = null;
        const inp2 = _g('histMed2Input'); if (inp2) { inp2.value = ''; setTimeout(() => inp2.focus(), 60); }
        const cb2 = _g('histMed2ClearBtn'); if (cb2) cb2.style.display = 'none';
        const drop2 = _g('histMed2Dropdown'); if (drop2) drop2.style.display = 'none';
        applyDateLedgerFilters();
    }
    function _selectMed2(item) {
        _med2 = item; _m2DropIdx = -1;
        const drop = _g('histMed2Dropdown'), noRes = _g('histMed2NoResults');
        if (drop) drop.style.display = 'none'; if (noRes) noRes.style.display = 'none';
        const inp2 = _g('histMed2Input'); if (inp2) inp2.value = item.name;
        const cb2 = _g('histMed2ClearBtn'); if (cb2) cb2.style.display = 'flex';
        applyDateLedgerFilters();
    }
    window.clearHistMed1 = function() {
        _med1 = null; _med2 = null; _m1DropIdx = -1; _m2DropIdx = -1;
        const f1Row = _g('histF1Row'); if (f1Row) f1Row.style.display = 'flex';
        const f2Row = _g('histF2Row'); if (f2Row) f2Row.style.display = 'none';
        const inp = _g('histMed1Input'); if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 60); }
        const inp2 = _g('histMed2Input'); if (inp2) inp2.value = '';
        [_g('histMed1Dropdown'), _g('histMed2Dropdown')].forEach(d => { if (d) d.style.display = 'none'; });
        [_g('histMed1NoResults'), _g('histMed2NoResults')].forEach(n => { if (n) n.style.display = 'none'; });
        [_g('histMed1ClearBtn'), _g('histMed2ClearBtn')].forEach(b => { if (b) b.style.display = 'none'; });
        applyDateLedgerFilters();
    };
    window._histMed1ClearInput = function() {
        const inp = _g('histMed1Input'); if (inp) inp.value = '';
        _renderMed1Drop('');
        const cb = _g('histMed1ClearBtn'); if (cb) cb.style.display = 'none';
        if (inp) inp.focus();
    };
    window._histMed2ClearInput = function() {
        _med2 = null;
        const inp2 = _g('histMed2Input'); if (inp2) inp2.value = '';
        _renderMed2Drop('');
        const cb2 = _g('histMed2ClearBtn'); if (cb2) cb2.style.display = 'none';
        applyDateLedgerFilters();
        if (inp2) inp2.focus();
    };
    window._histMedFiltersReset = function() {
        _med1 = null; _med2 = null; _m1DropIdx = -1; _m2DropIdx = -1;
        const f1Row = _g('histF1Row'); if (f1Row) f1Row.style.display = 'flex';
        const f2Row = _g('histF2Row'); if (f2Row) f2Row.style.display = 'none';
        ['histMed1Input','histMed2Input'].forEach(id => { const el = _g(id); if (el) el.value = ''; });
        ['histMed1Dropdown','histMed2Dropdown'].forEach(id => { const el = _g(id); if (el) el.style.display = 'none'; });
        ['histMed1NoResults','histMed2NoResults'].forEach(id => { const el = _g(id); if (el) el.style.display = 'none'; });
        ['histMed1ClearBtn','histMed2ClearBtn'].forEach(id => { const el = _g(id); if (el) el.style.display = 'none'; });
    };
    window._histGetMedFilters = function() { return { med1: _med1, med2: _med2 }; };

    function _med1Keydown(e) {
        const drop = _g('histMed1Dropdown'); const rows = drop ? Array.from(drop.children).slice(1) : [];
        if (e.key === 'Escape') { _renderMed1Drop(''); e.preventDefault(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); if (_m1DropIdx < rows.length - 1) { _setNavHighlight(drop, ++_m1DropIdx); rows[_m1DropIdx].scrollIntoView({block:'nearest'}); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (_m1DropIdx > 0) { _setNavHighlight(drop, --_m1DropIdx); rows[_m1DropIdx].scrollIntoView({block:'nearest'}); } }
        else if (e.key === 'Enter') { e.preventDefault(); const t = (_m1DropIdx >= 0 && rows[_m1DropIdx]) ? rows[_m1DropIdx] : (rows.length === 1 ? rows[0] : null); if (t && t._hItem) _selectMed1(t._hItem); }
    }
    function _med2Keydown(e) {
        const drop = _g('histMed2Dropdown'); const rows = drop ? Array.from(drop.children).slice(1) : [];
        if (e.key === 'Escape') { _renderMed2Drop(''); e.preventDefault(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); if (_m2DropIdx < rows.length - 1) { _setNavHighlight(drop, ++_m2DropIdx); rows[_m2DropIdx].scrollIntoView({block:'nearest'}); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (_m2DropIdx > 0) { _setNavHighlight(drop, --_m2DropIdx); rows[_m2DropIdx].scrollIntoView({block:'nearest'}); } }
        else if (e.key === 'Enter') { e.preventDefault(); const t = (_m2DropIdx >= 0 && rows[_m2DropIdx]) ? rows[_m2DropIdx] : (rows.length === 1 ? rows[0] : null); if (t && t._hItem) _selectMed2(t._hItem); }
    }
    function _histMedInit() {
        const inp1 = _g('histMed1Input');
        if (inp1) {
            inp1.addEventListener('input', function() {
                const v = this.value.trim(); const cb = _g('histMed1ClearBtn'); if (cb) cb.style.display = v ? 'flex' : 'none';
                _renderMed1Drop(v);
            });
            inp1.addEventListener('keydown', _med1Keydown);
            inp1.addEventListener('blur', () => setTimeout(() => { const d = _g('histMed1Dropdown'); if (d) d.style.display = 'none'; const n = _g('histMed1NoResults'); if (n) n.style.display = 'none'; }, 180));
        }
        const inp2 = _g('histMed2Input');
        if (inp2) {
            inp2.addEventListener('input', function() {
                const v = this.value.trim(); const cb = _g('histMed2ClearBtn'); if (cb) cb.style.display = v ? 'flex' : 'none';
                _renderMed2Drop(v);
            });
            inp2.addEventListener('keydown', _med2Keydown);
            inp2.addEventListener('blur', () => setTimeout(() => { const d = _g('histMed2Dropdown'); if (d) d.style.display = 'none'; const n = _g('histMed2NoResults'); if (n) n.style.display = 'none'; }, 180));
        }
        document.addEventListener('mousedown', function(e) {
            if (!e.target.closest('#histF1DropWrap')) { const d = _g('histMed1Dropdown'); if (d) d.style.display = 'none'; const n = _g('histMed1NoResults'); if (n) n.style.display = 'none'; }
            if (!e.target.closest('#histF2DropWrap')) { const d = _g('histMed2Dropdown'); if (d) d.style.display = 'none'; const n = _g('histMed2NoResults'); if (n) n.style.display = 'none'; }
        });
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', _histMedInit); }
    else { _histMedInit(); }
})();

function onHistF1Input() {}
function lockHistF1()   {}
function clearHistF1()  { if (typeof clearHistMed1 === 'function') clearHistMed1(); }
function clearHistF2()  { if (typeof _histMed2ClearInput === 'function') _histMed2ClearInput(); }

function applyDateLedgerFilters() {
    const s = document.getElementById('filterStartDate').value;
    const e = document.getElementById('filterEndDate').value;
    const deviceFilter = (document.getElementById('historyDeviceFilter')?.value || '').trim().toUpperCase();
    const invSearch    = (document.getElementById('histInvSearch')?.value || '').trim().toLowerCase();
    const medF = (typeof _histGetMedFilters === 'function') ? _histGetMedFilters() : { med1: null, med2: null };
    const med1 = medF.med1, med2 = medF.med2;
    if ((s && !e) || (!s && e)) { if (!med1 && !deviceFilter && !invSearch) { showToast('❌ Set both date filters.', true); return; } }
    let filtered = savedInvoicesLedger;
    if (s && e) filtered = filtered.filter(inv => inv.date >= s && inv.date <= e);
    if (med1) {
        const m1name = med1.name.toLowerCase(), m1code = med1.code.toLowerCase();
        filtered = filtered.filter(inv => Array.isArray(inv.details) && inv.details.some(d =>
            (d.name || '').toLowerCase() === m1name || (d.code || '').toLowerCase() === m1code));
    }
    if (med2) {
        const m2name = med2.name.toLowerCase(), m2code = med2.code.toLowerCase();
        filtered = filtered.filter(inv => Array.isArray(inv.details) && inv.details.some(d =>
            (d.name || '').toLowerCase() === m2name || (d.code || '').toLowerCase() === m2code));
    }
    if (deviceFilter) {
        filtered = filtered.filter(inv =>
            (inv.deviceCode || '').toUpperCase() === deviceFilter ||
            (inv.id || '').toUpperCase().startsWith(deviceFilter));
    }
    if (invSearch) {
        filtered = filtered.filter(inv => (inv.id || '').toLowerCase().includes(invSearch));
    }
    renderHistoryCards(filtered);
}

function resetLedgerFilters() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('filterStartDate').value = today;
    document.getElementById('filterEndDate').value   = today;
    const devEl = document.getElementById('historyDeviceFilter'); if (devEl) devEl.value = '';
    const invSearchEl = document.getElementById('histInvSearch'); if (invSearchEl) invSearchEl.value = '';
    _histSortCol = null; _histSortDir = 1;
    document.querySelectorAll('.hist-table thead th[data-sort-col]').forEach(th => {
        th.textContent = th.textContent.replace(/\s*[↕▲▼]$/, '').trim() + ' ↕';
        th.classList.remove('hist-th-sorted');
    });
    if (typeof _histMedFiltersReset === 'function') _histMedFiltersReset();
    const bar = document.getElementById('histSubFilterBar');
    if (bar && bar.classList.contains('open')) {
        bar.classList.remove('open'); bar.style.display = 'none';
        const btn = document.getElementById('histSubFilterToggleBtn');
        if (btn) { btn.style.background = 'var(--g100)'; btn.style.color = 'var(--g700)'; btn.style.borderColor = 'var(--g300)'; }
    }
    renderHistoryCards(savedInvoicesLedger);
}

function toggleHistSubFilter() {
    const bar = document.getElementById('histSubFilterBar');
    const btn = document.getElementById('histSubFilterToggleBtn'); if (!bar) return;
    const isOpen = bar.classList.contains('open');
    if (isOpen) {
        bar.classList.remove('open'); bar.style.display = 'none';
        if (btn) { btn.style.background = 'var(--g100)'; btn.style.color = 'var(--g700)'; btn.style.borderColor = 'var(--g300)'; }
    } else {
        bar.classList.add('open'); bar.style.display = 'block';
        if (btn) { btn.style.background = 'var(--teal-lt)'; btn.style.color = 'var(--teal)'; btn.style.borderColor = 'rgba(0,105,92,.3)'; }
        const si = document.getElementById('histMed1Input'); if (si) setTimeout(() => si.focus(), 60);
    }
}

function _populateDeviceDropdown() {
    // Thin wrapper — delegates to cloud-aware version defined in Phase 7 Step 2 block above
    _populateDeviceDropdownCloud().catch(() => {
        const sel = document.getElementById('historyDeviceFilter'); if (!sel) return;
        const current = sel.value;
        const codes = [...new Set(savedInvoicesLedger.map(inv => inv.deviceCode || '').filter(Boolean))].sort();
        sel.innerHTML = '<option value="">All Devices</option>';
        codes.forEach(code => { const opt = document.createElement('option'); opt.value = code; opt.textContent = code; sel.appendChild(opt); });
        if (current) sel.value = current;
    });
}

function exportMasterLedgerToCSV() {
    if (savedInvoicesLedger.length === 0) { showToast('No data to export.', true); return; }
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    let csv = 'Invoice ID,Device,Date/Time,Customer Name,Customer Phone,Staff,Product Code,Product Name,Unit Price,Qty,Total Row,Discount %,Invoice Net Total,Refund Status\n';
    savedInvoicesLedger.forEach(inv => {
        const discPct = typeof inv.discountPct === 'number' ? inv.discountPct : 0;
        const refundStatus = inv.isRefund ? 'REFUND' : (inv.refunded ? 'REFUNDED' : '');
        const deviceCode = inv.deviceCode || '';
        if (!Array.isArray(inv.details) || inv.details.length === 0) {
            csv += [esc(inv.id),esc(deviceCode),esc(inv.timestamp),esc(inv.customerName||''),esc(inv.customerPhone||''),esc(inv.staffName||''),'"VOID"','"VOID"',0,0,0,discPct,inv.netTotal,esc(refundStatus||'VOID')].join(',') + '\n';
        } else {
            inv.details.forEach(item => {
                csv += [esc(inv.id),esc(deviceCode),esc(inv.timestamp),esc(inv.customerName||''),esc(inv.customerPhone||''),esc(inv.staffName||''),esc(item.code),esc(item.name),item.unitPrice,item.qty,item.total,discPct,inv.netTotal,esc(refundStatus)].join(',') + '\n';
            });
        }
    });
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'Pharma_Ledger_Export.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// =========================================================================
// RECEIPT VIEWER
// =========================================================================
// ── Receipt view helper ───────────────────────────────────────────────────
// Renders the receipt modal for invoiceID.
// 1. Looks up invoice in local savedInvoicesLedger.
// 2. If found but details[] is empty (invoice_items not yet written when it
//    was first synced), fetches the invoice_items from Supabase on demand.
// 3. If not found locally at all, fetches the full row + items from Supabase.
// 4. Falls back gracefully with a user-visible toast on any failure.
async function launchInvoiceIsolatedWindow(invoiceID) {
    let inv = savedInvoicesLedger.find(i => i.id === invoiceID);

    // Case A: invoice found in memory with full details — render immediately
    if (inv && Array.isArray(inv.details) && inv.details.length > 0) {
        _renderReceiptModal(inv);
        return;
    }

    // Case A2: not in memory — check IDB directly via StorageModule (covers invoices
    // from other devices that were synced into PharmaDataDB but not yet loaded into
    // savedInvoicesLedger).  Uses StorageModule.getInvoiceById() which correctly
    // targets the 'invoices' store in PharmaDataDB — NOT the inventory db handle.
    if (!inv && typeof StorageModule !== 'undefined' && typeof StorageModule.getInvoiceById === 'function') {
        try {
            inv = await StorageModule.getInvoiceById(invoiceID);
        } catch(_e) { inv = null; }
        if (inv && Array.isArray(inv.details) && inv.details.length > 0) {
            _renderReceiptModal(inv);
            return;
        }
    }

    // Case B: found locally but details[] empty, OR not found at all
    // → fetch from Supabase on demand (needs invoice_items written)
    if (navigator.onLine && typeof _dbSelect === 'function') {
        try {
            if (typeof showToast === 'function') showToast('⏳ Loading receipt details…', false);
            const filter = 'invoice_number=eq.' + encodeURIComponent(invoiceID);
            const { data, error } = await _dbSelect('invoices', filter, '*,invoice_items(*)');
            if (!error && Array.isArray(data) && data.length > 0) {
                const row = data[0];
                const cloudInv = {
                    id:               row.invoice_number,
                    invoiceNumber:    row.invoice_number,
                    deviceUuid:       row.device_uuid       || '',
                    deviceCode:       row.counter_id        || '',
                    customerName:     row.customer_name     || '',
                    customerPhone:    row.customer_phone    || '',
                    staffName:        row.staff_name        || '',
                    subtotal:         Number(row.subtotal)      || 0,
                    discountPct:      Number(row.discount_pct)  || 0,
                    roundOffAmt:      Number(row.round_off_amt) || 0,
                    netTotal:         Number(row.net_total)     || 0,
                    paymentMethod:    row.payment_method    || '',
                    cashReceived:     Number(row.cash_received) || 0,
                    changeAmount:     Number(row.change_amount) || 0,
                    isRefund:         !!row.is_refund,
                    isPartialRefund:  !!row.is_partial_refund,
                    isEdit:           !!row.is_edit,
                    isManual:         !!row.is_manual,
                    originalId:       row.original_invoice_id || null,
                    timestamp:        row.billed_at         || '',
                    date:             row.billed_at ? row.billed_at.slice(0, 10) : '',
                    details:          Array.isArray(row.invoice_items)
                        ? row.invoice_items.map(li => ({
                            code:        li.product_code  || '',
                            name:        li.product_name  || '',
                            packDetails: li.pack_size     || '',
                            unitPrice:   Number(li.unit_price) || 0,
                            qty:         Number(li.qty)        || 0,
                            total:       Number(li.total)      || 0
                        }))
                        : (inv ? (inv.details || []) : [])
                };
                // Patch memory + IDB so repeat opens are instant
                if (inv) {
                    inv.details = cloudInv.details;
                } else {
                    savedInvoicesLedger.push(cloudInv);
                    // Write-back via StorageModule.putRemoteInvoice() so it lands in
                    // PharmaDataDB (the correct database) instead of PharmaInventoryDB.
                    if (typeof StorageModule !== 'undefined' && typeof StorageModule.putRemoteInvoice === 'function') {
                        try {
                            // putRemoteInvoice expects Supabase snake_case shape; cloudInv is already
                            // camelCase. Build a minimal snake_case wrapper it can accept, then it
                            // will upsert cleanly into the 'invoices' store.
                            StorageModule.putRemoteInvoice({
                                invoice_number:      cloudInv.id,
                                device_uuid:         cloudInv.deviceUuid        || '',
                                counter_id:          cloudInv.deviceCode        || '',
                                customer_name:       cloudInv.customerName      || '',
                                customer_phone:      cloudInv.customerPhone     || '',
                                staff_name:          cloudInv.staffName         || '',
                                subtotal:            cloudInv.subtotal          || 0,
                                discount_pct:        cloudInv.discountPct       || 0,
                                round_off_amt:       cloudInv.roundOffAmt       || 0,
                                net_total:           cloudInv.netTotal          || 0,
                                payment_method:      cloudInv.paymentMethod     || '',
                                cash_received:       cloudInv.cashReceived      || 0,
                                change_amount:       cloudInv.changeAmount      || 0,
                                is_refund:           !!cloudInv.isRefund,
                                is_partial_refund:   !!cloudInv.isPartialRefund,
                                is_edit:             !!cloudInv.isEdit,
                                is_manual:           !!cloudInv.isManual,
                                original_invoice_id: cloudInv.originalId       || null,
                                billed_at:           cloudInv.timestamp        || '',
                                invoice_items:       Array.isArray(cloudInv.details) ? cloudInv.details.map(li => ({
                                    product_code: li.code        || '',
                                    product_name: li.name        || '',
                                    pack_size:    li.packDetails || '',
                                    unit_price:   li.unitPrice   || 0,
                                    qty:          li.qty         || 0,
                                    total:        li.total       || 0
                                })) : []
                            }).catch(() => {});
                        } catch(_e) {}
                    }
                }
                _renderReceiptModal(cloudInv);
                return;
            }
        } catch (fetchErr) {
            console.warn('[history] On-demand invoice_items fetch failed:', fetchErr);
        }
    }

    // Case C: offline or fetch failed — render with whatever we have
    if (inv) { _renderReceiptModal(inv); return; }

    // Case D: completely not found
    if (typeof showToast === 'function') showToast('⚠️ Invoice not found. Try syncing first.', true);
}

// ── Receipt modal renderer ────────────────────────────────────────────────
// Called by launchInvoiceIsolatedWindow() after we have a full invoice object.
function _renderReceiptModal(inv) {
    const subtotal = Array.isArray(inv.details) ? inv.details.reduce((a, c) => a + (Number(c.total) || 0), 0) : 0;
    const discPct  = typeof inv.discountPct === 'number' ? inv.discountPct : 0;
    const deduction = (subtotal * discPct) / 100;
    const roundOffAmt = typeof inv.roundOffAmt === 'number' ? inv.roundOffAmt : 0;
    const modal = document.getElementById('receiptViewModal');
    // FIX: ID in index.html is 'receiptViewBody', not 'receiptViewContent'
    const content = document.getElementById('receiptViewBody');
    content.innerHTML = '';
    const hdr = document.createElement('div'); hdr.className = 'rv-header';
    const _rvBi = _getBranchIdentity();
    hdr.textContent = (_rvBi.receiptHeader || _rvBi.businessName || _rvBi.branchName || 'PHARMA POS').toUpperCase();
    content.appendChild(hdr);
    const ab = document.createElement('div'); ab.className = 'rv-archive-badge'; ab.textContent = '🔒 ARCHIVE DUPLICATE'; content.appendChild(ab);
    const addRow = (l, v, cls) => {
        const r = document.createElement('div'); r.className = 'rv-row' + (cls ? ' ' + cls : '');
        const le = document.createElement('span'); le.textContent = l;
        const ve = document.createElement('span'); ve.textContent = v;
        r.appendChild(le); r.appendChild(ve); content.appendChild(r);
    };
    const addDiv = () => { const d = document.createElement('div'); d.className = 'rv-divider'; content.appendChild(d); };
    const cur = _getCurrency();
    addDiv(); addRow('Invoice:', inv.id); addRow('Date:', inv.timestamp);
    if (inv.customerName)  addRow('Customer:', inv.customerName);
    if (inv.customerPhone) addRow('Phone:',    inv.customerPhone);
    addDiv();
    if (!Array.isArray(inv.details) || inv.details.length === 0) {
        const v = document.createElement('div'); v.className = 'rv-voided';
        v.textContent = inv.isRefund ? '-- REFUND / NO ITEMS --' : '-- NO ITEM DATA (sync pending) --';
        content.appendChild(v);
    } else {
        inv.details.forEach(item => {
            const ne = document.createElement('div'); ne.className = 'rv-item-name'; ne.textContent = item.name; content.appendChild(ne);
            const pr = document.createElement('div'); pr.className = 'rv-row';
            const qs = document.createElement('span'); qs.textContent = item.qty + ' Pcs × ' + cur + item.unitPrice.toFixed(2);
            const ts = document.createElement('span'); ts.textContent = cur + item.total.toFixed(2);
            pr.appendChild(qs); pr.appendChild(ts); content.appendChild(pr);
        });
    }
    addDiv();
    addRow('Gross Subtotal:', cur + subtotal.toFixed(2));
    if (deduction > 0)    addRow('Discount (' + discPct + '%):', '− ' + cur + deduction.toFixed(2));
    if (roundOffAmt !== 0) addRow('Round-Off:', (roundOffAmt >= 0 ? '+ ' : '− ') + cur + Math.abs(roundOffAmt).toFixed(2));
    const tr2 = document.createElement('div'); tr2.className = 'rv-row rv-total-row';
    const tl = document.createElement('span'); tl.textContent = 'TOTAL PAID:';
    const tv = document.createElement('span'); tv.textContent = cur + inv.netTotal.toFixed(2);
    tr2.appendChild(tl); tr2.appendChild(tv); content.appendChild(tr2);
    document.getElementById('printInvId').textContent     = inv.id;
    document.getElementById('printDate').textContent      = inv.timestamp || '';
    document.getElementById('printSubtotal').textContent  = cur + subtotal.toFixed(2);
    document.getElementById('printDiscPerc').textContent  = discPct;
    document.getElementById('printDiscValue').textContent = cur + deduction.toFixed(2);
    document.getElementById('printNetPayable').textContent= cur + inv.netTotal.toFixed(2);
    if (inv.customerName || inv.customerPhone) {
        document.getElementById('printCustomerName').textContent  = inv.customerName || '—';
        document.getElementById('printCustomerPhone').textContent = inv.customerPhone || '';
        document.getElementById('printCustomerRow').style.display = '';
    } else { document.getElementById('printCustomerRow').style.display = 'none'; }
    let _pH = '';
    const _tsRePrint = _getThermalSettings();
    inv.details.forEach(item => {
        _pH += '<div class="item-print-block"><div class="item-desc-row">' + _escHtml(item.name) + '</div>' +
               '<div class="item-meta-row">' +
               (_tsRePrint.showUnitPrice ? '<span>' + item.qty + ' Pcs \u00d7 ' + cur + item.unitPrice.toFixed(2) + '</span>' : '<span>' + item.qty + ' Pcs</span>') +
               '<span>' + cur + item.total.toFixed(2) + '</span></div></div>';
    });
    document.getElementById('printReceiptItemsContainer').innerHTML = _pH;
    const rvTermEl = document.getElementById('printTerminalId');
    if (rvTermEl) rvTermEl.textContent = (inv && inv.deviceCode) ? inv.deviceCode : _getDeviceCode();
    _applyPrintMode();
    modal.classList.add('visible');
}
function closeReceiptModal() {
    document.getElementById('receiptViewModal').classList.remove('visible');
    // FIX: correct ID is 'receiptViewBody'
    const _rcBody = document.getElementById('receiptViewBody');
    if (_rcBody) _rcBody.innerHTML = '';
}

// =========================================================================
// HOLD VIEW
// =========================================================================
function renderHeldBillsTable() {
    const container = document.getElementById('heldBillsContainer');
    if (temporaryHeldBills.length === 0) {
        container.innerHTML = '<div class="empty-cart"><div class="empty-cart-ico">📋</div><div class="empty-cart-txt">No held bills</div><div class="empty-cart-sub">Hold a bill from Billing tab (F4)</div></div>';
        return;
    }
    const frag = document.createDocumentFragment();
    temporaryHeldBills.forEach((bill, i) => {
        const card = document.createElement('div'); card.className = 'hbc';
        const ico  = document.createElement('div'); ico.className  = 'hbc-icon'; ico.textContent = '📋';
        const info = document.createElement('div'); info.className = 'hbc-info';
        const tag  = document.createElement('div'); tag.className  = 'hbc-tag';  tag.textContent  = bill.tag;
        const meta = document.createElement('div'); meta.className = 'hbc-meta';
        meta.textContent = bill.timestamp + ' · ' + bill.items.length + ' item' + (bill.items.length !== 1 ? 's' : '');
        info.appendChild(tag); info.appendChild(meta);
        const btn = document.createElement('button'); btn.className = 'hbc-recall'; btn.textContent = '↩ Recall'; btn.onclick = () => recallHeldBill(i);
        const discardBtn = document.createElement('button'); discardBtn.className = 'hbc-discard'; discardBtn.textContent = '✕'; discardBtn.title = 'Discard';
        discardBtn.onclick = () => {
            showConfirmModal('Discard "' + bill.tag + '"? This cannot be undone.', () => {
                temporaryHeldBills.splice(i, 1);
                StorageModule.saveHeldBills(temporaryHeldBills);
                updateStatsCounters(); renderHeldBillsTable(); showToast('Held bill discarded.');
            }, null, 'Discard', true);
        };
        card.appendChild(ico); card.appendChild(info); card.appendChild(btn); card.appendChild(discardBtn);
        frag.appendChild(card);
    });
    container.innerHTML = ''; container.appendChild(frag);
}
// updateStatsCounters is defined in billing.js (loaded earlier)

// =========================================================================
// HEADER STATS
// =========================================================================
function updateHdrStats() {
    const todayStr  = new Date().toISOString().split('T')[0];
    const todayBills = savedInvoicesLedger.filter(inv => inv.date === todayStr);
    const count   = todayBills.length;
    const revenue = todayBills.reduce((s, inv) => s + (inv.netTotal || 0), 0);
    const cur = _getCurrency();
    const be  = document.getElementById('hdrTodayBills');
    const re  = document.getElementById('hdrRevenue');
    const newBills   = String(count);
    const newRevenue = cur + (revenue >= 1000 ? (revenue / 1000).toFixed(1) + 'k' : Math.round(revenue).toLocaleString('en-PK'));
    if (be) { const ch = be.textContent !== newBills;    be.textContent = newBills;    if (ch) { be.classList.remove('stat-pop'); void be.offsetWidth; be.classList.add('stat-pop'); } }
    if (re) { const ch = re.textContent !== newRevenue;  re.textContent = newRevenue;  if (ch) { re.classList.remove('stat-pop'); void re.offsetWidth; re.classList.add('stat-pop'); } }
}
