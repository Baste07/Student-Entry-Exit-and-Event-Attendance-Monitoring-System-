const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const route = require('../../EntryExitMonitoring/resc/js/gate-scan-route.js');
const { extractGateQrId, movementFromLatest, buildGateLog } = require('../../EntryExitMonitoring/resc/js/qrAttendance.js');

test('saved scan method chooses the default page, while a deliberate switch lasts for that visit', () => {
    assert.equal(route.preferredMode({ scanMethod: 'qr' }), 'qr');
    assert.equal(route.preferredMode({ scanMethod: 'face' }), 'face');
    assert.equal(route.preferredMode({ scanMethod: 'qr' }, '?mode=face'), 'face');
    assert.equal(route.preferredMode({ scanMethod: 'face' }, '?mode=qr'), 'qr');
});

test('redirect sets the gate navigation token for the destination page', () => {
    const oldLocation = globalThis.location;
    const oldStorage = globalThis.sessionStorage;
    const stored = new Map();
    let redirected = '';
    globalThis.location = {
        href: 'http://localhost/CAPSTONEFINAL/EVENTMONITORING/EntryExitMonitoring/gate/entryExitScanner.html',
        search: '',
        replace: url => { redirected = url; }
    };
    globalThis.sessionStorage = { setItem: (key, value) => stored.set(key, value) };
    try {
        assert.equal(route.redirectIfPreferred({ scanMethod: 'qr' }, 'face'), true);
        assert.match(new URL(redirected).pathname, /\/gate\/qrAttendance\.html$/);
        assert.equal(new URL(redirected).searchParams.get('v'), '20260927b');
        assert.equal(stored.get('allowed_admin_route'), new URL(redirected).pathname);
        globalThis.location.search = '?mode=face';
        redirected = '';
        assert.equal(route.redirectIfPreferred({ scanMethod: 'qr' }, 'face'), false);
        assert.equal(redirected, '');

        globalThis.location.href = 'http://localhost/CAPSTONEFINAL/EVENTMONITORING/EntryExitMonitoring/gate/qrAttendance.html';
        globalThis.location.search = '';
        assert.equal(route.redirectIfPreferred({ scanMethod: 'face' }, 'qr'), true);
        assert.match(new URL(redirected).pathname, /\/gate\/entryExitScanner\.html$/);
        assert.equal(stored.get('allowed_admin_route'), new URL(redirected).pathname);
        globalThis.location.search = '?mode=qr';
        assert.equal(route.redirectIfPreferred({ scanMethod: 'face' }, 'qr'), false);
    } finally {
        globalThis.location = oldLocation;
        globalThis.sessionStorage = oldStorage;
    }
});

test('settings Gate Scanner link opens the saved QR or face page directly', () => {
    const source = fs.readFileSync(require.resolve('../../EntryExitMonitoring/resc/js/settings.js'), 'utf8');
    const routes = [];
    const stored = new Map();
    const context = vm.createContext({
        URL,
        document: { addEventListener() {} },
        window: { location: {
            href: 'http://localhost/CAPSTONEFINAL/EVENTMONITORING/EntryExitMonitoring/admin/settings.html',
            assign(url) { routes.push(url); }
        } },
        sessionStorage: { setItem(key, value) { stored.set(key, value); } },
        UIFeedback: { error() { throw new Error('Gate settings unexpectedly unavailable'); } }
    });
    vm.runInContext(source, context);
    const click = { target: { closest: () => ({}) }, button: 0, preventDefault() {} };
    for (const [setting, page] of [['qr', 'qrAttendance.html'], ['face', 'entryExitScanner.html']]) {
        vm.runInContext(`storedGateSettings = { scanMethod: '${setting}' }`, context);
        context.openSavedGateScanner(click);
        assert.equal(new URL(routes.at(-1)).pathname.endsWith(`/gate/${page}`), true);
        assert.equal(stored.get('allowed_admin_route'), new URL(routes.at(-1)).pathname);
    }
});

test('QR payload parser accepts student IDs in plain text, JSON and URLs', () => {
    assert.deepEqual(extractGateQrId('K-001'), { id: 'K-001', role: 'student' });
    assert.deepEqual(extractGateQrId('{"stud_id":"10-1234"}'), { id: '10-1234', role: 'student' });
    assert.deepEqual(extractGateQrId('https://school.example/qr?stud_id=5-123'), { id: '5-123', role: 'student' });
    assert.deepEqual(extractGateQrId('PLP Laboratory Attendance QR\nName: Test Student\nStudent ID: K-001\nSection: Rose'), { id: 'K-001', role: 'student' });
    assert.deepEqual(extractGateQrId('EMP12345'), { id: 'EMP12345', role: 'employee' });
    assert.equal(extractGateQrId('unrelated QR data'), null);
});

test('gate QR and manual records keep the correct person, movement and late rules', () => {
    assert.equal(movementFromLatest('true', 'entry'), 'exit');
    assert.equal(movementFromLatest('true', 'exit'), 'entry');
    assert.equal(movementFromLatest('false', 'entry'), 'entry');

    const now = { date: '2026-09-27', clock: '07:31' };
    const timestamp = '2026-09-26T23:31:00.000Z';
    const settings = { lateThreshold: '07:30' };
    const student = buildGateLog({ student_id: 'student-uuid' }, 'student', 'qr', 'entry', now, timestamp, settings);
    assert.deepEqual(student, {
        student_id: 'student-uuid', employee_id: null, log_type: 'entry', scan_method: 'qr',
        log_date: now.date, log_timestamp: timestamp, is_late: true
    });
    const employee = buildGateLog({ employee_id: 'employee-uuid' }, 'employee', 'manual', 'entry', now, timestamp, settings);
    assert.equal(employee.employee_id, 'employee-uuid');
    assert.equal(employee.student_id, null);
    assert.equal(employee.is_late, false);
    assert.equal(buildGateLog({ student_id: 'student-uuid' }, 'student', 'qr', 'exit', now, timestamp, settings).is_late, false);
});
