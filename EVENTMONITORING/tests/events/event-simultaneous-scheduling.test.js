const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const conflicts = require(path.join(root, 'shared/event-schedule-conflicts.js'));
const source = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/events.js'), 'utf8');
const on = (id, location = 'Court', start = '08:00', end = '10:00', date = '2026-11-20') => ({
    event_id: id, event_name: id, event_date: date, end_date: null,
    time_start: start, time_end: end, location, status: 'upcoming',
});

test('different participants can share the same time at different locations', () => {
    const first = on('A', 'Court');
    const second = on('B', 'Laboratory');
    assert.equal(conflicts.overlaps(first, second), true);
    assert.equal(conflicts.locationConflicts(second, [first]).length, 0);
    assert.equal(conflicts.participantConflicts(['D', 'E'], [first], [
        { event_id: 'A', student_id: 'A' }, { event_id: 'A', student_id: 'B' },
    ]).length, 0);
});

test('same location and same time warns both events, even with different casing and spaces', () => {
    const first = on('A', 'Covered Court');
    const second = on('B', ' covered   court ');
    assert.deepEqual([...conflicts.locationConflictIds([first, second])].sort(), ['A', 'B']);
    assert.equal(conflicts.locationConflicts(second, [first]).length, 1);
});

test('partial overlap warns; exact end/start boundary is not an overlap', () => {
    const first = on('A');
    assert.equal(conflicts.locationConflicts(on('B', 'Court', '09:00', '11:00'), [first]).length, 1);
    assert.equal(conflicts.overlaps(first, on('B', 'Court', '10:00', '12:00')), false);
    assert.equal(conflicts.locationConflictIds([first, on('B', 'Court', '10:00', '12:00')]).size, 0);
});

test('one shared participant blocks independently of location, including same-location conflicts', () => {
    const first = on('A');
    for (const candidate of [on('B', 'Laboratory'), on('B', 'Court')]) {
        const matches = conflicts.participantConflicts(['C', 'D'], [first], [
            { event_id: 'A', student_id: 'A' }, { event_id: 'A', student_id: 'C' },
        ]);
        assert.equal(matches.length, 1);
        assert.deepEqual([...matches[0].studentIds], ['C']);
        assert.equal(conflicts.overlappingEvents(candidate, [first]).length, 1);
    }
});

test('cancelled events never warn, and an edit excludes its own event ID', () => {
    const first = on('A');
    assert.equal(conflicts.locationConflicts(first, [first], 'A').length, 0);
    assert.equal(conflicts.locationConflicts(on('B'), [{ ...first, status: 'cancelled' }]).length, 0);
    assert.equal(conflicts.locationConflictIds([first, { ...on('B'), status: 'cancelled' }]).size, 0);
});

test('multi-day and all-day intervals use their full dates, including the last day', () => {
    const multi = { ...on('A', 'Court', '09:00', '17:00', '2026-11-20'), end_date: '2026-11-22' };
    assert.equal(conflicts.overlaps(multi, on('B', 'Court', '08:00', '10:00', '2026-11-22')), true);
    assert.equal(conflicts.overlaps(multi, on('B', 'Court', '17:00', '18:00', '2026-11-22')), false);
    const allDay = on('C', 'Court', null, null, '2026-11-21');
    assert.equal(conflicts.overlaps(multi, allDay), true);
    assert.equal(conflicts.overlaps(allDay, on('D', 'Court', '00:00', '01:00', '2026-11-22')), false);
});

function page({ existing = [], roster = [], selected = ['student-new'], confirm = true, stubValidation = true } = {}) {
    const elements = new Map();
    const calls = [];
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
            value: '', checked: false, innerHTML: '', textContent: '', style: {},
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, force) {
                    if (force === true || (force === undefined && !classes.has(name))) classes.add(name);
                    else classes.delete(name);
                },
                contains(name) { return classes.has(name); },
            },
            scrollIntoView() {}, setAttribute() {}, removeAttribute() {},
            addEventListener(type, handler) { if (id === 'eventForm' && type === 'submit') this.submit = handler; },
            querySelector() { return { disabled: false, innerHTML: '' }; },
            });
        }
        return elements.get(id);
    };
    const client = {
        from(table) {
            return {
                update(value) {
                    calls.push({ kind: 'update', table, value });
                    return { eq: async () => ({ error: null }) };
                },
                delete() {
                    calls.push({ kind: 'delete', table });
                    return { eq: async () => ({ error: null }) };
                },
                insert(value) {
                    calls.push({ kind: 'insert', table, value });
                    if (table === 'events') return { select: async () => ({ data: [{ event_id: 'new-event' }], error: null }) };
                    return Promise.resolve({ error: null });
                },
            };
        },
        rpc: (name) => {
            calls.push({ kind: 'rpc', name });
            if (name === 'preview_event_grade_participants') {
                return {
                    order() { return this; },
                    range: async () => ({ data: selected.map(student_id => ({ student_id })), error: null }),
                };
            }
            return Promise.resolve({ data: 'new-event', error: null });
        },
    };
    const context = vm.createContext({
        document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
        EventScheduleConflicts: conflicts,
        EventTargets: { summary: () => 'Grade 1' },
        supabaseClient: client,
        UIFeedback: {
            confirm: async options => { calls.push({ kind: 'confirm', options }); return confirm; },
            error: async (message, title) => { calls.push({ kind: 'error', message, title }); },
        },
        setInterval() {}, console,
    });
    vm.runInContext(source, context);
    const realFetch = {
        schedules: vm.runInContext('fetchScheduleEvents', context),
        rosters: vm.runInContext('fetchOverlappingRosters', context),
    };
    vm.runInContext(`
        fetchScheduleEvents = async () => ${JSON.stringify(existing)};
        fetchOverlappingRosters = async () => ${JSON.stringify(roster)};
        ${stubValidation ? 'validateLive = () => true;' : ''} clearValidationError = () => {};
        closeModal = () => {}; loadEvents = async () => {}; showToast = () => {};
        getManilaNow = () => new Date('2026-10-19T09:00:00');
        selectedStudentIds = new Set(${JSON.stringify(selected)});
    `, context);
    const values = {
        eventId: '', eventName: 'New Event', eventDate: '2026-11-20',
        eventEndDate: '', eventType: 'assembly', timeStart: '08:00',
        timeEnd: '10:00', location: 'Court', description: '',
        participantMode: 'individual',
    };
    for (const [id, value] of Object.entries(values)) element(id).value = value;
    return { context, element, calls, client, realFetch };
}

test('Create Anyway saves the selected participants and unmodified schedule after a location warning', async () => {
    const { element, calls } = page({ existing: [on('A')], roster: [{ event_id: 'A', student_id: 'other' }] });
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    const warning = calls.find(call => call.kind === 'confirm');
    assert.equal(warning.options.type, 'warning');
    assert.equal(warning.options.confirmText, 'Create Anyway');
    assert.equal(calls.filter(call => call.kind === 'insert' && call.table === 'events').length, 1);
    assert.equal(calls.find(call => call.kind === 'insert' && call.table === 'events').value.time_start, '08:00');
    assert.equal(calls.find(call => call.kind === 'insert' && call.table === 'event_participants').value[0].student_id, 'student-new');
});

test('Review Schedule cancels save; a shared participant blocks before the location warning', async () => {
    const declined = page({ existing: [on('A')], confirm: false });
    await declined.element('eventForm').submit.call(declined.element('eventForm'), { preventDefault() {} });
    assert.equal(declined.calls.filter(call => call.kind === 'insert').length, 0);

    const blocked = page({ existing: [on('A')], roster: [{ event_id: 'A', student_id: 'student-new' }] });
    blocked.element('overlapWarning').classList.add('active');
    await blocked.element('eventForm').submit.call(blocked.element('eventForm'), { preventDefault() {} });
    assert.equal(blocked.calls.some(call => call.kind === 'error' && call.title === 'Participant Schedule Conflict'), true);
    assert.equal(blocked.calls.some(call => call.kind === 'confirm'), false);
    assert.equal(blocked.calls.some(call => call.kind === 'insert'), false);
    assert.equal(blocked.element('overlapWarning').classList.contains('active'), false);
});

test('normalized grade targeting uses the same preview RPC participant UUID set for conflict checking', async () => {
    const { context, element, calls } = page({
        existing: [on('A', 'Laboratory')],
        roster: [{ event_id: 'A', student_id: 'student-new' }],
    });
    element('participantMode').value = 'grade';
    vm.runInContext(`
        applicableSchoolYear = { id: 'year-1' };
        selectedGrades.add('Grade 1');
        gradeSectionTargets.set('Grade 1', null);
    `, context);
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    assert.equal(calls.some(call => call.name === 'preview_event_grade_participants'), true);
    assert.equal(calls.some(call => call.kind === 'error' && call.title === 'Participant Schedule Conflict'), true);
    assert.equal(calls.some(call => call.name === 'save_grade_targeted_event'), false);
});

test('grade preview participant check collects every page beyond the default row limit', async () => {
    const { context, client } = page();
    const requested = [];
    client.rpc = name => {
        assert.equal(name, 'preview_event_grade_participants');
        return {
            order() { return this; },
            async range(from, to) {
                requested.push([from, to]);
                const count = from === 0 ? 500 : 1;
                return { data: Array.from({ length: count }, (_, i) => ({ student_id: 'student-' + (from + i) })), error: null };
            },
        };
    };
    vm.runInContext(`
        applicableSchoolYear = { id: 'year-1' };
        selectedGrades.add('Grade 1');
        gradeSectionTargets.set('Grade 1', null);
    `, context);
    const ids = await vm.runInContext(`resolveSelectedStudentIds('grade', 'new', null)`, context);
    assert.equal(ids.length, 501);
    assert.deepEqual(requested, [[0, 499], [500, 999]]);
});

test('table badge appears for both events and disappears after a location edit or cancellation', () => {
    const { context, element } = page();
    vm.runInContext(`allEvents = [${JSON.stringify(on('A'))}, ${JSON.stringify(on('B'))}]; renderTable(allEvents)`, context);
    assert.equal((element('eventsTableBody').innerHTML.match(/Location Conflict/g) || []).length, 2);
    vm.runInContext(`allEvents[1].location = 'Laboratory'; renderTable(allEvents)`, context);
    assert.equal((element('eventsTableBody').innerHTML.match(/Location Conflict/g) || []).length, 0);
    vm.runInContext(`allEvents[1].location = 'Court'; allEvents[1].status = 'cancelled'; renderTable(allEvents)`, context);
    assert.equal((element('eventsTableBody').innerHTML.match(/Location Conflict/g) || []).length, 0);
});

test('same event name on the same day does not block a different participant group', () => {
    const { context, element } = page({ stubValidation: false });
    vm.runInContext(`allEvents = [${JSON.stringify({ ...on('A', 'Laboratory'), event_name: 'New Event' })}]`, context);
    assert.equal(vm.runInContext('validateLive()', context), true);
    assert.equal(element('liveValidationBox').style.display, 'none');
});

test('edit with unchanged schedule updates itself without a false conflict', async () => {
    const { context, element, calls } = page();
    element('eventId').value = 'A';
    vm.runInContext(`editingTargetKind = 'individual'`, context);
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    assert.equal(calls.filter(call => call.kind === 'update' && call.table === 'events').length, 1);
    assert.equal(calls.some(call => call.kind === 'confirm' || call.kind === 'error'), false);
});

test('Edit Event can Update Anyway at a shared location when its participants differ', async () => {
    const { context, element, calls } = page({
        existing: [on('B')],
        roster: [{ event_id: 'B', student_id: 'other' }],
    });
    element('eventId').value = 'A';
    vm.runInContext(`editingTargetKind = 'individual'`, context);
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    assert.equal(calls.find(call => call.kind === 'confirm').options.confirmText, 'Update Anyway');
    assert.equal(calls.filter(call => call.kind === 'update' && call.table === 'events').length, 1);
});

test('schedule and roster preflight use batched fresh Supabase reads, not one query per event', async () => {
    const { client, realFetch } = page();
    const seen = [];
    client.from = table => {
        seen.push(table);
        const query = {
            select() { return this; }, lte() { return this; }, or() { return this; },
            neq() { return this; }, in() { return this; },
            order() { return this; },
            async range() {
                return {
                    data: table === 'events'
                        ? [on('A'), on('B', 'Laboratory'), { ...on('C'), status: 'cancelled' }]
                        : [{ event_id: 'A', student_id: 'one' }, { event_id: 'B', student_id: 'two' }],
                    error: null,
                };
            },
        };
        return query;
    };
    const current = on('new');
    assert.deepEqual(Array.from(await realFetch.schedules(current), event => event.event_id), ['A', 'B']);
    assert.deepEqual(Array.from(await realFetch.rosters([on('A'), on('B')]), row => row.student_id), ['one', 'two']);
    assert.deepEqual(seen, ['events', 'event_participants']);
});

test('a failed fresh schedule read blocks saving instead of silently allowing it', async () => {
    const { context, element, calls } = page();
    context.console = { error() {} };
    vm.runInContext(`
        fetchScheduleEvents = async () => { throw new Error('schedule unavailable'); };
        showValidationError = message => { globalThis.validationFailure = message; };
    `, context);
    await element('eventForm').submit.call(element('eventForm'), { preventDefault() {} });
    assert.match(context.validationFailure, /Nothing was saved/);
    assert.equal(calls.some(call => call.kind === 'insert'), false);
});
