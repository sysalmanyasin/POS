// =========================================================================
// config.js — Supabase config, device identity, Lamport clock, REST helpers
// FIX Bug 9: Lamport timestamp engine added — every mutation uses a logical
//            sequence counter instead of Date.now() to survive clock skew.
// =========================================================================

// ── Supabase connection ───────────────────────────────────────────────────
const _SUPA_URL = 'https://qkwwtetixyvhbtjmwnfv.supabase.co';
const _SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrd3d0ZXRpeHl2aGJ0am13bmZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODIwMzgsImV4cCI6MjA5NTc1ODAzOH0.a2C-cSACGseeDNA-78T2U2JCj5CaK3ouE4-cNnZmaCQ';

const _SUPA_HEADERS = {
    'apikey':        _SUPA_KEY,
    'Authorization': 'Bearer ' + _SUPA_KEY,
    'Content-Type':  'application/json'
};

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

// =========================================================================
// BUG 9 FIX — Lamport Logical Clock
// Monotonically increasing sequence counter, per device, survives clock skew.
// Every mutation must call _lamportNext() to get its sequence number.
// On pull from cloud, call _lamportMerge(serverSeq) to advance local clock.
// =========================================================================
const _LAMPORT_KEY = 'pharma_lamport_' + _DEVICE_UUID.slice(0, 8);

function _lamportRead() {
    try { return parseInt(localStorage.getItem(_LAMPORT_KEY) || '0', 10) || 0; } catch(e) { return 0; }
}

function _lamportNext() {
    const seq = _lamportRead() + 1;
    try { localStorage.setItem(_LAMPORT_KEY, String(seq)); } catch(e) {}
    return seq;
}

/** Advance local clock past a server sequence value (on sync pull). */
function _lamportMerge(serverSeq) {
    const local = _lamportRead();
    const next  = Math.max(local, Number(serverSeq) || 0) + 1;
    try { localStorage.setItem(_LAMPORT_KEY, String(next)); } catch(e) {}
    return next;
}

// =========================================================================
// Legacy KV helpers (pharma_sync table) — kept for auth.js / devices.js
// =========================================================================
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

async function _dbUpsert(table, rows, onConflict = 'uuid') {
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/' + table, {
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

// ── Supabase RPC helper ───────────────────────────────────────────────────
// BUG 7 FIX: Used to call atomic server-side functions like
// deduct_inventory_atomic so concurrent deltas merge instead of overwriting.
async function _dbRpc(fnName, params = {}) {
    try {
        const r = await fetch(_SUPA_URL + '/rest/v1/rpc/' + fnName, {
            method:  'POST',
            headers: { ..._SUPA_HEADERS, 'Prefer': 'return=representation' },
            body:    JSON.stringify(params)
        });
        if (!r.ok) {
            const err = await r.text().catch(() => r.statusText);
            return { data: null, error: err };
        }
        const text = await r.text();
        const data = text ? JSON.parse(text) : null;
        return { data, error: null };
    } catch(e) {
        return { data: null, error: e.message || String(e) };
    }
}

// ── EmailJS config ────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = 'service_c46u9tr';
const EMAILJS_TEMPLATE_ID = 'template_nr8juhn';
const EMAILJS_PUBLIC_KEY  = 'JmP847vJN1MXxKRva';
const RESET_EMAIL_ADDRESS = 'sy.salmanmughal@gmail.com';

// ── Shared helpers ────────────────────────────────────────────────────────
function _getCurrency() {
    return (typeof StorageModule !== 'undefined'
        ? StorageModule.get('pharma_currency', 'Rs.')
        : localStorage.getItem('pharma_currency') || 'Rs.') || 'Rs.';
}

function _getDeviceCode() {
    try {
        const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
        const raw = (bi.counterId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (raw) return raw.slice(0, 20);
    } catch(e) {}
    try {
        const stored = localStorage.getItem('pharma_device_counter_id') || '';
        if (stored) return stored.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 20);
    } catch(e) {}
    return 'DEV';
}

// ── requestIdleCallback polyfill (Bug 11) ─────────────────────────────────
window._ric = (typeof requestIdleCallback === 'function')
    ? requestIdleCallback
    : function(cb, opts) { return setTimeout(() => cb({ timeRemaining: () => 16, didTimeout: false }), opts && opts.timeout ? Math.min(opts.timeout, 16) : 16); };
