const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../../config/config.js'), 'utf8');

function load(mode, pathname = '/EVENTMONITORING/auth/login.html') {
    const styles = [];
    let authOptions, authEvent;
    const document = {
        currentScript: { src: 'https://school.example/EVENTMONITORING/config/config.js' },
        documentElement: { dataset: {}, style: {} },
        head: { appendChild: item => styles.push(item) },
        createElement: () => ({ textContent: '' }),
        addEventListener: () => {}
    };
    const window = { location: { pathname }, dispatchEvent() {} };
    vm.runInNewContext(script, {
        window, document, URL, console, Event: class { constructor(type) { this.type = type; } },
        supabase: { createClient(_url, _key, options) {
            authOptions = options.auth;
            return { auth: { onAuthStateChange(callback) { authEvent = callback; } } };
        } },
        ENV: { SUPABASE_PROJECT_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'public', DEPLOYMENT_MODE: mode }
    });
    return { window, document, styles, authOptions, authEvent: () => authEvent };
}

test('WEB mode hides local controls and resolves the application root from the script', () => {
    const { window, document, styles } = load('WEB');
    const controls = [{ hidden: false }, { hidden: false }];
    window.AppDeployment.applyNavigation({ querySelectorAll: () => controls });
    assert.equal(window.AppDeployment.isWeb, true);
    assert.equal(window.AppDeployment.root.pathname, '/EVENTMONITORING/');
    assert.equal(document.documentElement.dataset.deploymentMode, 'WEB');
    assert.ok(controls.every(control => control.hidden));
    assert.match(styles[0].textContent, /data-local-operation/);
    assert.equal(window.AppDeployment.apiRoute('../../admin/create-admin.php'),
        'https://school.example/EVENTMONITORING/api/create-admin');
    assert.equal(window.AppDeployment.apiRoute('../../admin/send-student-qr-email.php'),
        'https://school.example/EVENTMONITORING/api/send-student-qr-email');
    assert.throws(() => window.AppDeployment.apiRoute('../../trigger_attendance.php'), /Unsupported WEB API route/);
});

test('LOCAL_GATE keeps scanner controls available', () => {
    const { window, styles } = load('LOCAL_GATE');
    const control = { hidden: false };
    window.AppDeployment.applyNavigation({ querySelectorAll: () => [control] });
    assert.equal(window.AppDeployment.isLocalGate, true);
    assert.equal(control.hidden, false);
    assert.equal(styles.length, 0);
    assert.equal(window.AppDeployment.apiRoute('../../admin/create-admin.php'), '../../admin/create-admin.php');
});

test('only the reset page parses recovery links and subscribes before its page script', () => {
    const login = load('WEB');
    assert.equal(login.authOptions.detectSessionInUrl, false);
    assert.equal(login.authEvent(), undefined);
    const reset = load('WEB', '/EVENTMONITORING/auth/reset-password.html');
    assert.equal(reset.authOptions.detectSessionInUrl, true);
    reset.authEvent()('PASSWORD_RECOVERY', { user: { id: 'test-uid' } });
    assert.equal(reset.window.passwordRecoverySessionReady, true);
});

test('Entry & Exit management links resolve in WEB and LOCAL_GATE layouts', () => {
    const header = fs.readFileSync(path.join(__dirname, '../../EntryExitMonitoring/includes/header.html'), 'utf8');
    const qrPage = fs.readFileSync(path.join(__dirname, '../../EntryExitMonitoring/gate/qrAttendance.html'), 'utf8');
    const headerHref = header.match(/href="([^"]+)"[^>]*class="header-back-btn"/)?.[1];
    const qrHref = qrPage.match(/href="([^"]+)" id="backToDashboard"/)?.[1];
    assert.equal(headerHref, '../../portal/portal.html');
    assert.equal(qrHref, '../../portal/portal.html');

    for (const prefix of ['/', '/CAPSTONEFINAL/EVENTMONITORING/']) {
        const base = `https://school.example${prefix}`;
        assert.equal(new URL(headerHref, `${base}EntryExitMonitoring/admin/dashboard.html`).pathname,
            `${prefix}portal/portal.html`);
        assert.equal(new URL(qrHref, `${base}EntryExitMonitoring/gate/qrAttendance.html`).pathname,
            `${prefix}portal/portal.html`);
    }
});
