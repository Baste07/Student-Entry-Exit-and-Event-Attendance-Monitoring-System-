const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
    '../../EntryExitMonitoring/resc/js/entry-exitLogs.js'), 'utf8');

const studentA = { student_id: 'private-student-a', stud_id: '1-0001', first_name: 'John',
    last_name: 'Larga', current_grade_level: 'Grade 1', sections: { section_name: 'MABAIT' } };
const studentB = { student_id: 'private-student-b', stud_id: '1-0002', first_name: 'Ada',
    last_name: 'Santos', current_grade_level: 'Grade 2', sections: { section_name: 'WISDOM' } };
const employee = { employee_id: 'private-employee', emp_no: 'EMP-07', first_name: 'Maria',
    last_name: 'Reyes', faculty: 'Registrar' };
const logs = [
    { id: 'private-log-1', student_id: 'private-student-a', students: studentA,
        log_type: 'entry', scan_method: 'face', log_date: '2026-10-14',
        log_timestamp: '2026-10-13T17:00:00Z', is_late: false },
    { id: 'private-log-2', student_id: 'private-student-a', students: studentA,
        log_type: 'exit', scan_method: 'qr', log_date: '2026-10-14',
        log_timestamp: '2026-10-14T07:00:00Z' },
    { id: 'private-log-3', student_id: 'private-student-b', students: studentB,
        log_type: 'entry', scan_method: 'manual', log_date: '2026-10-14',
        log_timestamp: '2026-10-14T01:00:00Z', is_late: true },
    { id: 'private-log-4', employee_id: 'private-employee', employees: employee,
        log_type: 'entry', scan_method: 'face', log_date: '2026-10-14',
        log_timestamp: '2026-10-14T00:00:00Z' },
    { id: 'private-log-5', student_id: 'private-student-a', students: studentA,
        log_type: 'entry', scan_method: 'face', log_date: '2026-10-01',
        log_timestamp: '2026-10-01T00:00:00Z', is_late: false }
];

function page(rows = logs) {
    const elements = new Map();
    const events = { clicks: [], notices: [], pdfs: [], blobs: [], revoked: [] };
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', innerHTML: '', textContent: '', appendChild() {}, addEventListener() {}
        });
        return elements.get(id);
    };
    const document = {
        getElementById: element, addEventListener() {},
        body: { appendChild() {} },
        createElement() { return { click() { events.clicks.push(this.download); }, remove() {} }; }
    };
    class PDF {
        constructor(options) {
            this.options = options;
            this.internal = { pageSize: { width: 297, height: 210 }, getNumberOfPages: () => 3 };
            events.pdfs.push(this);
        }
        setFillColor() {} rect() {} setTextColor() {} setFont() {} setFontSize() {}
        text(value) { this.texts ||= []; this.texts.push(value); }
        splitTextToSize(value) { return [value]; }
        autoTable(options) { this.table = options; }
        setPage(pageNumber) { this.pageNumbers ||= []; this.pageNumbers.push(pageNumber); }
        save(filename) { this.filename = filename; }
    }
    const context = vm.createContext({
        document, window: { jspdf: { jsPDF: PDF } }, Blob,
        URL: { createObjectURL(blob) { events.blobs.push(blob); return 'blob:test'; },
            revokeObjectURL(url) { events.revoked.push(url); } },
        UIFeedback: { toast(note) { events.notices.push(note.message); },
            success(message) { events.notices.push(message); },
            error(message) { events.notices.push(message); } },
        setTimeout(callback) { callback(); }, console, seedLogs: rows
    });
    vm.runInContext(source, context);
    vm.runInContext('allLogs = seedLogs; applyFilters()', context);
    return {
        context, events, element,
        filter(id, value) { element(id).value = value; vm.runInContext('applyFilters()', context); },
        rows() { return JSON.parse(vm.runInContext('JSON.stringify(getFilteredExportRows())', context)); },
        async csv() {
            vm.runInContext('exportCSV()', context);
            const blob = events.blobs.at(-1);
            return blob ? blob.text() : null;
        },
        pdf() { vm.runInContext('exportPDF()', context); return events.pdfs.at(-1); }
    };
}

test('CSV and PDF consume the same filtered rows, not just the visible page', async () => {
    const p = page([...logs, ...Array.from({ length: 30 }, (_, i) => ({
        ...logs[0], id: `private-extra-${i}`
    }))]);
    p.filter('userTypeFilter', 'student');
    p.filter('dateFrom', '2026-10-14');
    p.filter('dateTo', '2026-10-14');
    const rows = p.rows();
    assert.equal(rows.length, 33);
    const csv = await p.csv();
    const pdf = p.pdf();
    assert.equal((csv.match(/\r\n/g) || []).length, 33);
    assert.deepEqual(JSON.parse(JSON.stringify(pdf.table.body)), rows);
    assert.equal(pdf.table.showHead, 'everyPage');
    assert.equal(pdf.table.rowPageBreak, 'avoid');
    assert.deepEqual(pdf.pageNumbers, [1, 2, 3]);
    assert.deepEqual(JSON.parse(JSON.stringify(pdf.options)),
        { orientation: 'landscape', unit: 'mm', format: 'a4' });
    assert.deepEqual([...new Uint8Array(await p.events.blobs[0].arrayBuffer()).slice(0, 3)],
        [0xef, 0xbb, 0xbf]);
    assert.ok(csv.startsWith('"ID / EMP NO."'));
    assert.match(csv, /"\t1-0001"/);
    assert.doesNotMatch(csv, /private-student|private-log/);
    assert.equal(p.events.clicks.length, 1);
    assert.equal(p.events.pdfs.length, 1);
});

test('all six page filters constrain exported records', () => {
    const cases = [
        ['typeFilter', 'entry', [0, 2, 3, 4]],
        ['typeFilter', 'exit', [1]],
        ['methodFilter', 'face', [0, 3, 4]],
        ['methodFilter', 'qr', [1]],
        ['methodFilter', 'manual', [2]],
        ['userTypeFilter', 'student', [0, 1, 2, 4]],
        ['userTypeFilter', 'employee', [3]],
        ['searchInput', '1-0002', [2]],
        ['searchInput', 'reyes', [3]],
        ['dateFrom', '2026-10-14', [0, 1, 2, 3]],
        ['dateTo', '2026-10-01', [4]]
    ];
    for (const [filter, value, expected] of cases) {
        const p = page();
        p.filter(filter, value);
        assert.deepEqual(p.rows().map(row => row[0]), expected.map(i =>
            i === 3 ? 'EMP-07' : i === 2 ? '1-0002' : '1-0001'), `${filter}=${value}`);
    }
});

test('empty results create no CSV/PDF and show existing feedback', async () => {
    const p = page();
    p.filter('searchInput', 'no matching person');
    assert.equal(await p.csv(), null);
    assert.equal(p.pdf(), undefined);
    assert.equal(p.events.clicks.length, 0);
    assert.equal(p.events.notices.filter(x => x === 'No records to export.').length, 2);
});

test('CSV quotes commas, quotes, newlines and disarms formula-like text', async () => {
    const malicious = { ...logs[0], students: { ...studentA,
        first_name: '="RUN"\nsecond line', last_name: 'Smith, Jr.',
        sections: { section_name: '+formula' } } };
    const p = page([malicious]);
    const csv = await p.csv();
    assert.match(csv, /"Smith, Jr\., =""RUN""\nsecond line"/);
    assert.match(csv, /"\t\+formula"/);
    assert.match(csv, /"\t1-0001"/);
    assert.match(csv, /"Oct 14, 2026","01:00:00 AM"/);
    assert.equal(p.events.clicks[0].endsWith('.csv'), true);
});

test('formula-like leading characters are escaped without corrupting ordinary IDs', () => {
    const p = page();
    assert.equal(vm.runInContext("csvCell('1-0001')", p.context), '"1-0001"');
    for (const formula of ['=1+1', '+SUM(A1)', '-3+4', '@cmd', '  =NOW()']) {
        assert.ok(vm.runInContext(`csvCell(${JSON.stringify(formula)})`, p.context).startsWith('"\t'));
    }
});

test('Manila date rollover, long names, PDF filters, filenames and success feedback', async () => {
    const longName = 'Long Family Name '.repeat(8);
    const p = page([{ ...logs[0], students: { ...studentA, last_name: longName } }]);
    p.filter('dateFrom', '2026-10-14');
    p.filter('dateTo', '2026-10-14');
    p.filter('userTypeFilter', 'student');
    const pdf = p.pdf();
    assert.equal(pdf.table.body[0][7], 'Oct 14, 2026');
    assert.equal(pdf.table.body[0][8], '01:00:00 AM');
    assert.ok(pdf.table.body[0][1].length > 100);
    assert.equal(pdf.table.styles.overflow, 'linebreak');
    assert.equal(pdf.filename, 'entry-exit-logs-2026-10-14-to-2026-10-14.pdf');
    assert.ok(pdf.texts.flat().some(text => String(text).includes('Asia/Manila')));
    assert.ok(pdf.texts.flat().some(text => String(text).includes('User Type: Students')));
    assert.ok(pdf.texts.flat().some(text => String(text).includes('Entry-Exit Attendance Logs')));
    assert.equal(p.events.notices.at(-1), 'Entry-Exit logs exported successfully as PDF.');
    await p.csv();
    assert.equal(p.events.notices.at(-1), 'Entry-Exit logs exported successfully as CSV.');
});

test('PDF plugin failure gives feedback without a broken download', () => {
    const p = page();
    delete p.context.window.jspdf;
    assert.equal(p.pdf(), undefined);
    assert.equal(p.events.pdfs.length, 0);
    assert.match(p.events.notices.at(-1), /PDF export is unavailable/);
});
