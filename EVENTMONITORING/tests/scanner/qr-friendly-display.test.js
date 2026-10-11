const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/qrAttendance.js'), 'utf8');
const studentUuid = '123e4567-e89b-42d3-a456-426614174000';
const qrPayload = `student_uuid:${studentUuid}`;
const student = {
    student_id: studentUuid, stud_id: '1-0001', first_name: 'John', middle_name: 'Sebastian',
    last_name: 'Larga', current_grade_level: 'Grade 1', sections: { section_name: 'MABAIT' }
};
const employee = { employee_id: 'employee-uuid', emp_no: 'EMP123', first_name: 'Maria',
    last_name: 'Reyes', faculty: 'Office' };

async function scannerPage() {
    const elements = new Map();
    const lookups = [];
    const logs = [];
    let onReady;
    let cameraDecode;
    let gunTimer;
    let selected = 'student';
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', className: '', disabled: false, hidden: false,
            handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
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
                    const rows = table === 'students' ? [student] : table === 'employees' ? [employee]
                        : table === 'entry_exit_logs' ? [...logs].reverse() : [];
                    return { data: rows.filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, 1), error: null };
                },
                async insert(log) { assert.equal(table, 'entry_exit_logs'); logs.push(log); return { error: null }; }
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
        window: { gateRouteAuthorized: true, setInterval() {} },
        supabaseClient: client,
        AppSettings: { async load() { return {
            cooldown: '10', autoExit: 'true', enforceGateHours: 'false', lateThreshold: '23:59'
        }; } },
        GateScanRoute: { redirectIfPreferred() { return false; } },
        Html5Qrcode: class {
            async start(_camera, _options, callback) { cameraDecode = callback; }
            async stop() {}
            async clear() {}
        },
        setTimeout(callback) { gunTimer = callback; return 1; },
        clearTimeout() { gunTimer = null; },
        URL, console
    });
    vm.runInContext(source, context);
    await onReady();
    return {
        context, element, radios, lookups, logs,
        async lookup(id, role = 'student', sourceType = 'manual', autoRecord = false) {
            element('personId').value = id;
            await vm.runInContext(`prepareCheckIn(${JSON.stringify(id)}, ${JSON.stringify(role)}, ${JSON.stringify(sourceType)}, ${autoRecord})`, context);
        },
        async cameraScan(raw) {
            element('cameraButton').handlers.click();
            await new Promise(setImmediate);
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
            gunTimer();
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
