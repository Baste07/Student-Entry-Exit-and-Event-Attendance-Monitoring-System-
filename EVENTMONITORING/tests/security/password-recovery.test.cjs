const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../auth/reset-password.js'), 'utf8');

function page({ hasFactor = true, verifyError = null } = {}) {
    const elements = Object.fromEntries(['resetBtn', 'newPassword', 'confirmPassword',
        'recoveryMfaWrap', 'recoveryMfaCode', 'status-alert', 'status-message', 'status-icon']
        .map(id => [id, {
            disabled: true, hidden: id === 'recoveryMfaWrap', value: '', textContent: '', style: {}, innerHTML: '',
            classList: { add() {}, remove() {} },
            addEventListener(type, callback) { this[type] = callback; }
        }]));
    const listeners = {};
    const timers = [];
    let authEvent;
    let updated = 0;
    let signedOut = 0;
    let challenged = 0;
    let verified = 0;
    let aal = 'aal1';
    const client = {
        auth: {
            onAuthStateChange(callback) { authEvent = callback; },
            async getUser() { return { data: { user: { id: 'admin' } }, error: null }; },
            mfa: {
                async listFactors() { return { data: { totp: hasFactor ? [{ id: 'factor', status: 'verified' }] : [] }, error: null }; },
                async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: aal }, error: null }; },
                async challenge({ factorId }) { assert.equal(factorId, 'factor'); challenged++; return { data: { id: 'challenge' }, error: null }; },
                async verify({ factorId, challengeId, code }) {
                    assert.equal(factorId, 'factor');
                    assert.equal(challengeId, 'challenge');
                    assert.equal(code, '123456');
                    verified++;
                    if (!verifyError) aal = 'aal2';
                    return { error: verifyError };
                }
            },
            async updateUser({ password }) { assert.ok(password); updated++; return { error: null }; },
            async signOut() { signedOut++; return { error: null }; }
        }
    };
    const window = {
        location: { pathname: '/auth/reset-password.html', href: '' },
        history: { replaceState() {} },
        addEventListener(type, callback) { listeners[type] = callback; },
        dispatchEvent(event) { listeners[event.type]?.(); }
    };
    const document = {
        getElementById(id) { return elements[id]; },
        addEventListener(type, callback) { listeners[type] = callback; }
    };
    vm.runInNewContext(source, { supabaseClient: client, document, window,
        Event: class { constructor(type) { this.type = type; } },
        setTimeout(callback) { timers.push(callback); } });
    listeners.DOMContentLoaded();
    return { elements, authEvent: async (event, session) => { authEvent(event, session); await new Promise(setImmediate); },
        expireCheck: () => timers[0](), updates: () => updated, signouts: () => signedOut,
        challenged: () => challenged, verified: () => verified };
}

test('ordinary session or missing recovery link cannot submit a password', async () => {
    const p = page();
    await p.authEvent('SIGNED_IN', { user: { id: 'admin' } });
    p.expireCheck();
    assert.equal(p.elements.resetBtn.disabled, true);
    assert.match(p.elements['status-message'].textContent, /invalid or expired/);
    await p.elements.resetBtn.click();
    assert.equal(p.updates(), 0);
});

test('enrolled factor requires a valid TOTP challenge before password update', async () => {
    const p = page();
    await p.authEvent('PASSWORD_RECOVERY', { user: { id: 'admin' } });
    assert.equal(p.elements.recoveryMfaWrap.hidden, false);
    assert.equal(p.elements.resetBtn.disabled, false);
    p.elements.newPassword.value = 'strong-new-password';
    p.elements.confirmPassword.value = 'strong-new-password';
    await p.elements.resetBtn.click();
    assert.equal(p.updates(), 0);
    p.elements.recoveryMfaCode.value = '123456';
    await p.elements.resetBtn.click();
    assert.equal(p.challenged(), 1);
    assert.equal(p.verified(), 1);
    assert.equal(p.updates(), 1);
    assert.equal(p.signouts(), 1);
    assert.equal(p.elements.newPassword.value, '');
    assert.equal(p.elements.recoveryMfaCode.value, '');
});

test('failed TOTP verification blocks password update', async () => {
    const p = page({ verifyError: { status: 422, code: 'invalid_credentials' } });
    await p.authEvent('PASSWORD_RECOVERY', { user: { id: 'admin' } });
    p.elements.newPassword.value = 'strong-new-password';
    p.elements.confirmPassword.value = 'strong-new-password';
    p.elements.recoveryMfaCode.value = '123456';
    await p.elements.resetBtn.click();
    assert.equal(p.updates(), 0);
    assert.equal(p.signouts(), 0);
    assert.equal(p.elements.recoveryMfaCode.value, '');
});

test('account without an enrolled factor can reset and must enroll on next login', async () => {
    const p = page({ hasFactor: false });
    await p.authEvent('PASSWORD_RECOVERY', { user: { id: 'admin' } });
    assert.equal(p.elements.recoveryMfaWrap.hidden, true);
    p.elements.newPassword.value = 'strong-new-password';
    p.elements.confirmPassword.value = 'strong-new-password';
    await p.elements.resetBtn.click();
    assert.equal(p.updates(), 1);
    assert.equal(p.signouts(), 1);
});
