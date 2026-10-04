const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../../shared/settings-service.js');

const source = fs.readFileSync(path.join(__dirname, '../../shared/admin-inactivity.js'), 'utf8');

function harness(minutes = '3', signOutError = false) {
    const clock = { now: 1_000_000 };
    const values = new Map();
    const tabs = [];
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ session_id: 'session-1' })).toString('base64url')}.signature`;
    function createTab() {
        const listeners = new Map();
        const documentListeners = new Map();
        const intervals = [];
        const notices = new Map();
        const warning = { shown: 0, message: '', resolve: null, open: false };
        const signOutScopes = [];
        const redirects = [];
        const window = {
            atob: text => Buffer.from(text, 'base64').toString('utf8'),
            localStorage: {
                getItem: key => values.get(key) ?? null,
                setItem: (key, value) => {
                    values.set(key, value);
                    for (const other of tabs) {
                        if (other.window !== window) other.emit('storage', { key, newValue: value });
                    }
                },
                removeItem: key => {
                    values.delete(key);
                    for (const other of tabs) {
                        if (other.window !== window) other.emit('storage', { key, newValue: null });
                    }
                }
            },
            sessionStorage: {
                getItem: key => notices.get(key) ?? null,
                setItem: (key, value) => notices.set(key, value),
                removeItem: key => notices.delete(key)
            },
            document: {
                hidden: false,
                addEventListener: (name, handler) => {
                    const handlers = documentListeners.get(name) || [];
                    handlers.push(handler); documentListeners.set(name, handlers);
                }
            },
            UIFeedback: {
                confirm(options) {
                    warning.shown++;
                    warning.message = options.message;
                    warning.open = true;
                    return new Promise(resolve => { warning.resolve = resolve; });
                },
                updateDialogMessage(message) { warning.message = message; },
                dismissDialog() {
                    if (warning.open) { warning.open = false; warning.resolve(false); }
                }
            },
            location: { replace: url => redirects.push(url) },
            setInterval: callback => { intervals.push(callback); },
            addEventListener: (name, handler) => {
                const handlers = listeners.get(name) || [];
                handlers.push(handler); listeners.set(name, handlers);
            }
        };
        const client = {
            auth: {
                getSession: async () => ({ data: { session: { user: { id: 'admin-1' }, access_token: token } }, error: null }),
                signOut: async options => { signOutScopes.push(options.scope); return { error: signOutError ? new Error('offline') : null }; },
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
            },
            from(table) {
                assert.equal(table, 'system_settings');
                return { select(columns) {
                    assert.equal(columns, 'value');
                    return { eq(key, value) {
                        assert.equal(key, 'key');
                        assert.equal(value, 'admin_inactivity_timeout_minutes');
                        return { maybeSingle: async () => ({ data: { value: minutes }, error: null }) };
                    } };
                } };
            }
        };
        class FakeDate extends Date { static now() { return clock.now; } }
        vm.runInNewContext(source, { window, Date: FakeDate, URL, console });
        const tab = {
            window, warning, signOutScopes, redirects, notices,
            emit(name, event) { for (const handler of listeners.get(name) || []) handler(event); },
            user(name) {
                for (const handler of documentListeners.get(name) || []) {
                    handler({ isTrusted: true, target: { closest: () => null } });
                }
            },
            background(name) {
                for (const handler of documentListeners.get(name) || []) {
                    handler({ isTrusted: false, target: { closest: () => null } });
                }
            },
            tick() { intervals[0](); },
            async start() {
                await window.AdminInactivity.start({ client, userId: 'admin-1',
                    appRoot: new URL('https://school.example/'),
                    projectUrl: 'https://ehyqvyglirirktfmdezq.supabase.co' });
            }
        };
        tabs.push(tab);
        return tab;
    }
    return { clock, createTab, values };
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test('timeout setting rejects 2 and accepts 3 and larger integers', async () => {
    const db = { from: () => ({ upsert: rows => ({ select: async () => ({ data: rows, error: null }) }) }) };
    assert.equal(settings.validAdminTimeoutMinutes('2'), false);
    assert.equal(settings.validAdminTimeoutMinutes('3'), true);
    assert.equal(settings.validAdminTimeoutMinutes('15'), true);
    await assert.rejects(settings.save(db, 'system', { admin_inactivity_timeout_minutes: '2' }), /at least 3/);
    await settings.save(db, 'system', { admin_inactivity_timeout_minutes: '3' });
    await settings.save(db, 'system', { admin_inactivity_timeout_minutes: '15' });
});

test('System Settings rejects an invalid value before sending a write', async () => {
    const code = fs.readFileSync(path.join(__dirname, '../../admin/system-settings.js'), 'utf8');
    const input = { value: '2' };
    const button = { disabled: false };
    const status = { textContent: '' };
    const writes = [];
    const errors = [];
    let notified = 0;
    const context = {
        document: {
            addEventListener() {},
            getElementById(id) {
                return { adminInactivityTimeout: input, saveAdminInactivityTimeout: button,
                    adminInactivityStatus: status }[id];
            }
        },
        AppSettings: {
            validAdminTimeoutMinutes: settings.validAdminTimeoutMinutes,
            async save(_client, scope, rows) { writes.push({ scope, rows }); }
        },
        UIFeedback: { fieldError: (_field, message) => errors.push(message), success() {}, error() {} },
        window: { AdminInactivity: { settingChanged() { notified++; } } },
        supabaseClient: {}, logSystemAudit: async () => {}, console
    };
    vm.runInNewContext(code, context);
    await context.saveAdminInactivityTimeout();
    assert.equal(writes.length, 0);
    assert.match(errors[0], /at least 3/);
    input.value = '3';
    await context.saveAdminInactivityTimeout();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].rows.admin_inactivity_timeout_minutes, '3');
    assert.equal(notified, 1);
    assert.match(status.textContent, /3 minutes/);
});

test('user interaction resets idle time; background activity does not', async () => {
    const h = harness(); const tab = h.createTab(); await tab.start();
    h.clock.now += 120_000; tab.user('pointermove');
    h.clock.now += 35_000; tab.background('keydown'); tab.tick();
    assert.equal(tab.warning.shown, 0);
    h.clock.now += 116_000; tab.tick();
    assert.equal(tab.warning.shown, 1);
    assert.match(tab.warning.message, /29 seconds/);
    h.clock.now += 30_000; tab.tick(); await flush();
    assert.deepEqual(tab.signOutScopes, ['local']);
    assert.equal(tab.notices.get('admin_inactivity_notice'), '3');
    assert.deepEqual(tab.redirects, ['https://school.example/auth/login.html']);
});

test('Stay Signed In resets the timer and Log Out Now uses local Supabase sign-out', async () => {
    const h = harness(); const tab = h.createTab(); await tab.start();
    h.clock.now += 151_000; tab.tick();
    assert.equal(tab.warning.shown, 1);
    tab.warning.resolve(true); await flush();
    h.clock.now += 151_000; tab.tick();
    assert.equal(tab.warning.shown, 2);
    tab.warning.resolve(false); await flush();
    assert.deepEqual(tab.signOutScopes, ['local']);
    assert.equal(tab.notices.get('admin_inactivity_notice'), undefined);
});

test('activity and timeout synchronize across browser tabs without database writes', async () => {
    const h = harness(); const a = h.createTab(); const b = h.createTab();
    await a.start(); await b.start();
    h.clock.now += 100_000; a.user('click');
    h.clock.now += 70_000; b.tick();
    assert.equal(b.warning.shown, 0);
    h.clock.now += 81_000; b.tick();
    assert.equal(b.warning.shown, 1);
    h.clock.now += 30_000; b.tick(); await flush();
    assert.deepEqual(a.signOutScopes, ['local']);
    assert.deepEqual(b.signOutScopes, ['local']);
    assert.equal(a.notices.get('admin_inactivity_notice'), '3');
    assert.equal(b.notices.get('admin_inactivity_notice'), '3');
});

test('activity in another tab dismisses the warning without treating focus as activity', async () => {
    const h = harness(); const a = h.createTab(); const b = h.createTab();
    await a.start(); await b.start();
    h.clock.now += 151_000; b.tick();
    assert.equal(b.warning.open, true);
    b.emit('focus', {});
    assert.equal(b.warning.open, true);
    a.user('wheel'); await flush();
    assert.equal(b.warning.open, false);
    h.clock.now += 35_000; b.tick();
    assert.equal(b.signOutScopes.length, 0);
});

test('failed network sign-out clears only this Supabase project browser token', async () => {
    const h = harness('3', true);
    h.values.set('sb-ehyqvyglirirktfmdezq-auth-token', 'local-session-fixture');
    h.values.set('unrelated-key', 'preserve');
    const tab = h.createTab(); await tab.start();
    h.clock.now += 180_000; tab.tick(); await flush();
    assert.equal(h.values.has('sb-ehyqvyglirirktfmdezq-auth-token'), false);
    assert.equal(h.values.get('unrelated-key'), 'preserve');
});
