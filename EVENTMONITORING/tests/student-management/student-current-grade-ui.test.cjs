const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../..', 'admin', 'student-import.js'), 'utf8');
function codeBetween(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert(first >= 0 && last > first, `Cannot extract ${start}`);
    return source.slice(first, last);
}
const code = [
    codeBetween('const EMAIL_LIKE_PATTERN', "document.addEventListener('DOMContentLoaded'"),
    codeBetween('function validateRow(', 'function renderPreview('),
    codeBetween('async function submitEditStudentForm(', 'function deleteStudentRow('),
    codeBetween('async function submitSingleStudentForm(', 'function openDuplicateRowsModal('),
].join('\n');

function harness(values) {
    const alerts = [];
    const writes = [];
    const elements = new Map(Object.entries(values).map(([key, value]) =>
        [key, { value, disabled: false, textContent: '', reset() {}, focus() {} }]));
    const context = {
        crypto, console, Date,
        document: { getElementById: id => elements.get(id) || { value: '', reset() {}, focus() {} } },
        activeSchoolYear: { id: 'year-1' },
        allStudents: [{ student_id: 'uuid-1', stud_id: '1-0016', current_grade_level: 'Grade 1', section_id: 'section-4' }],
        selectedDepartmentName: 'Section A', departmentsCache: [],
        singleStudentModal: null, editStudentModal: null,
        getStudentBirthDateError: () => null,
        updateStudentBirthDateInput: () => null,
        setSingleStudentLoading() {}, loadAllStudentsTable: async () => {},
        showImportAlert: message => alerts.push(message),
        supabaseClient: { from(table) {
            assert.equal(table, 'students');
            return {
                select() { return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } }; },
                insert(payload) { writes.push({ kind: 'insert', payload }); return Promise.resolve({ error: null }); },
                update(payload) { return { eq(column, value) {
                    writes.push({ kind: 'update', payload, column, value });
                    return Promise.resolve({ error: null });
                } }; },
            };
        } },
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    return { context, elements, alerts, writes };
}

test('valid Student ID prefixes determine academic grade independent of section', () => {
    const { context } = harness({ gradeLevelSelect: 'Grade 1' });
    for (const [id, grade] of [['K-0001', 'Kinder'], ['1-0016', 'Grade 1'],
                               ['2-0001', 'Grade 2'], ['10-9999', 'Grade 10']]) {
        assert.equal(vm.runInContext(`currentGradeFromStudentId('${id}')`, context), grade);
    }
    assert.equal(vm.runInContext("currentGradeFromStudentId('G1-0001')", context), null);
    const row = { studId: '1-0016', firstName: 'Dummy', lastName: 'Student',
        birthDate: '2015-01-01', gender: 'male', g1Phone: '09990000000',
        g1FirstName: 'Guardian', g1LastName: 'One', g1Relationship: 'mother' };
    context.rowForTest = row;
    assert.equal(vm.runInContext('validateRow(rowForTest, 0).status', context), 'warning');
    context.document.getElementById('gradeLevelSelect').value = 'Grade 4';
    assert(vm.runInContext('validateRow(rowForTest, 0).errors', context)
        .some(error => error.includes('prefix must match')));
});

test('single registration writes ID-derived grade even with an older-grade section', async () => {
    const h = harness({ singleDepartment: 'section-4', singleStudentId: '1-0016',
        singleGradeLevel: 'Grade 1', singleFirstName: 'Dummy', singleLastName: 'Student',
        singleYearLevel: '2015-01-01', singleSection: 'male' });
    h.context.eventForTest = { preventDefault() {} };
    await vm.runInContext('submitSingleStudentForm(eventForTest)', h.context);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].payload.stud_id, '1-0016');
    assert.equal(h.writes[0].payload.current_grade_level, 'Grade 1');
    assert.equal(h.writes[0].payload.section_id, 'section-4');

    h.elements.get('singleGradeLevel').value = 'Grade 4';
    h.writes.length = 0;
    await vm.runInContext('submitSingleStudentForm(eventForTest)', h.context);
    assert.equal(h.writes.length, 0);
    assert(h.alerts.some(message => message.includes('prefix must match')));
});

test('student edit advances ID and grade together while retaining section and UUID', async () => {
    const h = harness({ editStudentUid: 'uuid-1', editStudentId: '1-0016',
        editGradeLevel: 'Grade 2', editDepartment: 'section-4',
        editFirstName: 'Dummy', editLastName: 'Student', editYearLevel: '2015-01-01',
        editSection: 'male', editStatus: 'active' });
    h.context.eventForTest = { preventDefault() {} };
    await vm.runInContext('submitEditStudentForm(eventForTest)', h.context);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].column, 'student_id');
    assert.equal(h.writes[0].value, 'uuid-1');
    assert.equal(h.writes[0].payload.stud_id, '2-0016');
    assert.equal(h.writes[0].payload.current_grade_level, 'Grade 2');
    assert.equal(h.writes[0].payload.section_id, 'section-4');
    assert.equal('student_id' in h.writes[0].payload, false);
});
