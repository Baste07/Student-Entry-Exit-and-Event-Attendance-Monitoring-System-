const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = require('../../admin/spoof-attempts.js');

const at = (id, time, extra = {}) => ({
    spoof_log_id: id,
    student_id: id === 3 ? null : `student-${id}`,
    employee_id: id === 3 ? 'employee-3' : null,
    detected_name: `Captured ${id}`,
    source_module: 'daily_attendance',
    reason: 'Liveness check failed',
    detected_at: time,
    liveness_score: 0.2,
    is_spoof: true,
    ...extra
});

function fakeDocument() {
    const elements = new Map();
    const getElementById = id => {
        if (!elements.has(id)) elements.set(id, {
            textContent: '', innerHTML: '', disabled: false, listeners: {},
            addEventListener(type, handler) { this.listeners[type] = handler; },
            fire(type, value) { return this.listeners[type]({ target: { value } }); }
        });
        return elements.get(id);
    };
    return { getElementById };
}

function fakeClient(rows, { failure = null, profilesFail = false } = {}) {
    const calls = [];
    const client = {
        calls,
        from(table) {
            calls.push(table);
            return {
                select() {
                    return {
                        order() { return this; },
                        range(start, end) {
                            return Promise.resolve(failure
                                ? { data: null, error: { code: failure } }
                                : { data: rows.slice(start, end + 1), error: null });
                        },
                        in(column, ids) {
                            if (profilesFail) return Promise.resolve({ data: null, error: { code: '42501' } });
                            const data = table === 'students'
                                ? ids.filter(id => id === 'student-1').map(student_id => ({ student_id, stud_id: '1-0001', first_name: 'Student', last_name: 'One' }))
                                : ids.filter(id => id === 'employee-3').map(employee_id => ({ employee_id, emp_no: 'EMP-3', first_name: 'Employee', last_name: 'Three' }));
                            assert.equal(column, table === 'students' ? 'student_id' : 'employee_id');
                            return Promise.resolve({ data, error: null });
                        }
                    };
                }
            };
        }
    };
    return client;
}

test('Manila dates, including a UTC date rollover, drive display and Today counts', () => {
    assert.equal(page.dateValue('2026-10-13T17:00:00Z').stamp, '2026-10-14');
    assert.match(page.dateValue('2026-10-13T17:00:00Z').time, /01:00:00\s*AM/i);
    assert.deepEqual(page.summary([at(1, '2026-10-13T17:00:00Z')], new Date('2026-10-14T01:00:00Z')),
        { total: 1, today: 1, attendance: 1 });
});

test('populated rows resolve student and employee identities without dropping unresolved records', async () => {
    const rows = [
        at(1, '2026-10-13T17:00:00Z'),
        at(2, '2026-10-12T03:00:00Z', { student_id: 'missing-student', source_module: 'entry_exit' }),
        at(3, '2026-10-11T03:00:00Z')
    ];
    const resolved = await page.resolveProfiles(fakeClient(rows), rows, console);
    assert.equal(resolved.length, 3);
    assert.equal(resolved[0].display_name, 'Student One');
    assert.equal(resolved[0].display_id, '1-0001');
    assert.equal(resolved[1].display_name, 'Captured 2');
    assert.equal(resolved[1].display_id, 'Unavailable');
    assert.equal(resolved[2].display_name, 'Employee Three');
    assert.equal(resolved[2].display_id, 'EMP-3');
    assert.match(page.renderRow(resolved[0]), /Daily Attendance/);
    assert.match(page.renderRow(resolved[1]), /Entry \/ Exit/);
});

test('source, search and Manila-date filters preserve matching rows', () => {
    const rows = [
        at(1, '2026-10-13T17:00:00Z', { display_name: 'Student One', display_id: '1-0001' }),
        at(2, '2026-10-13T14:00:00Z', { source_module: 'entry_exit', display_name: 'Other', display_id: '2-0001' })
    ];
    assert.equal(page.filterRows(rows, { date: '2026-10-14' }).length, 1);
    assert.equal(page.filterRows(rows, { source: 'entry_exit' }).length, 1);
    assert.equal(page.filterRows(rows, { search: '1-0001' }).length, 1);
    assert.equal(page.filterRows(rows, { search: 'does not exist' }).length, 0);
    assert.equal(page.filterRows(rows).length, 2);
    assert.equal(page.summary(rows, new Date('2026-10-14T01:00:00Z')).attendance, 2);
});

test('query failure is visibly different from zero records, and refresh recovers', async () => {
    const doc = fakeDocument();
    const client = fakeClient([], { failure: '42501' });
    const notices = [];
    const controller = page.createController({ client, doc, logger: { error() {}, warn() {} }, feedback: { toast: value => notices.push(value) } });
    controller.bind();
    await controller.load();
    assert.match(doc.getElementById('spoofTableBody').innerHTML, /Unable to load security records/);
    assert.notEqual(doc.getElementById('totalSpoofCount').textContent, 0);
    assert.equal(notices.length, 1);
    client.from = fakeClient([at(1, '2026-10-13T17:00:00Z')]).from;
    await doc.getElementById('refreshSpoofBtn').fire('click');
    assert.equal(doc.getElementById('totalSpoofCount').textContent, 1);
    assert.match(doc.getElementById('spoofTableBody').innerHTML, /Student One/);
});

test('profile lookup failure preserves security rows and captured name', async () => {
    const rows = [at(1, '2026-10-13T17:00:00Z')];
    const resolved = await page.resolveProfiles(fakeClient(rows, { profilesFail: true }), rows, { warn() {} });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].display_name, 'Captured 1');
});

test('fetches all spoof records beyond the first page', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => at(index + 1, '2026-10-13T17:00:00Z'));
    const client = fakeClient(rows);
    assert.equal((await page.fetchAll(client)).length, 501);
    assert.equal(client.calls.filter(table => table === 'spoof_attempts').length, 2);
});

test('a Production-sized set renders all records and refresh keeps active filters', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => at(index + 1, '2026-10-13T17:00:00Z'));
    const doc = fakeDocument();
    const controller = page.createController({ client: fakeClient(rows), doc, logger: { warn() {}, error() {} } });
    controller.bind();
    await controller.load();
    assert.equal(doc.getElementById('totalSpoofCount').textContent, 101);
    assert.equal((doc.getElementById('spoofTableBody').innerHTML.match(/<tr>/g) || []).length, 101);
    doc.getElementById('spoofSourceFilter').fire('change', 'entry_exit');
    assert.match(doc.getElementById('spoofTableBody').innerHTML, /No spoofing attempts found/);
    await doc.getElementById('refreshSpoofBtn').fire('click');
    assert.equal(doc.getElementById('totalSpoofCount').textContent, 101);
    assert.match(doc.getElementById('spoofTableBody').innerHTML, /No spoofing attempts found/);
    doc.getElementById('spoofSourceFilter').fire('change', 'all');
    assert.equal((doc.getElementById('spoofTableBody').innerHTML.match(/<tr>/g) || []).length, 101);
});

test('the page does not query before route and Super Admin authorization', async () => {
    const client = fakeClient([]);
    const options = { client, doc: fakeDocument(), feedback: {}, loadHeader() {}, loadSidebar() {} };
    assert.equal(await page.start({ ...options, routeReady: Promise.resolve(false), authorize: () => true }), null);
    assert.equal(await page.start({ ...options, routeReady: Promise.resolve(true), authorize: () => false }), null);
    assert.equal(client.calls.length, 0);
});

test('migration grants only authenticated, active AAL2 Super Admin SELECT access', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/20261014_spoof_attempts_super_admin_read.sql'), 'utf8');
    const helperSql = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/20261005_admin_login_lockout.sql'), 'utf8');
    assert.match(sql, /as permissive\s+for select to authenticated/i);
    assert.match(sql, /using\s*\(\(select app_private\.is_active_super_admin\(\)\)\)/i);
    assert.doesNotMatch(sql, /(?:grant\s+.*\s+to\s+anon|for\s+insert|for\s+update|for\s+delete|disable\s+row\s+level\s+security)/i);
    assert.match(helperSql, /create or replace function app_private\.is_active_super_admin\(\)[\s\S]*?auth\.jwt\(\)->>'aal'\) = 'aal2'[\s\S]*?admin_level = 'super_admin' and status = 'active' and not login_locked/i);
});
