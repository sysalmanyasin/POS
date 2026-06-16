// =========================================================================
// config.js — Supabase config, device identity, shared REST helpers
// BYOS Edition: credentials read from localStorage so each pharmacy
// connects their own Supabase project. EmailJS keys also user-configured.
// =========================================================================

// ── Supabase connection — reads from localStorage (set by setup screen) ───
const _SUPA_URL = localStorage.getItem('pharma_supa_url') || '';
const _SUPA_KEY = localStorage.getItem('pharma_supa_key') || '';

const _SUPA_HEADERS = {
    'apikey':        _SUPA_KEY,
    'Authorization': 'Bearer ' + _SUPA_KEY,
    'Content-Type':  'application/json'
};

// ── Supabase available check ──────────────────────────────────────────────
function _isSupabaseConfigured() {
    return !!(localStorage.getItem('pharma_supa_url') && localStorage.getItem('pharma_supa_key'));
}

// ── Legacy KV helpers (pharma_sync table) — kept for auth.js / synchub.js ──
async function _supaGet(key) {
    if (!key || !_SUPA_URL) return null;
    try {
        const r = await fetch(
            _SUPA_URL + '/rest/v1/pharma_sync?key=eq.' + encodeURIComponent(key) + '&select=value',
            { headers: _SUPA_HEADERS }
        );
        if (!r.ok) return null;
        const rows = await r.json();
        return rows.length ? rows[0].value : null;
    } catch(e) { return null; }
}

async function _supaSet(key, value) {
    if (!key || !_SUPA_URL) return false;
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/pharma_sync', {
            method:  'POST',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'resolution=merge-duplicates' },
            body:    JSON.stringify({ key, value, updated_at: new Date().toISOString() })
        });
        return r.ok;
    } catch(e) { return false; }
}

async function _supaDel(key) {
    if (!key || !_SUPA_URL) return false;
    try {
        const r = await fetch(
            _SUPA_URL + '/rest/v1/pharma_sync?key=eq.' + encodeURIComponent(key),
            { method: 'DELETE', headers: _SUPA_HEADERS }
        );
        return r.ok;
    } catch(e) { return false; }
}

async function _supaProbe() {
    if (!_SUPA_URL) return;
    await _supaSet('__pharma_probe__', '1');
    try { await _supaDel('__pharma_probe__'); } catch(e) {}
}

// ── Relational table helpers ──────────────────────────────────────────────
async function _dbSelect(table, query = '', select = '*') {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    try {
        const qs = [select ? 'select=' + select : '', query].filter(Boolean).join('&');
        const r  = await fetch(_SUPA_URL + '/rest/v1/' + table + (qs ? '?' + qs : ''), {
            headers: _SUPA_HEADERS
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        return { data: await r.json(), error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

async function _dbSelectAll(table, query = '', select = '*', pageSize = 1000) {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    const allData = [];
    let offset = 0;
    while (true) {
        const pageQuery = [query, 'limit=' + pageSize, 'offset=' + offset]
            .filter(Boolean).join('&');
        const { data, error } = await _dbSelect(table, pageQuery, select);
        if (error) return { data: null, error };
        if (!data || data.length === 0) break;
        allData.push(...data);
        if (data.length < pageSize) break;
        offset += pageSize;
    }
    return { data: allData, error: null };
}

async function _dbInsert(table, rows) {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table, {
            method:  'POST',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'return=representation' },
            body:    JSON.stringify(rows)
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        return { data: await r.json(), error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

async function _dbUpsert(table, rows, onConflict = 'uuid') {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    try {
        const encodedConflict = onConflict
            .split(',')
            .map(c => encodeURIComponent(c.trim()))
            .join(',');
        const url = _SUPA_URL + '/rest/v1/' + table +
                    (onConflict ? '?on_conflict=' + encodedConflict : '');
        const r = await fetch(url, {
            method:  'POST',
            headers: {
                ..._SUPA_HEADERS,
                'Prefer': 'resolution=merge-duplicates,return=representation'
            },
            body: JSON.stringify(rows)
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        return { data: await r.json(), error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

async function _dbUpdate(table, query, updates) {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table + '?' + query, {
            method:  'PATCH',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'return=representation' },
            body:    JSON.stringify(updates)
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        return { data: await r.json(), error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

async function _dbDelete(table, query) {
    if (!_SUPA_URL) return { data: null, error: 'No database configured' };
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table + '?' + query, {
            method:  'DELETE',
            headers: _SUPA_HEADERS
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        return { data: true, error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

async function _dbInsertIgnore(table, rows) {
    if (!_SUPA_URL) return { data: [], error: null };
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table, {
            method:  'POST',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'return=minimal' },
            body:    JSON.stringify(rows)
        });
        if (r.status === 409) return { data: [], error: null };
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            console.error('[_dbInsertIgnore] 400 detail:', err);
            return { data: null, error: err };
        }
        return { data: [], error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

// ── EmailJS config — reads from localStorage (set by setup screen) ────────
const EMAILJS_SERVICE_ID  = localStorage.getItem('pharma_emailjs_service_id')  || '';
const EMAILJS_TEMPLATE_ID = localStorage.getItem('pharma_emailjs_template_id') || '';
const EMAILJS_PUBLIC_KEY  = localStorage.getItem('pharma_emailjs_public_key')  || '';
const RESET_EMAIL_ADDRESS = localStorage.getItem('pharma_emailjs_reset_email') || '';

// ── Device identity ───────────────────────────────────────────────────────
function _getOrCreateDeviceId() {
    const KEY = 'pharma_device_id';
    let id;
    try { id = localStorage.getItem(KEY); } catch(e) {}
    if (!id) {
        try {
            id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
               ? crypto.randomUUID()
               : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                     const r = Math.random() * 16 | 0;
                     return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                 });
        } catch(e) { id = 'dev-' + Date.now(); }
        try { localStorage.setItem(KEY, id); } catch(e) {}
    }
    return id;
}

const _DEVICE_UUID = _getOrCreateDeviceId();

// ── Shared helpers ────────────────────────────────────────────────────────
function _getCurrency() {
    return (typeof StorageModule !== 'undefined'
        ? StorageModule.get('pharma_currency', 'Rs.')
        : localStorage.getItem('pharma_currency') || 'Rs.') || 'Rs.';
}

function _getDeviceCode() {
    try {
        const s = StorageModule.get('pharma_branch_identity');
        const bi = s ? Object.assign({}, BRANCH_DEFAULTS, JSON.parse(s)) : Object.assign({}, BRANCH_DEFAULTS);
        const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return raw.slice(0, 6) || 'DEV';
    } catch(e) { return 'DEV'; }
}

// ── Pakistan Standard Time (PKT = UTC+5) helpers ─────────────────────────
const _PKT_TIMEZONE = 'Asia/Karachi';

function _toPKT(dateOrStr, options) {
    try {
        const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
        if (isNaN(d.getTime())) return String(dateOrStr || '');
        return d.toLocaleString('en-PK', Object.assign({
            year:   'numeric',
            month:  'numeric',
            day:    'numeric',
            hour:   'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: _PKT_TIMEZONE
        }, options || {}));
    } catch(e) { return String(dateOrStr || ''); }
}

function _pktDateStr(dateOrStr) {
    try {
        const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
        if (isNaN(d.getTime())) return '';
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            timeZone: _PKT_TIMEZONE
        }).format(d);
        return parts;
    } catch(e) { return ''; }
}

function _nowISO() {
    try {
        const offset = (function() {
            try { const v = parseInt(localStorage.getItem('server_clock_offset_ms'), 10); return isNaN(v) ? 0 : v; } catch(e) { return 0; }
        })();
        return new Date(Date.now() + offset).toISOString();
    } catch(e) { return new Date().toISOString(); }
}

function _nowPKTStr(options) {
    return _toPKT(new Date(), options);
}

function _nowPKTTimeStr() {
    return _toPKT(new Date(), { year: undefined, month: undefined, day: undefined,
        hour: 'numeric', minute: '2-digit', hour12: true });
}
