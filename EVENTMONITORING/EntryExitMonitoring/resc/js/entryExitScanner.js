'use strict';

/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
const FLASK_BASE          = 'http://127.0.0.1:5000';
const ENGINE_STATUS_URL   = `${FLASK_BASE}/engine_status`;
const VIDEO_FEED_URL      = `${FLASK_BASE}/video_feed`;
const ATTENDEE_STREAM_URL = `${FLASK_BASE}/attendee_stream`;
const ATTENDANCE_TRIGGER_URL = 'http://localhost/CAPSTONEFINAL/EVENTMONITORING/TimeInAndTimeOutMonitoring/students/trigger_attendance.php';
const OVERLAY_DISMISS_MS  = 5000; // auto-dismiss overlays after 5s

/* ══════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════ */
let currentMode   = 'face';
let qrScanner     = null;
let sseSource     = null;
let engineOnline  = false;
let cooldownMap   = {};
let COOLDOWN_MS   = 10000;
let AUTO_EXIT     = true;
let GATE_SETTINGS = {};
let overlayTimer  = null; // shared dismiss timer

/* ══════════════════════════════════════════════════
   CLOCK
══════════════════════════════════════════════════ */
(function tick() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    let h = now.getHours(),
        mm = String(now.getMinutes()).padStart(2, '0'),
        ss = String(now.getSeconds()).padStart(2, '0'),
        ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const el = document.getElementById('gateClock');
    if (el) el.textContent = `${h}:${mm}:${ss} ${ap}`;
    setTimeout(tick, 1000);
})();

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    await loadGateSettings();
    checkEngineStatus();
    setInterval(checkEngineStatus, 10000);
});

async function loadGateSettings() {
    try {
        const { data } = await supabaseClient.from('gate_settings').select('key,value');
        (data || []).forEach(r => { GATE_SETTINGS[r.key] = r.value; });
        COOLDOWN_MS = (parseInt(GATE_SETTINGS.cooldown, 10) || 10) * 1000;
        AUTO_EXIT   = GATE_SETTINGS.autoExit !== 'false';
    } catch (_) { /* use defaults */ }
}

/* ══════════════════════════════════════════════════
   ENGINE STATUS
══════════════════════════════════════════════════ */
async function checkEngineStatus() {
    try {
        const res = await fetch(ENGINE_STATUS_URL, { signal: AbortSignal.timeout(3000) });
        setEngineStatus(res.ok);
    } catch (_) {
        setEngineStatus(false);
    }
}

function setEngineStatus(online) {
    engineOnline = online;
    const pill        = document.getElementById('enginePill');
    const engineState = document.getElementById('engineState');
    const stripStatus = document.getElementById('stripStatus');
    const startEngineButton = document.getElementById('btnStartEngine');

    if (online) {
        if (startEngineButton) startEngineButton.style.display = 'none';
        pill.className = 'engine-pill online';
        pill.innerHTML = '<i class="fa-solid fa-circle"></i> Face Engine Online';
        if (engineState) engineState.textContent = 'Online';
        if (stripStatus) stripStatus.innerHTML   = '<span class="pulse"></span> Online';
    } else {
        if (startEngineButton) startEngineButton.style.display = 'inline-flex';
        pill.className = 'engine-pill offline';
        pill.innerHTML = '<i class="fa-solid fa-circle"></i> Face Engine Offline — run START_ATTENDANCE.bat';
        if (engineState) engineState.textContent = 'Offline';
        if (stripStatus) stripStatus.textContent = 'Offline';
    }
}

/* ══════════════════════════════════════════════════
   MODE SWITCH
══════════════════════════════════════════════════ */
function switchMode(mode) {
    stopScanner();
    currentMode = mode;

    document.getElementById('faceMode').style.display = mode === 'face' ? 'block' : 'none';
    document.getElementById('qrMode').style.display   = mode === 'qr'   ? 'block' : 'none';
    document.getElementById('tabFace').classList.toggle('active', mode === 'face');
    document.getElementById('tabQR').classList.toggle('active',   mode === 'qr');
    document.getElementById('resultStrip').classList.remove('show');

    const pill = document.getElementById('enginePill');
    if (pill) pill.style.display = mode === 'face' ? 'inline-flex' : 'none';

    const tileMode = document.getElementById('tileMode');
    if (tileMode) {
        tileMode.innerHTML = mode === 'face'
            ? '<i class="fa-solid fa-face-smile"></i> Face Recognition'
            : '<i class="fa-solid fa-qrcode"></i> QR Code';
    }
}

/* ══════════════════════════════════════════════════
   START / STOP
══════════════════════════════════════════════════ */
async function startScanner() {
    if (currentMode === 'face' && !engineOnline) {
        const started = await startAttendanceEngine();
        if (!started) return;
    }

    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display  = 'flex';
    const scannerState = document.getElementById('scannerState');
    if (scannerState) scannerState.textContent = 'Active';

    if (currentMode === 'face') startFaceMode();
    else                        startQRMode();
}

function startEngine() {
    if (engineOnline) return;
    startAttendanceEngine();
}

async function startAttendanceEngine() {
    const startButton = document.getElementById('btnStartEngine');
    const scannerState = document.getElementById('scannerState');

    if (startButton) {
        startButton.disabled = true;
        startButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting Engine...';
    }
    if (scannerState) scannerState.textContent = 'Starting Engine';
    setStatus('faceStatus', 'scanning', '<i class="fa-solid fa-circle-notch fa-spin"></i> Starting face engine...');

    try {
        const triggerResponse = await fetch(ATTENDANCE_TRIGGER_URL, { method: 'POST' });
        if (!triggerResponse.ok) throw new Error('Engine start request failed.');

        for (let attempt = 0; attempt < 60; attempt++) {
            try {
                const statusResponse = await fetch(ENGINE_STATUS_URL, {
                    signal: AbortSignal.timeout(1500)
                });
                if (statusResponse.ok) {
                    setEngineStatus(true);
                    return true;
                }
            } catch (_) {}

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error('Engine did not respond.');
    } catch (error) {
        setEngineStatus(false);
        setStatus('faceStatus', 'offline', '<i class="fa-solid fa-triangle-exclamation"></i> Unable to start face engine.');
        showToast('Unable to start the face engine. Please try again.', 'red', 4000);
        return false;
    } finally {
        if (startButton) {
            startButton.disabled = false;
            startButton.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
        }
        if (scannerState && !engineOnline) scannerState.textContent = 'Idle';
    }
}

function stopScanner() {
    const stream = document.getElementById('faceStream');
    stream.src = ''; stream.style.display = 'none';
    document.getElementById('faceStreamOff').style.display = 'flex';
    if (sseSource) { sseSource.close(); sseSource = null; }

    if (qrScanner) { qrScanner.stop().catch(() => {}); qrScanner = null; }

    setStatus('faceStatus', 'idle', '<i class="fa-solid fa-circle-info"></i> Scanner stopped');
    setStatus('qrStatus',   'idle', '<i class="fa-solid fa-qrcode"></i> QR scanner stopped');

    document.getElementById('btnStart').style.display = 'flex';
    document.getElementById('btnStop').style.display  = 'none';

    const scannerState = document.getElementById('scannerState');
    if (scannerState) scannerState.textContent = 'Idle';
}

/* ══════════════════════════════════════════════════
   FACE MODE — SSE from Flask :5000
   Handles all SSE message types:
     greeting_only → employee gate log
     time_in / time_out → student gate log
     spoof → spoof overlay + log to spoof_attempts
     not_participant / error / already_recorded → info overlay
     upcoming → info overlay (reminder)
══════════════════════════════════════════════════ */
function startFaceMode() {
    if (!engineOnline) {
        setStatus('faceStatus', 'offline',
            '<i class="fa-solid fa-triangle-exclamation"></i> Face engine offline — run START_ATTENDANCE.bat first');
        document.getElementById('btnStart').style.display = 'flex';
        document.getElementById('btnStop').style.display  = 'none';
        return;
    }

    const stream = document.getElementById('faceStream');
    stream.src   = VIDEO_FEED_URL;
    stream.style.display = 'block';
    document.getElementById('faceStreamOff').style.display = 'none';
    setStatus('faceStatus', 'scanning', '<i class="fa-solid fa-spinner fa-spin"></i> Scanning for face...');

    sseSource = new EventSource(ATTENDEE_STREAM_URL);

    sseSource.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (!data || !data.type) return;

            const cooldownKey = data.name || data.student_id || data.employee_id || 'unknown';
            if (isInCooldown(cooldownKey)) return;

            switch (data.type) {

                // ── Employee recognized (liveness already passed in Flask) ──
                case 'greeting_only': {
                    setCooldown(cooldownKey);
                    await logEmployeeEntry(data);
                    break;
                }

                // ── Student recognized and event attendance recorded in Flask ──
                // For gate entry/exit we also need to log to entry_exit_logs
                case 'time_in':
                case 'time_out': {
                    if (!data.stud_id) break; // safety check
                    setCooldown(cooldownKey);
                    await logStudentGateEntry(data);
                    break;
                }

                // ── Spoof detected ──
                case 'spoof': {
                    setCooldown(cooldownKey);
                    await handleSpoofDetected(data);
                    break;
                }

                // ── Info messages (not registered, no event, already recorded, upcoming) ──
                case 'not_participant':
                case 'error':
                case 'already_recorded':
                case 'upcoming': {
                    setCooldown(cooldownKey);
                    showInfoOverlay(data);
                    break;
                }

                default:
                    break;
            }
        } catch (_) {}
    };

    sseSource.onerror = () => {
        setStatus('faceStatus', 'offline',
            '<i class="fa-solid fa-triangle-exclamation"></i> Lost connection to face engine');
    };
}

/* ══════════════════════════════════════════════════
   LOG EMPLOYEE GATE ENTRY/EXIT (face recognition)
   SSE greeting_only payload: { name, type, role }
   We need to look up employee_id UUID by name match
   from the Flask meta — Flask sends teacher_id as 'id'
   but SSE greeting_only only has name/type/role.
   We resolve UUID by fetching from employees table.
══════════════════════════════════════════════════ */
async function logEmployeeEntry(data) {
    try {
        const today   = new Date().toLocaleDateString('en-CA');
        const isLate  = await checkIfLate();

        // Parse name from greeting: "HELLO John Midname Doe" → "John Midname Doe"
        const rawName = (data.name || '').replace(/^HELLO\s*/i, '').trim();

        // Resolve employee UUID from name (first_name + last_name match)
        // Flask builds name as: `${first_name} ${mid} ${last_name}`.strip()
        // We split last token as last_name, rest as first/middle
        const nameParts  = rawName.split(' ');
        const lastName   = nameParts[nameParts.length - 1] || '';
        const firstName  = nameParts[0] || '';

        let employeeUUID = null;
        let empNo        = '—';
        let department   = '—';

        try {
            const { data: empRows } = await supabaseClient
                .from('employees')
                .select('employee_id, emp_no, first_name, last_name, department')
                .ilike('last_name', `%${lastName}%`)
                .ilike('first_name', `%${firstName}%`)
                .limit(1);

            if (empRows && empRows.length > 0) {
                employeeUUID = empRows[0].employee_id;
                empNo        = empRows[0].emp_no || '—';
                department   = empRows[0].department || '—';
            }
        } catch (_) {}

        // Determine entry/exit
        const logType = employeeUUID
            ? await determineLogTypeEmployee(employeeUUID, today)
            : 'entry';

        // Insert to entry_exit_logs
        const { error } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    null,
            employee_id:   employeeUUID,
            log_type:      logType,
            scan_method:   'face',
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });

        if (error) {
            console.warn('[entryExitScanner] employee log insert error:', error.message);
            showToast(`${rawName} recognized (DB save pending)`, 'purple', 3000);
        }

        showResultEmployee(rawName, empNo, department, logType, isLate);
        flashStatus('faceStatus', logType, isLate, rawName, true);

    } catch (e) {
        console.error('[entryExitScanner] logEmployeeEntry:', e);
    }
}

/* ══════════════════════════════════════════════════
   LOG STUDENT GATE ENTRY/EXIT (face recognition)
   SSE time_in/time_out payload has stud_id (display ID)
   We resolve the student UUID from students table
══════════════════════════════════════════════════ */
async function logStudentGateEntry(data) {
    try {
        const today  = new Date().toLocaleDateString('en-CA');
        const isLate = await checkIfLate();

        // Resolve student UUID from stud_id (display ID like "2024-00001")
        let studentUUID = null;
        try {
            const { data: sRows } = await supabaseClient
                .from('students')
                .select('student_id')
                .eq('stud_id', data.stud_id)
                .limit(1);
            if (sRows && sRows.length > 0) studentUUID = sRows[0].student_id;
        } catch (_) {}

        const logType = studentUUID
            ? await determineLogType(studentUUID, today)
            : 'entry';

        const { error } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    studentUUID,
            employee_id:   null,
            log_type:      logType,
            scan_method:   'face',
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });

        if (error) console.warn('[entryExitScanner] student gate log error:', error.message);

        const displayMeta = {
            name:         data.name || '—',
            stud_id:      data.stud_id || '—',
            grade_level:  data.grade || data.grade_level || '—',
            section_name: data.section || data.section_name || '—'
        };

        showResultStudent(displayMeta, logType, isLate);
        flashStatus('faceStatus', logType, isLate, displayMeta.name, false);

    } catch (e) {
        console.error('[entryExitScanner] logStudentGateEntry:', e);
    }
}

/* ══════════════════════════════════════════════════
   SPOOF DETECTED — show overlay + log to spoof_attempts
══════════════════════════════════════════════════ */
async function handleSpoofDetected(data) {
    // Show the spoof overlay
    showSpoofOverlay(data.name || 'Unknown', data.reason || 'Liveness check failed.');

    // Log to spoof_attempts table
    try {
        await supabaseClient.from('spoof_attempts').insert({
            student_id:   null,  // unknown at spoof stage — name only
            employee_id:  null,
            source_module: 'entry_exit',
            detected_name: data.name || 'Unknown',
            reason:        data.reason || 'Liveness check failed',
            detected_at:   new Date().toISOString()
        });
    } catch (e) {
        // Silently fail — spoof_attempts table columns may differ; log and move on
        console.warn('[entryExitScanner] spoof_attempts insert error:', e.message);
    }

    // Update status bar
    setStatus('faceStatus', 'error',
        '<i class="fa-solid fa-shield-halved"></i> Spoof Detected — ' + (data.name || 'Unknown'));
    setTimeout(() => {
        if (currentMode === 'face') {
            setStatus('faceStatus', 'scanning',
                '<i class="fa-solid fa-spinner fa-spin"></i> Scanning for face...');
        }
    }, OVERLAY_DISMISS_MS);
}

/* ══════════════════════════════════════════════════
   QR MODE
══════════════════════════════════════════════════ */
function startQRMode() {
    setStatus('qrStatus', 'scanning', '<i class="fa-solid fa-spinner fa-spin"></i> Starting QR scanner...');

    qrScanner = new Html5Qrcode('qrReader');
    qrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (decodedText) => {
            if (isInCooldown(decodedText)) return;
            setCooldown(decodedText);
            await logEntryByStudId(decodedText.trim(), 'qr');
        },
        () => {}
    ).then(() => {
        setStatus('qrStatus', 'scanning',
            '<i class="fa-solid fa-qrcode"></i> Point camera at student QR code...');
    }).catch(e => {
        setStatus('qrStatus', 'error',
            `<i class="fa-solid fa-triangle-exclamation"></i> Camera error: ${e}`);
        stopScanner();
    });
}

/* ══════════════════════════════════════════════════
   LOGGING — by stud_id string (QR scan)
   Only students have QR codes (generated by Superadmin)
══════════════════════════════════════════════════ */
async function logEntryByStudId(studId, method) {
    try {
        const { data: rows, error } = await supabaseClient
            .from('students')
            .select('student_id, stud_id, first_name, last_name, grade_level, section_name')
            .eq('stud_id', studId)
            .limit(1);

        if (error) throw error;
        if (!rows || rows.length === 0) {
            const sid = currentMode === 'face' ? 'faceStatus' : 'qrStatus';
            setStatus(sid, 'error',
                `<i class="fa-solid fa-user-xmark"></i> Student ID not found: ${studId}`);
            return;
        }

        const student = rows[0];
        const today   = new Date().toLocaleDateString('en-CA');
        const logType = await determineLogType(student.student_id, today);
        const isLate  = await checkIfLate();

        const { error: insErr } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    student.student_id,
            employee_id:   null,
            log_type:      logType,
            scan_method:   method,
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });

        if (insErr) throw insErr;

        const displayMeta = {
            name:         `${student.last_name}, ${student.first_name}`,
            stud_id:      student.stud_id,
            grade_level:  student.grade_level,
            section_name: student.section_name
        };
        showResultStudent(displayMeta, logType, isLate);
        const sid = currentMode === 'face' ? 'faceStatus' : 'qrStatus';
        flashStatus(sid, logType, isLate, displayMeta.name, false);

    } catch (e) {
        console.error('[entryExitScanner] logEntryByStudId:', e);
        const sid = currentMode === 'face' ? 'faceStatus' : 'qrStatus';
        setStatus(sid, 'error',
            '<i class="fa-solid fa-triangle-exclamation"></i> Log failed. Check connection.');
    }
}

/* ══════════════════════════════════════════════════
   MANUAL ENTRY — accepts Student ID or Employee emp_no
══════════════════════════════════════════════════ */
function openManual() {
    document.getElementById('manualModal').classList.add('open');
    document.getElementById('manualIdInput').value = '';
    document.getElementById('manualLookupResult').style.display = 'none';
    document.getElementById('manualLookupResult').className = 'manual-lookup-result';
    document.getElementById('manualLookupResult').innerHTML = '';
    // Live lookup as user types
    document.getElementById('manualIdInput').oninput = debounce(previewManualLookup, 420);
}

function closeManual() {
    document.getElementById('manualModal').classList.remove('open');
    document.getElementById('manualIdInput').oninput = null;
}

// Preview who will be logged before submitting
async function previewManualLookup() {
    const val = document.getElementById('manualIdInput').value.trim();
    const box = document.getElementById('manualLookupResult');
    if (!val) { box.style.display = 'none'; return; }

    box.style.display = 'block';
    box.className = 'manual-lookup-result';
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Looking up...';

    const result = await resolveIdInput(val);
    if (!result) {
        box.className = 'manual-lookup-result not-found';
        box.innerHTML = '<strong><i class="fa-solid fa-user-xmark"></i> Not found</strong><span>No student or employee matched this ID.</span>';
        return;
    }

    if (result.type === 'student') {
        box.className = 'manual-lookup-result found-student';
        box.innerHTML = `<strong><i class="fa-solid fa-user-graduate"></i> ${result.last_name}, ${result.first_name}</strong>
                         <span>Student · ${result.stud_id} · Grade ${result.grade_level || '—'}</span>`;
    } else {
        box.className = 'manual-lookup-result found-employee';
        box.innerHTML = `<strong><i class="fa-solid fa-user-tie"></i> ${result.last_name}, ${result.first_name}</strong>
                         <span>Employee · ${result.emp_no || '—'} · ${result.department || '—'}</span>`;
    }
}

async function submitManual() {
    const val = document.getElementById('manualIdInput').value.trim();
    if (!val) return;
    closeManual();

    const result = await resolveIdInput(val);
    if (!result) {
        setStatus('faceStatus', 'error',
            `<i class="fa-solid fa-user-xmark"></i> ID not found: ${val}`);
        showToast('ID not found', 'red', 2500);
        return;
    }

    if (result.type === 'student') {
        await manualLogStudent(result);
    } else {
        await manualLogEmployee(result);
    }
}

// Resolve a typed ID string: check students first, then employees
async function resolveIdInput(val) {
    // Try students.stud_id
    try {
        const { data: sRows } = await supabaseClient
            .from('students')
            .select('student_id, stud_id, first_name, middle_name, last_name, grade_level, section_name')
            .eq('stud_id', val)
            .limit(1);
        if (sRows && sRows.length > 0) return { type: 'student', ...sRows[0] };
    } catch (_) {}

    // Try employees.emp_no
    try {
        const { data: eRows } = await supabaseClient
            .from('employees')
            .select('employee_id, emp_no, first_name, middle_name, last_name, department')
            .eq('emp_no', val)
            .limit(1);
        if (eRows && eRows.length > 0) return { type: 'employee', ...eRows[0] };
    } catch (_) {}

    return null;
}

async function manualLogStudent(student) {
    try {
        const today   = new Date().toLocaleDateString('en-CA');
        const logType = await determineLogType(student.student_id, today);
        const isLate  = await checkIfLate();

        const { error } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    student.student_id,
            employee_id:   null,
            log_type:      logType,
            scan_method:   'manual',
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });
        if (error) throw error;

        const meta = {
            name:         `${student.last_name}, ${student.first_name}`,
            stud_id:      student.stud_id,
            grade_level:  student.grade_level,
            section_name: student.section_name
        };
        showResultStudent(meta, logType, isLate);
        flashStatus('faceStatus', logType, isLate, meta.name, false);

    } catch (e) {
        console.error('[entryExitScanner] manualLogStudent:', e);
        showToast('Failed to log student entry', 'red', 3000);
    }
}

async function manualLogEmployee(emp) {
    try {
        const today   = new Date().toLocaleDateString('en-CA');
        const logType = await determineLogTypeEmployee(emp.employee_id, today);
        const isLate  = await checkIfLate();

        const { error } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    null,
            employee_id:   emp.employee_id,
            log_type:      logType,
            scan_method:   'manual',
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });
        if (error) throw error;

        const name = `${emp.last_name}, ${emp.first_name}`;
        showResultEmployee(name, emp.emp_no, emp.department, logType, isLate);
        flashStatus('faceStatus', logType, isLate, name, true);

    } catch (e) {
        console.error('[entryExitScanner] manualLogEmployee:', e);
        showToast('Failed to log employee entry', 'red', 3000);
    }
}

/* ══════════════════════════════════════════════════
   OVERLAYS
══════════════════════════════════════════════════ */
function showSpoofOverlay(name, reason) {
    clearOverlayTimer();
    const el = document.getElementById('spoofOverlay');
    document.getElementById('spoofName').textContent   = name;
    document.getElementById('spoofReason').textContent = reason;

    // Reset and restart the timer bar animation
    const fill = document.getElementById('spoofTimerFill');
    fill.style.animation = 'none';
    fill.offsetHeight; // reflow
    fill.style.animation = `timerShrink ${OVERLAY_DISMISS_MS/1000}s linear forwards`;

    el.classList.add('show');
    overlayTimer = setTimeout(() => dismissOverlay('spoofOverlay'), OVERLAY_DISMISS_MS);
}

function showInfoOverlay(data) {
    clearOverlayTimer();
    const el   = document.getElementById('infoOverlay');
    const icon = document.getElementById('infoIcon');
    const badge = document.getElementById('infoBadge');

    // Configure icon and badge color based on type
    const cfg = {
        not_participant:  { icon: 'fa-user-xmark',   iconCls: '',     badge: 'NOT REGISTERED',   badgeCls: 'info-badge' },
        error:            { icon: 'fa-circle-xmark',  iconCls: 'warn', badge: 'NO ACTIVE EVENT',  badgeCls: 'info-badge' },
        already_recorded: { icon: 'fa-check-double',  iconCls: '',     badge: 'ALREADY LOGGED',   badgeCls: 'info-badge' },
        upcoming:         { icon: 'fa-clock',          iconCls: 'warn', badge: 'UPCOMING EVENT',   badgeCls: 'info-badge' }
    };
    const c = cfg[data.type] || cfg['error'];

    icon.className  = `overlay-icon info-icon ${c.iconCls}`;
    icon.innerHTML  = `<i class="fa-solid ${c.icon}"></i>`;
    badge.className = `overlay-badge ${c.badgeCls}`;
    badge.textContent = c.badge;

    document.getElementById('infoName').textContent   = data.name || '—';
    document.getElementById('infoReason').textContent = data.reason || data.message || '—';

    // Reset timer bar
    const fill = document.getElementById('infoTimerFill');
    fill.style.animation = 'none';
    fill.offsetHeight;
    fill.style.animation = `timerShrink ${OVERLAY_DISMISS_MS/1000}s linear forwards`;

    el.classList.add('show');
    overlayTimer = setTimeout(() => dismissOverlay('infoOverlay'), OVERLAY_DISMISS_MS);
}

function dismissOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
}

function clearOverlayTimer() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    dismissOverlay('spoofOverlay');
    dismissOverlay('infoOverlay');
}

/* ══════════════════════════════════════════════════
   RESULT STRIP
══════════════════════════════════════════════════ */
function showResultStudent(meta, logType, isLate) {
    const avatar = document.getElementById('resultAvatar');
    avatar.className = 'result-avatar';
    avatar.innerHTML = '<i class="fa-solid fa-user-graduate"></i>';

    document.getElementById('resultName').textContent = meta.name || '—';
    document.getElementById('resultMeta').textContent =
        `${meta.stud_id || '—'} · Grade ${meta.grade_level || '—'} — ${meta.section_name || '—'}`;

    const typeBadge = logType === 'entry'
        ? '<span class="rbadge rbadge-entry"><i class="fa-solid fa-door-open"></i> Entry</span>'
        : '<span class="rbadge rbadge-exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
    const lateBadge = (isLate && logType === 'entry')
        ? '<span class="rbadge rbadge-late"><i class="fa-solid fa-clock"></i> Late</span>' : '';
    const roleBadge = '<span class="rbadge rbadge-student"><i class="fa-solid fa-user-graduate"></i> Student</span>';

    document.getElementById('resultBadges').innerHTML = typeBadge + lateBadge + roleBadge;
    document.getElementById('resultStrip').classList.add('show');
}

function showResultEmployee(name, empNo, department, logType, isLate) {
    const avatar = document.getElementById('resultAvatar');
    avatar.className = 'result-avatar employee-avatar';
    avatar.innerHTML = '<i class="fa-solid fa-user-tie"></i>';

    document.getElementById('resultName').textContent = name || '—';
    document.getElementById('resultMeta').textContent =
        `${empNo || '—'} · ${department || '—'}`;

    const typeBadge = logType === 'entry'
        ? '<span class="rbadge rbadge-entry"><i class="fa-solid fa-door-open"></i> Entry</span>'
        : '<span class="rbadge rbadge-exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
    const lateBadge = (isLate && logType === 'entry')
        ? '<span class="rbadge rbadge-late"><i class="fa-solid fa-clock"></i> Late</span>' : '';
    const empBadge = '<span class="rbadge rbadge-employee"><i class="fa-solid fa-user-tie"></i> Employee</span>';

    document.getElementById('resultBadges').innerHTML = typeBadge + lateBadge + empBadge;
    document.getElementById('resultStrip').classList.add('show');
}

/* ══════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════ */
// Determine entry/exit for students based on last log
async function determineLogType(studentUUID, today) {
    if (!AUTO_EXIT) return 'entry';
    try {
        const { data } = await supabaseClient
            .from('entry_exit_logs')
            .select('log_type')
            .eq('student_id', studentUUID)
            .eq('log_date', today)
            .order('log_timestamp', { ascending: false })
            .limit(1)
            .single();
        return data?.log_type === 'entry' ? 'exit' : 'entry';
    } catch (_) { return 'entry'; }
}

// Determine entry/exit for employees based on last log
async function determineLogTypeEmployee(employeeUUID, today) {
    if (!AUTO_EXIT) return 'entry';
    try {
        const { data } = await supabaseClient
            .from('entry_exit_logs')
            .select('log_type')
            .eq('employee_id', employeeUUID)
            .eq('log_date', today)
            .order('log_timestamp', { ascending: false })
            .limit(1)
            .single();
        return data?.log_type === 'entry' ? 'exit' : 'entry';
    } catch (_) { return 'entry'; }
}

async function checkIfLate() {
    const threshold = GATE_SETTINGS.lateThreshold || '07:30';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const [th, tm] = threshold.split(':').map(Number);
    return now.getHours() > th || (now.getHours() === th && now.getMinutes() >= tm);
}

function flashStatus(statusId, logType, isLate, name, isEmployee) {
    const icon  = logType === 'entry' ? 'fa-door-open' : 'fa-right-from-bracket';
    const label = logType === 'entry' ? 'Entry Logged' : 'Exit Logged';
    const cls   = isEmployee ? 'employee' : (isLate && logType === 'entry') ? 'late' : 'success';
    setStatus(statusId, cls, `<i class="fa-solid ${icon}"></i> ${label}: ${name}`);
    setTimeout(() => {
        if (currentMode === 'face') {
            setStatus(statusId, 'scanning', '<i class="fa-solid fa-spinner fa-spin"></i> Scanning for face...');
        } else {
            setStatus(statusId, 'scanning', '<i class="fa-solid fa-qrcode"></i> Point camera at QR code...');
        }
    }, 3500);
}

function isInCooldown(id) {
    const last = cooldownMap[id];
    return last && (Date.now() - last) < COOLDOWN_MS;
}
function setCooldown(id) { cooldownMap[id] = Date.now(); }

function setStatus(id, cls, html) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `scan-status ${cls}`;
    el.innerHTML = html;
}

function showToast(msg, type = 'green', duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.className = type;
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, duration);
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}