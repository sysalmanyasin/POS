// =========================================================================
// auditLog.js — Audit Log: write, view, export
// Stores every significant action in IDB store 'audit_log' (added in v6).
// Called by billing.js, auth.js, settings.js via AuditLog.write().
// =========================================================================

const AuditLog = (() => {

    // ── Action categories ─────────────────────────────────────────────────
    const CATEGORIES = {
        LOGIN:        { icon: '🔑', label: 'Login',        color: 'var(--blu)'    },
        LOGOUT:       { icon: '🚪', label: 'Logout',       color: 'var(--g500)'   },
        SALE:         { icon: '🧾', label: 'Sale',         color: 'var(--green)'  },
        REFUND:       { icon: '↩️',  label: 'Refund',       color: 'var(--red)'    },
        VOID:         { icon: '🚫', label: 'Void',         color: 'var(--red)'    },
        EDIT_INVOICE: { icon: '✏️',  label: 'Edit Invoice', color: 'var(--amber)'  },
        INVENTORY:    { icon: '📦', label: 'Inventory',    color: 'var(--teal)'   },
        SETTINGS:     { icon: '⚙️',  label: 'Settings',    color: 'var(--purple)' },
        STAFF:        { icon: '👤', label: 'Staff',        color: 'var(--purple)' },
        BACKUP:       { icon: '💾', label: 'Backup',       color: 'var(--teal)'   },
        PURGE:        { icon: '🗑',  label: 'Purge',        color: 'var(--red)'    },
        SYNC:         { icon: '🔄', label: 'Sync',         color: 'var(--blu)'    },
        SYSTEM:       { icon: '🖥',  label: 'System',       color: 'var(--g600)'   }
    };

    // ── IDB reference (shared from StorageModule) ─────────────────────────
    function _write(action, detail, staffName, extra) {
        const entry = {
            id:        Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            action:    action || 'SYSTEM',
            detail:    detail || '',
            staff:     staffName || StorageModule.get('pharma_active_staff_name') || 'System',
            device:    _DEVICE_UUID || '',
            ts:        new Date().toISOString(),
            extra:     extra || null
        };
        // Write via StorageModule
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.writeAuditLog === 'function') {
            StorageModule.writeAuditLog(entry);
        }
        // Mirror to sessionStorage for instant display without IDB read
        try {
            const recent = JSON.parse(sessionStorage.getItem('_audit_recent') || '[]');
            recent.unshift(entry);
            if (recent.length > 200) recent.pop();
            sessionStorage.setItem('_audit_recent', JSON.stringify(recent));
        } catch(e) {}
    }

    // ── View state ────────────────────────────────────────────────────────
    let _auditPage       = 1;
    const _AUDIT_PAGE_SZ = 50;
    let _auditFiltered   = [];
    let _auditAll        = [];
    let _filterCategory  = 'SALE';
    let _filterSearch    = '';
    let _filterStart     = '';
    let _filterEnd       = '';
    let _searchDebounce  = null;

    // ── Load & render ─────────────────────────────────────────────────────
    async function openAuditLogTab() {
        _auditPage = 1;
        // Merge IDB logs + session recent
        let idbLogs = [];
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.getAuditLogs === 'function') {
            idbLogs = await StorageModule.getAuditLogs(5000);
        }
        // Session fallback (covers entries written before IDB was ready)
        const recent = (() => {
            try { return JSON.parse(sessionStorage.getItem('_audit_recent') || '[]'); } catch(e) { return []; }
        })();
        const allById = new Map();
        [...idbLogs, ...recent].forEach(e => allById.set(e.id, e));
        _auditAll = [...allById.values()].sort((a, b) => b.ts.localeCompare(a.ts));
        _applyAuditFilters();
    }

    function _applyAuditFilters() {
        _filterCategory = document.getElementById('auditCatFilter')?.value  || 'SALE';
        _filterSearch   = (document.getElementById('auditSearchInp')?.value || '').toLowerCase().trim();
        _filterStart    = document.getElementById('auditStartDate')?.value   || '';
        _filterEnd      = document.getElementById('auditEndDate')?.value     || '';

        _auditFiltered = _auditAll.filter(e => {
            const date = (e.ts || '').slice(0, 10);
            if (_filterCategory !== 'all' && e.action !== _filterCategory) return false;
            if (_filterStart && date < _filterStart) return false;
            if (_filterEnd   && date > _filterEnd)   return false;
            if (_filterSearch) {
                const hay = [e.action, e.detail, e.staff, e.device].join(' ').toLowerCase();
                if (!hay.includes(_filterSearch)) return false;
            }
            return true;
        });

        _renderAuditTable();
    }

    function _renderAuditTable() {
        const tbody   = document.getElementById('auditLogBody');
        const countEl = document.getElementById('auditCount');
        const paginEl = document.getElementById('auditPaginInfo');
        if (!tbody) return;

        const total = _auditFiltered.length;
        const pages = Math.ceil(total / _AUDIT_PAGE_SZ) || 1;
        const start = (_auditPage - 1) * _AUDIT_PAGE_SZ;
        const slice = _auditFiltered.slice(start, start + _AUDIT_PAGE_SZ);

        if (countEl) countEl.textContent = total + ' event' + (total === 1 ? '' : 's');
        if (paginEl) paginEl.textContent = 'Page ' + _auditPage + ' of ' + pages;

        tbody.innerHTML = '';

        if (slice.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--g400);padding:24px;font-size:12px;">No audit events match the current filters.</td></tr>';
            _updateAuditPageBtns(pages);
            return;
        }

        const buildRow = (entry) => {
            const cat   = CATEGORIES[entry.action] || CATEGORIES.SYSTEM;
            const ts    = (entry.ts || '').slice(0, 19).replace('T', ' ');
            const extra = entry.extra ? ' <span style="font-size:10px;color:var(--g400);">' + _escHtml(JSON.stringify(entry.extra).slice(0, 60)) + '</span>' : '';
            const tr    = document.createElement('tr');
            tr.style.cssText = 'border-bottom:1px solid var(--g100);';
            tr.innerHTML = `
                <td style="padding:7px 10px;font-size:11px;color:var(--g500);white-space:nowrap;">${ts}</td>
                <td style="padding:7px 10px;">
                    <span class="audit-cat-badge" style="background:${cat.color}15;color:${cat.color};border:1px solid ${cat.color}33;padding:2px 7px;border-radius:99px;font-size:9px;font-weight:800;">${cat.icon} ${cat.label}</span>
                </td>
                <td style="padding:7px 10px;font-size:12px;">${_escHtml(entry.detail)}${extra}</td>
                <td style="padding:7px 10px;font-size:11px;color:var(--g600);">${_escHtml(entry.staff || '—')}</td>
                <td style="padding:7px 10px;font-size:10px;color:var(--g400);font-family:monospace;">${(entry.device || '').slice(0, 8)}</td>`;
            return tr;
        };

        if (typeof _renderChunked === 'function') {
            _renderChunked(slice, 20, (chunk) => {
                chunk.forEach(e => tbody.appendChild(buildRow(e)));
            }, () => _updateAuditPageBtns(pages));
        } else {
            slice.forEach(e => tbody.appendChild(buildRow(e)));
            _updateAuditPageBtns(pages);
        }
    }

    function _updateAuditPageBtns(pages) {
        const prev = document.getElementById('auditPrevBtn');
        const next = document.getElementById('auditNextBtn');
        if (prev) prev.disabled = _auditPage <= 1;
        if (next) next.disabled = _auditPage >= pages;
    }

    function auditPrevPage() { if (_auditPage > 1) { _auditPage--; _renderAuditTable(); } }
    function auditNextPage() {
        const pages = Math.ceil(_auditFiltered.length / _AUDIT_PAGE_SZ) || 1;
        if (_auditPage < pages) { _auditPage++; _renderAuditTable(); }
    }

    function onAuditSearch() {
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(() => { _auditPage = 1; _applyAuditFilters(); }, 220);
    }

    // ── Export ────────────────────────────────────────────────────────────
    function exportAuditCSV() {
        if (_auditAll.length === 0) { if (typeof showToast === 'function') showToast('No audit data to export.', true); return; }
        const lines = ['Timestamp,Action,Detail,Staff,Device'];
        _auditFiltered.forEach(e => {
            lines.push([
                e.ts,
                e.action,
                (e.detail || '').replace(/,/g, ';'),
                (e.staff  || '').replace(/,/g, ';'),
                (e.device || '').slice(0, 8)
            ].join(','));
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = 'audit_log_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        if (typeof showToast === 'function') showToast('✅ Audit log exported.');
    }

    // ── Build category dropdown options ───────────────────────────────────
    function buildCategorySelect() {
        const sel = document.getElementById('auditCatFilter');
        if (!sel) return;
        sel.innerHTML = '<option value="all">All Actions</option>' +
            Object.entries(CATEGORIES).map(([k, v]) =>
                `<option value="${k}">${v.icon} ${v.label}</option>`
            ).join('');
        sel.value = 'SALE'; // default to Sale
    }

    // ── Init ──────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        buildCategorySelect();
        const tab = document.getElementById('tab-auditlog');
        if (tab) tab.addEventListener('click', () => setTimeout(openAuditLogTab, 80));
        // Write system start event
        setTimeout(() => _write('SYSTEM', 'App started · device ' + (_DEVICE_UUID || '').slice(0, 8), 'System'), 1200);
    });

    return {
        write: _write,
        openAuditLogTab,
        applyFilters: _applyAuditFilters,
        auditPrevPage,
        auditNextPage,
        onAuditSearch,
        exportAuditCSV,
        CATEGORIES
    };
})();

// ── Global shorthand used by other modules ────────────────────────────────
function _auditWrite(action, detail, extra) {
    AuditLog.write(action, detail, null, extra);
}
