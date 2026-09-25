'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    normalizeAnalytics, summarizeAnalytics, trendPoints, lateInfo, percentage
} = require('../resc/js/eventAttendanceTrends.js');

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
            section_id: sectionId,
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

test('dashboard script references existing filter, metric, chart, and table elements', () => {
    const script = fs.readFileSync(path.join(__dirname, '../resc/js/eventAttendanceTrends.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '../admin/eventAttendanceTrends.html'), 'utf8');
    const ids = [...script.matchAll(/(?:field|value|setText)\('([^']+)'/g)].map(match => match[1]);
    const missing = [...new Set(ids)].filter(id => !page.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
    assert.equal((page.match(/<canvas\s/g) || []).length, 6);
});

test('dashboard markup and local assets use the current version', () => {
    const pageFile = path.join(__dirname, '../admin/eventAttendanceTrends.html');
    const page = fs.readFileSync(pageFile, 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../resc/js/eventAttendanceTrends.js'), 'utf8');
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
