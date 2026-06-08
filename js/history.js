// =========================================================================
// history.js — Bill History View
// BUG 3 FIX:  Bill-view click handler now reads correctly from
//             savedInvoicesLedger (IDB-backed), builds a full receipt HTML,
//             injects into the review modal, and exposes a print action.
// BUG 11 FIX: History table rendered via _renderChunked() so long ledgers
//             never block the main thread.
// =========================================================================

// ── State ─────────────────────────────────────────────────────────────────
let _historyLedger       = [];
let _historyFilteredView = [];
let _histPage            = 1;
const _HIST_PAGE_SIZE    = 50;
let _histSearchDebounce  = null;

// =========================================================================
// RESTORE / INIT — called by billing.js switchTab('historyView')
// =========================================================================
function _restoreHistoryView() {
    _histPage = 1;
    _applyHistoryFiltersAndRender();
}

// =========================================================================
// FILTER & SORT
// =========================================================================
function applyHistoryFilters() {
    _histPage = 1;
    _applyHistoryFiltersAndRender();
}

function _applyHistoryFiltersAndRender() {
    const ledger = (typeof savedInvoicesLedger !== 'undefined' && Array.isArray(savedInvoicesLedger))
        ? savedInvoicesLedger
        : _historyLedger;

    const search  = (document.getElementById('histSearchInput')?.value  || '').toLowerCase().trim();
    const fStart  = document.getElementById('filterStartDate')?.value   || '';
    const fEnd    = document.getElementById('filterEndDate')?.value     || '';
    const fType   = document.getElementById('filterTypeSelect')?.value  || 'all';
    const fMethod = document.getElementById('filterMethodSelect')?.value || 'all';
    const sortBy  = document.getElementById('historySortSelect')?.value  || 'date_desc';

    let filtered = ledger.filter(inv => {
        if (!inv) return false;
        const date = (inv.date || inv.billedAt || inv.billed_at || inv.created_at || '').slice(0, 10);

        // Date range
        if (fStart && date < fStart) return false;
        if (fEnd   && date > fEnd)   return false;

        // Type filter
        const isRefund = !!(inv.isRefund || inv.is_refund);
        const isVoid   = !!(inv.isFullyRefunded || inv.is_fully_refunded) && isRefund;
        if (fType === 'sales'   && isRefund)  return false;
        if (fType === 'refunds' && !isRefund) return false;
        if (fType === 'voids'   && !isVoid)   return false;

        // Payment method
        const pm = (inv.paymentMethod || inv.payment_method || 'cash').toLowerCase();
        if (fMethod !== 'all' && pm !== fMethod) return false;

        // Full-text search
        if (search) {
            const haystack = [
                inv.id, inv.invoice_number,
                inv.customerName || inv.customer_name,
                inv.customerPhone || inv.customer_phone,
                inv.staffName || inv.staff_name,
                date
            ].join(' ').toLowerCase();
            if (!haystack.includes(search)) return false;
        }

        return true;
    });

    // Sort
    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'date_asc':
                return new Date(a.billedAt || a.billed_at || 0) - new Date(b.billedAt || b.billed_at || 0);
            case 'amount_desc':
                return (Number(b.netTotal || b.net_total) || 0) - (Number(a.netTotal || a.net_total) || 0);
            case 'amount_asc':
                return (Number(a.netTotal || a.net_total) || 0) - (Number(b.netTotal || b.net_total) || 0);
            case 'date_desc':
            default:
                return new Date(b.billedAt || b.billed_at || 0) - new Date(a.billedAt || a.billed_at || 0);
        }
    });

    _historyFilteredView = filtered;
    _renderHistoryTable();
    _renderHistorySummary(filtered);
}

// =========================================================================
// BUG 11 FIX — Chunked History Table Rendering
// Slices the filtered ledger into idle-callback batches so a 5000-invoice
// day never blocks the main thread while a barcode scan is incoming.
// =========================================================================
function _renderHistoryTable() {
    const tbody    = document.getElementById('historyTableBody');
    const countEl  = document.getElementById('histMatchCount');
    const paginEl  = document.getElementById('histPaginInfo');
    if (!tbody) return;

    const total  = _historyFilteredView.length;
    const pages  = Math.ceil(total / _HIST_PAGE_SIZE);
    const start  = (_histPage - 1) * _HIST_PAGE_SIZE;
    const end    = Math.min(start + _HIST_PAGE_SIZE, total);
    const slice  = _historyFilteredView.slice(start, end);

    if (countEl) countEl.textContent = total + ' invoice' + (total === 1 ? '' : 's');
    if (paginEl) paginEl.textContent = 'Page ' + _histPage + ' of ' + Math.max(1, pages);

    tbody.innerHTML = '';

    if (slice.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="hist-empty-cell">No invoices match the current filters.</td></tr>';
        _updateHistPaginationButtons(pages);
        return;
    }

    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    // BUG 11: Use _renderChunked to avoid main-thread freeze on large history
    if (typeof _renderChunked === 'function') {
        _renderChunked(slice, 15, (chunk, isFirst) => {
            chunk.forEach(inv => tbody.appendChild(_buildHistoryRow(inv, cur)));
        }, () => {
            _updateHistPaginationButtons(pages);
        });
    } else {
        slice.forEach(inv => tbody.appendChild(_buildHistoryRow(inv, cur)));
        _updateHistPaginationButtons(pages);
    }
}

/**
 * Build a single TR element for the history table.
 * @param {object} inv — invoice record
 * @param {string} cur — currency symbol
 */
function _buildHistoryRow(inv, cur) {
    const isRefund     = !!(inv.isRefund || inv.is_refund);
    const isVoid       = !!(inv.isFullyRefunded || inv.is_fully_refunded);
    const invoiceId    = inv.id || inv.invoice_number || '?';
    const dateStr      = (inv.billedAt || inv.billed_at || inv.date || '').slice(0, 16).replace('T', ' ');
    const customer     = _escHtml(inv.customerName || inv.customer_name || 'Walk-in');
    const amount       = Number(inv.netTotal || inv.net_total || 0).toFixed(2);
    const payMethod    = _escHtml((inv.paymentMethod || inv.payment_method || 'cash').toUpperCase());
    const staff        = _escHtml(inv.staffName || inv.staff_name || '—');
    let   badge        = '';
    if (isVoid)        badge = '<span class="hist-badge hist-void">VOID</span>';
    else if (isRefund) badge = '<span class="hist-badge hist-refund">REFUND</span>';
    else               badge = '<span class="hist-badge hist-sale">SALE</span>';

    const tr = document.createElement('tr');
    tr.className = 'hist-tr' + (isRefund ? ' hist-tr-refund' : '') + (isVoid ? ' hist-tr-void' : '');

    // BUG 3 FIX: onclick correctly calls _openHistoryBillView with the invoice ID
    tr.innerHTML = `
        <td class="hist-td hist-td-id"
            onclick="_openHistoryBillView('${_escHtml(invoiceId)}')"
            style="cursor:pointer;color:var(--blu);font-weight:700;text-decoration:underline;"
            title="Click to view invoice">
            ${_escHtml(invoiceId)}
        </td>
        <td class="hist-td">${dateStr}</td>
        <td class="hist-td">${customer}</td>
        <td class="hist-td hist-td-r">${cur}${amount}</td>
        <td class="hist-td hist-td-c">${payMethod}</td>
        <td class="hist-td">${staff}</td>
        <td class="hist-td hist-td-c">
            ${badge}
            <button class="hist-view-btn" onclick="_openHistoryBillView('${_escHtml(invoiceId)}')" title="View bill">👁</button>
            <button class="hist-print-btn" onclick="_printHistoryBill('${_escHtml(invoiceId)}')" title="Print">🖨</button>
            ${!isRefund && !isVoid ? `<button class="hist-edit-btn" onclick="_promptHistoryEdit('${_escHtml(invoiceId)}')" title="Edit">✏️</button>` : ''}
        </td>`;
    return tr;
}

function _updateHistPaginationButtons(totalPages) {
    const prevBtn = document.getElementById('histPrevBtn');
    const nextBtn = document.getElementById('histNextBtn');
    if (prevBtn) prevBtn.disabled = _histPage <= 1;
    if (nextBtn) nextBtn.disabled = _histPage >= totalPages;
}

function histPrevPage() { if (_histPage > 1) { _histPage--; _renderHistoryTable(); } }
function histNextPage() {
    const pages = Math.ceil(_historyFilteredView.length / _HIST_PAGE_SIZE);
    if (_histPage < pages) { _histPage++; _renderHistoryTable(); }
}

function _renderHistorySummary(filtered) {
    const sales   = filtered.filter(i => !i.isRefund && !i.is_refund);
    const refunds = filtered.filter(i =>  i.isRefund ||  i.is_refund);
    const totalSales   = sales.reduce((s, i)   => s + (Number(i.netTotal || i.net_total) || 0), 0);
    const totalRefunds = refunds.reduce((s, i) => s + (Number(i.netTotal || i.net_total) || 0), 0);
    const net          = totalSales - totalRefunds;
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const _set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _set('histSumSaleCount',    sales.length);
    _set('histSumRefundCount',  refunds.length);
    _set('histSumSaleAmount',   cur + totalSales.toFixed(2));
    _set('histSumRefundAmount', cur + totalRefunds.toFixed(2));
    _set('histSumNetAmount',    cur + net.toFixed(2));
}

// =========================================================================
// BUG 3 FIX — Bill-View Modal
// Reads invoice from savedInvoicesLedger (IDB-backed, not stale innerHTML),
// builds a full structured receipt HTML, injects into the review modal,
// and connects the print button.
// =========================================================================

/**
 * Open the full bill-view modal for a given invoice ID.
 * @param {string} invoiceId
 */
function _openHistoryBillView(invoiceId) {
    if (!invoiceId) return;

    // BUG 3 FIX: Read from the authoritative in-memory + IDB ledger
    const ledger = (typeof savedInvoicesLedger !== 'undefined' && Array.isArray(savedInvoicesLedger))
        ? savedInvoicesLedger
        : [];

    const inv = ledger.find(i => (i.id || i.invoice_number) === invoiceId);

    if (!inv) {
        // Async fallback: load from IDB directly
        if (typeof StorageModule !== 'undefined') {
            StorageModule.loadInvoices().then(all => {
                const found = all.find(i => (i.id || i.invoice_number) === invoiceId);
                if (found) _renderBillViewModal(found);
                else if (typeof showToast === 'function') showToast('⚠️ Invoice not found: ' + invoiceId, true);
            }).catch(() => {
                if (typeof showToast === 'function') showToast('⚠️ Invoice not found: ' + invoiceId, true);
            });
        }
        return;
    }

    _renderBillViewModal(inv);
}

/**
 * Render the bill-view modal with full invoice data.
 * @param {object} inv — full invoice record
 */
function _renderBillViewModal(inv) {
    const cur  = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const bi   = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    const rs   = (typeof _receiptSettings !== 'undefined') ? _receiptSettings : {};

    const invoiceId  = inv.id || inv.invoice_number || '?';
    const dateStr    = new Date(inv.billedAt || inv.billed_at || inv.date || Date.now())
                           .toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' });
    const items      = inv.details || inv.line_items || [];
    const isRefund   = !!(inv.isRefund || inv.is_refund);

    // Build line items HTML
    const itemsHtml = items.length === 0
        ? '<tr><td colspan="4" style="text-align:center;color:var(--g400);padding:8px;">No items</td></tr>'
        : items.map((li, i) => {
            const code  = _escHtml(li.code || li.product_code || '');
            const name  = _escHtml(li.name || li.product_name || '');
            const ps    = _escHtml(li.packDetails || li.pack_size || '');
            const price = Number(li.unitPrice || li.unit_price || 0).toFixed(2);
            const qty   = Number(li.qty || li.quantity || 0);
            const total = Number(li.total || 0).toFixed(2);
            return `<tr class="bv-item-row">
                <td class="bv-td" style="font-size:11px;color:var(--g500);">${i+1}</td>
                <td class="bv-td">
                    <div style="font-size:12px;font-weight:700;">${name}</div>
                    <div style="font-size:10px;color:var(--g500);">${code}${ps ? ' · ' + ps : ''}</div>
                </td>
                <td class="bv-td bv-td-r">${cur}${price} × ${qty}</td>
                <td class="bv-td bv-td-r" style="font-weight:700;">${cur}${total}</td>
            </tr>`;
        }).join('');

    // Build totals rows
    const discAmt   = Number(inv.discountAmount || inv.discount_amount || 0);
    const roundOff  = Number(inv.roundOffAmt    || inv.round_off_amt   || 0);
    const netTotal  = Number(inv.netTotal       || inv.net_total       || 0);
    const cashRcvd  = Number(inv.cashReceived   || inv.cash_received   || 0);
    const change    = Number(inv.changeAmount   || inv.change_amount   || 0);

    // Build complete receipt HTML
    const receiptHtml = `
<div class="bill-view-receipt" id="billViewPrintArea">
    ${rs.header ? `<div class="bv-preheader">${_escHtml(rs.header)}</div>` : ''}
    <div class="bv-header">
        ${bi.businessName ? `<div class="bv-biz">${_escHtml(bi.businessName)}</div>` : ''}
        ${bi.branchName   ? `<div class="bv-branch">${_escHtml(bi.branchName)}</div>` : ''}
        ${bi.address      ? `<div class="bv-addr">${_escHtml(bi.address)}</div>`     : ''}
        ${bi.phone        ? `<div class="bv-phone">📞 ${_escHtml(bi.phone)}</div>`   : ''}
        ${bi.licenseNo    ? `<div class="bv-lic">License: ${_escHtml(bi.licenseNo)}</div>` : ''}
    </div>
    <div class="bv-divider"></div>
    <div class="bv-meta">
        <div class="bv-meta-row"><span class="bv-meta-lbl">Invoice #</span><span class="bv-meta-val ${isRefund ? 'bv-refund-badge' : ''}">${_escHtml(invoiceId)}</span></div>
        <div class="bv-meta-row"><span class="bv-meta-lbl">Date</span><span class="bv-meta-val">${dateStr}</span></div>
        ${inv.customerName || inv.customer_name ? `<div class="bv-meta-row"><span class="bv-meta-lbl">Customer</span><span class="bv-meta-val">${_escHtml(inv.customerName || inv.customer_name)}</span></div>` : ''}
        ${inv.customerPhone || inv.customer_phone ? `<div class="bv-meta-row"><span class="bv-meta-lbl">Phone</span><span class="bv-meta-val">${_escHtml(inv.customerPhone || inv.customer_phone)}</span></div>` : ''}
        ${inv.staffName || inv.staff_name ? `<div class="bv-meta-row"><span class="bv-meta-lbl">Staff</span><span class="bv-meta-val">${_escHtml(inv.staffName || inv.staff_name)}</span></div>` : ''}
        <div class="bv-meta-row"><span class="bv-meta-lbl">Payment</span><span class="bv-meta-val">${_escHtml((inv.paymentMethod || inv.payment_method || 'cash').toUpperCase())}</span></div>
        ${isRefund ? `<div class="bv-meta-row"><span class="bv-meta-lbl">Type</span><span class="bv-meta-val bv-refund-badge">REFUND</span></div>` : ''}
        ${inv.refund_reason || inv.refundReason ? `<div class="bv-meta-row"><span class="bv-meta-lbl">Reason</span><span class="bv-meta-val">${_escHtml(inv.refund_reason || inv.refundReason)}</span></div>` : ''}
    </div>
    <div class="bv-divider"></div>
    <table class="bv-items-table">
        <thead>
            <tr class="bv-thead-tr">
                <th class="bv-th" style="width:28px;">#</th>
                <th class="bv-th">Item</th>
                <th class="bv-th bv-td-r">Unit × Qty</th>
                <th class="bv-th bv-td-r">Total</th>
            </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
    </table>
    <div class="bv-divider"></div>
    <div class="bv-totals">
        <div class="bv-total-row"><span>Subtotal</span><span>${cur}${Number(inv.subtotal || 0).toFixed(2)}</span></div>
        ${discAmt > 0 ? `<div class="bv-total-row"><span>Discount (${inv.discountPct || inv.discount_pct || 0}%)</span><span>-${cur}${discAmt.toFixed(2)}</span></div>` : ''}
        ${roundOff !== 0 ? `<div class="bv-total-row"><span>Round Off</span><span>${roundOff >= 0 ? '+' : ''}${cur}${roundOff.toFixed(2)}</span></div>` : ''}
        <div class="bv-total-row bv-total-net"><span>Net Payable</span><span>${cur}${netTotal.toFixed(2)}</span></div>
        ${cashRcvd > 0 ? `<div class="bv-total-row"><span>Cash Received</span><span>${cur}${cashRcvd.toFixed(2)}</span></div>` : ''}
        ${cashRcvd > 0 ? `<div class="bv-total-row"><span>Change</span><span>${cur}${change.toFixed(2)}</span></div>` : ''}
    </div>
    ${rs.footer ? `<div class="bv-divider"></div><div class="bv-footer">${_escHtml(rs.footer)}</div>` : ''}
    <div class="bv-items-count">${items.length} item${items.length === 1 ? '' : 's'}</div>
</div>`;

    // ── Inject into modal ─────────────────────────────────────────────────
    let modal = document.getElementById('historyBillViewModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'historyBillViewModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:16000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:16px;';
        modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
<div style="background:var(--white);border-radius:14px;width:420px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.4);">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--g100);position:sticky;top:0;background:var(--white);z-index:2;">
        <div style="font-size:14px;font-weight:800;">📄 Invoice ${_escHtml(invoiceId)}</div>
        <div style="display:flex;gap:8px;align-items:center;">
            <button onclick="_printHistoryBill('${_escHtml(invoiceId)}')"
                style="padding:6px 12px;border:1.5px solid var(--blu);border-radius:6px;background:var(--white);color:var(--blu);font-size:11px;font-weight:800;cursor:pointer;">🖨 Print</button>
            ${!(isRefund || (inv.isFullyRefunded || inv.is_fully_refunded)) ? `<button onclick="_promptHistoryEdit('${_escHtml(invoiceId)}');document.getElementById('historyBillViewModal').style.display='none';"
                style="padding:6px 12px;border:1.5px solid var(--teal);border-radius:6px;background:var(--white);color:var(--teal);font-size:11px;font-weight:800;cursor:pointer;">✏️ Edit</button>` : ''}
            <button onclick="document.getElementById('historyBillViewModal').style.display='none'"
                style="width:28px;height:28px;border:none;border-radius:50%;background:var(--g100);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
        </div>
    </div>
    <div style="padding:16px 20px;">
        ${receiptHtml}
    </div>
</div>`;
    modal.style.display = 'flex';
}

/**
 * Print a specific invoice by ID.
 */
function _printHistoryBill(invoiceId) {
    _openHistoryBillView(invoiceId);
    // Delay print to allow modal render
    setTimeout(() => {
        const printArea = document.getElementById('billViewPrintArea');
        if (!printArea) { window.print(); return; }
        // Inject a temporary print-only style
        const style = document.createElement('style');
        style.id    = '_bv_print_style';
        style.textContent = `
            @media print {
                body > * { display: none !important; }
                #historyBillViewModal { display: flex !important; }
                #historyBillViewModal > div { box-shadow: none !important; border-radius: 0 !important; width: 100% !important; max-height: none !important; }
                #historyBillViewModal [style*="sticky"] { display: none !important; }
            }`;
        document.head.appendChild(style);
        window.print();
        setTimeout(() => { const s = document.getElementById('_bv_print_style'); if (s) s.remove(); }, 2000);
    }, 350);
}

/**
 * Alias for billing.js compatibility — opens the bill-view modal.
 */
function openBillReviewModal(invoiceId) { _openHistoryBillView(invoiceId); }

/**
 * Prompt the user before switching to edit mode for a historical invoice.
 */
function _promptHistoryEdit(invoiceId) {
    if (typeof showConfirmModal === 'function') {
        showConfirmModal(
            { title: '✏️ Edit Invoice', subtitle: 'Edit ' + invoiceId + '? Stock adjustments will only apply the delta between old and new quantities.' },
            () => {
                if (typeof startEditInvoice === 'function') startEditInvoice(invoiceId);
                else if (typeof showToast === 'function') showToast('⚠️ Edit not available.', true);
            },
            null, 'Edit Invoice', false
        );
    } else {
        if (typeof startEditInvoice === 'function') startEditInvoice(invoiceId);
    }
}

// =========================================================================
// SEARCH DEBOUNCE
// =========================================================================
function onHistSearchInput() {
    clearTimeout(_histSearchDebounce);
    _histSearchDebounce = setTimeout(() => { _histPage = 1; _applyHistoryFiltersAndRender(); }, 250);
}

// =========================================================================
// EXPORT — FILTERED VIEW
// =========================================================================
function exportFilteredHistoryCSV() {
    if (_historyFilteredView.length === 0) { if (typeof showToast === 'function') showToast('No data to export.', true); return; }
    const cur   = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const lines = ['Invoice #,Date,Customer,Amount,Payment,Staff,Type'];
    _historyFilteredView.forEach(inv => {
        const isRefund = !!(inv.isRefund || inv.is_refund);
        lines.push([
            inv.id || inv.invoice_number || '',
            (inv.billedAt || inv.billed_at || '').slice(0, 16),
            (inv.customerName || inv.customer_name || 'Walk-in').replace(/,/g, ';'),
            Number(inv.netTotal || inv.net_total || 0).toFixed(2),
            (inv.paymentMethod || inv.payment_method || 'cash').toUpperCase(),
            (inv.staffName || inv.staff_name || '').replace(/,/g, ';'),
            isRefund ? 'REFUND' : 'SALE'
        ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'history_export_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (typeof showToast === 'function') showToast('✅ History exported as CSV.');
}

// ── Init on tab switch ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const tab = document.getElementById('tab-history');
    if (tab) {
        tab.addEventListener('click', () => {
            setTimeout(() => {
                _historyLedger = (typeof savedInvoicesLedger !== 'undefined' && Array.isArray(savedInvoicesLedger))
                    ? savedInvoicesLedger
                    : [];
                _applyHistoryFiltersAndRender();
            }, 100);
        });
    }
});
