'use strict';

let gateSettings = null;
let qrCamera = null;
let cameraStarting = false;
let cameraStopping = false;
let cameraStartTask = null;
let cameraStopTask = null;
let cameraSession = 0;
let qrDecodeBusy = false;
const seenCameraQrs = new Set();
let cameraRearmTimer = null;
const CAMERA_REARM_MS = 750;
let qrGunMode = false;
let qrGunSubmitTimer = null;
let requestBusy = false;
let pendingPerson = null;
const recordedAt = new Map();

function extractGateQrId(raw) {
    const text = String(raw || '').replace(/[\u2010-\u2015]/g, '-').trim();
    const uuidMatch = text.match(/student_uuid\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) return { id: `student_uuid:${uuidMatch[1].toLowerCase()}`, role: 'student' };
    const candidate = value => {
        const id = String(value || '').trim();
        const uuid = id.match(/^student_uuid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        if (uuid) return { id: `student_uuid:${uuid[1].toLowerCase()}`, role: 'student' };
        if (/^([Kk]|[1-9]|10)-\d{1,4}$/.test(id)) return { id, role: 'student' };
        if (/^EMP\d+$/i.test(id) || /^\d{9}$/.test(id)) return { id, role: 'employee' };
        return null;
    };
    let found = candidate(text);
    if (found) return found;

    if (text.startsWith('{')) {
        try {
            const object = JSON.parse(text);
            for (const key of ['stud_id', 'studentId', 'student_id', 'id_number', 'employee_id', 'emp_no', 'id']) {
                found = candidate(object[key]);
                if (found) return found;
            }
        } catch (_) { /* Not JSON; try the text below. */ }
    }

    if (/^https?:\/\//i.test(text)) {
        try {
            const url = new URL(text);
            for (const key of ['stud_id', 'studentId', 'student_id', 'id_number', 'employee_id', 'emp_no', 'id']) {
                found = candidate(url.searchParams.get(key));
                if (found) return found;
            }
            found = candidate(decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || ''));
            if (found) return found;
        } catch (_) { /* Try the patterns below. */ }
    }

    const student = text.match(/\b(?:K|k|10|[1-9])-\d{1,4}\b/);
    if (student) return candidate(student[0]);
    const employee = text.match(/\bEMP\d+\b|\b\d{9}\b/i);
    return employee ? candidate(employee[0]) : null;
}

function gateNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const part = key => parts.find(item => item.type === key).value;
    return { date: `${part('year')}-${part('month')}-${part('day')}`, clock: `${part('hour')}:${part('minute')}` };
}

function gateAcceptsScans() {
    if (!gateSettings) return false;
    if (gateSettings.enforceGateHours !== 'true') return true;
    const clock = gateNow().clock;
    return clock >= gateSettings.gateOpen && clock < gateSettings.gateClose;
}

function selectedRole() {
    return document.querySelector('input[name="personRole"]:checked').value;
}

function setRole(role) {
    document.querySelector(`input[name="personRole"][value="${role}"]`).checked = true;
    document.getElementById('idLabel').innerHTML = role === 'student'
        ? '<i class="fa-solid fa-id-card"></i> Student ID Number'
        : '<i class="fa-solid fa-id-card"></i> Employee Number';
    document.getElementById('personId').placeholder = role === 'student' ? 'e.g. K-001 or 10-1234' : 'Enter employee number';
    clearPreview();
}

function showStatus(message, type = '') {
    const el = document.getElementById('pageStatus');
    el.textContent = message;
    el.className = `page-status ${type}`;
}

function playScanBeep() {
    try {
        // Match the short Web Audio confirmation used by Event QR.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1850, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1850, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(1.0, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
        osc.onended = () => ctx.close();
    } catch (_) { /* Audio feedback must never prevent a gate record. */ }
}

function clearCameraRearmTimer() {
    if (cameraRearmTimer) clearTimeout(cameraRearmTimer);
    cameraRearmTimer = null;
}

function clearPreview() {
    pendingPerson = null;
    document.getElementById('previewCard').hidden = true;
    document.getElementById('confirmButton').disabled = true;
}

function personName(person) {
    return [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' ');
}

function personId(person, role) {
    return role === 'student' ? person.student_id : person.employee_id;
}

function movementFromLatest(autoExit, lastType) {
    return autoExit !== 'false' && lastType === 'entry' ? 'exit' : 'entry';
}

function buildGateLog(person, role, source, movement, now, timestamp, settings = gateSettings) {
    return {
        student_id: role === 'student' ? person.student_id : null,
        employee_id: role === 'employee' ? person.employee_id : null,
        log_type: movement,
        scan_method: source,
        log_date: now.date,
        log_timestamp: timestamp,
        is_late: role === 'student' && movement === 'entry' && now.clock >= settings.lateThreshold
    };
}

async function findPerson(id, role) {
    if (role === 'student') {
        const uuid = String(id).match(/^student_uuid:([0-9a-f-]{36})$/i);
        let query = supabaseClient.from('students')
            .select('student_id, stud_id, current_grade_level, first_name, middle_name, last_name, sections ( section_name )');
        query = uuid ? query.eq('student_id', uuid[1]) : query.eq('stud_id', id);
        const { data, error } = await query.limit(1);
        if (error) throw error;
        return data?.[0] || null;
    }
    const { data, error } = await supabaseClient.from('employees')
        .select('employee_id, emp_no, first_name, middle_name, last_name, faculty')
        .eq('emp_no', id).limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

async function nextMovement(person, role, now) {
    if (gateSettings.autoExit === 'false') return 'entry';
    const column = role === 'student' ? 'student_id' : 'employee_id';
    const { data, error } = await supabaseClient.from('entry_exit_logs')
        .select('log_type').eq(column, personId(person, role))
        .eq('log_date', now.date).order('log_timestamp', { ascending: false }).limit(1);
    if (error) throw error;
    return movementFromLatest(gateSettings.autoExit, data?.[0]?.log_type);
}

function renderPreview(person, role, movement, now) {
    document.getElementById('previewCard').hidden = false;
    document.getElementById('previewIcon').innerHTML = role === 'student'
        ? '<i class="fa-solid fa-user-graduate"></i>' : '<i class="fa-solid fa-user-tie"></i>';
    document.getElementById('previewName').textContent = personName(person);
    const section = Array.isArray(person.sections) ? person.sections[0] : person.sections;
    document.getElementById('previewMeta').textContent = role === 'student'
        ? [person.stud_id, person.current_grade_level, section?.section_name].filter(Boolean).join(' · ')
        : [person.emp_no, person.faculty].filter(Boolean).join(' · ');
    const late = role === 'student' && movement === 'entry' && now.clock >= gateSettings.lateThreshold;
    const message = `${movement === 'entry' ? 'Entry' : 'Exit'} ready to record${late ? ' · Late arrival' : ''}.`;
    const previewMessage = document.getElementById('previewMessage');
    previewMessage.textContent = message;
    previewMessage.className = '';
    document.getElementById('confirmButton').disabled = false;
}

async function prepareCheckIn(id, role, source, autoRecord = false) {
    if (requestBusy || !gateSettings) return;
    clearPreview();
    if (!id) return showStatus('Enter an ID or scan a QR code.', 'error');
    if (!gateAcceptsScans()) return showStatus('Gate scanner is outside its configured hours.', 'error');
    requestBusy = true;
    document.getElementById('lookupButton').disabled = true;
    showStatus('Looking up ID...');
    try {
        if (source === 'qr' && role === 'student' && !String(id).startsWith('student_uuid:')) {
            const { data: uuidRequired, error: rolloverError } = await supabaseClient
                .rpc('student_qr_uuid_required');
            if (rolloverError && rolloverError.code !== 'PGRST202') {
                throw rolloverError;
            }
            if (uuidRequired) {
                showStatus('This student QR code has expired after ID rollover. Ask for a reissued QR code.', 'error');
                return;
            }
        }
        const person = await findPerson(id, role);
        if (!person) {
            showStatus('ID not found. Check the selected role and ID.', 'error');
            return;
        }
        if (role === 'student' && /^student_uuid:/i.test(String(id))) {
            // The resolved record keeps its permanent UUID for movement and recording.
            // Show staff the readable ID after the UUID lookup has succeeded.
            document.getElementById('personId').value = person.stud_id || '';
        }
        const now = gateNow();
        const movement = await nextMovement(person, role, now);
        pendingPerson = { person, role, source };
        renderPreview(person, role, movement, now);
        showStatus('Identity found. Confirm to record gate attendance.');
    } catch (error) {
        console.error('[qrAttendance] Lookup failed:', error);
        showStatus('Could not look up this ID. Check the database connection.', 'error');
    } finally {
        requestBusy = false;
        document.getElementById('lookupButton').disabled = false;
    }
    if (autoRecord && pendingPerson) await recordCheckIn();
}

async function recordCheckIn() {
    if (requestBusy || !pendingPerson || !gateSettings) return;
    if (!gateAcceptsScans()) return showStatus('Gate scanner is outside its configured hours.', 'error');

    const { person, role, source } = pendingPerson;
    const key = `${role}:${personId(person, role)}`;
    const cooldownMs = Math.min(300, Math.max(1, Number(gateSettings.cooldown) || 10)) * 1000;
    const remaining = cooldownMs - (Date.now() - (recordedAt.get(key) || 0));
    if (remaining > 0) return showStatus(`Please wait ${Math.ceil(remaining / 1000)} seconds before scanning this person again.`, 'error');

    requestBusy = true;
    const button = document.getElementById('confirmButton');
    button.disabled = true;
    showStatus('Recording gate attendance...');
    try {
        const now = gateNow();
        const movement = await nextMovement(person, role, now);
        const log = buildGateLog(person, role, source, movement, now, new Date().toISOString());
        const { error } = await supabaseClient.from('entry_exit_logs').insert(log);
        if (error) throw error;
        recordedAt.set(key, Date.now());
        pendingPerson = null;
        if (source === 'qr') playScanBeep();
        const message = document.getElementById('previewMessage');
        message.textContent = `${movement === 'entry' ? 'Entry' : 'Exit'} recorded${log.is_late ? ' · Late arrival' : ''}.`;
        message.className = 'success';
        showStatus('Gate attendance saved successfully.', 'success');
        if (source === 'qr' && qrGunMode) {
            document.getElementById('personId').value = '';
            document.getElementById('personId').focus();
        }
    } catch (error) {
        console.error('[qrAttendance] Gate log failed:', error);
        showStatus('Could not save the gate log. Please try again.', 'error');
        button.disabled = false;
    } finally {
        requestBusy = false;
    }
}

function stopQrCamera() {
    if (cameraStopTask) return cameraStopTask;
    cameraStopTask = releaseQrCamera().finally(() => { cameraStopTask = null; });
    return cameraStopTask;
}

async function releaseQrCamera() {
    cameraSession++;
    cameraStopping = true;
    clearCameraRearmTimer();
    seenCameraQrs.clear();
    const button = document.getElementById('cameraButton');
    button.disabled = true;
    try {
        // A permission prompt can still be pending when QR Gun or navigation stops the camera.
        if (cameraStartTask) await cameraStartTask;
        const instance = qrCamera;
        qrCamera = null;
        if (instance) {
            try { await instance.stop(); } catch (_) { /* Camera may already be stopped. */ }
            try { await instance.clear(); } catch (_) { /* Clear only when supported. */ }
        }
    } finally {
        cameraStopping = false;
        button.disabled = !gateSettings || cameraStarting;
        document.getElementById('qrReader').hidden = true;
        button.classList.remove('camera-stop');
        button.innerHTML = '<i class="fa-solid fa-qrcode"></i> Scan QR';
    }
}

function startQrCamera() {
    if (cameraStartTask) return cameraStartTask;
    cameraStartTask = initializeQrCamera().finally(() => { cameraStartTask = null; });
    return cameraStartTask;
}

async function initializeQrCamera() {
    if (qrCamera || cameraStarting || cameraStopping || !gateSettings) return;
    if (!gateAcceptsScans()) return showStatus('Gate scanner is outside its configured hours.', 'error');
    if (typeof Html5Qrcode === 'undefined') return showStatus('QR scanner library is unavailable. Enter the ID instead.', 'error');
    if (qrGunMode) {
        qrGunMode = false;
        if (qrGunSubmitTimer) clearTimeout(qrGunSubmitTimer);
        qrGunSubmitTimer = null;
        document.getElementById('qrGunButton').setAttribute('aria-pressed', 'false');
    }
    const session = ++cameraSession;
    cameraStarting = true;
    seenCameraQrs.clear();
    clearCameraRearmTimer();
    const button = document.getElementById('cameraButton');
    button.disabled = true;
    document.getElementById('qrReader').hidden = false;
    showStatus('Starting QR camera...');
    const onDecode = async raw => {
        if (session !== cameraSession || qrDecodeBusy || requestBusy) return;
        clearCameraRearmTimer();
        const detected = extractGateQrId(raw);
        const scanKey = detected ? `${detected.role}:${detected.id}` : `invalid:${String(raw || '').trim()}`;
        if (seenCameraQrs.has(scanKey)) return;
        seenCameraQrs.add(scanKey);
        if (!detected) return showStatus('This QR code does not contain a supported student or employee ID.', 'error');
        qrDecodeBusy = true;
        try {
            setRole(detected.role);
            document.getElementById('personId').value = detected.id;
            await prepareCheckIn(detected.id, detected.role, 'qr', true);
        } finally { qrDecodeBusy = false; }
    };
    const onNoDecode = error => {
        if (session !== cameraSession) return;
        if (/NotReadable|track ended|device.*disconnect|video.*ended/i.test(String(error || ''))) {
            void stopQrCamera().then(() => showStatus('Camera Unavailable: The camera stopped. Reconnect it and use Scan QR to retry.', 'error'));
            return;
        }
        if (session !== cameraSession || qrDecodeBusy || !seenCameraQrs.size || cameraRearmTimer) return;
        cameraRearmTimer = setTimeout(() => {
            cameraRearmTimer = null;
            if (session === cameraSession) seenCameraQrs.clear();
        }, CAMERA_REARM_MS);
    };
    const config = { fps: 10, qrbox: { width: 240, height: 240 } };
    let started = false;
    let permissionDenied = false;
    let cameraError = null;
    let devices = [];
    try {
        if (typeof PreferredCamera !== 'undefined') devices = await PreferredCamera.listVideoInputs();
    } catch (error) {
        cameraError = error;
    }
    const candidates = cameraError ? [] : devices.length
        ? devices.map(device => ({ config: { deviceId: { exact: device.id } }, type: device.type }))
        : [{ config: { facingMode: 'environment' }, type: 'unknown' },
            { config: { facingMode: 'user' }, type: 'unknown' }];
    for (const candidate of candidates) {
        if (session !== cameraSession) break;
        let instance;
        try {
            instance = new Html5Qrcode('qrReader');
            await instance.start(candidate.config, config, onDecode, onNoDecode);
            if (session !== cameraSession) {
                try { await instance.stop(); } catch (_) { /* Navigation stopped startup. */ }
                try { await instance.clear(); } catch (_) { /* Nothing left to clear. */ }
                break;
            }
            qrCamera = instance;
            started = true;
            console.info(`[Entry/Exit QR] ${candidate.type} camera selected`);
            const video = document.getElementById('qrReader').querySelector?.('video');
            video?.srcObject?.getVideoTracks?.().forEach(track => track.addEventListener('ended', () => {
                if (session !== cameraSession || qrCamera !== instance) return;
                void stopQrCamera().then(() => showStatus('Camera Unavailable: The camera disconnected. Reconnect it and use Scan QR to retry.', 'error'));
            }, { once: true }));
            break;
        } catch (error) {
            if (instance) try { await instance.clear(); } catch (__) { /* Try the other camera. */ }
            if (/NOTALLOWED|PERMISSION|SECURITYERROR/i.test(`${error?.name || ''} ${error?.message || ''}`)) {
                permissionDenied = true;
                break;
            }
        }
    }
    cameraStarting = false;
    if (session !== cameraSession) {
        button.disabled = !gateSettings || cameraStopping;
        return;
    }
    button.disabled = false;
    if (started) {
        button.classList.add('camera-stop');
        button.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Camera';
        showStatus('Point the camera at a student QR code.');
    } else {
        document.getElementById('qrReader').hidden = true;
        const code = String(cameraError?.message || '');
        showStatus(permissionDenied || code === 'CAMERA_PERMISSION_DENIED'
            ? 'Camera Access Required: Allow camera access in browser settings, then use Scan QR to retry.'
            : code === 'NO_CAMERA_FOUND'
                ? 'Camera Required: Connect an external webcam or enable the built-in camera, then try again.'
                : 'Camera Unavailable: Check that a camera is connected and not in use, then try again.', 'error');
    }
}

function updateClock() {
    document.getElementById('liveClock').textContent = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'medium'
    }).format(new Date());
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', async () => {
    if (!window.gateRouteAuthorized) return;
    document.getElementById('footerYear').textContent = new Date().getFullYear();
    updateClock();
    window.setInterval(updateClock, 1000);

    document.querySelectorAll('input[name="personRole"]').forEach(input => input.addEventListener('change', () => {
        setRole(selectedRole());
        document.getElementById('personId').value = '';
    }));
    document.getElementById('lookupButton').addEventListener('click', () => {
        void prepareCheckIn(document.getElementById('personId').value.trim(), selectedRole(), qrGunMode ? 'qr' : 'manual');
    });
    document.getElementById('personId').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (qrGunSubmitTimer) clearTimeout(qrGunSubmitTimer);
        const raw = event.currentTarget.value.trim();
        const detected = qrGunMode ? extractGateQrId(raw) : null;
        if (qrGunMode && !detected) return showStatus('Waiting for a valid ID in the QR code.', 'error');
        if (detected) setRole(detected.role);
        void prepareCheckIn(detected?.id || raw, detected?.role || selectedRole(), qrGunMode ? 'qr' : 'manual', qrGunMode);
    });
    document.getElementById('personId').addEventListener('input', event => {
        if (qrGunSubmitTimer) clearTimeout(qrGunSubmitTimer);
        if (!qrGunMode) {
            // Typing a manual ID is a deliberate switch away from camera scanning.
            if (qrCamera || cameraStarting) void stopQrCamera().then(() => showStatus('Manual ID entry ready. Use Scan QR to return to the camera.'));
            return;
        }
        const detected = extractGateQrId(event.currentTarget.value);
        if (!detected) return;
        qrGunSubmitTimer = setTimeout(() => {
            qrGunSubmitTimer = null;
            if (requestBusy) return;
            setRole(detected.role);
            document.getElementById('personId').value = detected.id;
            void prepareCheckIn(detected.id, detected.role, 'qr', true);
        }, 350);
    });
    document.getElementById('qrGunButton').addEventListener('click', event => {
        qrGunMode = !qrGunMode;
        if (qrGunSubmitTimer) clearTimeout(qrGunSubmitTimer);
        event.currentTarget.setAttribute('aria-pressed', String(qrGunMode));
        if (qrGunMode) {
            void stopQrCamera().then(() => {
                if (qrGunMode) showStatus('QR gun ready. Scan into the ID field; Enter records the scan.');
            });
            document.getElementById('personId').focus();
        } else {
            // Wait for camera release before starting a new stream on the same preview element.
            void (async () => {
                if (cameraStopTask) await cameraStopTask;
                if (!qrGunMode) await startQrCamera();
            })();
        }
    });
    document.getElementById('cameraButton').addEventListener('click', () => {
        if (qrCamera) void stopQrCamera().then(() => showStatus('QR camera stopped. Use Scan QR to restart it.'));
        else void startQrCamera();
    });
    document.getElementById('confirmButton').addEventListener('click', () => void recordCheckIn());
    document.getElementById('againButton').addEventListener('click', () => {
        clearPreview();
        document.getElementById('personId').value = '';
        document.getElementById('personId').focus();
        showStatus('Ready for the next ID or QR code.');
    });
    window.addEventListener('pagehide', () => { void stopQrCamera(); });
    try {
        gateSettings = await AppSettings.load(supabaseClient, 'gate', { refresh: true });
        if (GateScanRoute.redirectIfPreferred(gateSettings, 'qr')) return;
        for (const id of ['personId', 'lookupButton', 'qrGunButton', 'cameraButton']) {
            document.getElementById(id).disabled = false;
        }
        // QR Camera is the default mode; a failed permission request leaves Scan QR usable for retry.
        void startQrCamera();
    } catch (error) {
        console.error('[qrAttendance] Gate settings unavailable:', error);
        showStatus('Gate settings could not be loaded. Check the connection before scanning.', 'error');
    }
});

if (typeof module !== 'undefined' && module.exports) module.exports = { extractGateQrId, movementFromLatest, buildGateLog };
