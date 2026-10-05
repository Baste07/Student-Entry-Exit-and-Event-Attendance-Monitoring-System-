const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const authDir = path.resolve(__dirname, '../../auth');
const loginSource = fs.readFileSync(path.join(authDir, 'login.js'), 'utf8');
const registrationSource = fs.readFileSync(path.join(authDir, 'register.js'), 'utf8');

function loginPage(profiles = {}, assuranceLevel = 'aal1', pageUrl = 'http://localhost/auth/login.html') {
    const nodes = new Map();
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, {
            value: '', textContent: '', innerHTML: '', style: {}, disabled: false,
            classList: { add() {}, remove() {} },
            listeners: {},
            addEventListener(name, handler) { this.listeners[name] = handler; },
            focus() {}, click() { return this.listeners.click?.(); }
        });
        return nodes.get(id);
    };
    const form = element('form');
    const calls = { signIns: [], resets: [], recoveryOptions: [], signOuts: 0, completed: [], redirects: [] };
    const client = {
        auth: {
            async setSession({ access_token }) {
                const profile = Object.values(profiles).find(item => item.admin_id === access_token);
                return { data: { user: profile ? { id: profile.admin_id } : null }, error: null };
            },
            async signOut() { calls.signOuts++; },
            async resetPasswordForEmail(email, options) {
                calls.resets.push(email);
                calls.recoveryOptions.push(options);
                return { error: null };
            },
            mfa: { async getAuthenticatorAssuranceLevel() {
                return { data: { currentLevel: assuranceLevel }, error: null };
            } }
        },
        from(table) {
            assert.equal(table, 'admins');
            return { select() { return this; }, eq(_column, id) {
                return { async maybeSingle() {
                    return { data: Object.values(profiles).find(profile => profile.admin_id === id) || null,
                        error: null };
                } };
            } };
        }
    };
    const context = {
        document: {
            querySelector(selector) {
                if (selector === 'form') return form;
                if (selector === '.btn-signin') return element('submit');
                return null;
            },
            getElementById: element,
            addEventListener(name, handler) { if (name === 'DOMContentLoaded') handler(); }
        },
        sessionStorage: { removeItem() {}, getItem() { return null; } },
        window: { AppDeployment: { apiRoute: () => '/api/admin-login' }, location: { href: pageUrl,
            replace(path) { calls.redirects.push(path); } } },
        supabaseClient: client,
        AppDeployment: { apiRoute: () => '/api/admin-login' },
        async fetch(_url, options) {
            const { email } = JSON.parse(options.body);
            calls.signIns.push(email);
            const profile = profiles[email];
            const result = profile
                ? { success: true, userId: profile.admin_id,
                    access_token: profile.admin_id, refresh_token: 'test-refresh' }
                : { success: false, message: 'Invalid email or password.' };
            return { ok: !!profile, async json() { return result; } };
        },
        AdminMFA: { async completeLogin(profile) { calls.completed.push(profile.admin_level); } },
        console: { log() {}, error() {} },
        URL,
        setTimeout() {}
    };
    vm.createContext(context);
    vm.runInContext(loginSource, context);
    return { element, form, calls, context };
}

test('login and registration accept any valid email domain and reject malformed addresses', () => {
    const page = loginPage();
    const registration = vm.createContext({ document: { getElementById() { return {}; },
        addEventListener() {} } });
    vm.runInContext(registrationSource, registration);
    for (const email of ['admin@gmail.com', 'person@yahoo.com', 'user@outlook.com',
        'admin@plpasig.edu.ph', 'codex-super-20260926@example.com']) {
        assert.equal(vm.runInContext(`isValidLoginEmail(${JSON.stringify(email)})`, page.context), true);
        assert.equal(vm.runInContext(`isValidRegistrationEmail(${JSON.stringify(email)})`, registration), true);
    }
    for (const email of ['abc', 'user@', '@example.com']) {
        assert.equal(vm.runInContext(`isValidLoginEmail(${JSON.stringify(email)})`, page.context), false);
        assert.equal(vm.runInContext(`isValidRegistrationEmail(${JSON.stringify(email)})`, registration), false);
    }
});

test('login sends valid addresses to Auth, including unknown users, but blocks malformed input', async () => {
    const page = loginPage();
    page.element('password').value = 'not-a-real-password';
    for (const email of ['admin@gmail.com', 'person@yahoo.com', 'user@outlook.com',
        'admin@plpasig.edu.ph', 'codex-super-20260926@example.com']) {
        page.element('username').value = email;
        await page.form.listeners.submit({ preventDefault() {} });
    }
    assert.deepEqual(page.calls.signIns, ['admin@gmail.com', 'person@yahoo.com',
        'user@outlook.com', 'admin@plpasig.edu.ph', 'codex-super-20260926@example.com']);
    for (const email of ['abc', 'user@', '@example.com']) {
        page.element('username').value = email;
        await page.form.listeners.submit({ preventDefault() {} });
        assert.equal(page.element('error-message').textContent, 'Enter a valid email address.');
    }
    assert.equal(page.calls.signIns.length, 5);
    assert.equal(page.element('error-message').textContent, 'Enter a valid email address.');
});

test('active Admin and Super Admin proceed to MFA; suspended Admin is denied', async () => {
    const profiles = {
        'admin@gmail.com': { admin_id: 'normal', status: 'active', admin_level: 'admin', login_locked: false },
        'super@example.com': { admin_id: 'super', status: 'active', admin_level: 'super_admin', login_locked: false },
        'suspended@yahoo.com': { admin_id: 'suspended', status: 'suspended', admin_level: 'admin', login_locked: false }
    };
    const page = loginPage(profiles);
    page.element('password').value = 'not-a-real-password';
    for (const email of Object.keys(profiles)) {
        page.element('username').value = email;
        await page.form.listeners.submit({ preventDefault() {} });
    }
    assert.deepEqual(page.calls.redirects, ['mfa.html', 'mfa.html']);
    assert.equal(page.calls.signOuts, 1);
    const alreadyAal2 = loginPage(profiles, 'aal2');
    alreadyAal2.element('username').value = 'super@example.com';
    alreadyAal2.element('password').value = 'not-a-real-password';
    await alreadyAal2.form.listeners.submit({ preventDefault() {} });
    assert.deepEqual(alreadyAal2.calls.completed, ['super_admin']);
});

test('password recovery accepts valid external email and rejects malformed email', async () => {
    const page = loginPage({}, 'aal1',
        'https://eventmonitoring-dev-preview-example.vercel.app/auth/login.html');
    page.element('forgotEmailInput').value = 'person@yahoo.com';
    await page.element('sendResetBtn').listeners.click();
    assert.deepEqual(page.calls.resets, ['person@yahoo.com']);
    assert.equal(page.calls.recoveryOptions[0].redirectTo,
        'https://eventmonitoring-dev-preview-example.vercel.app/auth/reset-password.html');
    page.element('forgotEmailInput').value = 'user@';
    await page.element('sendResetBtn').listeners.click();
    assert.equal(page.element('modal-error-text').textContent, 'Enter a valid email address.');
    assert.equal(page.calls.resets.length, 1);
});
