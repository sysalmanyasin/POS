// =========================================================================
// DROPBOX BACKUP — dropbox.js
// User-supplied App Key (PKCE / no client secret).
// Auto-backup every 10 min when enabled. Status bar toggle.
// =========================================================================

const _DBX_KEY_APPKEY   = 'pharma_dbx_app_key';
const _DBX_KEY_ACCESS   = 'pharma_dbx_access_token';
const _DBX_KEY_REFRESH  = 'pharma_dbx_refresh_token';
const _DBX_KEY_EXPIRY   = 'pharma_dbx_token_expiry';
const _DBX_KEY_VERIFIER = 'pharma_dbx_pkce_verifier';
const _DBX_KEY_AUTO     = 'pharma_dbx_auto_on';
const _DBX_KEY_LAST_UP  = 'pharma_dbx_last_upload';
const _DBX_BACKUP_PFX   = 'FDPP_BACKUP_';
const _DBX_AUTO_MS      = 10 * 60 * 1000; // 10 minutes

// ── Accessors ─────────────────────────────────────────────────────────────
function _dbxAppKey()      { return localStorage.getItem(_DBX_KEY_APPKEY)  || ''; }
function _dbxAccessTok()   { return localStorage.getItem(_DBX_KEY_ACCESS)  || ''; }
function _dbxRefreshTok()  { return localStorage.getItem(_DBX_KEY_REFRESH) || ''; }
function _dbxIsConnected() { return !!_dbxAccessTok() && !!_dbxAppKey(); }
function _dbxAutoOn()      { return localStorage.getItem(_DBX_KEY_AUTO) === 'true'; }

function _dbxSaveTokens(access, refresh, expiresIn) {
    localStorage.setItem(_DBX_KEY_ACCESS, access);
    if (refresh) localStorage.setItem(_DBX_KEY_REFRESH, refresh);
    const ms = expiresIn ? Date.now() + (Number(expiresIn) - 60) * 1000 : 0;
    localStorage.setItem(_DBX_KEY_EXPIRY, String(ms));
}

function _dbxTokenExpired() {
    const exp = parseInt(localStorage.getItem(_DBX_KEY_EXPIRY) || '0');
    return exp > 0 && Date.now() > exp;
}

function _dbxRedirectUri() {
    return window.location.origin + window.location.pathname;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────
function _dbxMakeVerifier() {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function _dbxMakeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ── Token refresh ─────────────────────────────────────────────────────────
async function _dbxRefreshAccessToken() {
    const appKey  = _dbxAppKey();
    const refresh = _dbxRefreshTok();
    if (!appKey || !refresh) return false;
    try {
        const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token', refresh_token: refresh, client_id: appKey
            })
        });
        if (!r.ok) return false;
        const d = await r.json();
        if (d.access_token) { _dbxSaveTokens(d.access_token, d.refresh_token || refresh, d.expires_in); return true; }
        return false;
    } catch(e) { return false; }
}

async function _dbxGetToken() {
    if (_dbxTokenExpired()) { if (!await _dbxRefreshAccessToken()) return null; }
    return _dbxAccessTok() || null;
}

// ── OAuth connect ─────────────────────────────────────────────────────────
async function dropboxConnect() {
    const appKey = _dbxAppKey();
    if (!appKey) {
        if (typeof showToast === 'function')
            showToast('⚠️ Enter your Dropbox App Key in Settings → Dropbox Backup first.', true);
        return;
    }
    const verifier  = _dbxMakeVerifier();
    const challenge = await _dbxMakeChallenge(verifier);
    localStorage.setItem(_DBX_KEY_VERIFIER, verifier);
    const p = new URLSearchParams({
        client_id: appKey, response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256',
        redirect_uri: _dbxRedirectUri(), token_access_type: 'offline',
        state: 'dropbox_oauth'
    });
    window.location.href = 'https://www.dropbox.com/oauth2/authorize?' + p.toString();
}

// ── Handle OAuth redirect callback (runs on every page load) ──────────────
async function dropboxHandleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (!code || state !== 'dropbox_oauth') return;

    history.replaceState({}, '', window.location.origin + window.location.pathname);

    const appKey   = _dbxAppKey();
    const verifier = localStorage.getItem(_DBX_KEY_VERIFIER) || '';
    if (!appKey || !verifier) {
        if (typeof showToast === 'function')
            showToast('❌ Dropbox: OAuth state lost — please try connecting again.', true);
        return;
    }
    localStorage.removeItem(_DBX_KEY_VERIFIER);

    try {
        const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code, grant_type: 'authorization_code',
                client_id: appKey, redirect_uri: _dbxRedirectUri(),
                code_verifier: verifier
            })
        });
        const d = await r.json();
        if (!r.ok || !d.access_token) {
            const msg = (d && d.error_description) || (d && d.error) || r.statusText;
            if (typeof showToast === 'function')
                showToast('❌ Dropbox connection failed: ' + msg, true);
            return;
        }
        _dbxSaveTokens(d.access_token, d.refresh_token, d.expires_in);
        _dbxUpdateUI();
        if (typeof showToast === 'function')
            showToast('✅ Dropbox connected! Auto-backup is now available.', false);
    } catch(e) {
        if (typeof showToast === 'function')
            showToast('❌ Dropbox token exchange failed: ' + (e.message || e), true);
    }
}

// ── Disconnect ────────────────────────────────────────────────────────────
function dropboxDisconnect() {
    [_DBX_KEY_ACCESS, _DBX_KEY_REFRESH, _DBX_KEY_EXPIRY, _DBX_KEY_VERIFIER]
        .forEach(k => localStorage.removeItem(k));
    _dbxUpdateUI();
    if (typeof showToast === 'function') showToast('Dropbox disconnected.', false);
}

// ── Upload backup ─────────────────────────────────────────────────────────
async function dropboxUploadBackup(silent) {
    if (!_dbxAppKey()) {
        if (!silent && typeof showToast === 'function')
            showToast('⚠️ Enter your Dropbox App Key in Settings first.', true);
        return;
    }
    if (!_dbxIsConnected()) {
        if (!silent && typeof showToast === 'function')
            showToast('⚠️ Connect to Dropbox first (Settings → Dropbox Backup).', true);
        return;
    }
    const token = await _dbxGetToken();
    if (!token) {
        if (!silent && typeof showToast === 'function')
            showToast('❌ Dropbox session expired — please reconnect.', true);
        _dbxUpdateUI(); return;
    }
    if (!silent && typeof showToast === 'function') showToast('☁️ Uploading backup to Dropbox…', false);
    try {
        const payload = typeof _buildBackupPayload === 'function' ? _buildBackupPayload()
            : { _meta: { app:'PharmaPOS', version:1, exportedAt: new Date().toISOString() } };
        if (typeof exportIndexedDB === 'function')
            payload.indexedDB = await exportIndexedDB();
        const json = JSON.stringify(payload);
        const now  = new Date();
        const pad  = n => String(n).padStart(2,'0');
        const fname = _DBX_BACKUP_PFX
            + now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate())
            + '_' + pad(now.getHours()) + '-' + pad(now.getMinutes()) + '.json';

        const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
                'Authorization':   'Bearer ' + token,
                'Content-Type':    'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({ path:'/' + fname, mode:'add', autorename:true })
            },
            body: json
        });
        if (!r.ok) { const err = await r.text().catch(() => r.statusText); throw new Error(err); }

        const result = await r.json();
        localStorage.setItem(_DBX_KEY_LAST_UP, String(Date.now()));
        if (typeof StorageModule !== 'undefined') StorageModule.set('pharma_last_backup_time', String(Date.now()));
        if (typeof updateBackupReminderBanner === 'function') updateBackupReminderBanner();
        _dbxUpdateUI();
        if (typeof showToast === 'function')
            showToast('✅ Dropbox backup saved: ' + (result.name || fname), false);
    } catch(e) {
        if (!silent && typeof showToast === 'function')
            showToast('❌ Dropbox upload failed: ' + (e.message || e), true);
    }
}

// ── List files ────────────────────────────────────────────────────────────
async function _dbxListBackups() {
    const token = await _dbxGetToken();
    if (!token) return null;
    try {
        const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
            method: 'POST',
            headers: { 'Authorization':'Bearer ' + token, 'Content-Type':'application/json' },
            body: JSON.stringify({ path:'', recursive:false })
        });
        if (!r.ok) return null;
        const d = await r.json();
        return (d.entries || [])
            .filter(f => f['.tag'] === 'file' && f.name.startsWith(_DBX_BACKUP_PFX))
            .sort((a,b) => b.server_modified.localeCompare(a.server_modified));
    } catch(e) { return null; }
}

// ── Restore a file ────────────────────────────────────────────────────────
async function dropboxRestoreFile(path) {
    const token = await _dbxGetToken();
    if (!token) {
        if (typeof showToast === 'function') showToast('❌ Dropbox session expired. Reconnect first.', true);
        return;
    }
    try {
        const r = await fetch('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: {
                'Authorization':   'Bearer ' + token,
                'Dropbox-API-Arg': JSON.stringify({ path })
            }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let payload;
        try { payload = JSON.parse(await r.text()); }
        catch(pe) { throw new Error('Not valid JSON.'); }
        if (!payload || !payload._meta) throw new Error('Invalid backup format.');

        const invCnt  = Array.isArray(payload.inventory)     ? payload.inventory.length     : '?';
        const invCnt2 = Array.isArray(payload.savedInvoices) ? payload.savedInvoices.length : '?';
        if (typeof showConfirmModal === 'function') {
            showConfirmModal(
                'Restore from Dropbox?\n\nFrom: ' + (payload._meta.exportedAt || 'unknown') +
                '\nBranch: ' + (payload._meta.branchName || 'N/A') +
                '\n' + invCnt2 + ' invoices · ' + invCnt + ' products' +
                '\n\n⚠️ This will replace ALL current data.',
                () => { if (typeof _performRestore === 'function') _performRestore(payload); },
                () => { if (typeof showToast === 'function') showToast('Restore cancelled.', false); },
                'Restore', true
            );
        } else {
            if (typeof _performRestore === 'function') _performRestore(payload);
        }
    } catch(e) {
        if (typeof showToast === 'function')
            showToast('❌ Restore failed: ' + (e.message || e), true);
    }
    closeDropboxRestoreModal();
}

// ── Restore modal ─────────────────────────────────────────────────────────
async function openDropboxRestoreModal() {
    if (!_dbxAppKey()) {
        if (typeof showToast === 'function') showToast('⚠️ Enter your App Key in Settings first.', true); return;
    }
    if (!_dbxIsConnected()) {
        if (typeof showToast === 'function') showToast('⚠️ Connect to Dropbox first.', true); return;
    }
    const modal = document.getElementById('dropboxRestoreModal');
    const list  = document.getElementById('dbxRestoreList');
    if (!modal || !list) return;
    list.innerHTML = '<div class="dbx-list-msg">⟳ Loading backups…</div>';
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('visible'));

    const files = await _dbxListBackups();
    if (!files) {
        list.innerHTML = '<div class="dbx-list-msg dbx-list-err">❌ Could not reach Dropbox. Check your connection.</div>';
        return;
    }
    if (files.length === 0) {
        list.innerHTML = '<div class="dbx-list-msg">No backups found yet.<br>Upload one first using "Backup to Dropbox".</div>';
        return;
    }
    list.innerHTML = files.map(f => {
        const date = f.server_modified ? new Date(f.server_modified).toLocaleString() : f.name;
        const sz   = f.size ? (f.size > 1048576
            ? (f.size/1048576).toFixed(1)+' MB' : (f.size/1024).toFixed(0)+' KB') : '';
        const path = _escHtml(f.path_lower || f.path_display || '/' + f.name);
        return `<div class="dbx-file-row" onclick="dropboxRestoreFile('${path}')">
          <span class="dbx-file-icon">📄</span>
          <span class="dbx-file-info">
            <span class="dbx-file-name">${_escHtml(f.name)}</span>
            <span class="dbx-file-meta">${date}${sz ? '  ·  '+sz : ''}</span>
          </span>
          <span class="dbx-file-action">Restore ›</span>
        </div>`;
    }).join('');
}

function closeDropboxRestoreModal() {
    const modal = document.getElementById('dropboxRestoreModal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 260);
}

// ── Auto-backup toggle ────────────────────────────────────────────────────
function dropboxToggleAuto() {
    const nowOn = !_dbxAutoOn();
    localStorage.setItem(_DBX_KEY_AUTO, nowOn ? 'true' : 'false');
    _dbxUpdateUI();
    if (typeof showToast === 'function')
        showToast(nowOn ? '✅ Dropbox auto-backup ON (every 10 min)' : '⚪ Dropbox auto-backup paused', false);
}

// ── Save App Key ──────────────────────────────────────────────────────────
function dropboxSaveAppKey() {
    const inp = document.getElementById('dbxAppKeyInput');
    if (!inp) return;
    const key = (inp.value || '').trim();
    if (!key) { if (typeof showToast === 'function') showToast('⚠️ App Key cannot be empty.', true); return; }
    localStorage.setItem(_DBX_KEY_APPKEY, key);
    [_DBX_KEY_ACCESS, _DBX_KEY_REFRESH, _DBX_KEY_EXPIRY].forEach(k => localStorage.removeItem(k));
    _dbxUpdateUI();
    if (typeof showToast === 'function') showToast('✅ App Key saved. Click "Connect Dropbox" to authorise.', false);
}

// ── Update ALL UI elements related to Dropbox ────────────────────────────
function _dbxUpdateUI() {
    const connected = _dbxIsConnected();
    const autoOn    = _dbxAutoOn();
    const lastUpTs  = localStorage.getItem(_DBX_KEY_LAST_UP);

    // Settings panel
    const badge      = document.getElementById('dbxStatusBadge');
    const connectBtn = document.getElementById('dbxConnectBtn');
    const disconnBtn = document.getElementById('dbxDisconnectBtn');
    const autoBtn    = document.getElementById('dbxAutoBtn');
    const autoLabel  = document.getElementById('dbxAutoLabel');
    const lastUpEl   = document.getElementById('dbxLastUpload');

    if (badge) {
        badge.textContent = connected ? '✅ Connected' : '⚪ Not connected';
        badge.className   = 'dbx-status-badge ' + (connected ? 'dbx-ok' : 'dbx-off');
    }
    if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
    if (disconnBtn) disconnBtn.style.display = connected ? '' : 'none';
    if (autoBtn) {
        autoBtn.textContent = autoOn ? 'ON' : 'OFF';
        autoBtn.className   = 'sett-toggle-btn ' + (autoOn ? 'sett-toggle-on' : 'sett-toggle-off');
        autoBtn.disabled    = !connected;
    }
    if (autoLabel) autoLabel.style.opacity = connected ? '1' : '.45';
    if (lastUpEl) {
        if (lastUpTs) {
            const diff = Math.floor((Date.now() - parseInt(lastUpTs)) / 60000);
            lastUpEl.textContent = diff < 1 ? 'Just now' : diff < 60 ? diff + ' min ago' : Math.floor(diff/60) + 'h ago';
        } else {
            lastUpEl.textContent = '—';
        }
    }

    // Status bar chip
    const sbChip  = document.getElementById('sbDbxChip');
    const sbState = document.getElementById('sbDbxState');
    if (sbChip) {
        sbChip.style.display = connected ? '' : 'none';
        if (sbState) sbState.textContent = autoOn ? 'AUTO' : 'OFF';
        sbChip.classList.toggle('dbx-chip-on',  connected && autoOn);
        sbChip.classList.toggle('dbx-chip-off', connected && !autoOn);
    }
}

// ── 10-minute auto-backup heartbeat ──────────────────────────────────────
setInterval(async () => {
    if (_dbxAutoOn() && _dbxIsConnected()) {
        await dropboxUploadBackup(true).catch(() => {});
        _dbxUpdateUI();
    }
}, _DBX_AUTO_MS);

// ── Init on page load ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    dropboxHandleCallback().catch(() => {});
    const inp = document.getElementById('dbxAppKeyInput');
    if (inp && _dbxAppKey()) inp.value = _dbxAppKey();
    _dbxUpdateUI();
});
