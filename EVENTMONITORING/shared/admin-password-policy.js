(function (root) {
    'use strict';
    const message = 'Password must contain at least 12 characters, including uppercase and lowercase letters, a number, and a special character.';

    function checks(password) {
        return {
            length: [...password].length >= 12 && [...password].length <= 256,
            uppercase: /[A-Z]/.test(password),
            lowercase: /[a-z]/.test(password),
            number: /[0-9]/.test(password),
            special: /[^A-Za-z0-9\s]/.test(password)
        };
    }
    function valid(password, email, name) {
        if (typeof password !== 'string' || !Object.values(checks(password)).every(Boolean)) return false;
        const lower = password.toLowerCase();
        const address = String(email || '').trim().toLowerCase();
        if (address && lower.includes(address)) return false;
        const localPart = address.split('@')[0];
        if (localPart.length >= 3 && lower.includes(localPart)) return false;
        return !(String(name || '').toLowerCase().match(/[a-z]{3,}/g) || [])
            .some(word => lower.includes(word));
    }
    function render(list, password) {
        if (!list) return;
        const state = checks(password);
        list.querySelectorAll('[data-password-rule]').forEach(item => {
            const met = state[item.dataset.passwordRule] === true;
            item.classList.toggle('met', met);
            item.setAttribute('aria-label', `${met ? 'Met' : 'Not met'}: ${item.textContent.trim()}`);
        });
    }
    root.AdminPasswordPolicy = { message, checks, valid, render };
})(typeof window !== 'undefined' ? window : globalThis);
