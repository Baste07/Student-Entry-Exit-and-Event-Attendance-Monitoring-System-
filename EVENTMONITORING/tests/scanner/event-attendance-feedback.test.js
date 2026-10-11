const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring');
const faceSource = fs.readFileSync(path.join(root, 'resc/js/takeAttendance.js'), 'utf8');
const qrSource = fs.readFileSync(path.join(root, 'resc/js/manualAttendance.js'), 'utf8');
const feedback = require(path.join(root, 'resc/js/eventAttendanceFeedback.js'));
const selectionFixtures = require('./event-selection-fixtures.json');

test('both LOCAL_GATE scanner pages load the shared result wording before their page scripts', () => {
    for (const [page, script] of [
        ['takeAttendance.html', 'takeAttendance.js'],
        ['manualAttendance.html', 'manualAttendance.js'],
    ]) {
        const html = fs.readFileSync(path.join(root, 'students', page), 'utf8');
        const feedbackAt = html.indexOf('eventAttendanceFeedback.js');
        const pageScriptAt = html.indexOf(`/${script}?`);
        assert.ok(feedbackAt >= 0 && pageScriptAt > feedbackAt, `${page} must load shared wording first`);
    }
});

function sourceFunction(source, name, isAsync = false) {
    const declaration = source.match(new RegExp(`^${isAsync ? 'async ' : ''}function ${name}\\([^]*?^}`, 'm'));
    assert.ok(declaration, `${name} must be present`);
    return declaration[0];
}

function facePage() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { textContent: '', style: {}, classList: { add() {} } });
        return elements.get(id);
    };
    const toasts = [];
    const context = vm.createContext({
        EventAttendanceFeedback: feedback,
        document: { getElementById: element, activeElement: null },
        greetPerson: element('person'), greetMsg: element('message'), greetCard: element('card'),
        greetAvatar: element('avatar'), greetTitle: element('title'), greetBadge: element('badge'),
        greetDiagnostics: element('diagnostics'), greetScore: element('score'),
        greetThreshold: element('threshold'), greetOverlay: element('overlay'),
        greetClose: { focus() {} },
        clearTimeout() {}, clearInterval() {}, setInterval() { return 1; },
        requestAnimationFrame(callback) { callback(); }, updateGreetingCountdown() {},
        showToast: (...args) => toasts.push(args),
        showMultiFaceModal() {}, dismissMultiFaceModal() {},
        greetTimer: null, greetCountdownInterval: null, lastGreetingEventId: null,
    });
    vm.runInContext(sourceFunction(faceSource, 'showGreeting'), context);
    vm.runInContext(sourceFunction(faceSource, 'handleRecognitionEvent'), context);
    return { event: data => context.handleRecognitionEvent(data), element, toasts };
}

function qrStatus({ status = 'ongoing', attendance = null, attendanceRows = null, registered = true, late = 0, eventRows = null } = {}) {
    const events = eventRows || [{ event_id: 'event', event_name: 'School Program', status,
        event_date: '2026-10-11', time_start: '08:00:00',
        time_end: status === 'completed' ? '08:30:00' : '10:00:00' }];
    const rows = {
        event_participants: registered ? events.map(event => ({ student_id: 'student', event_id: event.event_id })) : [],
        events, event_attendance: attendanceRows || (attendance ? [attendance] : [])
    };
    let writes = 0;
    const client = {
        from(table) {
            const filters = [];
            return {
                select() { return this; },
                eq(column, value) { filters.push([column, value]); return this; },
                in(column, values) { filters.push([column, values]); return this; },
                order() { return this; },
                then(resolve) {
                    resolve({ data: rows[table].filter(row => filters.every(([column, value]) =>
                        Array.isArray(value) ? value.includes(row[column]) : row[column] === value)) });
                },
                insert() { writes++; return Promise.resolve({ error: null }); },
            };
        },
    };
    const context = vm.createContext({
        Date: class FixedDate extends Date {
            constructor(...args) { super(...(args.length ? args : ['2026-10-11T01:00:00Z'])); }
        },
        Intl,
        supabaseClient: client,
        AppSettings: { async load() { return { late_grace_minutes: '15' }; } },
        EventAttendanceFeedback: feedback,
        eventLateMinutes: () => late,
        format12HourTime: value => value,
        EVENT_LATE_GRACE_MINUTES: 15,
    });
    vm.runInContext(sourceFunction(qrSource, 'selectRelevantEvent'), context);
    vm.runInContext(sourceFunction(qrSource, 'getStudentEventStatus', true), context);
    return { status: () => context.getStudentEventStatus({ student_id: 'student' }),
        select: (value, openIds = []) => context.selectRelevantEvent(value, new Date('2026-10-11T01:00:00Z'), openIds),
        writes: () => writes };
}

test('Face and Event QR use the same deterministic Manila schedule selection cases', () => {
    const qr = qrStatus();
    for (const fixture of selectionFixtures) {
        const selected = qr.select(fixture.events, fixture.open_event_ids || []);
        assert.equal(selected.state, fixture.state, fixture.name);
        assert.equal(selected.event?.event_id || null, fixture.event_id, fixture.name);
    }
});

test('Event QR ignores old attendance, selects active or nearest upcoming, and never writes early', async () => {
    const old = { event_id: 'old', event_name: 'Old Exhibit', status: 'completed',
        event_date: '2026-10-01', time_start: '08:00:00', time_end: '10:00:00' };
    const active = { event_id: 'active', event_name: 'Today', status: 'ongoing',
        event_date: '2026-10-11', time_start: '08:00:00', time_end: '10:00:00' };
    const future = { ...active, event_id: 'future', event_name: 'Next Event',
        status: 'upcoming', time_start: '13:00:00', time_end: '15:00:00' };
    const current = qrStatus({ eventRows: [old, active] });
    assert.equal((await current.status()).action, 'IN');
    assert.equal((await current.status()).event_id, 'active');

    const next = qrStatus({ eventRows: [old, future] });
    const upcoming = await next.status();
    assert.equal(upcoming.action, 'EVENT_NOT_STARTED');
    assert.equal(upcoming.event_id, 'future');
    assert.match(qrResultCard(upcoming), /Event Not Started Yet/);
    assert.equal(next.writes(), 0);

    const history = qrStatus({ eventRows: [old] });
    const noEvent = await history.status();
    assert.equal(noEvent.action, 'NO_ACTIVE_EVENT');
    assert.match(qrResultCard(noEvent), /No Active Event/);
    assert.equal(history.writes(), 0);
});

test('Event QR selects pending same-day Time Out before upcoming, then resumes upcoming', async () => {
    const ended = { event_id: 'ended', event_name: 'Morning Event', status: 'completed',
        event_date: '2026-10-11', time_start: '07:00:00', time_end: '08:30:00' };
    const future = { event_id: 'future', event_name: 'Afternoon Event', status: 'upcoming',
        event_date: '2026-10-11', time_start: '13:00:00', time_end: '15:00:00' };
    const row = { attendance_id: 'morning-row', event_id: 'ended', student_id: 'student',
        time_in: '2026-10-10T23:00:00Z', time_out: null };
    const qr = qrStatus({ eventRows: [ended, future], attendanceRows: [row] });
    const pending = await qr.status();
    assert.equal(pending.action, 'OUT');
    assert.equal(pending.event_id, 'ended');
    assert.equal(qr.writes(), 0); // Lookup itself must remain read-only.

    row.time_out = '2026-10-11T01:00:00Z';
    const next = await qr.status();
    assert.equal(next.action, 'EVENT_NOT_STARTED');
    assert.equal(next.event_id, 'future');
    assert.equal(qr.writes(), 0);
});

function qrResultCard(result) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            classList: { remove() {}, add() {} }, style: {}, innerHTML: '', disabled: false,
            scrollIntoView() {},
        });
        return elements.get(id);
    };
    let shown = '';
    const context = vm.createContext({
        EventAttendanceFeedback: feedback,
        ERR_ACTIONS: new Set(['NOT_REGISTERED', 'NO_ACTIVE_EVENT', 'EVENT_NOT_STARTED', 'TIME_OUT_UNAVAILABLE', 'ATTENDANCE_COMPLETE']),
        document: { getElementById: element },
        setAv() {}, setName() {}, setMsg(_cls, _icon, text) { shown = text; },
        msgCls: action => action === 'TIME_OUT_UNAVAILABLE' ? { mc: 'mw', ic: 'fa-hourglass-half' } : { mc: 'mi', ic: 'fa-check' },
        showPanel() {}, actBtn() {}, payload: null,
    });
    vm.runInContext(sourceFunction(qrSource, 'renderResult'), context);
    context.renderResult({ success: true, role: 'student', person: { stud_id: '1-0001' },
        ...result });
    return shown;
}

async function qrConfirm(action, isLate = false) {
    const writes = [];
    const context = vm.createContext({
        EventAttendanceFeedback: feedback,
        supabaseClient: {
            from(table) {
                assert.equal(table, 'event_attendance');
                return {
                    async insert(row) { writes.push(['insert', row]); return { error: null }; },
                    update(row) { return { async eq() { writes.push(['update', row]); return { error: null }; } }; },
                    select() { return { eq() { return { async single() {
                        return { data: { time_in: '2026-10-11T08:00:00Z' } };
                    } }; } }; },
                };
            },
        },
        getManualAttendanceClock: () => ({ nowStore: '2026-10-11T10:00:00Z' }),
        sendManualAttendanceEmail() {},
        Date,
    });
    vm.runInContext(sourceFunction(qrSource, 'confirmStudentEvent', true), context);
    const result = await context.confirmStudentEvent({
        action, event_id: 'event', attendance_id: 'attendance',
        person: { student_id: 'student', first_name: 'Test' },
        _event: { event_id: 'event', event_name: 'School Program' },
        is_late: isLate, late_minutes: isLate ? 20 : 0,
    });
    return { result, writes };
}

async function qrConfirmedCard(action, result) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '1-0001', disabled: false,
            innerHTML: '', style: {} });
        return elements.get(id);
    };
    let cardText = '';
    let toastText = '';
    const context = vm.createContext({
        document: { getElementById: element },
        payload: { role: 'student', action },
        confirmStudentEvent: async () => result,
        showToast: text => { toastText = text; },
        setMsg: (_cls, _icon, text) => { cardText = text; },
        setTimeout() { return 1; },
    });
    vm.runInContext(sourceFunction(qrSource, 'doConfirm', true), context);
    await context.doConfirm();
    return { cardText, toastText };
}

test('Face scanner uses the returned attendance status, not browser time, for Late wording', () => {
    for (const [status, expectedTitle, expectedMessage] of [
        ['on-time', 'Attendance Recorded', 'Time In successfully recorded.'],
        ['late', 'Late Attendance Recorded', 'Time In successfully recorded as Late.'],
    ]) {
        const page = facePage();
        page.event({ type: 'time_in', attendance_status: status, name: 'Test Student',
            stud_id: '1-0001', event_name: 'School Program', message: 'TIME IN Test Student' });
        assert.equal(page.element('title').textContent, expectedTitle);
        assert.equal(page.element('message').textContent, expectedMessage);
        assert.match(page.element('greetMeta').textContent, /1-0001/);
        assert.equal(page.element('card').className, 'greet-card success');
    }
});

test('Face scanner separates blocked early Time Out, completed attendance, nonparticipant, and valid Time Out', () => {
    for (const [type, title, cardClass] of [
        ['time_out_unavailable', 'Cannot Time Out Yet', 'greet-card warning'],
        ['already_recorded', 'Attendance Already Completed', 'greet-card warning'],
        ['not_participant', 'Not Part of Event', 'greet-card error'],
        ['time_out', 'Time Out Recorded', 'greet-card success'],
    ]) {
        const page = facePage();
        page.event({ type, name: 'Test Student', stud_id: '1-0001',
            reason: 'You are not registered for any event.' });
        assert.equal(page.element('title').textContent, title);
        assert.equal(page.element('card').className, cardClass);
        assert.equal(page.element('person').textContent, 'Test Student');
    }
});

test('Event QR status keeps distinct read-only states for early Time Out and completed attendance', async () => {
    const timeIn = { attendance_id: 'attendance', event_id: 'event', student_id: 'student',
        time_in: '2026-10-11T08:00:00Z', time_out: null };
    const early = qrStatus({ attendance: timeIn });
    assert.equal((await early.status()).action, 'TIME_OUT_UNAVAILABLE');
    assert.equal(early.writes(), 0);
    assert.match(qrResultCard(await early.status()), /Cannot Time Out Yet/);

    const completed = qrStatus({ status: 'completed', attendance: { ...timeIn, time_out: '2026-10-11T10:00:00Z' } });
    assert.equal((await completed.status()).action, 'ATTENDANCE_COMPLETE');
    assert.equal(completed.writes(), 0);
    assert.match(qrResultCard(await completed.status()), /Attendance Already Completed/);

    const outsider = qrStatus({ registered: false });
    assert.equal((await outsider.status()).action, 'NOT_REGISTERED');
    assert.equal(outsider.writes(), 0);
    assert.match(qrResultCard(await outsider.status()), /not registered for any event/);
});

test('Event QR keeps On-Time/Late classification and permits Time Out only for completed events', async () => {
    const onTime = qrStatus();
    assert.equal((await onTime.status()).is_late, false);
    const late = qrStatus({ late: 20 });
    assert.equal((await late.status()).is_late, true);
    const completed = qrStatus({ status: 'completed', attendance: {
        attendance_id: 'attendance', event_id: 'event', student_id: 'student',
        time_in: '2026-10-11T08:00:00Z', time_out: null,
    } });
    assert.equal((await completed.status()).action, 'OUT');
    assert.equal(completed.writes(), 0); // Lookup alone never records attendance.
    assert.deepEqual(feedback.forOutcome('IN', 'late'), feedback.forOutcome('time_in', 'late'));
    assert.deepEqual(feedback.forOutcome('OUT'), feedback.forOutcome('time_out'));
    assert.deepEqual(feedback.forOutcome('TIME_OUT_UNAVAILABLE'), feedback.forOutcome('time_out_unavailable'));
});

test('Event QR inserts On-Time and Late Time In, then shows the same successful wording as Face', async () => {
    for (const [late, expectedRemarks, expectedTitle] of [
        [false, 'On time', 'Attendance Recorded'],
        [true, 'Late by 20 min', 'Late Attendance Recorded'],
    ]) {
        const { result, writes } = await qrConfirm('IN', late);
        assert.equal(writes.length, 1);
        assert.equal(writes[0][0], 'insert');
        assert.equal(writes[0][1].remarks, expectedRemarks);
        assert.equal(result.title, expectedTitle);
        const display = await qrConfirmedCard('IN', result);
        assert.match(display.cardText, new RegExp(expectedTitle));
        assert.match(display.toastText, new RegExp(expectedTitle));
        assert.equal(result.message, feedback.forOutcome('time_in', late ? 'late' : 'on-time').message);
    }
});

test('Event QR never writes for early Time Out, but records and displays valid Time Out', async () => {
    const early = await qrConfirm('TIME_OUT_UNAVAILABLE');
    assert.equal(early.writes.length, 0);
    assert.match(qrResultCard({ action: 'TIME_OUT_UNAVAILABLE', message: 'blocked' }), /Cannot Time Out Yet/);

    const valid = await qrConfirm('OUT');
    assert.equal(valid.writes.length, 1);
    assert.equal(valid.writes[0][0], 'update');
    assert.equal(valid.writes[0][1].time_out, '2026-10-11T10:00:00Z');
    const display = await qrConfirmedCard('OUT', valid.result);
    assert.match(display.cardText, /Time Out Recorded.*Time Out successfully recorded/);
    assert.match(display.toastText, /Time Out Recorded/);
});
