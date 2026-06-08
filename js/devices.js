// =========================================================================
// devices.js — Device Registry
// BUG 6 FIX:  Master purge cascades through all IDB stores, clears caches,
//             drops device row, and redirects to fresh setup screen.
// BUG 10 FIX: Server-authoritative master lease. A device can only hold
//             master privileges if it owns a valid, non-expired lease stored
//             in Supabase pharma_sync. On heartbeat failure or expiry → auto-
//             downgrade to client role.
// =========================================================================
const DevicesModule = (() => {

    // ── Constants ─────────────────────────────────────────────────────────
    const HEARTBEAT_MS    = 60_000;
    const COMMAND_POLL_MS = 15_000;
    const MAX_DEVICES     = 6;
    const COMMANDS_KEY    = 'pharma_commands';

    // BUG 10: Master lease — 5 minute window, refreshed every 4 minutes
    const MASTER_LEASE_KEY    = 'pharma_master_lease';
    const MASTER_LEASE_TTL_MS = 5 * 60 * 1000;   // 5 min lease duration
    const MASTER_LEASE_REFRESH_MS = 4 * 60 * 1000; // refresh every 4 min

    let _hbTimer   = null;
    let _pollTimer = null;
    let _started   = false;
    let _leaseRefreshTimer = null;

    // ── Relational table helpers ──────────────────────────────────────────

    async function _fetchAllDevices() {
        const { data, error } = await _dbSelect('devices', 'is_active=eq.true', '*');
        if (error) { console.warn('[DevicesModule] _fetchAllDevices:', error); return []; }
        return data || [];
    }

    async function _fetchMyDevice() {
        const { data, error } = await _dbSelect(
            'devices',
            'uuid=eq.' + encodeURIComponent(_DEVICE_UUID),
            '*'
        );
        if (error || !data || data.length === 0) return null;
        return data[0];
    }

    async function _masterExists() {
        const { data } = await _dbSelect('devices', 'role=eq.master&is_active=eq.true', 'uuid');
        return !!(data && data.length > 0);
    }

    async function _activeDeviceCount() {
        const { data } = await _dbSelect('devices', 'is_active=eq.true', 'uuid');
        return data ? data.length : 0;
    }

    // =========================================================================
    // BUG 10 FIX — Server-Authoritative Master Lease
    // A device may only act as master if it holds an UNEXPIRED lease record
    // in Supabase pharma_sync under MASTER_LEASE_KEY.
    // On any heartbeat failure or lease expiry → downgrade to client silently.
    // =========================================================================

    async function _acquireOrRefreshMasterLease() {
        const role = StorageModule.get('pharma_device_role');
        if (role !== 'master') return; // only master attempts lease acquisition

        const now        = Date.now();
        const expiresAt  = new Date(now + MASTER_LEASE_TTL_MS).toISOString();
        const leaseRecord = JSON.stringify({
            deviceUuid: _DEVICE_UUID,
            expiresAt,
            refreshedAt: new Date().toISOString()
        });

        try {
            // Check for an existing valid lease owned by another device
            const raw = await _supaGet(MASTER_LEASE_KEY);
            if (raw) {
                const existing = JSON.parse(raw);
                const expired  = new Date(existing.expiresAt).getTime() < now;
                if (!expired && existing.deviceUuid !== _DEVICE_UUID) {
                    // Another device holds a valid lease — downgrade this device
                    console.warn('[DevicesModule] Master lease held by another device. Downgrading to client.');
                    await _downgradeSelfToClient('lease_stolen');
                    return;
                }
            }
            // Acquire or refresh the lease for this device
            await _supaSet(MASTER_LEASE_KEY, leaseRecord);
        } catch(e) {
            // Network failure → safe downgrade (BUG 10 requirement)
            console.warn('[DevicesModule] Lease refresh failed — downgrading to client:', e.message);
            _downgradeSelfToClientLocally('network_failure');
        }
    }

    async function _validateMasterLease() {
        const role = StorageModule.get('pharma_device_role');
        if (role !== 'master') return true; // clients always valid
        try {
            const raw = await _supaGet(MASTER_LEASE_KEY);
            if (!raw) {
                _downgradeSelfToClientLocally('no_lease');
                return false;
            }
            const lease   = JSON.parse(raw);
            const expired = new Date(lease.expiresAt).getTime() < Date.now();
            if (expired || lease.deviceUuid !== _DEVICE_UUID) {
                console.warn('[DevicesModule] Lease invalid or expired. Downgrading to client.');
                await _downgradeSelfToClient('lease_expired');
                return false;
            }
            return true;
        } catch(e) {
            _downgradeSelfToClientLocally('validate_error');
            return false;
        }
    }

    async function _downgradeSelfToClient(reason) {
        StorageModule.set('pharma_device_role', 'client');
        try {
            await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(_DEVICE_UUID), { role: 'client' });
        } catch(e) {}
        if (typeof showToast === 'function')
            showToast('⚠️ Master lease lost (' + reason + '). Switched to client mode.');
    }

    function _downgradeSelfToClientLocally(reason) {
        StorageModule.set('pharma_device_role', 'client');
        if (typeof showToast === 'function')
            showToast('⚠️ Operating offline as client (' + reason + ').');
    }

    // ── Registration flow ─────────────────────────────────────────────────

    async function _registerOrUpdateDevice() {
        const isPostPurge = localStorage.getItem('pharma_post_purge') === '1';
        if (isPostPurge) {
            try { localStorage.removeItem('pharma_post_purge'); } catch(_e) {}
            _showRegistrationModal();
            return;
        }

        const myDevice = await _fetchMyDevice();
        if (!myDevice)            { _showRegistrationModal(); return; }
        if (!myDevice.is_active)  { _showDeregisteredModal(); return; }

        // Validate master lease on startup
        await _validateMasterLease();
        await _heartbeatUpdate();
    }

    function _showRegistrationModal() {
        const old = document.getElementById('deviceRegModal');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deviceRegModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:var(--white,#fff);border-radius:14px;padding:28px 24px;width:400px;max-width:94vw;box-shadow:0 24px 64px rgba(0,0,0,.4);">
                <div style="font-size:30px;text-align:center;margin-bottom:8px;">📱</div>
                <div style="font-size:16px;font-weight:800;text-align:center;margin-bottom:4px;">Register This Device</div>
                <div style="font-size:12px;color:var(--g500);text-align:center;margin-bottom:20px;line-height:1.5;">
                    Give this device a name and counter ID.<br>Role (Master / Client) is assigned automatically.
                </div>
                <label style="font-size:11px;font-weight:700;color:var(--g600);display:block;margin-bottom:4px;">Device Name</label>
                <input id="devRegNameInput" type="text" placeholder="e.g. Main Counter, Pharmacy Desk…"
                    style="width:100%;padding:10px 12px;border:1.5px solid var(--g300);border-radius:8px;font-size:13px;margin-bottom:14px;box-sizing:border-box;"
                    maxlength="40" autocomplete="off">
                <label style="font-size:11px;font-weight:700;color:var(--g600);display:block;margin-bottom:4px;">Counter ID</label>
                <input id="devRegCounterInput" type="text" placeholder="e.g. C-01, MAIN, POS-2…"
                    style="width:100%;padding:10px 12px;border:1.5px solid var(--g300);border-radius:8px;font-size:13px;margin-bottom:6px;box-sizing:border-box;"
                    maxlength="20" autocomplete="off">
                <div id="devRegErr" style="font-size:11px;color:var(--red);min-height:16px;margin-bottom:12px;"></div>
                <button id="devRegSaveBtn" onclick="DevicesModule._confirmRegistration()"
                    style="width:100%;padding:10px;background:var(--teal);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;">
                    ✅ Register Device
                </button>
            </div>`;
        document.body.appendChild(overlay);

        setTimeout(() => {
            const inp = document.getElementById('devRegNameInput');
            if (inp) {
                inp.focus();
                inp.addEventListener('keydown', e => {
                    if (e.key === 'Enter') {
                        const ci = document.getElementById('devRegCounterInput');
                        if (ci && !ci.value.trim()) ci.focus(); else DevicesModule._confirmRegistration();
                    }
                });
            }
            const ci = document.getElementById('devRegCounterInput');
            if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') DevicesModule._confirmRegistration(); });
        }, 120);
    }

    async function _confirmRegistration() {
        const nameEl    = document.getElementById('devRegNameInput');
        const counterEl = document.getElementById('devRegCounterInput');
        const errEl     = document.getElementById('devRegErr');
        const saveBtn   = document.getElementById('devRegSaveBtn');

        const name      = (nameEl?.value    || '').trim();
        const counterId = (counterEl?.value || '').trim();

        if (!name || name.length < 2) { if (errEl) errEl.textContent = 'Please enter a device name (at least 2 characters).'; return; }
        if (!counterId)               { if (errEl) errEl.textContent = 'Please enter a counter ID.'; return; }

        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Please wait…'; }
        if (errEl)   errEl.textContent = '';

        try {
            const count = await _activeDeviceCount();
            if (count >= MAX_DEVICES) {
                if (errEl) errEl.textContent = '❌ Maximum ' + MAX_DEVICES + ' devices allowed.';
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
                return;
            }

            const hasMaster = await _masterExists();
            const role      = hasMaster ? 'client' : 'master';
            const now       = new Date().toISOString();

            const row = { uuid: _DEVICE_UUID, name, counter_id: counterId, role, registered_at: now, last_seen_at: now, is_active: true };
            const { error } = await _dbUpsert('devices', row, 'uuid');
            if (error) {
                if (errEl) errEl.textContent = '❌ Registration failed: ' + error;
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
                return;
            }

            StorageModule.set('pharma_device_name', name);
            StorageModule.set('pharma_device_role', role);
            StorageModule.set('pharma_device_counter_id', counterId);

            try {
                const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
                bi.counterId = counterId;
                localStorage.setItem('pharma_branch_identity', JSON.stringify(bi));
            } catch(e) {}

            const overlay = document.getElementById('deviceRegModal');
            if (overlay) overlay.remove();

            if (typeof showToast === 'function')
                showToast('✅ Device "' + name + '" registered as ' + (role === 'master' ? '👑 Master' : '💻 Client') + '.');

            // BUG 10: acquire initial master lease right after registration
            if (role === 'master') {
                await _acquireOrRefreshMasterLease();
                if (typeof _checkAndInitMasterSetup === 'function')
                    setTimeout(() => _checkAndInitMasterSetup(), 800);
            }

            _startHeartbeat();
            _startCommandPoll();

        } catch(e) {
            if (errEl) errEl.textContent = '❌ Unexpected error: ' + (e.message || e);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
        }
    }

    function _showDeregisteredModal() {
        const old = document.getElementById('deviceDeregModal');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'deviceDeregModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:var(--white,#fff);border-radius:14px;padding:28px 24px;width:380px;max-width:94vw;box-shadow:0 24px 64px rgba(0,0,0,.4);text-align:center;">
                <div style="font-size:32px;margin-bottom:10px;">⛔</div>
                <div style="font-size:15px;font-weight:800;margin-bottom:8px;color:var(--red);">Device Removed</div>
                <div style="font-size:12px;color:var(--g600);margin-bottom:20px;line-height:1.5;">This device was removed by the master. Please re-register to continue.</div>
                <button onclick="DevicesModule._handleReRegistration()"
                    style="width:100%;padding:10px;background:var(--teal);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;">
                    🔄 Re-Register This Device
                </button>
            </div>`;
        document.body.appendChild(overlay);
    }

    async function _handleReRegistration() {
        const old = document.getElementById('deviceDeregModal');
        if (old) old.remove();
        _showRegistrationModal();
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    async function _heartbeatUpdate() {
        try {
            const now        = new Date().toISOString();
            const todayBills = (typeof savedInvoicesLedger !== 'undefined' && Array.isArray(savedInvoicesLedger))
                ? savedInvoicesLedger.filter(i => !i.isRefund && !i.is_refund && (i.date || '').startsWith(now.slice(0,10))).length
                : 0;

            await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(_DEVICE_UUID), {
                last_seen_at: now,
                today_bills:  todayBills
            });

            // BUG 10: Refresh master lease on every heartbeat
            await _acquireOrRefreshMasterLease();
        } catch(e) {
            console.warn('[DevicesModule] Heartbeat failed:', e.message);
            // BUG 10: on failure, downgrade to safe client role
            _downgradeSelfToClientLocally('heartbeat_failure');
        }
    }

    function _startHeartbeat() {
        if (_hbTimer) clearInterval(_hbTimer);
        _heartbeatUpdate();
        _hbTimer = setInterval(_heartbeatUpdate, HEARTBEAT_MS);
    }

    async function sendHeartbeatNow() {
        await _heartbeatUpdate();
    }

    // ── Command polling ───────────────────────────────────────────────────

    async function _pollCommands() {
        try {
            const raw = await _supaGet(COMMANDS_KEY);
            if (!raw) return;
            const commands = JSON.parse(raw);
            if (!Array.isArray(commands)) return;

            for (const cmd of commands) {
                if (cmd.targetDevice && cmd.targetDevice !== _DEVICE_UUID && cmd.targetDevice !== 'all') continue;
                await _handleCommand(cmd);
            }
        } catch(e) {
            console.warn('[DevicesModule] Command poll error:', e.message);
        }
    }

    async function _handleCommand(cmd) {
        const type = (cmd.type || '').toUpperCase();

        if (type === 'RELOAD') {
            if (typeof showToast === 'function') showToast('🔄 Remote reload command received…');
            setTimeout(() => location.reload(), 1500);
            return;
        }

        if (type === 'SYNC_NOW') {
            if (typeof syncOfflineQueue === 'function') syncOfflineQueue(_DEVICE_UUID).catch(() => {});
            return;
        }

        if (type === 'PURGE' || type === 'GLOBAL_PURGE') {
            // Verify admin auth before executing destructive operation
            const adminOk = await _verifyPurgeAuthority(cmd);
            if (!adminOk) {
                console.warn('[DevicesModule] Purge command rejected — auth failed.');
                return;
            }
            await _executePurgeCascade(type === 'GLOBAL_PURGE');
        }
    }

    async function _verifyPurgeAuthority(cmd) {
        // Commands must include a purge token that matches what was set by master
        if (!cmd.purgeToken) return false;
        try {
            const stored = await _supaGet('pharma_master_purge_token');
            return !!(stored && stored === cmd.purgeToken);
        } catch(e) { return false; }
    }

    // =========================================================================
    // BUG 6 FIX — Global Purge Cascade
    // 1. Verify authority (master only via purge token)
    // 2. Drop device row in Supabase
    // 3. Wipe all local IDB stores via StorageModule
    // 4. Clear all localStorage keys
    // 5. Release master lease
    // 6. Mark post-purge flag → registration modal on next load
    // 7. Redirect to bare setup screen
    // =========================================================================
    async function _executePurgeCascade(isGlobal) {
        if (typeof showToast === 'function') showToast('⚠️ Purge initiated. Please wait…');

        // 1. Drop this device's row from Supabase
        try {
            await _dbDelete('devices', 'uuid=eq.' + encodeURIComponent(_DEVICE_UUID));
        } catch(e) {
            console.warn('[Purge] Device row deletion failed (may already be gone):', e.message);
        }

        // 2. Release master lease if held
        try {
            const raw = await _supaGet(MASTER_LEASE_KEY);
            if (raw) {
                const lease = JSON.parse(raw);
                if (lease.deviceUuid === _DEVICE_UUID) await _supaDel(MASTER_LEASE_KEY);
            }
        } catch(e) {}

        // 3. If GLOBAL_PURGE — wipe cloud KV data (master only)
        if (isGlobal && StorageModule.get('pharma_device_role') === 'master') {
            try {
                const keysToWipe = [
                    'pharma_cloud_invoices', 'pharma_cloud_staff', 'pharma_cloud_settings',
                    'pharma_master_purge_token', 'pharma_cloud_device_registry',
                    'pharma_master_setup_pin', 'pharma_master_device_id'
                ];
                await Promise.allSettled(keysToWipe.map(k => _supaDel(k)));
                // Issue RELOAD command to all other devices
                await _supaSet(COMMANDS_KEY, JSON.stringify([{ type: 'RELOAD', targetDevice: 'all', issuedAt: new Date().toISOString() }]));
            } catch(e) {}
        }

        // 4. Wipe all IDB stores
        try { await StorageModule.purgeAllLocalData(); } catch(e) {}

        // 5. Clear ALL localStorage keys (complete reset)
        const keepKeys = []; // nothing survives a purge
        const allKeys = Object.keys(localStorage);
        allKeys.forEach(k => {
            if (!keepKeys.includes(k)) { try { localStorage.removeItem(k); } catch(e2) {} }
        });

        // 6. Mark post-purge so registration modal appears on reload
        try { localStorage.setItem('pharma_post_purge', '1'); } catch(e) {}

        // 7. Clear in-memory caches
        if (typeof masterInventoryDB !== 'undefined') {
            try { masterInventoryDB.length = 0; } catch(e) {}
        }
        if (typeof savedInvoicesLedger !== 'undefined') {
            try { savedInvoicesLedger.length = 0; } catch(e) {}
        }

        // 8. Stop timers
        if (_hbTimer)     clearInterval(_hbTimer);
        if (_pollTimer)   clearInterval(_pollTimer);
        if (_leaseRefreshTimer) clearInterval(_leaseRefreshTimer);

        if (typeof showToast === 'function') showToast('✅ Purge complete. Restarting…');
        setTimeout(() => { location.href = location.origin + location.pathname; }, 1500);
    }

    function _startCommandPoll() {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollCommands();
        _pollTimer = setInterval(_pollCommands, COMMAND_POLL_MS);
    }

    // ── Sync Hub / Telemetry ──────────────────────────────────────────────

    async function openDeviceTelemetryHub() {
        const devices = await _fetchAllDevices();
        const now     = Date.now();

        let rows = '';
        devices.forEach(d => {
            const diffMs  = d.last_seen_at ? (now - new Date(d.last_seen_at).getTime()) : null;
            const diffMin = diffMs !== null ? Math.floor(diffMs / 60000) : null;
            const status  = diffMin === null ? '❓' : diffMin < 2 ? '🟢' : diffMin < 10 ? '🟡' : '🔴';
            const role    = d.role === 'master' ? '👑 Master' : '💻 Client';
            rows += `<tr>
                <td>${status} ${_escHtml(d.name || d.uuid.slice(0,8))}</td>
                <td>${_escHtml(d.counter_id)}</td>
                <td>${role}</td>
                <td>${diffMin !== null ? diffMin + ' min ago' : 'never'}</td>
                <td>${d.today_bills || 0}</td>
                <td>${d.is_active ? '✅' : '❌'}</td>
            </tr>`;
        });

        const myRole = StorageModule.get('pharma_device_role');
        let purgeBtn = '';
        if (myRole === 'master') {
            purgeBtn = `<button onclick="DevicesModule._promptGlobalPurge()" style="
                margin-top:12px;padding:8px 16px;background:#b71c1c;color:#fff;border:none;
                border-radius:6px;font-size:11px;font-weight:800;cursor:pointer;">
                ⚠️ Global Purge (Master Only)
            </button>`;
        }

        const html = `<div style="position:fixed;inset:0;z-index:25000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;">
            <div style="background:var(--white);border-radius:12px;padding:24px;width:680px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.4);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <div style="font-size:16px;font-weight:800;">📡 Device Telemetry</div>
                    <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;">×</button>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:11px;">
                    <thead><tr style="background:var(--g100);">
                        <th style="padding:6px;text-align:left;">Device</th>
                        <th style="padding:6px;">Counter</th>
                        <th style="padding:6px;">Role</th>
                        <th style="padding:6px;">Last Seen</th>
                        <th style="padding:6px;">Bills</th>
                        <th style="padding:6px;">Active</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                ${purgeBtn}
            </div>
        </div>`;

        const el = document.createElement('div');
        el.innerHTML = html;
        document.body.appendChild(el.firstElementChild);
    }

    async function _promptGlobalPurge() {
        if (typeof showConfirmModal !== 'function') return;
        showConfirmModal(
            { title: '⚠️ Global Purge', subtitle: 'This will wipe ALL data across ALL devices. This action cannot be undone.' },
            async () => {
                const token = Math.random().toString(36).slice(2, 12).toUpperCase();
                try { await _supaSet('pharma_master_purge_token', token); } catch(e) {}
                await _executePurgeCascade(true);
            },
            null,
            'PURGE ALL DATA',
            true
        );
    }

    // ── Module startup ────────────────────────────────────────────────────

    async function start() {
        if (_started) return;
        _started = true;

        if (!navigator.onLine) {
            // Offline start: run from cached local role
            console.log('[DevicesModule] Starting offline — using cached role.');
            _startHeartbeat();
            _startCommandPoll();
            return;
        }

        await _registerOrUpdateDevice();
        _startHeartbeat();
        _startCommandPoll();
    }

    // ── Public API ────────────────────────────────────────────────────────
    return {
        start,
        sendHeartbeatNow,
        openDeviceTelemetryHub,
        _fetchAllDevices,
        _confirmRegistration,
        _handleReRegistration,
        _promptGlobalPurge,
        _executePurgeCascade
    };

})();

// Auto-start after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => DevicesModule.start().catch(e => console.warn('[DevicesModule] start error:', e)), 800);
});
