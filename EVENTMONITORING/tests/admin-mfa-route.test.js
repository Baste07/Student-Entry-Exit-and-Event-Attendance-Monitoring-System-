const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../config/config.js'), 'utf8');
const base = 'http://localhost/EVENTMONITORING/';

async function visit(relativePath, { aal = 'aal1', active = true, user = true } = {}) {
    const values = new Map([['user', 'stale-unverified-value']]);
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
    let redirected = null;
    let signedOut = false;
    const managerStarts = [];
    const document = {
        currentScript: { src: base + 'config/config.js' },
        readyState: 'complete',
        documentElement: { style: { visibility: '' }, dataset: {} },
        head: { appendChild: script => { setImmediate(() => script.onload?.()); } },
        createElement: () => ({}),
        addEventListener: () => {}
    };
    const window = {
        UIFeedback: {},
        AdminInactivity: { start: async options => managerStarts.push(options.userId) },
        location: {
            pathname: '/EVENTMONITORING/' + relativePath,
            replace: url => { redirected = url; }
        }
    };
    const client = {
        auth: {
            getUser: async () => ({ data: { user: user ? { id: 'admin-id' } : null }, error: null }),
            signOut: async () => { signedOut = true; },
            mfa: { getAuthenticatorAssuranceLevel: async () =>
                ({ data: { currentLevel: aal }, error: null }) }
        },
        from: () => ({
            select: () => ({
                eq: () => ({ maybeSingle: async () => ({
                    data: { admin_id: 'admin-id', admin_name: 'Test Admin',
                        email: 'test@example.invalid', admin_level: 'admin',
                        status: active ? 'active' : 'suspended', faculty: 'TEST' },
                    error: null
                }) })
            })
        })
    };
    vm.runInNewContext(script, {
        window, document, sessionStorage: storage, URL, console,
        ENV: { SUPABASE_PROJECT_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-test-key' },
        supabase: { createClient: () => client }
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    return { redirected, signedOut, visibility: document.documentElement.style.visibility,
        profile: values.get('user'), managerStarts };
}

test('AAL1 cannot navigate directly to admin, event, or gate pages', async () => {
    for (const route of [
        'admin/usermanagement.html',
        'TimeInAndTimeOutMonitoring/admin/eventSettings.html',
        'TimeInAndTimeOutMonitoring/students/manualAttendance.html',
        'EntryExitMonitoring/gate/qrAttendance.html'
    ]) {
        const result = await visit(route);
        assert.equal(result.redirected, base + 'auth/mfa.html');
        assert.equal(result.profile, undefined);
        assert.equal(result.visibility, 'hidden');
    }
});

test('AAL2 admin reaches module page after profile is checked', async () => {
    const result = await visit('EntryExitMonitoring/admin/settings.html', { aal: 'aal2' });
    assert.equal(result.redirected, null);
    assert.equal(result.visibility, '');
    assert.equal(JSON.parse(result.profile).id, 'admin-id');
    assert.deepEqual(result.managerStarts, ['admin-id']);
});

test('inactivity guard runs on management pages but never on scanner or student pages', async () => {
    for (const route of ['portal/portal.html', 'admin/system-settings.html',
        'TimeInAndTimeOutMonitoring/admin/eventSettings.html',
        'EntryExitMonitoring/admin/settings.html']) {
        assert.deepEqual((await visit(route, { aal: 'aal2' })).managerStarts, ['admin-id']);
    }
    for (const route of ['TimeInAndTimeOutMonitoring/students/manualAttendance.html',
        'TimeInAndTimeOutMonitoring/students/accountRegistration.html',
        'EntryExitMonitoring/gate/qrAttendance.html',
        'EntryExitMonitoring/gate/entryExitScanner.html']) {
        assert.deepEqual((await visit(route, { aal: 'aal2' })).managerStarts, []);
    }
});

test('suspended admin is signed out even with AAL2', async () => {
    const result = await visit('portal/portal.html', { aal: 'aal2', active: false });
    assert.equal(result.redirected, base + 'auth/login.html');
    assert.equal(result.signedOut, true);
    assert.equal(result.profile, undefined);
});

test('unauthenticated page visit goes to login', async () => {
    const result = await visit('admin/system-settings.html', { user: false });
    assert.equal(result.redirected, base + 'auth/login.html');
});

test('the MFA page stays available to an AAL1 session', async () => {
    const result = await visit('auth/mfa.html');
    assert.equal(result.redirected, null);
    assert.equal(result.visibility, '');
});
