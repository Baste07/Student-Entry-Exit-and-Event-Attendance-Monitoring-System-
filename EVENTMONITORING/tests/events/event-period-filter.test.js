'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Period = require('../../shared/event-period-filter.js');
const { normalizeAnalytics, performanceAnalytics } = require('../../TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js');

const fixedNow = new Date('2026-10-22T04:00:00Z');
const event = (id, start, end = null, status = 'completed') => ({
    event_id: id, event_name: id, event_date: start, end_date: end, status, time_start: '08:00:00'
});

test('Monthly ranges use real calendar boundaries for January, leap February, and October', () => {
    assert.deepEqual(Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 1 }, fixedNow), {
        mode: 'monthly', year: 2026, month: 1, valid: true,
        start: '2026-01-01', endExclusive: '2026-02-01', label: 'January 2026'
    });
    assert.equal(Period.getPeriodRange({ mode: 'monthly', year: 2024, month: 2 }, fixedNow).endExclusive, '2024-03-01');
    const october = Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 10 }, fixedNow);
    assert.deepEqual(Period.filterEvents([
        event('dec', '2025-12-31'), event('jan', '2026-01-01'), event('oct', '2026-10-31'), event('nov', '2026-11-01')
    ], october).map(row => row.event_id), ['oct']);
});

test('Quarterly ranges cover Q1-Q4 and Q4 does not cross the year boundary', () => {
    const expected = [
        ['2026-01-01', '2026-04-01'], ['2026-04-01', '2026-07-01'],
        ['2026-07-01', '2026-10-01'], ['2026-10-01', '2027-01-01']
    ];
    expected.forEach(([start, endExclusive], index) => {
        const range = Period.getPeriodRange({ mode: 'quarterly', year: 2026, quarter: index + 1 }, fixedNow);
        assert.equal(range.start, start);
        assert.equal(range.endExclusive, endExclusive);
    });
    const q4 = Period.getPeriodRange({ mode: 'quarterly', year: 2026, quarter: 4 }, fixedNow);
    assert.deepEqual(Period.filterEvents([event('dec', '2026-12-31'), event('jan', '2027-01-01')], q4).map(row => row.event_id), ['dec']);
});

test('Custom ranges remain inclusive and reject a reversed range', () => {
    const range = Period.getPeriodRange({ mode: 'custom', from: '2026-10-10', to: '2026-10-15' }, fixedNow);
    assert.equal(range.start, '2026-10-10');
    assert.equal(range.endExclusive, '2026-10-16');
    assert.match(range.label, /^Custom:/);
    assert.deepEqual(Period.filterEvents([
        event('before', '2026-10-09'), event('first', '2026-10-10'), event('last', '2026-10-15'), event('after', '2026-10-16')
    ], range).map(row => row.event_id), ['first', 'last']);
    assert.equal(Period.getPeriodRange({ mode: 'custom', from: '2026-10-16', to: '2026-10-15' }, fixedNow).valid, false);
});

test('A multi-day Event is included once when its scheduled range intersects the period', () => {
    const october = Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 10 }, fixedNow);
    const events = [event('cross-boundary', '2026-09-30', '2026-10-02'), event('september', '2026-09-01', '2026-09-30')];
    assert.deepEqual(Period.filterEvents(events, october).map(row => row.event_id), ['cross-boundary']);
});

test('Default period is the current Manila month and available years include Event data', () => {
    const range = Period.getPeriodRange({}, fixedNow);
    assert.equal(range.label, 'October 2026');
    assert.deepEqual(Period.availableYears([event('old', '2024-01-01'), event('future', '2028-01-01')], fixedNow), [2028, 2027, 2026, 2025, 2024]);
});

test('Report and analytics inputs use the same filtered Event set', () => {
    const october = Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 10 }, fixedNow);
    const events = [event('sep', '2026-09-20'), event('oct-a', '2026-10-03'), event('oct-b', '2026-10-20')];
    const selected = Period.filterEvents(events, october);
    const participants = selected.map(row => ({
        event_id: row.event_id, student_id: `${row.event_id}-student`,
        students: { student_id: `${row.event_id}-student`, current_grade_level: 'Grade 1', section_id: 'A', sections: { section_name: 'A' } }
    }));
    const attendance = selected.map(row => ({ event_id: row.event_id, student_id: `${row.event_id}-student`, time_in: `${row.event_date}T00:00:00Z` }));
    const analytics = performanceAnalytics(selected, normalizeAnalytics(selected, participants, attendance), attendance, {}, '2026-11-01');
    const reportRows = attendance.filter(row => selected.some(item => item.event_id === row.event_id));
    assert.equal(selected.length, 2);
    assert.equal(reportRows.length, 2);
    assert.equal(analytics.rows.length, 2);
    assert.equal(analytics.totals.attended, 2);
});

test('Event Attendance selector uses overlap semantics from the shared period helper', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/eventAttendance.js'), 'utf8');
    const select = { value: '', innerHTML: '' };
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById(id) { return id === 'eventSelect' ? select : null; } },
        EventPeriodFilter: Period, console
    });
    vm.runInContext(source, context);
    context.fixture = [event('cross', '2026-09-30', '2026-10-02'), event('sep', '2026-09-01', '2026-09-30')];
    context.range = Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 10 }, fixedNow);
    vm.runInContext('allEventsList = fixture; eventPeriodFilter = { getRange: () => range }; renderEventOptions();', context);
    assert.match(select.innerHTML, /cross/);
    assert.doesNotMatch(select.innerHTML, /value="sep"/);
});

test('Event Reports applies the shared period before every visible metric and export dataset', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/attendanceReports.js'), 'utf8');
    const values = { filterSearch: '', filterStatus: '', filterFrom: '', filterTo: '', filterCourse: '', filterEvent: '' };
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById(id) { return { value: values[id] || '' }; } },
        EventPeriodFilter: Period, Chart: class {}, console
    });
    vm.runInContext(source, context);
    context.fixture = [
        { id: 'cross-row', name: 'A', id_number: '1', event: 'Cross', eventData: event('cross', '2026-09-30', '2026-10-02'), status: 'present' },
        { id: 'sep-row', name: 'B', id_number: '2', event: 'Sep', eventData: event('sep', '2026-09-01', '2026-09-30'), status: 'present' }
    ];
    context.range = Period.getPeriodRange({ mode: 'monthly', year: 2026, month: 10 }, fixedNow);
    const ids = vm.runInContext('activeTab = "event"; reportPeriodFilter = { getRange: () => range }; applyFilters(fixture).map(row => row.id)', context);
    assert.deepEqual([...ids], ['cross-row']);
});

test('Event Reports uses the current employee and student relationships', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../TimeInAndTimeOutMonitoring/resc/js/attendanceReports.js'), 'utf8');
    assert.match(source, /employees\(employee_id, emp_no, first_name, last_name\)/);
    assert.match(source, /students\(student_id, stud_id, first_name, last_name\)/);
    assert.match(source, /r\.students \|\| r\.employees/);
    assert.doesNotMatch(source, /teachers\(teacher_id/);
    assert.doesNotMatch(source, /r\.teachers/);
});

test('All three pages load the shared helper and exports use filtered state and period labels', () => {
    const root = path.join(__dirname, '../..');
    const pages = [
        'TimeInAndTimeOutMonitoring/admin/eventAttendance.html',
        'TimeInAndTimeOutMonitoring/admin/attendanceReports.html',
        'TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html'
    ];
    for (const page of pages) {
        const source = fs.readFileSync(path.join(root, page), 'utf8');
        assert.match(source, /shared\/event-period-filter\.js/);
        assert.match(source, /shared\/event-period-filter\.css/);
        assert.match(source, />Monthly</);
        assert.match(source, />Quarterly</);
        assert.match(source, />Custom Date</);
    }
    const report = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/attendanceReports.js'), 'utf8');
    const analytics = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js'), 'utf8');
    assert.match(report, /filteredRows\.map/);
    assert.match(report, /Reporting Period/);
    assert.match(analytics, /state\.performance\?\.completed/);
    assert.match(analytics, /state\.activeRange\?\.label/);
    assert.match(analytics, /No Events found for/);
});

test('Cancelled-Event business rules remain page-specific', () => {
    const root = path.join(__dirname, '../..');
    const attendance = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/eventAttendance.js'), 'utf8');
    const analytics = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/eventAttendanceTrends.js'), 'utf8');
    const reports = fs.readFileSync(path.join(root, 'TimeInAndTimeOutMonitoring/resc/js/attendanceReports.js'), 'utf8');
    assert.match(attendance, /\.neq\('status', 'cancelled'\)/);
    assert.match(analytics, /status !== 'cancelled'/);
    assert.doesNotMatch(reports, /allReportEvents\.filter\([^\n]+cancelled/);
});
