// =========================================================================
// settings.js — App-wide Settings, Purge Control & Backup
// BUG 2 FIX:  Staff CRUD wired to saveStaffMember() from auth.js (write-through
//             to Supabase pharma_sync, master-only, hashed credentials).
// BUG 6 FIX:  Local purge cascades through all IDB stores via
//             StorageModule.purgeAllLocalData() before redirecting.
// =========================================================================

// ── Branch identity ───────────────────────────────────────────────────────
let _branchIdentity = {};
let _receiptSettings = {};
let _billingSettings = {};
let _thermalSettings = {};
let roundOffStep = 0;
let _discountPresets = [0, 5, 10, 15, 20];
let _darkMode = false;

function _getBranchIdentity()  { return structuredClone(_branchIdentity); }
function _getDiscountPresets() { return [..._discountPresets]; }

function loadBranchIdentity() {
    try {
        const raw = localStorage.getItem('pharma_branch_identity');
        if (raw) _branchIdentity = JSON.parse(raw);
    } catch(e) { _branchIdentity = {}; }

    // Receipt settings
    try {
        const raw = StorageModule.get('pharma_receipt_settings');
        if (raw) _receiptSettings = JSON.parse(raw);
    } catch(e) { _receiptSettings = {}; }

    // Billing settings
    try {
        const raw = StorageModule.get('pharma_billing_settings');
        if (raw) {
            _billingSettings = JSON.parse(raw);
            const rs = parseFloat(_billingSettings.roundOffStep || '0');
            roundOffStep = isFinite(rs) ? rs : 0;
        }
    } catch(e) { _billingSettings = {}; }

    // Thermal settings
    try {
        const raw = StorageModule.get('pharma_thermal_settings');
        if (raw) _thermalSettings = JSON.parse(raw);
    } catch(e) { _thermalSettings = {}; }

    // Discount presets
    try {
        const raw = StorageModule.get('pharma_discount_presets');
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) _discountPresets = arr;
        }
    } catch(e) {}

    // Dark mode
    _darkMode = StorageModule.get('pharma_dark_mode') === '1';
    _applyDarkMode();

    // Populate UI if visible
    _populateSettingsUI();
    _applyReceiptInfo();
    _applyThermalPrintCSS();
    if (typeof _syncRoundOffBtn === 'function') _syncRoundOffBtn();

    // Start auto-backup timer with saved interval (default 15 min)
    setTimeout(_startAutoBackupTimer, 3000);
}

// =========================================================================
// SETTINGS DRAWER
// =========================================================================
function toggleSettingsDrawer() {
    const drawer = document.getElementById('settingsDrawer');
    if (!drawer) return;
    const isOpen = drawer.classList.contains('open');
    if (isOpen) {
        drawer.classList.remove('open');
    } else {
        _populateSettingsUI();
        drawer.classList.add('open');
    }
}

function _populateSettingsUI() {
    const bi = _branchIdentity;
    _setInputVal('settingBusinessName',  bi.businessName   || '');
    _setInputVal('settingBranchName',    bi.branchName     || '');
    _setInputVal('settingLicenseNo',     bi.licenseNo      || '');
    _setInputVal('settingCounterId',     bi.counterId      || '');
    _setInputVal('settingPhone',         bi.phone          || '');
    _setInputVal('settingAddress',       bi.address        || '');
    _setInputVal('settingTagLine',       bi.tagLine        || '');
    _setInputVal('settingCurrency',      StorageModule.get('pharma_currency') || 'Rs.');
    _setInputVal('settingRoundOffStep',  String(roundOffStep || ''));
    _setInputVal('settingAutoBackupInterval', StorageModule.get('pharma_auto_backup_interval') || '0');

    // Receipt settings
    const rs = _receiptSettings;
    _setInputVal('settingReceiptHeader',  rs.header  || '');
    _setInputVal('settingReceiptFooter',  rs.footer  || '');

    // Discount presets
    _discountPresets.forEach((v, i) => _setInputVal('discPreset' + i, String(v)));

    // Dark mode toggle
    const dm = document.getElementById('settingDarkModeToggle');
    if (dm) dm.checked = _darkMode;

    // Populate staff list
    _renderStaffList();
}

function _setInputVal(id, val) {
    const el = document.getElementById(id);
    if (el) {
        if (el.type === 'checkbox') el.checked = val === 'true' || val === true || val === 1;
        else el.value = val;
    }
}

// ── Save handlers (admin-gated) ───────────────────────────────────────────
function saveBranchIdentity() {
    requestAdminAccess('SAVE_BRANCH_IDENTITY');
}

async function _doSaveBranchIdentity() {
    const newBi = {
        businessName: (document.getElementById('settingBusinessName')?.value  || '').trim(),
        branchName:   (document.getElementById('settingBranchName')?.value    || '').trim(),
        licenseNo:    (document.getElementById('settingLicenseNo')?.value     || '').trim(),
        counterId:    (document.getElementById('settingCounterId')?.value     || '').trim(),
        phone:        (document.getElementById('settingPhone')?.value         || '').trim(),
        address:      (document.getElementById('settingAddress')?.value       || '').trim(),
        tagLine:      (document.getElementById('settingTagLine')?.value       || '').trim()
    };

    _branchIdentity = newBi;
    try { localStorage.setItem('pharma_branch_identity', JSON.stringify(newBi)); } catch(e) {}

    const currency = document.getElementById('settingCurrency')?.value || 'Rs.';
    StorageModule.set('pharma_currency', currency);

    const roRaw = parseFloat(document.getElementById('settingRoundOffStep')?.value || '0');
    roundOffStep = isFinite(roRaw) ? roRaw : 0;
    _billingSettings.roundOffStep = String(roundOffStep);
    StorageModule.set('pharma_billing_settings', JSON.stringify(_billingSettings));

    const abInt = document.getElementById('settingAutoBackupInterval')?.value || '0';
    StorageModule.set('pharma_auto_backup_interval', abInt);

    _receiptSettings.header = document.getElementById('settingReceiptHeader')?.value || '';
    _receiptSettings.footer = document.getElementById('settingReceiptFooter')?.value || '';
    StorageModule.set('pharma_receipt_settings', JSON.stringify(_receiptSettings));

    _discountPresets = [];
    for (let i = 0; i < 5; i++) {
        const v = parseFloat(document.getElementById('discPreset' + i)?.value || '0');
        _discountPresets.push(isNaN(v) ? 0 : v);
    }
    StorageModule.set('pharma_discount_presets', JSON.stringify(_discountPresets));

    _applyReceiptInfo();
    if (typeof _syncRoundOffBtn === 'function') _syncRoundOffBtn();
    if (typeof renderDiscountPresetButtons === 'function') renderDiscountPresetButtons();

    // Sync settings to cloud
    const settingsPayload = {
        branchIdentity: newBi,
        currency,
        billingSettings: _billingSettings,
        receiptSettings: _receiptSettings,
        discountPresets: _discountPresets
    };
    try { await _supaSet('pharma_cloud_settings', JSON.stringify(settingsPayload)); } catch(e) {}

    // Restart auto-backup timer with new interval
    _startAutoBackupTimer();

    // Audit log
    if (typeof _auditWrite === 'function') _auditWrite('SETTINGS', 'Branch settings saved: ' + newBi.businessName);

    if (typeof showToast === 'function') showToast('✅ Settings saved.');
    toggleSettingsDrawer();
}

// =========================================================================
// BUG 2 FIX — Staff Management UI
// =========================================================================
function _renderStaffList() {
    const container = document.getElementById('staffListContainer');
    if (!container) return;

    const staff = _loadStaffLocal();
    if (staff.length === 0) {
        container.innerHTML = '<div style="color:var(--g400);font-size:11px;padding:8px;">No staff registered.</div>';
        return;
    }

    container.innerHTML = staff.map(s => `
        <div class="staff-list-row" style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--g100);">
            <div style="flex:1;">
                <div style="font-size:12px;font-weight:700;">${_escHtml(s.name)}</div>
                <div style="font-size:10px;color:var(--g500);">@${_escHtml(s.username)} · ${_escHtml(s.role || 'cashier')}</div>
            </div>
            <button onclick="openEditStaffModal('${_escHtml(s.username)}')"
                style="font-size:10px;padding:4px 8px;border:1px solid var(--g300);border-radius:4px;background:var(--g100);cursor:pointer;">Edit</button>
            <button onclick="confirmDeleteStaff('${_escHtml(s.username)}')"
                style="font-size:10px;padding:4px 8px;border:none;border-radius:4px;background:var(--red);color:#fff;cursor:pointer;">Del</button>
        </div>`).join('');
}

function openAddStaffModal() {
    const myRole = StorageModule.get('pharma_device_role');
    if (myRole !== 'master') { if (typeof showToast === 'function') showToast('⚠️ Only the master device can manage staff.', true); return; }
    _openStaffModal(null);
}

function openEditStaffModal(username) {
    const myRole = StorageModule.get('pharma_device_role');
    if (myRole !== 'master') { if (typeof showToast === 'function') showToast('⚠️ Only the master device can manage staff.', true); return; }
    const staff  = _loadStaffLocal();
    const member = staff.find(s => s.username === username);
    _openStaffModal(member || null);
}

function _openStaffModal(existing) {
    let modal = document.getElementById('staffEditModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'staffEditModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:18000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(modal);
    }

    const isEdit = !!(existing && existing.username);
    modal.innerHTML = `
<div style="background:var(--white);border-radius:12px;padding:24px;width:380px;max-width:94vw;box-shadow:0 16px 48px rgba(0,0,0,.3);">
    <div style="font-size:15px;font-weight:800;margin-bottom:14px;">${isEdit ? '✏️ Edit Staff' : '➕ Add Staff Member'}</div>
    <input id="seName" type="text" placeholder="Full name" value="${isEdit ? _escHtml(existing.name) : ''}"
        style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
    <input id="seUsername" type="text" placeholder="Username" value="${isEdit ? _escHtml(existing.username) : ''}"
        style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;"
        ${isEdit ? 'readonly' : ''}>
    <input id="sePassword" type="password" placeholder="${isEdit ? 'New password (leave blank to keep)' : 'Password'}"
        style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
    <input id="sePin" type="password" placeholder="${isEdit ? 'New PIN (4–6 digits, leave blank to keep)' : 'PIN (4–6 digits)'}" inputmode="numeric"
        style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
    <select id="seRole" style="width:100%;border:1.5px solid var(--g300);border-radius:6px;padding:9px;font-size:13px;margin-bottom:14px;box-sizing:border-box;">
        <option value="cashier"  ${isEdit && existing.role === 'cashier'  ? 'selected' : ''}>Cashier</option>
        <option value="supervisor" ${isEdit && existing.role === 'supervisor' ? 'selected' : ''}>Supervisor</option>
        <option value="pharmacist" ${isEdit && existing.role === 'pharmacist' ? 'selected' : ''}>Pharmacist</option>
        <option value="admin"    ${isEdit && existing.role === 'admin'    ? 'selected' : ''}>Admin</option>
    </select>
    <div id="seErr" style="font-size:11px;color:var(--red);min-height:14px;margin-bottom:8px;"></div>
    <div style="display:flex;gap:8px;">
        <button onclick="document.getElementById('staffEditModal').style.display='none'"
            style="flex:1;height:36px;border:1px solid var(--g300);border-radius:6px;background:var(--g100);font-size:12px;font-weight:700;cursor:pointer;">Cancel</button>
        <button onclick="_submitStaffSave()"
            style="flex:1;height:36px;border:none;border-radius:6px;background:var(--teal);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">
            ${isEdit ? '💾 Update' : '✅ Add Staff'}
        </button>
    </div>
</div>`;
    modal.style.display = 'flex';
    document.getElementById('seName').focus();
}

async function _submitStaffSave() {
    const name     = (document.getElementById('seName')?.value     || '').trim();
    const username = (document.getElementById('seUsername')?.value || '').trim();
    const password = (document.getElementById('sePassword')?.value || '').trim();
    const pin      = (document.getElementById('sePin')?.value      || '').trim();
    const role     = document.getElementById('seRole')?.value || 'cashier';
    const errEl    = document.getElementById('seErr');

    if (!name || name.length < 2) { if (errEl) errEl.textContent = 'Name is required.'; return; }
    if (!username)                  { if (errEl) errEl.textContent = 'Username is required.'; return; }

    const { ok, error } = await saveStaffMember({ name, username, password: password || undefined, pin: pin || undefined, role });

    if (!ok) { if (errEl) errEl.textContent = '❌ ' + (error || 'Save failed.'); return; }

    document.getElementById('staffEditModal').style.display = 'none';
    _renderStaffList();
    if (typeof showToast === 'function') showToast('✅ Staff member saved.');
}

async function confirmDeleteStaff(username) {
    if (!username) return;
    if (typeof showConfirmModal === 'function') {
        showConfirmModal(
            { title: 'Remove Staff', subtitle: 'Remove @' + username + ' from staff? This cannot be undone.' },
            async () => {
                const { ok, error } = await deleteStaffMember(username);
                if (ok) { _renderStaffList(); if (typeof showToast === 'function') showToast('✅ Staff removed.'); }
                else    { if (typeof showToast === 'function') showToast('❌ ' + (error || 'Delete failed.'), true); }
            },
            null, 'Remove', true
        );
    }
}

// =========================================================================
// BACKUP & RESTORE
// =========================================================================
async function exportFullBackup(silent) {
    const invoices = await StorageModule.loadInvoices();
    const inventory = window.masterInventoryDB || [];
    const staff     = _loadStaffLocal();
    const settings  = {
        branchIdentity:  _branchIdentity,
        receiptSettings: _receiptSettings,
        billingSettings: _billingSettings,
        thermalSettings: _thermalSettings,
        discountPresets: _discountPresets,
        currency:        StorageModule.get('pharma_currency')
    };

    const payload = {
        version:    'DuaPharmaPos-v1',
        exportedAt: new Date().toISOString(),
        deviceUuid: _DEVICE_UUID,
        invoices,
        inventory,
        staff,
        settings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'DuaPharmaPos_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    StorageModule.set('pharma_last_backup_time', String(Date.now()));
    if (!silent && typeof showToast === 'function') showToast('✅ Backup exported.');
}

function importFullBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.version || !data.version.startsWith('DuaPharmaPos')) {
                if (typeof showToast === 'function') showToast('❌ Invalid backup file.', true);
                return;
            }

            if (typeof showConfirmModal === 'function') {
                showConfirmModal(
                    { title: 'Import Backup', subtitle: 'Overwrite local data with backup from ' + (data.exportedAt || '?') + '?' },
                    async () => {
                        if (data.invoices  && Array.isArray(data.invoices))   { await StorageModule.saveInvoices(data.invoices); window.savedInvoicesLedger = data.invoices; }
                        if (data.inventory && Array.isArray(data.inventory))  { window.masterInventoryDB = data.inventory; saveInventoryToDB(data.inventory); }
                        if (data.staff     && Array.isArray(data.staff))      { await _saveStaffWriteThrough(data.staff); }
                        if (data.settings) {
                            if (data.settings.branchIdentity)  { _branchIdentity = data.settings.branchIdentity; localStorage.setItem('pharma_branch_identity', JSON.stringify(_branchIdentity)); }
                            if (data.settings.receiptSettings) { _receiptSettings = data.settings.receiptSettings; StorageModule.set('pharma_receipt_settings', JSON.stringify(_receiptSettings)); }
                            if (data.settings.discountPresets) { _discountPresets = data.settings.discountPresets; StorageModule.set('pharma_discount_presets', JSON.stringify(_discountPresets)); }
                            if (data.settings.currency) StorageModule.set('pharma_currency', data.settings.currency);
                        }
                        StorageModule.set('pharma_last_backup_time', String(Date.now()));
                        if (typeof showToast === 'function') showToast('✅ Backup imported. Refreshing…');
                        setTimeout(() => location.reload(), 1200);
                    },
                    null, 'Import & Overwrite', true
                );
            }
        } catch(err) {
            if (typeof showToast === 'function') showToast('❌ Backup parse error: ' + err.message, true);
        }
    };
    reader.readAsText(file);
}

// =========================================================================
// BUG 6 FIX — Local Purge Cascade
// Wipes all IDB stores + localStorage + memory caches + device row.
// =========================================================================
async function _triggerLocalPurge() {
    if (typeof showToast === 'function') showToast('⚠️ Local purge started…');

    // 1. Wipe all IDB stores
    try { await StorageModule.purgeAllLocalData(); } catch(e) { console.warn('[Purge] IDB wipe error:', e); }

    // 2. Clear localStorage (all pharma_ keys)
    const allKeys = Object.keys(localStorage);
    allKeys.forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });

    // 3. Drop device row from Supabase
    try { await _dbDelete('devices', 'uuid=eq.' + encodeURIComponent(_DEVICE_UUID)); } catch(e) {}

    // 4. Clear memory caches
    if (typeof masterInventoryDB !== 'undefined') try { masterInventoryDB.length = 0; } catch(e) {}
    if (typeof savedInvoicesLedger !== 'undefined') try { savedInvoicesLedger.length = 0; } catch(e) {}

    // 5. Mark post-purge flag
    try { localStorage.setItem('pharma_post_purge', '1'); } catch(e) {}

    if (typeof showToast === 'function') showToast('✅ Purge complete. Reloading…');
    setTimeout(() => { location.href = location.origin + location.pathname; }, 1500);
}

function confirmLocalPurge() {
    if (typeof showConfirmModal !== 'function') { _triggerLocalPurge(); return; }
    showConfirmModal(
        { title: '⚠️ Wipe Local Data', subtitle: 'This will delete ALL local invoices, inventory, and settings from this device. Cloud data (if synced) will remain intact.' },
        () => requestAdminAccess('LOCAL_PURGE'),
        null, 'WIPE LOCAL DATA', true
    );
}

// =========================================================================
// UI HELPERS
// =========================================================================
function _applyDarkMode() {
    document.documentElement.classList.toggle('dark', _darkMode);
}

function _applyReceiptInfo() {
    const bi = _branchIdentity;
    const _setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _setText('printBizName',   bi.businessName || bi.branchName || '');
    _setText('printAddress',   bi.address      || '');
    _setText('printPhone',     bi.phone        || '');
    _setText('printLicenseNo', bi.licenseNo    || '');
    _setText('printTagLine',   bi.tagLine      || '');
    const header = (_receiptSettings.header || '').trim();
    const footer = (_receiptSettings.footer || '').trim();
    const hEl = document.getElementById('printReceiptHeader');
    const fEl = document.getElementById('printReceiptFooter');
    if (hEl) { hEl.textContent = header; hEl.style.display = header ? '' : 'none'; }
    if (fEl) { fEl.textContent = footer; fEl.style.display = footer ? '' : 'none'; }
}

function _applyThermalPrintCSS() {
    const ts = _thermalSettings;
    const el = document.getElementById('thermalCssBlock');
    if (!el) return;
    const w = ts.paperWidth || '80mm';
    el.textContent = `
        @media print {
            body { width: ${w}; font-size: ${ts.fontSize || '10pt'}; }
            .no-print { display: none !important; }
        }`;
}

function _applyPrintMode() {}

function _syncRoundOffBtn() {
    const btn = document.getElementById('roundOffToggle');
    if (!btn) return;
    btn.textContent  = roundOffStep > 0 ? '⚡ RO:' + roundOffStep : '⚡ No R/O';
    btn.style.opacity = roundOffStep > 0 ? '1' : '0.55';
}

function renderDiscountPresetButtons() {
    const container = document.getElementById('discountPresetBtns');
    if (!container) return;
    container.innerHTML = _discountPresets
        .filter(v => v >= 0)
        .map((v, i) => `<button class="disc-preset-btn" onclick="applyPresetDiscount(${i})">${v}%</button>`)
        .join('');
}

// ── Storage usage check ───────────────────────────────────────────────────
function checkStorageUsage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(({ usage, quota }) => {
        const pct = Math.round((usage / quota) * 100);
        const banner = document.getElementById('storageWarnBanner');
        if (!banner) return;
        if (pct > 85) {
            banner.style.display = 'flex';
            banner.textContent = '⚠️ Storage ' + pct + '% full. Export a backup or purge old data.';
        } else {
            banner.style.display = 'none';
        }
    });
}

// =========================================================================
// SCHEDULED AUTO-BACKUP — fires every N minutes (default 15)
// The interval field in Settings stores the number of minutes.
// A value of 0 disables the timer. Timer restarts whenever settings are saved.
// =========================================================================
let _autoBackupTimer = null;

function _startAutoBackupTimer() {
    if (_autoBackupTimer) { clearInterval(_autoBackupTimer); _autoBackupTimer = null; }
    const raw     = parseInt(StorageModule.get('pharma_auto_backup_interval') || '15', 10);
    const minutes = (isFinite(raw) && raw > 0) ? raw : 15;   // fallback: 15 min
    const ms      = minutes * 60 * 1000;

    _autoBackupTimer = setInterval(async () => {
        try {
            await exportFullBackup(true);   // silent = no toast
            if (typeof _auditWrite === 'function') _auditWrite('BACKUP', 'Auto-backup fired (every ' + minutes + ' min)', null);
            // Show a subtle one-time toast so the user knows it happened
            if (typeof showToast === 'function') showToast('💾 Auto-backup saved (' + minutes + ' min interval).');
        } catch(e) {
            console.warn('[AutoBackup] Failed:', e.message);
        }
    }, ms);

    console.log('[AutoBackup] Timer started — every', minutes, 'minutes.');
}

// ── openDataHub stub (used by billing.js auto-backup reminder) ────────────
function openDataHub(auto) {
    if (!auto || typeof showToast !== 'function') return;
    StorageModule.set('pharma_dh_reminder_date', new Date().toISOString().split('T')[0]);
    showToast('💾 Reminder: back up your data via Settings → Export Backup.');
}

// ── Quick add / product modal stub ───────────────────────────────────────
function openQuickAdd() {
    const inv = document.getElementById('tab-inventory');
    if (inv) inv.click();
}
