/* Small browser-side reader for the three key/value settings scopes. */
(function (root) {
    'use strict';
    const tables = { system: 'system_settings', gate: 'gate_settings', event: 'event_settings' };
    const defaults = {
        system: { sms_enabled: 'true', anti_spoof_enabled: 'true', school_year_end_month_day: '03-25',
            admin_inactivity_timeout_minutes: '3', admin_login_max_attempts: '3' },
        gate: {
            gateOpen: '06:00', gateClose: '18:00', lateThreshold: '07:30',
            enforceGateHours: 'false', scanMethod: 'face', autoExit: 'true',
            cooldown: '10', sms_enabled: 'true'
        },
        event: { sms_enabled: 'true', late_grace_minutes: '15' }
    };
    const cache = {};
    const savedKeys = {};

    function missingTable(error) {
        return ['42P01', 'PGRST205'].includes(error?.code)
            || /could not find the table|relation .* does not exist/i.test(String(error?.message || ''));
    }

    async function load(client, scope, { refresh = false, missingTableDefaults = false } = {}) {
        if (!tables[scope]) throw new Error('Unknown settings scope');
        if (!refresh && cache[scope]) return { ...cache[scope] };
        const { data, error } = await client.from(tables[scope]).select('key,value');
        if (error) {
            if (!missingTableDefaults || !missingTable(error)) throw error;
            cache[scope] = { ...defaults[scope] };
            savedKeys[scope] = new Set();
            return { ...cache[scope] };
        }
        const result = { ...defaults[scope] };
        (data || []).forEach(row => {
            if (Object.hasOwn(result, row.key)) result[row.key] = String(row.value);
        });
        savedKeys[scope] = new Set((data || []).map(row => row.key));
        cache[scope] = result;
        return { ...result };
    }

    async function save(client, scope, changes) {
        if (!tables[scope]) throw new Error('Unknown settings scope');
        const rows = Object.entries(changes).map(([key, value]) => {
            if (!Object.hasOwn(defaults[scope], key)) throw new Error(`Unsupported setting: ${key}`);
            if (scope === 'system' && key === 'admin_inactivity_timeout_minutes' &&
                !validAdminTimeoutMinutes(value)) throw new Error('Inactivity timeout must be at least 3 whole minutes.');
            if (scope === 'system' && key === 'admin_login_max_attempts' &&
                !validAdminLoginMaxAttempts(value)) throw new Error('Maximum failed logins must be a whole number from 3 to 6.');
            return { key, value: String(value) };
        });
        if (!rows.length) return;
        const { data: saved, error } = await client.from(tables[scope]).upsert(rows, { onConflict: 'key' }).select('key,value');
        if (error) throw error;
        const savedMap = new Map((saved || []).map(row => [row.key, String(row.value)]));
        if (rows.some(row => savedMap.get(row.key) !== row.value)) {
            throw new Error('Settings could not be verified after saving');
        }
        cache[scope] = { ...(cache[scope] || defaults[scope]), ...Object.fromEntries(rows.map(row => [row.key, row.value])) };
        if (!savedKeys[scope]) savedKeys[scope] = new Set();
        rows.forEach(row => savedKeys[scope].add(row.key));
    }

    function enabled(settings, key) { return String(settings?.[key]).toLowerCase() === 'true'; }
    function validAdminTimeoutMinutes(value) {
        const text = String(value ?? '');
        return /^([3-9]|[1-9][0-9]+)$/.test(text) && Number.isSafeInteger(Number(text));
    }
    function validAdminLoginMaxAttempts(value) { return /^[3-6]$/.test(String(value ?? '')); }
    function effectiveSms(system, module) { return enabled(system, 'sms_enabled') && enabled(module, 'sms_enabled'); }
    function hasSaved(scope, key) { return !!savedKeys[scope]?.has(key); }
    const api = { defaults, load, save, enabled, effectiveSms, hasSaved,
        validAdminTimeoutMinutes, validAdminLoginMaxAttempts };
    root.AppSettings = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
