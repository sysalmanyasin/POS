// ============================================================
//  credentialShare.js — Credential Share/Import via URL + QR
// ============================================================
(function() {
  'use strict';

  const CRED_KEYS = [
    { key: 'pharma_supa_url',              label: 'Supabase URL' },
    { key: 'pharma_supa_key',              label: 'Supabase Anon Key' },
    { key: 'pharma_emailjs_service_id',    label: 'EmailJS Service ID' },
    { key: 'pharma_emailjs_template_id',   label: 'EmailJS Template ID' },
    { key: 'pharma_emailjs_public_key',    label: 'EmailJS Public Key' },
    { key: 'pharma_emailjs_reset_email',   label: 'Recovery Email' },
    { key: 'pharma_mode',                  label: 'Mode' },
    { key: 'pharma_dbx_app_key',           label: 'Dropbox App Key' },
  ];

  let _qrInstance = null;
  let _scanStream  = null;
  let _scanRaf     = null;

  // ── Build credential URL ───────────────────────────────────────────────
  function buildCredentialUrl() {
    const base = window.location.origin + window.location.pathname;
    const params = new URLSearchParams();
    params.set('cred_import', '1');
    CRED_KEYS.forEach(({ key }) => {
      const val = localStorage.getItem(key);
      if (val) params.set(key, val);
    });
    return base + '?' + params.toString();
  }

  // ── Collect current credential values ─────────────────────────────────
  function collectCreds() {
    const result = {};
    CRED_KEYS.forEach(({ key }) => {
      const v = localStorage.getItem(key);
      if (v) result[key] = v;
    });
    return result;
  }

  // ── Apply imported credentials ─────────────────────────────────────────
  function applyCredentials(creds) {
    let count = 0;
    CRED_KEYS.forEach(({ key }) => {
      if (creds[key]) {
        localStorage.setItem(key, creds[key]);
        if (typeof StorageModule !== 'undefined' && typeof StorageModule.set === 'function') {
          StorageModule.set(key, creds[key]);
        }
        count++;
      }
    });
    return count;
  }

  // ── Open modal ─────────────────────────────────────────────────────────
  window.openCredentialShareModal = function(mode) {
    const modal = document.getElementById('credShareModal');
    if (!modal) return;

    const titleEl = document.getElementById('credShareModalTitle');
    const subEl   = document.getElementById('credShareModalSub');
    const expPanel = document.getElementById('credShareExportPanel');
    const impPanel = document.getElementById('credShareImportPanel');

    if (mode === 'import') {
      titleEl.textContent = '📥 Import Credentials';
      subEl.textContent   = 'Bring credentials from another device';
      expPanel.style.display = 'none';
      impPanel.style.display = 'block';
      document.getElementById('credImportStatus').textContent = '';
      document.getElementById('credImportUrlInput').value = '';
    } else {
      titleEl.textContent = '📤 Share Credentials';
      subEl.textContent   = 'Export all API credentials';
      expPanel.style.display = 'block';
      impPanel.style.display = 'none';
      _buildExportPanel();
    }

    modal.style.display = 'flex';
  };

  function _buildExportPanel() {
    const url = buildCredentialUrl();

    // Set URL input
    const urlInput = document.getElementById('credShareUrlInput');
    if (urlInput) urlInput.value = url;

    // Build summary
    const creds = collectCreds();
    const summaryEl = document.getElementById('credShareSummary');
    if (summaryEl) {
      summaryEl.innerHTML = CRED_KEYS.map(({ key, label }) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:6px;">
          <span style="color:${creds[key] ? '#16a34a' : '#d1d5db'}">${creds[key] ? '✓' : '○'}</span>
          <span style="color:${creds[key] ? 'var(--g800)' : 'var(--g400)'}">${label}</span>
        </span>`
      ).join('');
    }

    // Generate QR
    const qrBox = document.getElementById('credShareQrBox');
    if (!qrBox) return;

    qrBox.innerHTML = '';

    if (typeof QRCode === 'undefined') {
      qrBox.innerHTML = '<div style="font-size:11px;color:#ef4444;">QR library not loaded. Copy the link above.</div>';
      return;
    }

    if (_qrInstance) {
      try { _qrInstance.clear(); } catch(e) {}
      _qrInstance = null;
    }

    const qrContainer = document.createElement('div');
    qrBox.appendChild(qrContainer);

    try {
      _qrInstance = new QRCode(qrContainer, {
        text: url,
        width: 180,
        height: 180,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch(e) {
      qrBox.innerHTML = '<div style="font-size:11px;color:#ef4444;">QR generation failed. Copy the link above.</div>';
    }
  }

  // ── Close modal ────────────────────────────────────────────────────────
  window.closeCredentialShareModal = function() {
    const modal = document.getElementById('credShareModal');
    if (modal) modal.style.display = 'none';
    stopCredQrScan();
  };

  // ── Copy URL ───────────────────────────────────────────────────────────
  window.copyCredShareUrl = function() {
    const input = document.getElementById('credShareUrlInput');
    if (!input) return;
    navigator.clipboard.writeText(input.value).then(() => {
      if (typeof showToast === 'function') showToast('✅ Link copied to clipboard!', 2000);
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      if (typeof showToast === 'function') showToast('✅ Link copied!', 2000);
    });
  };

  // ── WhatsApp share ─────────────────────────────────────────────────────
  window.shareCredWhatsApp = function() {
    const url  = buildCredentialUrl();
    const text = encodeURIComponent('🔗 DuaPharma POS Credentials\n\nPaste this link on the new device to import all credentials:\n\n' + url);
    window.open('https://wa.me/?text=' + text, '_blank');
  };

  // ── SMS share ──────────────────────────────────────────────────────────
  window.shareCredSMS = function() {
    const url  = buildCredentialUrl();
    const body = encodeURIComponent('DuaPharma POS credentials link: ' + url);
    window.open('sms:?body=' + body, '_blank');
  };

  // ── Download as .txt ───────────────────────────────────────────────────
  window.downloadCredTxt = function() {
    const url   = buildCredentialUrl();
    const creds = collectCreds();
    let content = 'DuaPharma POS — Credential Export\n';
    content += '==================================\n';
    content += 'Date: ' + new Date().toLocaleString() + '\n\n';
    content += 'SHARE LINK:\n' + url + '\n\n';
    content += 'INDIVIDUAL VALUES:\n';
    CRED_KEYS.forEach(({ key, label }) => {
      if (creds[key]) content += label + ': ' + creds[key] + '\n';
    });
    content += '\n⚠️ Keep this file secure — it contains sensitive API keys.';

    const blob = new Blob([content], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'duapharma-pos-credentials.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Import from URL ────────────────────────────────────────────────────
  window.importCredFromUrl = function() {
    const input = document.getElementById('credImportUrlInput');
    if (!input || !input.value.trim()) {
      _setImportStatus('⚠️ Please paste a share link first.', '#f59e0b');
      return;
    }
    _processCredImportUrl(input.value.trim());
  };

  function _processCredImportUrl(rawUrl) {
    try {
      let params;
      // Handle bare share link or full URL
      if (rawUrl.startsWith('http')) {
        params = new URL(rawUrl).searchParams;
      } else {
        params = new URLSearchParams(rawUrl);
      }

      const creds = {};
      CRED_KEYS.forEach(({ key }) => {
        const v = params.get(key);
        if (v) creds[key] = v;
      });

      const count = applyCredentials(creds);
      if (count === 0) {
        _setImportStatus('⚠️ No credentials found in that link.', '#f59e0b');
        return;
      }
      _setImportStatus('✅ Imported ' + count + ' credential(s)! Reloading…', '#16a34a');
      setTimeout(() => {
        closeCredentialShareModal();
        if (typeof showToast === 'function') showToast('✅ Credentials imported. Reloading app…', 2000);
        setTimeout(() => location.reload(), 1500);
      }, 1200);
    } catch(e) {
      _setImportStatus('⚠️ Invalid link format.', '#ef4444');
    }
  }

  // ── Import from file ───────────────────────────────────────────────────
  window.importCredFromFile = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      const text = e.target.result || '';
      // Try to find share URL in file
      const urlMatch = text.match(/https?:\/\/\S+/);
      if (urlMatch) {
        _processCredImportUrl(urlMatch[0]);
        return;
      }
      // Try to parse key: value pairs
      const creds = {};
      CRED_KEYS.forEach(({ key, label }) => {
        const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)', 'i');
        const m  = text.match(re);
        if (m && m[1]) creds[key] = m[1].trim();
      });
      const count = applyCredentials(creds);
      if (count === 0) {
        _setImportStatus('⚠️ No credentials found in that file.', '#f59e0b');
      } else {
        _setImportStatus('✅ Imported ' + count + ' credential(s) from file!', '#16a34a');
        setTimeout(() => {
          closeCredentialShareModal();
          if (typeof showToast === 'function') showToast('✅ Credentials imported. Reloading app…', 2000);
          setTimeout(() => location.reload(), 1500);
        }, 1200);
      }
    };
    reader.readAsText(file);
    input.value = '';
  };

  // ── Camera QR scan ─────────────────────────────────────────────────────
  window.startCredQrScan = function() {
    const video   = document.getElementById('credQrVideo');
    const stopBtn = document.getElementById('credQrStopBtn');
    if (!video) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      _setImportStatus('⚠️ Camera not available on this device.', '#f59e0b');
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function(stream) {
        _scanStream = stream;
        video.srcObject = stream;
        video.style.display = 'block';
        if (stopBtn) stopBtn.style.display = 'block';
        _setImportStatus('📷 Point camera at the QR code…', '#7c3aed');
        video.play().then(() => _runQrScanLoop(video));
      })
      .catch(function(err) {
        _setImportStatus('⚠️ Camera permission denied: ' + err.message, '#ef4444');
      });
  };

  function _runQrScanLoop(video) {
    const canvas = document.getElementById('credQrCanvas');
    if (!canvas || !video || video.readyState < 2) {
      _scanRaf = requestAnimationFrame(() => _runQrScanLoop(video));
      return;
    }
    const ctx = canvas.getContext('2d');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    // Try jsQR if available
    if (typeof jsQR !== 'undefined') {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code    = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        stopCredQrScan();
        _processCredImportUrl(code.data);
        return;
      }
    }
    _scanRaf = requestAnimationFrame(() => _runQrScanLoop(video));
  }

  window.stopCredQrScan = function() {
    if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = null; }
    if (_scanStream) {
      _scanStream.getTracks().forEach(t => t.stop());
      _scanStream = null;
    }
    const video   = document.getElementById('credQrVideo');
    const stopBtn = document.getElementById('credQrStopBtn');
    if (video)   { video.style.display = 'none'; video.srcObject = null; }
    if (stopBtn) stopBtn.style.display = 'none';
  };

  function _setImportStatus(msg, color) {
    const el = document.getElementById('credImportStatus');
    if (el) { el.textContent = msg; el.style.color = color || ''; }
  }

  // ── Close on backdrop click ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('credShareModal');
    if (modal) {
      modal.addEventListener('click', function(e) {
        if (e.target === modal) closeCredentialShareModal();
      });
    }

    // ── Auto-import if URL has cred_import=1 ──────────────────────────
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('cred_import') === '1') {
        const creds = {};
        CRED_KEYS.forEach(({ key }) => {
          const v = params.get(key);
          if (v) creds[key] = v;
        });
        const count = applyCredentials(creds);
        if (count > 0) {
          // Clean URL and notify
          const cleanUrl = window.location.origin + window.location.pathname;
          history.replaceState({}, '', cleanUrl);
          setTimeout(() => {
            if (typeof showToast === 'function') {
              showToast('✅ ' + count + ' credential(s) imported from shared link! Reload to apply.', 4000);
            } else {
              alert('✅ ' + count + ' credential(s) imported from shared link!');
            }
          }, 800);
        }
      }
    } catch(e) {}
  });

})();
