const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../admin/student-import.js'), 'utf8');
const code = source.slice(source.indexOf('async function confirmDeleteStudent()'), source.indexOf('function showStep('));
function harness(rpc) {
    const alerts = [], button = {}, calls = [];
    const ctx = { pendingDeleteStudentId: '1-9999', studentDeletionInProgress: false,
        allStudents: [{ stud_id: '1-9999', student_id: 'uuid-a' }],
        document: { getElementById: () => button }, console: { error() {} },
        supabaseClient: { rpc: async (...args) => { calls.push(args); return rpc(); } },
        deleteStudentModal: { hide() {} }, loadAllStudentsTable: async () => {},
        showImportAlert: (...args) => alerts.push(args) };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    return { ctx, alerts, button, calls };
}
test('one UUID RPC, list refresh, accurate success, and duplicate-click barrier', async () => {
    let finish;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    let refreshed = 0; h.ctx.loadAllStudentsTable = async () => refreshed++;
    const first = h.ctx.confirmDeleteStudent();
    await h.ctx.confirmDeleteStudent();
    assert.equal(h.calls.length, 1); assert.equal(h.button.disabled, true);
    assert.equal(h.calls[0][0], 'delete_student'); assert.equal(h.calls[0][1].p_student_id, 'uuid-a');
    finish({ data: { deleted: true, student_id: 'uuid-a' }, error: null }); await first;
    assert.equal(refreshed, 1); assert.equal(h.ctx.allStudents.length, 0);
    assert.equal(h.alerts[0][1], 'success'); assert.equal(h.ctx.pendingDeleteStudentId, null);
    assert.equal(h.button.disabled, false);
});
test('database error keeps selection for retry and never reports success', async () => {
    const h = harness(() => ({ error: { message: 'Permission denied' } }));
    await h.ctx.confirmDeleteStudent();
    assert.equal(h.ctx.pendingDeleteStudentId, '1-9999'); assert.equal(h.ctx.allStudents.length, 1);
    assert.equal(h.alerts[0][1], 'danger'); assert.match(h.alerts[0][0], /Permission denied/);
    assert.equal(h.button.disabled, false);
});
test('missing UUID and malformed server results fail safely', async () => {
    const h = harness(() => ({ data: null }));
    await h.ctx.confirmDeleteStudent(); assert.equal(h.alerts[0][1], 'danger');
    h.ctx.allStudents = []; await h.ctx.confirmDeleteStudent(); assert.equal(h.calls.length, 1);
});
test('repeated request refreshes with already-deleted message', async () => {
    const h = harness(() => ({ data: { deleted: false, student_id: 'uuid-a' } }));
    await h.ctx.confirmDeleteStudent(); assert.match(h.alerts[0][0], /already deleted/);
});
test('a failed list refresh reports the committed deletion accurately', async () => {
    const h = harness(() => ({ data: { deleted: true, student_id: 'uuid-a' } }));
    h.ctx.loadAllStudentsTable = async () => false;
    await h.ctx.confirmDeleteStudent();
    assert.equal(h.alerts.at(-1)[1], 'warning');
    assert.match(h.alerts.at(-1)[0], /is deleted, but the list could not be refreshed/);
});
