const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/qrAttendance.js'), 'utf8');
const studentUuid = '123e4567-e89b-42d3-a456-426614174000';
const studentBUuid = '123e4567-e89b-42d3-a456-426614174001';
const qrPayload = `student_uuid:${studentUuid}`;
const qrPayloadB = `student_uuid:${studentBUuid}`;
const student = {
    student_id: studentUuid, stud_id: '1-0001', first_name: 'John', middle_name: 'Sebastian',
    last_name: 'Larga', current_grade_level: 'Grade 1', sections: { section_name: 'MABAIT' }
};
const studentB = { ...student, student_id: studentBUuid, stud_id: '1-0014', first_name: 'Jane' };
const employee = { employee_id: 'employee-uuid', emp_no: 'EMP123', first_name: 'Maria',
    last_name: 'Reyes', faculty: 'Office' };

async function scannerPage({ cameraStartFailures = 0, cameraStartFailureKind = 'permission',
    cameraStartGate = null, cameras = [{ id: 'external-a', type: 'external' }],
    cameraError = null, redirect = false, withTrack = false } = {}) {
    const elements = new Map();
    const lookups = [];
    const logs = [];
    let onReady;
    let cameraDecode;
    let cameraMiss;
    let cameraTrackEnded;
    let gunTimer;
    let cameraStarts = 0;
    const cameraAttempts = [];
    let cameraStops = 0;
    let cameraClears = 0;
    let beeps = 0;
    let failNextInsert = false;
    let nextTimerId = 0;
    const timers = new Map();
    const windowHandlers = {};
    let selected = 'student';
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', className: '', disabled: false, hidden: false,
            handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
            querySelector() { return id === 'qrReader' && withTrack ? { srcObject: {
                getVideoTracks: () => [{ addEventListener(event, callback) {
                    if (event === 'ended') cameraTrackEnded = callback;
                } }]
            } } : null; },
            focus() {}, setAttribute() {}, classList: { add() {}, remove() {} }
        });
        return elements.get(id);
    };
    const radios = ['student', 'employee'].map(value => ({
        value, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
        get checked() { return selected === value; }, set checked(checked) { if (checked) selected = value; }
    }));
    const client = {
        from(table) {
            const filters = [];
            return {
                select() { return this; },
                eq(column, value) { filters.push([column, value]); return this; },
                order() { return this; },
                async limit() {
                    lookups.push({ table, filters: [...filters] });
                    const rows = table === 'students' ? [student, studentB] : table === 'employees' ? [employee]
                        : table === 'entry_exit_logs' ? [...logs].reverse() : [];
                    return { data: rows.filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, 1), error: null };
                },
                async insert(log) {
                    assert.equal(table, 'entry_exit_logs');
                    if (failNextInsert) { failNextInsert = false; return { error: { message: 'Test failure' } }; }
                    logs.push(log);
                    return { error: null };
                }
            };
        },
        async rpc() { return { data: false, error: null }; }
    };
    const context = vm.createContext({
        document: {
            getElementById: element,
            addEventListener(event, handler) { if (event === 'DOMContentLoaded') onReady = handler; },
            querySelectorAll() { return radios; },
            querySelector(selector) {
                if (selector.endsWith(':checked')) return radios.find(radio => radio.checked);
                return radios.find(radio => selector.includes(`value="${radio.value}"`));
            }
        },
        window: {
            gateRouteAuthorized: true, setInterval() {},
            addEventListener(event, handler) { windowHandlers[event] = handler; },
            AudioContext: class {
                currentTime = 0;
                destination = {};
                createOscillator() { return {
                    connect() {}, type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                    start() { beeps++; }, stop() {}, onended: null
                }; }
                createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
                close() {}
            }
        },
        supabaseClient: client,
        AppSettings: { async load() { return {
            cooldown: '10', autoExit: 'true', enforceGateHours: 'false', lateThreshold: '23:59'
        }; } },
        GateScanRoute: { redirectIfPreferred() { return redirect; } },
        PreferredCamera: { async listVideoInputs() {
            if (cameraError) throw new Error(cameraError);
            return cameras;
        } },
        Html5Qrcode: class {
            async start(cameraConfig, _options, callback, onError) {
                cameraStarts++;
                cameraAttempts.push(cameraConfig);
                if (cameraStartGate) await cameraStartGate;
                if (cameraStartFailures-- > 0) throw Object.assign(new Error('Camera start failed'), {
                    name: cameraStartFailureKind === 'permission' ? 'NotAllowedError' : 'NotReadableError'
                });
                cameraDecode = callback;
                cameraMiss = onError;
            }
            async stop() { cameraStops++; }
            async clear() { cameraClears++; }
        },
        setTimeout(callback, delay) {
            const id = ++nextTimerId;
            timers.set(id, { callback, delay });
            if (delay === 350) gunTimer = { id, callback };
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
            if (gunTimer?.id === id) gunTimer = null;
        },
        URL, console
    });
    vm.runInContext(source, context);
    await onReady();
    await new Promise(setImmediate);
    return {
        context, element, radios, lookups, logs, cameraAttempts,
        counts() { return { cameraStarts, cameraStops, cameraClears, beeps }; },
        failNextInsert() { failNextInsert = true; },
        runTimer(delay) {
            const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
            assert.ok(entry, `Expected a ${delay} ms timer`);
            timers.delete(entry[0]);
            entry[1].callback();
        },
        async startCamera() {
            if (!vm.runInContext('qrCamera !== null', context)) element('cameraButton').handlers.click();
            await new Promise(setImmediate);
            assert.ok(cameraDecode);
            assert.equal(vm.runInContext('qrCamera !== null', context), true);
        },
        async stopCamera() {
            element('cameraButton').handlers.click();
            await new Promise(setImmediate);
        },
        async cameraMiss() { cameraMiss(); },
        async disconnectCamera() {
            assert.ok(cameraTrackEnded);
            cameraTrackEnded();
            await new Promise(setImmediate);
        },
        async navigateAway() { windowHandlers.pagehide(); await new Promise(setImmediate); },
        async lookup(id, role = 'student', sourceType = 'manual', autoRecord = false) {
            element('personId').value = id;
            await vm.runInContext(`prepareCheckIn(${JSON.stringify(id)}, ${JSON.stringify(role)}, ${JSON.stringify(sourceType)}, ${autoRecord})`, context);
        },
        async cameraScan(raw) {
            if (!vm.runInContext('qrCamera !== null', context)) await this.startCamera();
            assert.ok(cameraDecode);
            await cameraDecode(raw);
        },
        async gunScan(raw) {
            element('qrGunButton').handlers.click({ currentTarget: element('qrGunButton') });
            element('personId').value = raw;
            element('personId').handlers.keydown({ key: 'Enter', preventDefault() {}, currentTarget: element('personId') });
            await new Promise(setImmediate);
        },
        async gunAutoScan(raw) {
            element('qrGunButton').handlers.click({ currentTarget: element('qrGunButton') });
            element('personId').value = raw;
            element('personId').handlers.input({ currentTarget: element('personId') });
            assert.ok(gunTimer);
            const callback = gunTimer.callback;
            timers.delete(gunTimer.id);
            gunTimer = null;
            callback();
            await new Promise(setImmediate);
        }
    };
}

test('QR lookup uses the permanent UUID while the field and result show the display ID', async () => {
    const page = await scannerPage();
    await page.lookup(qrPayload, 'student', 'qr');
    assert.deepEqual(page.lookups[0], { table: 'students', filters: [['student_id', studentUuid]] });
    assert.equal(page.element('personId').value, '1-0001');
    assert.equal(page.element('previewName').textContent, 'John Sebastian Larga');
    assert.match(page.element('previewMeta').textContent, /1-0001.*Grade 1.*MABAIT/);
    assert.equal(page.element('previewCard').hidden, false);
    assert.equal(vm.runInContext('pendingPerson.person.student_id', page.context), studentUuid);
    await vm.runInContext('recordCheckIn()', page.context);
    assert.equal(page.logs[0].student_id, studentUuid);
    assert.equal(page.logs[0].log_type, 'entry');
    assert.match(page.element('previewMessage').textContent, /Entry recorded/);
    assert.ok(!page.element('personId').value.includes('student_uuid:'));
});

test('manual ID, Search Again, and role switching stay separate from QR lookup', async () => {
    const page = await scannerPage();
    await page.lookup('1-0001');
    assert.deepEqual(page.lookups[0], { table: 'students', filters: [['stud_id', '1-0001']] });
    assert.equal(page.element('personId').value, '1-0001');
    page.element('againButton').handlers.click();
    assert.equal(page.element('personId').value, '');
    assert.equal(page.element('previewCard').hidden, true);
    await page.lookup(qrPayload, 'student', 'qr');
    page.radios[1].checked = true;
    page.radios[1].handlers.change();
    assert.equal(page.element('personId').value, '');
    assert.equal(page.element('previewCard').hidden, true);
    assert.match(page.element('idLabel').innerHTML, /Employee Number/);
    await page.lookup('EMP123', 'employee');
    assert.deepEqual(page.lookups.at(-2), { table: 'employees', filters: [['emp_no', 'EMP123']] });
    assert.equal(page.element('personId').value, 'EMP123');
});

test('camera QR and QR Gun both record by UUID without leaving the raw payload visible', async () => {
    const camera = await scannerPage();
    await camera.cameraScan(qrPayload);
    assert.deepEqual(camera.lookups[0], { table: 'students', filters: [['student_id', studentUuid]] });
    assert.equal(camera.element('personId').value, '1-0001');
    assert.equal(camera.logs[0].student_id, studentUuid);
    assert.match(camera.element('previewMessage').textContent, /Entry recorded/);

    const gun = await scannerPage();
    await gun.gunScan(qrPayload);
    assert.deepEqual(gun.lookups[0], { table: 'students', filters: [['student_id', studentUuid]] });
    assert.equal(gun.logs[0].student_id, studentUuid);
    assert.equal(gun.element('personId').value, ''); // Ready for the next gun scan.
    assert.match(gun.element('previewMeta').textContent, /1-0001.*Grade 1.*MABAIT/);

    const autoGun = await scannerPage();
    await autoGun.gunAutoScan(qrPayload);
    assert.deepEqual(autoGun.lookups[0], { table: 'students', filters: [['student_id', studentUuid]] });
    assert.equal(autoGun.logs[0].student_id, studentUuid);
    assert.equal(autoGun.element('personId').value, '');
});

test('QR cooldown still blocks a repeat and Auto Exit records the next eligible movement', async () => {
    const page = await scannerPage();
    page.context.clock = 100_000;
    vm.runInContext('Date.now = () => clock', page.context);
    await page.lookup(qrPayload, 'student', 'qr', true);
    assert.equal(page.logs.length, 1);
    assert.equal(page.logs[0].log_type, 'entry');
    page.context.clock += 5_000;
    await page.lookup(qrPayload, 'student', 'qr', true);
    assert.equal(page.logs.length, 1);
    assert.equal(page.element('personId').value, '1-0001');
    assert.match(page.element('pageStatus').textContent, /Please wait/);
    page.context.clock += 5_000;
    await vm.runInContext('recordCheckIn()', page.context);
    assert.equal(page.logs.length, 2);
    assert.equal(page.logs[1].student_id, studentUuid);
    assert.equal(page.logs[1].log_type, 'exit');
    assert.match(page.element('previewMessage').textContent, /Exit recorded/);
});

test('camera stays open, beeps once per saved scan, and accepts a different student immediately', async () => {
    const page = await scannerPage();
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 1);
    assert.deepEqual(page.counts(), { cameraStarts: 1, cameraStops: 0, cameraClears: 0, beeps: 1 });
    assert.equal(page.element('personId').value, '1-0001');
    assert.equal(page.logs[0].student_id, studentUuid);

    await page.cameraScan(qrPayload);
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 1);
    assert.equal(page.lookups.filter(lookup => lookup.table === 'students').length, 1);
    assert.equal(page.counts().beeps, 1);

    await page.cameraScan(qrPayloadB);
    assert.equal(page.logs.length, 2);
    assert.equal(page.logs[1].student_id, studentBUuid);
    assert.equal(page.element('personId').value, '1-0014');
    assert.equal(page.counts().beeps, 2);
    assert.equal(page.counts().cameraStarts, 1);
    assert.equal(page.counts().cameraStops, 0);
    await page.cameraScan(qrPayload); // Returning to A while both QRs are still in view stays quiet.
    assert.equal(page.lookups.filter(lookup => lookup.table === 'students').length, 2);
    assert.equal(page.logs.length, 2);
    assert.equal(page.counts().beeps, 2);
});

test('a held QR stays suppressed beyond business cooldown until it leaves the frame', async () => {
    const page = await scannerPage();
    page.context.clock = 100_000;
    vm.runInContext('Date.now = () => clock', page.context);
    await page.cameraScan(qrPayload);
    page.context.clock += 12_000;
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 1);
    assert.equal(page.counts().beeps, 1);

    await page.cameraMiss();
    await page.cameraScan(qrPayload); // A new decode cancels the brief absence timer.
    assert.throws(() => page.runTimer(750), /Expected a 750 ms timer/);
    assert.equal(page.logs.length, 1);

    await page.cameraMiss();
    page.runTimer(750); // QR left the view long enough to re-arm the same identity.
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 2);
    assert.equal(page.logs[1].log_type, 'exit');
    assert.equal(page.counts().beeps, 2);
    assert.equal(page.counts().cameraStarts, 1);
});

test('invalid, unknown, and failed-save QR scans keep the camera ready without a false beep', async () => {
    const page = await scannerPage();
    await page.cameraScan('not a school QR');
    assert.match(page.element('pageStatus').textContent, /does not contain a supported/);
    assert.equal(page.counts().cameraStops, 0);

    await page.cameraScan('student_uuid:123e4567-e89b-42d3-a456-426614174099');
    assert.match(page.element('pageStatus').textContent, /ID not found/);
    assert.equal(page.counts().beeps, 0);
    assert.equal(page.counts().cameraStops, 0);

    page.failNextInsert();
    await page.cameraScan(qrPayload);
    assert.match(page.element('pageStatus').textContent, /Could not save/);
    assert.equal(page.logs.length, 0);
    assert.equal(page.counts().beeps, 0);
    assert.equal(page.counts().cameraStops, 0);

    await page.cameraScan(qrPayloadB);
    assert.equal(page.logs.length, 1);
    assert.equal(page.counts().beeps, 1);
    assert.equal(page.counts().cameraStops, 0);
});

test('Stop, navigation, and switching to QR Gun release the camera without duplicate streams', async () => {
    const page = await scannerPage();
    await page.startCamera();
    await page.stopCamera();
    assert.equal(vm.runInContext('qrCamera === null', page.context), true);
    assert.equal(page.element('qrReader').hidden, true);
    assert.deepEqual(page.counts(), { cameraStarts: 1, cameraStops: 1, cameraClears: 1, beeps: 0 });

    await page.startCamera();
    await page.navigateAway();
    assert.equal(vm.runInContext('qrCamera === null', page.context), true);
    assert.deepEqual(page.counts(), { cameraStarts: 2, cameraStops: 2, cameraClears: 2, beeps: 0 });

    const modePage = await scannerPage();
    await modePage.startCamera();
    modePage.element('qrGunButton').handlers.click({ currentTarget: modePage.element('qrGunButton') });
    await new Promise(setImmediate);
    assert.equal(vm.runInContext('qrCamera === null', modePage.context), true);
    assert.equal(modePage.counts().cameraStops, 1);
    assert.equal(modePage.counts().cameraClears, 1);
    await modePage.startCamera();
    assert.equal(vm.runInContext('qrGunMode', modePage.context), false);
    assert.equal(modePage.counts().cameraStarts, 2);
});

test('QR Camera starts after settings load without a button click and never opens duplicate streams', async () => {
    const page = await scannerPage();
    assert.equal(page.counts().cameraStarts, 1);
    assert.equal(page.element('qrReader').hidden, false);
    assert.match(page.element('cameraButton').innerHTML, /Stop Camera/);
    await vm.runInContext('Promise.all([startQrCamera(), startQrCamera()])', page.context);
    assert.equal(page.counts().cameraStarts, 1);
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 1);
    assert.equal(page.counts().beeps, 1);
    assert.equal(page.counts().cameraStops, 0);
});

test('QR Gun releases the webcam and switching back starts QR Camera automatically', async () => {
    const page = await scannerPage();
    page.element('qrGunButton').handlers.click({ currentTarget: page.element('qrGunButton') });
    await new Promise(setImmediate);
    assert.equal(page.counts().cameraStops, 1);
    assert.equal(page.counts().cameraClears, 1);
    assert.equal(page.element('qrReader').hidden, true);
    assert.equal(vm.runInContext('qrGunMode', page.context), true);

    page.element('qrGunButton').handlers.click({ currentTarget: page.element('qrGunButton') });
    await new Promise(setImmediate);
    assert.equal(page.counts().cameraStarts, 2);
    assert.equal(vm.runInContext('qrGunMode', page.context), false);
    assert.equal(page.element('qrReader').hidden, false);
    await page.stopCamera();
    assert.equal(page.counts().cameraStops, 2);
    await page.startCamera(); // Explicit restart remains available after Stop Camera.
    assert.equal(page.counts().cameraStarts, 3);
});

test('typing a manual ID releases the default camera and keeps manual lookup usable', async () => {
    const page = await scannerPage();
    page.element('personId').value = '1-0001';
    page.element('personId').handlers.input({ currentTarget: page.element('personId') });
    await new Promise(setImmediate);
    assert.equal(page.counts().cameraStops, 1);
    assert.equal(page.element('qrReader').hidden, true);
    await page.lookup('1-0001');
    assert.deepEqual(page.lookups[0], { table: 'students', filters: [['stud_id', '1-0001']] });
    await page.startCamera();
    assert.equal(page.counts().cameraStarts, 2);
});

test('failed automatic camera start leaves manual retry usable without repeated prompts', async () => {
    const page = await scannerPage({ cameraStartFailures: 1 });
    assert.equal(page.counts().cameraStarts, 1); // Permission denial does not try a second camera.
    assert.equal(page.counts().cameraClears, 1);
    assert.equal(page.element('qrReader').hidden, true);
    assert.equal(page.element('cameraButton').disabled, false);
    assert.match(page.element('pageStatus').textContent, /Camera Access Required/);
    await page.startCamera();
    assert.equal(page.counts().cameraStarts, 2);
    assert.equal(page.element('qrReader').hidden, false);
});

test('switching modes during a pending camera start releases the old stream before restarting', async () => {
    let releaseStart;
    const gate = new Promise(resolve => { releaseStart = resolve; });
    const page = await scannerPage({ cameraStartGate: gate });
    assert.equal(page.counts().cameraStarts, 1);
    page.element('qrGunButton').handlers.click({ currentTarget: page.element('qrGunButton') });
    page.element('qrGunButton').handlers.click({ currentTarget: page.element('qrGunButton') });
    releaseStart();
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(page.counts().cameraStarts, 2);
    assert.equal(page.counts().cameraStops, 1);
    assert.equal(page.counts().cameraClears, 1);
    assert.equal(vm.runInContext('qrCamera !== null', page.context), true);
});

test('redirecting away from QR route does not request a camera', async () => {
    const page = await scannerPage({ redirect: true });
    assert.equal(page.counts().cameraStarts, 0);
});

test('Entry/Exit QR tries external devices before local and falls back when one is unusable', async () => {
    const page = await scannerPage({ cameraStartFailures: 2, cameraStartFailureKind: 'busy',
        cameras: [
            { id: 'external-a', type: 'external' },
            { id: 'external-b', type: 'external' },
            { id: 'built-in', type: 'local' }
        ] });
    assert.deepEqual(page.cameraAttempts.map(config => config.deviceId.exact),
        ['external-a', 'external-b', 'built-in']);
    assert.equal(page.counts().cameraStarts, 3);
    assert.equal(page.element('qrReader').hidden, false);
    await page.stopCamera();
    assert.equal(page.counts().cameraStops, 1);
});

test('Entry/Exit QR handles no camera and permission denial without retry loops', async () => {
    const missing = await scannerPage({ cameraError: 'NO_CAMERA_FOUND' });
    assert.equal(missing.counts().cameraStarts, 0);
    assert.match(missing.element('pageStatus').textContent, /Camera Required/);
    assert.equal(missing.element('cameraButton').disabled, false);

    const denied = await scannerPage({ cameraError: 'CAMERA_PERMISSION_DENIED' });
    assert.equal(denied.counts().cameraStarts, 0);
    assert.match(denied.element('pageStatus').textContent, /Camera Access Required/);
});

test('Entry/Exit QR releases a disconnected webcam and leaves restart available', async () => {
    const page = await scannerPage({ withTrack: true });
    await page.disconnectCamera();
    assert.equal(page.counts().cameraStops, 1);
    assert.equal(page.element('qrReader').hidden, true);
    assert.match(page.element('pageStatus').textContent, /Camera Unavailable.*disconnected/);
    await page.startCamera();
    assert.equal(page.counts().cameraStarts, 2);
});

test('Entry/Exit QR keeps scanning and recording independently of Event completion', async () => {
    assert.doesNotMatch(source, /\.from\(['"](?:events|event_attendance)['"]\)/);
    const page = await scannerPage();
    await page.cameraScan(qrPayload);
    assert.equal(page.logs.length, 1);
    assert.equal(page.logs[0].log_type, 'entry');
    assert.equal(page.counts().cameraStops, 0);
    assert.equal(vm.runInContext('qrCamera !== null', page.context), true);
    await page.stopCamera();
    assert.equal(page.counts().cameraStops, 1);
});
