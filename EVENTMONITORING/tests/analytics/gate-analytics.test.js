'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Gate = require('../../EntryExitMonitoring/resc/js/gate-analytics.js');

function log(id, type, action, time, method = 'face', section = 'Grade 7') {
    return {
        id: `${id}-${action}-${time}`, student_id: type === 'student' ? id : null,
        employee_id: type === 'employee' ? id : null,
        log_type: action, scan_method: method, log_timestamp: time,
        students: type === 'student' ? { first_name: id, last_name: 'Student', stud_id: id, current_grade_level: section, section_id: section, sections: { grade_level: section, section_name: 'A' } } : null,
        employees: type === 'employee' ? { first_name: id, last_name: 'Employee', emp_no: 1, role: 'teacher', faculty: 'Science' } : null
    };
}
const at = (hour, minute = 0, day = 25) => `2026-09-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
const now = new Date(at(18)).getTime();

test('four-person sample yields correct gate counts, occupancy, peaks, and stays', () => {
    const raw = [
        log('A', 'student', 'entry', at(7)), log('A', 'student', 'exit', at(16)),
        log('B', 'student', 'entry', at(7, 15)), log('B', 'student', 'exit', at(16, 10)),
        log('C', 'student', 'entry', at(7, 30)),
        log('D', 'employee', 'entry', at(6, 45)), log('D', 'employee', 'exit', at(17))
    ];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.entries, 4);
    assert.equal(view.exits, 3);
    assert.equal(view.uniquePeople, 4);
    assert.equal(view.inside.length, 1);
    assert.equal(view.inside[0].identifier, 'C');
    assert.equal(view.studentsInside, 1);
    assert.equal(view.employeesInside, 0);
    assert.equal(view.visits.unclosed.length, 1);
    assert.equal(view.visits.completed.length, 3);
    assert.equal(view.peakEntry.hour, 7);
    assert.equal(view.peakEntry.entries, 3);
    assert.equal(view.peakExit.hour, 16);
    assert.equal(view.peakExit.exits, 2);
    assert.equal(Gate.durationLabel(view.medianStayMs), '9h 00m');
    assert.equal(Gate.durationLabel(view.averageStayMs), '9h 23m');
    assert.equal(view.types.student.uniquePeople, 3);
    assert.equal(view.types.employee.uniquePeople, 1);
});

test('composite person keys keep overlapping student and employee IDs separate', () => {
    const raw = [log('same-id', 'student', 'entry', at(7)), log('same-id', 'employee', 'entry', at(8))];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.uniquePeople, 2);
    assert.equal(view.inside.length, 2);
});

test('an advanced display ID still resolves historical gate logs by permanent UUID', () => {
    const row = log('permanent-uuid', 'student', 'entry', at(7), 'qr', 'Grade 1');
    row.students.stud_id = '2-0001';
    row.students.current_grade_level = 'Grade 2';
    row.students.section_id = 'persistent-section-a';
    const normalized = Gate.normalize([row], now);
    const view = Gate.summary(normalized.rows, now);
    assert.equal(view.entries, 1);
    assert.equal(normalized.rows[0].key, 'student:permanent-uuid');
    assert.equal(normalized.rows[0].identifier, '2-0001');
    assert.equal(normalized.rows[0].sectionId, 'persistent-section-a');
    assert.equal(normalized.rows[0].grade, 'Grade 2');
    assert.equal(Gate.filterRows(normalized.rows, { grade: 'Grade 2' }).length, 1);
    assert.equal(Gate.filterRows(normalized.rows, { grade: 'Grade 1' }).length, 0);
});

test('Entry, Entry, Exit leaves one diagnostic unpaired Entry without false occupancy', () => {
    const raw = [log('A', 'student', 'entry', at(7)), log('A', 'student', 'entry', at(8)), log('A', 'student', 'exit', at(9))];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.visits.repeatedEntries, 1);
    assert.equal(view.visits.unclosed.length, 1);
    assert.equal(view.visits.unclosed[0].reason, 'Repeated Entry');
    assert.equal(view.visits.completed.length, 1);
    assert.equal(view.inside.length, 0);
});

test('Exit, Entry, Exit and Exit-only scans report unpaired exits', () => {
    const raw = [log('A', 'student', 'exit', at(6)), log('A', 'student', 'entry', at(7)), log('A', 'student', 'exit', at(8)), log('B', 'student', 'exit', at(9))];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.visits.unpairedExits, 2);
    assert.equal(view.visits.completed.length, 1);
    assert.equal(view.visits.unclosed.length, 0);
    assert.equal(view.inside.length, 0);
});

test('a cross-midnight visit has a positive duration and Manila calendar grouping', () => {
    const raw = [log('A', 'student', 'entry', at(23, 30, 24)), log('A', 'student', 'exit', at(0, 30))];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.visits.completed[0].durationMs, 3600000);
    assert.deepEqual(view.dates.map(day => day.date), ['2026-09-24', '2026-09-25']);
    assert.equal(view.dates[0].entries, 1);
    assert.equal(view.dates[1].exits, 1);
});

test('multiple visits for one person pair separately and latest Entry carries across midnight', () => {
    const raw = [
        log('A', 'student', 'entry', at(7, 0, 24)), log('A', 'student', 'exit', at(8, 0, 24)),
        log('A', 'student', 'entry', at(9, 0, 24)), log('A', 'student', 'exit', at(10, 0, 24)),
        log('A', 'student', 'entry', at(23, 30, 24))
    ];
    const view = Gate.summary(Gate.normalize(raw, now).rows, now);
    assert.equal(view.visits.completed.length, 2);
    assert.deepEqual(view.visits.completed.map(visit => visit.durationMs), [3600000, 3600000]);
    assert.equal(view.inside.length, 1);
    assert.equal(view.inside[0].date, '2026-09-24');
    assert.equal(view.visits.unclosed.length, 1);
});

test('empty activity produces zero counts without invented peaks or durations', () => {
    const view = Gate.summary([]);
    assert.equal(view.entries, 0);
    assert.equal(view.exits, 0);
    assert.equal(view.uniquePeople, 0);
    assert.equal(view.inside.length, 0);
    assert.equal(view.peakEntry, null);
    assert.equal(view.peakExit, null);
    assert.equal(view.averageStayMs, null);
    assert.equal(view.medianStayMs, null);
});

test('filters and invalid records never produce invented people or negative stays', () => {
    const raw = [log('A', 'student', 'entry', at(7), 'qr', 'Grade 7'), log('B', 'student', 'entry', at(8), 'manual', 'Grade 8'), log('C', 'employee', 'entry', at(9))];
    raw.push({ id: 'invalid', student_id: null, employee_id: null, log_type: 'entry', log_timestamp: at(10) });
    raw.push({ id: 'no-time', student_id: 'D', log_type: 'entry', log_timestamp: null });
    raw.push(log('E', 'student', 'entry', at(19)));
    const normalized = Gate.normalize(raw, now);
    assert.equal(normalized.invalid, 2);
    assert.equal(normalized.future, 1);
    const filtered = Gate.filterRows(normalized.rows, { personType: 'student', grade: 'Grade 7', section: 'Grade 7', method: 'qr' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].identifier, 'A');
    assert.equal(Gate.summary([]).averageStayMs, null);
});

test('dashboard and report pages reference existing assets and unique element IDs', () => {
    for (const file of ['dashboard.html', 'reports.html']) {
        const pageFile = path.join(__dirname, '../../EntryExitMonitoring/admin', file);
        const html = fs.readFileSync(pageFile, 'utf8');
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        assert.equal(ids.length, new Set(ids).size, `${file} has duplicate IDs`);
        const local = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map(match => match[1].split('?')[0]).filter(url => !/^https?:\/\//.test(url));
        assert.deepEqual(local.filter(url => !fs.existsSync(path.resolve(path.dirname(pageFile), url))), [], `${file} references missing assets`);
        const marker = file === 'dashboard.html' ? 'gate-dashboard-version' : 'gate-reports-version';
        const version = html.match(new RegExp(`data-${marker}="([^"]+)"`))?.[1];
        assert.ok(version, `${file} is missing its cache version`);
        assert.ok(html.includes(`gate-analytics.js?v=${version}`));
        assert.ok(html.includes(`${file === 'dashboard.html' ? 'dashboard' : 'reports'}.js?v=${version}`));
    }
});

test('paged data loading includes rows beyond the first 500 and uses Manila date boundaries', async () => {
    const source = Array.from({ length: 501 }, (_, index) => ({ id: index }));
    const ranges = [];
    const constraints = [];
    const client = { from(table) {
        assert.equal(table, 'entry_exit_logs');
        return {
            select() { return this; }, order() { return this; },
            gte(column, value) { constraints.push(['gte', column, value]); return this; },
            lte(column, value) { constraints.push(['lte', column, value]); return this; },
            async range(start, end) { ranges.push([start, end]); return { data: source.slice(start, end + 1), error: null }; }
        };
    } };
    const result = await Gate.fetchLogs(client, { from: '2026-09-25', to: '2026-09-25' });
    assert.equal(result.length, 501);
    assert.deepEqual(ranges, [[0, 499], [500, 999]]);
    assert.deepEqual(constraints[0], ['gte', 'log_timestamp', '2026-09-24T16:00:00.000Z']);
    assert.deepEqual(constraints[1], ['lte', 'log_timestamp', '2026-09-25T15:59:59.999Z']);
});

test('page scripts reference controls present in their matching pages', () => {
    for (const [page, scripts] of [
        ['dashboard.html', ['dashboard.js']],
        ['reports.html', ['gate-report-analytics.js']]
    ]) {
        const html = fs.readFileSync(path.join(__dirname, '../../EntryExitMonitoring/admin', page), 'utf8');
        for (const script of scripts) {
            const source = fs.readFileSync(path.join(__dirname, '../../EntryExitMonitoring/resc/js', script), 'utf8');
            const ids = [...source.matchAll(/(?:getElementById|dashboardText|gateText)\('([^']+)'/g)].map(match => match[1]);
            assert.deepEqual([...new Set(ids)].filter(id => !html.includes(`id="${id}"`)), [], `${script} references missing controls`);
        }
    }
});

test('weekday averages count one arrival per student per Manila date across months', () => {
    const days = [
        ['2026-09-28', '2026-10-05', 1], // Monday
        ['2026-09-29', '2026-10-06', 2], // Tuesday
        ['2026-09-30', '2026-10-07', 1],
        ['2026-10-01', '2026-10-08', 1],
        ['2026-10-02', '2026-10-09', 1]
    ];
    const raw = [];
    for (const [first, second, count] of days) {
        for (const date of [first, second]) {
            for (let student = 0; student < count; student++) {
                raw.push(log(`student-${student}`, 'student', 'entry', `${date}T06:35:00+08:00`));
            }
        }
    }
    // The same student exits, then enters again on Tuesday. This is another
    // transaction, not another unique arrival on that date.
    raw.push(log('student-0', 'student', 'exit', '2026-10-06T12:00:00+08:00'));
    raw.push(log('student-0', 'student', 'entry', '2026-10-06T13:00:00+08:00'));
    const view = Gate.studentActivity(Gate.normalize(raw, Date.parse('2026-11-01T00:00:00Z')).rows);
    assert.equal(view.busiest.day, 'Tuesday');
    assert.equal(view.reliable, true);
    assert.equal(view.busiest.average, 2);
    assert.equal(view.busiest.observedDates, 2);
    assert.equal(view.busiest.totalUniqueArrivals, 4);
    assert.equal(view.busiest.entryScans, 5);
    assert.equal(view.weekdayAverage, 1.2);
    assert.ok(Math.abs(view.busiest.differencePercent - 66.6667) < .01);
    assert.equal(view.totalUniqueArrivals, 12);
    assert.equal(view.observedDates, 10);
    assert.equal(view.averageDailyStudents, 1.2);
    assert.equal(view.peakArrival.label, '6:30 AM–7:00 AM');
    assert.equal(view.peakArrival.arrivals, 12);
    assert.equal(view.daily.find(day => day.date === '2026-10-06').uniqueArrivals, 2);
    assert.equal(view.daily.find(day => day.date === '2026-10-06').entryScans, 3);

    const source = fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/gate-report-analytics.js'), 'utf8');
    const context = { document: { addEventListener() {} }, Intl };
    vm.createContext(context);
    vm.runInContext(source, context);
    const explanation = vm.runInContext('gateWeekdayExplanation', context)(view);
    assert.match(explanation, /Tuesday is the busiest school day/);
    assert.match(explanation, /Based on 2 observed Tuesdays, an average of 2 unique students/);
    assert.match(explanation, /66\.7% higher than the weekday average/);
});

test('first arrivals and last exits use half-hour periods, not repeat scans', () => {
    const raw = [
        log('A', 'student', 'entry', '2026-10-06T06:35:00+08:00'),
        log('A', 'student', 'exit', '2026-10-06T12:00:00+08:00'),
        log('A', 'student', 'entry', '2026-10-06T13:05:00+08:00'),
        log('A', 'student', 'exit', '2026-10-06T16:45:00+08:00'),
        log('B', 'student', 'entry', '2026-10-06T06:40:00+08:00'),
        log('B', 'student', 'exit', '2026-10-06T16:35:00+08:00'),
        log('staff', 'employee', 'entry', '2026-10-06T06:37:00+08:00')
    ];
    const view = Gate.studentActivity(Gate.normalize(raw, Date.parse('2026-11-01T00:00:00Z')).rows);
    assert.equal(view.entryScans, 3);
    assert.equal(view.exitScans, 3);
    assert.equal(view.totalUniqueArrivals, 2);
    assert.equal(view.peakArrival.label, '6:30 AM–7:00 AM');
    assert.equal(view.peakArrival.arrivals, 2);
    assert.equal(view.peakExit.label, '4:30 PM–5:00 PM');
    assert.equal(view.peakExit.departures, 2);
    assert.equal(Gate.halfHourLabel(47), '11:30 PM–12:00 AM');
});

test('sparse or weekend-only data never invents school-day zeros or a reliable winner', () => {
    const raw = [log('A', 'student', 'entry', '2026-10-03T07:00:00+08:00')];
    const rows = Gate.normalize(raw, Date.parse('2026-11-01T00:00:00Z')).rows;
    const view = Gate.studentActivity(rows, { from: '2026-10-03', to: '2026-10-04' });
    assert.deepEqual(view.weekdays.map(day => day.day), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    assert.equal(view.weekdays[0].average, null);
    assert.equal(view.weekdays[5].observedDates, 1);
    assert.equal(view.reliable, false);
    assert.equal(view.observedDates, 1);
    assert.equal(Gate.studentActivity([]).busiest, null);
});

test('grade and action filters update student analysis without including employees', () => {
    const raw = [
        log('A', 'student', 'entry', '2026-10-06T07:00:00+08:00', 'qr', 'Grade 1'),
        log('B', 'student', 'entry', '2026-10-06T07:05:00+08:00', 'face', 'Grade 2'),
        log('E', 'employee', 'entry', '2026-10-06T07:10:00+08:00'),
        log('A', 'student', 'exit', '2026-10-06T16:00:00+08:00', 'qr', 'Grade 1')
    ];
    const rows = Gate.normalize(raw, Date.parse('2026-11-01T00:00:00Z')).rows;
    assert.equal(Gate.studentActivity(Gate.filterRows(rows, { grade: 'Grade 1' })).totalUniqueArrivals, 1);
    assert.equal(Gate.studentActivity(Gate.filterRows(rows, { grade: 'Grade 2' })).totalUniqueArrivals, 1);
    assert.equal(Gate.studentActivity(Gate.filterRows(rows, { personType: 'employee' })).totalUniqueArrivals, 0);
    assert.equal(Gate.studentActivity(Gate.filterRows(rows, { action: 'exit' })).totalUniqueArrivals, 0);
    assert.equal(Gate.studentActivity(Gate.filterRows(rows, { method: 'qr' })).entryScans, 1);
});

test('Manila midnight and year boundaries remain separate observed arrival dates', () => {
    const raw = [
        log('A', 'student', 'entry', '2026-12-31T23:55:00+08:00'),
        log('A', 'student', 'entry', '2027-01-01T00:10:00+08:00'),
        log('A', 'student', 'entry', '2027-01-01T00:20:00+08:00')
    ];
    const view = Gate.studentActivity(Gate.normalize(raw, Date.parse('2027-02-01T00:00:00Z')).rows);
    assert.deepEqual(view.daily.map(day => [day.date, day.uniqueArrivals]),
        [['2026-12-31', 1], ['2027-01-01', 1]]);
    assert.equal(view.totalUniqueArrivals, 2);
    assert.equal(view.entryScans, 3);
    assert.equal(view.reliable, false);
});

test('changing a grade filter updates overview, weekday chart, and explanation together', () => {
    const raw = [
        log('A', 'student', 'entry', '2026-10-06T07:00:00+08:00', 'qr', 'Grade 1'),
        log('B', 'student', 'entry', '2026-10-06T07:05:00+08:00', 'qr', 'Grade 2'),
        log('C', 'student', 'entry', '2026-10-06T07:10:00+08:00', 'qr', 'Grade 2')
    ];
    const rows = Gate.normalize(raw, Date.parse('2026-11-01T00:00:00Z')).rows;
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '',
            style: {}, hidden: false, classList: { toggle() {} }, setAttribute() {} });
        return elements.get(id);
    };
    element('reportType').value = 'analytics';
    element('reportFrom').value = '2026-10-06';
    element('reportTo').value = '2026-10-06';
    const configs = [];
    const context = {
        GateAnalytics: Gate, Intl,
        document: { addEventListener() {}, getElementById: element, querySelector() { return { style: {} }; } },
        window: { Chart: class { constructor(_canvas, config) { configs.push(config); } destroy() {} } }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../EntryExitMonitoring/resc/js/gate-report-analytics.js'), 'utf8'), context);
    context.rowsForTest = rows;
    vm.runInContext('gateAnalyticsSource = rowsForTest', context);
    element('gradeFilter').value = 'Grade 1';
    vm.runInContext('renderGateAnalytics()', context);
    assert.equal(element('gateAverageDaily').textContent, '1');
    assert.match(element('gateWeekdayExplanation').textContent, /highest observed average \(1 unique student arrivals\).*Based on 1 observed Tuesday/);
    assert.equal(configs.at(-1).data.datasets[0].data[1], 1);
    element('gradeFilter').value = 'Grade 2';
    vm.runInContext('renderGateAnalytics()', context);
    assert.equal(element('gateAverageDaily').textContent, '2');
    assert.match(element('gateWeekdayExplanation').textContent, /highest observed average \(2 unique student arrivals\).*Based on 1 observed Tuesday/);
    assert.equal(configs.at(-1).data.datasets[0].data[1], 2);
    element('actionFilter').value = 'exit';
    vm.runInContext('renderGateAnalytics()', context);
    assert.equal(element('gateAverageDaily').textContent, '—');
    assert.match(element('gateWeekdayExplanation').textContent, /not enough Entry & Exit data/);
});
