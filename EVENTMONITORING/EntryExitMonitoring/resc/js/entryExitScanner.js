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
let isBooting     = false;
let isFaceDbReady = false;
let previousFaceDbPhase = null;
let previousRebuildSummaryTimestamp = null;
let gateSyncModalTimer = null;
let multiFaceActive = false;

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

    const switchCameraButton = document.getElementById('switchCameraBtn');
    if (switchCameraButton) {
        switchCameraButton.addEventListener('click', switchCameraToEntryExit);
    }
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
        const status = res.ok ? await res.json() : null;
        if (status) handleFaceDbSync(status);
        setEngineStatus(res.ok, status);
    } catch (_) {
        setEngineStatus(false, null);
    }
}

function setEngineStatus(online, status = null) {
    engineOnline = online;
    isFaceDbReady = !!status?.face_db_ready && status?.face_db_phase === 'ready';
    const pill        = document.getElementById('enginePill');
    const engineState = document.getElementById('engineState');
    const stripStatus = document.getElementById('stripStatus');
    const startEngineButton = document.getElementById('btnStartEngine');
    const stopEngineButton = document.getElementById('btnStopEngine');

    if (online) {
        if (startEngineButton) startEngineButton.style.display = 'none';
        if (stopEngineButton) stopEngineButton.style.display = 'inline-flex';
        pill.className = 'engine-pill online';
        pill.innerHTML = '<i class="fa-solid fa-circle"></i> Face Engine Online';
        if (engineState) engineState.textContent = 'Online';
        if (stripStatus) stripStatus.innerHTML   = '<span class="pulse"></span> Online';
    } else {
        if (startEngineButton) startEngineButton.style.display = 'inline-flex';
        if (stopEngineButton) stopEngineButton.style.display = 'none';
        pill.className = 'engine-pill offline';
        pill.innerHTML = '<i class="fa-solid fa-circle"></i> Face Engine Offline';
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

    if (currentMode === 'face') await startFaceMode();
    else                        startQRMode();
}

function startEngine() {
    if (isBooting) return;
    if (engineOnline) {
        document.getElementById('scannerState').textContent = 'Idle';
        setStatus('faceStatus', 'idle', '<i class="fa-solid fa-circle-info"></i> Engine ready. Start the scanner to begin');
        return;
    }
    startAttendanceEngine();
}

async function startAttendanceEngine() {
    const startButton = document.getElementById('btnStartEngine');
    const scannerState = document.getElementById('scannerState');

    if (engineOnline) {
        if (scannerState) scannerState.textContent = 'Idle';
        setStatus('faceStatus', 'idle', '<i class="fa-solid fa-circle-info"></i> Engine ready. Start the scanner to begin');
        return true;
    }

    isBooting = true;
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
                    const status = await statusResponse.json();
                    setEngineStatus(true, status);
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
        if (scannerState) {
            scannerState.textContent = engineOnline
                ? (document.getElementById('btnStop').style.display === 'none' ? 'Idle' : 'Active')
                : 'Idle';
        }
        if (engineOnline && document.getElementById('btnStop').style.display === 'none') {
            setStatus('faceStatus', 'idle', '<i class="fa-solid fa-circle-info"></i> Engine ready. Start the scanner to begin');
        }
        isBooting = false;
    }
}

async function stopEngine() {
    if (!confirm('Stop the face engine? The camera will be released.')) return;

    stopScanner();
    try {
        await fetch(`${FLASK_BASE}/shutdown`, { method: 'POST' });
    } catch (_) {}

    engineOnline = false;
    isFaceDbReady = false;
    setEngineStatus(false);
}

async function switchCameraToEntryExit() {
    const button = document.getElementById('switchCameraBtn');
    if (!button) return;

    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching...';

    try {
        let switched = false;
        for (const base of [FLASK_BASE, 'http://127.0.0.1:5001']) {
            try {
                const response = await fetch(`${base}/camera_control`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ owner: 'attendance', force: true })
                });
                if (!response.ok) continue;
                const data = await response.json();
                switched = switched || data.success && data.owner === 'attendance';
            } catch (_) {}
        }

        if (switched) {
            showToast('Camera is now assigned to Entry-Exit.', 'green', 3000);
            if (sseSource) {
                const stream = document.getElementById('faceStream');
                stream.src = `${VIDEO_FEED_URL}?t=${Date.now()}`;
            }
        } else {
            showToast('Unable to switch camera ownership.', 'red', 4000);
        }
    } finally {
        button.disabled = false;
        button.innerHTML = '<i class="fa-solid fa-repeat"></i> Use Camera for Entry-Exit';
    }
}

function stopScanner() {
    const stream = document.getElementById('faceStream');
    stream.src = ''; stream.style.display = 'none';
    document.getElementById('faceStreamOff').style.display = 'flex';
    if (sseSource) { sseSource.close(); sseSource = null; }
    multiFaceActive = false;
    dismissMultiFaceOverlay();

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
async function setScannerMode(mode) {
    const response = await fetch(`${FLASK_BASE}/scanner_mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
    });
    if (!response.ok) throw new Error('Unable to select scanner mode.');
}

async function startFaceMode() {
    if (!engineOnline) {
        setStatus('faceStatus', 'offline',
            '<i class="fa-solid fa-triangle-exclamation"></i> Face engine offline — run START_ATTENDANCE.bat first');
        document.getElementById('btnStart').style.display = 'flex';
        document.getElementById('btnStop').style.display  = 'none';
        return;
    }

    try {
        await setScannerMode('entry_exit');
    } catch (_) {
        setStatus('faceStatus', 'error', '<i class="fa-solid fa-triangle-exclamation"></i> Unable to select Entry-Exit mode.');
        document.getElementById('btnStart').style.display = 'flex';
        document.getElementById('btnStop').style.display = 'none';
        document.getElementById('scannerState').textContent = 'Idle';
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

            // Scanner-wide warnings have no person ID and must bypass the cooldown.
            if (data.type === 'multiple_faces') {
                showMultiFaceOverlay(data.message);
                return;
            }
            if (data.type === 'multiple_faces_cleared') {
                if (multiFaceActive) {
                    multiFaceActive = false;
                    dismissMultiFaceOverlay();
                    setStatus('faceStatus', 'scanning', '<i class="fa-solid fa-spinner fa-spin"></i> Scanning for face...');
                }
                return;
            }

            const cooldownKey = data.name || data.student_id || data.employee_id || 'unknown';
            if (isInCooldown(cooldownKey)) return;

            switch (data.type) {

                // Student gate logging is independent from event attendance.
                case 'recognized': {
                    break;
                }

                case 'gate_recorded': {
                    setCooldown(cooldownKey);
                    if (data.role === 'student') {
                        showResultStudent({
                            name: data.name,
                            stud_id: data.stud_id,
                            grade_level: data.grade,
                            section_name: data.section
                        }, data.log_type, false);
                    } else {
                        showResultEmployee(data.name, data.emp_no, data.department, data.log_type, false);
                    }
                    flashStatus('faceStatus', data.log_type, false, data.name, data.role !== 'student');
                    break;
                }

                // ── Employee recognized (liveness already passed in Flask) ──
                case 'greeting_only': {
                    break;
                }

                // Event-specific messages are handled by the event attendance page.
                // Entry-Exit already logged the neutral recognized event above.
                case 'time_in':
                case 'time_out': {
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
        multiFaceActive = false;
        dismissMultiFaceOverlay();
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
                .select('employee_id, emp_no, first_name, last_name, faculty, role')
                .ilike('last_name', `%${lastName}%`)
                .ilike('first_name', `%${firstName}%`)
                .limit(1);

            if (empRows && empRows.length > 0) {
                employeeUUID = empRows[0].employee_id;
                empNo        = empRows[0].emp_no || '—';
                department   = empRows[0].faculty || empRows[0].role || '—';
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
            showToast(`${rawName} recognized, but the gate log was not saved.`, 'red', 4000);
            return;
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

        if (error) {
            console.warn('[entryExitScanner] student gate log error:', error.message);
            showToast(`${data.name || 'Student'} recognized, but the gate log was not saved.`, 'red', 4000);
            return;
        }

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
            .select('student_id, stud_id, first_name, last_name, section_id, sections ( grade_level, section_name )')
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
            grade_level:  student.sections?.grade_level || '—',
            section_name: student.sections?.section_name || '—'
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

function openManualAccess() {
    const modal = document.getElementById('manualAccessModal');
    const error = document.getElementById('manualAccessError');
    modal.classList.add('open');
    error.classList.remove('show');
    document.getElementById('manualAccessEmail').value = '';
    document.getElementById('manualAccessPassword').value = '';
    setTimeout(() => document.getElementById('manualAccessEmail').focus(), 100);
}

function closeManualAccess() {
    document.getElementById('manualAccessModal').classList.remove('open');
}

async function submitManualAccess() {
    const email = document.getElementById('manualAccessEmail').value.trim();
    const password = document.getElementById('manualAccessPassword').value;
    const button = document.getElementById('manualAccessSubmit');
    const error = document.getElementById('manualAccessError');
    const errorText = document.getElementById('manualAccessErrorText');

    error.classList.remove('show');
    if (!email || !password) {
        errorText.textContent = 'Enter both email and password.';
        error.classList.add('show');
        return;
    }

    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

    try {
        const { data, error: queryError } = await supabaseClient
            .from('admins')
            .select('admin_id, admin_level, status')
            .eq('email', email)
            .eq('password', password)
            .eq('status', 'active')
            .maybeSingle();

        if (queryError) throw queryError;
        if (!data) throw new Error('Invalid administrator credentials.');

        sessionStorage.setItem('manual_access_granted', 'true');
        sessionStorage.setItem('manual_access_role', data.admin_level || 'admin');
        window.location.href = '../../TimeInAndTimeOutMonitoring/students/manualAttendance.html';
    } catch (err) {
        console.error('[entryExitScanner] manual access verification failed:', err);
        errorText.textContent = err.message || 'Unable to verify credentials.';
        error.classList.add('show');
    } finally {
        button.disabled = false;
        button.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Continue';
    }
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
        const section = result.sections || {};
        box.className = 'manual-lookup-result found-student';
        box.innerHTML = `<strong><i class="fa-solid fa-user-graduate"></i> ${result.last_name}, ${result.first_name}</strong>
                         <span>Student · ${result.stud_id} · ${section.grade_level || '—'} — ${section.section_name || '—'}</span>`;
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
            .select('student_id, stud_id, first_name, middle_name, last_name, section_id, sections ( grade_level, section_name )')
            .eq('stud_id', val)
            .limit(1);
        if (sRows && sRows.length > 0) return { type: 'student', ...sRows[0] };
    } catch (_) {}

    // Try employees.emp_no
    try {
        const { data: eRows } = await supabaseClient
            .from('employees')
            .select('employee_id, emp_no, first_name, middle_name, last_name, faculty, role')
            .eq('emp_no', val)
            .limit(1);
        if (eRows && eRows.length > 0) {
            return {
                type: 'employee',
                ...eRows[0],
                department: eRows[0].faculty || eRows[0].role || '—'
            };
        }
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
            grade_level:  student.sections?.grade_level || '—',
            section_name: student.sections?.section_name || '—'
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
function showMultiFaceOverlay(message) {
    if (multiFaceActive) return;
    multiFaceActive = true;
    clearOverlayTimer();
    document.getElementById('multiFaceMessage').textContent =
        message || 'Only one face is allowed in the scan area. Please scan one person at a time.';
    document.getElementById('multiFaceOverlay').classList.add('show');
    setStatus('faceStatus', 'error', '<i class="fa-solid fa-users"></i> Multiple faces detected — scan one person at a time');
}

function dismissMultiFaceOverlay() {
    dismissOverlay('multiFaceOverlay');
}

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

function showGateResultOverlay(name, meta, badges, isEmployee) {
    clearOverlayTimer();

    const avatar = document.getElementById('gateResultAvatar');
    avatar.className = `overlay-icon gate-result-icon${isEmployee ? ' employee-avatar' : ''}`;
    avatar.innerHTML = `<i class="fa-solid ${isEmployee ? 'fa-user-tie' : 'fa-user-graduate'}"></i>`;
    document.getElementById('gateResultName').textContent = name || '—';
    document.getElementById('gateResultMeta').textContent = meta || '—';
    document.getElementById('gateResultBadges').innerHTML = badges || '';

    const fill = document.getElementById('gateResultTimerFill');
    fill.style.animation = 'none';
    fill.offsetHeight;
    fill.style.animation = `timerShrink ${OVERLAY_DISMISS_MS / 1000}s linear forwards`;

    document.getElementById('gateResultOverlay').classList.add('show');
    overlayTimer = setTimeout(() => dismissOverlay('gateResultOverlay'), OVERLAY_DISMISS_MS);
}

function dismissOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
}

function clearOverlayTimer() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    dismissOverlay('spoofOverlay');
    dismissOverlay('infoOverlay');
    dismissOverlay('gateResultOverlay');
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
    showGateResultOverlay(
        meta.name,
        `${meta.stud_id || '—'} · Grade ${meta.grade_level || '—'} — ${meta.section_name || '—'}`,
        typeBadge + lateBadge + roleBadge,
        false
    );
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
    showGateResultOverlay(
        name,
        `${empNo || '—'} · ${department || '—'}`,
        typeBadge + lateBadge + empBadge,
        true
    );
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

function handleFaceDbSync(status) {
    const phase = status.face_db_phase || (status.face_db_ready ? 'ready' : 'starting');
    if (phase === 'rebuilding' && previousFaceDbPhase !== 'rebuilding') {
        showToast('Syncing facial data. Recognition will continue in the background.', 'blue', 6000);
    }

    if (previousFaceDbPhase === 'rebuilding' && phase === 'ready') {
        const summary = status.last_rebuild_summary;
        if (summary?.timestamp && summary.timestamp !== previousRebuildSummaryTimestamp) {
            previousRebuildSummaryTimestamp = summary.timestamp;
            const changed = (summary.added || 0) + (summary.updated || 0) + (summary.removed || 0);
            if (changed) showGateSyncSummary(summary);
            else showToast('Facial data sync complete. No changes found.', 'green', 3000);
        }
    }
    previousFaceDbPhase = phase;
}

function showGateSyncSummary(summary) {
    document.getElementById('gateSyncAdded').textContent = summary.added || 0;
    document.getElementById('gateSyncUpdated').textContent = summary.updated || 0;
    document.getElementById('gateSyncRemoved').textContent = summary.removed || 0;
    document.getElementById('gateSyncDuration').textContent = summary.duration_ms
        ? `Completed in ${Math.round(summary.duration_ms)}ms` : '';
    const box = document.getElementById('gateSyncBox');
    const removedOnly = summary.removed > 0 && !summary.added && !summary.updated;
    box.classList.toggle('warn', removedOnly);
    document.getElementById('gateSyncTitle').textContent = removedOnly ? 'Facial Data Removed' : 'Facial Data Synced';
    document.getElementById('gateSyncSubtext').textContent = removedOnly
        ? 'Some facial records were removed. Recognition may fail until they are registered again.'
        : 'New or changed facial records are ready for Entry-Exit scanning.';
    document.getElementById('gateSyncOverlay').classList.add('on');
    clearTimeout(gateSyncModalTimer);
    gateSyncModalTimer = setTimeout(dismissGateSyncModal, removedOnly ? 12000 : 8000);
}

function dismissGateSyncModal() {
    clearTimeout(gateSyncModalTimer);
    document.getElementById('gateSyncOverlay').classList.remove('on');
    document.getElementById('gateSyncBox').classList.remove('warn');
}
