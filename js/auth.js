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
// DEVICE REGISTRATION GATE — New unified flow (replaces master/client setup)
// Any unregistered device must:
//   First launch (no admin PIN set): EmailJS OTP → Set Admin PIN → Device setup
//   Subsequent device (admin PIN exists): Enter Admin PIN → EmailJS OTP → Device setup
// =========================================================================
const _MASTER_SETUP_SUPABASE_KEY = 'pharma_master_setup_pin'; // kept for compat
const _MASTER_DEVICE_KEY = 'pharma_master_device_id';         // kept for compat
let _masterSetupPin = '';
let _generatedMasterPin = '';

/**
 * Called after global purge to check if this should be the master device
 * Sets up the EmailJS PIN distribution flow
 */
// =========================================================================
// UNIFIED DEVICE REGISTRATION GATE
//
// Flow A — First launch (no admin PIN in Supabase):
//   Send EmailJS OTP → Verify OTP → Set 8-digit Admin PIN → Device setup
//
// Flow B — New device (admin PIN already exists):
//   Enter Admin PIN → Send EmailJS OTP → Verify OTP → Device setup
//
// After both flows the device lands on the Device Setup page (name + counter)
// which calls DevicesModule._confirmRegistration() to write to Supabase.
// =========================================================================

// OTP state shared across both flows
const _REG_OTP_KEY = 'pharma_reg_otp';
let _regOtpValue   = '';
let _regPinEntered = ''; // used in Flow B admin-PIN entry step
let _regOtpVerifyFn = null; // set by each OTP step to route auto-submit

/**
 * Entry point — called by devices.js instead of showing the bare
 * registration modal directly.  Decides which flow to use.
 */
async function _startDeviceRegistrationGate() {
    // Must be online
    const online = navigator.onLine;
    if (!online) {
        _showOfflineRegistrationBlock();
        return;
    }
    // Check if an admin PIN already exists in Supabase
    let adminPinExists = false;
    try {
        const h = await _supaGet('pharma_master_password_hash');
        adminPinExists = !!h;
    } catch(e) {}

    if (!adminPinExists) {
        // Flow A — very first launch
        _showRegFlowA_SendOtp();
    } else {
        // Flow B — existing system, need admin PIN first
        _showRegFlowB_AdminPin();
    }
}

// ── Offline block ─────────────────────────────────────────────────────────
function _showOfflineRegistrationBlock() {
    _regRemoveAll();
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div style="position:fixed;inset:0;z-index:30000;background:rgba(15,23,42,.9);display:flex;align-items:center;justify-content:center;padding:16px;">
  <div style="background:#fff;border-radius:14px;padding:32px 24px;width:100%;max-width:380px;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.4);">
    <div style="font-size:48px;margin-bottom:12px;">📡</div>
    <div style="font-size:16px;font-weight:800;color:#1f2937;margin-bottom:8px;">No Internet Connection</div>
    <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:24px;">
      An internet connection is required to register this device.<br>Please connect and refresh.
    </div>
    <button onclick="location.reload()" style="padding:10px 24px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">🔄 Retry</button>
  </div>
</div>`;
    document.body.appendChild(d);
}

function _regRemoveAll() {
    ['regGateModal'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
}

// =========================================================================
// FLOW A — First launch: OTP → Set Admin PIN → Device setup
// =========================================================================
function _showRegFlowA_SendOtp() {
    _regRemoveAll();
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<style>
.rg-overlay{position:fixed;inset:0;z-index:30000;background:rgba(15,23,42,.9);display:flex;align-items:center;justify-content:center;padding:16px;}
.rg-card{background:#fff;border-radius:14px;width:100%;max-width:420px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;}
.rg-hdr{padding:18px 20px;background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;}
.rg-hdr-title{font-size:16px;font-weight:900;}
.rg-hdr-sub{font-size:11px;opacity:.85;margin-top:2px;}
.rg-body{padding:24px;}
.rg-info{font-size:13px;color:#374151;line-height:1.6;margin-bottom:16px;}
.rg-email-chip{display:inline-block;background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:20px;}
.rg-btn{width:100%;padding:11px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;margin-top:8px;}
.rg-btn:disabled{opacity:.5;cursor:not-allowed;}
.rg-status{font-size:12px;margin-top:10px;min-height:18px;text-align:center;}
</style>
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">🏥 First Time Setup</div>
      <div class="rg-hdr-sub">Verify your email to set the Admin PIN</div>
    </div>
    <div class="rg-body">
      <div class="rg-info">Welcome! No admin PIN has been set yet. An OTP will be sent to the owner email to verify identity before setup.</div>
      <div><span class="rg-email-chip">📧 ${RESET_EMAIL_ADDRESS}</span></div>
      <button class="rg-btn" id="rgFlowASendBtn" onclick="_regFlowA_DoSend()">📧 Send OTP to Email</button>
      <div class="rg-status" id="rgFlowAStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
}

async function _regFlowA_DoSend() {
    const btn = document.getElementById('rgFlowASendBtn');
    const st  = document.getElementById('rgFlowAStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    st.style.color = '#6b7280'; st.textContent = 'Generating OTP…';

    const otp = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    try {
        const ok = await _supaSet(_REG_OTP_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Supabase write failed');
    } catch(e) {
        st.style.color = '#dc2626'; st.textContent = '❌ Could not save OTP. Check connection.';
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
        return;
    }
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  'Pharma POS',
            counter_id: 'First Setup',
            expires_in: '10 minutes',
            email_subject: '🔐 PharmaPos — First Setup OTP'
        }, EMAILJS_PUBLIC_KEY);
        st.style.color = '#059669'; st.textContent = '✅ OTP sent! Check your email.';
        setTimeout(() => _showRegFlowA_VerifyOtp(), 1200);
    } catch(err) {
        try { await _supaDel(_REG_OTP_KEY); } catch(_e) {}
        st.style.color = '#dc2626'; st.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown');
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
    }
}

function _showRegFlowA_VerifyOtp() {
    _regRemoveAll();
    _regOtpValue = '';
    _regOtpVerifyFn = _regFlowA_VerifyOtp;
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">🔐 Enter Email OTP</div>
      <div class="rg-hdr-sub">Enter the 8-digit code sent to your email</div>
    </div>
    <div class="rg-body">
      ${_buildOtpKeypad('rgOtp', '_regOtpKey', '_regOtpBack', '_regFlowA_VerifyOtp')}
      <div class="rg-status" id="rgOtpStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
}

async function _regFlowA_VerifyOtp() {
    const st = document.getElementById('rgOtpStatus');
    st.style.color = '#6b7280'; st.textContent = 'Verifying…';
    try {
        const raw = await _supaGet(_REG_OTP_KEY);
        if (!raw) { st.style.color = '#dc2626'; st.textContent = '❌ OTP not found or expired.'; _regOtpValue = ''; _regUpdateDots('rgOtp'); return; }
        const stored = JSON.parse(raw);
        if (new Date(stored.expiresAt).getTime() < Date.now()) {
            await _supaDel(_REG_OTP_KEY).catch(() => {});
            st.style.color = '#d97706'; st.textContent = '⏰ OTP expired. Go back and resend.';
            _regOtpValue = ''; _regUpdateDots('rgOtp'); return;
        }
        if (stored.pin !== _regOtpValue) {
            st.style.color = '#dc2626'; st.textContent = '❌ Incorrect OTP.';
            _regOtpValue = ''; _regUpdateDots('rgOtp'); return;
        }
        await _supaDel(_REG_OTP_KEY).catch(() => {});
        st.style.color = '#059669'; st.textContent = '✅ Verified!';
        setTimeout(() => _showRegFlowA_SetPin(), 800);
    } catch(e) {
        st.style.color = '#dc2626'; st.textContent = '❌ Error: ' + (e.message || e);
        _regOtpValue = ''; _regUpdateDots('rgOtp');
    }
}

function _showRegFlowA_SetPin() {
    _regRemoveAll();
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">🔒 Set Admin PIN</div>
      <div class="rg-hdr-sub">This PIN protects admin actions on all devices</div>
    </div>
    <div class="rg-body">
      <div class="rg-info" style="margin-bottom:12px;">Choose an 8-digit Admin PIN. All registered devices will use this PIN for admin actions.</div>
      <div style="margin-bottom:12px;">
        <label style="font-size:11px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">New Admin PIN (8 digits)</label>
        <input type="password" id="rgSetPin1" maxlength="8" inputmode="numeric" pattern="[0-9]*" placeholder="••••••••"
          style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:18px;text-align:center;letter-spacing:4px;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:11px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">Confirm PIN</label>
        <input type="password" id="rgSetPin2" maxlength="8" inputmode="numeric" pattern="[0-9]*" placeholder="••••••••"
          style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:18px;text-align:center;letter-spacing:4px;box-sizing:border-box;">
      </div>
      <button class="rg-btn" id="rgSetPinBtn" onclick="_regFlowA_SavePin()">✅ Set Admin PIN</button>
      <div class="rg-status" id="rgSetPinStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
    const p1 = document.getElementById('rgSetPin1');
    const p2 = document.getElementById('rgSetPin2');
    if (p1) { p1.focus(); p1.addEventListener('keydown', e => { if (e.key === 'Enter') { p2 && p2.focus(); } }); }
    if (p2) p2.addEventListener('keydown', e => { if (e.key === 'Enter') _regFlowA_SavePin(); });
}

async function _regFlowA_SavePin() {
    const btn = document.getElementById('rgSetPinBtn');
    const st  = document.getElementById('rgSetPinStatus');
    const p1  = (document.getElementById('rgSetPin1')?.value || '').trim();
    const p2  = (document.getElementById('rgSetPin2')?.value || '').trim();
    if (!p1 || p1.length !== 8 || !/^\d{8}$/.test(p1)) { st.style.color = '#dc2626'; st.textContent = '❌ PIN must be exactly 8 digits.'; return; }
    if (p1 !== p2) { st.style.color = '#dc2626'; st.textContent = '❌ PINs do not match.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    st.style.color = '#6b7280'; st.textContent = 'Saving…';
    const hash = await _hashPassword(p1);
    await _persistPassword(hash);
    st.style.color = '#059669'; st.textContent = '✅ Admin PIN saved!';
    setTimeout(() => _showRegDeviceSetup(), 800);
}

// =========================================================================
// FLOW B — Existing system: Enter Admin PIN → Send OTP → Verify → Device setup
// =========================================================================
function _showRegFlowB_AdminPin() {
    _regRemoveAll();
    _regPinEntered = '';
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">🔐 Register This Device</div>
      <div class="rg-hdr-sub">Enter the Admin PIN to begin registration</div>
    </div>
    <div class="rg-body">
      <div class="rg-info" style="margin-bottom:8px;">Enter the 8-digit Admin PIN to prove this is an authorised device.</div>
      ${_buildPinKeypad('rgAdminPin', '_regAdminPinKey', '_regAdminPinBack', '_regFlowB_VerifyPin')}
      <div class="rg-status" id="rgAdminPinStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
}

function _regAdminPinKey(d) {
    if (_regPinEntered.length >= 8) return;
    _regPinEntered += d;
    _regUpdatePinDots('rgAdminPin');
    if (_regPinEntered.length === 8) setTimeout(_regFlowB_VerifyPin, 180);
}
function _regAdminPinBack() { _regPinEntered = _regPinEntered.slice(0, -1); _regUpdatePinDots('rgAdminPin'); }

async function _regFlowB_VerifyPin() {
    const st = document.getElementById('rgAdminPinStatus');
    st.style.color = '#6b7280'; st.textContent = 'Verifying…';
    const ok = await _verifyPassword(_regPinEntered).catch(() => false);
    if (!ok) {
        st.style.color = '#dc2626'; st.textContent = '❌ Incorrect Admin PIN.';
        _regPinEntered = ''; _regUpdatePinDots('rgAdminPin'); return;
    }
    st.style.color = '#059669'; st.textContent = '✅ PIN correct! Sending OTP…';
    setTimeout(() => _showRegFlowB_SendOtp(), 800);
}

function _showRegFlowB_SendOtp() {
    _regRemoveAll();
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">📧 Email Verification</div>
      <div class="rg-hdr-sub">Send OTP to confirm device registration</div>
    </div>
    <div class="rg-body">
      <div class="rg-info">An OTP will be sent to the owner email to confirm this device registration.</div>
      <div><span class="rg-email-chip">📧 ${RESET_EMAIL_ADDRESS}</span></div>
      <button class="rg-btn" id="rgFlowBSendBtn" onclick="_regFlowB_DoSend()">📧 Send OTP to Email</button>
      <div class="rg-status" id="rgFlowBStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
}

async function _regFlowB_DoSend() {
    const btn = document.getElementById('rgFlowBSendBtn');
    const st  = document.getElementById('rgFlowBStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    st.style.color = '#6b7280'; st.textContent = 'Generating OTP…';

    const otp = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    try {
        const ok = await _supaSet(_REG_OTP_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Supabase write failed');
    } catch(e) {
        st.style.color = '#dc2626'; st.textContent = '❌ Could not save OTP. Check connection.';
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
        return;
    }
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  'Pharma POS',
            counter_id: 'Device Registration',
            expires_in: '10 minutes',
            email_subject: '🔐 PharmaPos — Device Registration OTP'
        }, EMAILJS_PUBLIC_KEY);
        st.style.color = '#059669'; st.textContent = '✅ OTP sent! Check your email.';
        setTimeout(() => _showRegFlowB_VerifyOtp(), 1200);
    } catch(err) {
        try { await _supaDel(_REG_OTP_KEY); } catch(_e) {}
        st.style.color = '#dc2626'; st.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown');
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
    }
}

function _showRegFlowB_VerifyOtp() {
    _regRemoveAll();
    _regOtpValue = '';
    _regOtpVerifyFn = _regFlowB_VerifyOtp;
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">🔐 Enter Email OTP</div>
      <div class="rg-hdr-sub">Enter the 8-digit code from your email</div>
    </div>
    <div class="rg-body">
      ${_buildOtpKeypad('rgOtp', '_regOtpKey', '_regOtpBack', '_regFlowB_VerifyOtp')}
      <div class="rg-status" id="rgOtpStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
}

async function _regFlowB_VerifyOtp() {
    const st = document.getElementById('rgOtpStatus');
    st.style.color = '#6b7280'; st.textContent = 'Verifying…';
    try {
        const raw = await _supaGet(_REG_OTP_KEY);
        if (!raw) { st.style.color = '#dc2626'; st.textContent = '❌ OTP not found or expired.'; _regOtpValue = ''; _regUpdateDots('rgOtp'); return; }
        const stored = JSON.parse(raw);
        if (new Date(stored.expiresAt).getTime() < Date.now()) {
            await _supaDel(_REG_OTP_KEY).catch(() => {});
            st.style.color = '#d97706'; st.textContent = '⏰ OTP expired.';
            _regOtpValue = ''; _regUpdateDots('rgOtp'); return;
        }
        if (stored.pin !== _regOtpValue) {
            st.style.color = '#dc2626'; st.textContent = '❌ Incorrect OTP.';
            _regOtpValue = ''; _regUpdateDots('rgOtp'); return;
        }
        await _supaDel(_REG_OTP_KEY).catch(() => {});
        st.style.color = '#059669'; st.textContent = '✅ Verified!';
        setTimeout(() => _showRegDeviceSetup(), 800);
    } catch(e) {
        st.style.color = '#dc2626'; st.textContent = '❌ Error: ' + (e.message || e);
        _regOtpValue = ''; _regUpdateDots('rgOtp');
    }
}

// =========================================================================
// SHARED — OTP keypad helpers + Device Setup page
// =========================================================================

function _regOtpKey(d) {
    if (_regOtpValue.length >= 8) return;
    _regOtpValue += d;
    _regUpdateDots('rgOtp');
    if (_regOtpValue.length === 8 && _regOtpVerifyFn) setTimeout(_regOtpVerifyFn, 180);
}
function _regOtpBack() { _regOtpValue = _regOtpValue.slice(0, -1); _regUpdateDots('rgOtp'); }

function _regUpdateDots(prefix) {
    const len = _regOtpValue.length;
    for (let i = 0; i < 8; i++) {
        const el = document.getElementById(prefix + 'Dot' + i);
        if (el) el.classList.toggle('filled', i < len);
    }
}
function _regUpdatePinDots(prefix) {
    const len = _regPinEntered.length;
    for (let i = 0; i < 8; i++) {
        const el = document.getElementById(prefix + 'Dot' + i);
        if (el) el.classList.toggle('filled', i < len);
    }
}

function _buildOtpKeypad(dotPrefix, keyFn, backFn, submitFn) {
    return `
<div style="display:flex;gap:8px;justify-content:center;margin:16px 0;">
  ${[...Array(8)].map((_, i) => `<div id="${dotPrefix}Dot${i}" style="width:12px;height:12px;border-radius:50%;background:#e5e7eb;transition:all 150ms;" class="rg-dot"></div>`).join('')}
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button onclick="${keyFn}('${n}')" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">${n}</button>`).join('')}
  <button onclick="${backFn}()" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">⌫</button>
  <button onclick="${keyFn}('0')" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">0</button>
  <button onclick="void(0)" style="padding:12px;border:1px solid transparent;background:transparent;cursor:default;"></button>
</div>`;
}

function _buildPinKeypad(dotPrefix, keyFn, backFn, submitFn) {
    return `
<div style="display:flex;gap:8px;justify-content:center;margin:16px 0;">
  ${[...Array(8)].map((_, i) => `<div id="${dotPrefix}Dot${i}" style="width:12px;height:12px;border-radius:50%;background:#e5e7eb;transition:all 150ms;" class="rg-dot"></div>`).join('')}
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button onclick="${keyFn}('${n}')" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">${n}</button>`).join('')}
  <button onclick="${backFn}()" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">⌫</button>
  <button onclick="${keyFn}('0')" style="padding:12px;border:1px solid #d1d5db;background:#f9fafb;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;">0</button>
  <button onclick="${submitFn}()" style="padding:12px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">✓</button>
</div>`;
}

/** Final step: collect device name + counter ID then register */
function _showRegDeviceSetup() {
    _regRemoveAll();
    const d = document.createElement('div');
    d.id = 'regGateModal';
    d.innerHTML = `
<div class="rg-overlay">
  <div class="rg-card">
    <div class="rg-hdr">
      <div class="rg-hdr-title">📱 Device Setup</div>
      <div class="rg-hdr-sub">Name this device and set a counter ID</div>
    </div>
    <div class="rg-body">
      <div class="rg-info" style="margin-bottom:16px;">Almost done! Give this device a name and counter ID to start working.</div>
      <div style="margin-bottom:12px;">
        <label style="font-size:11px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">Device Name</label>
        <input id="rgDevName" type="text" placeholder="e.g. Main Counter, Pharmacy Desk…" maxlength="40" autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:11px;font-weight:700;color:#374151;display:block;margin-bottom:4px;">Counter ID</label>
        <input id="rgDevCounter" type="text" placeholder="e.g. C-01, MAIN, POS-2…" maxlength="20" autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box;">
      </div>
      <div id="rgDevErr" style="font-size:11px;color:#dc2626;min-height:16px;margin-bottom:8px;"></div>
      <button class="rg-btn" id="rgDevSaveBtn" onclick="_regDeviceSetup_Save()">✅ Start Working</button>
      <div class="rg-status" id="rgDevStatus"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(d);
    const inp = document.getElementById('rgDevName');
    if (inp) {
        inp.focus();
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const ci = document.getElementById('rgDevCounter'); if (ci && !ci.value.trim()) ci.focus(); else _regDeviceSetup_Save(); }
        });
    }
    const ci = document.getElementById('rgDevCounter');
    if (ci) ci.addEventListener('keydown', e => { if (e.key === 'Enter') _regDeviceSetup_Save(); });
}

async function _regDeviceSetup_Save() {
    const btn = document.getElementById('rgDevSaveBtn');
    const err = document.getElementById('rgDevErr');
    const st  = document.getElementById('rgDevStatus');
    const name      = (document.getElementById('rgDevName')?.value || '').trim();
    const counterId = (document.getElementById('rgDevCounter')?.value || '').trim();

    if (!name || name.length < 2) { if (err) err.textContent = 'Enter a device name (at least 2 characters).'; return; }
    if (!counterId) { if (err) err.textContent = 'Enter a counter ID.'; return; }
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Registering…'; }
    st.style.color = '#6b7280'; st.textContent = 'Connecting to cloud…';

    try {
        // Check device limit
        const { data: allDevs } = await _dbSelect('devices', 'is_active=eq.true', 'uuid');
        const MAX_DEVICES = 10;
        if (allDevs && allDevs.length >= MAX_DEVICES) {
            if (err) err.textContent = `❌ Max ${MAX_DEVICES} devices allowed. Ask admin to remove a device first.`;
            if (btn) { btn.disabled = false; btn.textContent = '✅ Start Working'; }
            st.textContent = '';
            return;
        }

        // Determine role: first device is master if none active
        const { data: masterDevs } = await _dbSelect('devices', 'role=eq.master&is_active=eq.true', 'uuid');
        const role = (!masterDevs || masterDevs.length === 0) ? 'master' : 'client';

        const now = new Date().toISOString();
        const { error } = await _dbUpsert('devices', {
            uuid: _DEVICE_UUID, name, counter_id: counterId,
            role, registered_at: now, last_seen_at: now, is_active: true
        }, 'uuid');

        if (error) {
            if (err) err.textContent = '❌ Registration failed: ' + error;
            if (btn) { btn.disabled = false; btn.textContent = '✅ Start Working'; }
            st.textContent = '';
            return;
        }

        StorageModule.set('pharma_device_name', name);
        StorageModule.set('pharma_device_role', role);
        StorageModule.set('pharma_device_counter_id', counterId);
        StorageModule.set('pharma_device_registered', 'true');

        // Update branch identity counter
        try {
            const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
            bi.counterId = counterId;
            localStorage.setItem('pharma_branch_identity', JSON.stringify(bi));
        } catch(_e) {}

        st.style.color = '#059669'; st.textContent = '✅ Registered! Loading…';
        setTimeout(() => {
            _regRemoveAll();
            location.reload();
        }, 1200);

    } catch(e) {
        if (err) err.textContent = '❌ Unexpected error: ' + (e.message || e);
        if (btn) { btn.disabled = false; btn.textContent = '✅ Start Working'; }
        st.textContent = '';
    }
}

// ── Dot fill helper shared across all steps ───────────────────────────────
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('rg-dot')) e.preventDefault();
});
// Inject shared dot CSS once
(function _injectRegDotCss() {
    if (document.getElementById('regDotStyle')) return;
    const s = document.createElement('style');
    s.id = 'regDotStyle';
    s.textContent = '.rg-dot.filled{background:#0f766e!important;box-shadow:0 0 8px rgba(15,118,110,.5);}';
    document.head.appendChild(s);
})();

// ── Backward-compat stubs (called from old code paths, now no-ops or rerouted) ─
function _checkAndInitMasterSetup() { /* removed — registration gate handles this */ }
function _showMasterDeviceSetupModal() { _startDeviceRegistrationGate(); }
function _showClientDeviceSetupModal() { _startDeviceRegistrationGate(); }
function _showFirstLaunchPasswordSetup() { _startDeviceRegistrationGate(); }
async function saveFirstLaunchPassword() { /* removed — flow A handles this */ }
function _migratePasswordOnStartup() { /* removed — no startup login gate */ }


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
