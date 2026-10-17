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
        event_participants: registered ? events.flatMap(event => ['student', 'student-b'].map(student_id =>
            ({ student_id, event_id: event.event_id }))) : [],
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
        AppSettings: { async load() { return { late_grace_minutes: '15', attendance_cooldown_seconds: '5' }; },
            validEventAttendanceCooldownSeconds: value => /^[1-9]$/.test(String(value)) },
        EventAttendanceFeedback: feedback,
        eventLateMinutes: () => late,
        format12HourTime: value => value,
        EVENT_LATE_GRACE_MINUTES: 15,
    });
    vm.runInContext('const recentEventAttendance = new Map();', context);
    vm.runInContext(sourceFunction(qrSource, 'selectRelevantEvent'), context);
    for (const name of ['eventCooldownSeconds', 'eventCooldownRemaining', 'eventCooldownResult', 'markEventAttendanceSuccess']) {
        vm.runInContext(sourceFunction(qrSource, name), context);
    }
    vm.runInContext(sourceFunction(qrSource, 'getStudentEventStatus', true), context);
    return { status: (studentId = 'student') => context.getStudentEventStatus({ student_id: studentId }),
        select: (value, openIds = []) => context.selectRelevantEvent(value, new Date('2026-10-11T01:00:00Z'), openIds),
        remaining: (row, eventId, studentId, seconds, now) =>
            context.eventCooldownRemaining(row, eventId, studentId, seconds, now),
        mark: (eventId, studentId) => context.markEventAttendanceSuccess(eventId, studentId),
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
        UIFeedback: { toast() {} },
    });
    vm.runInContext(sourceFunction(qrSource, 'renderResult'), context);
    context.renderResult({ success: true, role: 'student', person: { stud_id: '1-0001' },
        ...result });
    return shown;
}

async function qrConfirm(action, isLate = false, options = {}) {
    const writes = [];
    const emails = [];
    let failWrite = Boolean(options.failWrite);
    const cooldownSeconds = options.cooldownSeconds || 20;
    const context = vm.createContext({
        EventAttendanceFeedback: feedback,
        AppSettings: { async load() { return { attendance_cooldown_seconds: String(cooldownSeconds) }; },
            validEventAttendanceCooldownSeconds: value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 300 },
        supabaseClient: {
            from(table) {
                assert.equal(table, 'event_attendance');
                return {
                    async insert(row) { if (failWrite) return { error: { message: 'write failed' } };
                        writes.push(['insert', row]); return { error: null }; },
                    update(row) { return { async eq() { if (failWrite) return { error: { message: 'write failed' } };
                        writes.push(['update', row]); return { error: null }; } }; },
                    select() { return { eq() { return { async single() {
                        return { data: { time_in: '2026-10-11T08:00:00Z' } };
                    } }; } }; },
                };
            },
        },
        getManualAttendanceClock: () => ({ nowStore: '2026-10-11T10:00:00Z' }),
        sendManualAttendanceEmail: action => emails.push(action),
        Date,
    });
    vm.runInContext('const recentEventAttendance = new Map();', context);
    for (const name of ['eventCooldownSeconds', 'eventCooldownRemaining', 'markEventAttendanceSuccess']) {
        vm.runInContext(sourceFunction(qrSource, name), context);
    }
    vm.runInContext(sourceFunction(qrSource, 'confirmStudentEvent', true), context);
    const payload = {
        action, event_id: 'event', attendance_id: 'attendance',
        person: { student_id: 'student', first_name: 'Test' },
        _event: { event_id: 'event', event_name: 'School Program' },
        is_late: isLate, late_minutes: isLate ? 20 : 0,
    };
    const result = await context.confirmStudentEvent(payload);
    return { result, writes, emails, repeat: () => context.confirmStudentEvent(payload),
        setFail: value => { failWrite = value; } };
}

test('Event QR and Manual status suppress a fresh successful row, per person and event', async () => {
    const row = { attendance_id: 'attendance', event_id: 'event', student_id: 'student',
        time_in: '2026-10-11T01:00:00Z', time_out: null };
    const qr = qrStatus({ attendance: row });
    assert.equal((await qr.status()).action, 'COOLDOWN_ACTIVE');
    assert.equal((await qr.status('student-b')).action, 'IN');
    assert.equal(qr.writes(), 0);
    qr.mark('event', 'student');
    assert.ok(qr.remaining(null, 'event', 'student', 5, new Date()) > 0);
    assert.equal(qr.remaining(null, 'other-event', 'student', 5, new Date()), 0);
    assert.equal(qr.remaining(null, 'event', 'student-b', 5, new Date()), 0);
    assert.equal(qr.remaining(row, 'event', 'student', 5, new Date('2026-10-11T01:00:05Z')), 0);
    assert.match(feedback.forOutcome('COOLDOWN_ACTIVE').title, /Cooldown/);
});

test('Event QR and Manual writes start cooldown only after successful Time In or Time Out', async () => {
    for (const action of ['IN', 'OUT']) {
        const flow = await qrConfirm(action);
        assert.equal(flow.result.success, true);
        const repeat = await flow.repeat();
        assert.equal(repeat.success, false);
        assert.match(repeat.title, /Cooldown/);
        assert.equal(flow.writes.length, 1);
        assert.deepEqual(flow.emails, [action]);
    }
    const failed = await qrConfirm('IN', false, { failWrite: true });
    assert.equal(failed.result.success, false);
    assert.equal(failed.writes.length, 0);
    assert.deepEqual(failed.emails, []);
    failed.setFail(false);
    const retry = await failed.repeat();
    assert.equal(retry.success, true);
    assert.equal(failed.writes.length, 1);
    assert.deepEqual(failed.emails, ['IN']);
});

test('Event QR cooldown gives one notice, suppresses repeat beeps, and releases camera for another student', async () => {
    const qrId = 'student_uuid:00000000-0000-4000-8000-000000000001';
    const input = { value: qrId };
    const panel = { classList: { remove() {} }, style: {} };
    const timers = [];
    const rendered = [];
    let beeps = 0;
    let resets = 0;
    let lookups = 0;
    const context = vm.createContext({
        document: {
            getElementById: id => id === 'id_input' ? input : panel,
            querySelector: () => ({ checked: true }),
        },
        supabaseClient: { from: () => ({ select() { return this; }, eq() { return this; },
            async maybeSingle() { return { data: { student_id: 'student', stud_id: '1-0001' } }; } }) },
        getSelectedRole: () => 'student',
        getStudentEventStatus: async () => ({ action: 'COOLDOWN_ACTIVE', event_id: 'event' }),
        renderResult: result => rendered.push(result.action),
        resetFormForNextStudent: () => { resets++; input.value = ''; },
        setTimeout: callback => { timers.push(callback); return timers.length; },
        extractIdFromQr: value => value,
        setQrDebug() {}, isValidDetectedId: () => true,
        playScanBeep: () => { beeps++; }, showToast() {},
        lookupById: async () => { lookups++; return { action: 'COOLDOWN_ACTIVE' }; },
        lastDecodedId: '', lastDecodedAt: 0, QR_DUPLICATE_COOLDOWN_MS: 50,
        Date,
    });
    vm.runInContext('let payload = null; let lastCooldownFeedbackKey = "";', context);
    vm.runInContext(sourceFunction(qrSource, 'lookupById', true), context);
    const first = await context.lookupById(qrId, true, true);
    assert.equal(first.action, 'COOLDOWN_ACTIVE');
    assert.deepEqual(rendered, ['COOLDOWN_ACTIVE']);
    assert.equal(timers.length, 1);
    timers.shift()();
    assert.equal(resets, 1);
    input.value = qrId;
    await context.lookupById(qrId, true, true);
    assert.deepEqual(rendered, ['COOLDOWN_ACTIVE']);
    timers.shift()();
    assert.equal(resets, 2);

    context.lookupById = async () => { lookups++; return { action: 'COOLDOWN_ACTIVE' }; };
    vm.runInContext(sourceFunction(qrSource, 'processQrResult', true), context);
    await context.processQrResult(qrId);
    assert.equal(lookups, 1);
    assert.equal(beeps, 0);
});

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
