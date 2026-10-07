'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    normalizeAnalytics, summarizeAnalytics, performanceAnalytics, performanceExplanation,
    trendNarrative, trendPoints, lateInfo, percentage, percentLabel
} = require('../../TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js');

const events = [
    { event_id: 'first', event_name: 'Science Fair', event_date: '2026-09-04', time_start: '08:00:00', status: 'completed' },
    { event_id: 'second', event_name: 'Sports Day', event_date: '2026-09-18', time_start: '08:00:00', status: 'completed' },
    { event_id: 'third', event_name: 'School Assembly', event_date: '2026-09-25', time_start: '08:00:00', status: 'ongoing' }
];
function participant(eventId, studentId, grade = 'Grade 7', sectionId = 'seven-a') {
    return {
        event_id: eventId, student_id: studentId,
        students: {
            student_id: studentId, stud_id: studentId, first_name: studentId,
            section_id: sectionId, current_grade_level: grade,
            sections: { section_id: sectionId, grade_level: grade, section_name: sectionId }
        }
    };
}
function checkIn(eventId, studentId, timeIn, timeOut = null) {
    return { event_id: eventId, student_id: studentId, time_in: timeIn, time_out: timeOut };
}

test('completed events with no check-ins retain their expected count and no-shows', () => {
    const roster = [participant('first', 'A'), participant('first', 'B')];
    const view = summarizeAnalytics(events.slice(0, 1), normalizeAnalytics(events.slice(0, 1), roster, []));
    assert.equal(view.totals.expected, 2);
    assert.equal(view.totals.attended, 0);
    assert.equal(view.totals.noShows, 2);
    assert.equal(view.totals.attendanceRate, 0);
    assert.equal(view.totals.completionRate, 0);
    assert.equal(view.totals.averageLateMinutes, null);
    assert.equal(view.details.noShow.length, 2);
});

test('duplicate roster and attendance rows count once per student and event', () => {
    const roster = [participant('first', 'A'), participant('first', 'A'), participant('second', 'A'), participant('first', 'B')];
    const scans = [
        checkIn('first', 'A', '2026-09-04T00:20:00Z'),
        checkIn('first', 'A', '2026-09-04T00:10:00Z', '2026-09-04T02:00:00Z'),
        checkIn('second', 'A', '2026-09-18T00:00:00Z'),
        checkIn('first', 'outside-roster', '2026-09-04T00:00:00Z'),
        { event_id: 'first', student_id: null, employee_id: 'teacher', time_in: '2026-09-04T00:00:00Z' }
    ];
    const normalized = normalizeAnalytics(events.slice(0, 2), roster, scans);
    const view = summarizeAnalytics(events.slice(0, 2), normalized);
    assert.equal(normalized.duplicateParticipants, 1);
    assert.equal(normalized.duplicateAttendance, 1);
    assert.equal(normalized.outsideRoster, 1);
    assert.equal(view.totals.expected, 3);
    assert.equal(view.totals.attended, 2);
    assert.equal(view.totals.onTime, 2);
    assert.equal(view.totals.noShows, 1);
    assert.equal(view.totals.timedOut, 1);
    assert.equal(view.totals.missingTimeOut, 1);
    assert.equal(view.details.missing.length, 1);
    assert.ok(Math.abs(view.totals.attendanceRate - 200 / 3) < 1e-10);
});

test('advanced display ID keeps event attendance linked by UUID and original section', () => {
    const row = participant('first', 'permanent-uuid', 'Grade 1', 'persistent-section-a');
    row.students.stud_id = '2-0001';
    row.students.current_grade_level = 'Grade 2';
    const scans = [checkIn('first', 'permanent-uuid', '2026-09-04T00:00:00Z')];
    const normalized = normalizeAnalytics(events.slice(0, 1), [row], scans);
    const view = summarizeAnalytics(events.slice(0, 1), normalized);
    assert.equal(view.totals.expected, 1);
    assert.equal(view.totals.attended, 1);
    assert.equal(normalized.records[0].student.stud_id, '2-0001');
    assert.equal(normalized.records[0].student.section_id, 'persistent-section-a');
    assert.equal(normalized.records[0].section.grade, 'Grade 2');
    assert.equal(normalizeAnalytics(events.slice(0, 1), [row], scans, { grade: 'Grade 2' }).records.length, 1);
    assert.equal(normalizeAnalytics(events.slice(0, 1), [row], scans, { grade: 'Grade 1' }).records.length, 0);
});

test('the existing 15-minute grace period separates on-time and late scans', () => {
    assert.equal(lateInfo({ timeIn: '2026-09-04T00:15:00Z' }, events[0]).late, false);
    const afterGrace = lateInfo({ timeIn: '2026-09-04T00:16:00Z' }, events[0]);
    assert.equal(afterGrace.late, true);
    assert.equal(afterGrace.minutes, 16);
    const roster = [participant('first', 'A'), participant('first', 'B')];
    const scans = [checkIn('first', 'A', '2026-09-04T00:15:00Z'), checkIn('first', 'B', '2026-09-04T00:16:00Z')];
    const view = summarizeAnalytics(events.slice(0, 1), normalizeAnalytics(events.slice(0, 1), roster, scans));
    assert.equal(view.totals.onTime, 1);
    assert.equal(view.totals.late, 1);
    assert.equal(view.totals.averageLateMinutes, 16);
    assert.equal(view.totals.lateRate, 50);
});

test('ongoing participants remain pending and missing time-out is not a no-show', () => {
    const roster = [participant('third', 'A'), participant('third', 'B')];
    const scans = [checkIn('third', 'A', '2026-09-25T00:02:00Z')];
    const view = summarizeAnalytics(events.slice(2), normalizeAnalytics(events.slice(2), roster, scans));
    assert.equal(view.totals.expected, 2);
    assert.equal(view.totals.attended, 1);
    assert.equal(view.totals.pending, 1);
    assert.equal(view.totals.noShows, 0);
    assert.equal(view.totals.missingTimeOut, 1);
    assert.equal(view.details.missing.length, 0);
    assert.equal(view.details.noShow.length, 0);
});

test('grade and section filters apply to roster, metrics, and details', () => {
    const roster = [participant('first', 'A'), participant('first', 'B', 'Grade 8', 'eight-a')];
    const scans = [checkIn('first', 'A', '2026-09-04T00:00:00Z')];
    const normalized = normalizeAnalytics(events.slice(0, 1), roster, scans, { grade: 'Grade 8', section: 'eight-a' });
    const view = summarizeAnalytics(events.slice(0, 1), normalized);
    assert.equal(view.totals.expected, 1);
    assert.equal(view.totals.attended, 0);
    assert.equal(view.details.noShow[0].student.student_id, 'B');
    assert.equal(view.sectionRows[0].label, 'Grade 8 · eight-a');
});

test('trend grouping stays chronological and uses a weighted attendance rate', () => {
    const rows = [
        { event: events[0], expected: 1, attended: 1 },
        { event: { ...events[0], event_id: 'another' }, expected: 3, attended: 0 },
        { event: events[1], expected: 2, attended: 1 }
    ];
    const daily = trendPoints(rows, 'daily');
    assert.deepEqual(daily.map(point => point.label), ['2026-09-04', '2026-09-18']);
    assert.equal(daily[0].rate, 25);
    assert.equal(daily[1].rate, 50);
    assert.equal(percentage(0, 0), 0);
});

test('all KPIs agree for ten assigned students with mixed attendance', () => {
    const roster = Array.from({ length: 10 }, (_, index) => participant('first', `student-${index}`));
    const scans = Array.from({ length: 8 }, (_, index) => checkIn(
        'first', `student-${index}`,
        index < 6 ? '2026-09-04T00:10:00Z' : '2026-09-04T00:20:00Z',
        index < 7 ? '2026-09-04T02:00:00Z' : null
    ));
    const view = summarizeAnalytics(events.slice(0, 1), normalizeAnalytics(events.slice(0, 1), roster, scans));
    assert.deepEqual({
        expected: view.totals.expected, attended: view.totals.attended,
        onTime: view.totals.onTime, late: view.totals.late,
        noShows: view.totals.noShows, timedOut: view.totals.timedOut,
        missingTimeOut: view.totals.missingTimeOut
    }, { expected: 10, attended: 8, onTime: 6, late: 2, noShows: 2, timedOut: 7, missingTimeOut: 1 });
    assert.equal(view.totals.attendanceRate, 80);
    assert.equal(view.totals.noShowRate, 20);
    assert.equal(view.totals.onTimeRate, 75);
    assert.equal(view.totals.lateRate, 25);
    assert.equal(view.totals.completionRate, 87.5);
    assert.equal(view.totals.averageLateMinutes, 20);
});

test('a time-out without a valid time-in does not imply attendance', () => {
    const roster = [participant('first', 'A')];
    const scans = [checkIn('first', 'A', null, '2026-09-04T02:00:00Z')];
    const view = summarizeAnalytics(events.slice(0, 1), normalizeAnalytics(events.slice(0, 1), roster, scans));
    assert.equal(view.totals.attended, 0);
    assert.equal(view.totals.noShows, 1);
    assert.equal(view.totals.timedOut, 0);
});

test('100 expected and 92 unique attendees agree across overview rate, chart input, and explanation', () => {
    const event = events[0];
    const roster = Array.from({ length: 100 }, (_, index) => participant(event.event_id, `student-${index}`));
    const scans = Array.from({ length: 92 }, (_, index) => checkIn(event.event_id, `student-${index}`, '2026-09-04T00:05:00Z'));
    scans.push(checkIn(event.event_id, 'student-0', '2026-09-04T00:07:00Z'));
    const report = performanceAnalytics([event], normalizeAnalytics([event], roster, scans), scans, {}, '2026-10-08');
    assert.deepEqual({ expected: report.totals.expected, attended: report.totals.attended, rate: report.totals.rate },
        { expected: 100, attended: 92, rate: 92 });
    assert.equal(percentLabel(report.totals.rate), '92.0%');
    assert.equal(percentLabel(report.ranked[0].rate), '92.0%');
    assert.match(performanceExplanation(report), /92\.0%/);
    assert.match(performanceExplanation(report), /92 of 100/);
    assert.equal(report.rows[0].recordedTurnout, 92);
    assert.equal(report.totals.noShows, 8);
});

test('the rendered overview, performance chart, and explanation all show the same 92% sample', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js'), 'utf8');
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
            style: {}, parentElement: { style: {} },
            classList: { toggle() {} }, setAttribute() {},
            replaceChildren() { this.options = []; this.value = ''; },
            add(option) { this.options.push(option); }
        });
        return elements.get(id);
    };
    const chartConfigs = [];
    class Chart {
        constructor(canvas, config) { chartConfigs.push(config); }
        destroy() {}
    }
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById: element },
        window: { Chart }, Option: class Option {
            constructor(label, value) { this.label = label; this.value = value; }
        }, console
    });
    vm.runInContext(source, context);
    const event = events[0];
    context.fixture = {
        events: [event],
        participants: Array.from({ length: 100 }, (_, index) => participant(event.event_id, `student-${index}`)),
        attendance: Array.from({ length: 92 }, (_, index) => checkIn(event.event_id, `student-${index}`, '2026-09-04T00:05:00Z'))
    };
    element('trendDateFrom').value = '2026-09-01';
    element('trendDateTo').value = '2026-09-30';
    element('trendGrouping').value = 'event';
    vm.runInContext('Object.assign(state, fixture); state.activeTab = "performance"; render();', context);
    assert.equal(element('statAttendanceRate').textContent, '92.0%');
    assert.equal(chartConfigs.at(-1).data.datasets[0].data[0], 92);
    assert.match(element('performanceExplanation').textContent, /92\.0%/);
    assert.match(element('performanceExplanation').textContent, /92 of 100/);
    element('trendEvent').value = event.event_id;
    element('trendGrade').value = 'Grade 7';
    element('trendGrouping').value = 'weekly';
    context.resetCalled = false;
    vm.runInContext('loadRange = () => { resetCalled = true; }; resetFilters();', context);
    assert.equal(element('trendEvent').value, '');
    assert.equal(element('trendGrade').value, '');
    assert.equal(element('trendGrouping').value, 'event');
    assert.equal(context.resetCalled, true);
});

test('best rate, largest turnout, ties, and attention threshold are distinct', () => {
    const sampleEvents = [
        { ...events[0], event_id: 'best-a', event_name: 'Science Fair' },
        { ...events[1], event_id: 'best-b', event_name: 'Arts Day' },
        { ...events[1], event_id: 'largest', event_name: 'Foundation Day' },
        { ...events[1], event_id: 'attention', event_name: 'Parents Day' }
    ];
    const counts = [[100, 95], [20, 19], [500, 400], [100, 69]];
    const roster = [], scans = [];
    sampleEvents.forEach((event, index) => {
        for (let student = 0; student < counts[index][0]; student++) {
            const id = `${index}-${student}`;
            roster.push(participant(event.event_id, id));
            if (student < counts[index][1]) scans.push(checkIn(event.event_id, id, '2026-09-18T00:02:00Z'));
        }
    });
    const report = performanceAnalytics(sampleEvents, normalizeAnalytics(sampleEvents, roster, scans), scans, {}, '2026-10-08');
    assert.deepEqual(report.best.map(row => row.event.event_id).sort(), ['best-a', 'best-b']);
    assert.deepEqual(report.largest.map(row => row.event.event_id), ['largest']);
    assert.deepEqual(report.attention.map(row => row.event.event_id), ['attention']);
    assert.match(performanceExplanation(report), /tied for the highest/);
    assert.equal(report.totals.expected, 720);
    assert.equal(report.totals.attended, 583);
});

test('no-roster events have no rate, while unique recorded turnout includes non-roster people', () => {
    const event = events[0];
    const scans = [
        checkIn(event.event_id, 'unrostered', '2026-09-04T00:00:00Z'),
        checkIn(event.event_id, 'unrostered', '2026-09-04T00:01:00Z'),
        { event_id: event.event_id, employee_id: 'staff-a', time_in: '2026-09-04T00:00:00Z' }
    ];
    const report = performanceAnalytics([event], normalizeAnalytics([event], [], scans), scans, {}, '2026-10-08');
    assert.equal(report.rows[0].rate, null);
    assert.equal(report.rows[0].recordedTurnout, 2);
    assert.equal(report.totals.rate, null);
    assert.equal(report.best.length, 0);
    assert.equal(report.largest.length, 1);
});

test('upcoming, ongoing, cancelled, and future-dated events do not enter completed performance', () => {
    const sampleEvents = [
        events[0],
        { ...events[1], status: 'upcoming' },
        { ...events[1], event_id: 'ongoing', status: 'ongoing' },
        { ...events[1], event_id: 'cancelled', status: 'cancelled' },
        { ...events[1], event_id: 'future', event_date: '2026-11-01', status: 'completed' }
    ];
    const roster = sampleEvents.map(event => participant(event.event_id, 'A'));
    const report = performanceAnalytics(sampleEvents, normalizeAnalytics(sampleEvents, roster, []), [], {}, '2026-10-08');
    assert.deepEqual(report.completed.map(row => row.event.event_id), ['first']);
    assert.equal(report.totals.noShows, 1);
    assert.match(trendNarrative(report), /Only 1 comparable completed event/);
});

test('grade filters restrict both roster metrics and recorded turnout to matching students', () => {
    const roster = [participant('first', 'A'), participant('first', 'B', 'Grade 8', 'eight-a')];
    const scans = [
        checkIn('first', 'A', '2026-09-04T00:00:00Z'),
        checkIn('first', 'B', '2026-09-04T00:00:00Z'),
        checkIn('first', 'outside', '2026-09-04T00:00:00Z')
    ];
    const filters = { grade: 'Grade 8' };
    const report = performanceAnalytics(events.slice(0, 1),
        normalizeAnalytics(events.slice(0, 1), roster, scans, filters), scans, filters, '2026-10-08');
    assert.deepEqual({ expected: report.totals.expected, attended: report.totals.attended, turnout: report.rows[0].recordedTurnout },
        { expected: 1, attended: 1, turnout: 1 });
});

test('trend wording requires three comparable completed events and does not invent a trend', () => {
    const rows = [60, 72, 84].map((rate, index) => ({
        event: { event_id: String(index), event_date: `2026-09-${String(index + 1).padStart(2, '0')}` },
        expected: 100, attended: rate, rate
    }));
    assert.match(trendNarrative({ rated: rows }), /higher attendance rate/);
    assert.match(trendNarrative({ rated: rows.slice(0, 2) }), /cannot be determined/);
    assert.match(trendNarrative({ rated: [{ ...rows[0], rate: 84 }, { ...rows[1], rate: 72 }, { ...rows[2], rate: 60 }] }), /lower attendance rate/);
    assert.match(trendNarrative({ rated: [{ ...rows[0], rate: 80 }, { ...rows[1], rate: 82 }, { ...rows[2], rate: 81 }] }), /within five percentage points/);
});

test('dashboard script references existing filter, metric, chart, and table elements', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html'), 'utf8');
    const ids = [...script.matchAll(/(?:field|value|setText)\('([^']+)'/g)].map(match => match[1]);
    const missing = [...new Set(ids)].filter(id => !page.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
    assert.equal((page.match(/<canvas\s/g) || []).length, 3);
    const idsInPage = [...page.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(idsInPage).size, idsInPage.length);
    for (const label of ['Overview', 'Event Performance', 'Attendance Breakdown', 'Trends']) {
        assert.ok(page.includes(label));
    }
});

test('dashboard markup and local assets use the current version', () => {
    const pageFile = path.join(__dirname, '../../TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html');
    const page = fs.readFileSync(pageFile, 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js'), 'utf8');
    const version = page.match(/data-event-analytics-version="([^"]+)"/)?.[1];
    assert.ok(version);
    assert.ok(script.includes(`ANALYTICS_PAGE_VERSION = '${version}'`));
    assert.ok(page.includes(`eventAttendanceTrends.js?v=${version}`));
    assert.ok(page.includes(`eventAttendanceTrends.css?v=${version}`));
    const assets = [...page.matchAll(/(?:href|src)="([^"#]+)"/g)]
        .map(match => match[1].split('?')[0])
        .filter(url => !/^https?:\/\//.test(url));
    assert.deepEqual(assets.filter(url => !fs.existsSync(path.resolve(path.dirname(pageFile), url))), []);
});
