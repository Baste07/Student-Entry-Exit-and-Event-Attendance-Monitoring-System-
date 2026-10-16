const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleRoot = path.resolve(__dirname, '../../TimeInAndTimeOutMonitoring');
const read = name => fs.readFileSync(path.join(moduleRoot, 'resc/js', name), 'utf8');
const eventsSource = read('events.js');
const faceSource = read('takeAttendance.js');
const manualSource = read('manualAttendance.js');
const laboratorySource = read('laboratorySessions.js');
const entryFaceSource = fs.readFileSync(path.resolve(__dirname,
    '../../EntryExitMonitoring/resc/js/entryExitScanner.js'), 'utf8');
const entryFaceHtml = fs.readFileSync(path.resolve(__dirname,
    '../../EntryExitMonitoring/gate/entryExitScanner.html'), 'utf8');

function sourceFunction(source, name, isAsync = false) {
    const declaration = source.match(new RegExp(`^${isAsync ? 'async ' : ''}function ${name}\\([^]*?^}`, 'm'));
    assert.ok(declaration, `${name} must exist`);
    return declaration[0];
}

test('scheduled Event end changes only event status, without page or scanner teardown', async () => {
    const writes = [];
    const lifecycle = [];
    const location = { href: '/events.html', assign: () => lifecycle.push('navigate') };
    const context = vm.createContext({
        window: { location }, console,
        getManilaNow: () => new Date('2026-10-15T10:00:00'),
        allEvents: [{ event_id: 'event-a', event_date: '2026-10-15',
            end_date: '2026-10-15', time_start: '08:00:00',
            time_end: '09:59:00', status: 'ongoing' }],
        supabaseClient: { from(table) {
            assert.equal(table, 'events');
            return { update(values) {
                return { async eq(column, id) {
                    writes.push({ values, column, id });
                    return { error: null };
                } };
            } };
        } },
        updateBadges: () => {}, renderTable: () => {},
        stopScanner: () => lifecycle.push('stop scanner'),
        stopAttendanceSession: () => lifecycle.push('stop face'),
        stopEngine: () => lifecycle.push('stop engine'),
    });
    vm.runInContext(sourceFunction(eventsSource, 'computeEventStatus'), context);
    vm.runInContext(sourceFunction(eventsSource, 'updateEventStatusesLocal', true), context);
    await context.updateEventStatusesLocal();
    assert.equal(vm.runInContext('allEvents[0].status', context), 'completed');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].values.status, 'completed');
    assert.equal(writes[0].column, 'event_id');
    assert.equal(writes[0].id, 'event-a');
    assert.deepEqual(lifecycle, []);
    assert.equal(location.href, '/events.html');
});

test('scheduled laboratory auto-end changes session state without scanner teardown', async () => {
    const updates = [];
    const lifecycle = [];
    const client = { from(table) {
        const query = {
            select() { return this; }, in() { return this; }, eq() { return this; },
            not() { return this; }, is() { return this; },
            update(values) { updates.push({ table, values }); return this; },
            then(resolve) {
                const data = table === 'lab_sessions' ? [{ session_id: 'lab-a',
                    status: 'ongoing', lab_schedules: { start_time: '08:00:00', end_time: '09:00:00' } }] : [];
                resolve({ data, error: null });
            }
        };
        return query;
    } };
    const location = { href: '/laboratorySessions.html' };
    const context = vm.createContext({
        supabaseClient: client, today: '2026-10-15', currentDay: 'Thursday',
        getCurrentTime: () => '10:00:00', PROFESSOR_START_WINDOW: 45,
        stopScanner: () => lifecycle.push('stop scanner'),
        stopEngine: () => lifecycle.push('stop engine'),
        window: { location }
    });
    vm.runInContext(sourceFunction(laboratorySource, 'autoEndSessions', true), context);
    assert.equal(await context.autoEndSessions(), 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, 'lab_sessions');
    assert.equal(updates[0].values.status, 'completed');
    assert.deepEqual(lifecycle, []);
    assert.equal(location.href, '/laboratorySessions.html');
});

test('Event Face ongoing-event poll leaves the live session open when its event ends', async () => {
    const lifecycle = [];
    const stream = { src: 'http://127.0.0.1:5000/video_feed' };
    const context = vm.createContext({
        isEngineOnline: true, ongoingEvents: [{ event_id: 'event-a' }],
        fetch: async () => ({ json: async () => ({ success: true, events: [] }) }),
        stopAttendanceSession: () => lifecycle.push('stop face'),
        stopEngine: () => lifecycle.push('stop engine'),
        videoStream: stream,
        window: { location: { href: '/takeAttendance.html' } }
    });
    vm.runInContext(sourceFunction(faceSource, 'fetchOngoingEvents', true), context);
    await context.fetchOngoingEvents();
    assert.equal(vm.runInContext('ongoingEvents.length', context), 0);
    assert.equal(stream.src, 'http://127.0.0.1:5000/video_feed');
    assert.deepEqual(lifecycle, []);
    assert.equal(context.window.location.href, '/takeAttendance.html');
});

test('Manual Attendance keeps its page open when the selected Event has completed', () => {
    const location = { href: '/manualAttendance.html', assign() { throw new Error('unexpected redirect'); } };
    const context = vm.createContext({ Intl, Date, window: { location } });
    vm.runInContext(sourceFunction(manualSource, 'selectRelevantEvent'), context);
    const ended = { event_id: 'event-a', event_date: '2026-10-15',
        time_start: '08:00:00', time_end: '09:00:00', status: 'completed' };
    const result = context.selectRelevantEvent([ended], new Date('2026-10-15T02:00:00Z'));
    assert.equal(result.state, 'completed');
    assert.equal(result.event.event_id, 'event-a');
    assert.equal(location.href, '/manualAttendance.html');
    assert.doesNotMatch(manualSource, /(?:location\.(?:href|assign|replace)|window\.close|logout)\s*(?:=|\()/);
});

test('scanner teardown remains tied to explicit controls, engine loss, or camera lifecycle', () => {
    const eventFacePoll = sourceFunction(faceSource, 'fetchOngoingEvents', true);
    const eventQrSelection = sourceFunction(manualSource, 'selectRelevantEvent');
    assert.doesNotMatch(eventFacePoll, /stopAttendanceSession|stopEngine|shutdown|location/);
    assert.doesNotMatch(eventQrSelection, /stopScanner|shutdown|location/);
    assert.match(faceSource, /stopBtn\.addEventListener\('click'[\s\S]*?stopAttendanceSession\(\)/);
    assert.match(faceSource, /stopEngineBtn\.addEventListener\('click'|async function stopEngine\(/);
    assert.match(manualSource, /function toggleQRScanner\(\)[\s\S]*?stopScanner\(\)/);
    assert.match(manualSource, /track\.addEventListener\('ended'[\s\S]*?stopScanner\(\)/);
    assert.doesNotMatch(entryFaceSource, /ongoing_events|computeEventStatus|updateEventStatusesLocal|\.from\(['"]events['"]\)/);
    assert.match(entryFaceHtml, /id="btnStop"\s+onclick="stopScanner\(\)"/);
    assert.match(entryFaceHtml, /id="btnStopEngine"\s+onclick="stopEngine\(\)"/);
});
