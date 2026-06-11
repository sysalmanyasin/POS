// =========================================================================
// config.js — Supabase config, device identity, shared REST helpers
// Phase 2: added relational table helpers (_dbInsert, _dbUpsert, _dbSelect,
//          _dbUpdate, _dbDelete) alongside the legacy pharma_sync KV helpers
//          (_supaGet/_supaSet/_supaDel) which remain for auth.js compatibility.
// =========================================================================

// ── Supabase connection ───────────────────────────────────────────────────
const _SUPA_URL = 'https://qkwwtetixyvhbtjmwnfv.supabase.co';
const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrd3d0ZXRpeHl2aGJ0am13bmZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODIwMzgsImV4cCI6MjA5NTc1ODAzOH0.a2C-cSACGseeDNA-78T2U2JCj5CaK3ouE4-cNnZmaCQ';

const _SUPA_HEADERS = {
    'apikey':        _SUPA_KEY,
    'Authorization': 'Bearer ' + _SUPA_KEY,
    'Content-Type':  'application/json'
};

// ── Legacy KV helpers (pharma_sync table) — kept for auth.js / synchub.js ──
// These are used by: auth.js (password hash, master setup PIN, device key),
// devices.js (commands), synchub.js (cloud KV sync).
// Do NOT remove until those modules are fully migrated in later phases.

async function _supaGet(key) {
    if (!key) return null;
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
    if (!key) return false;
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
    if (!key) return false;
    try {
        const r = await fetch(
            _SUPA_URL + '/rest/v1/pharma_sync?key=eq.' + encodeURIComponent(key),
            { method: 'DELETE', headers: _SUPA_HEADERS }
        );
        return r.ok;
    } catch(e) { return false; }
}

async function _supaProbe() {
    await _supaSet('__pharma_probe__', '1');
    try { await _supaDel('__pharma_probe__'); } catch(e) {}
}

// ── Relational table helpers ──────────────────────────────────────────────
// These target the new Phase 1 relational tables (devices, invoices,
// inventory, inventory_movements, settings, sync_log, invoice_items).
//
// All functions return { data, error } so callers can handle failures
// without try/catch boilerplate.

/**
 * SELECT rows from a table.
 * @param {string} table  — table name
 * @param {string} query  — PostgREST query string, e.g. "role=eq.master&is_active=eq.true"
 * @param {string} select — columns to return, default "*"
 */
async function _dbSelect(table, query = '', select = '*') {
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

/**
 * INSERT one or more rows.
 * @param {string} table   — table name
 * @param {object|Array} rows — row object or array of row objects
 */
/**
 * SELECT ALL rows from a table, paginating automatically to bypass
 * PostgREST's default 1000-row limit.  Required for large catalogues
 * (e.g. inventory with 30,000+ products).
 * @param {string} table    — table name
 * @param {string} query    — PostgREST filter string (no limit/offset — added internally)
 * @param {string} select   — columns to return, default "*"
 * @param {number} pageSize — rows per page, default 1000
 */
async function _dbSelectAll(table, query = '', select = '*', pageSize = 1000) {
    const allData = [];
    let offset = 0;
    while (true) {
        const pageQuery = [query, 'limit=' + pageSize, 'offset=' + offset]
            .filter(Boolean).join('&');
        const { data, error } = await _dbSelect(table, pageQuery, select);
        if (error) return { data: null, error };
        if (!data || data.length === 0) break;
        allData.push(...data);
        if (data.length < pageSize) break; // reached last page
        offset += pageSize;
    }
    return { data: allData, error: null };
}

async function _dbInsert(table, rows) {
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

/**
 * UPSERT one or more rows (insert or update on conflict).
 * @param {string} table   — table name
 * @param {object|Array} rows — row object or array of row objects
 * @param {string} onConflict — conflict column(s), default "uuid"
 */
async function _dbUpsert(table, rows, onConflict = 'uuid') {
    try {
        // FIX: PostgREST requires ?on_conflict=<column> in the URL to know which
        // column to use for the "merge-duplicates" upsert. Without it, PostgREST
        // on some Supabase versions silently falls back to INSERT-only, creating
        // duplicate rows instead of updating existing ones.
        // FIX: encodeURIComponent encodes commas as %2C, which breaks composite
        // conflict keys like 'invoice_number,product_code' — PostgREST does not
        // decode %2C back to a comma and treats the whole string as an unknown
        // column, causing the upsert to silently fail with a 400 error.
        // Fix: encode each column name individually, rejoin with a literal comma.
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

/**
 * UPDATE rows matching a PostgREST filter.
 * @param {string} table   — table name
 * @param {string} query   — PostgREST filter, e.g. "uuid=eq.abc-123"
 * @param {object} updates — fields to update
 */
async function _dbUpdate(table, query, updates) {
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

/**
 * DELETE rows matching a PostgREST filter.
 * @param {string} table — table name
 * @param {string} query — PostgREST filter, e.g. "uuid=eq.abc-123"
 */
async function _dbDelete(table, query) {
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

/**
 * INSERT rows, silently skipping any that already exist (ignore-duplicates).
 * Use for append-only tables like inventory_movements where upsert is not
 * needed and no UNIQUE constraint is guaranteed for on_conflict resolution.
 * @param {string} table   — table name
 * @param {object|Array} rows — row object or array of row objects
 */
async function _dbInsertIgnore(table, rows) {
    // Plain INSERT — no resolution= Prefer header.
    // resolution=ignore-duplicates and merge-duplicates both require a UNIQUE
    // constraint on the conflict column; without one PostgREST returns 400.
    // We handle 409 (duplicate key) as success since the row already exists.
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table, {
            method:  'POST',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'return=minimal' },
            body:    JSON.stringify(rows)
        });
        if (r.status === 409) return { data: [], error: null }; // already synced — fine
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            // Log full PostgREST error so schema mismatches are visible in console
            console.error('[_dbInsertIgnore] 400 detail:', err);
            return { data: null, error: err };
        }
        return { data: [], error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

// ── EmailJS config ────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = 'service_c46u9tr';
const EMAILJS_TEMPLATE_ID = 'template_nr8juhn';
const EMAILJS_PUBLIC_KEY  = 'JmP847vJN1MXxKRva';
const RESET_EMAIL_ADDRESS = 'sy.salmanmughal@gmail.com';

// ── Device identity ───────────────────────────────────────────────────────
// Immutable per-browser UUID, created once and persisted in localStorage.
// This is the primary key used in the devices table.

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

// ── _getDeviceCode (moved from billing.js so inventory.js can use it) ────
// Returns a short counter ID read from branch identity settings.
// Depends only on BRANCH_DEFAULTS and StorageModule — both defined above.
function _getDeviceCode() {
    try {
        const s = StorageModule.get('pharma_branch_identity');
        const bi = s ? Object.assign({}, BRANCH_DEFAULTS, JSON.parse(s)) : Object.assign({}, BRANCH_DEFAULTS);
        const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return raw.slice(0, 6) || 'DEV';
    } catch(e) { return 'DEV'; }
}

// ── Pakistan Standard Time (PKT = UTC+5) helpers ─────────────────────────
// All timestamps in this app are stored as UTC ISO strings in Supabase and
// local IndexedDB. These helpers ensure every displayed time is shown in
// PKT regardless of what timezone the browser's OS is set to.

const _PKT_TIMEZONE = 'Asia/Karachi';

/**
 * Format any Date (or UTC ISO string, or ms epoch) as a human-readable
 * PKT string, e.g. "11/6/2026, 2:11 PM".
 * Pass options to override the default date+time format.
 */
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

/**
 * Return a Date object adjusted so that calling .toISOString() on it
 * gives the wall-clock time in PKT expressed as if it were UTC.
 * Useful for splitting billed_at into a PKT-local date string (YYYY-MM-DD).
 *
 *   _pktDateStr(new Date())  →  '2026-06-11'  (PKT date, not UTC date)
 */
function _pktDateStr(dateOrStr) {
    try {
        const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
        if (isNaN(d.getTime())) return '';
        // Extract the date parts in PKT timezone
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            timeZone: _PKT_TIMEZONE
        }).format(d);           // gives "YYYY-MM-DD" in en-CA locale
        return parts;
    } catch(e) { return ''; }
}

/**
 * Return a "now" ISO string that is clock-offset adjusted AND represents
 * the actual wall time. Equivalent to new Date(Date.now() + _getClockOffset()).toISOString()
 * but centralised so every module uses the same source of truth.
 * The stored value is still UTC ISO (correct for Supabase timestamptz).
 */
function _nowISO() {
    try {
        const offset = (function() {
            try { const v = parseInt(localStorage.getItem('server_clock_offset_ms'), 10); return isNaN(v) ? 0 : v; } catch(e) { return 0; }
        })();
        return new Date(Date.now() + offset).toISOString();
    } catch(e) { return new Date().toISOString(); }
}

/**
 * Convenience: PKT display string for right now (used on receipts, held bills, etc.)
 * Returns e.g. "6/11/2026, 2:11 PM"
 */
function _nowPKTStr(options) {
    return _toPKT(new Date(), options);
}

/**
 * PKT time-only string, e.g. "2:11 PM" — used in held bill tags, clock display.
 */
function _nowPKTTimeStr() {
    return _toPKT(new Date(), { year: undefined, month: undefined, day: undefined,
        hour: 'numeric', minute: '2-digit', hour12: true });
}

