// =========================================================================
// auth.js — Authentication & Staff Management
// BUG 2 FIX:  Staff save now:
//   1. Hashes credentials with 'DUAPHARMA_v1_' prefix for passwords and
//      'FDPP_pin_' prefix for PINs (SHA-256 via SubtleCrypto).
//   2. Writes staff record to local IDB (via StorageModule KV).
//   3. Forces write-through upsert to Supabase pharma_sync KV table
//      (no relational staff table in schema — stored as JSON blob).
//   4. Operation gated to master device only (role check enforced).
// =========================================================================

// ── SHA-256 hashing ───────────────────────────────────────────────────────
async function _sha256(str) {
    const data = new TextEncoder().encode(str);
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// BUG 2 FIX: Use 'DUAPHARMA_v1_' prefix for master password hashing
async function _hashPassword(p) { return await _sha256('DUAPHARMA_v1_' + p); }
async function _hashPin(p)      { return await _sha256('FDPP_pin_' + p); }

// ── Password verify — cloud-first, local fallback ────────────────────────
async function _verifyPassword(entered) {
    try {
        const cloudHash = await _supaGet('pharma_master_password_hash');
        if (cloudHash) return (await _hashPassword(entered)) === cloudHash;
    } catch(e) {}
    const storedHash = StorageModule.get('sys_admin_pass_hash');
    if (storedHash) return (await _hashPassword(entered)) === storedHash;
    const plain = StorageModule.get('sys_admin_pass');
    if (plain) return entered === plain;
    return false;
}

// ── Password persist — always writes to cloud ─────────────────────────────
async function _persistPassword(hash) {
    try { await _supaSet('pharma_master_password_hash', hash); } catch(e) {}
    StorageModule.set('sys_admin_pass_hash', hash);
    StorageModule.remove('sys_admin_pass');
    StorageModule.set('sys_has_password', 'true');
}

// =========================================================================
// BUG 2 FIX — Staff Registration Engine
// Only the master device may create or modify staff records.
// Saves to: 1) localStorage (fast read), 2) IDB kv (persistent), 3) Supabase
// =========================================================================

const STAFF_CLOUD_KEY = 'pharma_cloud_staff';

/**
 * Load staff array from local storage (no cloud call — fast path).
 * @returns {Array} array of staff objects
 */
function _loadStaffLocal() {
    try {
        const raw = StorageModule.get(STAFF_CLOUD_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr;
        }
    } catch(e) {}
    return [];
}

/**
 * Save staff array locally and force write-through to Supabase cloud.
 * @param {Array} staff
 */
async function _saveStaffWriteThrough(staff) {
    const json = JSON.stringify(staff);
    // 1. Local write (sync, immediate)
    StorageModule.set(STAFF_CLOUD_KEY, json);
    // 2. Cloud write-through (async, required)
    try {
        const ok = await _supaSet(STAFF_CLOUD_KEY, json);
        if (!ok) console.warn('[auth] Staff cloud write returned false.');
    } catch(e) {
        console.error('[auth] Staff cloud write failed:', e.message);
        // Data is still safe locally; sync queue will retry
    }
}

/**
 * Pull staff list from cloud and merge into local store.
 * Called on startup and after any cloud sync.
 */
async function _syncStaffFromCloud() {
    try {
        const raw = await _supaGet(STAFF_CLOUD_KEY);
        if (!raw) return;
        const cloud = JSON.parse(raw);
        if (!Array.isArray(cloud)) return;
        StorageModule.set(STAFF_CLOUD_KEY, JSON.stringify(cloud));
    } catch(e) {
        console.warn('[auth] Staff cloud pull failed:', e.message);
    }
}

/**
 * Create or update a staff member.
 * BUG 2 FIX: Enforces master-only, hashes credentials, write-through to cloud.
 *
 * @param {object} staffData — { name, username, password, pin, role, permissions }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function saveStaffMember(staffData) {
    // Enforce master-only access
    const myRole = StorageModule.get('pharma_device_role');
    if (myRole !== 'master') {
        return { ok: false, error: 'Only the master device can manage staff.' };
    }

    if (!staffData.name || !staffData.username) {
        return { ok: false, error: 'Staff name and username are required.' };
    }

    const staff = _loadStaffLocal();

    // Check for duplicate username (unless updating existing record by same username)
    const existingIdx = staff.findIndex(s => s.username === staffData.username);

    // Hash credentials
    let passwordHash = null;
    let pinHash      = null;

    if (staffData.password) {
        try { passwordHash = await _hashPassword(staffData.password); }
        catch(e) { return { ok: false, error: 'Password hashing failed: ' + e.message }; }
    } else if (existingIdx >= 0 && staff[existingIdx].passwordHash) {
        // Keep existing hash if no new password provided
        passwordHash = staff[existingIdx].passwordHash;
    }

    if (staffData.pin) {
        if (!/^\d{4,6}$/.test(String(staffData.pin).trim())) {
            return { ok: false, error: 'PIN must be 4–6 digits.' };
        }
        try { pinHash = await _hashPin(String(staffData.pin).trim()); }
        catch(e) { return { ok: false, error: 'PIN hashing failed: ' + e.message }; }
    } else if (existingIdx >= 0 && staff[existingIdx].pinHash) {
        pinHash = staff[existingIdx].pinHash;
    }

    const staffId = (existingIdx >= 0 && staff[existingIdx].id)
        ? staff[existingIdx].id
        : (_DEVICE_UUID.slice(0, 8) + '_staff_' + Date.now());

    const record = {
        id:           staffId,
        name:         staffData.name.trim(),
        username:     staffData.username.trim().toLowerCase(),
        role:         staffData.role     || 'cashier',
        permissions:  staffData.permissions || { canRefund: false, canVoid: false, canEdit: false, canViewReports: false },
        passwordHash,
        pinHash,
        createdAt:    existingIdx >= 0 && staff[existingIdx].createdAt ? staff[existingIdx].createdAt : new Date().toISOString(),
        updatedAt:    new Date().toISOString(),
        deviceUuid:   _DEVICE_UUID
    };

    if (existingIdx >= 0) staff[existingIdx] = record;
    else                  staff.push(record);

    // Write-through: local + cloud
    await _saveStaffWriteThrough(staff);

    return { ok: true };
}

/**
 * Delete a staff member by username (master only).
 */
async function deleteStaffMember(username) {
    const myRole = StorageModule.get('pharma_device_role');
    if (myRole !== 'master') return { ok: false, error: 'Master only.' };

    const staff  = _loadStaffLocal();
    const before = staff.length;
    const updated = staff.filter(s => s.username !== username);
    if (updated.length === before) return { ok: false, error: 'Staff member not found.' };

    await _saveStaffWriteThrough(updated);
    return { ok: true };
}

/**
 * Verify staff login with PIN or password.
 * @returns {object|null} staff record on success, null on failure
 */
async function verifyStaffLogin(username, credential, isPin) {
    await _syncStaffFromCloud(); // refresh from cloud first
    const staff = _loadStaffLocal();
    const member = staff.find(s => s.username === username.toLowerCase());
    if (!member) return null;

    const hash    = isPin ? await _hashPin(String(credential).trim()) : await _hashPassword(credential);
    const stored  = isPin ? member.pinHash : member.passwordHash;
    if (!stored || hash !== stored) return null;
    return member;
}

// =========================================================================
// POST-PURGE MASTER DEVICE SETUP — EmailJS PIN Distribution
// =========================================================================
let _generatedMasterPin = '';
const _MASTER_SETUP_SUPABASE_KEY = 'pharma_master_setup_pin';
const _MASTER_DEVICE_KEY         = 'pharma_master_device_id';

async function _checkAndInitMasterSetup() {
    try {
        const { data } = await _dbSelect('devices', 'role=eq.master&is_active=eq.true', 'uuid');
        const masterIsOtherDevice = data && data.length > 0 && !data.find(r => r.uuid === _DEVICE_UUID);
        if (masterIsOtherDevice) { _showClientDeviceSetupModal(); return; }
        _showMasterDeviceSetupModal();
    } catch(e) {
        console.warn('[Master Setup] Devices check failed, falling back to KV:', e.message);
        try {
            const existingMasterId = await _supaGet(_MASTER_DEVICE_KEY);
            if (existingMasterId && existingMasterId !== _DEVICE_UUID) { _showClientDeviceSetupModal(); return; }
        } catch(_e) {}
        _showFirstLaunchPasswordSetup();
    }
}

function _showMasterDeviceSetupModal() {
    let modal = document.getElementById('masterDeviceSetupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'masterDeviceSetupModal';
        modal.innerHTML = `
<div class="master-setup-overlay" id="masterSetupOverlay">
  <div class="master-setup-card">
    <div class="master-setup-hdr">👑 Master Device Setup</div>
    <div class="master-setup-body">
      <div class="master-setup-step">This is the <strong>first device</strong> after system purge. It will become the <strong>Master Device</strong>.</div>
      <div class="master-setup-warning">⚠️ An 8-digit PIN will be sent to your email. Use it to set the master password.</div>
      <div class="master-setup-step"><strong>Email:</strong> ${RESET_EMAIL_ADDRESS || '(not configured)'}</div>
      <div class="master-setup-actions">
        <button class="master-setup-btn master-setup-btn-secondary" onclick="_closeMasterSetupModal()">Cancel</button>
        <button class="master-setup-btn master-setup-btn-primary" onclick="_sendMasterSetupPin()">📧 Send PIN to Email</button>
      </div>
      <div class="master-setup-status" id="masterSetupStatus"></div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    const st = document.getElementById('masterSetupStatus');
    if (st) st.textContent = '';
    modal.style.display = '';
}

function _closeMasterSetupModal() {
    const m = document.getElementById('masterDeviceSetupModal');
    if (m) m.style.display = 'none';
    _showFirstLaunchPasswordSetup();
}

async function _sendMasterSetupPin() {
    const statusEl = document.getElementById('masterSetupStatus');
    if (!RESET_EMAIL_ADDRESS || RESET_EMAIL_ADDRESS.includes('YOUR_')) { if (statusEl) { statusEl.textContent = '❌ Email address not configured.'; } return; }
    if (typeof emailjs === 'undefined') { if (statusEl) { statusEl.textContent = '❌ EmailJS not loaded.'; } return; }

    if (statusEl) statusEl.textContent = 'Generating PIN…';

    _generatedMasterPin = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt     = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    try {
        await _supaSet(_MASTER_SETUP_SUPABASE_KEY, JSON.stringify({
            pin: _generatedMasterPin, expiresAt, deviceId: _DEVICE_UUID, createdAt: new Date().toISOString()
        }));
        const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:      RESET_EMAIL_ADDRESS,
            reset_pin:     _generatedMasterPin,
            shop_name:     bi.businessName || bi.branchName || 'Pharma POS',
            counter_id:    bi.counterId || 'Master Device',
            expires_in:    '15 minutes',
            email_subject: '👑 Pharma POS Master Device Setup PIN'
        }, EMAILJS_PUBLIC_KEY);
        if (statusEl) { statusEl.textContent = '✅ PIN sent! Check your email.'; }
        setTimeout(() => _showMasterPinEntryModal(), 1500);
    } catch(err) {
        console.error('[Master Setup] PIN send failed:', err);
        if (statusEl) statusEl.textContent = '❌ Failed: ' + (err.message || 'Unknown error');
    }
}

function _showMasterPinEntryModal() {
    const m = document.getElementById('masterDeviceSetupModal');
    if (m) m.style.display = 'none';

    let modal = document.getElementById('masterPinEntryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'masterPinEntryModal';
        modal.innerHTML = `
<div class="master-pin-overlay">
  <div class="master-pin-card">
    <div class="master-pin-hdr">Enter Master Setup PIN</div>
    <div class="master-pin-body">
      <div class="master-pin-instruction">Enter the 8-digit PIN sent to your email to set the master password.</div>
      <input id="masterPinInput" type="text" maxlength="8" inputmode="numeric"
        style="width:100%;text-align:center;font-size:24px;font-weight:800;letter-spacing:8px;
               border:2px solid var(--g300);border-radius:8px;padding:10px;margin:16px 0;"
        placeholder="— — — — — — — —">
      <input id="masterNewPassInput" type="password"
        style="width:100%;border:1.5px solid var(--g300);border-radius:8px;padding:10px;font-size:14px;margin-bottom:8px;"
        placeholder="New master password">
      <div id="masterPinStatus" style="font-size:11px;color:var(--g500);min-height:18px;text-align:center;margin-bottom:12px;"></div>
      <div style="display:flex;gap:8px;">
        <button onclick="_closeMasterPinModal()" style="flex:1;padding:10px;border:1px solid var(--g300);border-radius:6px;background:var(--g100);font-size:12px;font-weight:700;cursor:pointer;">Cancel</button>
        <button onclick="_verifyMasterSetupPin()" style="flex:1;padding:10px;border:none;border-radius:6px;background:#059669;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">✅ Set Password</button>
      </div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = '';
    const inp = document.getElementById('masterPinInput');
    if (inp) inp.focus();
}

function _closeMasterPinModal() {
    const m = document.getElementById('masterPinEntryModal');
    if (m) m.style.display = 'none';
}

async function _verifyMasterSetupPin() {
    const statusEl = document.getElementById('masterPinStatus');
    const pinInp   = document.getElementById('masterPinInput');
    const passInp  = document.getElementById('masterNewPassInput');

    const enteredPin  = (pinInp?.value  || '').trim();
    const newPassword = (passInp?.value || '').trim();

    if (!enteredPin || enteredPin.length !== 8) { if (statusEl) statusEl.textContent = '❌ Please enter the 8-digit PIN.'; return; }
    if (!newPassword || newPassword.length < 6)  { if (statusEl) statusEl.textContent = '❌ Password must be at least 6 characters.'; return; }

    try {
        const raw = await _supaGet(_MASTER_SETUP_SUPABASE_KEY);
        if (!raw) { if (statusEl) statusEl.textContent = '❌ No PIN found. Request a new one.'; return; }
        const stored  = JSON.parse(raw);
        const expired = new Date(stored.expiresAt).getTime() < Date.now();
        if (expired)              { if (statusEl) statusEl.textContent = '❌ PIN expired. Request a new one.'; return; }
        if (stored.pin !== enteredPin) { if (statusEl) statusEl.textContent = '❌ Incorrect PIN.'; return; }

        // PIN valid — set master password
        const hash = await _hashPassword(newPassword);
        await _persistPassword(hash);
        await _supaSet(_MASTER_DEVICE_KEY, _DEVICE_UUID);
        await _supaDel(_MASTER_SETUP_SUPABASE_KEY);

        _closeMasterPinModal();
        if (typeof showToast === 'function') showToast('✅ Master password set successfully.');
    } catch(e) {
        if (statusEl) statusEl.textContent = '❌ Error: ' + (e.message || 'Unknown');
    }
}

function _showClientDeviceSetupModal() {
    if (typeof showToast === 'function')
        showToast('ℹ️ A master device already exists. Connect to sync master password.');
}

function _showFirstLaunchPasswordSetup() {
    // Delegate to settings.js password-set flow
    if (typeof toggleSettingsDrawer === 'function') {
        setTimeout(() => toggleSettingsDrawer(), 300);
    }
}

// =========================================================================
// ADMIN ACCESS GATE — requestAdminAccess()
// Centralised permission check used by settings.js and billing.js.
// =========================================================================
let _adminSession = null; // { expiresAt: timestamp }
const _ADMIN_SESSION_TTL = 10 * 60 * 1000; // 10 minutes

function _isAdminSessionValid() {
    return _adminSession && _adminSession.expiresAt > Date.now();
}

function _grantAdminSession() {
    _adminSession = { expiresAt: Date.now() + _ADMIN_SESSION_TTL };
}

function requestAdminAccess(action) {
    if (_isAdminSessionValid()) {
        _dispatchAdminAction(action);
        return;
    }
    _showAdminPinModal(action);
}

function _showAdminPinModal(pendingAction) {
    let modal = document.getElementById('adminAccessModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'adminAccessModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:15000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
<div style="background:var(--white);border-radius:12px;padding:24px;width:320px;max-width:94vw;box-shadow:0 16px 48px rgba(0,0,0,.3);">
  <div style="font-size:15px;font-weight:800;margin-bottom:4px;">🔒 Admin Access Required</div>
  <div style="font-size:11px;color:var(--g500);margin-bottom:14px;">Enter the master password to continue.</div>
  <input id="adminAccessPwdInput" type="password" placeholder="Master password"
    style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px 10px;font-size:13px;margin-bottom:8px;box-sizing:border-box;"
    autocomplete="off">
  <div id="adminAccessErr" style="font-size:11px;color:var(--red);min-height:16px;margin-bottom:10px;"></div>
  <div style="display:flex;gap:8px;">
    <button onclick="_closeAdminModal()" style="flex:1;height:36px;border:1px solid var(--g300);border-radius:6px;background:var(--g100);font-size:12px;font-weight:700;cursor:pointer;">Cancel</button>
    <button onclick="_submitAdminAccess()" style="flex:1;height:36px;border:none;border-radius:6px;background:var(--blu);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">Unlock</button>
  </div>
</div>`;
        document.body.appendChild(modal);
        modal.querySelector('input').addEventListener('keydown', e => {
            if (e.key === 'Enter') _submitAdminAccess();
        });
    }
    modal.style.display = 'flex';
    modal._pendingAction = pendingAction;
    const inp = document.getElementById('adminAccessPwdInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const err = document.getElementById('adminAccessErr');
    if (err) err.textContent = '';
}

function _closeAdminModal() {
    const m = document.getElementById('adminAccessModal');
    if (m) m.style.display = 'none';
}

async function _submitAdminAccess() {
    const inp = document.getElementById('adminAccessPwdInput');
    const err = document.getElementById('adminAccessErr');
    const pwd = (inp?.value || '').trim();
    if (!pwd) { if (err) err.textContent = 'Please enter the password.'; return; }

    const ok = await _verifyPassword(pwd);
    if (!ok) { if (err) err.textContent = '❌ Incorrect password.'; return; }

    _grantAdminSession();
    const modal = document.getElementById('adminAccessModal');
    const action = modal?._pendingAction;
    _closeAdminModal();
    if (action) _dispatchAdminAction(action);
}

function _dispatchAdminAction(action) {
    const handlers = {
        'SAVE_BRANCH_IDENTITY':   typeof _doSaveBranchIdentity  === 'function' ? _doSaveBranchIdentity  : null,
        'SAVE_RECEIPT_SETTINGS':  typeof _doSaveReceiptSettings  === 'function' ? _doSaveReceiptSettings  : null,
        'SAVE_BILLING_SETTINGS':  typeof _doSaveBillingSettings  === 'function' ? _doSaveBillingSettings  : null,
        'SAVE_ALL_SETTINGS':      typeof _doSaveAllSettings      === 'function' ? _doSaveAllSettings      : null,
        'SAVE_THERMAL_SETTINGS':  typeof _doSaveThermalSettings  === 'function' ? _doSaveThermalSettings  : null,
        'SAVE_STAFF':             null, // handled separately via saveStaffMember()
        'LOCAL_PURGE':            typeof _triggerLocalPurge      === 'function' ? _triggerLocalPurge      : null,
        'GLOBAL_PURGE':           typeof DevicesModule !== 'undefined' ? () => DevicesModule._promptGlobalPurge() : null
    };
    const fn = handlers[action];
    if (typeof fn === 'function') fn();
    else console.warn('[auth] No handler for action:', action);
}

// =========================================================================
// STAFF LOGIN SESSION
// =========================================================================
function openStaffLogin() {
    let modal = document.getElementById('staffLoginModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'staffLoginModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:12000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
<div style="background:var(--white);border-radius:12px;padding:24px;width:320px;max-width:94vw;box-shadow:0 16px 48px rgba(0,0,0,.3);">
  <div style="font-size:15px;font-weight:800;margin-bottom:14px;">👤 Staff Login</div>
  <input id="staffLoginUser" type="text" placeholder="Username"
    style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;" autocomplete="off">
  <input id="staffLoginPin" type="password" placeholder="PIN or password"
    style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;" autocomplete="off">
  <div id="staffLoginErr" style="font-size:11px;color:var(--red);min-height:14px;margin-bottom:8px;"></div>
  <div style="display:flex;gap:8px;">
    <button onclick="document.getElementById('staffLoginModal').style.display='none'" style="flex:1;height:36px;border:1px solid var(--g300);border-radius:6px;background:var(--g100);font-size:12px;font-weight:700;cursor:pointer;">Cancel</button>
    <button onclick="_submitStaffLogin()" style="flex:1;height:36px;border:none;border-radius:6px;background:var(--blu);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">Login</button>
  </div>
  <button onclick="_logoutStaff()" style="width:100%;margin-top:8px;height:32px;border:1px solid var(--g200);border-radius:6px;background:var(--g100);font-size:11px;font-weight:700;cursor:pointer;color:var(--g600);">Logout Current Staff</button>
</div>`;
        document.body.appendChild(modal);
        modal.querySelector('#staffLoginPin').addEventListener('keydown', e => { if (e.key === 'Enter') _submitStaffLogin(); });
        modal.querySelector('#staffLoginUser').addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#staffLoginPin').focus(); });
    }
    modal.style.display = 'flex';
    const u = document.getElementById('staffLoginUser');
    if (u) { u.value = ''; u.focus(); }
    const p = document.getElementById('staffLoginPin');
    if (p) p.value = '';
    const e = document.getElementById('staffLoginErr');
    if (e) e.textContent = '';
}

async function _submitStaffLogin() {
    const user = (document.getElementById('staffLoginUser')?.value || '').trim();
    const cred = (document.getElementById('staffLoginPin')?.value  || '').trim();
    const err  = document.getElementById('staffLoginErr');

    if (!user || !cred) { if (err) err.textContent = 'Enter username and PIN/password.'; return; }

    // Try PIN first (4-6 digits), then password
    const isPin  = /^\d{4,6}$/.test(cred);
    const member = await verifyStaffLogin(user, cred, isPin);

    if (!member) {
        if (err) err.textContent = '❌ Incorrect credentials.';
        return;
    }

    StorageModule.set('pharma_active_staff', member.name);
    StorageModule.set('pharma_active_staff_id', member.id);
    StorageModule.set('pharma_active_staff_role', member.role);

    const badge = document.getElementById('activeStaffLabel');
    if (badge) badge.textContent = member.name;
    document.getElementById('staffLoginModal').style.display = 'none';
    if (typeof showToast === 'function') showToast('✅ Logged in as ' + member.name + '.');
}

function _logoutStaff() {
    StorageModule.remove('pharma_active_staff');
    StorageModule.remove('pharma_active_staff_id');
    StorageModule.remove('pharma_active_staff_role');
    const badge = document.getElementById('activeStaffLabel');
    if (badge) badge.textContent = 'Login';
    const m = document.getElementById('staffLoginModal');
    if (m) m.style.display = 'none';
    if (typeof showToast === 'function') showToast('✅ Staff logged out.');
}

function _getActiveStaffName() {
    return StorageModule.get('pharma_active_staff') || '';
}

// Sync staff from cloud on page load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => _syncStaffFromCloud().catch(() => {}), 2000);
});
