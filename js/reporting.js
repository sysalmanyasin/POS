// =========================================================================
// REPORTING MODULE — Phase 8
// Features:
//   A  — renderReportingView()        Tab shell + sub-section scaffold
//   B  — Revenue Summary              Cross-device totals from Supabase
//   C  — Per-Device Breakdown         Grouped by device_uuid
//   D  — Stock Overview               From inventory table
//   E  — Movement Audit               Per-product history
//   Z  — Staff Sales Report           (legacy modal, unchanged)
// =========================================================================

// ── Internal state ────────────────────────────────────────────────────────
let _rptDeviceMap   = {};   // uuid → { name, counter_id }
let _rptInvoices    = [];   // last fetched invoice dataset
let _rptInventory   = [];   // last fetched inventory dataset
let _rptFromDate    = '';
let _rptToDate      = '';

// =========================================================================
// SECTION A — Tab Shell Render
// =========================================================================
async function renderReportingView() {
    const view = document.getElementById('reportingView');
    if (!view) return;

    const today = new Date().toISOString().split('T')[0];
    _rptFromDate = _rptFromDate || today;
    _rptToDate   = _rptToDate   || today;

    view.innerHTML = `
<div class="rpt-wrap">

  <!-- ── Header ── -->
  <div class="rpt-hdr">
    <div class="rpt-hdr-left">
      <span class="rpt-hdr-icon">📈</span>
      <div>
        <div class="rpt-hdr-title">Reports &amp; Analytics</div>
        <div class="rpt-hdr-sub" id="rptAsOfLabel">As of last sync: —</div>
      </div>
    </div>
    <button class="rpt-refresh-btn" onclick="_rptRefreshAll()" title="Reload all data from cloud">
      🔄 Refresh
    </button>
  </div>

  <!-- ── Date Range Bar ── -->
  <div class="rpt-filter-bar">
    <span class="rpt-filter-label">Date Range:</span>
    <input type="date" id="rptFromDate" class="rpt-date-inp" value="${_escHtml(_rptFromDate)}">
    <span class="rpt-filter-sep">→</span>
    <input type="date" id="rptToDate"   class="rpt-date-inp" value="${_escHtml(_rptToDate)}">
    <button class="rpt-preset-btn" onclick="_rptSetPreset('today')">Today</button>
    <button class="rpt-preset-btn" onclick="_rptSetPreset('week')">This Week</button>
    <button class="rpt-preset-btn" onclick="_rptSetPreset('month')">This Month</button>
    <button class="rpt-preset-btn" onclick="_rptSetPreset('all')">All Time</button>
    <button class="rpt-apply-btn"  onclick="_rptApplyDateFilter()">Apply Filter</button>
  </div>

  <!-- ── Section 1: Revenue Summary ── -->
  <div class="rpt-section-hdr">
    <span class="rpt-section-icon">💰</span> Revenue Summary
    <span class="rpt-source-badge rpt-source-spin" id="rptRevSource" title="Indicates whether invoice data was loaded from Supabase (cloud) or this device's local cache">⟳ loading…</span>
    <span class="rpt-section-badge" id="rptRevBadge"></span>
  </div>
  <div id="rptRevSummary" class="rpt-card-row">
    <div class="rpt-placeholder">Loading revenue data…</div>
  </div>

  <!-- ── Section 2: Per-Device Breakdown ── -->
  <div class="rpt-section-hdr" style="margin-top:18px;">
    <span class="rpt-section-icon">🖥️</span> Per-Device Breakdown
  </div>
  <div id="rptDeviceBreakdown" class="rpt-table-wrap">
    <div class="rpt-placeholder">Loading device data…</div>
  </div>

  <!-- ── Section 3: Stock Overview ── -->
  <div class="rpt-section-hdr" style="margin-top:18px;">
    <span class="rpt-section-icon">📦</span> Stock Overview
    <span class="rpt-source-badge rpt-source-spin" id="rptStockSource" title="Indicates whether inventory data was loaded from Supabase (cloud) or this device's local cache">⟳ loading…</span>
    <span class="rpt-section-badge" id="rptStockBadge"></span>
  </div>
  <div id="rptStockSummary" class="rpt-card-row" style="margin-bottom:10px;">
    <div class="rpt-placeholder">Loading inventory…</div>
  </div>
  <div id="rptStockTable" class="rpt-table-wrap"></div>

  <!-- ── Section 4: Movement Audit ── -->
  <div class="rpt-section-hdr" style="margin-top:18px;">
    <span class="rpt-section-icon">🔍</span> Movement Audit
  </div>
  <div class="rpt-audit-bar">
    <input type="text" id="rptAuditCode" class="rpt-audit-inp"
           placeholder="Enter product code…" autocomplete="off"
           onkeydown="if(event.key==='Enter')_rptLoadMovementAudit()">
    <button class="rpt-apply-btn" onclick="_rptLoadMovementAudit()">Load Audit Trail</button>
  </div>
  <div id="rptAuditTable" class="rpt-table-wrap">
    <div class="rpt-placeholder rpt-muted">Enter a product code above to view its movement history.</div>
  </div>

</div>`;

    _rptUpdateAsOfLabel();

    // ── Fix 9A: On client, seed savedInvoicesLedger before rendering ──────
    // _rptLoadRevenue falls back to savedInvoicesLedger which is empty on a
    // client that has never opened the History tab. Prime it now if needed.
    try {
        const _rptRole = (typeof StorageModule !== 'undefined') ? StorageModule.get('pharma_device_role') : null;
        const _rptLedger = (typeof window.savedInvoicesLedger !== 'undefined' && Array.isArray(window.savedInvoicesLedger))
            ? window.savedInvoicesLedger : [];
        if (_rptRole === 'client' && _rptLedger.length === 0 && typeof _loadLedgerCloud === 'function') {
            await _loadLedgerCloud();
        }
    } catch (_e) { /* non-fatal — proceed with whatever data we have */ }

    await _rptRefreshAll();
}

// =========================================================================
// SECTION B — Revenue Summary + Per-Device Breakdown
// =========================================================================
async function _rptLoadRevenue() {
    const from = _rptFromDate;
    const to   = _rptToDate + 'T23:59:59';
    const filter = `billed_at=gte.${from}&billed_at=lte.${encodeURIComponent(to)}&order=billed_at.desc`;

    // Show loading state on source badge while fetching
    _rptSetSourceBadge('rptRevSource', 'loading');

    let invoices    = null;
    let dataSource  = 'cloud';  // track which source was ultimately used

    try {
        const { data, error } = await _dbSelect('invoices', filter, '*');
        if (!error) invoices = data || [];
    } catch (_e) { /* fall through to local */ }

    // FIX: If Supabase returned 0 results (bill not yet synced, or sync off),
    // fall back to the local invoice ledger so the report always shows data.
    if (!invoices || invoices.length === 0) {
        dataSource = 'local';
        const localLedger = (typeof window.savedInvoicesLedger !== 'undefined' && Array.isArray(window.savedInvoicesLedger))
            ? window.savedInvoicesLedger : [];
        invoices = localLedger
            .filter(function(inv) {
                const d = (inv.billed_at || inv.date || '').slice(0, 10);
                return d >= from && d <= _rptToDate;
            })
            .map(function(inv) {
                // Normalise camelCase local fields to snake_case Supabase shape
                return {
                    billed_at:   inv.billed_at || inv.date || '',
                    net_total:   Number(inv.net_total !== undefined ? inv.net_total : (inv.netTotal || 0)),
                    is_refund:   inv.is_refund !== undefined ? inv.is_refund : (inv.isRefund || false),
                    device_uuid: inv.device_uuid || inv.deviceUUID || '',
                    staff_name:  inv.staff_name || inv.staffName || '',
                };
            });
    } else {
        // Cloud returned data — check if local ledger also has unsynced records
        // that aren't yet in Supabase, and flag as "mixed" if so.
        const localCount = (typeof window.savedInvoicesLedger !== 'undefined' &&
                            Array.isArray(window.savedInvoicesLedger))
                           ? window.savedInvoicesLedger.length : 0;
        if (localCount > invoices.length) dataSource = 'mixed';
    }

    _rptInvoices = invoices;
    _rptSetSourceBadge('rptRevSource', dataSource);
    _rptRenderRevenueSummary(_rptInvoices);
    _rptRenderDeviceBreakdown(_rptInvoices);
}

function _rptRenderRevenueSummary(invoices) {
    const el = document.getElementById('rptRevSummary');
    if (!el) return;
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    const sales    = invoices.filter(i => !i.is_refund);
    const refunds  = invoices.filter(i => i.is_refund);
    const totalRev = sales.reduce((s, i) => s + (Number(i.net_total) || 0), 0);
    // FIX: local ledger stores refund netTotal as negative (e.g. -3000) while
    // Supabase stores it as positive.  Use Math.abs() so both sources produce
    // a positive refund total, preventing double-negative arithmetic (3000 - -3000 = 6000).
    const totalRef = refunds.reduce((s, i) => s + Math.abs(Number(i.net_total) || 0), 0);
    const netRev   = totalRev - totalRef;
    const avgBill  = sales.length ? (totalRev / sales.length) : 0;

    const badge = document.getElementById('rptRevBadge');
    if (badge) badge.textContent = sales.length + ' invoices';

    el.innerHTML = `
<div class="rpt-stat-card">
  <div class="rpt-stat-val rpt-col-grn">${cur}${_fmtNum(totalRev)}</div>
  <div class="rpt-stat-lbl">Gross Revenue</div>
</div>
<div class="rpt-stat-card">
  <div class="rpt-stat-val rpt-col-red">−${cur}${_fmtNum(totalRef)}</div>
  <div class="rpt-stat-lbl">Refunds (${refunds.length})</div>
</div>
<div class="rpt-stat-card rpt-stat-card--accent">
  <div class="rpt-stat-val rpt-col-blu">${cur}${_fmtNum(netRev)}</div>
  <div class="rpt-stat-lbl">Net Revenue</div>
</div>
<div class="rpt-stat-card">
  <div class="rpt-stat-val">${sales.length}</div>
  <div class="rpt-stat-lbl">Total Bills</div>
</div>
<div class="rpt-stat-card">
  <div class="rpt-stat-val">${cur}${_fmtNum(avgBill)}</div>
  <div class="rpt-stat-lbl">Avg Bill Value</div>
</div>`;
}

function _rptRenderDeviceBreakdown(invoices) {
    const el = document.getElementById('rptDeviceBreakdown');
    if (!el) return;
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    const sales = invoices.filter(i => !i.is_refund);
    const map   = {};
    sales.forEach(inv => {
        const uid = inv.device_uuid || 'unknown';
        if (!map[uid]) map[uid] = { count: 0, total: 0 };
        map[uid].count++;
        map[uid].total += Number(inv.net_total) || 0;
    });

    if (!Object.keys(map).length) {
        el.innerHTML = '<div class="rpt-placeholder rpt-muted">No invoices in this date range.</div>';
        return;
    }

    const rows = Object.entries(map)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([uid, v]) => {
            const dev  = _rptDeviceMap[uid] || {};
            const name = _escHtml(dev.name || uid.slice(0, 8));
            const cid  = _escHtml(dev.counter_id || '—');
            const role = _escHtml(dev.role || '');
            return `<tr>
              <td><span class="rpt-dev-name">${name}</span>
                  ${role === 'master' ? '<span class="rpt-badge-master">Master</span>' : '<span class="rpt-badge-client">Client</span>'}
              </td>
              <td class="rpt-td-ctr">${cid}</td>
              <td class="rpt-td-ctr">${v.count}</td>
              <td class="rpt-td-right rpt-col-grn">${cur}${_fmtNum(v.total)}</td>
            </tr>`;
        }).join('');

    el.innerHTML = `
<table class="rpt-table">
  <thead><tr>
    <th>Device</th><th class="rpt-td-ctr">Counter</th>
    <th class="rpt-td-ctr">Bills</th><th class="rpt-td-right">Revenue</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// =========================================================================
// SECTION C — Stock Overview
// =========================================================================
// ── Paginated inventory fetch ─────────────────────────────────────────────
// PostgREST defaults to 1000 rows per request. With 5000+ SKUs the plain
// _dbSelect() call was silently capped at 1000, leaving 4000+ rows missing.
// This helper loops through every page until a partial (< PAGE_SIZE) response
// signals the last page, then returns the full merged array.
async function _fetchAllInventoryPaged() {
    const PAGE = 1000;
    let all    = [];
    let offset = 0;
    while (true) {
        const r = await fetch(
            _SUPA_URL + '/rest/v1/inventory?order=name.asc&limit=' + PAGE + '&offset=' + offset,
            { headers: _SUPA_HEADERS }
        );
        if (!r.ok) throw new Error('inventory fetch failed: ' + r.status);
        const page = await r.json();
        if (!Array.isArray(page)) throw new Error('unexpected inventory response');
        all = all.concat(page);
        if (page.length < PAGE) break;   // last page reached
        offset += PAGE;
    }
    return all;
}

async function _rptLoadStock() {
    // Show loading state on source badge while fetching
    _rptSetSourceBadge('rptStockSource', 'loading');

    let inventory   = null;
    let dataSource  = 'cloud';

    try {
        // FIX (Bug 3): use paginated fetch instead of _dbSelect which was
        // capped at PostgREST's default 1000-row limit, hiding 4000+ SKUs.
        inventory = await _fetchAllInventoryPaged();
    } catch (_e) { inventory = null; /* fall through to local */ }

    // FIX: If Supabase inventory table is empty (CSV not yet cloud-pushed, or sync off),
    // fall back to the in-memory masterInventoryDB so stock overview always shows data.
    if (!inventory || inventory.length === 0) {
        dataSource = 'local';
        const localInv = (typeof window.masterInventoryDB !== 'undefined' && Array.isArray(window.masterInventoryDB))
            ? window.masterInventoryDB : [];
        // Normalise camelCase local fields to snake_case Supabase shape expected by _rptRenderStockOverview
        inventory = localInv.map(function(item) {
            return {
                code:       item.code       || '',
                name:       item.name       || '',
                stock:      Number(item.stock) || 0,
                unit_price: item.unit_price !== undefined ? Number(item.unit_price) : (Number(item.unitPrice) || 0),
                pack_size:  item.pack_size  !== undefined ? item.pack_size           : (item.packDetails || ''),
                // F1.31: map company/supplier/generic so grouping works for local data.
                // Local IDB uses camelCase; Supabase uses snake_case — handle both.
                company:    item.company    || '',
                supplier:   item.supplier   || '',
                generic:    item.generic    || item.generic_name || '',
            };
        }).sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    }

    _rptInventory = inventory;
    _rptSetSourceBadge('rptStockSource', dataSource);
    _rptRenderStockOverview(_rptInventory);
}

// ── Stock group-by state ──────────────────────────────────────────────────
let _rptStockGroupBy = 'none'; // 'none' | 'company' | 'supplier' | 'status'

function _rptRenderStockOverview(inventory) {
    const summEl  = document.getElementById('rptStockSummary');
    const tableEl = document.getElementById('rptStockTable');
    const badge   = document.getElementById('rptStockBadge');
    if (!summEl || !tableEl) return;

    const totalSKU   = inventory.length;
    const outOfStock = inventory.filter(i => (Number(i.stock) || 0) <= 0);
    const lowStock   = inventory.filter(i => { const s = Number(i.stock) || 0; return s > 0 && s < 10; });

    if (badge) badge.textContent = totalSKU + ' SKUs';

    summEl.innerHTML = `
<div class="rpt-stat-card">
  <div class="rpt-stat-val">${totalSKU}</div>
  <div class="rpt-stat-lbl">Total SKUs</div>
</div>
<div class="rpt-stat-card rpt-stat-card--warn">
  <div class="rpt-stat-val rpt-col-amb">${lowStock.length}</div>
  <div class="rpt-stat-lbl">Low Stock (&lt;10)</div>
</div>
<div class="rpt-stat-card rpt-stat-card--danger">
  <div class="rpt-stat-val rpt-col-red">${outOfStock.length}</div>
  <div class="rpt-stat-lbl">Out of Stock / Oversold</div>
</div>`;

    if (!inventory.length) {
        tableEl.innerHTML = '<div class="rpt-placeholder rpt-muted">No inventory data.</div>';
        return;
    }

    // ── Group-by toolbar ─────────────────────────────────────────────────
    const groupOpts = [
        { value: 'none',     label: 'No Grouping' },
        { value: 'company',  label: 'Manufacturer' },
        { value: 'supplier', label: 'Supplier' },
        { value: 'status',   label: 'Stock Status' },
    ].map(o => `<option value="${o.value}"${_rptStockGroupBy === o.value ? ' selected' : ''}>${o.label}</option>`).join('');

    const collapseExpandBtns = _rptStockGroupBy !== 'none' ? `
  <button onclick="window._rptCollapseAll(true)"
    style="padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;border:1px solid var(--g200);background:var(--g100);color:var(--g600);cursor:pointer;">
    &#9658; Collapse All
  </button>
  <button onclick="window._rptCollapseAll(false)"
    style="padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;border:1px solid var(--g200);background:var(--g100);color:var(--g600);cursor:pointer;">
    &#9660; Expand All
  </button>` : '';

    const toolbar = `<div class="rpt-stock-toolbar" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
  <label style="font-size:12px;color:var(--g500);font-weight:600;">Group by:</label>
  <select id="rptStockGroupSel" class="rpt-date-inp" style="padding:4px 8px;font-size:12px;"
    onchange="window._rptOnStockGroupChange(this.value)">${groupOpts}</select>
  ${collapseExpandBtns}
</div>`;

    // ── Sort items: negative → low → normal, then alpha ──────────────────
    const sorted = [...inventory].sort((a, b) => {
        const sa = Number(a.stock) || 0, sb = Number(b.stock) || 0;
        if (sa <= 0 && sb > 0) return -1;
        if (sb <= 0 && sa > 0) return  1;
        if (sa < 10 && sb >= 10) return -1;
        if (sb < 10 && sa >= 10) return  1;
        return (a.name || '').localeCompare(b.name || '');
    });

    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';

    function _itemRow(item) {
        const stock = Number(item.stock) || 0;
        const cls   = stock < 0 ? 'rpt-stock-neg' : (stock < 10 ? 'rpt-stock-low' : '');
        const tag   = stock < 0 ? '<span class="rpt-badge-oos">Oversold</span>'
                    : (stock === 0 ? '<span class="rpt-badge-oos">Out</span>'
                    : (stock < 10  ? '<span class="rpt-badge-low">Low</span>' : ''));
        return `<tr class="${cls}">
          <td>${_escHtml(item.code || '')}</td>
          <td>${_escHtml(item.name || '')} ${tag}</td>
          <td>${_escHtml(item.pack_size || '—')}</td>
          <td class="rpt-td-right">${cur}${_fmtNum(Number(item.unit_price) || 0)}</td>
          <td class="rpt-td-right rpt-stock-val ${stock < 0 ? 'rpt-col-red' : (stock < 10 ? 'rpt-col-amb' : '')}">${stock}</td>
        </tr>`;
    }

    const theadRow = `<tr><th>Code</th><th>Name</th><th>Pack</th>
      <th class="rpt-td-right">Unit Price</th><th class="rpt-td-right">Stock</th></tr>`;

    let tableHtml = '';

    if (_rptStockGroupBy === 'none') {
        tableHtml = `<table class="rpt-table"><thead>${theadRow}</thead><tbody>${sorted.map(_itemRow).join('')}</tbody></table>`;
    } else {
        // ── Build groups ─────────────────────────────────────────────────
        function _groupKey(item) {
            if (_rptStockGroupBy === 'company')  return (item.company  || '').trim() || '(No Manufacturer)';
            if (_rptStockGroupBy === 'supplier') return (item.supplier || '').trim() || '(No Supplier)';
            if (_rptStockGroupBy === 'status') {
                const s = Number(item.stock) || 0;
                return s < 0 ? '🔴 Oversold' : s === 0 ? '🔴 Out of Stock' : s < 10 ? '🟡 Low Stock' : '🟢 In Stock';
            }
            return 'All';
        }

        const groupMap = new Map();
        sorted.forEach(item => {
            const key = _groupKey(item);
            if (!groupMap.has(key)) groupMap.set(key, []);
            groupMap.get(key).push(item);
        });

        // Sort group keys (status has a natural sort order by the emoji prefix)
        const sortedKeys = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));

        const sections = sortedKeys.map(key => {
            const items = groupMap.get(key);
            const totalStock = items.reduce((s, i) => s + (Number(i.stock) || 0), 0);
            const groupId = 'rptsg_' + key.replace(/[^a-z0-9]/gi, '_');
            const rows = items.map(_itemRow).join('');
            return `
<div class="rpt-stock-group" style="margin-bottom:4px;">
  <div class="rpt-stock-group-hdr" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--g100);border-radius:6px;cursor:pointer;user-select:none;font-size:13px;font-weight:700;color:var(--g700);"
       onclick="var t=document.getElementById('${groupId}');var arr=this.querySelector('.rpt-grp-arrow');if(t){var collapsed=t.style.display==='none';t.style.display=collapsed?'':'none';if(arr)arr.textContent=collapsed?'▾':'▸';}">
    <span style="flex:1;"><span class="rpt-grp-arrow">▾</span> ${_escHtml(key)}</span>
    <span style="font-size:11px;font-weight:500;color:var(--g500);">${items.length} SKU${items.length !== 1 ? 's' : ''} · Total stock: ${totalStock}</span>
  </div>
  <div id="${groupId}">
    <table class="rpt-table" style="margin-top:0;border-radius:0 0 6px 6px;">
      <thead>${theadRow}</thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
        }).join('');

        tableHtml = sections;
    }

    tableEl.innerHTML = toolbar + tableHtml;
}

// Called by the group-by dropdown in the DOM
window._rptOnStockGroupChange = function(val) {
    _rptStockGroupBy = val;
    if (typeof _rptInventory !== 'undefined' && _rptInventory) {
        _rptRenderStockOverview(_rptInventory);
    }
};

// Collapse All (collapse=true) or Expand All (collapse=false)
window._rptCollapseAll = function(collapse) {
    const tableEl = document.getElementById('rptStockTable');
    if (!tableEl) return;
    tableEl.querySelectorAll('.rpt-stock-group').forEach(function(grp) {
        const body  = grp.querySelector('[id^="rptsg_"]');
        const arrow = grp.querySelector('.rpt-grp-arrow');
        if (body)  body.style.display  = collapse ? 'none' : '';
        if (arrow) arrow.textContent   = collapse ? '▸' : '▾';
    });
};

// =========================================================================
// SECTION D — Movement Audit
// =========================================================================
async function _rptLoadMovementAudit() {
    const input = document.getElementById('rptAuditCode');
    const code  = (input?.value || '').trim();
    const el    = document.getElementById('rptAuditTable');
    if (!el) return;

    if (!code) {
        el.innerHTML = '<div class="rpt-placeholder rpt-muted">Enter a product code above.</div>';
        return;
    }

    el.innerHTML = '<div class="rpt-placeholder">Loading movements…</div>';

    const filter = `product_code=eq.${encodeURIComponent(code)}&order=moved_at.desc`;
    const { data, error } = await _dbSelect('inventory_movements', filter, '*');
    if (error) {
        showToast('⚠️ Audit load failed: ' + (error.message || error), 'error');
        el.innerHTML = '<div class="rpt-placeholder rpt-muted">Failed to load.</div>';
        return;
    }

    const movements = data || [];
    if (!movements.length) {
        el.innerHTML = `<div class="rpt-placeholder rpt-muted">No movements found for product code <strong>${_escHtml(code)}</strong>.</div>`;
        return;
    }

    const rows = movements.map(m => {
        const dev     = _rptDeviceMap[m.device_uuid] || {};
        const devName = _escHtml(dev.name || (m.device_uuid || '').slice(0, 8));
        const movedAt = m.moved_at ? new Date(m.moved_at).toLocaleString('en-PK', { dateStyle: 'short', timeStyle: 'short' }) : '—';
        const qtySign = (Number(m.quantity_change) || 0) >= 0 ? '+' : '';
        const qtyClass = (Number(m.quantity_change) || 0) < 0 ? 'rpt-col-red' : 'rpt-col-grn';
        const typeClass = {
            SALE:           'rpt-mv-sale',
            REFUND:         'rpt-mv-refund',
            PARTIAL_REFUND: 'rpt-mv-refund',
            ADJUSTMENT:     'rpt-mv-adj',
            IMPORT:         'rpt-mv-import',
            MANUAL_EDIT:    'rpt-mv-manual',
        }[m.movement_type] || '';
        return `<tr>
          <td class="rpt-mv-ts">${movedAt}</td>
          <td><span class="rpt-mv-type ${typeClass}">${_escHtml(m.movement_type || '—')}</span></td>
          <td class="rpt-td-right ${qtyClass} rpt-fw7">${qtySign}${Number(m.quantity_change) || 0}</td>
          <td class="rpt-td-right">${m.stock_after !== null && m.stock_after !== undefined ? Number(m.stock_after) : '—'}</td>
          <td>${_escHtml(m.invoice_number || '—')}</td>
          <td>${devName}</td>
          <td class="rpt-mv-desc">${_escHtml(m.description || '—')}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
<div class="rpt-audit-title">Audit trail for <strong>${_escHtml(code)}</strong> — ${movements.length} record${movements.length !== 1 ? 's' : ''}</div>
<table class="rpt-table">
  <thead><tr>
    <th>Date/Time</th><th>Type</th>
    <th class="rpt-td-right">Qty Δ</th>
    <th class="rpt-td-right">Stock After</th>
    <th>Invoice</th><th>Device</th><th>Description</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// =========================================================================
// SECTION E — Utilities
// =========================================================================

// ── Source-badge helper ───────────────────────────────────────────────────
// Renders a coloured pill on the section header indicating where the data
// came from.  source = 'cloud' | 'local' | 'mixed' | 'loading'
// ─────────────────────────────────────────────────────────────────────────
function _rptSetSourceBadge(elementId, source) {
    const el = document.getElementById(elementId);
    if (!el) return;
    // Reset classes — keep only base class
    el.className = 'rpt-source-badge';
    switch (source) {
        case 'cloud':
            el.classList.add('rpt-source-cloud');
            el.textContent = '☁️ Supabase — fully synced';
            el.title = 'All data was loaded from Supabase cloud.';
            break;
        case 'local':
            el.classList.add('rpt-source-local');
            el.textContent = '💾 Local cache — not yet synced';
            el.title = 'Cloud returned no data. Showing this device\'s local cache. '
                     + 'Sync to Supabase to see all devices.';
            break;
        case 'mixed':
            el.classList.add('rpt-source-mixed');
            el.textContent = '⚡ Cloud + pending local';
            el.title = 'Cloud data was used, but this device has additional invoices '
                     + 'not yet pushed to Supabase. Run Force Sync to upload them.';
            break;
        default: // 'loading'
            el.classList.add('rpt-source-spin');
            el.textContent = '⟳ loading…';
            el.title = 'Fetching data…';
    }
}

async function _rptFetchDeviceMap() {
    try {
        const devices = await DevicesModule._fetchAllDevices();
        _rptDeviceMap = {};
        (devices || []).forEach(d => {
            _rptDeviceMap[d.uuid] = { name: d.name, counter_id: d.counter_id, role: d.role };
        });
    } catch (e) {
        // non-fatal — UUID will show raw
    }
}

function _rptUpdateAsOfLabel() {
    const el = document.getElementById('rptAsOfLabel');
    if (!el) return;
    const key = (typeof window._LAST_SYNC_KEY !== 'undefined') ? window._LAST_SYNC_KEY : null;
    const raw = key ? localStorage.getItem(key) : null;
    if (raw) {
        const d = new Date(raw);
        el.textContent = 'As of last sync: ' + d.toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' });
    } else {
        el.textContent = 'As of last sync: — (not yet synced)';
    }
}

async function _rptRefreshAll() {
    _rptUpdateAsOfLabel();
    await _rptFetchDeviceMap();
    await Promise.all([_rptLoadRevenue(), _rptLoadStock()]);
}

function _rptSetPreset(preset) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    let from = todayStr, to = todayStr;
    if (preset === 'week') {
        const d = new Date(today); d.setDate(d.getDate() - d.getDay());
        from = d.toISOString().split('T')[0];
    } else if (preset === 'month') {
        from = todayStr.slice(0, 7) + '-01';
    } else if (preset === 'all') {
        from = '2000-01-01';
    }
    const f = document.getElementById('rptFromDate');
    const t = document.getElementById('rptToDate');
    if (f) f.value = from;
    if (t) t.value = to;
    _rptApplyDateFilter();
}

async function _rptApplyDateFilter() {
    const f = document.getElementById('rptFromDate');
    const t = document.getElementById('rptToDate');
    if (!f || !t) return;
    _rptFromDate = f.value || new Date().toISOString().split('T')[0];
    _rptToDate   = t.value || _rptFromDate;
    await _rptLoadRevenue();
}

function _fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return v.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return v.toFixed(2);
}

// =========================================================================
// SECTION Z — Staff Sales Report (legacy modal — unchanged)
// =========================================================================
function openStaffSalesReport() {
    const modal = document.getElementById('staffReportModal'); if (!modal) return;
    modal.style.display = 'flex';
    const fromEl = document.getElementById('srFromDate'); const toEl = document.getElementById('srToDate');
    if (fromEl && !fromEl.value) { const today = new Date().toISOString().split('T')[0]; fromEl.value = today; toEl.value = today; }
    _setStaffReportPreset('today');
}
function closeStaffSalesReport() { const modal = document.getElementById('staffReportModal'); if (modal) modal.style.display = 'none'; }
function _setStaffReportPreset(preset) {
    const today = new Date(); const todayStr = today.toISOString().split('T')[0];
    let from = todayStr, to = todayStr;
    if (preset === 'week') { const d = new Date(today); d.setDate(d.getDate() - d.getDay()); from = d.toISOString().split('T')[0]; }
    else if (preset === 'month') { from = todayStr.slice(0, 7) + '-01'; }
    else if (preset === 'all') { from = '2000-01-01'; }
    const fromEl = document.getElementById('srFromDate'); const toEl = document.getElementById('srToDate');
    if (fromEl) fromEl.value = from; if (toEl) toEl.value = to;
    ['today','week','month','all'].forEach(p => { const btn = document.getElementById('srp-' + p); if (btn) btn.classList.toggle('active', p === preset); });
    _applyStaffReportFilter();
}
function _applyStaffReportFilter() {
    const today = new Date().toISOString().split('T')[0];
    const from = (document.getElementById('srFromDate')?.value) || today;
    const to   = (document.getElementById('srToDate')?.value)   || today;
    const lbl  = document.getElementById('staffReportDateLabel');
    if (lbl) lbl.textContent = from === to ? from : from + ' → ' + to;
    const invoices = (savedInvoicesLedger || []).filter(inv => { if (inv.isRefund) return false; const d = (inv.date || '').slice(0, 10); return d >= from && d <= to; });
    _renderStaffReport(invoices);
}
function _aggregateStaffSales(invoices) {
    const map = {};
    invoices.forEach(inv => {
        const name = (inv.staffName || '').trim() || 'Unassigned';
        if (!map[name]) map[name] = { count: 0, sales: 0, discount: 0 };
        map[name].count++; map[name].sales += inv.netTotal || 0;
        const gross = (inv.details || []).reduce((a, c) => a + (c.total || 0), 0);
        map[name].discount += Math.max(0, gross - (inv.netTotal || 0) - (inv.roundOffAmt || 0));
    });
    const sorted = Object.entries(map).sort((a, b) => b[1].sales - a[1].sales);
    const totalSales = sorted.reduce((s, [, v]) => s + v.sales, 0);
    const totalBills = sorted.reduce((s, [, v]) => s + v.count, 0);
    const totalDiscount = sorted.reduce((s, [, v]) => s + v.discount, 0);
    return { sorted, totalSales, totalBills, totalDiscount };
}
function _printStaffReport() {
    const today = new Date().toISOString().split('T')[0];
    const from = (document.getElementById('srFromDate')?.value) || today;
    const to   = (document.getElementById('srToDate')?.value)   || today;
    const dateLabel = from === to ? from : from + ' to ' + to;
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    const invoices = (savedInvoicesLedger || []).filter(inv => {
        if (inv.isRefund) return false;
        const d = (inv.date || '').slice(0, 10);
        return d >= from && d <= to;
    });
    const { sorted, totalSales, totalBills, totalDiscount } = _aggregateStaffSales(invoices);
    const COLORS = ['#0057b8','#1a7a4a','#b45309','#6d28d9','#c0392b','#0891b2','#be185d'];
    const rows = sorted.map(([name, v], idx) => {
        const pct   = totalSales > 0 ? ((v.sales / totalSales) * 100).toFixed(1) : '0.0';
        const color = COLORS[idx % COLORS.length];
        const cs    = 'padding:8px 10px;border-bottom:1px solid #f1f3f5;';
        const avatar = '<span style="width:26px;height:26px;border-radius:50%;background:' + color + ';display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;margin-right:8px;">' + name.charAt(0).toUpperCase() + '</span>';
        return ['<tr>', '<td style="' + cs + '">' + avatar + '<strong>' + _escHtml(name) + '</strong></td>', '<td style="' + cs + 'text-align:center;">' + v.count + '</td>', '<td style="' + cs + 'text-align:right;font-weight:700;color:' + color + ';">' + cur + v.sales.toFixed(2) + '</td>', '<td style="' + cs + 'text-align:right;color:#b45309;">' + cur + v.discount.toFixed(2) + '</td>', '<td style="' + cs + 'text-align:right;">' + pct + '%</td>', '</tr>'].join('');
    }).join('');
    const emptyRow = invoices.length === 0 ? '<tr><td colspan="5" style="padding:24px;text-align:center;color:#aaa;">No invoices found for this period.</td></tr>' : '';
    const printedAt = new Date().toLocaleString();
    const reportCSS = ['*{box-sizing:border-box;margin:0;padding:0;}', 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1e1e2e;background:#fff;padding:28px 36px;font-size:12px;}', 'h1{font-size:20px;font-weight:800;margin-bottom:3px;}', '.sub{font-size:11px;color:#888;margin-bottom:20px;}', '.summary{display:flex;gap:14px;margin-bottom:24px;}', '.card{flex:1;border:1.5px solid #e5e7eb;border-radius:8px;padding:12px 14px;}', '.card .val{font-size:22px;font-weight:800;}', '.card .lbl{font-size:10px;color:#888;margin-top:2px;}', 'table{width:100%;border-collapse:collapse;}', 'thead th{background:#f8f9fa;padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#888;text-transform:uppercase;border-bottom:2px solid #e5e7eb;}', 'thead th:not(:first-child){text-align:right;}', 'thead th:nth-child(2){text-align:center;}', 'tfoot td{padding:8px 10px;font-weight:800;border-top:2px solid #1e1e2e;}', 'tfoot td:not(:first-child){text-align:right;}', 'tfoot td:nth-child(2){text-align:center;}', '.footer{margin-top:28px;font-size:9px;color:#aaa;border-top:1px solid #f1f3f5;padding-top:10px;}', '@media print{body{padding:12px 16px;}@page{margin:1cm;}}'].join('');
    const summaryCards = ['<div class="card"><div class="val">' + totalBills + '</div><div class="lbl">Total Bills</div></div>', '<div class="card" style="border-color:#bbf7d0;"><div class="val" style="color:#1a7a4a;">' + cur + totalSales.toFixed(2) + '</div><div class="lbl">Total Sales</div></div>', '<div class="card" style="border-color:#fde68a;"><div class="val" style="color:#b45309;">' + cur + totalDiscount.toFixed(2) + '</div><div class="lbl">Total Discount</div></div>'].join('');
    const tfootRow = ['<tfoot><tr>', '<td>Totals</td>', '<td style="text-align:center;">' + totalBills + '</td>', '<td>' + cur + totalSales.toFixed(2) + '</td>', '<td>' + cur + totalDiscount.toFixed(2) + '</td>', '<td>100%</td>', '</tr></tfoot>'].join('');
    const html = ['<!DOCTYPE html><html><head>', '<meta charset="UTF-8">', '<title>Staff Sales Report — ' + dateLabel + '</title>', '<style>' + reportCSS + '</style>', '</head><body>', '<h1>👥 Staff Sales Report</h1>', '<div class="sub">Period: ' + dateLabel + ' &nbsp;·&nbsp; Printed: ' + printedAt + '</div>', '<div class="summary">' + summaryCards + '</div>', '<table>', '<thead><tr>', '<th>Staff Member</th><th>Bills</th><th>Sales</th><th>Discount</th><th>Share</th>', '</tr></thead>', '<tbody>' + rows + emptyRow + '</tbody>', tfootRow, '</table>', '<div class="footer">Generated by Pharmacy POS · ' + printedAt + '</div>', '</body></html>'].join('\n');
    const w = window.open('', '_blank', 'width=800,height=700');
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch(e) {} }, 250); }
}
function _renderStaffReport(invoices) {
    const body = document.getElementById('staffReportBody'); if (!body) return;
    const cur = (typeof _getCurrency === 'function') ? _getCurrency() : 'Rs.';
    if (!invoices.length) { body.innerHTML = '<p style="color:#aaa;text-align:center;font-size:12px;padding:20px 0;">No invoices found for this period.</p>'; return; }
    const { sorted, totalSales, totalBills, totalDiscount } = _aggregateStaffSales(invoices);
    const COLORS = ['#0057b8','#1a7a4a','#b45309','#6d28d9','#c0392b','#0891b2','#be185d'];
    body.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
        <div style="background:#f4f4f5;border-radius:6px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#1e1e2e;">${totalBills}</div><div style="font-size:10px;color:#888;margin-top:2px;">Total Bills</div></div>
        <div style="background:#f0fdf4;border-radius:6px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#1a7a4a;">${cur}${totalSales.toFixed(0)}</div><div style="font-size:10px;color:#888;margin-top:2px;">Total Sales</div></div>
        <div style="background:#fef3c7;border-radius:6px;padding:10px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#b45309;">${cur}${totalDiscount.toFixed(0)}</div><div style="font-size:10px;color:#888;margin-top:2px;">Total Discount</div></div>
    </div>
    <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Per Staff</div>
    ${sorted.map(([name, v], idx) => {
        const pct = totalSales > 0 ? ((v.sales / totalSales) * 100).toFixed(1) : '0.0';
        const color = COLORS[idx % COLORS.length];
        const safeName = _escHtml(name);
        return `<div style="background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
                <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;flex-shrink:0;">${_escHtml(name.charAt(0).toUpperCase())}</div>
                <div class="sr-staff-info"><div style="font-size:13px;font-weight:800;color:#1e1e2e;">${safeName}</div><div style="font-size:10px;color:#888;">${v.count} invoice${v.count!==1?'s':''} · ${pct}% of sales</div></div>
                <div style="text-align:right;"><div style="font-size:14px;font-weight:800;color:${color};">${_escHtml(cur)}${v.sales.toFixed(2)}</div><div style="font-size:10px;color:#b45309;">-${_escHtml(cur)}${v.discount.toFixed(2)}</div></div>
            </div>
            <div style="background:#e5e7eb;border-radius:3px;height:4px;overflow:hidden;"><div style="height:100%;background:${color};width:${pct}%;border-radius:3px;"></div></div>
        </div>`;
    }).join('')}`;
}
