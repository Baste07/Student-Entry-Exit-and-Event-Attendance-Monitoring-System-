const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../../shared/settings-service.js');

function client(rowsByTable) {
    return { from(table) {
        return {
            select: async () => ({ data: rowsByTable[table] || [], error: null }),
            upsert: rows => ({ select: async () => { rowsByTable[table] = rows; return { data: rows, error: null }; } })
        };
    } };
}

test('module SMS preferences survive master off and resume when master returns', async () => {
    const rows = { system_settings: [], gate_settings: [], event_settings: [] };
    const db = client(rows);
    const gate = await settings.load(db, 'gate', { refresh: true });
    const event = await settings.load(db, 'event', { refresh: true });
    await settings.save(db, 'system', { sms_enabled: false });
    let system = await settings.load(db, 'system', { refresh: true });
    assert.equal(settings.effectiveSms(system, gate), false);
    assert.equal(settings.effectiveSms(system, event), false);
    assert.equal(gate.sms_enabled, 'true');
    assert.equal(event.sms_enabled, 'true');
    await settings.save(db, 'system', { sms_enabled: true });
    system = await settings.load(db, 'system', { refresh: true });
    assert.equal(settings.effectiveSms(system, gate), true);
    assert.equal(settings.effectiveSms(system, event), true);
});

test('settings helper rejects writes to unrelated keys', async () => {
    await assert.rejects(settings.save(client({}), 'system', { service_role_key: 'secret' }), /Unsupported setting/);
});

test('legacy missing Event table keeps 15-minute grace, but network errors surface', async () => {
    const absent = { from: () => ({ select: async () => ({ data: null, error: { code: 'PGRST205' } }) }) };
    const values = await settings.load(absent, 'event', { refresh: true, missingTableDefaults: true });
    assert.equal(values.late_grace_minutes, '15');
    const offline = { from: () => ({ select: async () => ({ data: null, error: { code: 'NETWORK_ERROR' } }) }) };
    await assert.rejects(settings.load(offline, 'event', { refresh: true, missingTableDefaults: true }));
});

test('three settings pages load their scripts and expose no duplicate controls', () => {
    const pages = [
        '../../admin/system-settings.html',
        '../../EntryExitMonitoring/admin/settings.html',
        '../../TimeInAndTimeOutMonitoring/admin/eventSettings.html'
    ];
    for (const relative of pages) {
        const filename = path.resolve(__dirname, relative);
        const html = fs.readFileSync(filename, 'utf8');
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        assert.equal(ids.length, new Set(ids).size, `${relative} has duplicate element IDs`);
        const assets = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)]
            .map(match => match[1].split('?')[0]).filter(url => !/^https?:/.test(url));
        assert.deepEqual(assets.filter(url => !fs.existsSync(path.resolve(path.dirname(filename), url))), []);
        assert.ok(html.includes('settings-service.js'));
    }
    const eventPage = fs.readFileSync(path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring/admin/eventSettings.html'), 'utf8');
    assert.ok(!/laboratory settings|lab_settings/i.test(eventPage));
});
