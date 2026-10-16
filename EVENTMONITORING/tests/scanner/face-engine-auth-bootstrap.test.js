const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const eventPage = read('TimeInAndTimeOutMonitoring/students/takeAttendance.html');
const gatePage = read('EntryExitMonitoring/gate/entryExitScanner.html');
const eventScript = read('TimeInAndTimeOutMonitoring/resc/js/takeAttendance.js').replace(/\r\n/g, '\n');
const gateScript = read('EntryExitMonitoring/resc/js/entryExitScanner.js');
const configScript = read('config/config.js');

function scriptSources(html) {
    return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
}

test('both Face pages load Supabase and the shared AAL2 helper before engine controls', () => {
    for (const [page, control] of [[eventPage, 'takeAttendance.js'], [gatePage, 'entryExitScanner.js']]) {
        const sources = scriptSources(page);
        const supabase = sources.findIndex(source => source.includes('@supabase/supabase-js'));
        const browserConfig = sources.indexOf('../../config/.env.js');
        const helper = sources.indexOf('../../config/config.js');
        const controls = sources.findIndex(source => source.includes(control));
        assert.ok(supabase >= 0 && supabase < browserConfig && browserConfig < helper && helper < controls);
        assert.match(configScript, /async function adminAal2Fetch\(/);
    }
});

function authPage(session) {
    const requests = [];
    const context = vm.createContext({
        ENV: { SUPABASE_PROJECT_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'fixture-public-key' },
        supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session }, error: null }) } }) },
        Headers,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true };
        },
        console,
    });
    vm.runInContext(configScript, context);
    return { context, requests };
}

test('Event Face Start Engine uses the loaded AAL2 helper and sends its bearer to the PHP bridge', async () => {
    const marker = "bootEngineBtn.addEventListener('click', async () => {";
    const start = eventScript.indexOf(marker);
    const end = eventScript.indexOf('\n});\n\nasync function stopEngine', start);
    assert.ok(start >= 0 && end > start, 'actual Start Engine handler is found');
    const startHandler = eventScript.slice(start, end + '\n});'.length);

    for (const [session, expectedRequests] of [
        [{ access_token: 'fixture-user-token' }, 1],
        [null, 0],
    ]) {
        const { context, requests } = authPage(session);
        let click;
        const output = [];
        context.bootEngineBtn = {
            style: {}, disabled: false, innerHTML: '',
            addEventListener: (name, callback) => {
                assert.equal(name, 'click');
                click = callback;
            },
        };
        context.stopEngineBtn = { style: {} };
        context.renderStripStatus = () => {};
        context.renderTileStates = () => {};
        context.updateSessionButtonState = () => {};
        context.setOutput = (...args) => output.push(args);
        context.waitForFlask = async () => {};
        vm.runInContext(startHandler, context);
        await click();
        assert.equal(requests.length, expectedRequests);
        if (session) {
            assert.equal(requests[0].url, 'trigger_attendance.php');
            assert.equal(requests[0].options.method, 'POST');
            assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer fixture-user-token');
        } else {
            assert.ok(output.some(([, , message]) => /Sign in is required/.test(message)));
        }
    }
});

test('both Face engine control scripts retain AAL2 requests for start, stop, and scanner controls', () => {
    assert.match(eventScript, /adminAal2Fetch\('trigger_attendance\.php', \{ method: 'POST' \}\)/);
    assert.match(eventScript, /adminAal2Fetch\('http:\/\/127\.0\.0\.1:5000\/shutdown', \{ method: 'POST' \}\)/);
    assert.match(eventScript, /adminAal2Fetch\('http:\/\/127\.0\.0\.1:5000\/scanner_mode'/);
    assert.match(gateScript, /adminAal2Fetch\(ATTENDANCE_TRIGGER_URL, \{ method: 'POST' \}\)/);
    assert.match(gateScript, /adminAal2Fetch\(`\$\{FLASK_BASE\}\/shutdown`, \{ method: 'POST' \}\)/);
    assert.match(gateScript, /adminAal2Fetch\(`\$\{FLASK_BASE\}\/scanner_mode`/);
});
