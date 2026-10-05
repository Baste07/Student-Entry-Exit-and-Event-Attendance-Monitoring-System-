// Development-only headless page wiring smoke test. The development fixture has
// no full Event/guardian schema, so data-backed workflows are tested separately.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

if (process.env.CONFIRM_DEVELOPMENT_BROWSER_SMOKE !== 'ehyqvyglirirktfmdezq') {
    throw new Error('Development browser smoke-test guard is not set.');
}
const root = path.resolve('C:/xampp/htdocs/CAPSTONEFINAL');
const projectUrl = 'https://ehyqvyglirirktfmdezq.supabase.co';
const localEnv = path.join(root, '.env.development.local');
if (!fs.existsSync(localEnv)) throw new Error('Ignored Development environment file is required.');
process.loadEnvFile(localEnv);
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.WEB_SUPABASE_ANON_KEY;
if (process.env.SUPABASE_URL !== projectUrl ||
    !serviceKey?.startsWith('sb_secret_') || !anonKey?.startsWith('sb_publishable_')) {
    throw new Error('Development URL, public key, and server secret must match the Development-only configuration.');
}
const email = `codex-browser-${crypto.randomBytes(6).toString('hex')}@example.com`;
const password = crypto.randomBytes(24).toString('hex');
let userId;
let phpServer;
let chrome;
let socket;
let profileDir;
let fixtureYear;
let fixtureSection;
let fixtureStudent;
let fixtureStudId;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function totp(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const letter of secret.toUpperCase().replace(/=+$/, '')) {
        const value = alphabet.indexOf(letter);
        if (value < 0) throw new Error('Development test authenticator has invalid encoding.');
        bits += value.toString(2).padStart(5, '0');
    }
    const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => Number.parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
async function api(method, pathname, body) {
    const response = await fetch(projectUrl + pathname, {
        method,
        headers: {
            apikey: serviceKey,
            'Content-Type': 'application/json', Accept: 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data };
}
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function until(check, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (await check()) return; } catch { /* waiting for page readiness */ }
        await sleep(400);
    }
    throw new Error('Browser page did not become ready in time.');
}
class CDP {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (!message.id) return;
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            message.error ? pending.reject(new Error('Browser command failed.')) : pending.resolve(message.result);
        });
    }
    send(method, params = {}) {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const response = await this.send('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true
        });
        if (response.exceptionDetails) {
            const reason = String(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
                .split('\n')[0];
            throw new Error(`Browser evaluation failed: ${reason}`);
        }
        return response.result?.value;
    }
}

try {
    const created = await api('POST', '/auth/v1/admin/users', {
        email, password, email_confirm: true
    });
    if (created.status < 200 || created.status >= 300 || !created.data?.id) {
        throw new Error('Could not create browser smoke-test Auth user.');
    }
    userId = created.data.id;
    const profile = await api('POST', '/rest/v1/admins', {
        admin_id: userId, email, password: 'AUTH_MANAGED',
        admin_name: 'Codex Browser Smoke', faculty: 'TEST',
        admin_level: 'super_admin', status: 'active'
    });
    if (profile.status < 200 || profile.status >= 300) {
        throw new Error('Could not create browser smoke-test profile.');
    }
    fixtureYear = crypto.randomUUID();
    fixtureSection = crypto.randomUUID();
    fixtureStudent = crypto.randomUUID();
    fixtureStudId = `2-${crypto.randomInt(9000, 9999)}`;
    for (const [table, record] of [
        ['school_years', { id: fixtureYear, name: `Browser fixture ${fixtureYear}`,
            start_date: '2025-06-01', end_date: '2026-03-25', is_active: false }],
        ['sections', { section_id: fixtureSection, grade_level: 'Grade 1',
            section_name: 'Persistent A', school_year_id: fixtureYear }],
        ['students', { student_id: fixtureStudent, stud_id: fixtureStudId,
            first_name: 'BrowserGradeFixture', last_name: 'Student',
            current_grade_level: 'Grade 2', section_id: fixtureSection,
            school_year_id: fixtureYear, status: 'active' }]
    ]) {
        const inserted = await api('POST', `/rest/v1/${table}`, record);
        if (inserted.status < 200 || inserted.status >= 300) {
            throw new Error(`Could not create development ${table} browser fixture.`);
        }
    }

    const port = await freePort();
    phpServer = spawn('C:/xampp/php/php.exe', [
        '-S', `127.0.0.1:${port}`, '-t', 'C:/xampp/htdocs',
        path.join(root, 'EVENTMONITORING/tests/deployment/development-browser-router.php')
    ], { cwd: root, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, DEV_SUPABASE_ANON_KEY: anonKey } });
    const origin = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(origin + '/CAPSTONEFINAL/EVENTMONITORING/auth/login.html')).ok, 12000);

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dev-browser-'));
    chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', 'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 15000);
    const debugPort = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,
        { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const base = `${origin}/CAPSTONEFINAL/EVENTMONITORING`;
    await cdp.send('Page.navigate', { url: `${base}/auth/login.html` });
    await until(async () => cdp.eval('typeof supabaseClient !== "undefined" && !!supabaseClient.auth?.signInWithPassword'));
    const loggedIn = await cdp.eval(`(async () => {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)}
        });
        if (error || !data?.user?.id) return false;
        sessionStorage.setItem('user', JSON.stringify({
            id: data.user.id, email: ${JSON.stringify(email)},
            userType: 'admin', adminLevel: 'super_admin', role: 'super_admin',
            lastName: 'Codex Browser Smoke', loginTime: new Date().toISOString()
        }));
        return data.user.id === ${JSON.stringify(userId)};
    })()`);
    if (!loggedIn) throw new Error('Headless browser Auth login failed.');
    console.log('PASS: Browser Supabase Auth session established');
    const factor = await cdp.eval(`(async () => {
        const { data, error } = await supabaseClient.auth.mfa.enroll({ factorType: 'totp' });
        return error ? null : { id: data?.id, secret: data?.totp?.secret };
    })()`);
    if (!factor?.id || !factor.secret) throw new Error('Development test authenticator enrollment failed.');
    const verified = await cdp.eval(`(async () => {
        const { error } = await supabaseClient.auth.mfa.challengeAndVerify({
            factorId: ${JSON.stringify(factor.id)}, code: ${JSON.stringify(totp(factor.secret))}
        });
        if (error) return false;
        const assurance = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
        return assurance.data?.currentLevel === 'aal2';
    })()`);
    if (!verified) throw new Error('Development test authenticator verification failed.');
    console.log('PASS: Browser Supabase Auth session reached AAL2');

    const pages = [
        ['Super Admin System Settings', '/admin/system-settings.html',
            `(() => { const sms = document.getElementById('attendanceSmsToggle');
                const spoof = document.getElementById('antiSpoofToggle');
                return !!sms && !sms.disabled && !!spoof; })()`],
        ['Student registration/import/edit controls', '/admin/student-import.html',
            `(() => !!document.getElementById('singleStudentForm')
                && !!document.getElementById('editStudentForm')
                && !!document.getElementById('studentSearchInput'))()`],
        ['Event participant controls', '/TimeInAndTimeOutMonitoring/admin/events.html',
            `(() => !!document.getElementById('eventForm')
                && !!document.getElementById('gradeOptionsList'))()`],
        ['Event analytics filters', '/TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html',
            `(() => !!document.getElementById('trendGrade')
                && !!document.getElementById('trendSection'))()`],
        ['Entry and Exit analytics filters', '/EntryExitMonitoring/admin/reports.html',
            `(() => !!document.getElementById('gradeFilter'))()`],
        ['Entry and Exit student grade filter', '/EntryExitMonitoring/admin/students.html',
            `(() => !!document.getElementById('gradeFilter'))()`],
        ['Gate UUID QR lookup', '/EntryExitMonitoring/gate/qrAttendance.html?mode=qr',
            `(() => !!document.getElementById('personId') && !!document.getElementById('previewMeta'))()`]
    ];
    for (const [label, pathname, check] of pages) {
        const routePath = pathname.split('?')[0];
        await cdp.eval(`sessionStorage.setItem('allowed_admin_route', ${JSON.stringify('/CAPSTONEFINAL/EVENTMONITORING' + routePath)})`);
        await cdp.send('Page.navigate', { url: base + pathname });
        await until(async () => {
            const current = await cdp.eval('location.pathname');
            return current.endsWith(routePath) && await cdp.eval(check);
        }, 25000);
        console.log(`PASS: ${label} rendered expected controls`);
        if (pathname === '/admin/student-import.html') {
            await until(() => cdp.eval('typeof populateStudentsFilterOptions === "function" && typeof renderAllStudentsTable === "function"'));
            const gradesWork = await cdp.eval(`(() => {
                allStudents = [
                    {student_id:'a', stud_id:'1-0016', first_name:'One', last_name:'Fixture',
                     current_grade_level:'Grade 1', sections:{section_name:'Persistent A'}, status:'active'},
                    {student_id:'b', stud_id:'2-0001', first_name:'Two', last_name:'Fixture',
                     current_grade_level:'Grade 2', sections:{section_name:'Persistent A'}, status:'active'}
                ];
                populateStudentsFilterOptions();
                const grade=document.getElementById('studentDeptFilter');
                const body=document.getElementById('allStudentsTableBody');
                grade.value='Grade 1'; renderAllStudentsTable();
                const first=body.textContent.includes('1-0016') && !body.textContent.includes('2-0001');
                grade.value='Grade 2'; renderAllStudentsTable();
                return first && body.textContent.includes('2-0001') && !body.textContent.includes('1-0016');
            })()`);
            if (!gradesWork) throw new Error('Student Import Grade 1/2 browser filtering failed.');
            console.log('PASS: Student Import browser Grade 1/2 filtering uses student grade');
        }
        if (pathname === '/EntryExitMonitoring/admin/students.html') {
            await until(() => cdp.eval('typeof applyFilters === "function" && typeof renderTable === "function"'));
            const gradesWork = await cdp.eval(`(() => {
                allSections=[{section_id:'persistent-a',section_name:'Persistent A',grade_level:'Grade 4'}];
                allStudents=[
                    {student_id:'a',stud_id:'1-0016',first_name:'One',last_name:'Fixture',
                     current_grade_level:'Grade 1',section_id:'persistent-a',status:'active',has_face_images:false},
                    {student_id:'b',stud_id:'2-0001',first_name:'Two',last_name:'Fixture',
                     current_grade_level:'Grade 2',section_id:'persistent-a',status:'active',has_face_images:false}
                ];
                const grade=document.getElementById('gradeFilter');
                grade.innerHTML='<option value="Grade 1">Grade 1</option><option value="Grade 2">Grade 2</option>';
                const body=document.getElementById('studentsTableBody');
                grade.value='Grade 1'; applyFilters();
                const first=body.textContent.includes('1-0016') && !body.textContent.includes('2-0001');
                grade.value='Grade 2'; applyFilters();
                return first && body.textContent.includes('2-0001') && !body.textContent.includes('1-0016');
            })()`);
            if (!gradesWork) throw new Error('Entry and Exit student Grade 1/2 browser filtering failed.');
            console.log('PASS: Entry and Exit student browser Grade 1/2 filtering ignores section grade');
        }
        if (pathname.startsWith('/EntryExitMonitoring/gate/qrAttendance.html')) {
            await until(() => cdp.eval('typeof findPerson === "function" && gateSettings !== null'));
            const lookupWorks = await cdp.eval(`(async () => {
                const parsed=extractGateQrId('student_uuid:${fixtureStudent}');
                if (parsed?.role!=='student') return false;
                const person=await findPerson(parsed.id,'student');
                if (person?.student_id!==${JSON.stringify(fixtureStudent)}
                    || person?.stud_id!==${JSON.stringify(fixtureStudId)}
                    || person?.current_grade_level!=='Grade 2') return false;
                renderPreview(person,'student','entry',{clock:'07:00'});
                const label=document.getElementById('previewMeta').textContent;
                return label.includes('Grade 2') && label.includes('Persistent A')
                    && !label.includes('Grade 1');
            })()`);
            if (!lookupWorks) throw new Error('Authenticated UUID QR lookup or grade display failed.');
            console.log('PASS: Authenticated UUID QR lookup and Grade 2 label with Grade 1 section');
        }
    }
} finally {
    socket?.close();
    chrome?.kill();
    phpServer?.kill();
    if (profileDir) {
        const resolved = path.resolve(profileDir);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot)) throw new Error('Browser profile cleanup path escaped temp directory.');
        try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked Chrome files may clear after exit */ }
    }
    if (fixtureStudent) {
        const present = await api('GET', `/rest/v1/students?student_id=eq.${fixtureStudent}&select=student_id,first_name`);
        if (present.status === 200 && present.data?.length) {
            if (present.data[0].first_name !== 'BrowserGradeFixture') throw new Error('Browser student cleanup guard failed.');
            const removed = await api('DELETE', `/rest/v1/students?student_id=eq.${fixtureStudent}`);
            if (removed.status < 200 || removed.status >= 300) throw new Error('Browser student cleanup failed.');
        }
    }
    if (fixtureSection) {
        const removed = await api('DELETE', `/rest/v1/sections?section_id=eq.${fixtureSection}`);
        if (removed.status < 200 || removed.status >= 300) throw new Error('Browser section cleanup failed.');
    }
    if (fixtureYear) {
        const removed = await api('DELETE', `/rest/v1/school_years?id=eq.${fixtureYear}`);
        if (removed.status < 200 || removed.status >= 300) throw new Error('Browser school-year cleanup failed.');
    }
    if (userId) {
        const current = await api('GET', `/rest/v1/admins?admin_id=eq.${userId}&select=admin_id,email`);
        if (current.status === 200 && current.data?.length) {
            if (current.data[0].email !== email) throw new Error('Browser test profile cleanup guard failed.');
            const removed = await api('DELETE', `/rest/v1/admins?admin_id=eq.${userId}`);
            if (removed.status < 200 || removed.status >= 300) throw new Error('Browser test profile cleanup failed.');
        }
        const auth = await api('GET', `/auth/v1/admin/users/${userId}`);
        if (auth.status === 200) {
            if (auth.data?.email !== email) throw new Error('Browser test Auth cleanup guard failed.');
            const removed = await api('DELETE', `/auth/v1/admin/users/${userId}`, { should_soft_delete: false });
            if (removed.status < 200 || removed.status >= 300) throw new Error('Browser test Auth cleanup failed.');
        }
        console.log('PASS: Browser test account removed');
    }
}
