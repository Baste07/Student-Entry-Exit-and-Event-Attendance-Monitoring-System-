const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../admin/student-import.js');
const source = readFileSync(sourcePath, 'utf8');

class Element {
    constructor(id, value = '') {
        this.id = id;
        this.value = value;
        this.style = {};
        this.attributes = {};
        this.listeners = {};
        this.classes = new Set();
        this.validationMessage = '';
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
            toggle: (name, enabled) => {
                if (enabled) this.classes.add(name);
                else this.classes.delete(name);
            }
        };
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setCustomValidity(message) { this.validationMessage = message; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    reportValidity() { return !this.validationMessage; }
    focus() { this.focused = true; }
    querySelectorAll() { return []; }
}

function harness(values = {}) {
    // A local calendar date makes these cases independent of when the tests run.
    class FixedDate extends Date {
        constructor(...args) {
            if (args.length) super(...args);
            else super(2026, 8, 23, 12, 0, 0);
        }
    }
    const defaults = {
        singleDepartment: 'section-1', singleStudentId: 'K-0001',
        singleFirstName: 'Test', singleLastName: 'Student',
        singleYearLevel: '2025-09-23', singleSection: 'female',
        singleEmail: 'student@example.test', editDepartment: 'section-1',
        editStudentUid: 'student-1', editStudentId: 'K-0001',
        editFirstName: 'Test', editLastName: 'Student',
        editYearLevel: '2025-09-23', editSection: 'female'
    };
    const nodes = new Map(Object.entries({ ...defaults, ...values })
        .map(([id, value]) => [id, new Element(id, value)]));
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, new Element(id));
        return nodes.get(id);
    };
    const alerts = [];
    const databaseCalls = [];
    const context = vm.createContext({
        Date: FixedDate,
        console: { log() {}, warn() {}, error() {} },
        document: { addEventListener() {}, getElementById: node },
        window: {},
        supabaseClient: {
            from(table) {
                databaseCalls.push(table);
                throw new Error('Unexpected database call during validation');
            }
        },
        captureAlert: message => alerts.push(message)
    });
    vm.runInContext(source, context, { filename: sourcePath });
    vm.runInContext(`
        activeSchoolYear = { id: 'school-year-1' };
        showImportAlert = captureAlert;
        renderPreview = () => {};
        showStep = () => {};
    `, context);
    return { context, node, alerts, databaseCalls };
}

function validImportRow(birthDate = '2025-09-23') {
    return {
        studId: 'K-0001', firstName: 'Test', lastName: 'Student',
        birthDate, gender: 'female', email: 'student@example.test',
        g1Phone: '09171234567', g1FirstName: 'Test', g1LastName: 'Guardian',
        g1Relationship: 'mother', g1Address: 'Test address'
    };
}

test('the first birthday is allowed and one day younger is rejected', () => {
    const { context } = harness();
    assert.equal(context.getLatestStudentBirthDate(), '2025-09-23');
    assert.equal(context.getStudentBirthDateError('2025-09-23'), '');
    assert.equal(context.getStudentBirthDateError('2012-06-14'), '');
    assert.notEqual(context.getStudentBirthDateError('2025-09-24'), '');
});

test('today, future birthdays, and infants are rejected', () => {
    const { context } = harness();
    for (const value of ['2026-09-23', '2026-09-24', '2030-01-01', '2026-03-23']) {
        assert.notEqual(context.getStudentBirthDateError(value), '', value);
    }
});

test('a birth date is required and must be a real ISO calendar date', () => {
    const { context } = harness();
    for (const value of ['', '   ', 'not-a-date', '2025-02-29', '2024-04-31',
        '2024-13-01', '2024-00-01', '2024-01-00', '0000-01-01',
        '01/02/2024', '2024-2-01', '2024-02-01T00:00:00Z']) {
        assert.notEqual(context.getStudentBirthDateError(value), '', JSON.stringify(value));
    }
    assert.equal(context.getStudentBirthDateError('2024-02-29'), '');
});

test('leap-day cutoffs do not roll forward to March 1', () => {
    const { context } = harness();
    const leapToday = new Date(2024, 1, 29, 12);
    assert.equal(context.getLatestStudentBirthDate(leapToday), '2023-02-28');
    assert.equal(context.getStudentBirthDateError('2023-02-28', leapToday), '');
    assert.notEqual(context.getStudentBirthDateError('2023-03-01', leapToday), '');
});

test('a February 29 birthday reaches the minimum age on March 1 in a non-leap year', () => {
    const { context } = harness();
    assert.notEqual(context.getStudentBirthDateError('2024-02-29', new Date(2025, 1, 28, 12)), '');
    assert.equal(context.getStudentBirthDateError('2024-02-29', new Date(2025, 2, 1, 12)), '');
});

test('the cutoff uses the local birthday at Manila midnight, not the preceding UTC date', () => {
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const vm = require('node:vm');
        const source = require('node:fs').readFileSync(process.argv[1], 'utf8');
        const context = vm.createContext({ document: { addEventListener() {} } });
        vm.runInContext(source, context);
        const today = new Date('2026-09-23T00:05:00+08:00');
        assert.equal(today.getDate(), 23);
        assert.equal(context.getLatestStudentBirthDate(today), '2025-09-23');
        assert.equal(context.getStudentBirthDateError('2025-09-23', today), '');
        assert.notEqual(context.getStudentBirthDateError('2025-09-24', today), '');
    `, sourcePath], {
        env: { ...process.env, TZ: 'Asia/Manila' }, encoding: 'utf8', windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('the date input restricts the picker and clears its error when corrected', () => {
    const app = harness({ singleYearLevel: '2026-09-23' });
    const input = app.node('singleYearLevel');
    app.context.updateStudentBirthDateInput(input);
    assert.equal(input.max, '2025-09-23');
    assert.notEqual(input.validationMessage, '');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.classList.contains('is-invalid'), true);

    input.value = '2025-09-23';
    app.context.updateStudentBirthDateInput(input);
    assert.equal(input.validationMessage, '');
    assert.notEqual(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.classList.contains('is-invalid'), false);
});

test('both registration and edit date pickers receive the cutoff and validation listeners', () => {
    const app = harness();
    app.context.setupStudentBirthDateValidation();
    for (const id of ['singleYearLevel', 'editYearLevel']) {
        const input = app.node(id);
        assert.equal(input.max, '2025-09-23');
        for (const name of ['input', 'change', 'focus']) {
            assert.equal(typeof input.listeners[name], 'function', `${id}: ${name}`);
        }
    }
});

test('bulk preview accepts the first birthday and marks missing or too-young birthdays as errors', () => {
    const { context } = harness();
    assert.equal(context.validateRow(validImportRow(), 0).status, 'ok');
    for (const value of ['', '2025-09-24', '2026-09-23', '2030-01-01', '2025-02-29']) {
        const row = context.validateRow(validImportRow(value), 0);
        assert.equal(row.status, 'error', value);
        assert.ok(row.errors.length > 0);
    }
});

test('Next remains on student details for a birthday below the minimum age', () => {
    const app = harness({ singleYearLevel: '2025-09-24' });
    app.node('studentFormStep').style.display = 'block';
    app.node('guardianFormStep').style.display = 'none';
    app.context.proceedToGuardianStep({ preventDefault() {} });
    assert.equal(app.node('studentFormStep').style.display, 'block');
    assert.equal(app.node('guardianFormStep').style.display, 'none');
    assert.ok(app.alerts.length > 0);
    assert.equal(app.databaseCalls.length, 0);
});

test('final single registration rechecks birth dates before contacting the database', async () => {
    for (const value of ['2025-09-24', '2026-09-23', '2030-01-01', '2025-02-29']) {
        const app = harness({ singleYearLevel: value });
        await app.context.submitSingleStudentForm({ preventDefault() {} });
        assert.equal(app.databaseCalls.length, 0, value);
        assert.ok(app.alerts.length > 0, value);
    }
});

test('editing a student cannot save a birthday below the minimum age', async () => {
    for (const value of ['2025-09-24', '2026-09-23', '2030-01-01', '2025-02-29']) {
        const app = harness({ editYearLevel: value });
        await app.context.submitEditStudentForm({ preventDefault() {} });
        assert.equal(app.databaseCalls.length, 0, value);
        assert.ok(app.alerts.length > 0, value);
    }
});

test('final import rechecks birthdays even if a row was previously marked valid', async () => {
    for (const value of ['', '2025-09-24', '2026-09-23', '2030-01-01', '2025-02-29']) {
        const app = harness();
        app.context.importFixture = { ...validImportRow(value), status: 'ok', errors: [], warnings: [] };
        vm.runInContext('parsedRows = [importFixture];', app.context);
        await app.context.startImport();
        assert.equal(app.databaseCalls.length, 0, value);
        assert.ok(app.alerts.length > 0, value);
    }
});
