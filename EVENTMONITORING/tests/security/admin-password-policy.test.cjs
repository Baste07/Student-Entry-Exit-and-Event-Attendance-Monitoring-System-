const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../../shared/admin-password-policy.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const policy = context.window.AdminPasswordPolicy;

test('Admin checklist updates each requirement as the password changes', () => {
    const items = ['length', 'uppercase', 'lowercase', 'number', 'special'].map(rule => ({
        dataset: { passwordRule: rule }, textContent: rule,
        classList: { toggle(name, value) { this[name] = value; } },
        setAttribute(name, value) { this[name] = value; }
    }));
    const list = { querySelectorAll: () => items };
    policy.render(list, 'short');
    assert.equal(items.find(item => item.dataset.passwordRule === 'lowercase').classList.met, true);
    assert.equal(items.filter(item => item.classList.met).length, 1);
    policy.render(list, 'SecureRandomPhrase123!');
    assert.ok(items.every(item => item.classList.met));
    assert.ok(items.every(item => item['aria-label'].startsWith('Met:')));
});

test('Admin browser feedback rejects weak and identity-based passwords', () => {
    assert.equal(policy.valid('SecureRandomPhrase123!', 'person@example.com', 'Patricia Cruz'), true);
    assert.equal(policy.valid('😀Abcdefgh1!', 'person@example.com', 'Patricia Cruz'), false);
    for (const candidate of ['shortA1!', 'withoutuppercase123!', 'WITHOUTLOWERCASE123!',
        'WithoutNumberHere!', 'WithoutSpecial123', 'PatriciaSecure123!',
        'person@example.comA1!', 'PERSONsomethingSecure123!']) {
        assert.equal(policy.valid(candidate, 'person@example.com', 'Patricia Cruz'), false);
    }
});
