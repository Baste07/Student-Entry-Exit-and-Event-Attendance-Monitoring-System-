const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleRoot = path.resolve(__dirname, '..');

function loadFunction(relativePath, name, globals) {
    const source = fs.readFileSync(path.join(moduleRoot, relativePath), 'utf8');
    const declaration = source.match(new RegExp(`async function ${name}\\([^]*?^}`, 'm'));
    assert.ok(declaration, `${name} must exist in ${relativePath}`);
    const context = vm.createContext(globals);
    vm.runInContext(`${declaration[0]}\nglobalThis.subject = ${name};`, context);
    return context.subject;
}

function eventDeleteHarness(confirmed) {
    const writes = [];
    const deleteEvent = loadFunction('resc/js/events.js', 'deleteEvent', {
        pendingEventDeletes: new Set(),
        UIFeedback: { confirm: async () => confirmed, error: () => { throw new Error('Unexpected error dialog'); } },
        supabaseClient: {
            from(table) {
                return { delete() { return { async eq() { writes.push(table); return { error: null }; } }; } };
            }
        },
        loadEvents: async () => {},
        showToast: () => {},
        console
    });
    return { deleteEvent, writes };
}

test('canceling event deletion makes no database writes', async () => {
    const { deleteEvent, writes } = eventDeleteHarness(false);
    await deleteEvent(17, 'Science Fair');
    assert.deepEqual(writes, []);
});

test('concurrent event delete requests write once for the same event', async () => {
    const { deleteEvent, writes } = eventDeleteHarness(true);
    await Promise.all([deleteEvent(17, 'Science Fair'), deleteEvent(17, 'Science Fair')]);
    assert.deepEqual(writes, ['event_attendance', 'event_participants', 'events']);
});

test('duplicate report export waits for the answer', async () => {
    let answer = false;
    const checkDuplicateWarning = loadFunction('resc/js/attendanceGraphs.js', 'checkDuplicateWarning', {
        getGraphExportState: () => ({ reportName: 'today', dataString: 'same rows' }),
        existingReportsToday: [{ name: 'today', dataString: 'same rows' }],
        UIFeedback: { confirm: async () => answer }
    });
    assert.equal(await checkDuplicateWarning('PDF'), false);
    answer = true;
    assert.equal(await checkDuplicateWarning('PDF'), true);
});
