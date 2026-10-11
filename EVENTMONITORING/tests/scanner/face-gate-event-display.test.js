const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/entryExitScanner.js'), 'utf8');

function scannerPage() {
    const elements = new Map();
    const timers = [];
    const displayed = [];
    let stream;
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            style: {}, textContent: '', innerHTML: '', className: '',
            classList: { add() {}, remove() {} }
        });
        return elements.get(id);
    };
    const context = vm.createContext({
        document: { getElementById: element, addEventListener() {} },
        setTimeout(_callback, delay) { timers.push(delay); },
        clearTimeout() {},
        EventSource: class { constructor() { stream = this; } },
        adminAal2Fetch: async () => ({ ok: true }),
        console
    });
    vm.runInContext(source, context);
    context.showResultStudent = (_person, movement) => displayed.push(movement);
    context.showResultEmployee = (_name, _number, _department, movement) => displayed.push(movement);
    context.flashStatus = () => {};
    context.setStatus = () => {};
    context.showInfoOverlay = () => {};
    context.handleSpoofDetected = async () => {};
    vm.runInContext('engineOnline = true', context);
    return { context, element, timers, displayed, start: async () => {
        await vm.runInContext('startFaceMode()', context);
        return stream;
    } };
}

test('every server-confirmed face Entry and Exit is displayed, including the historical 5/10-second gap', async () => {
    for (const configuredCooldown of [5, 10]) {
        const page = scannerPage();
        const stream = await page.start();
        const deliver = (type, movement) => stream.onmessage({ data: JSON.stringify({
            type, name: 'Student A', role: 'student', log_type: movement, stud_id: '1-0001'
        }) });

        await deliver('gate_recorded', 'entry');
        // Inside the configured cooldown Flask emits no second gate_recorded event.
        assert.deepEqual(page.displayed, ['entry']);
        // Flask has now accepted a later scan. The browser must show its result,
        // even when the historical face default is 5 seconds rather than 10.
        await deliver('gate_recorded', 'exit');
        assert.deepEqual(page.displayed, ['entry', 'exit'], `cooldown ${configuredCooldown}s`);
        await deliver('error');
        await deliver('gate_recorded', 'entry');
        assert.deepEqual(page.displayed, ['entry', 'exit', 'entry']);
    }
});

test('face result overlay still has its independent five-second dismissal timer', () => {
    const page = scannerPage();
    vm.runInContext("showGateResultOverlay('Student A', '', '', false)", page.context);
    assert.ok(page.timers.includes(5000));
    assert.match(page.element('gateResultTimerFill').style.animation, /5s linear/);
});

test('QR/ID uses the saved cooldown for both Entry and Exit without hiding accepted results', async () => {
    const qrSource = fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/qrAttendance.js'), 'utf8');
    for (const configured of [null, 5, 10]) {
        const seconds = configured ?? 10;
        const elements = new Map();
        const inserted = [];
        const statuses = [];
        const element = id => {
            if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', className: '' });
            return elements.get(id);
        };
        const context = vm.createContext({
            document: { getElementById: element, addEventListener() {} },
            supabaseClient: { from: () => ({ insert: async log => {
                inserted.push(log);
                return { error: null };
            } }) },
            console
        });
        vm.runInContext(qrSource, context);
        context.clock = 100000;
        vm.runInContext('Date.now = () => clock', context);
        context.nextMovement = async () => inserted.length ? 'exit' : 'entry';
        context.showStatus = message => statuses.push(message);
        vm.runInContext(`gateSettings = { ${configured === null ? '' : `cooldown: '${configured}',`} enforceGateHours: 'false', lateThreshold: '07:30' }`, context);
        const prepare = () => vm.runInContext("pendingPerson = { person: { student_id: 'student-a' }, role: 'student', source: 'manual' }", context);

        prepare();
        await vm.runInContext('recordCheckIn()', context);
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].log_type, 'entry');
        assert.match(element('previewMessage').textContent, /Entry recorded/);

        context.clock += seconds * 1000 - 1000;
        prepare();
        await vm.runInContext('recordCheckIn()', context);
        assert.equal(inserted.length, 1);
        assert.ok(statuses.some(message => /Please wait 1 seconds/.test(message)));

        context.clock += 1000;
        await vm.runInContext('recordCheckIn()', context);
        assert.equal(inserted.length, 2);
        assert.equal(inserted[1].log_type, 'exit');
        assert.match(element('previewMessage').textContent, /Exit recorded/);
    }
});
