// =========================================================================
// devices.js — Device Registry  (Phase 2)
//
// Changes from previous version:
//   • All device reads/writes now target the relational `devices` table
//     via _dbSelect / _dbUpsert / _dbUpdate / _dbDelete (from config.js).
//     The old pharma_sync KV blob (pharma_devices key) is no longer used.
//   • Role is auto-assigned: if no master exists in the table → master,
//     otherwise → client.  The manual role-picker modal is removed.
//   • Registration collects device name AND counter ID (both required).
//   • Max 6 active devices enforced on registration.
//   • Master re-claim is a separate flow (triggered from Settings),
//     protected by the admin PIN via requestAdminAccess().
//   • Heartbeat PATCHes only last_seen_at (and today_bills / active_staff)
//     on the device's own row — no full list rewrite.
//   • Commands (PURGE / RELOAD / SYNC_NOW / GLOBAL_PURGE) are still polled
//     from the pharma_sync KV table via _supaGet (unchanged).
//
// Dependencies (must load before this file):
//   config.js   — _DEVICE_UUID, _dbSelect, _dbUpsert, _dbUpdate, _dbDelete,
//                 _supaGet, _supaSet, _supaDel
//   storage.js  — StorageModule
//   auth.js     — requestAdminAccess, _verifyPassword
//   ui.js       — _escHtml, showToast
//   settings.js — _getBranchIdentity
//   billing.js  — savedInvoicesLedger (for today_bills count)
// =========================================================================

const DevicesModule = (() => {

    // ── Constants ─────────────────────────────────────────────────────────
    const HEARTBEAT_MS   = 60_000;
    const COMMAND_POLL_MS = 15_000;
    const MAX_DEVICES    = 6;   // 1 master + 5 clients

    // Legacy KV keys still used for cross-device commands
    const COMMANDS_KEY   = 'pharma_commands';

    let _hbTimer   = null;
    let _pollTimer = null;
    let _started   = false;

    // ── Relational table helpers ──────────────────────────────────────────

    /** Fetch all active (non-deleted) devices from Supabase. */
    async function _fetchAllDevices() {
        const { data, error } = await _dbSelect('devices', 'is_active=eq.true', '*');
        if (error) { console.warn('[DevicesModule] _fetchAllDevices error:', error); return []; }
        return data || [];
    }

    /** Fetch this device's own row, or null if not registered. */
    async function _fetchMyDevice() {
        const { data, error } = await _dbSelect(
            'devices',
            'uuid=eq.' + encodeURIComponent(_DEVICE_UUID),
            '*'
        );
        if (error || !data || data.length === 0) return null;
        return data[0];
    }

    /** Check whether a master device already exists in the table. */
    async function _masterExists() {
        const { data } = await _dbSelect(
            'devices',
            'role=eq.master&is_active=eq.true',
            'uuid'
        );
        return !!(data && data.length > 0);
    }

    /** Count all active devices. */
    async function _activeDeviceCount() {
        const { data } = await _dbSelect('devices', 'is_active=eq.true', 'uuid');
        return data ? data.length : 0;
    }

    // ── Registration flow ─────────────────────────────────────────────────

    /**
     * Called on startup. Checks if this device is already registered.
     * If yes → heartbeat. If no → show registration modal.
     * If deregistered (is_active = false) → show re-registration prompt.
     */
    async function _registerOrUpdateDevice() {
        // POST-PURGE GUARD: if a global purge just ran on this device (issuing OR remote),
        // force the registration modal regardless of what the cloud devices table contains.
        // This handles the case where the Supabase DELETE on the devices table failed
        // silently (missing RLS policy / grant), leaving a stale row that would otherwise
        // cause a heartbeat instead of re-registration.
        const isPostPurge = localStorage.getItem('pharma_post_purge') === '1';
        if (isPostPurge) {
            try { localStorage.removeItem('pharma_post_purge'); } catch(_e) {}
            _showRegistrationModal();
            return;
        }

        const myDevice = await _fetchMyDevice();

        if (!myDevice) {
            // Brand new device on this browser
            _showRegistrationModal();
            return;
        }

        if (!myDevice.is_active) {
            // Device was removed by master → prompt re-registration
            _showDeregisteredModal();
            return;
        }

        // Already registered and active — just heartbeat
        await _heartbeatUpdate();
    }

    /**
     * Registration modal — collects device name and counter ID,
     * then auto-assigns role and writes to devices table.
     */
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
                        if (ci && !ci.value.trim()) { ci.focus(); } else { DevicesModule._confirmRegistration(); }
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

        if (!name || name.length < 2) {
            if (errEl) errEl.textContent = 'Please enter a device name (at least 2 characters).';
            return;
        }
        if (!counterId || counterId.length < 1) {
            if (errEl) errEl.textContent = 'Please enter a counter ID.';
            return;
        }

        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Please wait…'; }
        if (errEl)   errEl.textContent = '';

        try {
            // Enforce max device limit
            const count = await _activeDeviceCount();
            if (count >= MAX_DEVICES) {
                if (errEl) errEl.textContent = `❌ Maximum ${MAX_DEVICES} devices allowed. Ask the master to remove a device first.`;
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
                return;
            }

            // Auto-assign role
            const hasMaster = await _masterExists();
            const role = hasMaster ? 'client' : 'master';

            const now = new Date().toISOString();
            const row = {
                uuid:          _DEVICE_UUID,
                name:          name,
                counter_id:    counterId,
                role:          role,
                registered_at: now,
                last_seen_at:  now,
                is_active:     true
            };

            const { error } = await _dbUpsert('devices', row, 'uuid');
            if (error) {
                if (errEl) errEl.textContent = '❌ Registration failed: ' + error;
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
                return;
            }

            // Persist role and name locally for quick access
            StorageModule.set('pharma_device_name', name);
            StorageModule.set('pharma_device_role', role);
            StorageModule.set('pharma_device_counter_id', counterId);

            // Also update pharma_branch_identity counter so billing uses the same ID
            try {
                const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
                bi.counterId = counterId;
                localStorage.setItem('pharma_branch_identity', JSON.stringify(bi));
            } catch(e) {}

            const overlay = document.getElementById('deviceRegModal');
            if (overlay) overlay.remove();

            const roleLabel = role === 'master' ? '👑 Master' : '💻 Client';
            if (typeof showToast === 'function') {
                showToast(`✅ Device "${name}" registered as ${roleLabel}.`);
            }

            // If this is the first master device, trigger master setup flow
            if (role === 'master' && typeof _checkAndInitMasterSetup === 'function') {
                setTimeout(() => _checkAndInitMasterSetup(), 800);
            }

        } catch(e) {
            if (errEl) errEl.textContent = '❌ Unexpected error: ' + (e.message || e);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Register Device'; }
        }
    }

    /**
     * Shown when a device that was previously deregistered (is_active=false)
     * opens the app. Offers re-registration as a new client.
     */
    function _showDeregisteredModal() {
        const old = document.getElementById('deviceDeregModal');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deviceDeregModal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:var(--white,#fff);border-radius:14px;padding:28px 24px;width:380px;max-width:94vw;box-shadow:0 24px 64px rgba(0,0,0,.4);">
                <div style="font-size:30px;text-align:center;margin-bottom:8px;">⛔</div>
                <div style="font-size:15px;font-weight:800;text-align:center;margin-bottom:6px;color:var(--red);">Device Removed</div>
                <div style="font-size:12px;color:var(--g500);text-align:center;margin-bottom:20px;line-height:1.5;">
                    This device was removed from the network by an administrator.<br>
                    You can re-register it as a new client device.
                </div>
                <button onclick="DevicesModule._reRegisterAfterRemoval()"
                    style="width:100%;padding:10px;background:var(--teal);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;margin-bottom:8px;">
                    🔄 Re-Register as Client
                </button>
                <div id="devDeregErr" style="font-size:11px;color:var(--red);min-height:16px;text-align:center;"></div>
            </div>`;
        document.body.appendChild(overlay);
    }

    async function _reRegisterAfterRemoval() {
        const errEl = document.getElementById('devDeregErr');
        if (errEl) errEl.textContent = 'Checking network…';
        try {
            // Clear local role so registration modal treats this as fresh
            StorageModule.remove('pharma_device_role');
            StorageModule.remove('pharma_device_name');
            const overlay = document.getElementById('deviceDeregModal');
            if (overlay) overlay.remove();
            _showRegistrationModal();
        } catch(e) {
            if (errEl) errEl.textContent = '❌ Error: ' + (e.message || e);
        }
    }

    // ── Master Re-Claim ───────────────────────────────────────────────────
    // Triggered from Settings → "Re-claim Master Role".
    // This does NOT purge anything — it only changes the role column.

    async function reclaimMasterRole() {
        requestAdminAccess('MASTER_RECLAIM', _DEVICE_UUID, '');
    }

    async function _doReclaimMasterRole() {
        try {
            const allDevices = await _fetchAllDevices();
            const now = new Date().toISOString();

            // Downgrade current master(s) to client
            for (const d of allDevices) {
                if (d.role === 'master' && d.uuid !== _DEVICE_UUID) {
                    await _dbUpdate(
                        'devices',
                        'uuid=eq.' + encodeURIComponent(d.uuid),
                        { role: 'client' }
                    );
                }
            }

            // Promote this device
            await _dbUpdate(
                'devices',
                'uuid=eq.' + encodeURIComponent(_DEVICE_UUID),
                { role: 'master', last_seen_at: now }
            );

            StorageModule.set('pharma_device_role', 'master');
            if (typeof showToast === 'function') showToast('👑 Master role claimed on this device.');

        } catch(e) {
            if (typeof showToast === 'function') showToast('❌ Re-claim failed: ' + (e.message || e), true);
        }
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    async function _heartbeatUpdate() {
        try {
            const todayBills  = _countTodayBills();
            const activeStaff = _getActiveStaffName();
            // FIX: Push today_bills and active_staff to the devices table on every heartbeat.
            // The schema has both columns (today_bills integer, active_staff text) — they were
            // previously commented out "no extra columns" in error.
            await _dbUpdate(
                'devices',
                'uuid=eq.' + encodeURIComponent(_DEVICE_UUID),
                {
                    last_seen_at: new Date().toISOString(),
                    today_bills:  todayBills,
                    active_staff: activeStaff || null
                }
            );
            // Keep local cache for dashboard display
            StorageModule.set('pharma_today_bills',  String(todayBills));
            StorageModule.set('pharma_active_staff', activeStaff || '');
        } catch(e) {
            console.warn('[DevicesModule] Heartbeat failed:', e);
        }
    }

    async function sendHeartbeatNow() {
        await _heartbeatUpdate();
    }

    function _countTodayBills() {
        try {
            const today  = new Date().toISOString().split('T')[0];
            const ledger = (typeof savedInvoicesLedger !== 'undefined') ? savedInvoicesLedger : [];
            return ledger.filter(inv => (inv.date || '').startsWith(today) && !inv.isRefund).length;
        } catch(e) { return 0; }
    }

    function _getActiveStaffName() {
        // FIX: Read from the authoritative `activeStaff` global set by settings.js,
        // not from the DOM label (which may not exist yet at page-load time).
        // Falls back to localStorage key set on login so reload sessions persist it.
        try {
            if (typeof activeStaff !== 'undefined' && activeStaff && activeStaff.name) {
                return activeStaff.name;
            }
        } catch(e) {}
        try {
            const stored = StorageModule.get('pharma_active_staff_name');
            return stored || '';
        } catch(e) { return ''; }
    }

    // ── Command polling (unchanged — still uses pharma_sync KV) ───────────
    // Commands are ephemeral broadcast/targeted payloads; they stay in KV
    // until synchub.js is migrated in a later phase.

    async function _pollCommands() {
        // Global purge broadcast
        try {
            const gpRaw = await _supaGet('pharma_global_purge_cmd');
            if (gpRaw) {
                const cmd         = JSON.parse(gpRaw);
                const now         = Date.now();
                const exp         = Number(cmd && cmd.expiresAt) || 0;
                const issuedBy    = cmd && cmd.issuedBy;
                const lastApplied = localStorage.getItem('pharma_global_purge_applied_at');
                const issuedAt    = String(Number(cmd && cmd.issuedAt) || 0);

                let issuerOk = (issuedBy === _DEVICE_UUID);
                if (!issuerOk && issuedBy) {
                    try {
                        const { data } = await _dbSelect(
                            'devices',
                            'uuid=eq.' + encodeURIComponent(issuedBy) + '&role=eq.master',
                            'uuid'
                        );
                        issuerOk = !!(data && data.length > 0);
                    } catch(_e) { issuerOk = false; }
                }

                if (issuerOk && exp >= now && lastApplied !== issuedAt) {
                    try { localStorage.setItem('pharma_global_purge_applied_at', issuedAt); } catch(_e) {}
                    await _executeCommand({ type: 'GLOBAL_PURGE', sentBy: issuedBy });
                    return;
                }
            }
        } catch(_e) {}

        // Cloud-wipe broadcast (DATA_WIPE) — wipes local data but keeps device registration
        try {
            const cwRaw = await _supaGet('pharma_cloud_wipe_cmd');
            if (cwRaw) {
                const cmd         = JSON.parse(cwRaw);
                const now         = Date.now();
                const exp         = Number(cmd && cmd.expiresAt) || 0;
                const issuedBy    = cmd && cmd.issuedBy;
                const issuedAt    = String(Number(cmd && cmd.issuedAt) || 0);
                const lastApplied = localStorage.getItem('pharma_cloud_wipe_applied_at');
                // Don't apply the wipe on the device that issued it (already processed)
                if (exp >= now && issuedBy !== _DEVICE_UUID && lastApplied !== issuedAt) {
                    try { localStorage.setItem('pharma_cloud_wipe_applied_at', issuedAt); } catch(_e) {}
                    await _executeCommand({ type: 'DATA_WIPE', sentBy: issuedBy });
                    return;
                }
            }
        } catch(_e) {}

        // Targeted commands
        try {
            const raw      = await _supaGet(COMMANDS_KEY);
            const commands = raw ? JSON.parse(raw) : [];
            const pending  = (Array.isArray(commands) ? commands : []).filter(c => {
                const target = c?.targetUUID || c?.target_uuid;
                return target === _DEVICE_UUID && !c.executed;
            });
            if (pending.length === 0) return;

            for (const cmd of pending) {
                await _executeCommand(cmd);
                cmd.executed   = true;
                cmd.executedAt = Date.now();
            }
            await _supaSet(COMMANDS_KEY, JSON.stringify(commands));
        } catch(e) { console.warn('[DevicesModule] Command poll failed:', e); }
    }

    async function _executeCommand(cmd) {
        const type = cmd?.type || cmd?.command;

        if (type === 'PURGE') {
            const sentByUUID = cmd?.sentBy || cmd?.sent_by || '';
            if (sentByUUID) {
                try {
                    const { data } = await _dbSelect(
                        'devices',
                        'uuid=eq.' + encodeURIComponent(sentByUUID) + '&role=eq.master',
                        'uuid'
                    );
                    if (!data || data.length === 0) {
                        console.warn('[DevicesModule] PURGE rejected — sender not master:', sentByUUID);
                        return;
                    }
                } catch(e) {
                    console.warn('[DevicesModule] Could not verify PURGE sender. Rejecting.');
                    return;
                }
            } else {
                console.warn('[DevicesModule] PURGE missing sentBy. Rejecting.');
                return;
            }
        }

        console.log('[DevicesModule] Executing command:', type);
        switch (type) {
            case 'PURGE': {
                if (typeof StorageModule !== 'undefined') StorageModule.clearAllPrimaryStores();
                const deviceId = localStorage.getItem('pharma_device_id');
                try {
                    Object.keys(localStorage).forEach(k => {
                        if (k !== 'pharma_device_id') { try { localStorage.removeItem(k); } catch(_e) {} }
                    });
                } catch(e) {}
                if (deviceId) { try { localStorage.setItem('pharma_device_id', deviceId); } catch(e) {} }
                try { localStorage.setItem('pharma_device_locked', 'true'); } catch(e) {}
                // Mark device as inactive in table
                try {
                    await _dbUpdate(
                        'devices',
                        'uuid=eq.' + encodeURIComponent(_DEVICE_UUID),
                        { is_active: false }
                    );
                } catch(_e) {}
                _showDeviceLockScreen();
                stop();
                break;
            }
            case 'RELOAD': {
                setTimeout(() => window.location.reload(), 1500);
                break;
            }
            case 'SYNC_NOW': {
                if (typeof StorageModule !== 'undefined') {
                    try { await StorageModule.syncFromCloudEngine(); } catch(e) {}
                }
                break;
            }
            case 'GLOBAL_PURGE': {
                console.warn('[DevicesModule] GLOBAL_PURGE received — wiping local data.');
                if (typeof StorageModule !== 'undefined' && typeof StorageModule.clearAllPrimaryStores === 'function') {
                    try { StorageModule.clearAllPrimaryStores(); } catch(_e) {}
                }
                try {
                    // Keep only device UUID and purge-applied dedup stamp.
                    // IMPORTANT: also strip sys_* keys (sys_has_password, sys_admin_pass_hash,
                    // sys_admin_pass) — without this they survive on remote devices and
                    // _migrateSecretsOnStartup pushes the old hash back to cloud,
                    // silently undoing the purge for ALL devices.
                    const keep = new Set(['pharma_device_id', 'pharma_global_purge_applied_at']);
                    Object.keys(localStorage).forEach(k => {
                        if (keep.has(k)) return;
                        if (k.startsWith('pharma_') || k.startsWith('sys_') ||
                            k === '_pharma_inv_fingerprint' || k === '_supabase_sync_on' ||
                            k === '_supabase_settings_ts') {
                            try { localStorage.removeItem(k); } catch(_e) {}
                        }
                    });
                    // Forces re-registration modal on next boot even if Supabase
                    // devices table DELETE silently failed (missing RLS grant).
                    localStorage.setItem('pharma_post_purge', '1');
                } catch(_e) {}
                try {
                    if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = [];
                    if (typeof temporaryHeldBills  !== 'undefined') temporaryHeldBills  = [];
                    if (typeof masterInventoryDB   !== 'undefined') masterInventoryDB   = [];
                    if (typeof activeCartItems     !== 'undefined') activeCartItems     = [];
                } catch(_e) {}
                stop();
                setTimeout(() => { try { window.location.reload(); } catch(_e) {} }, 2000);
                break;
            }
            case 'DATA_WIPE': {
                // Cloud Purge broadcast: wipe local data but keep device registration + auth keys
                console.warn('[DevicesModule] DATA_WIPE received — wiping local data (keeping registration).');
                // Stop sync engine first
                if (typeof StorageModule !== 'undefined') {
                    if (typeof StorageModule.clearAllPrimaryStores === 'function') StorageModule.clearAllPrimaryStores();
                    if (typeof StorageModule.clearAllQueues === 'function') StorageModule.clearAllQueues();
                    if (typeof StorageModule.setSyncEnabled === 'function') StorageModule.setSyncEnabled(false);
                }
                // Wipe IDB inventory + movements
                try {
                    if (typeof db !== 'undefined' && db) {
                        try { db.transaction(['inventory'], 'readwrite').objectStore('inventory').clear(); } catch(_e) {}
                        try { db.transaction(['inventory_movements'], 'readwrite').objectStore('inventory_movements').clear(); } catch(_e) {}
                    }
                } catch(_e) {}
                // Wipe localStorage — preserve device identity + auth
                try {
                    const keepKeys = new Set([
                        'pharma_device_id', 'pharma_device_name',
                        'pharma_device_role', 'pharma_device_counter_id',
                        'pharma_device_registered',
                        'sys_admin_pass_hash', 'sys_has_password', '_supabase_sync_on'
                    ]);
                    Object.keys(localStorage).forEach(k => {
                        if (keepKeys.has(k)) return;
                        if (k.startsWith('pharma_') || k.startsWith('sys_') ||
                            k === '_pharma_inv_fingerprint' || k === '_supabase_settings_ts') {
                            try { localStorage.removeItem(k); } catch(_e) {}
                        }
                    });
                } catch(_e) {}
                // Reset in-memory globals
                try {
                    if (typeof savedInvoicesLedger !== 'undefined') savedInvoicesLedger = [];
                    if (typeof temporaryHeldBills  !== 'undefined') temporaryHeldBills  = [];
                    if (typeof masterInventoryDB   !== 'undefined') masterInventoryDB   = [];
                    if (typeof activeCartItems     !== 'undefined') activeCartItems     = [];
                } catch(_e) {}
                stop();
                setTimeout(() => { try { window.location.reload(); } catch(_e) {} }, 2000);
                break;
            }
        }
    }

    // ── Lock screen (shown after PURGE command) ───────────────────────────

    function _showDeviceLockScreen() {
        const old = document.getElementById('deviceLockScreen');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'deviceLockScreen';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0a0a12;display:flex;flex-direction:column;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="text-align:center;max-width:360px;padding:24px;">
                <div style="font-size:56px;margin-bottom:16px;">🔒</div>
                <div style="font-size:18px;font-weight:800;color:#fff;margin-bottom:8px;">Device Deactivated</div>
                <div style="font-size:13px;color:#8090a8;margin-bottom:28px;line-height:1.6;">
                    This device has been deactivated by the system administrator.<br>
                    Enter the Master Password to unlock and re-register.
                </div>
                <div style="display:flex;justify-content:center;gap:10px;margin-bottom:16px;" id="lockDots">
                    ${[0,1,2,3,4,5,6,7].map(i => `<span class="pin-dot" style="background:#2a3550;" id="lockDot${i}"></span>`).join('')}
                </div>
                <div class="pin-pad" style="max-width:220px;margin:0 auto 12px;">
                    ${[1,2,3,4,5,6,7,8,9,'⌫',0,'✓'].map(k =>
                        `<button class="pin-btn" onclick="DevicesModule._lockPinKey('${k}')" style="background:#1a2540;color:#c8d8f0;border:1px solid #2a3550;font-size:18px;">${k}</button>`
                    ).join('')}
                </div>
                <div id="lockPinErr" style="font-size:11px;color:#ef5350;min-height:16px;margin-top:4px;"></div>
            </div>`;
        document.body.appendChild(overlay);
    }

    let _lockPin = '';
    async function _lockPinKey(k) {
        const overlay = document.getElementById('deviceLockScreen');
        if (!overlay) return;
        if (k === '⌫') { _lockPin = _lockPin.slice(0, -1); }
        else if (k === '✓') { await _doUnlock(); return; }
        else { if (_lockPin.length >= 8) return; _lockPin += k; }
        [0,1,2,3,4,5,6,7].forEach(i => {
            const d = document.getElementById('lockDot' + i);
            if (d) d.classList.toggle('filled', i < _lockPin.length);
        });
        if (_lockPin.length === 8) setTimeout(() => _doUnlock(), 180);
    }

    async function _doUnlock() {
        const errEl = document.getElementById('lockPinErr');
        const ok    = await _verifyPassword(_lockPin);
        _lockPin    = '';
        [0,1,2,3,4,5,6,7].forEach(i => {
            const d = document.getElementById('lockDot' + i);
            if (d) d.classList.remove('filled');
        });
        if (!ok) { if (errEl) errEl.textContent = '❌ Wrong password.'; return; }
        StorageModule.remove('pharma_device_locked');
        const overlay = document.getElementById('deviceLockScreen');
        if (overlay) overlay.remove();
        await _registerOrUpdateDevice();
    }

    // ── Send command to a specific device ─────────────────────────────────

    async function sendCommand(targetUUID, type, payload) {
        try {
            const raw      = await _supaGet(COMMANDS_KEY);
            const commands = raw ? JSON.parse(raw) : [];
            commands.push({
                id:         _DEVICE_UUID.slice(0, 8) + '_' + Date.now(),
                targetUUID,
                type,
                payload:    payload || {},
                sentAt:     Date.now(),
                expiresAt:  new Date(Date.now() + 24 * 3600_000).toISOString(),
                sentBy:     _DEVICE_UUID,
                executed:   false,
                executedAt: null
            });
            await _supaSet(COMMANDS_KEY, JSON.stringify(commands));
            if (typeof showToast === 'function') showToast('📨 Command "' + type + '" sent.');
        } catch(e) {
            console.error('[DevicesModule] sendCommand failed:', e);
            if (typeof showToast === 'function') showToast('❌ Command failed: ' + (e.message || e), true);
        }
    }

    // ── Dashboard UI ──────────────────────────────────────────────────────

    async function openDashboard() {
        const existing = document.getElementById('devicesDashboard');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'devicesDashboard';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.65);backdrop-filter:blur(5px);display:flex;align-items:flex-end;justify-content:center;';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        const box = document.createElement('div');
        box.id = 'devDashBox';
        box.style.cssText = 'background:var(--white,#fff);border-radius:18px 18px 0 0;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 -4px 40px rgba(0,0,0,.35);padding-bottom:env(safe-area-inset-bottom,0);';

        box.innerHTML = `
            <div style="position:sticky;top:0;background:var(--white,#fff);z-index:2;border-bottom:1px solid var(--g150,#eee);padding:16px 16px 10px;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                    <div>
                        <div style="font-size:15px;font-weight:800;">📱 Device Manager</div>
                        <div style="font-size:10px;color:var(--g500);margin-top:3px;line-height:1.4;">
                            All devices registered to this network.<br>Max ${MAX_DEVICES} devices (1 master + ${MAX_DEVICES - 1} clients).
                        </div>
                    </div>
                    <button onclick="document.getElementById('devicesDashboard').remove()"
                        style="flex-shrink:0;width:32px;height:32px;border:none;border-radius:50%;background:var(--g100);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--g600);">✕</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;">
                    ${[
                        { color:'#22c55e', label:'Online (<2 min)' },
                        { color:'#f59e0b', label:'Recent (<10 min)' },
                        { color:'#ef4444', label:'Offline' }
                    ].map(l => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--g600);">
                        <span style="width:8px;height:8px;border-radius:50%;background:${l.color};"></span>${l.label}
                    </span>`).join('')}
                </div>
            </div>
            <div id="devDashListWrap" style="padding:12px 16px 20px;">
                <div style="text-align:center;padding:24px;color:var(--g400);font-size:12px;">⏳ Loading devices…</div>
            </div>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        await _refreshDashboard();
    }

    async function _refreshDashboard() {
        const wrap = document.getElementById('devDashListWrap');
        if (!wrap) return;
        try {
            const devices = await _fetchAllDevices();
            if (!devices.length) {
                wrap.innerHTML = '<p style="color:var(--g400);text-align:center;padding:32px;font-size:12px;">No devices registered yet.</p>';
                return;
            }

            const now    = Date.now();
            const myUUID = _DEVICE_UUID;
            const myRole = StorageModule.get('pharma_device_role') || 'client';

            // Sort: master first, then by last_seen_at
            devices.sort((a, b) => {
                if (a.role === 'master' && b.role !== 'master') return -1;
                if (b.role === 'master' && a.role !== 'master') return  1;
                return new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0);
            });

            const renderCard = (d) => {
                const isMine   = d.uuid === myUUID;
                const isMaster = d.role === 'master';
                const seenMs   = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
                const ago      = now - seenMs;
                const isOnline = ago < 2 * 60_000;
                const isRecent = ago < 10 * 60_000;
                const dotColor = isOnline ? '#22c55e' : isRecent ? '#f59e0b' : '#ef4444';
                const seenMin  = seenMs ? Math.round(ago / 60000) : null;
                const agoStr   = seenMin === null ? 'Never'
                               : seenMin < 1      ? 'Just now'
                               : seenMin < 60     ? seenMin + ' min ago'
                               : seenMin < 1440   ? Math.round(seenMin / 60) + ' hr ago'
                               : Math.round(seenMin / 1440) + ' day(s) ago';
                const regDate  = d.registered_at ? new Date(d.registered_at).toLocaleDateString('en-PK') : '—';

                let cardBg     = 'background:var(--g50,#f8f9fa);';
                let cardBorder = 'border:1px solid var(--g200,#e2e5ea);';
                if (isMaster)  { cardBg = 'background:linear-gradient(135deg,#e8f0fe 0%,#f0f4ff 100%);'; cardBorder = 'border:2px solid #0057b8;'; }
                if (isMine)    { cardBg = isMaster ? 'background:linear-gradient(135deg,#e0f7ee 0%,#f0fff8 100%);' : 'background:linear-gradient(135deg,#e8faf1 0%,#f5fffa 100%);'; cardBorder = 'border:2px solid var(--teal,#00897b);'; }

                const roleBadge = isMaster
                    ? `<span style="background:#0057b8;color:#fff;font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px;">👑 MASTER</span>`
                    : `<span style="background:var(--g200);color:var(--g600);font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;">CLIENT</span>`;
                const myTag = isMine
                    ? `<span style="background:var(--teal);color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;">★ THIS DEVICE</span>`
                    : '';

                // Actions (master-only or non-self)
                const canManage = (myRole === 'master') && !isMine;
                const actionsHtml = canManage ? `
                    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
                        ${!isMaster ? `<button onclick="DevicesModule._setAsMaster('${_escHtml(d.uuid)}')"
                            style="flex:1;min-width:0;height:32px;padding:0 8px;background:#0057b8;color:#fff;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer;">👑 Set Master</button>` : ''}
                        <button onclick="DevicesModule.sendCommand('${_escHtml(d.uuid)}', 'SYNC_NOW')"
                            style="flex:1;min-width:0;height:32px;padding:0 8px;background:#1565c0;color:#fff;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer;">↻ Sync</button>
                        <button onclick="DevicesModule._removeDevice('${_escHtml(d.uuid)}')"
                            style="flex:1;min-width:0;height:32px;padding:0 8px;background:#b71c1c;color:#fff;border:none;border-radius:7px;font-size:10px;font-weight:700;cursor:pointer;">🗑 Remove</button>
                    </div>` : '';

                return `
                <div style="${cardBg}${cardBorder}border-radius:12px;padding:13px 14px;margin-bottom:10px;">
                    <div style="display:flex;align-items:flex-start;gap:9px;">
                        <span title="${isOnline ? 'Online' : isRecent ? 'Recent' : 'Offline'}"
                            style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};box-shadow:0 0 0 2px ${dotColor}33;flex-shrink:0;margin-top:3px;"></span>
                        <div style="flex:1;min-width:0;">
                            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-bottom:6px;">
                                <span style="font-weight:800;font-size:13px;color:var(--g900);">${_escHtml(d.name || d.uuid.slice(0, 8))}</span>
                                ${roleBadge}${myTag}
                            </div>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;">
                                <div style="font-size:10px;color:var(--g500);">🏪 Counter</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);">${_escHtml(d.counter_id || '—')}</div>
                                <div style="font-size:10px;color:var(--g500);">🕐 Last seen</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);">${_escHtml(agoStr)}</div>
                                <div style="font-size:10px;color:var(--g500);">📋 Today's Bills</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);">${typeof d.today_bills === 'number' ? d.today_bills : '—'}</div>
                                <div style="font-size:10px;color:var(--g500);">👤 Active Staff</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);">${_escHtml(d.active_staff || '—')}</div>
                                <div style="font-size:10px;color:var(--g500);">📅 Registered</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);">${_escHtml(regDate)}</div>
                                <div style="font-size:10px;color:var(--g500);">🔑 UUID</div>
                                <div style="font-size:10px;font-weight:700;color:var(--g800);font-family:monospace;">${_escHtml(d.uuid.slice(0, 8) + '…')}</div>
                            </div>
                            ${actionsHtml}
                        </div>
                    </div>
                </div>`;
            };

            let html = `<div style="font-size:11px;font-weight:800;color:var(--g700);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">
                🖥 Active Devices (${devices.length} / ${MAX_DEVICES})
            </div>`;
            html += devices.map(renderCard).join('');
            html += `<div style="text-align:center;margin-top:16px;">
                <button onclick="DevicesModule._refreshDashboard()"
                    style="height:32px;padding:0 18px;background:var(--g100);color:var(--g600);border:1px solid var(--g200);border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;">
                    ↻ Refresh
                </button>
            </div>`;

            wrap.innerHTML = html;
        } catch(e) {
            if (wrap) wrap.innerHTML = '<p style="color:var(--red);font-size:12px;padding:16px;">Error loading devices: ' + _escHtml(e.message || String(e)) + '</p>';
        }
    }

    // ── Dashboard actions ─────────────────────────────────────────────────

    async function _removeDevice(targetUUID) {
        requestAdminAccess('DEVICE_PURGE', targetUUID, '');
    }

    // Called by auth.js after admin verifies password for DEVICE_PURGE
    async function _doPurgeDevice(targetUUID) {
        try {
            await _dbUpdate(
                'devices',
                'uuid=eq.' + encodeURIComponent(targetUUID),
                { is_active: false }
            );
            await sendCommand(targetUUID, 'PURGE');
            if (typeof showToast === 'function') showToast('📨 Device removed and PURGE command sent.');
            await _refreshDashboard();
        } catch(e) {
            if (typeof showToast === 'function') showToast('❌ Remove failed: ' + (e.message || e), true);
        }
    }

    async function _setAsMaster(targetUUID) {
        requestAdminAccess('DEVICE_SET_MASTER', targetUUID);
    }

    // Called by auth.js after admin verifies password for DEVICE_SET_MASTER
    async function _doSetAsMaster(targetUUID) {
        try {
            // Downgrade current master(s)
            const all = await _fetchAllDevices();
            for (const d of all) {
                if (d.role === 'master' && d.uuid !== targetUUID) {
                    await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(d.uuid), { role: 'client' });
                }
            }
            await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(targetUUID), { role: 'master' });
            if (typeof showToast === 'function') showToast('👑 Device promoted to Master.');
            await _refreshDashboard();
        } catch(e) {
            if (typeof showToast === 'function') showToast('❌ Set master failed: ' + (e.message || e), true);
        }
    }

    // ── Telemetry Hub (mini popup from sync badge) ────────────────────────

    async function openDeviceTelemetryHub() {
        const existing = document.getElementById('deviceTelemetryHubOverlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'deviceTelemetryHubOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        const now     = Date.now();
        const devices = await _fetchAllDevices().catch(() => []);
        const myRole  = StorageModule.get('pharma_device_role') || 'client';
        const myName  = StorageModule.get('pharma_device_name') || _DEVICE_UUID.slice(0, 8);

        const online  = devices.filter(d => (now - new Date(d.last_seen_at || 0).getTime()) < 2 * 60_000).length;
        const recent  = devices.filter(d => { const a = now - new Date(d.last_seen_at || 0).getTime(); return a >= 2 * 60_000 && a < 10 * 60_000; }).length;
        const offline = devices.length - online - recent;

        const deviceRows = devices.map(d => {
            const ago    = now - new Date(d.last_seen_at || 0).getTime();
            const dot    = ago < 2 * 60_000 ? '#22c55e' : ago < 10 * 60_000 ? '#f59e0b' : '#ef4444';
            const agoStr = ago < 60_000 ? 'Just now' : ago < 3600_000 ? Math.floor(ago / 60_000) + ' min ago' : Math.floor(ago / 3600_000) + 'h ago';
            const isMe   = d.uuid === _DEVICE_UUID;
            return `<tr style="border-bottom:1px solid var(--g100);">
                <td style="padding:7px 8px;font-size:11px;">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot};margin-right:5px;"></span>
                    ${_escHtml(d.name || d.uuid.slice(0, 8))}
                    ${isMe ? '<span style="font-size:9px;background:var(--teal);color:#fff;padding:1px 5px;border-radius:4px;">You</span>' : ''}
                </td>
                <td style="padding:7px 8px;font-size:11px;text-align:center;">
                    <span style="background:${d.role === 'master' ? '#fef9c3' : '#e0f2fe'};color:${d.role === 'master' ? '#78350f' : '#0c4a6e'};padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;">${(d.role || 'client').toUpperCase()}</span>
                </td>
                <td style="padding:7px 8px;font-size:11px;color:var(--g600);">${agoStr}</td>
                <td style="padding:7px 8px;font-size:11px;color:var(--g700);">${_escHtml(d.counter_id || '—')}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="4" style="padding:16px;text-align:center;font-size:11px;color:var(--g400);">No devices found.</td></tr>';

        overlay.innerHTML = `
            <div style="background:var(--white,#fff);border-radius:16px;width:520px;max-width:96vw;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.4);">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid var(--g150);position:sticky;top:0;background:var(--white,#fff);z-index:2;">
                    <div>
                        <div style="font-size:14px;font-weight:800;">📡 Device Telemetry</div>
                        <div style="font-size:10px;color:var(--g400);margin-top:2px;">
                            This device: <strong>${_escHtml(myName)}</strong> ·
                            <span style="text-transform:uppercase;font-weight:700;color:${myRole === 'master' ? '#b45309' : '#0369a1'};">${myRole}</span>
                        </div>
                    </div>
                    <button onclick="document.getElementById('deviceTelemetryHubOverlay').remove()"
                        style="border:none;background:none;font-size:18px;cursor:pointer;color:var(--g500);padding:4px 8px;border-radius:6px;">✕</button>
                </div>
                <div style="padding:10px 18px;background:var(--g50);border-bottom:1px solid var(--g150);font-size:11px;color:var(--g600);">
                    <strong>${devices.length}</strong> devices · ${online} online · ${recent} recent · ${offline} offline
                </div>
                <div style="padding:12px 14px;">
                    <table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr style="border-bottom:2px solid var(--g150);">
                                <th style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--g500);text-align:left;">Device</th>
                                <th style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--g500);text-align:center;">Role</th>
                                <th style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--g500);">Last Seen</th>
                                <th style="padding:6px 8px;font-size:10px;font-weight:700;color:var(--g500);">Counter</th>
                            </tr>
                        </thead>
                        <tbody>${deviceRows}</tbody>
                    </table>
                </div>
                <div style="padding:12px 18px;border-top:1px solid var(--g150);display:flex;gap:8px;">
                    <button onclick="DevicesModule.openDashboard()"
                        style="padding:7px 14px;background:var(--teal);color:#fff;border:none;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;">📱 Full Device Manager</button>
                    <button onclick="DevicesModule._refreshTelemetry()"
                        style="padding:7px 14px;background:var(--g100);color:var(--g700);border:1px solid var(--g200);border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;">↻ Refresh</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
    }

    async function _refreshTelemetry() {
        const el = document.getElementById('deviceTelemetryHubOverlay');
        if (el) el.remove();
        await openDeviceTelemetryHub();
    }

    // ── Startup lock check ────────────────────────────────────────────────

    function checkStartupLock() {
        try {
            if (localStorage.getItem('pharma_device_locked') === 'true') {
                setTimeout(() => _showDeviceLockScreen(), 200);
                return true;
            }
        } catch(e) {}
        return false;
    }

    // ── Start / Stop ──────────────────────────────────────────────────────

    function start() {
        if (_started) return;
        _started = true;
        _heartbeatUpdate().catch(() => {});
        _hbTimer   = setInterval(() => _heartbeatUpdate().catch(() => {}),   HEARTBEAT_MS);
        _pollTimer = setInterval(() => _pollCommands().catch(() => {}),       COMMAND_POLL_MS);
    }

    function stop() {
        clearInterval(_hbTimer);
        clearInterval(_pollTimer);
        _started = false;
    }

    // ── Public API ────────────────────────────────────────────────────────
    return {
        start, stop,
        openDashboard,
        _refreshDashboard,
        openDeviceTelemetryHub,
        _refreshTelemetry,
        sendHeartbeatNow,
        sendCommand,
        checkStartupLock,
        reclaimMasterRole,
        _doReclaimMasterRole,
        _confirmRegistration,
        _reRegisterAfterRemoval,
        _lockPinKey,
        _removeDevice,
        _doPurgeDevice,
        _setAsMaster,
        _doSetAsMaster,
        _registerOrUpdateDevice,
        _fetchAllDevices,
        _fetchMyDevice
    };
})();

// ── Auto-start after DOM ready ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
    if (DevicesModule.checkStartupLock()) return;

    setTimeout(function () {
        if (StorageModule.get('_supabase_sync_on') === 'true') {
            DevicesModule.start();
            DevicesModule._registerOrUpdateDevice().catch(() => {});
        }
    }, 3500);
});

window.addEventListener('online', function () {
    setTimeout(function () {
        if (StorageModule.get('_supabase_sync_on') === 'true') {
            DevicesModule.start();
        }
    }, 3000);
});
