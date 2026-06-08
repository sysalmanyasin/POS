// =========================================================================
// MODULE: UIModule — Custom confirm dialog + XSS escape + PIN lockout
// BUG 11 FIX: Added _renderChunked() utility — slices large arrays into
//             idle-callback batches so the main thread never freezes during
//             high-volume data renders (history, reporting, inventory lists).
// =========================================================================
const UIModule = (() => {
    let _okCb = null;
    let _cancelCb = null;

    function showConfirmModal(msg, okCallback, cancelCallback, okLabel, danger, cancelLabel, okClass) {
        const titEl = document.getElementById('ccmTitle');
        const subEl = document.getElementById('ccmSub');
        const msgEl = document.getElementById('ccmMsg');
        const okBtn = document.getElementById('ccmOkBtn');
        const canBtn = document.getElementById('ccmCancelBtn');
        if (msg && typeof msg === 'object' && msg.title) {
            if (titEl) { titEl.textContent = msg.title; titEl.style.display = ''; }
            if (subEl) { subEl.textContent = msg.subtitle || ''; subEl.style.display = ''; }
            if (msgEl) msgEl.style.display = 'none';
        } else {
            if (titEl) titEl.style.display = 'none';
            if (subEl) subEl.style.display = 'none';
            if (msgEl) { msgEl.textContent = msg || ''; msgEl.style.display = ''; }
        }
        okBtn.textContent = okLabel || 'Confirm';
        okBtn.className = 'ccm-ok' + (danger ? ' danger' : '') + (okClass ? ' ' + okClass : '');
        if (canBtn) canBtn.textContent = cancelLabel || 'Cancel';
        _okCb = okCallback || null;
        _cancelCb = cancelCallback || null;
        document.getElementById('customConfirmModal').classList.add('visible');
        document.getElementById('customConfirmModal')._openedAt = Date.now();
        document.getElementById('ccmOkBtn').focus();
    }

    function ccmConfirm() {
        document.getElementById('customConfirmModal').classList.remove('visible');
        if (typeof _okCb === 'function') _okCb();
        _okCb = null; _cancelCb = null;
    }

    function ccmCancel() {
        document.getElementById('customConfirmModal').classList.remove('visible');
        if (typeof _cancelCb === 'function') _cancelCb();
        _okCb = null; _cancelCb = null;
    }

    return { showConfirmModal, ccmConfirm, ccmCancel };
})();

window.showConfirmModal = UIModule.showConfirmModal;
window.ccmConfirm       = UIModule.ccmConfirm;
window.ccmCancel        = UIModule.ccmCancel;

// Keyboard support for confirm modal
document.addEventListener('keydown', function(e) {
    const modal = document.getElementById('customConfirmModal');
    if (!modal || !modal.classList.contains('visible')) return;
    if (e.key === 'Escape' && modal._openedAt && (Date.now() - modal._openedAt) < 80) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); UIModule.ccmCancel(); }
    if (e.key === 'Enter')  { e.stopImmediatePropagation(); UIModule.ccmConfirm(); }
}, true);

// =========================================================================
// GLOBAL XSS ESCAPE HELPER
// =========================================================================
function _escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =========================================================================
// BUG 11 FIX — Chunked Idle Renderer
// Renders large data arrays in batches during idle time so the main thread
// never blocks during a checkout or barcode scan.
//
// Usage:
//   _renderChunked(dataArray, CHUNK_SIZE, (chunk, isFirst) => {
//       chunk.forEach(item => container.appendChild(buildRow(item)));
//   }, () => { /* done callback */ });
// =========================================================================
function _renderChunked(data, chunkSize, renderFn, doneFn) {
    if (!Array.isArray(data) || data.length === 0) {
        if (typeof doneFn === 'function') doneFn();
        return;
    }
    const ric    = window._ric || ((cb) => setTimeout(() => cb({ timeRemaining: () => 16 }), 0));
    let   offset = 0;

    function processChunk(deadline) {
        const isFirst = offset === 0;
        while (offset < data.length && deadline.timeRemaining() > 2) {
            const end   = Math.min(offset + chunkSize, data.length);
            const chunk = data.slice(offset, end);
            renderFn(chunk, isFirst && offset === 0);
            offset = end;
        }
        if (offset < data.length) {
            ric(processChunk, { timeout: 500 });
        } else {
            if (typeof doneFn === 'function') doneFn();
        }
    }
    ric(processChunk, { timeout: 500 });
}

// =========================================================================
// PIN LOCKOUT HELPERS — 5 wrong attempts → 30-second lockout
// =========================================================================
const _pinAttempts = {};
function _pinLockKey(ctx) { return '_pin_lock_' + ctx; }
function _loadPinState(ctx) {
    if (_pinAttempts[ctx]) return;
    try {
        const raw = sessionStorage.getItem(_pinLockKey(ctx));
        if (raw) _pinAttempts[ctx] = JSON.parse(raw);
    } catch(e) {}
}
function _savePinState(ctx) {
    try {
        if (_pinAttempts[ctx]) sessionStorage.setItem(_pinLockKey(ctx), JSON.stringify(_pinAttempts[ctx]));
        else sessionStorage.removeItem(_pinLockKey(ctx));
    } catch(e) {}
}
function _isPinLocked(ctx) {
    _loadPinState(ctx);
    const s = _pinAttempts[ctx];
    if (!s) return false;
    if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
    if (s.lockedUntil && Date.now() >= s.lockedUntil) { delete _pinAttempts[ctx]; _savePinState(ctx); }
    return false;
}
function _recordPinFailure(ctx) {
    _loadPinState(ctx);
    if (!_pinAttempts[ctx]) _pinAttempts[ctx] = { count: 0, lockedUntil: null };
    _pinAttempts[ctx].count++;
    if (_pinAttempts[ctx].count >= 5) {
        _pinAttempts[ctx].lockedUntil = Date.now() + 30_000;
        _pinAttempts[ctx].count = 0;
        _savePinState(ctx);
        return true;
    }
    _savePinState(ctx);
    return false;
}
function _clearPinFailures(ctx) { delete _pinAttempts[ctx]; _savePinState(ctx); }
