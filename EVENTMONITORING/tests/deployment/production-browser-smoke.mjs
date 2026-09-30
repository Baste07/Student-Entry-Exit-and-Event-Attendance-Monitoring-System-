// Headless, read-only page smoke test with one temporary synthetic Super Admin.
// Requires explicit guard; credentials stay in this process and are never logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

if (process.env.CONFIRM_PRODUCTION_BROWSER_SMOKE !== 'approved-20260927') {
    throw new Error('Production browser smoke-test guard is not set.');
}
const root = path.resolve('C:/xampp/htdocs/CAPSTONEFINAL');
const envText = fs.readFileSync(path.join(root, 'EVENTMONITORING/TimeInAndTimeOutMonitoring/students/.env'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_KEY)\s*=\s*(.*?)\s*$/);
    return match ? [match[1], match[2].replace(/^['"]|['"]$/g, '')] : [];
}).filter(pair => pair.length));
const projectUrl = env.SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;
if (projectUrl !== 'https://hgdqarcdfycdesavwrvq.supabase.co' || !serviceKey) {
    throw new Error('Production service configuration guard failed.');
}
const email = `codex-browser-${crypto.randomBytes(6).toString('hex')}@example.com`;
const password = crypto.randomBytes(24).toString('hex');
let userId;
let phpServer;
let chrome;
let socket;
let profileDir;
let sampleStudent;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(method, pathname, body) {
    const response = await fetch(projectUrl + pathname, {
        method,
        headers: {
            apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
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
            const firstLine = String(response.exceptionDetails.exception?.description
                || response.exceptionDetails.text || 'Unknown browser exception').split('\n')[0];
            throw new Error(`Browser evaluation failed: ${firstLine}`);
        }
        return response.result?.value;
    }
}

try {
    const studentResult = await api('GET',
        '/rest/v1/students?select=student_id,stud_id,current_grade_level&stud_id=eq.1-0016');
    if (studentResult.status !== 200 || studentResult.data?.length !== 1
        || studentResult.data[0].current_grade_level !== 'Grade 1') {
        throw new Error('Production Grade 1 sample is unavailable for read-only browser checks.');
    }
    sampleStudent = studentResult.data[0];
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

    const port = await freePort();
    phpServer = spawn('C:/xampp/php/php.exe', [
        '-S', `127.0.0.1:${port}`, '-t', 'C:/xampp/htdocs',
        path.join(root, 'EVENTMONITORING/tests/deployment/browser-smoke-router.php')
    ], { cwd: root, windowsHide: true, stdio: 'ignore' });
    const origin = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(origin + '/CAPSTONEFINAL/EVENTMONITORING/auth/login.html')).ok, 12000);

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prod-browser-'));
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

    const pages = [
        ['Super Admin System Settings', '/admin/system-settings.html',
            `(() => { const sms = document.getElementById('attendanceSmsToggle');
                const spoof = document.getElementById('antiSpoofToggle');
                const preview = document.getElementById('rolloverPreview');
                return !!sms && !sms.disabled && !sms.checked && !!spoof && spoof.checked
                    && document.getElementById('rolloverEndMonth')?.value === '03'
                    && document.getElementById('rolloverEndDay')?.value === '25'
                    && preview?.textContent.includes('Eligible students: 40')
                    && preview?.textContent.includes('2027-03-26'); })()`],
        ['Entry and Exit Settings', '/EntryExitMonitoring/admin/settings.html',
            `(() => { const sms = document.getElementById('gateSmsEnabled');
                return !!sms && sms.checked && !document.querySelector('.btn-save')?.disabled
                    && document.getElementById('gateSmsEffective')?.textContent.includes('Master SMS is off'); })()`],
        ['Event Settings', '/TimeInAndTimeOutMonitoring/admin/eventSettings.html',
            `(() => { const sms = document.getElementById('eventSmsEnabled');
                return !!sms && !sms.disabled && sms.checked
                    && document.getElementById('lateGraceMinutes')?.value === '15'
                    && document.getElementById('eventSmsStatus')?.textContent.includes('Master SMS is off'); })()`],
        ['Admin User Management', '/admin/usermanagement.html',
            `(() => { const body = document.getElementById('adminsTableBody');
                return !!body && body.textContent.includes(${JSON.stringify(email)}); })()`],
        ['Student Management', '/admin/student-import.html',
            `(() => typeof allStudents !== 'undefined' && allStudents.length === 40
                && !!document.getElementById('singleGradeLevel')
                && !!document.getElementById('editGradeLevel')
                && document.getElementById('allStudentsTableBody')?.textContent.includes('1-0016'))()`],
        ['Event participant selection', '/TimeInAndTimeOutMonitoring/admin/events.html',
            `(() => !!document.getElementById('eventForm')
                && !!document.getElementById('gradeOptionsList'))()`],
        ['Event attendance analytics', '/TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html',
            `(() => !!document.getElementById('trendGrade')
                && !!document.getElementById('trendSection'))()`],
        ['Entry and Exit student list', '/EntryExitMonitoring/admin/students.html',
            `(() => typeof allStudents !== 'undefined' && allStudents.length === 40
                && !!document.getElementById('gradeFilter'))()`],
        ['Entry and Exit reports', '/EntryExitMonitoring/admin/reports.html',
            `(() => !!document.getElementById('gradeFilter'))()`],
        ['Gate UUID QR lookup', '/EntryExitMonitoring/gate/qrAttendance.html?mode=qr',
            `(() => typeof findPerson === 'function'
                && !!document.getElementById('previewMeta'))()`]
    ];
    for (const [label, pathname, check] of pages) {
        const routePath = pathname.split('?')[0];
        await cdp.eval(`sessionStorage.setItem('allowed_admin_route', ${JSON.stringify('/CAPSTONEFINAL/EVENTMONITORING' + routePath)})`);
        await cdp.send('Page.navigate', { url: base + pathname });
        await until(async () => {
            const current = await cdp.eval('location.pathname');
            return current.endsWith(routePath) && await cdp.eval(check);
        }, 45000);
        console.log(`PASS: ${label} loaded expected controls and data`);
        if (routePath === '/admin/student-import.html') {
            const filtered = await cdp.eval(`(() => {
                const grade = document.getElementById('studentDeptFilter');
                grade.value = 'Grade 1'; renderAllStudentsTable();
                const count = Number(document.getElementById('allStudentsCount').textContent);
                return count === 40
                    && document.getElementById('allStudentsTableBody').textContent.includes('1-0016')
                    && currentGradeFromStudentId('1-0016') === 'Grade 1';
            })()`);
            if (!filtered) throw new Error('Production student Grade 1 filter or registration grade failed.');
            console.log('PASS: Student list, Grade 1 filter and registration ID grade');
        }
        if (routePath === '/TimeInAndTimeOutMonitoring/admin/events.html') {
            await until(() => cdp.eval('typeof supabaseClient !== "undefined" && !!supabaseClient'));
            const targets = await cdp.eval(`(async () => {
                const { data, error } = await supabaseClient.from('students')
                    .select('student_id,stud_id,current_grade_level')
                    .eq('current_grade_level','Grade 1').eq('status','active');
                return !error && data?.length === 40
                    && data.some(student => student.stud_id === '1-0016');
            })()`);
            if (!targets) throw new Error('Production Event Grade 1 targeting query failed.');
            console.log('PASS: Event Grade 1 targeting includes the section-mismatch student');
        }
        if (routePath === '/TimeInAndTimeOutMonitoring/admin/eventAttendanceTrends.html') {
            await until(() => cdp.eval(`(() => {
                const grades = [...document.getElementById('trendGrade').options]
                    .map(option => option.value);
                return document.getElementById('trendLoading').hidden
                    && document.getElementById('trendError').hidden
                    && grades.includes('Grade 1');
            })()`), 35000);
            console.log('PASS: Event analytics loaded actual Grade 1 participant data');
        }
        if (routePath === '/EntryExitMonitoring/admin/students.html') {
            const filtered = await cdp.eval(`(() => {
                const grade = document.getElementById('gradeFilter');
                grade.value = 'Grade 1'; applyFilters();
                return allStudents.every(student => student.current_grade_level === 'Grade 1')
                    && document.getElementById('studentsTableBody')?.textContent.includes('1-0016');
            })()`);
            if (!filtered) throw new Error('Production Gate student grade filter failed.');
            console.log('PASS: Entry and Exit students show authoritative Grade 1');
        }
        if (routePath === '/EntryExitMonitoring/admin/reports.html') {
            await until(() => cdp.eval('typeof generateGateAnalyticsReport === "function"'));
            const report = await cdp.eval(`(async () => {
                document.getElementById('reportFrom').value = '2026-08-17';
                document.getElementById('reportTo').value = '2026-09-25';
                await generateGateAnalyticsReport();
                const grades = [...document.getElementById('gradeFilter').options]
                    .map(option => option.value);
                return gateAnalyticsSource.length > 0
                    && grades.includes('Grade 1')
                    && !document.getElementById('gateAnalyticsPanel').hidden;
            })()`);
            if (!report) throw new Error('Production Gate analytics did not load Grade 1 records.');
            console.log('PASS: Entry and Exit analytics loaded actual Grade 1 gate records');
        }
        if (routePath === '/EntryExitMonitoring/gate/qrAttendance.html') {
            await until(() => cdp.eval('typeof gateSettings !== "undefined" && gateSettings !== null'));
            const lookup = await cdp.eval(`(async () => {
                const payload = 'student_uuid:${sampleStudent.student_id}';
                const parsed = extractGateQrId(payload);
                if (parsed?.role !== 'student') return false;
                const person = await findPerson(parsed.id, 'student');
                if (person?.student_id !== ${JSON.stringify(sampleStudent.student_id)}
                    || person?.stud_id !== '1-0016'
                    || person?.current_grade_level !== 'Grade 1') return false;
                renderPreview(person, 'student', 'entry', {clock:'07:00'});
                return document.getElementById('previewMeta').textContent.includes('Grade 1');
            })()`);
            if (!lookup) throw new Error('Authenticated production UUID QR lookup failed.');
            console.log('PASS: Authenticated UUID QR lookup and current-grade label');
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
