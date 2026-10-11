const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

function settingsPage(script) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', checked: false, disabled: false, textContent: '',
            classList: { classes: new Set(), toggle(name, on) {
                if (on) this.classes.add(name);
                else this.classes.delete(name);
            } }
        });
        return elements.get(id);
    };
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById: element },
        AppSettings: { enabled: settings.enabled, hasSaved: () => false },
        window: {}
    });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, script), 'utf8'), context);
    return { context, element };
}

test('Master SMS OFF disables Gate and Event controls without changing stored preferences', () => {
    const gate = settingsPage('../../EntryExitMonitoring/resc/js/settings.js');
    vm.runInContext("storedGateSettings = { sms_enabled: 'true', cooldown: '10', scanMethod: 'face' }; systemSettings = { sms_enabled: 'false' }; applyToForm(storedGateSettings)", gate.context);
    assert.equal(gate.element('gateSmsEnabled').checked, true);
    assert.equal(gate.element('gateSmsEnabled').disabled, true);
    assert.ok(gate.element('gateSmsRow').classList.classes.has('is-unavailable'));
    gate.element('gateSmsEnabled').checked = false; // Simulate a direct DOM change despite disabled UI.
    assert.equal(vm.runInContext('formValues().sms_enabled', gate.context), true);
    vm.runInContext('applyToForm(AppSettings.defaults.gate)', Object.assign(gate.context, {
        AppSettings: { ...gate.context.AppSettings, defaults: { gate: { ...settings.defaults.gate } } }
    }));
    assert.equal(gate.element('gateSmsEnabled').checked, true);
    vm.runInContext("systemSettings.sms_enabled = 'true'; updateEffectiveSms()", gate.context);
    assert.equal(gate.element('gateSmsEnabled').disabled, false);

    const event = settingsPage('../../TimeInAndTimeOutMonitoring/resc/js/eventSettings.js');
    vm.runInContext("savedEventSettings = { sms_enabled: 'true' }; systemEventSettings = { sms_enabled: 'false' }; document.getElementById('eventSmsEnabled').checked = true; showEventSmsStatus()", event.context);
    assert.equal(event.element('eventSmsEnabled').checked, true);
    assert.equal(event.element('eventSmsEnabled').disabled, true);
    assert.ok(event.element('eventSmsRow').classList.classes.has('is-unavailable'));
    vm.runInContext("systemEventSettings.sms_enabled = 'true'; showEventSmsStatus()", event.context);
    assert.equal(event.element('eventSmsEnabled').disabled, false);
});

test('saving another Event setting while Master SMS is OFF cannot overwrite the SMS preference', async () => {
    const event = settingsPage('../../TimeInAndTimeOutMonitoring/resc/js/eventSettings.js');
    let savedChanges;
    event.context.AppSettings.save = async (_client, _scope, changes) => { savedChanges = changes; };
    event.context.UIFeedback = { success() {}, toast() {}, error() {}, fieldError() {} };
    event.context.logSystemAudit = async () => {};
    event.context.supabaseClient = {};
    vm.runInContext("savedEventSettings = { sms_enabled: 'true', late_grace_minutes: '15' }; systemEventSettings = { sms_enabled: 'false' }; showEventSmsStatus()", event.context);
    event.element('eventSmsEnabled').checked = false; // Bypass the disabled control in the test DOM.
    event.element('lateGraceMinutes').value = '20';
    await vm.runInContext('saveEventSettings()', event.context);
    assert.deepEqual(Object.keys(savedChanges), ['late_grace_minutes']);
    assert.equal(savedChanges.late_grace_minutes, '20');
});

test('Event header school logo matches the packaged asset with exact case', () => {
    const relative = 'TimeInAndTimeOutMonitoring/resc/assets/El Tres Eres Cencia Escuela.jpg';
    const header = fs.readFileSync(path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring/includes/header.html'), 'utf8');
    const allowlist = fs.readFileSync(path.resolve(__dirname, '../../../tools/web_allowlist.txt'), 'utf8');
    assert.match(header, /src="\.\.\/resc\/assets\/El Tres Eres Cencia Escuela\.jpg"/);
    assert.ok(allowlist.split(/\r?\n/).includes(relative));
    const directory = path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring/resc/assets');
    assert.ok(fs.readdirSync(directory).includes('El Tres Eres Cencia Escuela.jpg'));
});
