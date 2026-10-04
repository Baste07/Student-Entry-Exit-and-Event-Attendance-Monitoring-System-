const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../..', 'admin', 'student-import.js'), 'utf8');
function between(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert(first >= 0 && last > first, `Cannot extract ${start}`);
    return source.slice(first, last);
}
const code = [
    between('const sectionLoadTokens', 'let singleStudentModal'),
    between('const EMAIL_LIKE_PATTERN', "document.addEventListener('DOMContentLoaded'"),
    between('function checkReadyToParse()', 'async function parseFile()'),
    between('async function startImport()', 'function renderStudentsSkeleton()'),
    between('function getRegistrationSection(', 'async function openSingleStudentModal(')
].join('\n');

const sections = [
    { section_id: 's1', grade_level: 'Grade 1', section_name: 'Section One', school_year_id: 'year-1' },
    { section_id: 's2', grade_level: 'Grade 2', section_name: 'Section Two', school_year_id: 'year-1' },
    { section_id: 's10', grade_level: 'Grade 10', section_name: 'Section Ten', school_year_id: 'year-1' },
    { section_id: 'old', grade_level: 'Grade 1', section_name: 'Old Section', school_year_id: 'year-0' }
];

function element(value = '') {
    let html = '';
    return {
        value, disabled: false,
        get innerHTML() { return html; },
        set innerHTML(next) { html = next; this.value = ''; }
    };
}

function harness({ databaseSections = sections, deferred = {} } = {}) {
    const elements = new Map([
        ['gradeLevelSelect', element('Grade 1')], ['singleGradeLevel', element('Grade 1')],
        ['departmentSelect', element()], ['singleDepartment', element()],
        ['parseFileBtn', element()]
    ]);
    const queries = [];
    const alerts = [];
    const steps = [];
    const context = {
        console, Date,
        activeSchoolYear: { id: 'year-1' }, departmentsCache: sections,
        selectedDepartmentId: 's1', selectedDepartmentName: 'Grade 1 - Section One',
        selectedFile: { name: 'students.xlsx' }, parsedRows: [],
        document: { getElementById: id => elements.get(id) || null },
        escapeHtml: value => String(value),
        showImportAlert: message => alerts.push(message),
        showStep: step => steps.push(step),
        getStudentBirthDateError: () => '',
        supabaseClient: {
            from(table) {
                assert.equal(table, 'sections', 'invalid selections must stop before student writes');
                const filters = {};
                const query = {
                    select() { return this; },
                    eq(column, value) { filters[column] = value; return this; },
                    order() {
                        queries.push({ ...filters });
                        if (deferred[filters.grade_level]) return deferred[filters.grade_level].promise;
                        return Promise.resolve({ data: databaseSections.filter(section =>
                            Object.entries(filters).every(([key, value]) => section[key] === value)), error: null });
                    },
                    async maybeSingle() {
                        return { data: databaseSections.find(section =>
                            Object.entries(filters).every(([key, value]) => section[key] === value)) || null,
                        error: null };
                    }
                };
                return query;
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    return { context, elements, queries, alerts, steps };
}

test('Grade 1, 2, and 10 query only active-year sections for that grade', async () => {
    const h = harness();
    for (const [grade, included, excluded] of [
        ['Grade 1', 'Section One', 'Section Two'],
        ['Grade 2', 'Section Two', 'Section Ten'],
        ['Grade 10', 'Section Ten', 'Section One']
    ]) {
        h.elements.get('singleGradeLevel').value = grade;
        await h.context.filterSectionsByGradeLevel(grade, 'singleDepartment');
        const html = h.elements.get('singleDepartment').innerHTML;
        assert.match(html, new RegExp(included));
        assert.doesNotMatch(html, new RegExp(excluded));
        assert.doesNotMatch(html, /Old Section/);
        assert.equal(h.elements.get('singleDepartment').value, '');
        assert.equal(h.elements.get('singleDepartment').disabled, false);
        assert.equal(h.queries.at(-1).grade_level, grade);
        assert.equal(h.queries.at(-1).school_year_id, 'year-1');
    }
});

test('switching grade clears the old section immediately and ignores late responses', async () => {
    let finishFirst;
    const first = { promise: new Promise(resolve => { finishFirst = resolve; }) };
    const h = harness({ deferred: { 'Grade 1': first } });
    const select = h.elements.get('singleDepartment');
    select.value = 's1';
    const oldRequest = h.context.filterSectionsByGradeLevel('Grade 1', 'singleDepartment');
    assert.equal(select.value, '');
    assert.equal(select.disabled, true);
    h.elements.get('singleGradeLevel').value = 'Grade 2';
    await h.context.filterSectionsByGradeLevel('Grade 2', 'singleDepartment');
    finishFirst({ data: [sections[0]], error: null });
    await oldRequest;
    assert.match(select.innerHTML, /Section Two/);
    assert.doesNotMatch(select.innerHTML, /Section One/);
});

test('bulk import rejects a cross-grade section and a mismatched Student ID before any write', async () => {
    const h = harness();
    h.context.parsedRows = [{ studId: '1-0001', birthDate: '2015-01-01', status: 'ok' }];
    h.context.selectedDepartmentId = 's2';
    await h.context.startImport();
    assert(h.alerts.some(message => message.includes('Select a section')));
    h.context.selectedDepartmentId = 's1';
    h.context.parsedRows = [{ studId: '2-0001', birthDate: '2015-01-01', status: 'ok' }];
    await h.context.startImport();
    assert(h.alerts.some(message => message.includes('Every Student ID')));
});

test('bulk import rechecks the section against the current database row', async () => {
    const h = harness({ databaseSections: [sections[1]] });
    h.context.parsedRows = [{ studId: '1-0001', birthDate: '2015-01-01', status: 'ok' }];
    await h.context.startImport();
    assert(h.alerts.some(message => message.includes('no longer matches')));
});
