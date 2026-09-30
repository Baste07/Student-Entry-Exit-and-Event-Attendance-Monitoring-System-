/* Choose the Entry-Exit page from the saved scan preference or a one-visit mode link. */
(function (root) {
    'use strict';

    function preferredMode(settings, search = '') {
        const requested = new URLSearchParams(search).get('mode');
        if (requested === 'face' || requested === 'qr') return requested;
        return settings?.scanMethod === 'qr' ? 'qr' : 'face';
    }

    function pageFor(mode) {
        return mode === 'qr' ? 'qrAttendance.html' : 'entryExitScanner.html';
    }

    function go(mode, { replace = false, override = true } = {}) {
        const target = new URL(pageFor(mode), root.location.href);
        target.searchParams.set('v', '20260927b');
        if (override) target.searchParams.set('mode', mode);
        root.sessionStorage.setItem('allowed_admin_route', target.pathname);
        if (replace) root.location.replace(target.href);
        else root.location.assign(target.href);
    }

    function redirectIfPreferred(settings, currentMode) {
        const desired = preferredMode(settings, root.location.search);
        if (desired === currentMode) return false;
        go(desired, { replace: true, override: false });
        return true;
    }

    const api = { preferredMode, pageFor, go, redirectIfPreferred };
    root.GateScanRoute = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
