// =========================================================================
// setup.js — Welcome screen, mode selection, credential setup, SQL schema
// Runs AFTER DOM is ready. Controls the #welcome-screen and #setup-screen
// overlays. Reads/writes pharma_mode, pharma_supa_url, pharma_supa_key,
// pharma_emailjs_* keys in localStorage.
// =========================================================================

(function PharmaSetup() {

  // ── SQL Schema for Supabase ──────────────────────────────────────────────
  const SUPABASE_SQL_SCHEMA = `-- ============================================================
-- Pharma POS — Supabase Schema
-- Paste this entire block into your Supabase SQL Editor
-- and click "Run". Then reload your app.
-- ============================================================

-- 1. KV sync table (used by auth, settings, device keys)
CREATE TABLE IF NOT EXISTS pharma_sync (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Device registry
CREATE TABLE IF NOT EXISTS devices (
  uuid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT,
  counter_id    TEXT,
  role          TEXT DEFAULT 'client',
  is_active     BOOLEAN DEFAULT true,
  last_seen     TIMESTAMPTZ DEFAULT now(),
  registered_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Invoices
CREATE TABLE IF NOT EXISTS invoices (
  uuid               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     TEXT UNIQUE NOT NULL,
  customer_name      TEXT DEFAULT '',
  customer_phone     TEXT DEFAULT '',
  total_amount       NUMERIC(12,2) DEFAULT 0,
  discount_amount    NUMERIC(12,2) DEFAULT 0,
  billed_at          TIMESTAMPTZ DEFAULT now(),
  device_uuid        UUID,
  counter_id         TEXT DEFAULT '',
  staff_name         TEXT DEFAULT '',
  line_items         JSONB DEFAULT '[]',
  is_fully_refunded  BOOLEAN DEFAULT false,
  is_edit            BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- 4. Invoice line items (for relational join queries)
CREATE TABLE IF NOT EXISTS invoice_items (
  id              BIGSERIAL PRIMARY KEY,
  invoice_number  TEXT NOT NULL REFERENCES invoices(invoice_number) ON DELETE CASCADE,
  product_code    TEXT NOT NULL,
  product_name    TEXT DEFAULT '',
  qty             NUMERIC(10,3) DEFAULT 1,
  unit_price      NUMERIC(12,2) DEFAULT 0,
  subtotal        NUMERIC(12,2) DEFAULT 0,
  UNIQUE (invoice_number, product_code)
);

-- 5. Inventory / product catalogue
CREATE TABLE IF NOT EXISTS inventory (
  uuid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name  TEXT NOT NULL,
  product_code  TEXT UNIQUE NOT NULL,
  generic_name  TEXT DEFAULT '',
  pack_size     TEXT DEFAULT '',
  price         NUMERIC(12,2) DEFAULT 0,
  stock_qty     NUMERIC(10,3) DEFAULT 0,
  category      TEXT DEFAULT '',
  vendor        TEXT DEFAULT '',
  expiry_date   DATE,
  version       BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 6. Inventory movements (audit trail for stock changes)
CREATE TABLE IF NOT EXISTS inventory_movements (
  uuid            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_uuid    UUID,
  product_code    TEXT,
  change_qty      NUMERIC(10,3) NOT NULL,
  reason          TEXT DEFAULT '',
  invoice_number  TEXT,
  device_uuid     UUID,
  counter_id      TEXT DEFAULT '',
  moved_at        TIMESTAMPTZ DEFAULT now()
);

-- 7. Sync log (heartbeat records per device)
CREATE TABLE IF NOT EXISTS sync_log (
  id               BIGSERIAL PRIMARY KEY,
  device_uuid      UUID,
  invoices_pushed  INT DEFAULT 0,
  invoices_pulled  INT DEFAULT 0,
  movements_pushed INT DEFAULT 0,
  movements_pulled INT DEFAULT 0,
  note             TEXT DEFAULT '',
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── RPC: atomic inventory deduction ─────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_inventory_atomic(
  p_product_code    TEXT,
  p_quantity        NUMERIC,
  p_invoice_number  TEXT,
  p_device_uuid     UUID  DEFAULT NULL,
  p_counter_id      TEXT  DEFAULT '',
  p_is_refund       BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_stock NUMERIC;
  v_new_stock     NUMERIC;
  v_product_uuid  UUID;
BEGIN
  SELECT uuid, stock_qty INTO v_product_uuid, v_current_stock
  FROM inventory WHERE product_code = p_product_code FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'product_not_found');
  END IF;

  IF p_is_refund THEN
    v_new_stock := v_current_stock + p_quantity;
  ELSE
    v_new_stock := v_current_stock - p_quantity;
  END IF;

  UPDATE inventory
  SET stock_qty = v_new_stock,
      version   = version + 1,
      updated_at = now()
  WHERE product_code = p_product_code;

  INSERT INTO inventory_movements
    (product_uuid, product_code, change_qty, reason, invoice_number, device_uuid, counter_id)
  VALUES
    (v_product_uuid, p_product_code,
     CASE WHEN p_is_refund THEN p_quantity ELSE -p_quantity END,
     CASE WHEN p_is_refund THEN 'REFUND' ELSE 'SALE' END,
     p_invoice_number, p_device_uuid, p_counter_id);

  RETURN jsonb_build_object('ok', true, 'new_stock', v_new_stock);
END;
$$;

-- ── Row Level Security (allow anon key full access) ──────────────────────
ALTER TABLE pharma_sync          ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory            ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log             ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='pharma_sync') THEN
    CREATE POLICY anon_all ON pharma_sync FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='devices') THEN
    CREATE POLICY anon_all ON devices FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='invoices') THEN
    CREATE POLICY anon_all ON invoices FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='invoice_items') THEN
    CREATE POLICY anon_all ON invoice_items FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='inventory') THEN
    CREATE POLICY anon_all ON inventory FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='inventory_movements') THEN
    CREATE POLICY anon_all ON inventory_movements FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='anon_all' AND tablename='sync_log') THEN
    CREATE POLICY anon_all ON sync_log FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Done! Return to your Pharma POS app and complete setup.`;

  // ── State helpers ─────────────────────────────────────────────────────────
  function getMode()  { return localStorage.getItem('pharma_mode'); }
  function setMode(m) { localStorage.setItem('pharma_mode', m); }

  function getSupaUrl() { return localStorage.getItem('pharma_supa_url') || ''; }
  function getSupaKey() { return localStorage.getItem('pharma_supa_key') || ''; }

  function isCloudReady() {
    return getMode() === 'cloud' && getSupaUrl() && getSupaKey();
  }

  // ── Update the header connection badge + native sync badge ───────────────
  function updateConnectionBadge() {
    const badge = document.getElementById('pharma-conn-badge');
    if (badge) {
      const mode = getMode();
      if (!mode) {
        badge.style.display = 'none';
      } else {
        badge.style.display = 'flex';
        if (mode === 'offline') {
          badge.className = 'pharma-conn-badge offline';
          badge.innerHTML = '<span class="pcb-dot"></span><span>Offline Only</span>';
          badge.title = 'Running in local-only mode. Click to switch.';
        } else if (isCloudReady()) {
          badge.className = 'pharma-conn-badge cloud';
          const url = getSupaUrl();
          const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || 'connected';
          badge.innerHTML = '<span class="pcb-dot"></span><span>' + ref + '</span>';
          badge.title = 'Connected to: ' + url + '\nClick to manage database settings.';
        } else {
          badge.className = 'pharma-conn-badge unconfigured';
          badge.innerHTML = '<span class="pcb-dot"></span><span>Setup Required</span>';
          badge.title = 'Database not configured. Click to set up.';
        }
        badge.onclick = function() { showSettingsConnectionCard(); };
      }
    }

    // Fix native Supabase sync badge for offline mode
    const nativeBadge = document.getElementById('supabase-sync-badge');
    const nativeLabel = document.getElementById('supabaseSyncLabel');
    const mode = getMode();
    if (nativeBadge && mode === 'offline') {
      nativeBadge.className = '';
      nativeBadge.style.cssText =
        'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;' +
        'border-radius:20px;font-size:11px;font-weight:700;cursor:default;' +
        'background:rgba(107,114,128,.12);border:1px solid rgba(107,114,128,.25);color:#6b7280;';
      nativeBadge.title = 'Running offline — no database connected';
      nativeBadge.onclick = null;
      if (nativeLabel) nativeLabel.textContent = 'Offline';
      const dot = nativeBadge.querySelector('.dot');
      if (dot) dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#6b7280;display:inline-block;';
    }
  }

  function showSettingsConnectionCard() {
    if (typeof switchTab === 'function') {
      const settTab = document.getElementById('tab-settings');
      switchTab('settingsView', settTab);
    }
    setTimeout(function() {
      const card = document.getElementById('dbConnectionCard');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  // ── Welcome screen ────────────────────────────────────────────────────────
  function showWelcomeScreen() {
    const el = document.getElementById('welcome-screen');
    if (el) el.style.display = 'flex';
  }

  function hideWelcomeScreen() {
    const el = document.getElementById('welcome-screen');
    if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 300); }
  }

  // ── Quick Setup Card (first-time users) ──────────────────────────────────
  function _showQuickSetupCard() {
    var el = document.getElementById('welcome-screen');
    if (!el) { hideWelcomeScreen(); return; }
    el.innerHTML = [
      '<div style="text-align:center;margin-bottom:8px;">',
        '<div style="font-size:48px;line-height:1;">🏥</div>',
        '<div style="color:#fff;font-size:22px;font-weight:800;margin-top:10px;">Set up your pharmacy</div>',
        '<div style="color:rgba(255,255,255,.6);font-size:13px;margin-top:6px;">Takes 30 seconds. You can always change this in Settings.</div>',
      '</div>',
      '<div style="width:100%;max-width:400px;display:flex;flex-direction:column;gap:12px;margin-top:8px;">',
        '<input id="qs-biz-name" class="setup-input" type="text"',
          ' placeholder="Pharmacy name — e.g. City Medical Store"',
          ' maxlength="60" autocomplete="off"',
          ' style="padding:12px 14px;border-radius:8px;border:none;font-size:15px;outline:none;">',
        '<input id="qs-city" class="setup-input" type="text"',
          ' placeholder="City / address — e.g. Nairobi, Kenya"',
          ' maxlength="80" autocomplete="off"',
          ' style="padding:12px 14px;border-radius:8px;border:none;font-size:15px;outline:none;">',
        '<input id="qs-phone" class="setup-input" type="tel"',
          ' placeholder="Phone number (for receipts)"',
          ' maxlength="30" autocomplete="off"',
          ' style="padding:12px 14px;border-radius:8px;border:none;font-size:15px;outline:none;">',
        '<button onclick="window._saveQuickSetup()"',
          ' style="padding:14px;background:#10b981;color:#fff;border:none;border-radius:8px;',
          'font-size:15px;font-weight:700;cursor:pointer;margin-top:4px;">',
          'Save &amp; Start →',
        '</button>',
        '<button onclick="(function(){var e=document.getElementById('welcome-screen');if(e){e.style.opacity='0';setTimeout(function(){e.style.display='none';},300);}})()"',
          ' style="padding:12px;background:transparent;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.2);',
          'border-radius:8px;font-size:13px;cursor:pointer;">',
          'Skip for now',
        '</button>',
      '</div>'
    ].join('');
  }

  window._saveQuickSetup = function() {
    var name  = ((document.getElementById('qs-biz-name') || {}).value || '').trim();
    var city  = ((document.getElementById('qs-city')     || {}).value || '').trim();
    var phone = ((document.getElementById('qs-phone')    || {}).value || '').trim();

    var bi = {
        businessName:  name || 'My Pharmacy',
        branchName:    'Main Branch',
        counterId:     'C-01',
        operatorName:  'Operator',
        receiptHeader: ''
    };
    localStorage.setItem('pharma_branch_identity', JSON.stringify(bi));

    if (city || phone) {
        var ri = { address: city, phone: phone, footer: '' };
        try {
            if (typeof StorageModule !== 'undefined') {
                StorageModule.set('pharma_receipt_info', JSON.stringify(ri));
            } else {
                localStorage.setItem('pharma_receipt_info', JSON.stringify(ri));
            }
        } catch(e) {}
    }

    // Apply to UI immediately
    if (typeof loadBranchIdentity === 'function') loadBranchIdentity();

    var el = document.getElementById('welcome-screen');
    if (el) { el.style.opacity = '0'; setTimeout(function() { el.style.display = 'none'; }, 300); }
    if (typeof showToast === 'function')
        showToast('✅ Welcome to ' + (name || 'your pharmacy') + '!');
  };

  // ── Setup screen ──────────────────────────────────────────────────────────
  function showSetupScreen(step) {
    const el = document.getElementById('setup-screen');
    if (!el) return;
    el.style.display = 'flex';
    showSetupStep(step || 'supabase');
  }

  function hideSetupScreen() {
    const el = document.getElementById('setup-screen');
    if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 300); }
  }

  function showSetupStep(step) {
    document.querySelectorAll('.setup-step').forEach(s => s.style.display = 'none');
    const el = document.getElementById('setup-step-' + step);
    if (el) el.style.display = 'block';
    document.querySelectorAll('.setup-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.step === step);
    });
  }

  // ── Choose mode ───────────────────────────────────────────────────────────
  window.chooseOfflineMode = function() {
    setMode('offline');
    updateConnectionBadge();
    // Check if business name already set (returning user)
    var bi = (function() {
        try { return JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}'); } catch(e) { return {}; }
    })();
    if (!bi.businessName && !bi.branchName) {
        _showQuickSetupCard();
    } else {
        hideWelcomeScreen();
    }
  };

  window.chooseCloudMode = function() {
    hideWelcomeScreen();
    showSetupScreen('supabase');
  };

  window.chooseShareLinkMode = function() {
    hideWelcomeScreen();
    _showPasteLinkModal();
  };

  function _showPasteLinkModal() {
    let modal = document.getElementById('_pasteLinkModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = '_pasteLinkModal';
      modal.innerHTML = `
<div style="position:fixed;inset:0;background:rgba(15,23,42,.9);z-index:9990;display:flex;align-items:center;justify-content:center;padding:16px;">
  <div style="background:#fff;width:100%;max-width:480px;border-radius:12px;padding:28px;box-shadow:0 25px 50px rgba(0,0,0,.3);">
    <div style="font-size:18px;font-weight:900;color:#1e293b;margin-bottom:6px;">📎 Paste Setup Link</div>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">Paste the share link you received from the master device. It will automatically configure your database connection.</div>
    <textarea id="_pasteLinkInput" placeholder="Paste link here… (starts with https://)" rows="4"
      style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;resize:vertical;font-family:monospace;"></textarea>
    <div style="margin-top:6px;font-size:11px;color:#9ca3af;">Your credentials are embedded in this link — treat it like a password.</div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">
      <button onclick="document.getElementById('_pasteLinkModal').remove();showWelcomeScreen();"
        style="padding:10px 18px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;font-weight:700;cursor:pointer;">Cancel</button>
      <button onclick="_applyPastedLink()"
        style="padding:10px 20px;background:#059669;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;">Apply Link →</button>
    </div>
    <div id="_pasteLinkStatus" style="margin-top:10px;font-size:12px;min-height:18px;"></div>
  </div>
</div>`;
      document.body.appendChild(modal);
    }
    modal.style.display = '';
  }

  window._applyPastedLink = function() {
    const raw = (document.getElementById('_pasteLinkInput').value || '').trim();
    const statusEl = document.getElementById('_pasteLinkStatus');
    const hashIdx = raw.indexOf('#byos?');
    if (hashIdx === -1) {
      statusEl.textContent = '⚠️ This doesn\'t look like a valid setup link (no #byos? found).';
      statusEl.style.color = '#dc2626';
      return;
    }
    // Extract just the hash part and apply it
    const hash = raw.slice(hashIdx + 1); // everything after #
    location.hash = hash;
    document.getElementById('_pasteLinkModal').remove();
    // _parseShareHash will run automatically on hash change or force it
    if (typeof _parseShareHash === 'function') _parseShareHash();
    showSetupScreen('supabase');
  };

  // ── Test Supabase connection ───────────────────────────────────────────────
  window.testSupabaseConnection = async function() {
    const urlEl  = document.getElementById('setup-supa-url');
    const keyEl  = document.getElementById('setup-supa-key');
    const statusEl = document.getElementById('setup-supa-status');
    const btn = document.getElementById('setup-supa-test-btn');

    const url = (urlEl.value || '').trim().replace(/\/$/, '');
    const key = (keyEl.value || '').trim();

    if (!url || !key) {
      statusEl.className = 'setup-status error';
      statusEl.textContent = '⚠️ Please enter both URL and Anon Key.';
      return;
    }
    if (!url.includes('supabase.co') && !url.includes('localhost')) {
      statusEl.className = 'setup-status error';
      statusEl.textContent = '⚠️ URL should look like: https://xxxx.supabase.co';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Testing…';
    statusEl.className = 'setup-status testing';
    statusEl.textContent = '🔄 Connecting to Supabase…';

    try {
      const r = await fetch(url + '/rest/v1/pharma_sync?select=key&limit=1', {
        headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
      });

      if (r.ok || r.status === 406) {
        statusEl.className = 'setup-status success';
        statusEl.textContent = '✅ Connection successful! Your Supabase project is reachable.';
        document.getElementById('setup-supa-save-btn').style.display = 'inline-block';
      } else if (r.status === 401) {
        statusEl.className = 'setup-status error';
        statusEl.textContent = '❌ Invalid Anon Key. Check your key from Supabase → Project Settings → API.';
      } else if (r.status === 404) {
        statusEl.className = 'setup-status warning';
        statusEl.textContent = '⚠️ Schema not found. Paste and run the SQL below in Supabase → SQL Editor, then click Test again.';
        // Do NOT show save button — block until schema exists
        if (typeof toggleSchemaAccordion === 'function') toggleSchemaAccordion(); // auto-expand SQL
      } else {
        statusEl.className = 'setup-status error';
        statusEl.textContent = '❌ Error ' + r.status + '. Check your URL and key.';
      }
    } catch(e) {
      statusEl.className = 'setup-status error';
      statusEl.textContent = '❌ Network error: ' + (e.message || 'Cannot reach Supabase. Check URL.');
    }

    btn.disabled = false;
    btn.textContent = 'Test Connection';
  };

  window.saveSupabaseAndContinue = async function() {
    const url = (document.getElementById('setup-supa-url').value || '').trim().replace(/\/$/, '');
    const key = (document.getElementById('setup-supa-key').value || '').trim();
    if (!url || !key) return;
    localStorage.setItem('pharma_supa_url', url);
    localStorage.setItem('pharma_supa_key', key);
    setMode('cloud');

    // ── 3C: Push current (or default) password hash to Supabase immediately ──
    // This ensures Device 2 can sync the password without triggering master setup.
    try {
        const localHash = StorageModule ? StorageModule.get('sys_admin_pass_hash') : null;
        if (localHash) {
            await _supaSet('pharma_master_password_hash', localHash);
        } else {
            // No custom password set yet — push the hash of the default 12345678
            if (typeof _hashPassword === 'function') {
                const defaultHash = await _hashPassword('12345678');
                await _supaSet('pharma_master_password_hash', defaultHash);
            }
        }
    } catch(e) {
        console.warn('[Setup] Could not push password hash to Supabase:', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    showSetupStep('emailjs');
  };

  // ── EmailJS setup ─────────────────────────────────────────────────────────
  window.testEmailJS = async function() {
    const sid   = (document.getElementById('setup-ejs-service').value || '').trim();
    const tid   = (document.getElementById('setup-ejs-template').value || '').trim();
    const pk    = (document.getElementById('setup-ejs-pubkey').value || '').trim();
    const email = (document.getElementById('setup-ejs-email').value || '').trim();
    const statusEl = document.getElementById('setup-ejs-status');
    const btn = document.getElementById('setup-ejs-test-btn');

    if (!sid || !tid || !pk || !email) {
      statusEl.className = 'setup-status error';
      statusEl.textContent = '⚠️ Fill in all four EmailJS fields to test.';
      return;
    }

    btn.disabled = true; btn.textContent = 'Sending…';
    statusEl.className = 'setup-status testing';
    statusEl.textContent = '🔄 Sending test email…';

    try {
      if (typeof emailjs !== 'undefined') {
        emailjs.init({ publicKey: pk });
        await emailjs.send(sid, tid, {
          to_email:    email,
          reset_link:  'https://test-link.example.com',
          device_name: 'Setup Test'
        });
        statusEl.className = 'setup-status success';
        statusEl.textContent = '✅ Test email sent to ' + email + '!';
        document.getElementById('setup-ejs-save-btn').style.display = 'inline-block';
      } else {
        statusEl.className = 'setup-status error';
        statusEl.textContent = '❌ EmailJS library not loaded.';
      }
    } catch(e) {
      statusEl.className = 'setup-status error';
      statusEl.textContent = '❌ EmailJS error: ' + (e.text || e.message || JSON.stringify(e));
    }
    btn.disabled = false; btn.textContent = 'Send Test Email';
  };

  window.saveEmailJSAndFinish = function() {
    const sid   = (document.getElementById('setup-ejs-service').value || '').trim();
    const tid   = (document.getElementById('setup-ejs-template').value || '').trim();
    const pk    = (document.getElementById('setup-ejs-pubkey').value || '').trim();
    const email = (document.getElementById('setup-ejs-email').value || '').trim();
    localStorage.setItem('pharma_emailjs_service_id',  sid);
    localStorage.setItem('pharma_emailjs_template_id', tid);
    localStorage.setItem('pharma_emailjs_public_key',  pk);
    localStorage.setItem('pharma_emailjs_reset_email', email);
    finishSetup();
  };

  window.skipEmailJSAndFinish = function() { finishSetup(); };

  function finishSetup() {
    // Show a brief "all done" screen before reloading
    const inner = document.querySelector('.setup-inner');
    if (inner) {
        inner.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:#fff;">
                <div style="font-size:56px;margin-bottom:18px;">✅</div>
                <div style="font-size:22px;font-weight:800;margin-bottom:10px;color:#10b981;">You're all set!</div>
                <div style="font-size:14px;opacity:.75;margin-bottom:20px;line-height:1.7;">
                    Your Supabase database is connected.<br>
                    Loading your system…
                </div>
                <div style="font-size:12px;opacity:.5;">
                    Default password: <strong>12345678</strong> — change it in Settings → Security
                </div>
            </div>`;
    }
    updateConnectionBadge();
    setTimeout(function() { location.reload(); }, 2200);
  }

  // ── Share Setup Link ──────────────────────────────────────────────────────
  // Encodes credentials into the URL hash (never sent to any server).
  // Format: [page]#byos?u=<btoa(url)>&k=<btoa(key)>
  // Optional EmailJS fields: &es=<btoa(sid)>&et=<btoa(tid)>&ep=<btoa(pk)>&ee=<btoa(email)>

  function _b64e(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch(e) { return btoa(s); } }
  function _b64d(s) { try { return decodeURIComponent(escape(atob(s))); } catch(e) { return atob(s); } }

  window.generateShareLink = function() {
    const url = getSupaUrl();
    const key = getSupaKey();
    if (!url || !key) {
      if (typeof showToast === 'function') showToast('⚠️ No database configured to share.', true);
      return;
    }
    const base = location.href.split('#')[0];
    let hash = '#byos?u=' + _b64e(url) + '&k=' + _b64e(key);
    const ejsSvc = localStorage.getItem('pharma_emailjs_service_id');
    const ejsTid = localStorage.getItem('pharma_emailjs_template_id');
    const ejsPk  = localStorage.getItem('pharma_emailjs_public_key');
    const ejsEm  = localStorage.getItem('pharma_emailjs_reset_email');
    if (ejsSvc) hash += '&es=' + _b64e(ejsSvc);
    if (ejsTid) hash += '&et=' + _b64e(ejsTid);
    if (ejsPk)  hash += '&ep=' + _b64e(ejsPk);
    if (ejsEm)  hash += '&ee=' + _b64e(ejsEm);
    const fullLink = base + hash;
    _showShareModal(fullLink);
  };

  function _showShareModal(link) {
    // Remove any existing modal
    const existing = document.getElementById('shareLinkModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'shareLinkModal';
    modal.style.cssText = [
      'position:fixed','inset:0','z-index:99998',
      'background:rgba(0,0,0,.55)','backdrop-filter:blur(3px)',
      'display:flex','align-items:center','justify-content:center','padding:20px'
    ].join(';');

    modal.innerHTML = `
      <div style="background:var(--surface,#fff);color:var(--text,#1a2233);border-radius:16px;
                  padding:28px 24px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div style="font-size:17px;font-weight:800;margin-bottom:4px;">📎 Share Setup Link</div>
        <div style="font-size:12px;opacity:.55;margin-bottom:18px;line-height:1.5;">
          Open this link on another device to instantly configure it with the same database.<br>
          <strong style="color:#ef4444;">⚠️ Keep this link private</strong> — it contains your Supabase key.
          The key is in the <code style="font-size:11px;">#hash</code> and is never sent to any server.
        </div>
        <textarea id="shareLinkBox" readonly
          style="width:100%;height:90px;box-sizing:border-box;font-family:monospace;font-size:11px;
                 line-height:1.5;padding:10px 12px;border-radius:8px;resize:none;outline:none;
                 background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.12);
                 word-break:break-all;color:inherit;">${link}</textarea>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center;">
          <button id="shareCopyBtn"
            style="padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;
                   border:none;cursor:pointer;background:var(--teal,#0d9488);color:#fff;"
            onclick="(function(){
              const box = document.getElementById('shareLinkBox');
              navigator.clipboard.writeText(box.value).then(function(){
                const b = document.getElementById('shareCopyBtn');
                b.textContent = '✅ Copied!';
                setTimeout(()=>b.textContent='📋 Copy Link', 2200);
              }).catch(()=>{ box.select(); document.execCommand('copy'); });
            })()">📋 Copy Link</button>
          <button
            style="padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;
                   border:1px solid rgba(0,0,0,.15);cursor:pointer;background:transparent;"
            onclick="document.getElementById('shareLinkModal').remove()">Close</button>
          <span style="font-size:11px;opacity:.45;margin-left:auto;">Link expires when you change your key</span>
        </div>
      </div>`;

    // Close on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);

    // Select all text
    setTimeout(function() {
      const box = document.getElementById('shareLinkBox');
      if (box) { box.focus(); box.select(); }
    }, 60);
  }

  // ── Parse share link from URL hash on load ────────────────────────────────
  function _parseShareHash() {
    const hash = location.hash;
    if (!hash.startsWith('#byos?')) return false;
    try {
      const params = new URLSearchParams(hash.slice(6)); // strip '#byos?'
      const u = params.get('u');
      const k = params.get('k');
      if (!u || !k) return false;

      const url = _b64d(u);
      const key = _b64d(k);
      if (!url || !key) return false;

      // Pre-fill the setup fields
      const urlEl = document.getElementById('setup-supa-url');
      const keyEl = document.getElementById('setup-supa-key');
      if (urlEl) urlEl.value = url;
      if (keyEl) keyEl.value = key;

      // Pre-fill EmailJS if present
      const es = params.get('es'); const et = params.get('et');
      const ep = params.get('ep'); const ee = params.get('ee');
      if (es) { const el = document.getElementById('setup-ejs-service');  if (el) el.value = _b64d(es); }
      if (et) { const el = document.getElementById('setup-ejs-template'); if (el) el.value = _b64d(et); }
      if (ep) { const el = document.getElementById('setup-ejs-pubkey');   if (el) el.value = _b64d(ep); }
      if (ee) { const el = document.getElementById('setup-ejs-email');    if (el) el.value = _b64d(ee); }

      // Clear hash so it doesn't persist
      history.replaceState(null, '', location.pathname + location.search);

      // Show setup screen with a banner
      showSetupScreen('supabase');
      _showShareBanner(url);
      return true;
    } catch(e) { return false; }
  }

  function _showShareBanner(url) {
    const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || url;
    const card = document.getElementById('setup-step-supabase');
    if (!card) return;
    const banner = document.createElement('div');
    banner.style.cssText = [
      'background:rgba(16,185,129,.15)','border:1px solid rgba(16,185,129,.3)',
      'border-radius:10px','padding:12px 14px','font-size:13px',
      'font-weight:600','color:#6ee7b7','margin-bottom:14px','line-height:1.5'
    ].join(';');
    banner.innerHTML = '🔗 Setup link detected — credentials for <strong>' + ref +
      '.supabase.co</strong> pre-filled below.<br>' +
      '<span style="font-size:11px;opacity:.75;">Click <strong>Test Connection</strong> to verify, then Save &amp; Continue.</span>';
    card.insertBefore(banner, card.firstChild);

    // Also show the save button immediately
    const saveBtn = document.getElementById('setup-supa-save-btn');
    if (saveBtn) saveBtn.style.display = 'inline-block';
  }

  // ── Schema generator ──────────────────────────────────────────────────────
  window.toggleSchemaAccordion = function() {
    const el = document.getElementById('schema-accordion-body');
    const btn = document.getElementById('schema-accordion-btn');
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    btn.textContent  = open ? '📋 View SQL Schema to run in Supabase ▼' : '📋 Hide SQL Schema ▲';
  };

  window.copySchemaSQL = function() {
    navigator.clipboard.writeText(SUPABASE_SQL_SCHEMA).then(function() {
      const btn = document.getElementById('copy-schema-btn');
      btn.textContent = '✅ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy SQL', 2000);
    }).catch(function() {
      document.getElementById('schema-sql-box').select();
      document.execCommand('copy');
    });
  };

  // ── Disconnect helpers (called from settings view) ─────────────────────
  window.disconnectDatabase = function() {
    if (!confirm('Disconnect your database? The app will restart in Offline-Only mode.\n\nYour local data (invoices, inventory) is preserved.')) return;
    localStorage.removeItem('pharma_supa_url');
    localStorage.removeItem('pharma_supa_key');
    localStorage.removeItem('pharma_mode');
    location.reload();
  };

  // ── Factory Reset — wipes all local data, credentials, and passwords ───────
  // Supabase cloud data is NOT affected. Only this device is reset.
  window.factoryReset = async function() {
    if (!confirm('⚠️ FACTORY RESET\n\nThis will permanently delete from THIS DEVICE:\n• All invoices and inventory\n• All settings and passwords\n• All cloud credentials\n\nYour Supabase cloud data is NOT deleted.\nThis cannot be undone. Continue?')) return;
    const typed = prompt('Type RESET to confirm:');
    if ((typed || '').trim() !== 'RESET') {
      if (typeof showToast === 'function') showToast('Factory reset cancelled.', 2500);
      return;
    }

    // 1. Clear IDB data via StorageModule helpers
    try {
      if (typeof StorageModule !== 'undefined') {
        if (typeof StorageModule.clearAllPrimaryStores === 'function') StorageModule.clearAllPrimaryStores();
        if (typeof StorageModule.clearAllQueues       === 'function') StorageModule.clearAllQueues();
      }
    } catch(e) { console.warn('[FactoryReset] StorageModule clear error:', e); }

    // 2. Delete IDB databases entirely for a clean slate
    try { indexedDB.deleteDatabase('PharmaDataDB'); }      catch(e) {}
    try { indexedDB.deleteDatabase('PharmaInventoryDB'); } catch(e) {}

    // 3. Clear all pharma_* and sys_* localStorage keys
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('pharma_') || k.startsWith('sys_'))) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));

    // 4. Reload → welcome screen
    if (typeof showToast === 'function') showToast('✅ Factory reset complete. Restarting…', 2000);
    setTimeout(() => location.reload(), 1400);
  };

  window.disconnectEmailJS = function() {
    if (!confirm('Remove your EmailJS configuration? Password reset emails will be disabled.')) return;
    localStorage.removeItem('pharma_emailjs_service_id');
    localStorage.removeItem('pharma_emailjs_template_id');
    localStorage.removeItem('pharma_emailjs_public_key');
    localStorage.removeItem('pharma_emailjs_reset_email');
    showToast('EmailJS disconnected. Reload to apply.', false);
    renderConnectionCard();
  };

  window.reconnectDatabase = function() {
    showSetupScreen('supabase');
  };

  window.reconfigureEmailJS = function() {
    showSetupScreen('emailjs');
  };

  // ── Render the settings connection card ───────────────────────────────────
  window.renderConnectionCard = function() {
    const card = document.getElementById('dbConnectionCard');
    if (!card) return;
    const mode = getMode();
    const url  = getSupaUrl();
    const key  = getSupaKey();
    const emailSvc    = localStorage.getItem('pharma_emailjs_service_id')   || '';
    const emailTid    = localStorage.getItem('pharma_emailjs_template_id')  || '';
    const emailPk     = localStorage.getItem('pharma_emailjs_public_key')   || '';
    const resetEmail  = localStorage.getItem('pharma_emailjs_reset_email')  || '';
    const emailConfigured = !!(emailSvc && emailTid && emailPk && resetEmail);

    // ── Card 1: Supabase Database ─────────────────────────────────────────
    let supaHtml = '';
    if (mode === 'cloud' && url) {
      const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || url;
      const maskedKey = key ? key.slice(0, 12) + '…' + key.slice(-6) : '';
      supaHtml = `
        <div class="conn-row conn-connected">
          <span class="conn-dot green"></span>
          <div class="conn-info">
            <div class="conn-label">Supabase Database</div>
            <div class="conn-value">${ref}.supabase.co</div>
            <div class="conn-sub">Anon Key: ${maskedKey}</div>
          </div>
          <div class="conn-actions">
            <button class="conn-btn primary" onclick="generateShareLink()" style="width:100%;margin-bottom:4px;" title="Generate a one-click setup link for a second device">📱 Add Another Device</button>
            <div style="font-size:11px;opacity:.55;margin-bottom:6px;line-height:1.5;">Opens this app on another device with the same database instantly. Keep the link private — it contains your credentials.</div>
            <button class="conn-btn outline" onclick="reconnectDatabase()">Change Database</button>
            <button class="conn-btn danger" onclick="disconnectDatabase()">Switch to Offline</button>
          </div>
        </div>`;
    } else if (mode === 'offline') {
      supaHtml = `
        <div class="conn-row conn-offline">
          <span class="conn-dot orange"></span>
          <div class="conn-info">
            <div class="conn-label">🔴 Offline — local only</div>
            <div class="conn-sub">No cloud sync. All data stored locally on this device.</div>
          </div>
          <div class="conn-actions">
            <button class="conn-btn primary" onclick="reconnectDatabase()">Connect Database</button>
            <button class="conn-btn outline" onclick="showSetupGuide()" style="margin-top:6px;">📖 Setup Guide</button>
          </div>
        </div>`;
    } else {
      supaHtml = `
        <div class="conn-row conn-unconfigured">
          <span class="conn-dot grey"></span>
          <div class="conn-info">
            <div class="conn-label">Supabase Database</div>
            <div class="conn-sub">No database configured. Click Connect to set up your own Supabase project.</div>
          </div>
          <div class="conn-actions">
            <button class="conn-btn primary" onclick="chooseCloudMode()">Connect Database</button>
            <button class="conn-btn outline" onclick="chooseOfflineMode()">Stay Offline</button>
          </div>
        </div>`;
    }

    // ── Card 2: Email Recovery (EmailJS) ─────────────────────────────────
    const emailDotClass  = emailConfigured ? 'green' : 'grey';
    const emailRowClass  = emailConfigured ? 'conn-connected' : 'conn-offline';
    const emailjs_howto  = `
      <div id="emailjs-howto" style="display:none;margin-top:12px;padding:12px 14px;background:rgba(0,0,0,.04);border-radius:8px;font-size:12px;line-height:1.7;color:var(--g600);">
        <strong style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.7;">How to set up EmailJS</strong><br>
        1. Go to <a href="https://www.emailjs.com" target="_blank" style="color:var(--teal);">emailjs.com</a> → Create a free account<br>
        2. Add an Email Service (Gmail, Outlook, etc.) → copy the <strong>Service ID</strong><br>
        3. Create an Email Template → copy the <strong>Template ID</strong><br>
        4. Go to Account → API Keys → copy the <strong>Public Key</strong><br>
        5. Enter the recovery email address where OTPs will be sent<br>
        <div style="margin-top:8px;padding:8px 10px;background:rgba(13,148,136,.08);border-left:3px solid var(--teal);border-radius:4px;">
          <strong style="font-size:11px;">Required template variables</strong> — your EmailJS template must include these exact variable names:<br>
          <code style="font-size:11px;background:rgba(0,0,0,.07);padding:1px 4px;border-radius:3px;">{{to_email}}</code> — recipient address (filled automatically)<br>
          <code style="font-size:11px;background:rgba(0,0,0,.07);padding:1px 4px;border-radius:3px;">{{reset_pin}}</code> — the 8-digit OTP code<br>
          <code style="font-size:11px;background:rgba(0,0,0,.07);padding:1px 4px;border-radius:3px;">{{shop_name}}</code> — your pharmacy name<br>
          <code style="font-size:11px;background:rgba(0,0,0,.07);padding:1px 4px;border-radius:3px;">{{expires_in}}</code> — expiry notice (e.g. "10 minutes")<br>
          <code style="font-size:11px;background:rgba(0,0,0,.07);padding:1px 4px;border-radius:3px;">{{counter_id}}</code> — counter/device ID (optional)
        </div>
      </div>`;

    let emailHtml = '';
    if (emailConfigured) {
      emailHtml = `
        <div class="conn-row ${emailRowClass}" style="margin-top:8px;">
          <span class="conn-dot ${emailDotClass}"></span>
          <div class="conn-info">
            <div class="conn-label">Email Recovery (EmailJS)</div>
            <div class="conn-value">Service: ${emailSvc}</div>
            <div class="conn-sub">OTPs → ${resetEmail}</div>
          </div>
          <div class="conn-actions">
            <button class="conn-btn outline" onclick="_settToggleEmailJSEdit()" id="ejsEditBtn">Edit</button>
            <button class="conn-btn danger" onclick="disconnectEmailJS()">Remove</button>
          </div>
        </div>
        <div id="ejsEditForm" style="display:none;margin-top:8px;padding:12px 14px;background:rgba(0,0,0,.04);border-radius:8px;">
          <div style="display:grid;gap:8px;">
            <input id="settEjsService"  class="sett-inp" placeholder="Service ID"    value="${emailSvc}" style="font-size:12px;">
            <input id="settEjsTemplate" class="sett-inp" placeholder="Template ID"   value="${emailTid}" style="font-size:12px;">
            <input id="settEjsPubkey"   class="sett-inp" placeholder="Public Key"    value="${emailPk}"  style="font-size:12px;">
            <input id="settEjsEmail"    class="sett-inp" placeholder="Recovery Email" value="${resetEmail}" type="email" style="font-size:12px;">
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="conn-btn primary" onclick="_settSaveEmailJS()">💾 Save</button>
            <button class="conn-btn outline" onclick="_settTestEmailJS()">📧 Test</button>
            <button class="conn-btn outline" onclick="_settToggleEmailJSEdit()">Cancel</button>
          </div>
          <div id="settEjsStatus" style="font-size:11px;color:var(--g500);margin-top:6px;min-height:16px;"></div>
          ${emailjs_howto}
          <button style="background:none;border:none;font-size:11px;color:var(--teal);cursor:pointer;padding:6px 0 0;text-decoration:underline;" onclick="document.getElementById('emailjs-howto').style.display=document.getElementById('emailjs-howto').style.display==='none'?'block':'none'">How to set up EmailJS ▾</button>
        </div>`;
    } else {
      emailHtml = `
        <div class="conn-row ${emailRowClass}" style="margin-top:8px;">
          <span class="conn-dot ${emailDotClass}"></span>
          <div class="conn-info">
            <div class="conn-label">Email Recovery (EmailJS)</div>
            <div class="conn-sub">Not configured — password reset emails are disabled.</div>
          </div>
          <div class="conn-actions">
            <button class="conn-btn outline" onclick="_settToggleEmailJSEdit()" id="ejsEditBtn">Set Up</button>
          </div>
        </div>
        <div id="ejsEditForm" style="display:none;margin-top:8px;padding:12px 14px;background:rgba(0,0,0,.04);border-radius:8px;">
          <div style="display:grid;gap:8px;">
            <input id="settEjsService"  class="sett-inp" placeholder="Service ID"    value="" style="font-size:12px;">
            <input id="settEjsTemplate" class="sett-inp" placeholder="Template ID"   value="" style="font-size:12px;">
            <input id="settEjsPubkey"   class="sett-inp" placeholder="Public Key"    value="" style="font-size:12px;">
            <input id="settEjsEmail"    class="sett-inp" placeholder="Recovery Email (OTPs sent here)" value="" type="email" style="font-size:12px;">
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="conn-btn primary" onclick="_settSaveEmailJS()">💾 Save</button>
            <button class="conn-btn outline" onclick="_settTestEmailJS()">📧 Test</button>
            <button class="conn-btn outline" onclick="_settToggleEmailJSEdit()">Cancel</button>
          </div>
          <div id="settEjsStatus" style="font-size:11px;color:var(--g500);margin-top:6px;min-height:16px;"></div>
          ${emailjs_howto}
          <button style="background:none;border:none;font-size:11px;color:var(--teal);cursor:pointer;padding:6px 0 0;text-decoration:underline;" onclick="document.getElementById('emailjs-howto').style.display=document.getElementById('emailjs-howto').style.display==='none'?'block':'none'">How to set up EmailJS ▾</button>
        </div>`;
    }

    card.innerHTML = `
      <div class="sett-section-title">🔌 Database &amp; Services</div>
      ${supaHtml}
      ${emailHtml}
    `;
  };

  // ── EmailJS inline edit helpers ───────────────────────────────────────────
  window._settToggleEmailJSEdit = function() {
    const form = document.getElementById('ejsEditForm');
    const btn  = document.getElementById('ejsEditBtn');
    if (!form) return;
    const showing = form.style.display !== 'none';
    form.style.display = showing ? 'none' : 'block';
    if (btn) btn.textContent = showing ? 'Edit' : 'Cancel';
  };

  window._settSaveEmailJS = function() {
    const statusEl = document.getElementById('settEjsStatus');
    const sid   = (document.getElementById('settEjsService')?.value  || '').trim();
    const tid   = (document.getElementById('settEjsTemplate')?.value || '').trim();
    const pk    = (document.getElementById('settEjsPubkey')?.value   || '').trim();
    const email = (document.getElementById('settEjsEmail')?.value    || '').trim();
    if (!sid || !tid || !pk || !email) {
      if (statusEl) { statusEl.textContent = '⚠️ Fill in all four fields.'; statusEl.style.color = 'var(--amb)'; }
      return;
    }
    localStorage.setItem('pharma_emailjs_service_id',  sid);
    localStorage.setItem('pharma_emailjs_template_id', tid);
    localStorage.setItem('pharma_emailjs_public_key',  pk);
    localStorage.setItem('pharma_emailjs_reset_email', email);
    if (statusEl) { statusEl.textContent = '✅ Saved.'; statusEl.style.color = 'var(--grn)'; }
    if (typeof showToast === 'function') showToast('✅ Email Recovery configured.');
    setTimeout(renderConnectionCard, 800);
  };

  window._settTestEmailJS = function() {
    const statusEl = document.getElementById('settEjsStatus');
    const sid   = (document.getElementById('settEjsService')?.value  || '').trim();
    const tid   = (document.getElementById('settEjsTemplate')?.value || '').trim();
    const pk    = (document.getElementById('settEjsPubkey')?.value   || '').trim();
    const email = (document.getElementById('settEjsEmail')?.value    || '').trim();
    if (!sid || !tid || !pk || !email) {
      if (statusEl) { statusEl.textContent = '⚠️ Fill in all four fields first.'; statusEl.style.color = 'var(--amb)'; }
      return;
    }
    if (typeof emailjs === 'undefined') {
      if (statusEl) { statusEl.textContent = '❌ EmailJS library not loaded.'; statusEl.style.color = 'var(--red)'; }
      return;
    }
    if (statusEl) { statusEl.textContent = '🔄 Sending test email…'; statusEl.style.color = 'var(--g500)'; }
    try {
      emailjs.init({ publicKey: pk });
      emailjs.send(sid, tid, { to_email: email, reset_link: 'https://test.example.com', device_name: 'Settings Test', reset_pin: '12345678', shop_name: 'Pharma POS', counter_id: 'Test', expires_in: 'N/A' })
        .then(function() {
          if (statusEl) { statusEl.textContent = '✅ Test email sent to ' + email + '!'; statusEl.style.color = 'var(--grn)'; }
        })
        .catch(function(err) {
          if (statusEl) { statusEl.textContent = '❌ ' + (err.text || err.message || 'Send failed'); statusEl.style.color = 'var(--red)'; }
        });
    } catch(e) {
      if (statusEl) { statusEl.textContent = '❌ ' + (e.message || 'EmailJS error'); statusEl.style.color = 'var(--red)'; }
    }
  };

  // ── Schema SQL textarea fill ──────────────────────────────────────────────
  function fillSchemaSQL() {
    const el = document.getElementById('schema-sql-box');
    if (el) el.value = SUPABASE_SQL_SCHEMA;
  }

  // ── Init on DOMContentLoaded ──────────────────────────────────────────────
  function init() {
    fillSchemaSQL();

    // Pre-fill setup fields if we already have values stored
    const url = getSupaUrl();
    const key = getSupaKey();
    const urlEl = document.getElementById('setup-supa-url');
    const keyEl = document.getElementById('setup-supa-key');
    if (urlEl && url) urlEl.value = url;
    if (keyEl && key) keyEl.value = key;

    const ejsSvc = localStorage.getItem('pharma_emailjs_service_id');
    const ejsTid = localStorage.getItem('pharma_emailjs_template_id');
    const ejsPk  = localStorage.getItem('pharma_emailjs_public_key');
    const ejsEm  = localStorage.getItem('pharma_emailjs_reset_email');
    if (ejsSvc) { const el = document.getElementById('setup-ejs-service');  if (el) el.value = ejsSvc; }
    if (ejsTid) { const el = document.getElementById('setup-ejs-template'); if (el) el.value = ejsTid; }
    if (ejsPk)  { const el = document.getElementById('setup-ejs-pubkey');   if (el) el.value = ejsPk;  }
    if (ejsEm)  { const el = document.getElementById('setup-ejs-email');    if (el) el.value = ejsEm;  }

    // Check for share link in URL hash — takes priority over normal flow
    if (_parseShareHash()) {
      updateConnectionBadge();
      return;
    }

    updateConnectionBadge();

    const mode = getMode();
    if (!mode) {
      showWelcomeScreen();
    } else if (mode === 'cloud' && (!url || !key)) {
      showSetupScreen('supabase');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Dynamic PIN gate title from business settings ─────────────────────────
  function updatePinGateTitle() {
    const titleEl = document.querySelector('#pin-gate .gate-title');
    if (!titleEl) return;
    try {
      const bi = JSON.parse(localStorage.getItem('pharma_branch_identity') || '{}');
      const name = bi.businessName || bi.branchName || '';
      if (name) titleEl.textContent = name;
    } catch(e) {}
  }

  // ── Apply mode-aware UI changes across the whole app ──────────────────────
  function applyModeUI() {
    const mode = getMode();

    // ── Sync Hub tab ──────────────────────────────────────────────────────
    const syncTab = document.getElementById('tabSyncHub');
    if (syncTab) {
      if (mode === 'offline') {
        syncTab.style.opacity = '0.45';
        syncTab.style.pointerEvents = 'auto'; // still clickable (shows the notice)
        // Replace label text while preserving the kbd shortcut
        const kbd = syncTab.querySelector('kbd');
        syncTab.innerHTML = '🔌 Sync Hub <small style="font-size:9px;opacity:.8;font-weight:600;' +
          'letter-spacing:.3px;text-transform:uppercase;vertical-align:middle;">(offline)</small> ';
        if (kbd) syncTab.appendChild(kbd);
      } else {
        syncTab.style.opacity = '';
        syncTab.innerHTML = '☁️ Cloud Sync Hub <kbd class="tab-k">F10</kbd>';
      }
    }

    // ── Force Sync button (inside syncHubView) ─────────────────────────────
    _patchSyncButton('forceSyncBtn',  mode);
    // ── Data Hub "Sync Now" button ─────────────────────────────────────────
    _patchSyncButton('dhPushSyncBtn', mode);

    // ── Stale device banner — irrelevant offline ────────────────────────────
    const staleBanner = document.getElementById('appStaleBanner');
    if (staleBanner && mode === 'offline') staleBanner.style.display = 'none';

    // ── Sync Hub view offline notice ────────────────────────────────────────
    if (mode === 'offline') {
      _injectSyncHubOfflineBanner();
    } else {
      const existing = document.getElementById('shOfflineBanner');
      if (existing) existing.remove();
    }
  }

  function _patchSyncButton(id, mode) {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (mode === 'offline') {
      btn.disabled = true;
      btn.title = 'Cloud sync disabled — running in offline mode';
      btn.style.opacity = '0.38';
      btn.style.cursor = 'not-allowed';
      btn.style.pointerEvents = 'none';
    } else {
      btn.disabled = false;
      btn.title = '';
      btn.style.opacity = '';
      btn.style.cursor = '';
      btn.style.pointerEvents = '';
    }
  }

  function _injectSyncHubOfflineBanner() {
    const view = document.getElementById('syncHubView');
    if (!view) return;
    if (document.getElementById('shOfflineBanner')) return; // already injected

    const banner = document.createElement('div');
    banner.id = 'shOfflineBanner';
    banner.style.cssText = [
      'margin:20px 16px 0',
      'padding:20px 24px',
      'border-radius:14px',
      'background:rgba(107,114,128,.08)',
      'border:1px solid rgba(107,114,128,.2)',
      'display:flex','align-items:flex-start','gap:16px',
      'flex-wrap:wrap'
    ].join(';');

    banner.innerHTML =
      '<div style="font-size:32px;line-height:1;flex-shrink:0;">🔌</div>' +
      '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:15px;font-weight:800;margin-bottom:4px;">Running in Offline Mode</div>' +
        '<div style="font-size:12px;opacity:.65;line-height:1.6;">' +
          'Cloud sync is disabled. All your invoices and inventory are stored locally on this device.<br>' +
          'Connect a Supabase database to enable multi-device sync, remote backups, and device telemetry.' +
        '</div>' +
        '<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">' +
          '<button onclick="reconnectDatabase()" style="padding:8px 18px;border-radius:8px;' +
            'font-size:12px;font-weight:700;border:none;cursor:pointer;' +
            'background:var(--teal,#0d9488);color:#fff;">' +
            '☁️ Connect Database' +
          '</button>' +
          '<button onclick="(function(){var t=document.getElementById(\'tab-settings\');if(t)switchTab(\'settingsView\',t);})()" ' +
            'style="padding:8px 18px;border-radius:8px;font-size:12px;font-weight:700;' +
            'border:1px solid rgba(0,0,0,.15);cursor:pointer;background:transparent;">' +
            '⚙️ Open Settings' +
          '</button>' +
        '</div>' +
      '</div>';

    // Prepend so it appears before any syncHub-rendered content
    view.insertBefore(banner, view.firstChild);
  }

  // Re-apply after all scripts (including syncHub) have run
  window.addEventListener('load', function() {
    updatePinGateTitle();
    updateConnectionBadge();
    applyModeUI();
    // A second pass for any late syncHub badge/button resets
    setTimeout(function() {
      updateConnectionBadge();
      applyModeUI();
    }, 700);
  });

  // Expose renderConnectionCard to be called when settings tab opens
  document.addEventListener('DOMContentLoaded', function() {
    const origSwitchTab = window.switchTab;
    if (typeof origSwitchTab === 'function') {
      window._setupSwitchTabHooked = true;
    }
    // Poll for switchTab being defined, then hook it
    let _hookAttempts = 0;
    const hookTimer = setInterval(function() {
      _hookAttempts++;
      if (typeof window.switchTab === 'function' && !window._setupTabHooked) {
        const orig = window.switchTab;
        window.switchTab = function(viewId, btn) {
          orig.call(this, viewId, btn);
          if (viewId === 'settingsView') {
            setTimeout(renderConnectionCard, 50);
          }
          if (viewId === 'syncHubView') {
            // syncHub renders its buttons dynamically — re-apply after render
            setTimeout(applyModeUI, 120);
          }
        };
        window._setupTabHooked = true;
        clearInterval(hookTimer);
      }
      if (_hookAttempts > 60) clearInterval(hookTimer);
    }, 100);
  });

})();

// ── Setup Guide Modal (Phase 5A) ─────────────────────────────────────────────
window.showSetupGuide = function() {
    var existing = document.getElementById('_setupGuideModal');
    if (existing) { existing.style.display = 'flex'; return; }

    var modal = document.createElement('div');
    modal.id = '_setupGuideModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99995;background:rgba(15,23,42,.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';

    modal.innerHTML = `
<div style="background:#fff;color:#1e293b;border-radius:16px;padding:0;max-width:580px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,.4);">
  <!-- Header -->
  <div style="padding:22px 24px 16px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;">
    <div>
      <div style="font-size:18px;font-weight:800;">☁️ Cloud Sync Setup Guide</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px;">Multi-device sync using your own free Supabase account</div>
    </div>
    <button onclick="document.getElementById('_setupGuideModal').style.display='none'"
      style="background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;padding:4px 8px;line-height:1;">×</button>
  </div>
  <!-- Scrollable body -->
  <div style="overflow-y:auto;padding:20px 24px;flex:1;">

    <!-- Supabase section -->
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#0d9488;margin-bottom:10px;">Step 1 — Create a Supabase project (2 min, free)</div>
      <div style="font-size:12px;color:#475569;line-height:1.8;">
        <strong>What is Supabase?</strong> It's a free, open-source database platform. Your pharmacy data lives in <em>your</em> Supabase project — not on any shared server. You own it completely; we never have access to it.
      </div>
      <ol style="font-size:12px;color:#475569;line-height:2;margin:10px 0 0 16px;padding:0;">
        <li>Go to <a href="https://supabase.com" target="_blank" style="color:#0d9488;font-weight:600;">supabase.com</a> → Sign up free (GitHub login works)</li>
        <li>Click <strong>New project</strong> — give it any name, e.g. "My Pharmacy"</li>
        <li>Wait ~2 minutes for the project to initialise</li>
        <li>Go to <strong>Project Settings → API</strong> (left sidebar)</li>
        <li>Copy the <strong>Project URL</strong> and <strong>anon / public key</strong></li>
        <li>In Settings → Database &amp; Services → click <strong>Connect Database</strong> → paste both values</li>
        <li>Click <strong>Test Connection</strong> — when it shows ✅, click <strong>View SQL Schema</strong></li>
        <li>Copy the SQL, open <strong>Supabase → SQL Editor</strong>, paste it, click <strong>Run</strong></li>
        <li>Back in the app → click <strong>Save &amp; Continue</strong></li>
      </ol>
      <div style="margin-top:10px;padding:8px 12px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:4px;font-size:11px;color:#166534;">
        ✅ Free tier: 500 MB storage, unlimited API calls — more than enough for a pharmacy.
      </div>
    </div>

    <!-- FAQ -->
    <div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#0d9488;margin-bottom:10px;">FAQ</div>
      <div style="font-size:12px;color:#475569;line-height:1.8;">
        <p style="margin:0 0 8px;"><strong>Is my data private?</strong><br>
        Yes. Your Supabase project belongs to your account. Only devices with your URL and key can access it. The app never sends your data anywhere else.</p>
        <p style="margin:0 0 8px;"><strong>What happens if I don't connect Supabase?</strong><br>
        Everything works offline on this device. Invoices, inventory, and settings are saved locally. You just can't sync to other devices or access data from a second computer.</p>
        <p style="margin:0 0 8px;"><strong>Can I add cloud sync later?</strong><br>
        Yes — at any time from Settings → Database &amp; Services → Connect Database. Your existing local data will sync up automatically.</p>
        <p style="margin:0;"><strong>What if I already set up Supabase and want a second device?</strong><br>
        Go to Settings → Database &amp; Services → click <strong>Add Another Device</strong>. Copy the link and open it on the second device.</p>
      </div>
    </div>

    <!-- EmailJS section -->
    <div style="margin-bottom:8px;">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin-bottom:10px;">
        Step 2 — Email Password Recovery <span style="font-weight:400;font-size:11px;background:#f1f5f9;padding:2px 7px;border-radius:10px;margin-left:4px;">Optional</span>
      </div>
      <div style="font-size:12px;color:#475569;line-height:1.8;">
        <strong>What is EmailJS?</strong> A free service that lets the app send password-reset emails from your own inbox — no server required. Without it, you still have the default password (12345678) as a fallback.
      </div>
      <ol style="font-size:12px;color:#475569;line-height:2;margin:10px 0 0 16px;padding:0;">
        <li>Go to <a href="https://www.emailjs.com" target="_blank" style="color:#0d9488;font-weight:600;">emailjs.com</a> → Create a free account</li>
        <li>Add an Email Service (Gmail, Outlook, etc.) → copy the <strong>Service ID</strong></li>
        <li>Create an Email Template with these exact variable names:<br>
          <span style="font-family:monospace;font-size:11px;background:#f1f5f9;padding:2px 5px;border-radius:3px;">{{to_email}}</span>
          <span style="font-family:monospace;font-size:11px;background:#f1f5f9;padding:2px 5px;border-radius:3px;">{{reset_pin}}</span>
          <span style="font-family:monospace;font-size:11px;background:#f1f5f9;padding:2px 5px;border-radius:3px;">{{shop_name}}</span>
          <span style="font-family:monospace;font-size:11px;background:#f1f5f9;padding:2px 5px;border-radius:3px;">{{expires_in}}</span>
        </li>
        <li>Copy the <strong>Template ID</strong></li>
        <li>Go to Account → API Keys → copy the <strong>Public Key</strong></li>
        <li>In Settings → Database &amp; Services → Email Recovery → click <strong>Set Up</strong> → paste all four values</li>
      </ol>
    </div>

  </div>
  <!-- Footer -->
  <div style="padding:14px 24px;border-top:1px solid #f1f5f9;display:flex;gap:10px;align-items:center;">
    <button onclick="(function(){document.getElementById('_setupGuideModal').style.display='none';if(typeof reconnectDatabase==='function')reconnectDatabase();})()"
      style="padding:10px 20px;background:#0d9488;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">
      Connect Database →
    </button>
    <button onclick="document.getElementById('_setupGuideModal').style.display='none'"
      style="padding:10px 18px;background:transparent;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#64748b;cursor:pointer;">
      Close
    </button>
  </div>
</div>`;

    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);
};
