const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const studentPages = path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring/students');
const facePage = fs.readFileSync(path.join(studentPages, 'takeAttendance.html'), 'utf8');
const manualPage = fs.readFileSync(path.join(studentPages, 'manualAttendance.html'), 'utf8');
const manualPath = '/CAPSTONEFINAL/EVENTMONITORING/TimeInAndTimeOutMonitoring/students/manualAttendance.html';

function inlineScript(page, marker) {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const script = scripts.find(([, source]) => source.includes(marker));
    assert.ok(script, `${marker} script exists`);
    return script[1];
}

function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    };
}

test('Manual Attendance button opens directly using the Entry/Exit navigation marker', () => {
    let click;
    let destination;
    const sessionStorage = storage({ user: JSON.stringify({ userType: 'admin' }) });
    const context = {
        URL,
        sessionStorage,
        document: {
            getElementById(id) {
                assert.equal(id, 'manualAttendanceButton');
                return { addEventListener(event, callback) { assert.equal(event, 'click'); click = callback; } };
            },
        },
        window: {
            location: {
                href: 'http://localhost' + manualPath.replace('manualAttendance.html', 'takeAttendance.html'),
                assign(url) { destination = url; },
            },
        },
    };

    vm.runInNewContext(inlineScript(facePage, 'manualAttendanceButton'), context);
    click();

    assert.equal(sessionStorage.getItem('allowed_admin_route'), manualPath);
    assert.equal(destination, 'http://localhost' + manualPath);
    assert.doesNotMatch(facePage, /Admin \/ Teacher Access|Verify & Open|credOverlay|verifyAdminCredentials|manual_access_granted/);
    assert.doesNotMatch(manualPage, /manual_access_granted|manual_access_role/);
});

function visitManualPage(initial, pathname = manualPath) {
    let redirect = null;
    const sessionStorage = storage(initial);
    vm.runInNewContext(inlineScript(manualPage, 'enforceManualAttendanceNavigation'), {
        sessionStorage,
        window: { location: { pathname, replace(url) { redirect = url; } } },
    });
    return { redirect, sessionStorage };
}

test('existing Admin navigation opens Manual Attendance without credentials', () => {
    const result = visitManualPage({
        user: JSON.stringify({ userType: 'admin' }),
        allowed_admin_route: manualPath,
    });
    assert.equal(result.redirect, null);
    assert.equal(result.sessionStorage.getItem('allowed_admin_route'), null);
});

test('direct Manual Attendance URL follows the Entry/Exit redirect pattern', () => {
    const adminDirect = visitManualPage({ user: JSON.stringify({ userType: 'admin' }) });
    assert.equal(adminDirect.redirect, '../../portal/portal.html');

    for (const user of [null, JSON.stringify({ userType: 'student' }), '{bad json']) {
        const result = visitManualPage({ user, allowed_admin_route: manualPath });
        assert.equal(result.redirect, '../../auth/login.html');
    }
});
