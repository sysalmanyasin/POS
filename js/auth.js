// =========================================================================
// SHA-256 PASSWORD HASHING
// =========================================================================
async function _sha256(str) {
    const data = new TextEncoder().encode(str);
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function _hashPassword(p) { return await _sha256('FDPP_v1_' + p); }
async function _hashPin(p)      { return await _sha256('FDPP_pin_' + p); }

// ── Task 2: verify checks Supabase first, falls back to localStorage ────────
async function _verifyPassword(entered) {
    // 1. Try Supabase cloud hash
    try {
        const cloudHash = await _supaGet('pharma_master_password_hash');
        if (cloudHash) return (await _hashPassword(entered)) === cloudHash;
    } catch(e) {}
    // 2. Fall back to localStorage
    const storedHash = StorageModule.get('sys_admin_pass_hash');
    if (storedHash) return (await _hashPassword(entered)) === storedHash;
    const plain = StorageModule.get('sys_admin_pass');
    if (plain) return entered === plain;
    return false;
}

// ── Task 2: save password always writes to Supabase ─────────────────────────
async function _persistPassword(hash) {
    // Write to Supabase (primary)
    try { await _supaSet('pharma_master_password_hash', hash); } catch(e) {}
    // Keep localStorage as offline fallback
    StorageModule.set('sys_admin_pass_hash', hash);
    StorageModule.remove('sys_admin_pass');
    // Persistent flag so UI knows a password is set even after localStorage is cleared
    StorageModule.set('sys_has_password', 'true');
}

// =========================================================================
// POST-PURGE MASTER DEVICE SETUP — EmailJS PIN Distribution
// =========================================================================
let _masterSetupPin = '';
let _generatedMasterPin = '';
const _MASTER_SETUP_SUPABASE_KEY = 'pharma_master_setup_pin';
const _MASTER_DEVICE_KEY = 'pharma_master_device_id';

/**
 * Called after global purge to check if this should be the master device
 * Sets up the EmailJS PIN distribution flow
 */
async function _checkAndInitMasterSetup() {
    // Phase 2+: master identity is determined by the `devices` table, not the
    // legacy pharma_master_device_id KV key.  We check the table first; if
    // offline we fall back to the old KV key so the flow degrades gracefully.
    try {
        // Check devices table for an active master row that is NOT this device.
        // If one exists the password is already set and we just need the client
        // to sync it; show the client setup modal instead.
        const { data } = await _dbSelect(
            'devices',
            'role=eq.master&is_active=eq.true',
            'uuid'
        );
        const masterIsOtherDevice = data && data.length > 0 && !data.find(r => r.uuid === _DEVICE_UUID);
        if (masterIsOtherDevice) {
            _showClientDeviceSetupModal();
            return;
        }
        // No other master exists — this device is the master; start PIN email flow.
        _showMasterDeviceSetupModal();
    } catch(e) {
        console.warn('[Master Setup] devices table check failed, falling back to KV:', e.message);
        // Offline fallback: use the old KV key
        try {
            const existingMasterId = await _supaGet(_MASTER_DEVICE_KEY);
            if (existingMasterId && existingMasterId !== _DEVICE_UUID) {
                _showClientDeviceSetupModal();
                return;
            }
        } catch(_e) {}
        _showFirstLaunchPasswordSetup();
    }
}

/**
 * Master Device Setup Modal — Send PIN via EmailJS
 */
function _showMasterDeviceSetupModal() {
    let modal = document.getElementById('masterDeviceSetupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'masterDeviceSetupModal';
        modal.innerHTML = `
<style>
.master-setup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, .85);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
}
.master-setup-card {
    background: #fff;
    width: 100%;
    max-width: 500px;
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, .3);
    overflow: hidden;
}
.master-setup-hdr {
    padding: 20px;
    background: linear-gradient(135deg, #059669, #047857);
    color: #fff;
    font-size: 18px;
    font-weight: 900;
    display: flex;
    align-items: center;
    gap: 10px;
}
.master-setup-body {
    padding: 24px;
}
.master-setup-step {
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.6;
    color: #374151;
}
.master-setup-step strong {
    color: #059669;
}
.master-setup-warning {
    background: #fef3c7;
    border: 1px solid #fcd34d;
    color: #78350f;
    padding: 12px 14px;
    border-radius: 8px;
    font-size: 12px;
    margin: 16px 0;
}
.master-setup-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}
.master-setup-btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
}
.master-setup-btn-primary {
    background: #059669;
    color: #fff;
}
.master-setup-btn-primary:hover {
    background: #047857;
}
.master-setup-btn-secondary {
    background: #e5e7eb;
    color: #374151;
}
.master-setup-status {
    font-size: 12px;
    color: #6b7280;
    margin-top: 12px;
    min-height: 20px;
}
</style>
<div class="master-setup-overlay" id="masterSetupOverlay">
  <div class="master-setup-card">
    <div class="master-setup-hdr">👑 Master Device Setup</div>
    <div class="master-setup-body">
      <div class="master-setup-step">
        This is the <strong>first device</strong> after system purge. It will become the <strong>Master Device</strong>.
      </div>
      <div class="master-setup-warning">
        ⚠️ An 8-digit PIN will be sent to your email. Use it to set the master password. All client devices will sync this password.
      </div>
      <div class="master-setup-step">
        <strong>Email:</strong> ${RESET_EMAIL_ADDRESS || '(not configured)'}
      </div>
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
    document.getElementById('masterSetupStatus').textContent = '';
    modal.style.display = '';
}

function _closeMasterSetupModal() {
    const m = document.getElementById('masterDeviceSetupModal');
    if (m) m.style.display = 'none';
    // Fall back to first launch setup
    _showFirstLaunchPasswordSetup();
}

/**
 * Generate and send master PIN via EmailJS
 */
async function _sendMasterSetupPin() {
    const statusEl = document.getElementById('masterSetupStatus');
    
    if (!RESET_EMAIL_ADDRESS || RESET_EMAIL_ADDRESS.includes('YOUR_')) {
        statusEl.textContent = '❌ Email address not configured.';
        statusEl.style.color = 'var(--red)';
        return;
    }
    
    if (typeof emailjs === 'undefined') {
        statusEl.textContent = '❌ EmailJS not loaded.';
        statusEl.style.color = 'var(--red)';
        return;
    }
    
    statusEl.textContent = 'Generating PIN…';
    statusEl.style.color = '#6b7280';
    
    // Generate 8-digit PIN
    _generatedMasterPin = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
    
    try {
        // Store in Supabase
        await _supaSet(_MASTER_SETUP_SUPABASE_KEY, JSON.stringify({
            pin: _generatedMasterPin,
            expiresAt,
            deviceId: _DEVICE_UUID,
            createdAt: new Date().toISOString()
        }));
        
        // Send via EmailJS
        const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email: RESET_EMAIL_ADDRESS,
            reset_pin: _generatedMasterPin,
            shop_name: bi.businessName || bi.branchName || 'Pharma POS',
            counter_id: bi.counterId || 'Master Device',
            expires_in: '15 minutes',
            email_subject: '👑 Pharma POS Master Device Setup PIN'
        }, EMAILJS_PUBLIC_KEY);
        
        statusEl.textContent = '✅ PIN sent! Check your email.';
        statusEl.style.color = '#059669';
        
        // Move to PIN entry step
        setTimeout(() => _showMasterPinEntryModal(), 1500);
        
    } catch(err) {
        console.error('[Master Setup] PIN send failed:', err);
        statusEl.textContent = '❌ Failed to send PIN: ' + (err.message || 'Unknown error');
        statusEl.style.color = '#dc2626';
    }
}

/**
 * Master Device PIN Entry Modal
 */
function _showMasterPinEntryModal() {
    const m = document.getElementById('masterDeviceSetupModal');
    if (m) m.style.display = 'none';
    
    let modal = document.getElementById('masterPinEntryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'masterPinEntryModal';
        modal.innerHTML = `
<style>
.master-pin-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, .85);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}
.master-pin-card {
    background: #fff;
    width: 100%;
    max-width: 420px;
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, .3);
    overflow: hidden;
}
.master-pin-hdr {
    padding: 18px 20px;
    background: linear-gradient(135deg, #059669, #047857);
    color: #fff;
    font-weight: 900;
    font-size: 16px;
}
.master-pin-body {
    padding: 24px;
}
.master-pin-instruction {
    font-size: 13px;
    color: #6b7280;
    margin-bottom: 18px;
    line-height: 1.5;
}
.master-pin-dots {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin: 20px 0;
}
.master-pin-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #e5e7eb;
    transition: all 150ms ease;
}
.master-pin-dot.filled {
    background: #059669;
    box-shadow: 0 0 8px rgba(5, 150, 105, .5);
}
.master-pin-keypad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 20px 0;
}
.master-pin-key {
    padding: 12px;
    border: 1px solid #d1d5db;
    background: #f9fafb;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    transition: all 150ms ease;
}
.master-pin-key:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
}
.master-pin-key:active {
    background: #e5e7eb;
    transform: scale(.95);
}
.master-pin-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
}
.master-pin-btn {
    flex: 1;
    padding: 10px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.master-pin-btn-cancel {
    background: #e5e7eb;
    color: #374151;
}
.master-pin-btn-submit {
    background: #059669;
    color: #fff;
}
.master-pin-status {
    font-size: 11px;
    color: #6b7280;
    margin-top: 10px;
    min-height: 18px;
    text-align: center;
}
</style>
<div class="master-pin-overlay">
  <div class="master-pin-card">
    <div class="master-pin-hdr">Enter Master Setup PIN</div>
    <div class="master-pin-body">
      <div class="master-pin-instruction">
        Enter the 8-digit PIN sent to your email to set master password.
      </div>
      <div class="master-pin-dots" id="masterPinDots">
        ${[...Array(8)].map((_, i) => `<div class="master-pin-dot" id="masterPinDot${i}"></div>`).join('')}
      </div>
      <div class="master-pin-keypad">
        ${[1,2,3,4,5,6,7,8,9,0].map(n => `<button class="master-pin-key" onclick="_masterPinKey('${n}')">${n}</button>`).join('')}
        <button class="master-pin-key" style="grid-column: 1 / -1;" onclick="_masterPinBack()">← Delete</button>
      </div>
      <div class="master-pin-actions">
        <button class="master-pin-btn master-pin-btn-cancel" onclick="_cancelMasterPinEntry()">Cancel</button>
        <button class="master-pin-btn master-pin-btn-submit" onclick="_verifyMasterPin()">Verify</button>
      </div>
      <div class="master-pin-status" id="masterPinStatus"></div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    _masterSetupPin = '';
    _updateMasterPinDisplay();
    document.getElementById('masterPinStatus').textContent = '';
    modal.style.display = '';
}

function _masterPinKey(d) {
    if (_masterSetupPin.length >= 8) return;
    _masterSetupPin += d;
    _updateMasterPinDisplay();
    if (_masterSetupPin.length === 8) setTimeout(_verifyMasterPin, 180);
}

function _masterPinBack() {
    _masterSetupPin = _masterSetupPin.slice(0, -1);
    _updateMasterPinDisplay();
}

function _updateMasterPinDisplay() {
    const len = _masterSetupPin.length;
    for (let i = 0; i < 8; i++) {
        const dot = document.getElementById(`masterPinDot${i}`);
        if (dot) dot.classList.toggle('filled', i < len);
    }
}

async function _verifyMasterPin() {
    const statusEl = document.getElementById('masterPinStatus');
    
    if (_masterSetupPin.length !== 8) {
        statusEl.textContent = '❌ Enter all 8 digits.';
        statusEl.style.color = '#dc2626';
        return;
    }
    
    statusEl.textContent = 'Verifying…';
    statusEl.style.color = '#6b7280';
    
    try {
        const raw = await _supaGet(_MASTER_SETUP_SUPABASE_KEY);
        if (!raw) {
            statusEl.textContent = '❌ PIN expired or not found.';
            statusEl.style.color = '#dc2626';
            return;
        }
        
        const stored = JSON.parse(raw);
        if (new Date(stored.expiresAt).getTime() < Date.now()) {
            statusEl.textContent = '⏰ PIN has expired.';
            statusEl.style.color = '#d97706';
            await _supaDel(_MASTER_SETUP_SUPABASE_KEY);
            return;
        }
        
        if (stored.pin !== _masterSetupPin) {
            statusEl.textContent = '❌ Incorrect PIN.';
            statusEl.style.color = '#dc2626';
            _masterSetupPin = '';
            _updateMasterPinDisplay();
            return;
        }
        
        // ✅ PIN verified — move to password setup
        statusEl.textContent = '✅ PIN verified!';
        statusEl.style.color = '#059669';
        
        // Delete used PIN
        await _supaDel(_MASTER_SETUP_SUPABASE_KEY);
        
        // Phase 2+: master identity lives in the `devices` table (written by
        // devices.js registration). Keep localStorage flag for UI checks only.
        StorageModule.set('sys_is_master_device', 'true');
        
        setTimeout(() => _showMasterPasswordSetupModal(), 1000);
        
    } catch(err) {
        console.error('[Master PIN] Verification failed:', err);
        statusEl.textContent = '❌ Verification error.';
        statusEl.style.color = '#dc2626';
    }
}

function _cancelMasterPinEntry() {
    const m = document.getElementById('masterPinEntryModal');
    if (m) m.style.display = 'none';
    _showMasterDeviceSetupModal();
}

/**
 * Master Password Setup Modal — Set password that syncs to all devices
 */
function _showMasterPasswordSetupModal() {
    const m = document.getElementById('masterPinEntryModal');
    if (m) m.style.display = 'none';
    
    let modal = document.getElementById('masterPasswordSetupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'masterPasswordSetupModal';
        modal.innerHTML = `
<style>
.master-pass-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, .85);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
}
.master-pass-card {
    background: #fff;
    width: 100%;
    max-width: 460px;
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, .3);
    overflow: hidden;
}
.master-pass-hdr {
    padding: 18px 20px;
    background: linear-gradient(135deg, #059669, #047857);
    color: #fff;
    font-weight: 900;
    font-size: 16px;
}
.master-pass-body {
    padding: 24px;
}
.master-pass-instruction {
    font-size: 13px;
    color: #6b7280;
    margin-bottom: 16px;
    line-height: 1.5;
}
.master-pass-field {
    margin-bottom: 14px;
}
.master-pass-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #374151;
    margin-bottom: 4px;
}
.master-pass-input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 13px;
    box-sizing: border-box;
}
.master-pass-input:focus {
    outline: none;
    border-color: #059669;
    box-shadow: 0 0 0 3px rgba(5, 150, 105, .1);
}
.master-pass-actions {
    display: flex;
    gap: 8px;
    margin-top: 20px;
}
.master-pass-btn {
    flex: 1;
    padding: 10px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.master-pass-btn-cancel {
    background: #e5e7eb;
    color: #374151;
}
.master-pass-btn-confirm {
    background: #059669;
    color: #fff;
}
.master-pass-status {
    font-size: 11px;
    color: #6b7280;
    margin-top: 10px;
    min-height: 18px;
}
</style>
<div class="master-pass-overlay">
  <div class="master-pass-card">
    <div class="master-pass-hdr">👑 Set Master Password</div>
    <div class="master-pass-body">
      <div class="master-pass-instruction">
        Set an 8-digit master password. This will be synced to all client devices.
      </div>
      <div class="master-pass-field">
        <label class="master-pass-label">Master Password</label>
        <input type="password" id="masterPassNewPass" class="master-pass-input" placeholder="8 digits" maxlength="8" autocomplete="off">
      </div>
      <div class="master-pass-field">
        <label class="master-pass-label">Confirm Password</label>
        <input type="password" id="masterPassConfirmPass" class="master-pass-input" placeholder="8 digits" maxlength="8" autocomplete="off">
      </div>
      <div class="master-pass-actions">
        <button class="master-pass-btn master-pass-btn-cancel" onclick="_cancelMasterPasswordSetup()">Cancel</button>
        <button class="master-pass-btn master-pass-btn-confirm" onclick="_confirmMasterPasswordSetup()">Set Password</button>
      </div>
      <div class="master-pass-status" id="masterPassStatus"></div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('masterPassNewPass').value = '';
    document.getElementById('masterPassConfirmPass').value = '';
    document.getElementById('masterPassStatus').textContent = '';
    modal.style.display = '';
    document.getElementById('masterPassNewPass').focus();
}

function _cancelMasterPasswordSetup() {
    const m = document.getElementById('masterPasswordSetupModal');
    if (m) m.style.display = 'none';
}

async function _confirmMasterPasswordSetup() {
    const newPassEl = document.getElementById('masterPassNewPass');
    const confirmPassEl = document.getElementById('masterPassConfirmPass');
    const statusEl = document.getElementById('masterPassStatus');
    
    const newP = (newPassEl?.value || '').trim();
    const confP = (confirmPassEl?.value || '').trim();
    
    if (!newP || newP.length !== 8 || !/^\d{8}$/.test(newP)) {
        statusEl.textContent = '❌ Password must be exactly 8 digits.';
        statusEl.style.color = '#dc2626';
        return;
    }
    
    if (newP !== confP) {
        statusEl.textContent = '❌ Passwords do not match.';
        statusEl.style.color = '#dc2626';
        return;
    }
    
    statusEl.textContent = 'Saving…';
    statusEl.style.color = '#6b7280';
    
    try {
        const hash = await _hashPassword(newP);
        await _persistPassword(hash);
        
        newPassEl.value = '';
        confirmPassEl.value = '';
        
        statusEl.textContent = '✅ Master password set and synced!';
        statusEl.style.color = '#059669';
        
        showToast('👑 Master device configured. Password synced to cloud.');
        
        // Close all modals
        const m = document.getElementById('masterPasswordSetupModal');
        if (m) m.style.display = 'none';
        
        setTimeout(() => location.reload(), 1500);
        
    } catch(err) {
        console.error('[Master Password] Setup failed:', err);
        statusEl.textContent = '❌ Setup failed: ' + (err.message || 'Unknown error');
        statusEl.style.color = '#dc2626';
    }
}

/**
 * Client Device Setup Modal — Receive password from cloud
 */
function _showClientDeviceSetupModal() {
    let modal = document.getElementById('clientDeviceSetupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'clientDeviceSetupModal';
        modal.innerHTML = `
<style>
.client-setup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, .85);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
}
.client-setup-card {
    background: #fff;
    width: 100%;
    max-width: 450px;
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, .3);
    overflow: hidden;
}
.client-setup-hdr {
    padding: 18px 20px;
    background: linear-gradient(135deg, #2563eb, #1d4ed8);
    color: #fff;
    font-weight: 900;
    font-size: 16px;
}
.client-setup-body {
    padding: 24px;
    text-align: center;
}
.client-setup-icon {
    font-size: 48px;
    margin-bottom: 12px;
}
.client-setup-title {
    font-size: 16px;
    font-weight: 700;
    color: #1f2937;
    margin-bottom: 8px;
}
.client-setup-text {
    font-size: 13px;
    color: #6b7280;
    line-height: 1.6;
    margin-bottom: 20px;
}
.client-setup-status {
    font-size: 12px;
    color: #2563eb;
    padding: 10px;
    background: #dbeafe;
    border-radius: 6px;
    margin-bottom: 16px;
}
.client-setup-btn {
    padding: 10px 20px;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.client-setup-btn:hover {
    background: #1d4ed8;
}
</style>
<div class="client-setup-overlay">
  <div class="client-setup-card">
    <div class="client-setup-hdr">🖥️ Client Device Setup</div>
    <div class="client-setup-body">
      <div class="client-setup-icon">⚡</div>
      <div class="client-setup-title">Syncing Master Password…</div>
      <div class="client-setup-text">
        This device will receive the master password from the cloud. You can now login with the master password set on the Master Device.
      </div>
      <div class="client-setup-status" id="clientSetupStatus">
        Connecting to cloud…
      </div>
      <button class="client-setup-btn" onclick="_completeClientDeviceSetup()">Continue</button>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    
    // Check for master password sync
    _syncClientPassword(document.getElementById('clientSetupStatus'));
    modal.style.display = '';
}

async function _syncClientPassword(statusEl) {
    try {
        // Wait for master password to be available (max 30 seconds)
        let attempts = 0;
        while (attempts < 30) {
            const cloudHash = await _supaGet('pharma_master_password_hash');
            if (cloudHash) {
                // Found it! Store locally
                StorageModule.set('sys_admin_pass_hash', cloudHash);
                StorageModule.set('sys_has_password', 'true');
                statusEl.textContent = '✅ Password synced! Ready to login.';
                statusEl.style.color = '#059669';
                return;
            }
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        statusEl.textContent = '⏰ Timeout waiting for password. Try again.';
        statusEl.style.color = '#d97706';
    } catch(err) {
        statusEl.textContent = '❌ Sync failed: ' + (err.message || 'Unknown error');
        statusEl.style.color = '#dc2626';
    }
}

function _completeClientDeviceSetup() {
    const m = document.getElementById('clientDeviceSetupModal');
    if (m) m.style.display = 'none';
    location.reload();
}

// =========================================================================
// FIRST-LAUNCH PASSWORD SETUP — Task 2: exactly 8 digits
// =========================================================================
function _showFirstLaunchPasswordSetup() {
    const modal = document.getElementById('firstLaunchModal');
    if (modal) {
        modal.classList.add('visible');
        setTimeout(() => { const f = document.getElementById('flNewPass'); if (f) f.focus(); }, 120);
    }
}
async function saveFirstLaunchPassword() {
    const newP     = (document.getElementById('flNewPass').value    || '').trim();
    const confirmP = (document.getElementById('flConfirmPass').value || '').trim();
    if (!newP || newP.length !== 8 || !/^\d{8}$/.test(newP)) {
        showToast('❌ Password must be exactly 8 digits.', true); return;
    }
    if (newP !== confirmP) { showToast('❌ Passwords do not match.', true); return; }
    const h = await _hashPassword(newP);
    await _persistPassword(h);
    document.getElementById('flNewPass').value    = '';
    document.getElementById('flConfirmPass').value = '';
    document.getElementById('firstLaunchModal').classList.remove('visible');
    showToast('✅ Admin password set. System is ready.');
}

// =========================================================================
// STARTUP MIGRATION — localStorage → Supabase
// =========================================================================
let _migrationDone = false;
async function _migrateSecretsOnStartup() {
    if (_migrationDone) return;
    _migrationDone = true;

    // Migrate plain-text password to hash first
    const plain = StorageModule.get('sys_admin_pass');
    if (plain) {
        const h = await _hashPassword(plain);
        StorageModule.set('sys_admin_pass_hash', h);
        StorageModule.remove('sys_admin_pass');
    }

    // Migrate localStorage hash → Supabase if not already there
    try {
        // ── FIX: Post-purge check BEFORE cloud read ───────────────────────
        // After a Global Purge, localStorage is wiped but the cloud password hash
        // in `pharma_sync` may still exist (purge doesn't always delete it).
        // Old flow: read cloud hash first → if found, skip setup → master never
        // gets the EmailJS PIN flow or Admin PIN reset.
        // Fix: if a purge happened within the last 10 minutes, run master setup
        // immediately and skip the cloud hash check entirely.
        const _lastPurge    = StorageModule.get('sys_last_purge_time');
        const _sincePurgeMs = _lastPurge ? (Date.now() - parseInt(_lastPurge)) : null;
        if (_sincePurgeMs !== null && _sincePurgeMs < 10 * 60 * 1000) {
            // Clear the stale purge marker so this branch only fires once
            StorageModule.remove('sys_last_purge_time');
            await _checkAndInitMasterSetup();
            return; // skip the rest of the migration on this run
        }

        const cloudHash = await _supaGet('pharma_master_password_hash');
        if (!cloudHash) {
            const localHash = StorageModule.get('sys_admin_pass_hash');
            if (localHash) {
                // Push to Supabase then clean localStorage
                await _supaSet('pharma_master_password_hash', localHash);
                StorageModule.remove('sys_admin_pass_hash');
            } else {
                // Check if this is post-purge scenario (fallback: timer not set)
                const lastPurgeTime = StorageModule.get('sys_last_purge_time');
                const timeSincePurge = lastPurgeTime ? (Date.now() - parseInt(lastPurgeTime)) : null;
                
                // If purged within last 5 minutes, init master setup
                if (timeSincePurge && timeSincePurge < 5 * 60 * 1000) {
                    await _checkAndInitMasterSetup();
                } else {
                    // Truly first launch — show setup modal
                    _showFirstLaunchPasswordSetup();
                }
            }
        } else {
            // Cloud has it — remove localStorage copy (cloud is source of truth)
            StorageModule.remove('sys_admin_pass_hash');
            StorageModule.remove('sys_admin_pass');
            StorageModule.set('sys_has_password', 'true');
        }
    } catch(e) {
        // Offline — if we have a local hash that's fine, keep it
        if (!StorageModule.get('sys_admin_pass_hash')) {
            _showFirstLaunchPasswordSetup();
        }
    }

    // Migrate staff PINs to hashed versions
    const list = _getStaffList();
    let changed = false;
    list.forEach(s => {
        if (s.pin && !s.pinHash) {
            _hashPin(s.pin).then(h => { s.pinHash = h; });
            changed = true;
        }
    });
    if (changed) setTimeout(() => _saveStaffList(_getStaffList()), 500);
}
function _migratePasswordOnStartup() { _migrateSecretsOnStartup().catch(() => {}); }

// =========================================================================
// ADMIN AUTH MODAL — Task 2: exactly 8-digit PIN
// =========================================================================
function requestAdminAccess(type, targetId = null, extraData = null) {
    _pendingActionQueue.push({ type, targetId, extraData });
    const msgs = {
        'PURGE_DATABASE':       '⚠️ This will permanently delete ALL saved invoices and ledger data.',
        'SUPABASE_PURGE':       '☁️🗑 This will DELETE all data from Supabase cloud KV. All other devices lose synced data.',
        'SUPABASE_PUSH':        '☁️⬆ This will overwrite Supabase cloud KV with all current local data.',
        'UPDATE_BILL':          'Authenticate to edit Invoice ' + targetId + '.',
        'REFUND_INVOICE':       'Authenticate to open refund screen for Invoice ' + targetId + '.',
        'APPLY_HIGH_DISCOUNT':  '⚠️ Discount of ' + extraData + '% exceeds allowed limit. Manager approval required.',
        'SAVE_BRANCH_IDENTITY': 'Authenticate to save branch identity settings.',
        'SAVE_RECEIPT_SETTINGS':'Authenticate to save receipt settings.',
        'SAVE_BILLING_SETTINGS':'Authenticate to save billing settings.',
        'TOGGLE_OVERSTOCK':     'Authenticate to change overstock permission.',
        'TOGGLE_REQUIRE_STAFF_PIN': 'Authenticate to change staff PIN requirement.',
        'TOGGLE_AUTO_BACKUP':   'Authenticate to toggle automatic backup.',
        'EDIT_OWNER_PIN':       'Authenticate with Master PIN to change the Owner login PIN.',
        'ADD_STAFF_MEMBER':     'Manager authentication required to add a new staff member.',
        'REMOVE_STAFF_MEMBER':  'Manager authentication required to remove a staff member.',
        'CHANGE_STAFF_PIN':     'Manager authentication required to change a staff User ID.',
        'SAVE_ALL_SETTINGS':    'Authenticate to save all settings in one action.',
        'SAVE_THERMAL_SETTINGS':'Authenticate to save printer/thermal settings.',
        'DELETE_PRODUCT':       '⚠️ Admin authentication required to delete a product from the catalogue.',
        'CSV_IMPORT':           '⚠️ Admin authentication required to import inventory from CSV.',
        'DEVICE_PURGE':         '⚠️ Authenticate to send a PURGE command to this device. All local data on that device will be erased.',
        'DEVICE_ARCHIVE':       'Authenticate to archive this device (hide from Device Manager).',
        'DEVICE_DELETE':        '⚠️ Authenticate to permanently delete this device from the registry. This cannot be undone.',
        'DEVICE_SET_MASTER':    '👑 Authenticate to promote this device to Master. The current Master will be downgraded to Client.',
        'DEVICE_DEMOTE_MASTER': 'Authenticate to demote the current Master device to Client.',
        'MASTER_RECLAIM':       '👑 Authenticate to re-claim the Master role on this device. Any other Master will be downgraded to Client.',
        'PURGE_OLD_INVOICES':   '⚠️ Authenticate to open the old-invoice purge tool.',
        'PURGE_ZERO_STOCK':     '⚠️ Authenticate to remove all zero-stock items from inventory.'
    };
    document.getElementById('authActionText').textContent = msgs[type] || 'Admin action required.';
    document.getElementById('authModal').classList.add('visible');
    _authPin = '';
    document.getElementById('masterPasswordInput').value = '';
    _updatePinDisplay();
}

let _authPin = '';
// Exactly 8 digits — guard >= 8, auto-submit at exactly 8
function authPinKey(d) {
    if (_authPin.length >= 8) return;
    _authPin += d;
    document.getElementById('masterPasswordInput').value = _authPin;
    _updatePinDisplay();
    if (_authPin.length === 8) setTimeout(submitAuth, 180);
}
function authPinBack() {
    _authPin = _authPin.slice(0, -1);
    document.getElementById('masterPasswordInput').value = _authPin;
    _updatePinDisplay();
}
// 8 dots (pinDot0–pinDot7)
function _updatePinDisplay() {
    const len = _authPin.length;
    ['pinDot0','pinDot1','pinDot2','pinDot3','pinDot4','pinDot5','pinDot6','pinDot7'].forEach((id, i) => {
        const dot = document.getElementById(id);
        if (dot) dot.classList.toggle('filled', i < len);
    });
}
function cancelAuthModal() {
    // Called when the user explicitly dismisses the modal (X button / Escape).
    // Safe to clear the queue here because no action was executed.
    _pendingActionQueue.length = 0;
    pendingAction = null;
    closeAuthModal();
}

function closeAuthModal() {
    document.getElementById('authModal').classList.remove('visible');
    _authPin = '';
    document.getElementById('masterPasswordInput').value = '';
    _updatePinDisplay();
    // NOTE: do NOT clear _pendingActionQueue or pendingAction here.
    // executeProtectedAction() may have dispatched an async action (e.g.
    // _doAddStaffMember → _hashPin) that still holds a reference to
    // pendingAction.extraData. Clearing it here races with the async
    // callback and causes "Cannot destructure property of null".
    // _pendingActionQueue is cleared by executeProtectedAction() via shift(),
    // and pendingAction is reset to null there too after the action runs.
    ['pinDot0','pinDot1','pinDot2','pinDot3','pinDot4','pinDot5','pinDot6','pinDot7'].forEach(id => {
        const d = document.getElementById(id); if (d) d.classList.remove('filled');
    });
}
let _authSubmitting = false;
function submitAuth() {
    if (_authSubmitting) return;
    if (_authPin.length !== 8) { showToast('❌ Password must be exactly 8 digits.', true); return; }
    _authSubmitting = true;
    try {
        _verifyPassword(document.getElementById('masterPasswordInput').value).then(ok => {
            if (ok) {
                try { executeProtectedAction(); closeAuthModal(); }
                catch(e) { showToast('❌ Error: ' + e.message, true); }
            } else {
                showToast('❌ Wrong PIN.', true);
                _authPin = '';
                document.getElementById('masterPasswordInput').value = '';
                _updatePinDisplay();
            }
        }).finally(() => { _authSubmitting = false; });
    } catch(e) {
        _authSubmitting = false;
        showToast('❌ Auth error: ' + e.message, true);
    }
}
document.addEventListener('keydown', e => {
    if (!document.getElementById('authModal').classList.contains('visible')) return;
    e.stopPropagation();
    if (e.key >= '0' && e.key <= '9')                { e.preventDefault(); authPinKey(e.key); }
    else if (e.key === 'Backspace')                  { e.preventDefault(); authPinBack(); }
    else if (e.key === 'Enter')                      { e.preventDefault(); submitAuth(); }
    else if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); cancelAuthModal(); }
}, true);

function executeProtectedAction() {
    pendingAction = _pendingActionQueue.shift();
    if (!pendingAction) return;
    const { type, targetId, extraData } = pendingAction;
    if      (type === 'PURGE_DATABASE')      { const input = document.getElementById('purgeConfirmInput'); input.value = ''; document.getElementById('purgeConfirmModal').classList.add('visible'); }
    else if (type === 'SUPABASE_PURGE')      { StorageModule.purgeCloudStorageOnly(); return; }
    else if (type === 'SUPABASE_PUSH')       { StorageModule.pushLocalToCloudEngine(); return; }
    else if (type === 'UPDATE_BILL')         { _doUpdateBill(targetId); }
    else if (type === 'REFUND_INVOICE')      { openPartialRefundModal(targetId); }
    else if (type === 'APPLY_HIGH_DISCOUNT') { discountInput.value = extraData; calculateBillTotals(); syncDiscountPresetButtons(extraData); }
    else if (type === 'SAVE_BRANCH_IDENTITY')  { _doSaveBranchIdentity(); }
    else if (type === 'SAVE_RECEIPT_SETTINGS') { _doSaveReceiptSettings(); }
    else if (type === 'SAVE_BILLING_SETTINGS') { _doSaveBillingSettings(); }
    else if (type === 'TOGGLE_OVERSTOCK')      { _doToggleOverstockSetting(); }
    else if (type === 'TOGGLE_REQUIRE_STAFF_PIN') { _doToggleRequireStaffPin(); }
    else if (type === 'TOGGLE_AUTO_BACKUP')    { _doToggleAutoBackup(); }
    else if (type === 'EDIT_OWNER_PIN')        { _openOwnerPinChangeModal(); }
    else if (type === 'ADD_STAFF_MEMBER')      { _doAddStaffMember(); }
    else if (type === 'REMOVE_STAFF_MEMBER')   { _doRemoveStaffMember(); }
    else if (type === 'CHANGE_STAFF_PIN')      { _openStaffPinChangeModal(); }
    else if (type === 'SAVE_ALL_SETTINGS')     { _doSaveAllSettings(); }
    else if (type === 'SAVE_THERMAL_SETTINGS') { _doSaveThermalSettings(); }
    else if (type === 'DELETE_PRODUCT')        { if (typeof deleteProductFromCatalogue === 'function') deleteProductFromCatalogue(targetId); }
    else if (type === 'CSV_IMPORT')            { _triggerCsvFileInput(); }
    // Phase 2+: DEVICE_PURGE and DEVICE_SET_MASTER route to DevicesModule
    // which writes to the relational `devices` table.
    // The old _settDevPurgeConfirmed / _settDevSetMasterConfirmed in settings.js
    // still exist for the settings panel's own device cards; they will be updated
    // in the settings.js phase.  The dashboard buttons in devices.js use the new path.
    else if (type === 'DEVICE_PURGE')          {
        if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._doPurgeDevice === 'function') {
            DevicesModule._doPurgeDevice(targetId);
        } else if (typeof _settDevPurgeConfirmed === 'function') {
            _settDevPurgeConfirmed(targetId, extraData); // fallback: settings panel
        }
    }
    else if (type === 'DEVICE_ARCHIVE')        { if (typeof _settDevArchiveConfirmed === 'function') _settDevArchiveConfirmed(targetId, extraData); }
    else if (type === 'DEVICE_DELETE')         {
        // F1.8: Hard-delete — permanently removes the device row via _doDeleteDevice.
        // _doPurgeDevice only soft-deactivates (is_active=false); _doDeleteDevice
        // issues _dbDelete for a true row removal then sends a PURGE command.
        if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._doDeleteDevice === 'function') {
            DevicesModule._doDeleteDevice(targetId);
        } else if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._doPurgeDevice === 'function') {
            // Fallback: older build without _doDeleteDevice — soft-deactivate instead
            DevicesModule._doPurgeDevice(targetId);
        }
    }
    else if (type === 'DEVICE_SET_MASTER')     {
        if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._doSetAsMaster === 'function') {
            DevicesModule._doSetAsMaster(targetId);
        } else if (typeof _settDevSetMasterConfirmed === 'function') {
            _settDevSetMasterConfirmed(targetId); // fallback: settings panel
        }
    }
    else if (type === 'DEVICE_DEMOTE_MASTER')  { if (typeof _settDevDemoteMasterConfirmed === 'function') _settDevDemoteMasterConfirmed(targetId); }
    else if (type === 'MASTER_RECLAIM')        { if (typeof DevicesModule !== 'undefined' && typeof DevicesModule._doReclaimMasterRole === 'function') DevicesModule._doReclaimMasterRole(); }
    else if (type === 'PURGE_OLD_INVOICES')    { if (typeof _openPurgeOldModalConfirmed === 'function') _openPurgeOldModalConfirmed(); }
    else if (type === 'PURGE_ZERO_STOCK')      { if (typeof _purgeZeroStockConfirmed === 'function') _purgeZeroStockConfirmed(); }
}

// =========================================================================
// CSV IMPORT FIX — Trigger file input after auth
// =========================================================================
function _triggerCsvFileInput() {
    const f = document.getElementById('csvFile');
    if (f) {
        f.click();
    } else {
        showToast('❌ CSV file input not found.', true);
    }
}

function cancelPurgeConfirm() {
    document.getElementById('purgeConfirmModal').classList.remove('visible');
    document.getElementById('purgeConfirmInput').value = '';
    showToast('Purge cancelled.');
}
function confirmPurgeAction() {
    const typed = document.getElementById('purgeConfirmInput').value.trim();
    document.getElementById('purgeConfirmModal').classList.remove('visible');
    document.getElementById('purgeConfirmInput').value = '';
    if (typed !== 'PURGE') { showToast('❌ Purge cancelled — text did not match.', true); return; }
    StorageModule.clearAllPrimaryStores();
    if (typeof db !== 'undefined' && db) db.transaction(['inventory'], 'readwrite').objectStore('inventory').clear();
    savedInvoicesLedger = []; temporaryHeldBills = []; masterInventoryDB = []; activeCartItems = []; currentlyEditingInvoiceId = null;
    updateStatsCounters(); renderHistoryCards([]); renderInvoiceUI(); updateHdrStats();
    StorageModule.purgeCloudStorageOnly().catch(() => {});
    
    // Mark purge time for master setup detection
    StorageModule.set('sys_last_purge_time', String(Date.now()));
    
    showToast('⚠️ All records purged.');
}
const _purgeConfirmInput = document.getElementById('purgeConfirmInput');
if (_purgeConfirmInput) _purgeConfirmInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  confirmPurgeAction();
    if (e.key === 'Escape') cancelPurgeConfirm();
});

// ── Helper: async check whether any password has been set (local OR cloud) ─────
async function _checkPasswordExists() {
    // Fast local checks first
    if (StorageModule.get('sys_has_password') === 'true') return true;
    if (StorageModule.get('sys_admin_pass_hash'))         return true;
    if (StorageModule.get('sys_admin_pass'))              return true;
    // Fallback: ask Supabase (handles post-migration state where local flags were cleared)
    try {
        const cloudHash = await _supaGet('pharma_master_password_hash');
        if (cloudHash) {
            // Restore the flag so future calls are instant
            StorageModule.set('sys_has_password', 'true');
            return true;
        }
    } catch(e) {}
    return false;
}

// ── Password change — current password verified via SHA-256 before _persistPassword ──
function processPasswordModification() {
    // Support both the legacy #oldPassInput and the new dedicated #currentAdminPasswordInput
    const currentPassEl = document.getElementById('currentAdminPasswordInput') || document.getElementById('oldPassInput');
    const newPassEl     = document.getElementById('newPassInput');
    const confirmPassEl = document.getElementById('confirmNewPassInput');
    const oldP = (currentPassEl?.value || '').trim();
    const newP = (newPassEl?.value     || '').trim();
    const confP = confirmPassEl ? (confirmPassEl.value || '').trim() : newP;

    if (!newP) { showToast('❌ Enter a new password.', true); if (newPassEl) newPassEl.focus(); return; }
    if (newP.length !== 8 || !/^\d{8}$/.test(newP)) { showToast('❌ New password must be exactly 8 digits.', true); return; }
    if (confirmPassEl && confP !== newP) { showToast('❌ Passwords do not match.', true); if (confirmPassEl) confirmPassEl.focus(); return; }

    const _clearFields = () => {
        if (currentPassEl) currentPassEl.value = '';
        if (newPassEl)     newPassEl.value     = '';
        if (confirmPassEl) confirmPassEl.value  = '';
    };

    // Async cloud-aware check so the guard works even after localStorage is cleared on migration
    _checkPasswordExists().then(hasExisting => {
        if (hasExisting) {
            if (!oldP) { showToast('❌ Enter your current password first.', true); if (currentPassEl) currentPassEl.focus(); return; }
            // SHA-256 verify current password before persisting the new hash
            _verifyPassword(oldP).then(async ok => {
                if (!ok) { showToast('❌ Incorrect current password.', true); if (currentPassEl) { currentPassEl.value=''; currentPassEl.focus(); } return; }
                const hash = await _hashPassword(newP);
                await _persistPassword(hash);
                _clearFields();
                showToast('🔒 Admin password updated securely.');
            }).catch(() => showToast('❌ Verification error. Try again.', true));
        } else {
            _hashPassword(newP).then(async hash => {
                await _persistPassword(hash);
                _clearFields();
                showToast('✅ Admin password set.');
            }).catch(() => showToast('❌ Failed to set password.', true));
        }
    }).catch(() => showToast('❌ Could not check existing password. Try again.', true));
}

document.getElementById('authModal').addEventListener('click', e => {
    if (e.target === document.getElementById('authModal')) cancelAuthModal();
});

// =========================================================================
// TASK 3 — GMAIL RESET VIA EMAILJS: Full OTP flow
// =========================================================================

// State for the reset flow
let _resetOtpPin  = '';
const _RESET_SUPABASE_KEY = 'pharma_reset_pin';

// ── Step 1: open the reset modal ─────────────────────────────────────────────
function openPasswordResetFlow() {
    const modal = document.getElementById('passwordResetModal');
    if (!modal) return;
    // Reset to step 1
    _showResetStep(1);
    _resetOtpPin = '';
    _updateOtpDots();
    document.getElementById('prm-status').textContent = '';
    document.getElementById('prm-send-btn').disabled  = false;
    document.getElementById('prm-send-btn').textContent = '📧 Send OTP to Email';
    const addrEl = document.getElementById('prm-email-display');
    if (addrEl) addrEl.textContent = RESET_EMAIL_ADDRESS || '(not configured)';
    modal.classList.add('visible');
}
function closePasswordResetFlow() {
    const modal = document.getElementById('passwordResetModal');
    if (modal) modal.classList.remove('visible');
    _resetOtpPin = '';
    _updateOtpDots();
}
function _showResetStep(n) {
    [1, 2, 3].forEach(i => {
        const el = document.getElementById('prm-step' + i);
        if (el) el.style.display = (i === n) ? '' : 'none';
    });
}

// ── Step 2: generate OTP, store in Supabase, send via EmailJS ────────────────
async function sendResetOtp() {
    const btn = document.getElementById('prm-send-btn');
    const statusEl = document.getElementById('prm-status');

    if (!RESET_EMAIL_ADDRESS || RESET_EMAIL_ADDRESS.includes('YOUR_')) {
        statusEl.textContent = '❌ Reset email address not configured in config.js.';
        statusEl.style.color = 'var(--red)';
        return;
    }
    if (typeof emailjs === 'undefined') {
        statusEl.textContent = '❌ EmailJS not loaded. Check internet connection.';
        statusEl.style.color = 'var(--red)';
        return;
    }

    btn.disabled    = true;
    btn.textContent = 'Sending…';
    statusEl.style.color = 'var(--g500)';
    statusEl.textContent = 'Generating OTP…';

    // Generate a random 8-digit numeric OTP
    const otp = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Store in Supabase
    try {
        const ok = await _supaSet(_RESET_SUPABASE_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Supabase write failed');
    } catch(e) {
        statusEl.textContent = '❌ Could not save OTP to cloud. Check internet connection.';
        statusEl.style.color = 'var(--red)';
        btn.disabled    = false;
        btn.textContent = '📧 Send OTP to Email';
        return;
    }

    // Send via EmailJS
    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  bi.businessName || bi.branchName || 'Pharma POS',
            counter_id: bi.counterId    || '',
            expires_in: '10 minutes'
        }, EMAILJS_PUBLIC_KEY);

        statusEl.textContent = '✅ OTP sent! Check your inbox. It expires in 10 minutes.';
        statusEl.style.color = 'var(--grn)';
        setTimeout(() => _showResetStep(2), 1400);

        // Auto-expire: after 10 min, if user is still on step 2, move them back
        setTimeout(() => {
            const modal = document.getElementById('passwordResetModal');
            if (modal && modal.classList.contains('visible')) {
                const step2 = document.getElementById('prm-step2');
                if (step2 && step2.style.display !== 'none') {
                    _showResetStep(1);
                    btn.disabled    = false;
                    btn.textContent = '📧 Send OTP to Email';
                    document.getElementById('prm-status').textContent = '⏰ OTP expired. Please request a new one.';
                    document.getElementById('prm-status').style.color = 'var(--amb)';
                }
            }
        }, 10 * 60 * 1000);

    } catch(err) {
        console.error('[EmailJS] OTP send failed:', err);
        // Delete the stored OTP if email failed
        try { await _supaDel(_RESET_SUPABASE_KEY); } catch(_e) {}
        statusEl.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown error');
        statusEl.style.color = 'var(--red)';
        btn.disabled    = false;
        btn.textContent = '📧 Send OTP to Email';
    }
}

// ── OTP keypad (step 2) ───────────────────────────────────────────────────────
function otpPinKey(d) {
    if (_resetOtpPin.length >= 8) return;
    _resetOtpPin += d;
    _updateOtpDots();
    if (_resetOtpPin.length === 8) setTimeout(verifyResetOtp, 180);
}
function otpPinBack() {
    _resetOtpPin = _resetOtpPin.slice(0, -1);
    _updateOtpDots();
}
function _updateOtpDots() {
    const len = _resetOtpPin.length;
    ['otpDot0','otpDot1','otpDot2','otpDot3','otpDot4','otpDot5','otpDot6','otpDot7'].forEach((id, i) => {
        const dot = document.getElementById(id);
        if (dot) dot.classList.toggle('filled', i < len);
    });
}

// ── Step 3: verify OTP against Supabase ──────────────────────────────────────
async function verifyResetOtp() {
    const statusEl = document.getElementById('prm-otp-status');
    if (!statusEl) return;

    if (_resetOtpPin.length !== 8) {
        statusEl.textContent = '❌ Enter the full 8-digit OTP.';
        statusEl.style.color = 'var(--red)';
        return;
    }

    statusEl.textContent = 'Verifying…';
    statusEl.style.color = 'var(--g500)';

    try {
        const raw = await _supaGet(_RESET_SUPABASE_KEY);
        if (!raw) {
            statusEl.textContent = '❌ OTP not found or already used. Request a new one.';
            statusEl.style.color = 'var(--red)';
            _resetOtpPin = ''; _updateOtpDots();
            return;
        }
        const stored = JSON.parse(raw);
        const now = Date.now();
        if (new Date(stored.expiresAt).getTime() < now) {
            statusEl.textContent = '⏰ OTP has expired. Please go back and request a new one.';
            statusEl.style.color = 'var(--amb)';
            try { await _supaDel(_RESET_SUPABASE_KEY); } catch(_e) {}
            _resetOtpPin = ''; _updateOtpDots();
            return;
        }
        if (stored.pin !== _resetOtpPin) {
            statusEl.textContent = '❌ Incorrect OTP. Try again.';
            statusEl.style.color = 'var(--red)';
            _resetOtpPin = ''; _updateOtpDots();
            return;
        }
        // ✅ OTP valid — delete it from Supabase immediately
        try { await _supaDel(_RESET_SUPABASE_KEY); } catch(_e) {}
        statusEl.textContent = '✅ OTP verified!';
        statusEl.style.color = 'var(--grn)';

        // Clear new-password fields and move to step 3
        const np1 = document.getElementById('prm-newpass1');
        const np2 = document.getElementById('prm-newpass2');
        if (np1) np1.value = '';
        if (np2) np2.value = '';
        document.getElementById('prm-newpass-status').textContent = '';
        setTimeout(() => _showResetStep(3), 700);

    } catch(e) {
        statusEl.textContent = '❌ Verification error: ' + (e.message || e);
        statusEl.style.color = 'var(--red)';
        _resetOtpPin = ''; _updateOtpDots();
    }
}

// ── Step 4: set new password (after successful OTP) ───────────────────────────
async function saveResetNewPassword() {
    const np1El     = document.getElementById('prm-newpass1');
    const np2El     = document.getElementById('prm-newpass2');
    const statusEl  = document.getElementById('prm-newpass-status');
    const np1 = (np1El?.value || '').trim();
    const np2 = (np2El?.value || '').trim();

    if (!np1 || np1.length !== 8 || !/^\d{8}$/.test(np1)) {
        statusEl.textContent = '❌ New password must be exactly 8 digits.';
        statusEl.style.color = 'var(--red)';
        return;
    }
    if (np1 !== np2) {
        statusEl.textContent = '❌ Passwords do not match.';
        statusEl.style.color = 'var(--red)';
        return;
    }

    statusEl.textContent = 'Saving…';
    statusEl.style.color = 'var(--g500)';

    const hash = await _hashPassword(np1);
    await _persistPassword(hash);
    if (np1El) np1El.value = '';
    if (np2El) np2El.value = '';

    statusEl.textContent = '✅ Password reset successfully!';
    statusEl.style.color = 'var(--grn)';
    showToast('🔒 Admin password has been reset successfully.');
    setTimeout(() => closePasswordResetFlow(), 1500);
}

// ── New-password keypad entry fields keyboard support ─────────────────────────
document.addEventListener('keydown', e => {
    const modal = document.getElementById('passwordResetModal');
    if (!modal || !modal.classList.contains('visible')) return;
    if (e.key === 'Escape') { e.stopPropagation(); closePasswordResetFlow(); }
}, true);

// =========================================================================
// LEGACY: backward-compat wrappers (used in index.html older buttons)
// =========================================================================
function openEmailResetModal()  { openPasswordResetFlow(); }
function closeEmailResetModal() { closePasswordResetFlow(); }
// sendPasswordResetEmail kept as alias for any inline buttons
function sendPasswordResetEmail() { sendResetOtp(); }
