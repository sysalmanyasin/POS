// =========================================================================
// SETTINGS — branch identity, receipt, billing, thermal, staff, backup
// =========================================================================

// ── Branch identity ──────────────────────────────────────────────────────
const BRANCH_DEFAULTS = { businessName:'', branchName:'Main Branch', counterId:'C-01', operatorName:'Operator', receiptHeader:'' };
function _getBranchIdentity() {
    try { const s = StorageModule.get('pharma_branch_identity'); if (s) return Object.assign({}, BRANCH_DEFAULTS, JSON.parse(s)); } catch(e) {}
    return Object.assign({}, BRANCH_DEFAULTS);
}
function loadBranchIdentity() {
    const bi = _getBranchIdentity();
    const termEl = document.getElementById('printTerminalId');
    const opEl   = document.getElementById('printOperatorId');
    const brEl   = document.getElementById('printBranchName');
    if (termEl) termEl.textContent = bi.counterId;
    if (opEl)   opEl.textContent   = bi.operatorName;
    const receiptTitle = (bi.receiptHeader || bi.businessName || bi.branchName || 'PHARMA POS').toUpperCase();
    if (brEl) brEl.textContent = receiptTitle;
    const appTitle = bi.businessName || bi.branchName || 'Pharma POS';
    const titleEl = document.getElementById('hdrAppTitle'); if (titleEl) titleEl.textContent = appTitle;
    document.title = appTitle + ' — POS';
    const sub = document.getElementById('hdrSubtitle');
    if (sub) sub.textContent = bi.branchName + '  ·  ' + bi.counterId + '  ·  ' + bi.operatorName;
}
function _doSaveBranchIdentity() {
    const businessName  = (document.getElementById('settingBusinessName')?.value  || '').trim();
    const branchName   = (document.getElementById('settingBranchName').value   || '').trim() || BRANCH_DEFAULTS.branchName;
    const counterId    = (document.getElementById('settingCounterId').value     || '').trim() || BRANCH_DEFAULTS.counterId;
    const operatorName = (document.getElementById('settingOperatorName').value  || '').trim() || BRANCH_DEFAULTS.operatorName;
    const receiptHeader = (document.getElementById('settingReceiptHeader') ? (document.getElementById('settingReceiptHeader').value || '').trim() : '');
    StorageModule.set('pharma_branch_identity', JSON.stringify({ businessName, branchName, counterId, operatorName, receiptHeader }));
    if (StorageModule.get('_supabase_sync_on') === 'true') { try { StorageModule.pushLocalToCloudEngine().catch(() => {}); } catch(e) {} }
    loadBranchIdentity(); showToast('✅ Identity settings saved.');
}
function saveBranchIdentity() { requestAdminAccess('SAVE_BRANCH_IDENTITY'); }

// ── Settings form loader ─────────────────────────────────────────────────
function _loadSettingsForm() {
    const bi = _getBranchIdentity();
    const settBiz = document.getElementById('settingBusinessName'); if (settBiz) settBiz.value = bi.businessName || '';
    document.getElementById('settingBranchName').value   = bi.branchName;
    document.getElementById('settingCounterId').value    = bi.counterId;
    document.getElementById('settingOperatorName').value = bi.operatorName;
    const settRH = document.getElementById('settingReceiptHeader'); if (settRH) settRH.value = bi.receiptHeader || '';
    _syncAutoBackupBtn();
    const st = document.getElementById('backupStatus'); if (st) st.textContent = '';
    try {
        const ri = JSON.parse(StorageModule.get('pharma_receipt_info', '{}'));
        document.getElementById('settingReceiptAddress').value = ri.address || '';
        document.getElementById('settingReceiptPhone').value   = ri.phone   || '';
        document.getElementById('settingReceiptFooter').value  = ri.footer  || '';
    } catch(e) {}
    const invPrefixEl = document.getElementById('settingInvPrefix');
    if (invPrefixEl) {
        const dc = _getDeviceCode();
        invPrefixEl.value = dc + '-'; invPrefixEl.readOnly = true;
        invPrefixEl.title = 'Auto-derived from Counter ID.'; invPrefixEl.classList.add('sett-inp-computed');
    }
    document.getElementById('settingCurrencyLabel').value = _getCurrency();
    const md = _getMaxDiscount();
    document.getElementById('settingMaxDiscount').value = md > 0 ? md : '';
    const presets = _getDiscountPresets();
    presets.forEach((v, i) => { document.getElementById('discPreset' + i).value = v; });
    _syncOverstockSettingBtn(); _syncDarkModeBtn(); _syncPaperModeBtn(); _syncThermalSettingsForm(); _syncRequireStaffPinBtn();
    renderStaffListSettings(); _attachReceiptPreviewListeners(); _renderReceiptPreview();
    // Check local flags first; sys_has_password is set by _persistPassword even after
    // sys_admin_pass_hash is wiped to Supabase during startup migration
    const hasPass = !!(
        StorageModule.get('sys_has_password') === 'true' ||
        StorageModule.get('sys_admin_pass_hash') ||
        StorageModule.get('sys_admin_pass')
    );
    const currentAdminPassEl = document.getElementById('currentAdminPasswordInput');
    const oldPassInput       = document.getElementById('oldPassInput');
    const confirmPassEl      = document.getElementById('confirmNewPassInput');
    const secTitle           = document.getElementById('securitySectionTitle');
    const updateBtn          = document.getElementById('updatePassBtn');
    // Show the current-password input only when a password is already set
    if (currentAdminPassEl) currentAdminPassEl.style.display = hasPass ? '' : 'none';
    if (oldPassInput)       oldPassInput.style.display       = 'none'; // superseded by currentAdminPasswordInput
    if (confirmPassEl)      confirmPassEl.style.display      = '';     // always visible
    if (secTitle)  secTitle.textContent  = hasPass ? 'Security — Change Admin Password' : 'Security — Set Admin Password';
    if (updateBtn) updateBtn.textContent = hasPass ? 'Update Password' : 'Set Password';
}

// ── Toggle Settings Drawer ───────────────────────────────────────────────
function toggleSettingsDrawer() {
    const activeViewEl = document.querySelector('.view.active');
    if (activeViewEl && activeViewEl.id === 'settingsView') {
        switchTab('billingView', document.getElementById('tab-billing'));
    } else {
        switchTab('settingsView', document.getElementById('tab-settings'));
    }
}

// ── Receipt settings ─────────────────────────────────────────────────────
function _doSaveReceiptSettings() {
    const info = {
        address: (document.getElementById('settingReceiptAddress').value || '').trim(),
        phone:   (document.getElementById('settingReceiptPhone').value   || '').trim(),
        footer:  (document.getElementById('settingReceiptFooter').value  || '').trim()
    };
    StorageModule.set('pharma_receipt_info', JSON.stringify(info));
    _applyReceiptInfo(); showToast('✅ Receipt settings saved.');
}
function saveReceiptSettings() { requestAdminAccess('SAVE_RECEIPT_SETTINGS'); }

function _doSaveAllSettings() {
    _doSaveBranchIdentity(); _doSaveReceiptSettings(); _doSaveBillingSettings(); _doSaveThermalSettings();
    showToast('✅ All settings saved.');
}
function saveAllSettings() { requestAdminAccess('SAVE_ALL_SETTINGS'); }

function _applyReceiptInfo() {
    try {
        const ri = JSON.parse(StorageModule.get('pharma_receipt_info', '{}'));
        const addrEl   = document.getElementById('printReceiptAddress');
        const phoneEl  = document.getElementById('printReceiptPhone');
        const footerEl = document.getElementById('printReceiptFooter');
        if (addrEl)   addrEl.textContent  = ri.address || 'Community Pharmacy Retail Operations';
        if (phoneEl)  phoneEl.textContent = ri.phone   || 'Lahore, Pakistan';
        if (footerEl) { footerEl.innerHTML = _escHtml(ri.footer || '*** THANK YOU FOR YOUR VISIT ***') + '<br>Medicines once sold will not be exchanged<br>or returned without a valid digital token.'; }
    } catch(e) {}
}

// ── Billing settings ─────────────────────────────────────────────────────
function _doSaveBillingSettings() {
    StorageModule.set('pharma_inv_prefix', _getDeviceCode() + '-');
    const currency = (document.getElementById('settingCurrencyLabel').value || '').trim() || 'Rs.';
    const maxDisc  = parseInt(document.getElementById('settingMaxDiscount').value || '0', 10) || 0;
    const presets  = [0,1,2,3,4].map(i => { const v = parseFloat(document.getElementById('discPreset' + i).value || '0') || 0; return Math.min(100, Math.max(0, v)); });
    StorageModule.set('pharma_currency', currency);
    StorageModule.set('pharma_max_disc', String(maxDisc));
    StorageModule.set('pharma_discount_presets', JSON.stringify(presets));
    renderDiscountPresetButtons(); _updateCurrencyDisplays();
    if (StorageModule.get('_supabase_sync_on') === 'true') { try { StorageModule.pushLocalToCloudEngine().catch(() => {}); } catch(e) {} }
    showToast('✅ Billing settings saved.');
}
function saveBillingSettings() { requestAdminAccess('SAVE_BILLING_SETTINGS'); }
function _updateCurrencyDisplays() { document.querySelectorAll('.cur-lbl').forEach(el => el.textContent = _getCurrency()); calculateBillTotals(); }

// ── Dark mode ─────────────────────────────────────────────────────────────
function _syncDarkModeBtn() {
    const btn = document.getElementById('darkModeToggleBtn'); if (!btn) return;
    const pref = StorageModule.get('pharma_dark_mode');
    btn.classList.remove('dmb-dark', 'dmb-light', 'dmb-auto');
    if (pref === 'dark') { btn.textContent = '🌙 Dark'; btn.classList.add('dmb-dark'); }
    else if (pref === 'light') { btn.textContent = '☀️ Light'; btn.classList.add('dmb-light'); }
    else { btn.textContent = '🌗 Auto'; btn.classList.add('dmb-auto'); }
    const hdrBtn = document.getElementById('hdrDarkModeBtn');
    if (hdrBtn) { if (pref === 'dark') hdrBtn.textContent = '🌙'; else if (pref === 'light') hdrBtn.textContent = '☀️'; else hdrBtn.textContent = '🌗'; }
}
function toggleDarkMode() {
    const pref = StorageModule.get('pharma_dark_mode');
    let next;
    if (!pref || pref === 'auto') next = 'dark';
    else if (pref === 'dark') next = 'light';
    else next = 'auto';
    StorageModule.set('pharma_dark_mode', next);
    _applyDarkMode(); _syncDarkModeBtn();
}
function _applyDarkMode() {
    const pref = StorageModule.get('pharma_dark_mode');
    const root = document.documentElement;
    if (pref === 'dark') root.setAttribute('data-theme', 'dark');
    else if (pref === 'light') root.removeAttribute('data-theme');
    else { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme'); }
}

// ── Paper/print mode ─────────────────────────────────────────────────────
function _syncPaperModeBtn() {
    const btn = document.getElementById('paperModeBtn'); if (!btn) return;
    const mode = StorageModule.get('pharma_paper_mode', 'thermal');
    btn.textContent = mode === 'a4' ? '🖨️ A4 / Full Sheet' : '🧾 Thermal';
    btn.className = 'sett-toggle-btn ' + (mode === 'a4' ? 'sett-toggle-on' : 'sett-toggle-off');
}
function togglePaperMode() {
    const mode = StorageModule.get('pharma_paper_mode', 'thermal');
    StorageModule.set('pharma_paper_mode', mode === 'a4' ? 'thermal' : 'a4');
    _applyPrintMode(); _syncPaperModeBtn();
}
function _applyPrintMode() {
    const mode = StorageModule.get('pharma_paper_mode', 'thermal');
    // Apply print mode class to the thermal wrapper used during window.print()
    const rp = document.getElementById('thermalReceiptPrintWrapper');
    if (rp) { rp.classList.remove('print-thermal', 'print-a4'); rp.classList.add(mode === 'a4' ? 'print-a4' : 'print-thermal'); }
}

// ── Thermal settings ─────────────────────────────────────────────────────
// Keys stored: boldItems, showSubtotal, showDiscount, showOperator, showTerminal, showUnitPrice, showFooter
// (plus legacy showPackDetails for backward compat)
const _THERMAL_DEFAULTS = {
    boldItems: true, showSubtotal: true, showDiscount: true,
    showOperator: true, showTerminal: true, showUnitPrice: true, showFooter: true,
    showPackDetails: false
};
function _getThermalSettings() {
    try {
        const raw = StorageModule.get('pharma_thermal_settings');
        if (raw) return Object.assign({}, _THERMAL_DEFAULTS, JSON.parse(raw));
    } catch(e) {}
    return Object.assign({}, _THERMAL_DEFAULTS);
}

// Map setting key → button ID (matching HTML)
const _THERMAL_BTN_MAP = {
    boldItems:    'printBoldItemsBtn',
    showSubtotal: 'printShowSubtotalBtn',
    showDiscount: 'printShowDiscountBtn',
    showOperator: 'printShowOperatorBtn',
    showTerminal: 'printShowTerminalBtn',
    showUnitPrice:'printShowUnitPriceBtn',
    showFooter:   'printShowFooterBtn'
};

function togglePrintSetting(key) {
    const ts = _getThermalSettings();
    ts[key] = !ts[key];
    StorageModule.set('pharma_thermal_settings', JSON.stringify(ts));
    _syncThermalBtn(key, ts[key]);
}

function _syncThermalBtn(key, value) {
    const btnId = _THERMAL_BTN_MAP[key]; if (!btnId) return;
    const btn = document.getElementById(btnId); if (!btn) return;
    btn.textContent = value ? 'ON' : 'OFF';
    btn.className = 'sett-toggle-btn ' + (value ? 'sett-toggle-on' : 'sett-toggle-off');
}

function _doSaveThermalSettings() {
    // Read selector/font settings
    const selIds = ['settingPaperWidth','settingPageMargin','settingHeaderFont','settingBodyFont',
                    'settingItemFont','settingTotalFont','settingLineSpacing','settingDividerStyle',
                    'settingItemSpacing','settingTrailingSpace'];
    const extra = {};
    selIds.forEach(id => { const el = document.getElementById(id); if (el) extra[id] = el.value; });

    // Read toggle button states
    const ts = _getThermalSettings();
    Object.keys(_THERMAL_BTN_MAP).forEach(key => {
        const btn = document.getElementById(_THERMAL_BTN_MAP[key]);
        if (btn) ts[key] = (btn.textContent.trim() === 'ON');
    });
    Object.assign(ts, extra);
    StorageModule.set('pharma_thermal_settings', JSON.stringify(ts));
    showToast('✅ Printer settings saved.');
}

// Public alias expected by HTML onclick
function saveThermalSettings() { requestAdminAccess('SAVE_THERMAL_SETTINGS'); }

function _syncThermalSettingsForm() {
    const ts = _getThermalSettings();
    // Sync toggle buttons
    Object.keys(_THERMAL_BTN_MAP).forEach(key => _syncThermalBtn(key, ts[key] !== false));
    // Sync select elements
    const selIds = ['settingPaperWidth','settingPageMargin','settingHeaderFont','settingBodyFont',
                    'settingItemFont','settingTotalFont','settingLineSpacing','settingDividerStyle',
                    'settingItemSpacing','settingTrailingSpace'];
    selIds.forEach(id => { const el = document.getElementById(id); if (el && ts[id]) el.value = ts[id]; });
}

function _applyThermalPrintCSS() {
    const ts = _getThermalSettings();
    const w = document.getElementById('thermalReceiptPrintWrapper'); if (!w) return;
    // Apply paper-width as max-width
    const pw = ts['settingPaperWidth'] || ts.paperWidth;
    if (pw) w.style.maxWidth = pw + 'mm';
}

// ── Overstock setting ─────────────────────────────────────────────────────
function _getAllowOverstock() { return StorageModule.get('pharma_allow_overstock') === 'true'; }
function _syncOverstockSettingBtn() {
    const btn = document.getElementById('overstockSettingBtn'); if (!btn) return;
    const on = _getAllowOverstock();
    btn.textContent = on ? '⛔ Overstock: ALLOWED' : '✅ Overstock: BLOCKED';
    btn.className = 'sett-toggle-btn ' + (on ? 'sett-toggle-on' : 'sett-toggle-off');
    btn.style.background = on ? 'var(--amb)' : 'var(--grn)';
}
function _doToggleOverstockSetting() {
    StorageModule.set('pharma_allow_overstock', String(!_getAllowOverstock()));
    _syncOverstockSettingBtn(); showToast('✅ Overstock setting updated.');
}
function toggleOverstockSetting() { requestAdminAccess('TOGGLE_OVERSTOCK'); }

function _getRequireStaffPin() { return StorageModule.get('pharma_require_staff_pin') === 'true'; }
function _syncRequireStaffPinBtn() {
    const btn = document.getElementById('requireStaffPinBtn');
    if (!btn) return;
    const on = _getRequireStaffPin();
    btn.textContent = on ? 'ON' : 'OFF';
    btn.className = 'sett-toggle-btn ' + (on ? 'sett-toggle-on' : 'sett-toggle-off');
}
function _doToggleRequireStaffPin() {
    StorageModule.set('pharma_require_staff_pin', String(!_getRequireStaffPin()));
    _syncRequireStaffPinBtn();
    showToast(_getRequireStaffPin() ? '🔐 PIN required on every bill save.' : '🔓 Bill save PIN disabled.');
}
function toggleRequireStaffPin() { requestAdminAccess('TOGGLE_REQUIRE_STAFF_PIN'); }

// ── Currency / discount helpers ───────────────────────────────────────────
// _getCurrency() is defined once in config.js
function _getMaxDiscount() { return parseInt(StorageModule.get('pharma_max_disc', '0'), 10) || 0; }
function _getDiscountPresets() {
    try { const r = StorageModule.get('pharma_discount_presets'); if (r) return JSON.parse(r); } catch(e) {}
    return [5, 10, 15, 20, 25];
}

// ── Staff list ─────────────────────────────────────────────────────────────
const STAFF_COLORS = ['#0057b8','#1a7a4a','#b45309','#6d28d9','#c0392b','#0891b2','#be185d'];
let activeStaff = null;
let _staffPinBuffer = '';
let _staffPinTarget = null;
const _VALID_RO_STEPS = [0, 5, 10];
let roundOffStep = (function() {
    var saved = parseInt(StorageModule.get('pharma_round_off_step', '0'), 10);
    return _VALID_RO_STEPS.includes(saved) ? saved : 0;
})();

function _getStaffList() {
    try { const raw = StorageModule.get('pharma_staff_list'); if (raw) return JSON.parse(raw); } catch(e) {}
    return [{ id: 1, name: 'Owner', pin: '0000', color: STAFF_COLORS[0], role: 'Owner / Manager' }];
}
function _saveStaffList(list) {
    StorageModule.set('pharma_staff_list', JSON.stringify(list));
    if (StorageModule.get('_supabase_sync_on') === 'true') { _supaSet('pharma_cloud_staff', JSON.stringify(list)).catch(() => {}); }
}
function _updateStaffBadge() { const label = document.getElementById('activeStaffLabel'); if (label) label.textContent = activeStaff ? activeStaff.name : 'Login'; }

let _staffIdsVisible = false;
function toggleShowUserIds() { _staffIdsVisible = !_staffIdsVisible; renderStaffListSettings(); showToast(_staffIdsVisible ? '👁 User IDs are now visible.' : '🔒 User IDs hidden.'); }

function renderStaffListSettings() {
    const list = _getStaffList();
    const el = document.getElementById('staffListSettings'); if (!el) return;
    if (list.length === 0) { el.innerHTML = '<p class="sl-empty">No staff yet.</p>'; return; }
    el.innerHTML = list.map((s, i) =>
        `<div class="sl-row">
            <div class="sl-avatar sl-init" style="background:${s.color||STAFF_COLORS[i%STAFF_COLORS.length]};"></div>
            <div class="sl-info"><div class="sl-name"></div><div class="sl-role"></div></div>
            <div class="sl-actions">
                <button class="sl-btn-pin" onclick="requestStaffPinChange(${i})">🔑 ID</button>
                ${i > 0 ? `<button class="sl-btn-remove" onclick="removeStaffMember(${i})">Remove</button>` : ''}
            </div>
        </div>`
    ).join('');
    el.querySelectorAll(':scope > div').forEach((row, i) => {
        const s = list[i];
        row.querySelector('.sl-init').textContent = s.name.charAt(0).toUpperCase();
        row.querySelector('.sl-name').textContent = s.name;
        const roleEl = row.querySelector('.sl-role');
        roleEl.textContent = (s.role || 'Staff') + ' · User ID: ';
        if (_staffIdsVisible) { const b = document.createElement('b'); b.style.color = '#0891b2'; b.textContent = s.pin; roleEl.appendChild(b); }
        else { roleEl.appendChild(document.createTextNode('•'.repeat(s.pin.length))); }
    });
}

function openStaffLogin() {
    _staffPinBuffer = ''; _updateStaffPinDots(); backToStaffList(); renderStaffPicker();
    const cancelBtn = document.getElementById('staffLoginCancelBtn');
    if (cancelBtn) cancelBtn.style.display = activeStaff ? 'block' : 'none';
    const m = document.getElementById('staffLoginModal'); if (m) m.style.display = 'flex';
}
function closeStaffLogin() {
    if (!activeStaff) { showToast('ℹ️ Please log in with your User ID to continue.', false); return; }
    const m = document.getElementById('staffLoginModal'); if (m) m.style.display = 'none';
}
function renderStaffPicker() {
    const list = _getStaffList();
    const container = document.getElementById('staffPickerList'); if (!container) return;
    container.innerHTML = list.map((s, i) =>
        `<div class="staff-item" onclick="selectStaffForPin(${i})">
            <div class="staff-avatar" style="background:${s.color || STAFF_COLORS[i % STAFF_COLORS.length]}"></div>
            <div><div class="staff-item-name"></div><div class="staff-item-role"></div></div>
        </div>`
    ).join('');
    container.querySelectorAll('.staff-item').forEach((item, i) => {
        const s = list[i];
        item.querySelector('.staff-avatar').textContent  = s.name.charAt(0).toUpperCase();
        item.querySelector('.staff-item-name').textContent = s.name;
        item.querySelector('.staff-item-role').textContent = s.role || 'Staff';
    });
}
function selectStaffForPin(idx) {
    const list = _getStaffList(); _staffPinTarget = list[idx]; _staffPinBuffer = ''; _updateStaffPinDots();
    const lbl = document.getElementById('staffPinNameLabel'); if (lbl) lbl.textContent = _staffPinTarget.name;
    document.getElementById('staffSelectBox').style.display = 'none';
    document.getElementById('staffPinBox').style.display = 'block';
}
function backToStaffList() {
    _staffPinBuffer = ''; _staffPinTarget = null;
    const sel = document.getElementById('staffSelectBox'), pin = document.getElementById('staffPinBox');
    if (sel) sel.style.display = 'block'; if (pin) pin.style.display = 'none';
}
function staffPinKey(d) { if (_staffPinBuffer.length >= 4) return; _staffPinBuffer += d; _updateStaffPinDots(); if (_staffPinBuffer.length === 4) setTimeout(staffPinSubmit, 180); }
function staffPinBack() { _staffPinBuffer = _staffPinBuffer.slice(0,-1); _updateStaffPinDots(); }
function _updateStaffPinDots() { for (let i = 0; i < 4; i++) { const dot = document.getElementById('sPinDot' + i); if (dot) dot.classList.toggle('filled', i < _staffPinBuffer.length); } }
function staffPinSubmit() {
    if (!_staffPinTarget) return;
    if (_isPinLocked('staffLogin')) { showToast('❌ Too many wrong attempts. Wait 30 seconds.', true); return; }
    const _doStaffPinCheck = async () => {
        let match = false;
        if (_staffPinTarget.pinHash) { const h = await _hashPin(_staffPinBuffer); match = h === _staffPinTarget.pinHash; }
        else { match = _staffPinBuffer === _staffPinTarget.pin; }
        if (match) {
            _clearPinFailures('staffLogin');
            activeStaff = _staffPinTarget;
            // FIX: persist staff name for AuditLog.write() fallback and heartbeat
            StorageModule.set('pharma_active_staff_name', activeStaff.name || '');
            _updateStaffBadge(); closeStaffLogin(); showToast('✅ Welcome, ' + activeStaff.name + '!');
            if (typeof _auditWrite === 'function') _auditWrite('LOGIN', 'Staff logged in: ' + activeStaff.name, activeStaff.name);
        } else {
            const locked = _recordPinFailure('staffLogin');
            const pinSec = document.getElementById('staffPinSection');
            if (pinSec) { pinSec.style.animation='none'; void pinSec.offsetWidth; pinSec.style.animation='shake 0.35s ease'; }
            _staffPinBuffer = ''; _updateStaffPinDots();
            if (locked) showToast('❌ 5 wrong attempts — locked for 30 seconds.', true);
            else showToast('❌ Wrong PIN. Try again.', true);
        }
    };
    _doStaffPinCheck();
}

function addNewStaffMember() {
    const nameEl = document.getElementById('newStaffNameInput');
    const pinEl  = document.getElementById('newStaffPinInput');
    const name = (nameEl.value || '').trim(); const pin = (pinEl.value || '').replace(/\D/g, '');
    if (!name) { showToast('❌ Enter a staff name.', true); return; }
    if (!/^\d{4}$/.test(pin)) { showToast('❌ User ID must be exactly 4 digits.', true); return; }
    const list = _getStaffList();
    if (list.find(s => s.name.toLowerCase() === name.toLowerCase())) { showToast('❌ Name already exists.', true); return; }
    if (list.find(s => s.pin === pin)) { showToast('❌ User ID already in use.', true); return; }
    requestAdminAccess('ADD_STAFF_MEMBER', null, { name, pin });
}
function _doAddStaffMember() {
    // FIX: capture extraData into locals BEFORE any async call.
    // closeAuthModal() sets pendingAction = null synchronously after
    // executeProtectedAction() returns, so by the time _hashPin resolves
    // pendingAction is already null — destructuring it throws.
    if (!pendingAction || !pendingAction.extraData) {
        showToast('❌ Staff data lost — please try again.', true); return;
    }
    const { name, pin } = pendingAction.extraData;
    const nameEl = document.getElementById('newStaffNameInput');
    const pinEl  = document.getElementById('newStaffPinInput');
    const list = _getStaffList();
    _hashPin(pin).then(pinHash => {
        list.push({ id: Date.now(), name, pin, pinHash, color: STAFF_COLORS[list.length % STAFF_COLORS.length], role: 'Staff' });
        _saveStaffList(list);
        if (nameEl) nameEl.value = ''; if (pinEl) pinEl.value = '';
        renderStaffListSettings(); showToast('✅ ' + name + ' added.');
    });
}
function removeStaffMember(idx) {
    const list = _getStaffList(); if (idx === 0) { showToast('❌ Cannot remove the Owner.', true); return; }
    requestAdminAccess('REMOVE_STAFF_MEMBER', idx, { name: list[idx].name });
}
function _doRemoveStaffMember() {
    const idx = pendingAction.targetId; const list = _getStaffList();
    if (!list[idx]) { showToast('❌ Staff member not found.', true); return; }
    const name = list[idx].name; list.splice(idx, 1); _saveStaffList(list); renderStaffListSettings(); showToast('✅ ' + name + ' removed.');
}
function requestStaffPinChange(idx) { const list = _getStaffList(); if (!list[idx]) return; requestAdminAccess('CHANGE_STAFF_PIN', idx, { name: list[idx].name }); }
function _openStaffPinChangeModal() {
    const nameEl = document.getElementById('staffPinChangeName');
    const newEl  = document.getElementById('staffNewPinInput');
    const cfmEl  = document.getElementById('staffConfirmPinInput');
    if (nameEl) nameEl.textContent = (pendingAction && pendingAction.extraData) ? pendingAction.extraData.name : '';
    if (newEl)  newEl.value = ''; if (cfmEl) cfmEl.value = '';
    document.getElementById('staffPinChangeModal').style.display = 'flex';
    setTimeout(() => { if (newEl) newEl.focus(); }, 80);
}
function closeStaffPinChangeModal() { document.getElementById('staffPinChangeModal').style.display = 'none'; }
document.addEventListener('keydown', function(ev) {
    if (document.getElementById('staffPinChangeModal').style.display !== 'flex') return;
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); saveStaffPinChange(); }
    else if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); closeStaffPinChangeModal(); }
}, true);
function saveStaffPinChange() {
    const newPin = (document.getElementById('staffNewPinInput').value  || '').replace(/\D/g, '');
    const cfmPin = (document.getElementById('staffConfirmPinInput').value || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(newPin)) { showToast('❌ New User ID must be exactly 4 digits.', true); return; }
    if (newPin !== cfmPin)       { showToast('❌ User IDs do not match.', true); return; }
    const idx = pendingAction.targetId; const list = _getStaffList();
    if (!list[idx]) { showToast('❌ Staff member not found.', true); closeStaffPinChangeModal(); return; }
    if (list.find((s, i) => s.pin === newPin && i !== idx)) { showToast('❌ User ID already in use.', true); return; }
    const name = list[idx].name; list[idx].pin = newPin;
    _hashPin(newPin).then(pinHash => {
        list[idx].pinHash = pinHash; _saveStaffList(list);
        closeStaffPinChangeModal(); renderStaffListSettings(); showToast('✅ User ID updated for ' + name + '.');
    }).catch(() => { _saveStaffList(list); closeStaffPinChangeModal(); renderStaffListSettings(); showToast('✅ User ID updated for ' + name + '.'); });
}

// ── Owner PIN change ──────────────────────────────────────────────────────
function requestOwnerPinChange() { requestAdminAccess('EDIT_OWNER_PIN'); }
function _openOwnerPinChangeModal() {
    const m = document.getElementById('ownerPinChangeModal'); if (!m) return;
    document.getElementById('ownerNewPin1').value = ''; document.getElementById('ownerNewPin2').value = '';
    m.style.display = 'flex'; setTimeout(() => document.getElementById('ownerNewPin1').focus(), 100);
}
function _closeOwnerPinChangeModal() { const m = document.getElementById('ownerPinChangeModal'); if (m) m.style.display = 'none'; }
function _saveOwnerPin() {
    const p1 = (document.getElementById('ownerNewPin1').value || '').replace(/\D/g, '');
    const p2 = (document.getElementById('ownerNewPin2').value || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(p1)) { showToast('❌ User ID must be exactly 4 digits.', true); return; }
    if (p1 !== p2) { showToast('❌ User IDs do not match.', true); return; }
    const list = _getStaffList();
    if (list.find((s, i) => s.pin === p1 && i !== 0)) { showToast('❌ User ID already in use.', true); return; }
    list[0].pin = p1; if (activeStaff && activeStaff.id === list[0].id) activeStaff.pin = p1;
    _hashPin(p1).then(pinHash => {
        list[0].pinHash = pinHash; _saveStaffList(list); _closeOwnerPinChangeModal(); renderStaffListSettings(); showToast('✅ Owner User ID updated successfully.');
    }).catch(() => { _saveStaffList(list); _closeOwnerPinChangeModal(); renderStaffListSettings(); showToast('✅ Owner User ID updated successfully.'); });
}

// ── Bill-save PIN modal ───────────────────────────────────────────────────
let _billPinBuffer = '';
function promptBillSavePinConfirm() {
    _billPinBuffer = ''; _updateBillPinDots();
    const avatarEl = document.getElementById('billConfirmAvatar');
    const nameEl   = document.getElementById('billConfirmName');
    if (avatarEl) { avatarEl.textContent = '🔐'; avatarEl.style.background = '#0057b8'; }
    if (nameEl) nameEl.textContent = 'Enter your User ID to confirm';
    const sec = document.getElementById('billPinSection');
    if (sec) { sec.style.animation = 'none'; void sec.offsetWidth; }
    const sb = document.getElementById('searchBox');
    if (sb) { sb.disabled = true; sb.setAttribute('data-bpin-locked','1'); if (document.activeElement === sb) sb.blur(); }
    document.getElementById('billSavePinModal').style.display = 'flex';
}
function closeBillSavePinModal() {
    document.getElementById('billSavePinModal').style.display = 'none';
    _billPinBuffer = ''; _updateBillPinDots();
    const sb = document.getElementById('searchBox');
    if (sb && sb.getAttribute('data-bpin-locked')) { sb.disabled = false; sb.removeAttribute('data-bpin-locked'); }
}
function billPinKey(d) { if (_billPinBuffer.length >= 4) return; _billPinBuffer += d; _updateBillPinDots(); if (_billPinBuffer.length === 4) setTimeout(_submitBillPin, 180); }
function billPinBack() { _billPinBuffer = _billPinBuffer.slice(0, -1); _updateBillPinDots(); }
document.addEventListener('keydown', function(ev) {
    if (document.getElementById('billSavePinModal').style.display !== 'flex') return;
    ev.stopPropagation();
    if (ev.key >= '0' && ev.key <= '9') { ev.preventDefault(); billPinKey(ev.key); }
    else if (ev.key === 'Backspace')    { ev.preventDefault(); billPinBack(); }
    else if (ev.key === 'Enter')        { ev.preventDefault(); _submitBillPin(); }
    else if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); closeBillSavePinModal(); }
}, true);
function _updateBillPinDots() { for (let i = 0; i < 4; i++) { const dot = document.getElementById('bPinDot' + i); if (dot) dot.classList.toggle('filled', i < _billPinBuffer.length); } }
function _submitBillPin() {
    if (_isPinLocked('billSave')) { showToast('❌ Too many wrong attempts. Wait 30 seconds.', true); return; }
    const list = _getStaffList();
    const _doBillPinCheck = async () => {
        let matched = null;
        for (const s of list) {
            if (s.pinHash) { const h = await _hashPin(_billPinBuffer); if (h === s.pinHash) { matched = s; break; } }
            else if (s.pin === _billPinBuffer) { matched = s; break; }
        }
        if (matched) {
            _clearPinFailures('billSave');
            activeStaff = matched;
            // FIX: persist staff name for AuditLog.write() fallback and heartbeat
            StorageModule.set('pharma_active_staff_name', activeStaff.name || '');
            _updateStaffBadge(); closeBillSavePinModal(); finalizeAndPrintBill();
        } else {
            const locked = _recordPinFailure('billSave');
            const sec = document.getElementById('billPinSection');
            if (sec) { sec.style.animation = 'none'; void sec.offsetWidth; sec.style.animation = 'shake 0.35s ease'; }
            _billPinBuffer = ''; _updateBillPinDots();
            if (locked) showToast('❌ 5 wrong attempts — locked for 30 seconds.', true);
            else showToast('❌ Wrong PIN — bill not saved.', true);
        }
    };
    _doBillPinCheck();
}

// ── Round-Off ─────────────────────────────────────────────────────────────
function _syncRoundOffBtn() {
    const btn = document.getElementById('roundOffToggleBtn'); if (!btn) return;
    if (roundOffStep === 0) { btn.textContent = '⟳ Round-Off: OFF'; btn.classList.remove('active'); }
    else { btn.textContent = '⟳ Round-Off: ' + _getCurrency() + roundOffStep; btn.classList.add('active'); }
}
function cycleRoundOff() {
    const steps = [0, 5, 10]; const cur = steps.indexOf(roundOffStep);
    roundOffStep = steps[(cur + 1) % steps.length];
    StorageModule.set('pharma_round_off_step', String(roundOffStep));
    _syncRoundOffBtn(); calculateBillTotals();
}

// ── Auto-backup ───────────────────────────────────────────────────────────
const AUTO_BACKUP_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_BACKUP_MAX_SLOTS   = 5;
const AUTO_BACKUP_DB_NAME     = 'FDPP_AutoBackups';
let _autoBackupDB = null;
let _autoBackupEnabled = (StorageModule.get('pharma_auto_backup_on', 'true') !== 'false');

function initAutoBackup() {
    const req = indexedDB.open(AUTO_BACKUP_DB_NAME, 1);
    req.onupgradeneeded = e => { const adb = e.target.result; if (!adb.objectStoreNames.contains('backups')) adb.createObjectStore('backups', {keyPath:'id'}); };
    req.onsuccess = e => { _autoBackupDB = e.target.result; setTimeout(_runAutoBackup, AUTO_BACKUP_INTERVAL_MS); };
    req.onerror   = () => {};
}
function _runAutoBackup() {
    if (!_autoBackupDB || !_autoBackupEnabled) { setTimeout(_runAutoBackup, AUTO_BACKUP_INTERVAL_MS); return; }
    try {
        const payload = _buildBackupPayload();
        const id = Date.now();
        const tx = _autoBackupDB.transaction(['backups'], 'readwrite');
        const store = tx.objectStore('backups');
        const putReq = store.put({ id, json: JSON.stringify(payload) });
        putReq.onsuccess = function() {
            store.getAllKeys().onsuccess = function(e2) {
                const keys = e2.target.result.sort((a,b) => a-b);
                if (keys.length > AUTO_BACKUP_MAX_SLOTS) { keys.slice(0, keys.length - AUTO_BACKUP_MAX_SLOTS).forEach(k => store.delete(k)); }
            };
        };
        tx.oncomplete = function() { StorageModule.set('pharma_last_backup_time', String(id)); updateBackupReminderBanner(); };
        tx.onerror = function() {};
    } catch(e) {}
    setTimeout(_runAutoBackup, AUTO_BACKUP_INTERVAL_MS);
}
function _syncAutoBackupBtn() {
    const btn = document.getElementById('autoBackupToggleBtn'); const lbl = document.getElementById('autoBackupBtnLabel');
    if (!btn || !lbl) return;
    btn.style.background = _autoBackupEnabled ? 'var(--grn)' : 'var(--g500)';
    btn.style.color = 'white'; btn.style.border = 'none';
    lbl.textContent = 'Auto-Backup: ' + (_autoBackupEnabled ? 'ON ✓' : 'OFF');
}
function _doToggleAutoBackup() {
    _autoBackupEnabled = !_autoBackupEnabled;
    StorageModule.set('pharma_auto_backup_on', String(_autoBackupEnabled));
    _syncAutoBackupBtn(); showToast('🔄 Auto-Backup ' + (_autoBackupEnabled ? 'enabled' : 'disabled'));
}
function toggleAutoBackup() { requestAdminAccess('TOGGLE_AUTO_BACKUP'); }

// ── Backup reminder banner ────────────────────────────────────────────────
function _formatBackupAge(ts) {
    const diffMs = Date.now() - ts; const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 2)  return 'Just now';
    if (diffMin < 60) return diffMin + ' min ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + (diffHr === 1 ? ' hour ago' : ' hours ago');
    return Math.floor(diffHr / 24) + ' day(s) ago';
}
function updateBackupReminderBanner() {
    const banner = document.getElementById('backupReminderBanner'); if (!banner) return;
    const tsStr = StorageModule.get('pharma_last_backup_time');
    if (!tsStr) { banner.style.display = 'flex'; banner.className = 'bk-red'; banner.textContent = '⚠ No backup on record — click to export a full backup.'; return; }
    const ts = parseInt(tsStr); const diffMin = Math.floor((Date.now()-ts)/60000); const age = _formatBackupAge(ts);
    let cls, icon;
    if (diffMin < 30) { cls = 'bk-green'; icon = '✓ Backup fresh: '; }
    else if (diffMin < 180) { cls = 'bk-amber'; icon = '⚠ Last backup: '; }
    else { cls = 'bk-red'; icon = '⚠ Last backup: '; }
    banner.style.display = 'flex'; banner.className = cls;
    banner.textContent = icon + age + ' — click to manage';
}

// ── Full backup export / import ───────────────────────────────────────────
function _buildBackupPayload() {
    const bi = _getBranchIdentity(); const lsSnapshot = {};
    ['pharma_held_bills','pharma_saved_ledger','pharma_active_cart','pharma_branch_identity',
     'sys_admin_pass_hash','pharma_last_backup_time','pharma_currency','pharma_inv_prefix',
     'pharma_max_disc','pharma_discount_presets','pharma_paper_mode','pharma_dark_mode',
     'pharma_auto_backup_on','pharma_receipt_info','pharma_allow_overstock','pharma_require_staff_pin'].forEach(k => {
        const v = StorageModule.get(k); if (v !== null) lsSnapshot[k] = v;
    });
    return { _meta:{ app:'PharmaPOS', version:1, exportedAt:new Date().toISOString(), branchName:bi.branchName, counterId:bi.counterId, operatorName:bi.operatorName }, inventory:masterInventoryDB, savedInvoices:savedInvoicesLedger, heldBills:temporaryHeldBills, localStorage:lsSnapshot };
}
async function exportFullBackup() {
    try {
        const payload = _buildBackupPayload();
        payload.indexedDB = await exportIndexedDB();
        const json = JSON.stringify(payload, null, 2);
        const now = new Date(); const pad = n => String(n).padStart(2,'0');
        const fname = 'FDPP_BACKUP_' + now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) + '_' + pad(now.getHours()) + '-' + pad(now.getMinutes()) + '.json';
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json],{type:'application/json'})); a.download = fname; a.click(); URL.revokeObjectURL(a.href);
        StorageModule.set('pharma_last_backup_time', String(Date.now())); updateBackupReminderBanner();
        const st = document.getElementById('backupStatus'); if (st) st.textContent = '✓ Saved: ' + new Date().toLocaleTimeString();
        showToast('💾 Backup exported: ' + fname);
    } catch(e) { showToast('❌ Backup failed: ' + e.message, true); }
}
function handleRestoreFileSelected(input) {
    const file = input.files[0]; if (!file) return; input.value = '';
    const reader = new FileReader();
    reader.onload = function(e) {
        let payload;
        try { payload = JSON.parse(e.target.result); } catch(err) { showToast('❌ Invalid file: not valid JSON.', true); return; }
        if (!payload || !payload._meta || !payload._meta.version) { showToast('❌ Invalid backup file format.', true); return; }
        if (!Array.isArray(payload.inventory) || !Array.isArray(payload.savedInvoices)) { showToast('❌ Backup file is incomplete.', true); return; }
        showConfirmModal(
            'Restore Full Backup?\n\nFrom: ' + (payload._meta.exportedAt||'unknown') + '\nBranch: ' + (payload._meta.branchName||'N/A') +
            '\n' + payload.savedInvoices.length + ' invoices · ' + payload.inventory.length + ' items\n\n⚠️ This will replace ALL current data.',
            () => _performRestore(payload), () => showToast('Restore cancelled.'), 'Restore', true
        );
    };
    reader.readAsText(file);
}
function _performRestore(payload) {
    try {
        if (payload.localStorage && typeof payload.localStorage === 'object') {
            Object.entries(payload.localStorage).forEach(([k,v]) => { if (k !== 'sys_admin_pass') StorageModule.set(k, v); });
        }
        const _idb = payload.indexedDB || {};
        const _idbInv  = ((_idb['PharmaInventoryDB'] || {})['inventory']);
        const _idbInvs = ((_idb['PharmaDataDB']      || {})['invoices']);
        const _idbHb   = ((_idb['PharmaDataDB']      || {})['heldBills']);
        masterInventoryDB   = Array.isArray(payload.inventory)     && payload.inventory.length     > 0 ? payload.inventory     : Array.isArray(_idbInv)  && _idbInv.length  > 0 ? _idbInv  : [];
        savedInvoicesLedger = Array.isArray(payload.savedInvoices) && payload.savedInvoices.length > 0 ? payload.savedInvoices : Array.isArray(_idbInvs) && _idbInvs.length > 0 ? _idbInvs : [];
        syncInvoiceCounterFromLedger(savedInvoicesLedger);
        temporaryHeldBills  = Array.isArray(payload.heldBills)     && payload.heldBills.length     > 0 ? payload.heldBills     : Array.isArray(_idbHb)   && _idbHb.length   > 0 ? _idbHb   : [];
        activeCartItems = []; currentlyEditingInvoiceId = null;
        saveInventoryToDB(masterInventoryDB); StorageModule.saveInvoices(savedInvoicesLedger); StorageModule.saveHeldBills(temporaryHeldBills); StorageModule.clearCart();
        loadBranchIdentity(); _applyReceiptInfo(); _applyDarkMode();
        updateStatsCounters(); renderHistoryCards(savedInvoicesLedger); renderInvoiceUI(); updateBackupReminderBanner(); updateHdrStats();
        showToast('✅ Backup restored successfully.');
    } catch(err) { showToast('❌ Restore error: ' + err.message, true); }
}

// ── IDB export ────────────────────────────────────────────────────────────
function exportIndexedDB() {
    return new Promise(resolve => {
        const databases = ['PharmaInventoryDB', 'PharmaDataDB'];
        const result = {}; let remaining = databases.length;
        databases.forEach(name => {
            const req = indexedDB.open(name);
            req.onsuccess = e => {
                const idb = e.target.result; const storeNames = [...idb.objectStoreNames]; result[name] = {};
                if (storeNames.length === 0) { idb.close(); if (--remaining === 0) resolve(result); return; }
                const tx = idb.transaction(storeNames, 'readonly'); let pending = storeNames.length;
                storeNames.forEach(sn => {
                    tx.objectStore(sn).getAll().onsuccess = ev => {
                        result[name][sn] = ev.target.result;
                        if (--pending === 0) { idb.close(); if (--remaining === 0) resolve(result); }
                    };
                });
            };
            req.onerror = () => { result[name] = {}; if (--remaining === 0) resolve(result); };
        });
    });
}

// ── Storage usage ─────────────────────────────────────────────────────────
async function checkStorageUsage() {
    try {
        const banner = document.getElementById('storageWarningBanner'); if (!banner) return;
        const label = document.getElementById('dhStorageLabel'); const bar = document.getElementById('dhStorageBar');
        const est = await StorageModule.estimateUsage();
        const usedMB = (est.usage || 0) / (1024 * 1024); const quotaMB = (est.quota || 500 * 1024 * 1024) / (1024 * 1024);
        const pct = quotaMB > 0 ? (usedMB / quotaMB) * 100 : 0;
        const quotaStr = quotaMB >= 1000 ? (quotaMB / 1024).toFixed(1) + ' GB' : Math.round(quotaMB) + ' MB';
        if (label) label.textContent = usedMB.toFixed(1) + ' MB / ~' + quotaStr;
        if (bar) { const bp = Math.min(pct, 100); bar.style.width = bp + '%'; bar.style.background = bp >= 90 ? 'var(--red)' : bp >= 70 ? 'var(--amb)' : 'var(--grn)'; }
        if (pct >= 90) {
            banner.style.display = 'flex'; banner.style.background = 'var(--red-lt, #fee2e2)'; banner.style.borderColor = 'var(--red, #ef4444)';
            banner.innerHTML = '🚨 Storage at ' + pct.toFixed(0) + '% — EXPORT BACKUP NOW and purge old invoices.' +
                '<button class="storage-banner-btn storage-banner-btn-backup" onclick="exportFullBackup()">Backup</button>' +
                '<button class="storage-banner-btn storage-banner-btn-free" onclick="openPurgeOldModal()">Free Up</button>';
        } else if (pct >= 70) {
            banner.style.display = 'flex'; banner.style.background = 'var(--amb-lt, #fef3c7)'; banner.style.borderColor = 'var(--amb, #f59e0b)';
            banner.innerHTML = '⚠️ Storage at ' + pct.toFixed(0) + '% — Consider exporting a backup.' +
                '<button class="storage-banner-btn storage-banner-btn-backup" onclick="exportFullBackup()">Backup</button>' +
                '<button class="storage-banner-btn storage-banner-btn-free" onclick="openPurgeOldModal()">Free Up</button>';
        } else { banner.style.display = 'none'; }
    } catch(e) {}
}
function openPurgeOldModal() {
    requestAdminAccess('PURGE_OLD_INVOICES');
}
function _openPurgeOldModalConfirmed() {
    const modal = document.getElementById('purgeOldModal'); if (!modal) return;
    const preview = document.getElementById('purgeOldPreview');
    if (preview && typeof savedInvoicesLedger !== 'undefined') preview.textContent = 'You currently have ' + savedInvoicesLedger.length + ' invoice(s) stored.';
    modal.classList.add('visible');
}
function closePurgeOldModal() { const modal = document.getElementById('purgeOldModal'); if (modal) modal.classList.remove('visible'); }
async function executePurgeOld(keepDays) {
    closePurgeOldModal();
    if (typeof savedInvoicesLedger === 'undefined') return;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const toDelete = savedInvoicesLedger.filter(inv => (inv.date || '') < cutoffStr);
    if (toDelete.length === 0) { showToast('ℹ️ No invoices older than ' + keepDays + ' days found.'); return; }
    showConfirmModal(
        'Delete ' + toDelete.length + ' invoice(s) older than ' + keepDays + ' days?\n\nA backup will be downloaded first.',
        async () => {
            try { await exportFullBackup(); } catch(e) { showToast('❌ Backup failed — purge aborted.', true); return; }
            savedInvoicesLedger = savedInvoicesLedger.filter(inv => (inv.date || '') >= cutoffStr);
            try { StorageModule.saveInvoices(savedInvoicesLedger); } catch(e) { showToast('❌ Could not save after purge: ' + (e.message || ''), true); return; }
            if (typeof renderHistoryCards === 'function') renderHistoryCards(savedInvoicesLedger);
            updateStatsCounters(); updateHdrStats(); checkStorageUsage();
            showToast('✅ ' + toDelete.length + ' old invoice(s) deleted. Storage freed.');
        },
        () => showToast('Purge cancelled.'), 'Delete & Free Up', true
    );
}

// ── Data Hub ──────────────────────────────────────────────────────────────
(function() {
    let _isStartupMode = false;

    // ── dhRefreshDevicePanel — populates #dhDeviceList ───────────────────
    window.dhRefreshDevicePanel = async function() {
        const list  = document.getElementById('dhDeviceList');
        const badge = document.getElementById('dhActiveDevicesBadge');
        if (!list) return;
        list.innerHTML = '<div style="font-size:11px;color:var(--g400);padding:8px 0;">⟳ Loading devices…</div>';
        try {
            const raw     = await _supaGet('pharma_devices');
            const devices = raw ? JSON.parse(raw) : [];
            const now     = Date.now();
            const active  = devices.filter(d => d.status !== 'archived' && d.status !== 'purged');
            const activeNowCount = active.filter(d => (now - (d.lastSeen || 0)) < 120000).length;
            if (badge) badge.textContent = '🟢 ' + activeNowCount + ' Active';
            if (active.length === 0) {
                list.innerHTML = '<div style="font-size:11px;color:var(--g400);padding:8px 0;">No active devices found.</div>';
                return;
            }
            active.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
            list.innerHTML = active.map(d => {
                const ageSec      = Math.floor((now - (d.lastSeen || 0)) / 1000);
                const isMe        = d.uuid === _DEVICE_UUID;
                const isMaster    = d.role === 'master';
                const statusClass = ageSec < 120  ? 'dh-dot-active'
                                  : ageSec < 600  ? 'dh-dot-recent'
                                  :                 'dh-dot-offline';
                const statusLabel = ageSec < 120  ? 'Active'
                                  : ageSec < 600  ? 'Recent'
                                  :                 'Offline';
                const agoStr      = ageSec < 5    ? 'just now'
                                  : ageSec < 60   ? ageSec + 's ago'
                                  : ageSec < 3600 ? Math.floor(ageSec / 60) + 'm ago'
                                  :                 Math.floor(ageSec / 3600) + 'h ago';
                const syncScore   = ageSec < 120  ? 100 : ageSec < 600 ? 65 : 30;
                const barColor    = syncScore >= 80 ? '#22c55e' : syncScore >= 50 ? '#f59e0b' : '#ef4444';
                const uuidShort   = (d.uuid || '').slice(0, 8) + '…' + (d.uuid || '').slice(-4);
                const avatarBg    = isMaster ? '#FEF3C7' : '#EFF6FF';
                const avatarColor = isMaster ? '#92400E' : '#1D4ED8';
                const initial     = (d.name || 'D').charAt(0).toUpperCase();
                return `<div class="dh-device-row">
                    <div class="dh-dev-avatar" style="background:${avatarBg};color:${avatarColor};">${initial}</div>
                    <div class="dh-dev-info">
                        <div class="dh-dev-name">${d.name || '—'}${isMaster
                            ? '<span class="dh-role-badge dh-role-master">MASTER</span>'
                            : '<span class="dh-role-badge dh-role-client">CLIENT</span>'}${isMe
                            ? '<span class="dh-this-device">This Device</span>' : ''}</div>
                        <div class="dh-dev-uuid">${uuidShort}</div>
                        <div class="dh-sync-bar-wrap"><div class="dh-sync-bar-fill" style="width:${syncScore}%;background:${barColor};"></div></div>
                    </div>
                    <div class="dh-dev-right">
                        <div class="dh-dev-status"><span class="dh-dot ${statusClass}"></span>${statusLabel}</div>
                        <div class="dh-dev-ago">${agoStr}</div>
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            list.innerHTML = '<div style="font-size:11px;color:var(--red);padding:8px 0;">⚠️ Could not reach cloud — check connection.</div>';
        }
    };

    // ── _dhInitStatusStrip — populates hero status pills & IDB chip ───────
    function _dhInitStatusStrip() {
        // Cloud / Supabase badge
        const cloudBadge = document.getElementById('dhSupabaseBadge');
        if (cloudBadge) {
            cloudBadge.textContent = navigator.onLine ? '☁️ Cloud OK' : '⚠️ Offline';
        }

        // Last-sync badges (hero strip + storage panel)
        const _setSync = function(elId) {
            const el = document.getElementById(elId);
            if (!el) return;
            const ts = StorageModule.get('pharma_last_sync_ts') || localStorage.getItem('pharma_last_backup_time');
            if (!ts) { el.textContent = '🕐 Last sync: never'; return; }
            const ageSec = Math.floor((Date.now() - Number(ts)) / 1000);
            const label  = ageSec < 60   ? ageSec + 's ago'
                         : ageSec < 3600 ? Math.floor(ageSec / 60) + 'm ago'
                         :                 Math.floor(ageSec / 3600) + 'h ago';
            el.textContent = '🕐 Last sync: ' + label;
        };
        _setSync('dhLastSyncBadge');
        _setSync('dhLastSyncStatus');

        // IndexedDB health chip
        const idbEl = document.getElementById('dhIDBStatus');
        if (idbEl) {
            try {
                const r = indexedDB.open('PharmaDataDB');
                r.onsuccess = function() {
                    idbEl.textContent = '🗄 IndexedDB: OK';
                    r.result.close();
                };
                r.onerror = function() {
                    idbEl.textContent = '🗄 IndexedDB: ⚠️ Error';
                    idbEl.style.background = '#fef2f2';
                    idbEl.style.color = '#b91c1c';
                };
            } catch(e) {
                idbEl.textContent = '🗄 IndexedDB: ⚠️ Error';
            }
        }

        // Populate device list
        window.dhRefreshDevicePanel();
    }

    window.openDataHub = function(startupMode) {
        _isStartupMode = !!startupMode;
        const modal    = document.getElementById('dataHubModal');
        const subtitle = document.getElementById('dataHubSubtitle');
        const fn       = document.getElementById('dataHubFooterNote');
        const skipBtn  = document.getElementById('dataHubSkipBtn');
        if (_isStartupMode) {
            subtitle.innerHTML = '<span class="dh-start-badge">⚡ STARTUP REMINDER</span>';
            const tsStr = StorageModule.get('pharma_last_backup_time');
            const diffMin = tsStr ? Math.floor((Date.now()-parseInt(tsStr))/60000) : Infinity;
            fn.textContent = !tsStr ? '⚠️ No backup on record. Export one now.' : diffMin < 30 ? '✓ Backup is fresh (' + _formatBackupAge(parseInt(tsStr)) + '). All good!' : diffMin < 180 ? '⚠ Last backup was ' + _formatBackupAge(parseInt(tsStr)) + '. Consider exporting again.' : '🔴 Last backup was ' + _formatBackupAge(parseInt(tsStr)) + '. Please back up now!';
            skipBtn.textContent = '✓ Continue to Billing';
        } else {
            subtitle.textContent = 'Manage inventory, backups & exports';
            fn.textContent = 'Regular backups protect against data loss from browser clears or storage limits.';
            skipBtn.textContent = 'Skip for now';
        }
        modal.style.display = 'flex';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            modal.classList.add('visible');
            if (typeof refreshDataHubInventoryStats === 'function') refreshDataHubInventoryStats();
            if (typeof checkStorageUsage === 'function') checkStorageUsage();
            _dhInitStatusStrip();
        }));
    };
    window.closeDataHub = function(skipReminder) {
        if (_isStartupMode && skipReminder) StorageModule.set('pharma_dh_reminder_date', new Date().toISOString().split('T')[0]);
        const modal = document.getElementById('dataHubModal'); modal.classList.remove('visible');
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    };
    document.getElementById('dataHubModal').addEventListener('click', e => { if (e.target === document.getElementById('dataHubModal')) closeDataHub(false); });
    window.triggerCSVLoad          = function() { closeDataHub(false); setTimeout(() => requestAdminAccess('CSV_IMPORT'), 350); };
    window.triggerFullBackupExport = function() { closeDataHub(false); setTimeout(() => exportFullBackup(), 300); };
    window.triggerRestoreBackup    = function() { closeDataHub(false); setTimeout(() => document.getElementById('restoreFileInputHeader').click(), 300); };
    document.getElementById('restoreFileInputHeader').addEventListener('change', function() { handleRestoreFileSelected(this); });

    // ── Wire CSV file input ──────────────────────────────────────────────
    document.getElementById('csvFile').addEventListener('change', function() {
        const file = this.files[0];
        this.value = ''; // reset so same file can be reloaded
        if (!file) return;
        _handleCSVImport(file);
    });
})();

// ── CSV Import ────────────────────────────────────────────────────────────
function _handleCSVImport(file) {
    const skipZero = document.getElementById('csvSkipZeroStock')
        ? document.getElementById('csvSkipZeroStock').checked
        : true;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 2) { showToast('❌ CSV is empty or has no data rows.', true); return; }

            // Parse header row — normalise to lowercase, strip BOM/quotes/spaces
            const rawHeader = lines[0].replace(/^\uFEFF/, '');
            const headers = rawHeader.split(',').map(h => h.trim().replace(/"/g, '').replace(/\s+/g, '').toLowerCase());

            // Column index resolver — flexible mapping
            const col = (candidates) => {
                for (const c of candidates) {
                    const idx = headers.indexOf(c);
                    if (idx >= 0) return idx;
                }
                return -1;
            };

            const iCode     = col(['productcode','code','itemcode','sku','barcode','id']);
            const iName     = col(['productname','name','itemname','medicinename','description','product']);
            const iStock    = col(['quantity','stock','qty','qtyinhand','balance','currentstock','units']);
            const iPrice    = col(['retailprice','price','unitprice','salesprice','mrp','rate','sp']);
            const iCostPrice= col(['costprice','purchaseprice','cp','cost','buyprice']);
            const iCompany  = col(['manufacture','manufacturer','company','brand','mfr','mfg']);
            const iGeneric  = col(['genericdetail','generic','genericname','molecule','composition','salt','ingredient']);
            const iSupplier = col(['supplier','vendor','distributor','dist']);
            const iPack     = col(['conversionfactor','pack','packdetails','packsize','packing','packaging']);

            // Diagnostic: show detected columns as toast
            const _diag = ['generic:'+(iGeneric>=0?'✓':'✗'),'company:'+(iCompany>=0?'✓':'✗'),'pack:'+(iPack>=0?'✓':'✗'),'price:'+(iPrice>=0?'✓':'✗')].join(' ');
            showToast('🔍 settings.js cols: ' + _diag, false);
            if (iName < 0) { showToast('❌ CSV must have a "name" column.', true); return; }

            const imported = [];
            let skipped = 0;

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Split respecting quoted commas
                const cells = _splitCSVLine(line);

                const get = (idx) => idx >= 0 && idx < cells.length ? cells[idx].trim().replace(/^"|"$/g, '') : '';

                const name = get(iName);
                if (!name) continue;

                const stockRaw = parseFloat(get(iStock)) || 0;
                if (skipZero && stockRaw === 0) { skipped++; continue; }

                const code = get(iCode) || ('ITEM-' + String(i).padStart(4, '0'));

                const item = {
                    code:        code,
                    name:        name,
                    unitPrice:   parseFloat(get(iPrice))     || 0,
                    costPrice:   parseFloat(get(iCostPrice)) || 0,
                    stock:       Math.max(0, stockRaw),
                    company:     get(iCompany)  || '',
                    generic:     get(iGeneric)  || '',
                    supplier:    get(iSupplier) || '',
                    packDetails: get(iPack)     || ''
                };
                imported.push(item);
            }

            if (imported.length === 0) {
                showToast('❌ No valid rows found in CSV' + (skipZero ? ' (all zero-stock rows skipped).' : '.'), true);
                return;
            }

            // Confirm before replacing
            const skipNote = skipped > 0 ? '\n(' + skipped + ' zero-stock rows skipped)' : '';
            showConfirmModal(
                { title: '📂 Import CSV?',
                  subtitle: imported.length + ' items ready to import.' + skipNote + '\n\nThis will REPLACE your current inventory.' },
                () => {
                    masterInventoryDB = imported;
                    try { saveInventoryToDB(masterInventoryDB); } catch(ex) {}
                    // Clear demo banner if visible
                    const demoBanner = document.getElementById('demoInventoryBanner');
                    if (demoBanner) demoBanner.style.display = 'none';
                    if (typeof updateStatsCounters   === 'function') updateStatsCounters();
                    if (typeof refreshSearchIndex    === 'function') refreshSearchIndex();
                    if (typeof renderInvoiceUI       === 'function') renderInvoiceUI();
                    refreshDataHubInventoryStats();
                    showToast('✅ Imported ' + imported.length + ' items from CSV.');
                },
                null, 'Import', true, 'Cancel'
            );
        } catch(err) {
            showToast('❌ CSV parse error: ' + (err.message || err), true);
        }
    };
    reader.onerror = function() { showToast('❌ Could not read file.', true); };
    reader.readAsText(file);
}

// Splits a single CSV line respecting double-quoted fields containing commas
function _splitCSVLine(line) {
    const result = [];
    let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
        else { cur += ch; }
    }
    result.push(cur);
    return result;
}

// ── Data Hub inventory stats ───────────────────────────────────────────────
function refreshDataHubInventoryStats() {
    const el = document.getElementById('dhInventoryStats');
    const purgeBtn = document.getElementById('dhPurgeZeroBtn');
    const purgeDesc = document.getElementById('dhPurgeZeroDesc');
    if (!el) return;
    const inv = (typeof masterInventoryDB !== 'undefined') ? masterInventoryDB : [];
    const total   = inv.length;
    const inStock = inv.filter(p => (p.stock || 0) > 0).length;
    const zeroStk = inv.filter(p => (p.stock || 0) === 0).length;
    el.innerHTML = total === 0
        ? '<div style="font-size:11px;color:var(--g400);padding:6px 0;">No inventory loaded yet.</div>'
        : `<div style="display:flex;gap:12px;flex-wrap:wrap;padding:6px 0;">
            <span style="font-size:11px;color:var(--g600);">📦 <strong style="color:var(--g900);">${total}</strong> items</span>
            <span style="font-size:11px;color:var(--g600);">✅ <strong style="color:#2e7d32;">${inStock}</strong> in stock</span>
            <span style="font-size:11px;color:var(--g600);">⬜ <strong style="color:#b71c1c;">${zeroStk}</strong> zero-stock</span>
           </div>`;
    if (purgeBtn) purgeBtn.style.display = zeroStk > 0 ? 'flex' : 'none';
    if (purgeDesc) purgeDesc.textContent = 'Remove ' + zeroStk + ' zero-stock item' + (zeroStk !== 1 ? 's' : '') + ' from inventory';
}

// ── Purge zero-stock items ────────────────────────────────────────────────
function purgeZeroStockItems() {
    requestAdminAccess('PURGE_ZERO_STOCK');
}
function _purgeZeroStockConfirmed() {
    const inv = (typeof masterInventoryDB !== 'undefined') ? masterInventoryDB : [];
    const toRemove = inv.filter(p => (p.stock || 0) === 0).length;
    if (toRemove === 0) { showToast('No zero-stock items to remove.'); return; }
    showConfirmModal(
        { title: '🧹 Remove Zero-Stock Items?',
          subtitle: 'This will permanently delete ' + toRemove + ' item' + (toRemove !== 1 ? 's' : '') + ' with stock = 0.' },
        () => {
            masterInventoryDB = inv.filter(p => (p.stock || 0) > 0);
            try { saveInventoryToDB(masterInventoryDB); } catch(e) {}
            if (typeof updateStatsCounters === 'function') updateStatsCounters();
            refreshDataHubInventoryStats();
            showToast('🧹 Removed ' + toRemove + ' zero-stock item' + (toRemove !== 1 ? 's' : '') + '.');
        },
        null, 'Remove', true, 'Cancel'
    );
}

// ── Sync dashboard ────────────────────────────────────────────────────────
async function runSyncDiagnostics() {
    const results = [];
    const pass = (n, m) => results.push({ name:n, status:'PASS', message:m });
    const fail = (n, m) => results.push({ name:n, status:'FAIL', message:m });
    const warn = (n, m) => results.push({ name:n, status:'WARN', message:m });
    const info = (n, m) => results.push({ name:n, status:'INFO', message:m });
    info('Device UUID',   _DEVICE_UUID);
    info('Device Code',   _getDeviceCode());
    info('Sync Enabled',  StorageModule.get('_supabase_sync_on') === 'true' ? 'Yes' : 'No');
    info('Browser Online', navigator.onLine ? 'Yes' : 'No');
    try {
        await new Promise((resolve, reject) => { const req = indexedDB.open('PharmaDataDB'); req.onsuccess = e => { e.target.result.close(); resolve(); }; req.onerror = () => reject(new Error('IDB open failed')); });
        pass('PharmaDataDB', 'Accessible');
    } catch(e) { fail('PharmaDataDB', String(e.message || e)); }
    try {
        await new Promise((resolve, reject) => {
            if (!db) { reject(new Error('inventory db handle is null')); return; }
            try { const req = db.transaction(['inventory_movements'], 'readonly').objectStore('inventory_movements').count(); req.onsuccess = e => { pass('PharmaInventoryDB', 'Accessible — ' + e.target.result + ' movements'); resolve(); }; req.onerror = () => reject(new Error('Movement count failed')); } catch(ex) { reject(ex); }
        });
    } catch(e) { fail('PharmaInventoryDB', String(e.message || e)); }
    if (typeof masterInventoryDB !== 'undefined') {
        const noCode = masterInventoryDB.filter(p => !p.code).length; const negStk = masterInventoryDB.filter(p => (p.stock||0) < 0).length; const tot = masterInventoryDB.length;
        if (noCode > 0)      warn('Inventory', tot + ' products — ' + noCode + ' missing code');
        else if (negStk > 0) warn('Inventory', tot + ' products — ' + negStk + ' with negative stock');
        else                 pass('Inventory', tot + ' products — all codes present, stock ≥ 0');
    } else { fail('Inventory', 'masterInventoryDB not initialised'); }
    if (typeof savedInvoicesLedger !== 'undefined') {
        const noId = savedInvoicesLedger.filter(i => !i.id).length; const tot = savedInvoicesLedger.length;
        if (noId > 0) warn('Invoice Ledger', tot + ' invoices — ' + noId + ' missing id');
        else          pass('Invoice Ledger', tot + ' invoices — all IDs present');
    } else { fail('Invoice Ledger', 'savedInvoicesLedger not initialised'); }
    const qm = (typeof StorageModule !== 'undefined' && StorageModule.syncQueueMetrics) ? StorageModule.syncQueueMetrics() : null;
    if (qm) { if (qm.total === 0) pass('Sync Queue', 'Empty'); else warn('Sync Queue', qm.total + ' pending'); }
    else info('Sync Queue', 'Metrics not available');
    try { await _supaProbe(); pass('Cloud (Supabase)', 'Reachable'); } catch(e) { fail('Cloud (Supabase)', 'Unreachable — ' + (e.message||'probe failed')); }
    return results;
}
async function openSyncDashboard() {
    const old = document.getElementById('syncDashboardOverlay'); if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'syncDashboardOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    function _sdEscHandler(e) { if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); e.stopImmediatePropagation(); overlay.remove(); document.removeEventListener('keydown', _sdEscHandler, true); } }
    document.addEventListener('keydown', _sdEscHandler, true);
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--white').trim()||'#fff', clr = cs.getPropertyValue('--g900').trim()||'#111';
    const muted = cs.getPropertyValue('--g600').trim()||'#6b7280', border = cs.getPropertyValue('--g300').trim()||'#e5e7eb';
    const btnBlu = cs.getPropertyValue('--blu').trim()||'#1565C0';
    const box = document.createElement('div');
    box.style.cssText = 'background:'+bg+';color:'+clr+';border-radius:14px;padding:28px 30px 22px;max-width:580px;width:93%;max-height:82vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.45);font-family:inherit;';
    box.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;"><h2 style="margin:0;font-size:17px;">🔬 Sync Health Dashboard</h2><span id="_sdts" style="font-size:11px;color:'+muted+'">Running…</span></div><div id="_sdres" style="font-size:13px;line-height:1.5;"></div><div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end;"><button onclick="openSyncDashboard()" style="padding:7px 14px;border-radius:8px;border:1px solid '+border+';background:'+bg+';color:'+clr+';cursor:pointer;font-size:13px;">↻ Refresh</button><button onclick="(function(){var o=document.getElementById(\'syncDashboardOverlay\');if(o)o.remove();})()" style="padding:7px 18px;border-radius:8px;border:none;background:'+btnBlu+';color:#fff;cursor:pointer;font-size:13px;font-weight:600;">Close</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    let results; try { results = await runSyncDiagnostics(); } catch(e) { results = [{ name:'Diagnostics', status:'FAIL', message: String(e.message||e) }]; }
    const ICONS = { PASS:'✅', FAIL:'❌', WARN:'⚠️', INFO:'ℹ️' };
    const COLORS = { PASS:'#16a34a', FAIL:'#dc2626', WARN:'#d97706', INFO:'#3b82f6' };
    const el = document.getElementById('_sdres');
    if (el) { el.innerHTML = results.map(r => '<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid '+border+';"><span style="font-size:15px;flex-shrink:0;margin-top:1px;">'+(ICONS[r.status]||'•')+'</span><div style="min-width:0;"><strong style="color:'+(COLORS[r.status]||clr)+'">'+_escHtml(r.name)+'</strong><br><span style="color:'+muted+';word-break:break-all;font-size:12px;">'+_escHtml(String(r.message))+'</span></div></div>').join(''); }
    const ts = document.getElementById('_sdts'); if (ts) ts.textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

// ── Receipt preview attachment ────────────────────────────────────────────
function _attachReceiptPreviewListeners() {
    // Fix 11: Wire live preview to every receipt-related input so the
    // thermal preview re-renders as the operator types, without needing
    // to click Save first.
    const _previewInputIds = [
        'settingBusinessName',
        'settingBranchName',
        'settingReceiptHeader',
        'settingReceiptAddress',
        'settingReceiptPhone',
        'settingReceiptFooter',
        'settingOperatorName',
        'settingCurrencyLabel',
    ];
    _previewInputIds.forEach(function(id) {
        const el = document.getElementById(id);
        if (el && !el._receiptPreviewBound) {
            el.addEventListener('input', _renderReceiptPreview);
            el._receiptPreviewBound = true;
        }
    });
}
function _renderReceiptPreview() {
    _applyReceiptInfo();
    _applyPrintMode();
    _applyThermalPrintCSS();
    // Clone the live thermal wrapper into the settings preview panel
    const src     = document.getElementById('thermalReceiptPrintWrapper');
    const target  = document.getElementById('receiptPreviewPaper');
    if (!src || !target) return;
    const clone = src.cloneNode(true);
    clone.removeAttribute('id');
    clone.style.cssText = 'pointer-events:none;transform-origin:top center;';
    target.innerHTML = '';
    target.appendChild(clone);
}
function _printReceiptIsolated() {
    const rp = document.getElementById('thermalReceiptPrintWrapper'); if (!rp) return;
    const printCopy = rp.cloneNode(true);
    const w = window.open('', '_blank', 'width=400,height=700');
    if (!w) return;
    const css = Array.from(document.styleSheets).reduce((acc, ss) => { try { return acc + Array.from(ss.cssRules).map(r => r.cssText).join('\n'); } catch(e) { return acc; } }, '');
    w.document.write('<!DOCTYPE html><html><head><style>' + css + '</style></head><body>' + printCopy.outerHTML + '</body></html>');
    w.document.close(); setTimeout(() => { try { w.focus(); w.print(); w.close(); } catch(e) {} }, 250);
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVICE MANAGER — Settings Tab (Task 4 UI)
// Card grid + detail drawer rendered inside #deviceManagerSection
// ═══════════════════════════════════════════════════════════════════════════

async function renderSettingsDeviceManager() {
    const grid = document.getElementById('settDeviceGrid');
    if (!grid) return;

    // FIX 2: Removed hard block on _supabase_sync_on. Device Manager should always
    // attempt to load from Supabase — the sync toggle controls background auto-sync,
    // not the ability to view the device list. Show a soft warning banner instead.
    const syncOn = StorageModule.get('_supabase_sync_on') === 'true';

    let bannerHtml = '';
    if (!syncOn) {
        bannerHtml = '<div style="font-size:11px;color:var(--warning,#b45309);background:var(--warning-bg,#fef3c7);border:1px solid var(--warning-border,#fde68a);border-radius:6px;padding:8px 10px;margin-bottom:10px;">⚠️ Cloud Sync is off — device list may be stale. Enable sync in Settings for live data.</div>';
    }

    grid.innerHTML = bannerHtml + '<div style="font-size:11px;color:var(--g400);padding:10px 0;">Loading…</div>';

    try {
        // FIX: Read from the relational `devices` table (was: _supaGet('pharma_devices') KV blob).
        // The KV blob is empty since Phase 6 migrated everything to the relational table.
        const { data: rawDevices, error: devErr } = await _dbSelect(
            'devices',
            'order=last_seen_at.desc',
            'uuid,name,counter_id,role,is_active,last_seen_at,registered_at,today_bills,active_staff'
        );
        if (devErr) throw new Error(devErr.message || JSON.stringify(devErr));

        // Normalize relational rows to the shape _buildSettDevCard expects
        // (last_seen numeric ms, status string, counterId alias)
        const _normalizeDevice = function(d) {
            const lsMs = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
            return Object.assign({}, d, {
                last_seen:  lsMs,
                lastSeen:   lsMs,
                status:     d.is_active ? 'active' : 'archived',
                counterId:  d.counter_id,
                deviceCode: d.counter_id,
            });
        };

        const list = (Array.isArray(rawDevices) ? rawDevices : []).map(_normalizeDevice);
        const _statusOf = (d) => String(d?.status || 'active').trim().toLowerCase();
        const activeDevices  = list.filter(d => d && _statusOf(d) === 'active');
        const archiveDevices = list.filter(d => d && _statusOf(d) !== 'active');

        const now = Date.now();
        // Sort: master first, then own device, then by lastSeen desc
        const sortedActive = [...activeDevices].sort((a, b) => {
            if (a.role === 'master' && b.role !== 'master') return -1;
            if (b.role === 'master' && a.role !== 'master') return  1;
            if (a.uuid === _DEVICE_UUID) return -1;
            if (b.uuid === _DEVICE_UUID) return  1;
            return (b.last_seen || b.lastSeen || 0) - (a.last_seen || a.lastSeen || 0);
        });
        const sortedArchive = [...archiveDevices].sort((a, b) => {
            // Purged first (more critical), then newest-seen
            if (_statusOf(a) === 'purged' && _statusOf(b) !== 'purged') return -1;
            if (_statusOf(b) === 'purged' && _statusOf(a) !== 'purged') return  1;
            return (b.last_seen || b.lastSeen || 0) - (a.last_seen || a.lastSeen || 0);
        });

        if (sortedActive.length === 0 && sortedArchive.length === 0) {
            grid.innerHTML = '<div style="font-size:11px;color:var(--g400);padding:10px 0;text-align:center;">No devices registered yet.</div>';
            return;
        }

        if (typeof window._devArchiveOpen !== 'boolean') window._devArchiveOpen = false;

        grid.innerHTML = '';

        // Active devices section
        const activeWrap = document.createElement('div');
        activeWrap.style.gridColumn = '1 / -1';
        activeWrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0 10px;';
        activeWrap.innerHTML =
            '<div style="font-size:10px;font-weight:900;color:var(--g600);letter-spacing:.6px;text-transform:uppercase;">Active Devices</div>' +
            '<div style="font-size:11px;font-weight:800;color:var(--g500);">' + sortedActive.length + '</div>';
        grid.appendChild(activeWrap);

        if (sortedActive.length === 0) {
            const empty = document.createElement('div');
            empty.style.gridColumn = '1 / -1';
            empty.style.cssText = 'font-size:11px;color:var(--g400);padding:6px 0 12px;';
            empty.textContent = 'No active devices.';
            grid.appendChild(empty);
        } else {
            sortedActive.forEach(d => grid.appendChild(_buildSettDevCard(d, now)));
        }

        // Archive section (archived + purged)
        const archHdr = document.createElement('div');
        archHdr.style.gridColumn = '1 / -1';
        archHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 8px;padding-top:12px;border-top:1px dashed var(--g200);';
        const btnLabel = window._devArchiveOpen ? 'Hide' : 'Show';
        archHdr.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;min-width:0;">' +
              '<div style="font-size:10px;font-weight:900;color:var(--g600);letter-spacing:.6px;text-transform:uppercase;">Archive</div>' +
              '<div style="font-size:10px;font-weight:800;color:var(--g500);white-space:nowrap;">(' + sortedArchive.length + ')</div>' +
              '<div style="font-size:10px;color:var(--g400);font-weight:600;white-space:nowrap;">Archived + Purged</div>' +
            '</div>' +
            '<button id="devArchiveToggleBtn" class="sett-toggle-btn sett-toggle-off" style="height:28px;" type="button">' + btnLabel + '</button>';
        grid.appendChild(archHdr);

        const archiveWrap = document.createElement('div');
        archiveWrap.id = 'settDeviceArchiveWrap';
        archiveWrap.className = 'dev-card-grid';
        archiveWrap.style.gridColumn = '1 / -1';
        archiveWrap.style.display = window._devArchiveOpen ? '' : 'none';
        grid.appendChild(archiveWrap);

        const toggleBtn = archHdr.querySelector('#devArchiveToggleBtn');
        if (toggleBtn) {
            toggleBtn.onclick = () => {
                window._devArchiveOpen = !window._devArchiveOpen;
                archiveWrap.style.display = window._devArchiveOpen ? '' : 'none';
                toggleBtn.textContent = window._devArchiveOpen ? 'Hide' : 'Show';
            };
        }

        if (sortedArchive.length === 0) {
            const empty = document.createElement('div');
            empty.style.gridColumn = '1 / -1';
            empty.style.cssText = 'font-size:11px;color:var(--g400);padding:6px 0;';
            empty.textContent = 'No archived devices.';
            archiveWrap.appendChild(empty);
        } else {
            sortedArchive.forEach(d => archiveWrap.appendChild(_buildSettDevCard(d, now)));
        }

    } catch (e) {
        grid.innerHTML = '<div style="font-size:11px;color:var(--red,#c62828);padding:10px 0;">❌ Failed to load devices: ' + _escHtml(String(e.message || e)) + '</div>';
    }
}

function _buildSettDevCard(d, now) {
    const isMine   = d.uuid === _DEVICE_UUID;
    const lastSeen = d.last_seen || d.lastSeen || 0;
    const diffMs   = lastSeen ? now - lastSeen : Infinity;
    const isOnline = diffMs < 120_000;
    const isRecent = diffMs < 600_000;
    const dotColor = isOnline ? '#22c55e' : isRecent ? '#f59e0b' : '#ef4444';
    const dotLabel = isOnline ? 'Online' : isRecent ? 'Recent' : 'Offline';
    const _status = String(d?.status || 'active').trim().toLowerCase();
    const isPurged = _status === 'purged';
    const isArchived = _status === 'archived';
    const isMaster = d.role === 'master';

    // Relative time string
    const seenMins = lastSeen ? Math.round(diffMs / 60000) : null;
    const agoStr   = seenMins === null  ? 'Never'
                   : seenMins < 1       ? 'Just now'
                   : seenMins < 60      ? seenMins + ' min ago'
                   : seenMins < 1440    ? Math.round(seenMins / 60) + ' hr ago'
                   :                      Math.round(seenMins / 1440) + ' day' + (Math.round(seenMins / 1440) !== 1 ? 's' : '') + ' ago';

    const regDate  = d.registered_at || d.registeredAt
                   ? new Date(d.registered_at || d.registeredAt).toLocaleDateString() : '—';
    const shortId  = (d.uuid || '').slice(0, 8);

    const card = document.createElement('div');
    card.className = 'dev-card' + (isMine ? ' dev-card-mine' : '') + (isPurged ? ' dev-card-purged' : '') + (isMaster && !isPurged ? ' dev-card-master' : '');
    card.title = 'Double-click for full details';
    card.addEventListener('dblclick', () => _openDevDetailDrawer(d));

    // ── Header row ──────────────────────────────────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'dev-card-hdr';
    const namePrefix = isMaster ? '👑 ' : '';
    hdr.innerHTML =
        '<span class="dev-card-dot" style="background:' + dotColor + ';" title="' + dotLabel + '"></span>' +
        '<span class="dev-card-name">' + _escHtml(namePrefix + (d.name || shortId)) + '</span>' +
        '<span class="dev-role-badge dev-role-' + (isMaster ? 'master' : 'client') + '">' + (isMaster ? 'MASTER' : 'CLIENT') + '</span>' +
        (isPurged ? '<span class="dev-role-badge dev-role-purged">PURGED</span>' : '') +
        (isArchived ? '<span class="dev-role-badge" style="background:var(--g200);color:var(--g600);font-weight:800;">ARCHIVED</span>' : '') +
        (isMine   ? '<span class="dev-card-mine-tag">★ THIS DEVICE</span>' : '');

    // ── Info grid ────────────────────────────────────────────────────────
    const info = document.createElement('div');
    info.className = 'dev-card-info';
    [
        ['🕐 Last seen',   agoStr],
        ['📅 Registered',  regDate],
        ['🧾 Bills today', d.today_bills != null ? String(d.today_bills) : '—'],
        ['👤 Active staff',d.active_staff || '—'],
        ['🔑 UUID',        shortId + '…'],
        ['🏪 Counter',     d.counterId || d.deviceCode || d.device_code || '—'],
    ].forEach(([lbl, val]) => {
        const lblEl = document.createElement('span');
        lblEl.className = 'dev-info-lbl';
        lblEl.textContent = lbl;
        const valEl = document.createElement('span');
        valEl.className = 'dev-info-val';
        valEl.textContent = val;
        info.appendChild(lblEl);
        info.appendChild(valEl);
    });

    // ── Action buttons ───────────────────────────────────────────────────
    const acts = document.createElement('div');
    acts.className = 'dev-card-acts';

    if (!isMine && !isPurged && !isArchived) {
        if (!isMaster) {
            const btnM = document.createElement('button');
            btnM.className = 'dev-act-btn dev-act-master';
            btnM.textContent = '👑 Set as Master';
            btnM.onclick = e => { e.stopPropagation(); _settDevSetMaster(d.uuid); };
            acts.appendChild(btnM);
        }
        // Archive (soft-remove / hidden)
        const btnA = document.createElement('button');
        btnA.className = 'dev-act-btn dev-act-archive';
        btnA.textContent = '🗄 Archive Device';
        btnA.onclick = e => { e.stopPropagation(); _settDevArchive(d.uuid, d.name); };
        acts.appendChild(btnA);

        const btnP = document.createElement('button');
        btnP.className = 'dev-act-btn dev-act-purge';
        btnP.textContent = '🗑 Purge Device';
        btnP.onclick = e => { e.stopPropagation(); _settDevPurge(d.uuid, d.name); };
        acts.appendChild(btnP);
    }

    // Restore buttons for archived/purged devices (shown in Archive section)
    if (!isMine && (isArchived || isPurged)) {
        const btnR = document.createElement('button');
        btnR.className = 'dev-act-btn dev-act-sync';
        btnR.textContent = isPurged ? '↩ Move to Active (show)' : '↩ Restore to Active';
        btnR.onclick = e => { e.stopPropagation(); _settDevRestoreToActive(d.uuid, d.name); };
        acts.appendChild(btnR);
    }

    // Master capabilities block
    if (isMaster && !isPurged) {
        const cap = document.createElement('div');
        cap.className = 'dev-master-capabilities';
        cap.innerHTML = '<div class="dev-master-cap-title">👑 Master Device Capabilities</div>' +
            '<div class="dev-master-cap-body">' +
            '✅ Auto-purge inactive devices (&gt;14 days)<br>' +
            '✅ Issue PURGE, RELOAD &amp; SYNC commands<br>' +
            '✅ Promote/demote any device to Master/Client<br>' +
            '✅ Cloud sync authority — source of truth<br>' +
            '✅ Stale-device cleanup runs once daily' +
            '</div>';
        info.after(cap);
    }

    card.appendChild(hdr);
    card.appendChild(info);
    if (acts.childElementCount) card.appendChild(acts);
    return card;
}

// ── Detail Drawer ──────────────────────────────────────────────────────────

function _openDevDetailDrawer(d) {
    const drawer = document.getElementById('devDetailDrawer');
    const body   = document.getElementById('devDetailBody');
    const titleEl= document.getElementById('devDetailTitle');
    if (!drawer || !body) return;

    const now     = Date.now();
    const lastSeen= d.last_seen || d.lastSeen || 0;
    const diffMs  = lastSeen ? now - lastSeen : Infinity;
    const isOnline= diffMs < 120_000;
    const isRecent= diffMs < 600_000;
    const dotClr  = isOnline ? '#22c55e' : isRecent ? '#f59e0b' : '#ef4444';
    const isMine  = d.uuid === _DEVICE_UUID;
    const isPurged= d.status === 'purged';
    const isArchived = d.status === 'archived';
    const isMaster = d.role === 'master';

    titleEl.innerHTML =
        '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + dotClr + ';margin-right:6px;vertical-align:middle;"></span>' +
        _escHtml(((isMaster ? '👑 ' : '') + (d.name || (d.uuid||'').slice(0,8))) + ' — Details');

    const rows = [
        ['Device Name',   d.name          || '—'],
        ['Role',          (d.role         || 'client').toUpperCase()],
        ['Status',        (d.status       || 'active').toUpperCase()],
        ['Connectivity',  isOnline ? 'Online' : isRecent ? 'Recent' : 'Offline'],
        ['Last Seen',     lastSeen ? new Date(lastSeen).toLocaleString() : '—'],
        ['Registered At', (d.registered_at||d.registeredAt) ? new Date(d.registered_at||d.registeredAt).toLocaleString() : '—'],
        ['Bills Today',   d.today_bills != null ? String(d.today_bills) : '—'],
        ['Active Staff',  d.active_staff  || '—'],
        ['Full UUID',     d.uuid          || '—'],
        ['Device Code',   d.deviceCode || d.device_code || '—'],
        ['Counter ID',    d.counterId     || '—'],
        ['Branch Name',   d.branchName || d.branch_name || '—'],
        ['Operator Name', d.operatorName || d.operator_name || '—'],
        ['User Agent',    d.userAgent || d.user_agent || '—'],
    ];

    let html = '<table class="dev-detail-table">';
    rows.forEach(([k, v]) => {
        html += '<tr><td class="dev-dt-lbl">' + _escHtml(k) + '</td><td class="dev-dt-val">' + _escHtml(v) + '</td></tr>';
    });
    html += '</table>';

    if (!isMine && !isPurged && !isArchived) {
        html += '<div class="dev-drawer-acts">';
        if (d.role !== 'master') {
            html += '<button class="dev-act-btn dev-act-master" onclick="_settDevSetMaster(\'' + _escHtml(d.uuid) + '\')">👑 Set as Master</button>';
        }
        html += '<button class="dev-act-btn dev-act-archive" onclick="_settDevArchive(\'' + _escHtml(d.uuid) + '\',\'' + _escHtml(d.name||'') + '\')">🗄 Archive Device</button>';
        html += '<button class="dev-act-btn dev-act-purge" onclick="_settDevPurge(\'' + _escHtml(d.uuid) + '\',\'' + _escHtml(d.name||'') + '\')">🗑 Purge Device</button>';
        html += '</div>';
    }
    if (!isMine && (isPurged || isArchived)) {
        html += '<div class="dev-drawer-acts">';
        html += '<button class="dev-act-btn dev-act-sync" onclick="_settDevRestoreToActive(\'' + _escHtml(d.uuid) + '\',\'' + _escHtml(d.name||'') + '\')">↩ Restore to Active</button>';
        html += '</div>';
    }

    body.innerHTML = html;
    drawer.classList.add('open');
}

function closeDevDetailDrawer() {
    const d = document.getElementById('devDetailDrawer');
    if (d) d.classList.remove('open');
}

// Close drawer on Escape
document.addEventListener('keydown', function(ev) {
    const drawer = document.getElementById('devDetailDrawer');
    if (drawer && drawer.classList.contains('open') && (ev.key === 'Escape' || ev.key === 'Esc')) {
        ev.preventDefault(); ev.stopPropagation();
        closeDevDetailDrawer();
    }
}, true);

// ── Card Actions ───────────────────────────────────────────────────────────

async function _settDevSetMaster(targetUUID) {
    requestAdminAccess('DEVICE_SET_MASTER', targetUUID);
}

async function _settDevSetMasterConfirmed(targetUUID) {
    if (typeof showConfirmModal !== 'function') return;
    showConfirmModal(
        { title: '👑 Set as Master?', subtitle: 'This device will become Master. The current Master will be downgraded to Client.' },
        async () => {
            try {
                // FIX: Use relational table instead of old pharma_devices KV blob
                // Downgrade any existing masters first
                await _dbUpdate('devices', 'role=eq.master', { role: 'client' });
                // Promote target device
                await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(targetUUID), { role: 'master' });
                showToast('👑 Master device updated.');
                closeDevDetailDrawer();
                await renderSettingsDeviceManager();
                if (typeof DevicesModule !== 'undefined' && DevicesModule._refreshDashboard) {
                    const dd = document.getElementById('devicesDashboard');
                    if (dd) DevicesModule._refreshDashboard().catch(() => {});
                }
            } catch (e) { showToast('❌ Failed: ' + (e.message || e), true); }
        },
        null, 'Set as Master', false, 'Cancel', 'amber'
    );
}

async function _settDevPurge(targetUUID, deviceName) {
    requestAdminAccess('DEVICE_PURGE', targetUUID, deviceName);
}

async function _settDevPurgeConfirmed(targetUUID, deviceName) {
    if (typeof showConfirmModal !== 'function') return;
    showConfirmModal(
        {
            title: '🗑 Purge Device?',
            subtitle: 'Sends a PURGE command to "' + _escHtml(deviceName || targetUUID.slice(0,8)) + '". It will clear all local data and lock that screen.'
        },
        async () => {
            try {
                // FIX: Use relational table — mark device inactive
                await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(targetUUID), { is_active: false });

                // Issue PURGE command via DevicesModule (sends command to target device)
                if (typeof DevicesModule !== 'undefined' && DevicesModule.sendCommand) {
                    await DevicesModule.sendCommand(targetUUID, 'PURGE');
                }
                showToast('📨 PURGE command issued.');
                closeDevDetailDrawer();
                await renderSettingsDeviceManager();
                if (typeof DevicesModule !== 'undefined' && DevicesModule._refreshDashboard) {
                    const dd = document.getElementById('devicesDashboard');
                    if (dd) DevicesModule._refreshDashboard().catch(() => {});
                }
            } catch (e) { showToast('❌ Purge failed: ' + (e.message || e), true); }
        },
        null, 'Purge Device', true, 'Cancel'
    );
}

async function _settDevArchive(targetUUID, deviceName) {
    requestAdminAccess('DEVICE_ARCHIVE', targetUUID, deviceName);
}

async function _settDevArchiveConfirmed(targetUUID, deviceName) {
    if (typeof showConfirmModal !== 'function') return;
    showConfirmModal(
        {
            title: '🗄 Archive Device?',
            subtitle:
                'This hides "' + _escHtml(deviceName || targetUUID.slice(0, 8)) + '" from the Device Manager.\n\n' +
                'If the device comes online again, it will auto-reactivate and reappear.'
        },
        async () => {
            try {
                // FIX: Use relational table — mark device inactive
                await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(targetUUID), { is_active: false });
                showToast('🗄 Device archived (hidden).');
                closeDevDetailDrawer();
                await renderSettingsDeviceManager();
            } catch (e) {
                showToast('❌ Archive failed: ' + (e.message || e), true);
            }
        },
        null, 'Archive', true, 'Cancel'
    );
}

async function _settDevRestoreToActive(targetUUID, deviceName) {
    if (typeof showConfirmModal !== 'function') return;
    showConfirmModal(
        {
            title: '↩ Restore Device?',
            subtitle:
                'This will move "' + _escHtml(deviceName || targetUUID.slice(0, 8)) + '" back to Active Devices (visible on the dashboard).\n\n' +
                'Note: If the device was PURGED, it may still require unlocking on that device.'
        },
        async () => {
            try {
                // FIX: Use relational table — mark device active again
                await _dbUpdate('devices', 'uuid=eq.' + encodeURIComponent(targetUUID), { is_active: true });
                showToast('✅ Device restored to Active.');
                closeDevDetailDrawer();
                await renderSettingsDeviceManager();
            } catch (e) {
                showToast('❌ Restore failed: ' + (e.message || e), true);
            }
        },
        null, 'Restore', false, 'Cancel'
    );
}

// Auto-render when settings tab opens — always attempt load regardless of sync toggle
// (FIX 2: removed _supabase_sync_on guard; soft warning shown inside the function instead)
const _origLoadSettingsFormForDevMgr = _loadSettingsForm;
window._loadSettingsForm = function() {
    _origLoadSettingsFormForDevMgr.apply(this, arguments);
    setTimeout(renderSettingsDeviceManager, 50);
};

// ── Startup deferred init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
        renderStaffListSettings();
        _updateStaffBadge();
        // Staff login gate removed — staff login is manual only via the badge button
    }, 0);
});

// =========================================================================
// MASTER RECLAIM
// Allows any device to claim the master role via:
//   1. 8-digit OTP sent via EmailJS (same flow as Global Purge)
//   2. Device self-registers as master in Supabase, all others demoted
// Use case: master device lost/reset, need to promote a client to master.
// =========================================================================

const _MR_OTP_KEY = 'pharma_master_reclaim_otp';
const _MR_OTP_TTL = 10 * 60 * 1000; // 10 min
let   _mrOtpEntered = '';

async function openMasterReclaimModal() {
    _mrOtpEntered = '';
    let modal = document.getElementById('mrModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mrModal';
        modal.innerHTML = `
<style>
.mr-overlay{position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}
.mr-card{background:#fff;width:100%;max-width:520px;max-height:92vh;overflow-y:auto;border-radius:14px;border:2px solid #7c3aed;box-shadow:0 30px 80px rgba(0,0,0,.45);}
.mr-hdr{padding:16px 20px;background:linear-gradient(135deg,#5b21b6,#7c3aed);color:#fff;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;}
.mr-hdr-title{font-size:16px;font-weight:900;}
.mr-hdr-sub{font-size:11px;opacity:.85;margin-top:2px;}
.mr-x{background:rgba(255,255,255,.15);color:#fff;border:none;width:30px;height:30px;border-radius:50%;font-size:18px;cursor:pointer;font-weight:800;}
.mr-body{padding:20px;}
.mr-step-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#5b21b6;margin-bottom:10px;}
.mr-info{background:#f5f3ff;border:1px solid #ddd6fe;color:#4c1d95;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.55;margin-bottom:14px;}
.mr-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;}
.mr-btn{padding:9px 16px;border:none;border-radius:6px;font-size:12px;font-weight:800;cursor:pointer;}
.mr-btn-ghost{background:#f1f5f9;color:#475569;}
.mr-btn-primary{background:#7c3aed;color:#fff;}
.mr-btn-primary:disabled{opacity:.5;cursor:not-allowed;}
.mr-status{font-size:12px;color:#64748b;margin-top:8px;min-height:18px;}
.mr-dots{display:flex;gap:8px;justify-content:center;margin:14px 0;}
.mr-dot{width:18px;height:18px;border-radius:50%;border:2px solid #cbd5e1;background:#fff;transition:all .15s;}
.mr-dot.filled{background:#7c3aed;border-color:#7c3aed;}
.mr-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:280px;margin:0 auto;}
.mr-key{padding:14px 0;font-size:18px;font-weight:800;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;color:#334155;}
.mr-key:hover{background:#e2e8f0;}
.mr-key-back{background:#fef3c7;color:#b45309;}
</style>
<div class="mr-overlay" onclick="if(event.target===this)closeMasterReclaimModal()">
  <div class="mr-card">
    <div class="mr-hdr">
      <div>
        <div class="mr-hdr-title">👑 Master Reclaim</div>
        <div class="mr-hdr-sub">Claim master role on this device via email OTP verification</div>
      </div>
      <button class="mr-x" onclick="closeMasterReclaimModal()">×</button>
    </div>
    <div class="mr-body" id="mrBody"></div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = '';
    _mrRenderStep1();
}

function closeMasterReclaimModal() {
    const m = document.getElementById('mrModal');
    if (m) m.style.display = 'none';
    _mrOtpEntered = '';
}

function _mrRenderStep1() {
    const body = document.getElementById('mrBody');
    if (!body) return;
    const currentRole = (typeof StorageModule !== 'undefined')
        ? (StorageModule.get('pharma_device_role') || 'client') : 'client';
    const deviceName  = (typeof StorageModule !== 'undefined')
        ? (StorageModule.get('pharma_device_name') || 'This Device') : 'This Device';

    body.innerHTML = `
<div class="mr-step-title">Step 1 / 2 — Verify Identity</div>
<div class="mr-info">
  <b>This device:</b> ${_escHtml(deviceName)} &nbsp;·&nbsp; Role: <b>${currentRole.toUpperCase()}</b><br><br>
  An 8-digit OTP will be sent to <b>${_escHtml(RESET_EMAIL_ADDRESS)}</b>.<br>
  After verification, this device will be promoted to <b>Master</b> and all other
  devices will be automatically demoted to Client.
</div>
<div class="mr-actions">
  <button class="mr-btn mr-btn-ghost" onclick="closeMasterReclaimModal()">Cancel</button>
  <button class="mr-btn mr-btn-primary" id="mrSendOtpBtn" onclick="_mrSendOtp()">
    📧 Send OTP to Email
  </button>
</div>
<div class="mr-status" id="mrStatus"></div>`;
}

async function _mrSendOtp() {
    const btn    = document.getElementById('mrSendOtpBtn');
    const status = document.getElementById('mrStatus');
    if (typeof emailjs === 'undefined') {
        status.textContent = '❌ EmailJS not loaded.'; status.style.color = '#dc2626'; return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    status.style.color = '#64748b'; status.textContent = 'Generating OTP…';

    const otp       = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = Date.now() + _MR_OTP_TTL;

    try {
        const ok = await _supaSet(_MR_OTP_KEY, JSON.stringify({ pin: otp, expiresAt }));
        if (!ok) throw new Error('Cloud write failed');
    } catch (e) {
        status.textContent = '❌ Could not save OTP to cloud: ' + (e.message || e);
        status.style.color = '#dc2626';
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
        return;
    }

    const bi = (typeof _getBranchIdentity === 'function') ? _getBranchIdentity() : {};
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email:   RESET_EMAIL_ADDRESS,
            reset_pin:  otp,
            shop_name:  (bi.businessName || bi.branchName || 'Pharma POS') + ' — 👑 MASTER RECLAIM',
            counter_id: (typeof StorageModule !== 'undefined' ? StorageModule.get('pharma_device_name') : '') || '',
            expires_in: '10 minutes'
        }, EMAILJS_PUBLIC_KEY);
        status.textContent = '✅ OTP sent. Check your inbox.'; status.style.color = '#059669';
        setTimeout(_mrRenderStep2, 800);
    } catch (err) {
        try { await _supaDel(_MR_OTP_KEY); } catch (_e) {}
        status.textContent = '❌ Email failed: ' + (err.text || err.message || 'Unknown error');
        status.style.color = '#dc2626';
        if (btn) { btn.disabled = false; btn.textContent = '📧 Send OTP to Email'; }
    }
}

function _mrRenderStep2() {
    _mrOtpEntered = '';
    const body = document.getElementById('mrBody');
    if (!body) return;
    body.innerHTML = `
<div class="mr-step-title">Step 2 / 2 — Enter OTP</div>
<div class="mr-info">Enter the 8-digit code sent to <b>${_escHtml(RESET_EMAIL_ADDRESS)}</b>.</div>
<div class="mr-dots" id="mrOtpDots">
  ${[0,1,2,3,4,5,6,7].map(i => `<div class="mr-dot" id="mrDot${i}"></div>`).join('')}
</div>
<div class="mr-pad">
  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="mr-key" onclick="_mrOtpKey('${n}')">${n}</button>`).join('')}
  <button class="mr-key mr-key-back" onclick="_mrOtpBack()">⌫</button>
  <button class="mr-key" onclick="_mrOtpKey('0')">0</button>
  <button class="mr-key mr-key-back" onclick="_mrOtpClear()">C</button>
</div>
<div class="mr-actions">
  <button class="mr-btn mr-btn-ghost" onclick="closeMasterReclaimModal()">Cancel</button>
</div>
<div class="mr-status" id="mrStatus"></div>`;
}

function _mrOtpKey(d) {
    if (_mrOtpEntered.length >= 8) return;
    _mrOtpEntered += d;
    _mrUpdateDots(_mrOtpEntered.length);
    if (_mrOtpEntered.length === 8) setTimeout(_mrVerifyAndClaim, 180);
}
function _mrOtpBack()  { _mrOtpEntered = _mrOtpEntered.slice(0, -1); _mrUpdateDots(_mrOtpEntered.length); }
function _mrOtpClear() { _mrOtpEntered = ''; _mrUpdateDots(0); }
function _mrUpdateDots(len) {
    for (let i = 0; i < 8; i++) {
        const el = document.getElementById('mrDot' + i);
        if (el) el.classList.toggle('filled', i < len);
    }
}

async function _mrVerifyAndClaim() {
    const status = document.getElementById('mrStatus');
    if (status) { status.textContent = 'Verifying…'; status.style.color = '#64748b'; }
    try {
        const raw = await _supaGet(_MR_OTP_KEY);
        if (!raw) throw new Error('No OTP found — request a new one.');
        const stored = JSON.parse(raw);
        if (!stored || !stored.pin) throw new Error('Invalid OTP record.');
        if (Date.now() > Number(stored.expiresAt || 0)) throw new Error('OTP expired — request a new one.');
        if (String(stored.pin) !== String(_mrOtpEntered)) throw new Error('Incorrect OTP.');

        // Consume OTP immediately
        try { await _supaDel(_MR_OTP_KEY); } catch (_e) {}
        if (status) { status.textContent = '✅ OTP verified. Claiming master role…'; status.style.color = '#059669'; }

        // Step 1: Demote all current master devices in Supabase
        try {
            await _dbUpdate('devices', 'role=eq.master', { role: 'client' });
        } catch (_e) {}

        // Step 2: Upsert this device as master
        const now = new Date().toISOString();
        const deviceName = (typeof StorageModule !== 'undefined')
            ? (StorageModule.get('pharma_device_name') || 'Reclaimed Master') : 'Reclaimed Master';
        const counterId  = (typeof StorageModule !== 'undefined')
            ? (StorageModule.get('pharma_device_counter_id') || 'Main') : 'Main';

        const { error: upsertErr } = await _dbUpsert('devices', [{
            uuid:          _DEVICE_UUID,
            name:          deviceName,
            counter_id:    counterId,
            role:          'master',
            is_active:     true,
            registered_at: now,
            last_seen_at:  now,
            today_bills:   0,
            active_staff:  null
        }], 'uuid');

        if (upsertErr) throw new Error('Supabase write failed: ' + upsertErr);

        // Step 3: Update localStorage
        if (typeof StorageModule !== 'undefined') {
            StorageModule.set('pharma_device_role', 'master');
        }

        // Step 4: Refresh device manager
        if (typeof renderSettingsDeviceManager === 'function') {
            setTimeout(renderSettingsDeviceManager, 300);
        }

        closeMasterReclaimModal();
        if (typeof showToast === 'function')
            showToast('✅ Master role claimed on this device. You are now the Master.', false);

    } catch (e) {
        if (status) {
            status.textContent = '❌ ' + (e.message || 'Verification failed.');
            status.style.color = '#dc2626';
        }
        _mrOtpClear();
    }
}

window.openMasterReclaimModal  = openMasterReclaimModal;
window.closeMasterReclaimModal = closeMasterReclaimModal;
window._mrSendOtp   = _mrSendOtp;
window._mrRenderStep2 = _mrRenderStep2;
window._mrOtpKey    = _mrOtpKey;
window._mrOtpBack   = _mrOtpBack;
window._mrOtpClear  = _mrOtpClear;

