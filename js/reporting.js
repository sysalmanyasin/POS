// =========================================================================
// reporting.js — Reports & Analytics
// BUG 11 FIX: All large-dataset renders use _renderChunked() / idle-callback
//             batching so the main thread never freezes during billing.
// =========================================================================

// ── Report state ──────────────────────────────────────────────────────────
let _reportData         = [];
let _reportLedger       = [];
let _reportStartDate    = '';
let _reportEndDate      = '';
let _reportGroupBy      = 'day';
let _reportFilterMethod = 'all';

// =========================================================================
// INIT
// =========================================================================
function initReporting() {
    const today     = new Date().toISOString().split('T')[0];
    const weekAgo   = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    _reportStartDate = weekAgo;
    _reportEndDate   = today;

    const rs = document.getElementById('reportStartDate');
    const re = document.getElementById('reportEndDate');
    if (rs) rs.value = weekAgo;
    if (re) re.value = today;

    _loadReportData();
}

function _loadReportData() {
    _reportLedger = (typeof savedInvoicesLedger !== 'undefined' && Array.isArray(savedInvoicesLedger))
        ? savedInvoicesLedger
        : [];
    applyReportFilters();
}

// =========================================================================
// FILTER
// =========================================================================
function applyReportFilters() {
    _reportStartDate    = document.getElementById('reportStartDate')?.value    || _reportStartDate;
    _reportEndDate      = document.getElementById('reportEndDate')?.value      || _reportEndDate;
    _reportGroupBy      = document.getElementById('reportGroupBy')?.value      || 'day';
    _reportFilterMethod = document.getElementById('reportPayMethod')?.value    || 'all';

    _reportData = _reportLedger.filter(inv => {
        if (!inv || inv.isRefund || inv.is_refund) return false;
        const date = (inv.date || inv.billedAt || inv.billed_at || '').slice(0, 10);
        if (_reportStartDate && date < _reportStartDate) return false;
        if (_reportEndDate   && date > _reportEndDate)   return false;
        if (_reportFilterMethod !== 'all') {
            const pm = (inv.paymentMethod || inv.payment_method || 'cash').toLowerCase();
            if (pm !== _reportFilterMethod) return false;
        }
        return true;
    });

    _renderAllReports();
}

// =========================================================================
// BUG 11 FIX — All report sections rendered via _renderChunked()
// =========================================================================
function _renderAllReports() {
    _renderSalesSummary();
    _renderProductReport();
    _renderStaffReport();
    _renderPaymentMethodReport();
    _renderTimeSeriesChart();
}

// ── Summary cards ─────────────────────────────────────────────────────────
function _renderSalesSummary() {
    const cur       = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const total     = _reportData.reduce((s, i) => s + (Number(i.netTotal || i.net_total) || 0), 0);
    const avg       = _reportData.length > 0 ? total / _reportData.length : 0;
    const maxInv    = _reportData.reduce((max, i) => {
        const v = Number(i.netTotal || i.net_total) || 0;
        return v > max.v ? { v, id: i.id } : max;
    }, { v: 0, id: '—' });

    const days = _daysBetween(_reportStartDate, _reportEndDate) + 1 || 1;

    const _set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _set('rptTotalSales',   _reportData.length);
    _set('rptTotalRevenue', cur + total.toFixed(2));
    _set('rptAvgBill',      cur + avg.toFixed(2));
    _set('rptDailyAvg',     cur + (total / days).toFixed(2));
    _set('rptMaxBill',      cur + maxInv.v.toFixed(2) + (maxInv.id !== '—' ? ' (' + maxInv.id + ')' : ''));
    _set('rptDateRange',    (_reportStartDate || '—') + ' → ' + (_reportEndDate || '—'));
}

function _daysBetween(start, end) {
    if (!start || !end) return 0;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return Math.max(0, Math.floor(ms / 86400000));
}

// ── Product sales report (BUG 11: chunked) ───────────────────────────────
function _renderProductReport() {
    const container = document.getElementById('productReportBody');
    if (!container) return;

    // Aggregate product data from all invoices
    const productMap = new Map();
    _reportData.forEach(inv => {
        const items = inv.details || inv.line_items || [];
        items.forEach(li => {
            const code = li.code || li.product_code || '?';
            const name = li.name || li.product_name || code;
            const qty  = Number(li.qty || li.quantity || 0);
            const tot  = Number(li.total || 0);
            if (!productMap.has(code)) productMap.set(code, { code, name, qty: 0, revenue: 0, count: 0 });
            const p = productMap.get(code);
            p.qty     += qty;
            p.revenue += tot;
            p.count++;
        });
    });

    const products = [...productMap.values()].sort((a, b) => b.revenue - a.revenue);
    const cur      = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    container.innerHTML = '';

    if (products.length === 0) {
        container.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--g400);padding:16px;">No product data for the selected period.</td></tr>';
        return;
    }

    // BUG 11: render in idle chunks
    if (typeof _renderChunked === 'function') {
        _renderChunked(products, 20, (chunk) => {
            chunk.forEach(p => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td class="rpt-td">${_escHtml(p.code)}</td>
                    <td class="rpt-td">${_escHtml(p.name)}</td>
                    <td class="rpt-td rpt-r">${p.qty}</td>
                    <td class="rpt-td rpt-r">${p.count}</td>
                    <td class="rpt-td rpt-r" style="font-weight:700;">${cur}${p.revenue.toFixed(2)}</td>`;
                container.appendChild(tr);
            });
        });
    } else {
        products.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="rpt-td">${_escHtml(p.code)}</td>
                <td class="rpt-td">${_escHtml(p.name)}</td>
                <td class="rpt-td rpt-r">${p.qty}</td>
                <td class="rpt-td rpt-r">${p.count}</td>
                <td class="rpt-td rpt-r" style="font-weight:700;">${cur}${p.revenue.toFixed(2)}</td>`;
            container.appendChild(tr);
        });
    }

    const countEl = document.getElementById('productReportCount');
    if (countEl) countEl.textContent = products.length + ' products';
}

// ── Staff performance report (BUG 11: chunked) ───────────────────────────
function _renderStaffReport() {
    const container = document.getElementById('staffReportBody');
    if (!container) return;

    const staffMap = new Map();
    _reportData.forEach(inv => {
        const name = inv.staffName || inv.staff_name || 'Unknown';
        if (!staffMap.has(name)) staffMap.set(name, { name, count: 0, revenue: 0 });
        const s = staffMap.get(name);
        s.count++;
        s.revenue += Number(inv.netTotal || inv.net_total || 0);
    });

    const staffArr = [...staffMap.values()].sort((a, b) => b.revenue - a.revenue);
    const cur      = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    container.innerHTML = '';

    if (staffArr.length === 0) {
        container.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--g400);padding:16px;">No staff data for the selected period.</td></tr>';
        return;
    }

    if (typeof _renderChunked === 'function') {
        _renderChunked(staffArr, 15, (chunk) => {
            chunk.forEach(s => {
                const avg = s.count > 0 ? s.revenue / s.count : 0;
                const tr  = document.createElement('tr');
                tr.innerHTML = `
                    <td class="rpt-td">${_escHtml(s.name)}</td>
                    <td class="rpt-td rpt-r">${s.count}</td>
                    <td class="rpt-td rpt-r">${cur}${avg.toFixed(2)}</td>
                    <td class="rpt-td rpt-r" style="font-weight:700;">${cur}${s.revenue.toFixed(2)}</td>`;
                container.appendChild(tr);
            });
        });
    } else {
        staffArr.forEach(s => {
            const avg = s.count > 0 ? s.revenue / s.count : 0;
            const tr  = document.createElement('tr');
            tr.innerHTML = `
                <td class="rpt-td">${_escHtml(s.name)}</td>
                <td class="rpt-td rpt-r">${s.count}</td>
                <td class="rpt-td rpt-r">${cur}${avg.toFixed(2)}</td>
                <td class="rpt-td rpt-r" style="font-weight:700;">${cur}${s.revenue.toFixed(2)}</td>`;
            container.appendChild(tr);
        });
    }
}

// ── Payment method breakdown ──────────────────────────────────────────────
function _renderPaymentMethodReport() {
    const container = document.getElementById('payMethodReportBody');
    if (!container) return;

    const pmMap = new Map();
    _reportData.forEach(inv => {
        const pm = (inv.paymentMethod || inv.payment_method || 'cash').toLowerCase();
        if (!pmMap.has(pm)) pmMap.set(pm, { method: pm, count: 0, revenue: 0 });
        const p = pmMap.get(pm);
        p.count++;
        p.revenue += Number(inv.netTotal || inv.net_total || 0);
    });

    const pmArr   = [...pmMap.values()].sort((a, b) => b.revenue - a.revenue);
    const total   = pmArr.reduce((s, p) => s + p.revenue, 0);
    const cur     = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    container.innerHTML = '';

    if (pmArr.length === 0) {
        container.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--g400);padding:12px;">No data.</td></tr>';
        return;
    }

    pmArr.forEach(p => {
        const pct = total > 0 ? (p.revenue / total * 100).toFixed(1) : '0.0';
        const tr  = document.createElement('tr');
        tr.innerHTML = `
            <td class="rpt-td" style="text-transform:capitalize;">${_escHtml(p.method)}</td>
            <td class="rpt-td rpt-r">${p.count}</td>
            <td class="rpt-td rpt-r">${pct}%</td>
            <td class="rpt-td rpt-r" style="font-weight:700;">${cur}${p.revenue.toFixed(2)}</td>`;
        container.appendChild(tr);
    });
}

// ── Time-series chart (ASCII / bar) ──────────────────────────────────────
function _renderTimeSeriesChart() {
    const container = document.getElementById('timeSeriesChartArea');
    if (!container) return;

    // Group by day
    const dayMap = new Map();
    _reportData.forEach(inv => {
        const date = (inv.date || inv.billedAt || inv.billed_at || '').slice(0, 10);
        if (!date) return;
        if (!dayMap.has(date)) dayMap.set(date, { date, count: 0, revenue: 0 });
        const d = dayMap.get(date);
        d.count++;
        d.revenue += Number(inv.netTotal || inv.net_total || 0);
    });

    const days    = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const maxRev  = Math.max(1, ...days.map(d => d.revenue));
    const cur     = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    if (days.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--g400);padding:24px;font-size:12px;">No data for selected period.</div>';
        return;
    }

    // BUG 11: render bars in idle chunks
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:flex-end;gap:4px;height:120px;padding:8px;overflow-x:auto;';
    container.appendChild(wrapper);

    if (typeof _renderChunked === 'function') {
        _renderChunked(days, 10, (chunk) => {
            chunk.forEach(d => {
                const h   = Math.max(4, Math.round((d.revenue / maxRev) * 100));
                const bar = document.createElement('div');
                bar.style.cssText = `flex-shrink:0;width:28px;background:var(--teal);border-radius:3px 3px 0 0;height:${h}%;cursor:pointer;position:relative;`;
                bar.title         = d.date + ': ' + cur + d.revenue.toFixed(2) + ' (' + d.count + ' bills)';
                bar.innerHTML     = `<span style="position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:8px;color:var(--g500);white-space:nowrap;">${d.date.slice(5)}</span>`;
                wrapper.appendChild(bar);
            });
        });
    } else {
        days.forEach(d => {
            const h   = Math.max(4, Math.round((d.revenue / maxRev) * 100));
            const bar = document.createElement('div');
            bar.style.cssText = `flex-shrink:0;width:28px;background:var(--teal);border-radius:3px 3px 0 0;height:${h}%;cursor:pointer;`;
            bar.title         = d.date + ': ' + cur + d.revenue.toFixed(2) + ' (' + d.count + ' bills)';
            wrapper.appendChild(bar);
        });
    }
}

// =========================================================================
// EXPORT
// =========================================================================
function exportReportCSV() {
    if (_reportData.length === 0) { if (typeof showToast === 'function') showToast('No data to export.', true); return; }
    const cur   = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const lines = ['Invoice #,Date,Customer,Staff,Payment,Net Total'];
    _reportData.forEach(inv => {
        lines.push([
            inv.id || inv.invoice_number || '',
            (inv.billedAt || inv.billed_at || inv.date || '').slice(0, 16),
            (inv.customerName || inv.customer_name || 'Walk-in').replace(/,/g, ';'),
            (inv.staffName || inv.staff_name || '').replace(/,/g, ';'),
            (inv.paymentMethod || inv.payment_method || 'cash').toUpperCase(),
            Number(inv.netTotal || inv.net_total || 0).toFixed(2)
        ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'report_' + _reportStartDate + '_to_' + _reportEndDate + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (typeof showToast === 'function') showToast('✅ Report exported.');
}

// ── Init on tab switch ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const tab = document.getElementById('tab-reports');
    if (tab) tab.addEventListener('click', () => setTimeout(initReporting, 100));
});
