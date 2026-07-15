/* ============================================================
   manualAttendance.js
   TimeInAndTimeOutMonitoring / resc / js / manualAttendance.js
   Updated for new schema: students, teachers, events, event_attendance
============================================================ */

const STUDENT_GRACE_MINUTES = 15;
const EVENT_LATE_GRACE_MINUTES = 15;

const ERR_ACTIONS = new Set([
    'NOT_REGISTERED', 'NO_ACTIVE_EVENT', 'EVENT_NOT_STARTED', 'ALREADY_TIMED_IN',
    'ATTENDANCE_COMPLETE', 'NO_TIME_IN_FOUND', 'TEACHER_GREETING'
]);

let payload = null;
let html5QrCode = null;
let isScanning = false;
let qrDecodeLocked = false;
const QR_DEBUG_MODE = new URLSearchParams(window.location.search).get('qrdebug') === '1';
let lastDecodedId = '';
let lastDecodedAt = 0;
const QR_DUPLICATE_COOLDOWN_MS = 50;
const MANUAL_ACCESS_ROLE = sessionStorage.getItem('manual_access_role') || '';
let resumeScannerAfterSuccess = false;
let qrCameraFallbackTimer = null;
let qrKeyboardActivitySeen = false;
let qrGunModeActive = false;
let qrGunSubmitTimer = null;

let nativeDetectorStop = null;

// ══════════════════════════════════════════════════════════════
// QR SCANNER — CORE
// ══════════════════════════════════════════════════════════════

function resetScannerUi() {
    const qrContainer = document.getElementById('qr-reader');
    const btnOpen     = document.getElementById('btn-scan-qr');
    qrContainer.style.display = 'none';
    btnOpen.innerHTML = '<i class="fa-solid fa-qrcode"></i> Scan QR';
    isScanning      = false;
    qrDecodeLocked  = false;
    html5QrCode     = null;
}

function clearQrCameraFallbackTimer() {
    if (qrCameraFallbackTimer) {
        clearTimeout(qrCameraFallbackTimer);
        qrCameraFallbackTimer = null;
    }
}

function clearQrGunSubmitTimer() {
    if (qrGunSubmitTimer) {
        clearTimeout(qrGunSubmitTimer);
        qrGunSubmitTimer = null;
    }
}

function scheduleQrCameraFallback(delayMs = 1800) {
    clearQrCameraFallbackTimer();
    qrCameraFallbackTimer = setTimeout(() => {
        if (qrKeyboardActivitySeen || qrGunModeActive || isScanning) return;
        void openQRScanner();
    }, delayMs);
}

function useQrGunMode() {
    qrGunModeActive = true;
    qrKeyboardActivitySeen = true;
    clearQrCameraFallbackTimer();
    clearQrGunSubmitTimer();
    if (isScanning) {
        stopScanner()
            .then(() => resetScannerUi())
            .catch(() => resetScannerUi());
    }

    const input = document.getElementById('id_input');
    if (input) {
        input.focus();
        input.select();
    }

    showToast('QR Gun mode ready. Scan into the ID field and press Enter if needed.', 's');
}

async function stopScanner() {
    if (nativeDetectorStop) {
        nativeDetectorStop();
        nativeDetectorStop = null;
    }

    if (!html5QrCode) return;
    const instance = html5QrCode;
    html5QrCode = null;
    try { await instance.stop();  } catch (_) {}
    try { await instance.clear(); } catch (_) {}
}

async function ensureCameraPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('MEDIA_DEVICES_UNSUPPORTED');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach(track => track.stop());
}

function getQrScannerConfig() {
    return {
        fps: 30,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
            const min  = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.floor(min * 0.85);
            return { width: size, height: size };
        },
        aspectRatio: 1.0,
        disableFlip: false,
        experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
        },
        rememberLastUsedCamera: false,
        showTorchButtonIfSupported: true,
        formatsToSupport: (typeof Html5QrcodeSupportedFormats !== 'undefined')
            ? [Html5QrcodeSupportedFormats.QR_CODE]
            : undefined
    };
}

function buildCameraConfig(facingMode) {
    return {
        facingMode: { ideal: facingMode },
        width:  { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 },
        advanced: [
            { focusMode:       'continuous' },
            { exposureMode:    'continuous' },
            { whiteBalanceMode:'continuous' }
        ]
    };
}

function buildDeviceCameraConfig(deviceId) {
    return {
        deviceId: { exact: deviceId },
        width:  { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 },
        advanced: [
            { focusMode:       'continuous' },
            { exposureMode:    'continuous' },
            { whiteBalanceMode:'continuous' }
        ]
    };
}

async function tryStartScanner(cameraConfig, qrConfig, onDecode) {
    const instance = new Html5Qrcode('qr-reader');
    try {
        await instance.start(cameraConfig, qrConfig, onDecode);
        html5QrCode = instance;
        return true;
    } catch (_) {
        try { await instance.clear(); } catch (__) {}
        return false;
    }
}

async function tryStartDeviceCamera(deviceId, qrConfig, onDecode) {
    if (!deviceId) return false;
    if (await tryStartScanner(buildDeviceCameraConfig(deviceId), qrConfig, onDecode)) return true;
    if (await tryStartScanner({ deviceId: { exact: deviceId } }, qrConfig, onDecode)) return true;
    if (await tryStartScanner(String(deviceId), qrConfig, onDecode)) return true;
    return false;
}

function getPreferredQrCameraId() {
    return localStorage.getItem('manual_attendance_qr_camera_id') || '';
}

function setPreferredQrCameraId(cameraId) {
    if (!cameraId) return;
    localStorage.setItem('manual_attendance_qr_camera_id', String(cameraId));
}

function isLaptopCameraLabel(label) {
    return /integrated|internal|built-in|builtin|facetime|face time|laptop|front camera/i.test(String(label || ''));
}

function isExternalCameraCandidate(camera) {
    const label = String(camera?.label || '').toLowerCase();
    if (!label) return true;
    if (isLaptopCameraLabel(label)) return false;
    return true;
}

async function startScannerWithFallback(onDecode) {
    const qrConfig = getQrScannerConfig();
    showToast('Scanning for webcam...', 's');

    try {
        await ensureCameraPermission();
    } catch (permErr) {
        console.warn('Camera permission pre-check failed:', permErr);
    }

    const devices = await Html5Qrcode.getCameras();

    if (devices && devices.length) {
        const labeledDevices = devices.map((cam, index) => {
            const label = String(cam.label || '').toLowerCase();
            const preferredExternal = /usb|webcam|logitech|hd pro|c920|c922|c930|brio|external|document/i.test(label);
            const preferredLaptop   = isLaptopCameraLabel(label);
            return { ...cam, originalIndex: index, preferredExternal, preferredLaptop };
        });

        const hasMultipleCameras  = labeledDevices.length > 1;
        const nonLaptopCandidates = labeledDevices.filter(isExternalCameraCandidate);

        if (hasMultipleCameras && !nonLaptopCandidates.length) {
            showToast('No external webcam found. Click Scan QR to start local camera.', 's');
            return;
        }

        const preferredCameraId = getPreferredQrCameraId();
        if (preferredCameraId) {
            const rememberedCamera    = labeledDevices.find(cam => String(cam.id) === String(preferredCameraId));
            const rememberedIsAllowed = rememberedCamera && (!hasMultipleCameras || !rememberedCamera.preferredLaptop);
            if (rememberedIsAllowed) {
                if (await tryStartDeviceCamera(rememberedCamera.id, qrConfig, onDecode)) return;
            } else if (rememberedCamera?.preferredLaptop) {
                localStorage.removeItem('manual_attendance_qr_camera_id');
            }
        }

        const keywordExternal   = nonLaptopCandidates.filter(cam => cam.preferredExternal);
        const otherNonLaptop    = nonLaptopCandidates.filter(cam => !cam.preferredExternal);
        const unknownCandidates = labeledDevices.filter(cam => !cam.preferredLaptop && !nonLaptopCandidates.includes(cam));
        const laptopCandidates  = labeledDevices.filter(cam => cam.preferredLaptop);

        const nonPrimaryNonLaptop = otherNonLaptop.filter(cam => cam.originalIndex !== 0);
        const primaryNonLaptop    = otherNonLaptop.filter(cam => cam.originalIndex === 0);

        const orderedDevices = hasMultipleCameras
            ? [...keywordExternal, ...nonPrimaryNonLaptop, ...primaryNonLaptop, ...unknownCandidates, ...laptopCandidates]
            : labeledDevices;

        for (const cam of orderedDevices) {
            if (await tryStartDeviceCamera(cam.id, qrConfig, onDecode)) {
                setPreferredQrCameraId(cam.id);
                return;
            }
        }

        showToast('No webcam matched. Falling back to local camera.', 's');
    }

    if (await tryStartScanner(buildCameraConfig('user'),        qrConfig, onDecode)) return;
    if (await tryStartScanner(buildCameraConfig('environment'), qrConfig, onDecode)) return;

    throw new Error(devices && devices.length ? 'CAMERA_START_FAILED' : 'NO_CAMERA_FOUND');
}

async function tryNativeBarcodeDetector(videoEl, onDetect) {
    if (!('BarcodeDetector' in window)) return null;

    let formats;
    try {
        formats = await BarcodeDetector.getSupportedFormats();
    } catch (_) {
        formats = ['qr_code'];
    }
    if (!formats.includes('qr_code')) return null;

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    let active = true;

    const scan = async () => {
        if (!active) return;
        if (!videoEl || videoEl.readyState < 2) {
            requestAnimationFrame(scan);
            return;
        }
        try {
            const barcodes = await detector.detect(videoEl);
            if (barcodes.length && barcodes[0].rawValue) {
                onDetect(barcodes[0].rawValue);
                return;
            }
        } catch (_) {}
        if (active) requestAnimationFrame(scan);
    };

    requestAnimationFrame(scan);
    return () => { active = false; };
}

function toggleQRScanner() {
    if (isScanning) {
        stopScanner()
            .then(() => resetScannerUi())
            .catch(() => resetScannerUi());
        return;
    }
    void openQRScanner();
}

async function openQRScanner() {
    if (isScanning) return;

    clearQrCameraFallbackTimer();

    const qrContainer = document.getElementById('qr-reader');
    const btnOpen     = document.getElementById('btn-scan-qr');

    qrContainer.style.display = 'block';
    btnOpen.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Camera';
    isScanning     = true;
    qrDecodeLocked = false;

    const onDecode = (decodedText) => {
        if (qrDecodeLocked) return;
        qrDecodeLocked = true;
        if (nativeDetectorStop) { nativeDetectorStop(); nativeDetectorStop = null; }
        processQrResult(decodedText);
    };

    try {
        await startScannerWithFallback(onDecode);

        const videoEl = qrContainer.querySelector('video');
        if (videoEl) {
            nativeDetectorStop = await tryNativeBarcodeDetector(videoEl, onDecode);
        }
    } catch (err) {
        resetScannerUi();
        const msg = String(err?.message || '').toUpperCase();
        if (msg.includes('MEDIA_DEVICES_UNSUPPORTED')) { showToast('Camera is not supported by this browser/device.', 'e'); return; }
        if (msg.includes('NO_CAMERA_FOUND'))            { showToast('No camera found on this device.', 'e');               return; }
        if (msg.includes('NOTALLOWED') || msg.includes('PERMISSION')) { showToast('Camera permission blocked. Allow camera access in browser settings.', 'e'); return; }
        if (msg.includes('NOTREADABLE') || msg.includes('TRACKSTARTERROR')) { showToast('Camera is busy. Close other apps/tabs using the camera and try again.', 'e'); return; }
        showToast('Unable to start camera. Check browser camera icon/site permissions then try again.', 'e');
    }
}

// ══════════════════════════════════════════════════════════════
// QR RESULT PROCESSING (FIXED for continuous scanning)
// ══════════════════════════════════════════════════════════════
function extractIdFromQr(rawText) {
    const normalized = String(rawText || '')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
        .trim();
    if (!normalized) return '';

    const collectCandidates = (...values) => {
        for (const value of values) {
            const text = String(value || '').trim();
            if (!text) continue;
            if (/^([Kk]|[1-9]|10)-\d{1,4}$/.test(text)) return text;
            if (/^EMP\d+$/i.test(text))        return text.toUpperCase();
            if (/^\d{9}$/.test(text))           return text;
        }
        return '';
    };

    // JSON payload
    if (normalized.startsWith('{') && normalized.endsWith('}')) {
        try {
            const parsed  = JSON.parse(normalized);
            const maybeId = collectCandidates(
                parsed.stud_id || parsed.studentId || parsed.student_id || parsed.id_number || parsed.id || parsed.employee_id || ''
            );
            if (maybeId) return maybeId;
        } catch (_) {}
    }

    // URL payload
    if (/^https?:\/\//i.test(normalized) || normalized.includes('?')) {
        try {
            const url     = new URL(normalized, window.location.href);
            const maybeId = collectCandidates(
                url.searchParams.get('stud_id'),
                url.searchParams.get('studentId'),
                url.searchParams.get('student_id'),
                url.searchParams.get('id_number'),
                url.searchParams.get('employee_id'),
                url.searchParams.get('id')
            );
            if (maybeId) return maybeId;
            const lastSeg = url.pathname.split('/').filter(Boolean).pop() || '';
            const pathId  = collectCandidates(lastSeg);
            if (pathId) return pathId;
        } catch (_) {}
    }

    // Labeled matches
    const labeledStudent = normalized.match(/student\s*id\s*[:#-]?\s*([Kk\d]-\d{1,4})/i);
    if (labeledStudent) return labeledStudent[1];

    const labeledEmp = normalized.match(/employee\s*id\s*[:#-]?\s*([0-9]{6,12}|EMP\d+)/i);
    if (labeledEmp) return labeledEmp[1];

    // Plain pattern fallback
    const studentMatch  = normalized.match(/\b([Kk]|[1-9]|10)-\d{1,4}\b/);
    if (studentMatch)  return studentMatch[0];

    const profCodeMatch = normalized.match(/\bEMP\d+\b/i);
    if (profCodeMatch) return profCodeMatch[0];

    const numericEmp   = normalized.match(/\b\d{9}\b/);
    if (numericEmp)    return numericEmp[0];

    return '';
}

function isValidDetectedId(id) {
    const val = String(id || '').trim();
    return /^([Kk]|[1-9]|10)-\d{1,4}$/.test(val) || /^EMP\d+$/i.test(val) || /^\d{9}$/.test(val);
}

function setQrDebug(text) {
    if (!QR_DEBUG_MODE) return;
    const el = document.getElementById('qr-debug-text');
    if (el) el.textContent = String(text || '');
}

function processQrResult(rawText) {
    let finalId = extractIdFromQr(rawText)
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
        .trim();

    setQrDebug(`RAW:\n${String(rawText || '').trim() || '(empty)'}\n\nEXTRACTED ID:\n${finalId || '(none)'}`);

    if (!finalId || !isValidDetectedId(finalId)) {
        qrDecodeLocked = false;
        return;
    }

    const nowMs = Date.now();
    if (finalId === lastDecodedId && (nowMs - lastDecodedAt) < QR_DUPLICATE_COOLDOWN_MS) {
        qrDecodeLocked = false;
        return;
    }
    lastDecodedId = finalId;
    lastDecodedAt = nowMs;

    playScanBeep();

    const studentRadio = document.querySelector('input[name="role_select"][value="student"]');
    const teacherRadio = document.querySelector('input[name="role_select"][value="teacher"]');

    if (/^([Kk]|[1-9]|10)-\d{1,4}$/.test(finalId)) {
        if (studentRadio && !studentRadio.checked) {
            studentRadio.checked = true;
            studentRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } else {
        if (teacherRadio && !teacherRadio.checked) {
            teacherRadio.checked = true;
            teacherRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (/^\d+$/.test(finalId)) finalId = finalId.slice(0, 9);
    }

    document.getElementById('id_input').value = finalId;
    showToast(`ID Detected: ${finalId}`, 's');

    lookupById(finalId, true);
}

// ══════════════════════════════════════════════════════════════
// LOOKUP
// ══════════════════════════════════════════════════════════════
async function doLookup(autoConfirm = false) {
    const id = document.getElementById('id_input').value.trim();
    if (!id) { showToast('Please enter your ID.', 'e'); return; }

    const btn = document.getElementById('btn-lookup');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Looking up...';

    try {
        await lookupById(id, autoConfirm);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Look Up';
    }
}

async function lookupById(id, autoConfirm = false) {
    const panel = document.getElementById('result-panel');
    panel.classList.remove('show');
    panel.style.display = 'none';
    payload = null;

    try {
        const role = getSelectedRole();

        if (role === 'student') {
            const { data: student } = await supabaseClient
                .from('students')
                .select('student_id, stud_id, first_name, middle_name, last_name, status, section_id')
                .eq('stud_id', id)
                .maybeSingle();

            if (student) {
                const result = await getStudentEventStatus(student);
                renderResult({ role: 'student', person: student, ...result }, autoConfirm);
                return;
            }
        } else {
            const { data: teacher } = await supabaseClient
                .from('teachers')
                .select('teacher_id, employee_id, first_name, middle_name, last_name, status')
                .eq('employee_id', id)
                .maybeSingle();

            if (teacher) {
                const result = await getTeacherStatus(teacher);
                renderResult({ role: 'teacher', person: teacher, ...result }, autoConfirm);
                return;
            }
        }

        renderResult({ success: false, action: null, message: 'ID not found. Check your Student ID or Employee ID and try again.' }, false);

    } catch (err) {
        showToast('Could not complete lookup. Please try again.', 'e');
    }
}

function getSelectedRole() {
    const checked = document.querySelector('input[name="role_select"]:checked');
    return checked ? checked.value : 'student';
}

// ══════════════════════════════════════════════════════════════
// STUDENT EVENT STATUS
// ══════════════════════════════════════════════════════════════
async function getStudentEventStatus(student) {
    const sid = student.student_id;

    // 1. Find events this student is registered for
    const { data: participants } = await supabaseClient
        .from('event_participants')
        .select('event_id')
        .eq('student_id', sid);

    if (!participants || !participants.length) {
        return { success: true, action: 'NOT_REGISTERED', message: 'You are not registered for any event.' };
    }

    const eventIds = participants.map(p => p.event_id);

    // 2. Pull those events: ongoing, completed, upcoming
    const { data: events } = await supabaseClient
        .from('events')
        .select('event_id, event_name, status, event_date, time_start, time_end, location')
        .in('event_id', eventIds)
        .in('status', ['ongoing', 'completed', 'upcoming'])
        .order('event_date', { ascending: false })
        .order('time_start', { ascending: false });

    if (!events || !events.length) {
        return { success: true, action: 'NO_ACTIVE_EVENT', message: 'No active or completed event found.' };
    }

    const now = new Date();
    const ongoing   = events.filter(e => e.status === 'ongoing');
    const completed = events.filter(e => e.status === 'completed');
    const upcoming  = events.filter(e => e.status === 'upcoming');

    // PRIORITY 1: ONGOING → time_in
    if (ongoing.length > 0) {
        const ev = ongoing[0];
        const evId = ev.event_id;
        const lateMinutes = eventLateMinutes(ev, now);
        const attendanceRemarks = lateMinutes > 0 ? `Late by ${lateMinutes} min` : 'On time';

        const { data: attRows } = await supabaseClient
            .from('event_attendance')
            .select('attendance_id, time_in, time_out')
            .eq('event_id', evId)
            .eq('student_id', sid);

        const row = attRows && attRows.length > 0 ? attRows[0] : null;

        if (!row) {
            return {
                success: true,
                action: 'IN',
                event_id: evId,
                event_name: ev.event_name,
                event_location: ev.location || '',
                event_date: ev.event_date,
                event_time_start: format12HourTime(ev.time_start),
                event_time_end: format12HourTime(ev.time_end),
                is_late: lateMinutes > 0,
                late_minutes: lateMinutes,
                message: lateMinutes > 0 ? `You are LATE by ${lateMinutes} min. Ready to record TIME IN.` : 'Ready to record TIME IN.'
            };
        } else if (row.time_in && !row.time_out) {
            return {
                success: true,
                action: 'ALREADY_TIMED_IN',
                event_id: evId,
                event_name: ev.event_name,
                message: 'You have already timed in for this event.'
            };
        } else {
            return {
                success: true,
                action: 'ATTENDANCE_COMPLETE',
                event_id: evId,
                event_name: ev.event_name,
                message: 'Time-in and time-out already recorded.'
            };
        }
    }

    // PRIORITY 2: COMPLETED → time_out (if missing)
    if (completed.length > 0) {
        for (const ev of completed) {
            const evId = ev.event_id;
            const { data: attRows } = await supabaseClient
                .from('event_attendance')
                .select('attendance_id, time_in, time_out')
                .eq('event_id', evId)
                .eq('student_id', sid);

            const row = attRows && attRows.length > 0 ? attRows[0] : null;

            if (row && row.time_in && !row.time_out) {
                return {
                    success: true,
                    action: 'OUT',
                    event_id: evId,
                    attendance_id: row.attendance_id,
                    event_name: ev.event_name,
                    event_location: ev.location || '',
                    event_date: ev.event_date,
                    event_time_start: format12HourTime(ev.time_start),
                    event_time_end: format12HourTime(ev.time_end),
                    message: 'Ready to record TIME OUT.'
                };
            }
        }
        return {
            success: true,
            action: 'NO_TIME_IN_FOUND',
            message: 'You cannot time out because no valid time-in exists for any completed event.'
        };
    }

    // PRIORITY 3: UPCOMING
    if (upcoming.length > 0) {
        const ev = upcoming[0];
        return {
            success: true,
            action: 'EVENT_NOT_STARTED',
            event_id: ev.event_id,
            event_name: ev.event_name,
            event_date: ev.event_date,
            event_time_start: format12HourTime(ev.time_start),
            message: `Event '${ev.event_name}' hasn't started yet.`
        };
    }

    return {
        success: true,
        action: 'NO_ACTIVE_EVENT',
        message: 'No attendance action available.'
    };
}

function eventLateMinutes(eventRow, scanTime) {
    const eventStart = parseEventStartDatetime(eventRow);
    if (!eventStart || !scanTime) return 0;

    const graceCutoff = new Date(eventStart.getTime() + EVENT_LATE_GRACE_MINUTES * 60000);
    if (scanTime <= graceCutoff) return 0;

    return Math.floor((scanTime - eventStart) / 60000);
}

function parseEventStartDatetime(eventRow) {
    const eventDate = eventRow.event_date;
    const timeStart = eventRow.time_start;
    if (!eventDate || !timeStart) return null;

    let dateVal, timeVal;
    if (typeof eventDate === 'string') {
        dateVal = new Date(eventDate);
    } else {
        dateVal = new Date(eventDate);
    }

    if (typeof timeStart === 'string') {
        const parts = timeStart.split(':');
        timeVal = { hours: parseInt(parts[0]) || 0, minutes: parseInt(parts[1]) || 0, seconds: parseInt(parts[2]) || 0 };
    } else if (timeStart && typeof timeStart === 'object') {
        timeVal = { hours: timeStart.hours || 0, minutes: timeStart.minutes || 0, seconds: timeStart.seconds || 0 };
    } else {
        return null;
    }

    const dt = new Date(dateVal);
    dt.setHours(timeVal.hours, timeVal.minutes, timeVal.seconds, 0);
    return dt;
}

// ══════════════════════════════════════════════════════════════
// TEACHER STATUS
// ══════════════════════════════════════════════════════════════
async function getTeacherStatus(teacher) {
    return {
        success: true,
        action: 'TEACHER_GREETING',
        message: `Hello ${teacher.first_name || ''}! Manual attendance is for students only.`
    };
}

// ══════════════════════════════════════════════════════════════
// CONFIRM (FIXED for continuous scanning)
// ══════════════════════════════════════════════════════════════
async function doConfirm() {
    if (!payload) return;
    const d       = payload;
    const savedId = document.getElementById('id_input').value.trim();
    const cb      = document.getElementById('btn-confirm');

    cb.disabled = true;
    cb.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

    try {
        let res;
        if (d.role === 'teacher') {
            res = { success: true, message: d.message || 'Greeting displayed.' };
        } else {
            res = await confirmStudentEvent(d.action, d.event_id, d.person.student_id, d.attendance_id, d.is_late, d.late_minutes);
        }

        showToast(res.message || 'Done', res.success ? 's' : 'e');

        if (res.success) {
            const isStudentAction = d.role === 'student' && ['IN', 'OUT'].includes(d.action);
            
            if (isStudentAction) {
                setTimeout(() => {
                    resetFormForNextStudent();
                }, 2000);
            } else {
                payload = null;
                await lookupById(savedId, false);
            }
        } else {
            restoreConfirmBtn(cb, d.action);
            qrDecodeLocked = false;
        }
    } catch (err) {
        showToast('Network error. Please try again.', 'e');
        restoreConfirmBtn(cb, payload.action);
        qrDecodeLocked = false;
    }
}

function getManualAttendanceClock() {
    const now = new Date();
    return { now, nowStore: now.toISOString(), nowLocalTime: now.toTimeString().slice(0, 8) };
}

async function confirmStudentEvent(action, eventId, studentId, attendanceId, isLate, lateMinutes) {
    if (['NOT_REGISTERED', 'NO_ACTIVE_EVENT', 'EVENT_NOT_STARTED', 'ALREADY_TIMED_IN', 'ATTENDANCE_COMPLETE', 'NO_TIME_IN_FOUND', 'TEACHER_GREETING'].includes(action)) {
        return { success: true, message: 'No action needed.' };
    }

    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        return { success: false, message: 'Supabase client is not available.' };
    }

    const { nowStore } = getManualAttendanceClock();

    if (action === 'IN') {
        const { error } = await supabaseClient.from('event_attendance').insert({
            event_id: eventId,
            student_id: studentId,
            time_in: nowStore,
            remarks: isLate ? `Late by ${lateMinutes} min` : 'On time',
            verified_by_facial_recognition: false,
            created_at: nowStore
        });
        if (error) return { success: false, message: error.message || 'Unable to save TIME IN.' };
        return { success: true, message: `Time IN recorded ✅ — ${isLate ? `⚠ LATE by ${lateMinutes || 0} min` : 'On Time'}` };
    }

    if (action === 'OUT') {
        if (!attendanceId) {
            const { data: rows } = await supabaseClient
                .from('event_attendance')
                .select('attendance_id, time_in')
                .eq('event_id', eventId)
                .eq('student_id', studentId)
                .maybeSingle();
            if (!rows) return { success: false, message: 'No time-in record found.' };
            attendanceId = rows.attendance_id;
        }

        let outTs = nowStore;
        let durationMinutes = 0;
        try {
            const { data: attRow } = await supabaseClient
                .from('event_attendance')
                .select('time_in')
                .eq('attendance_id', attendanceId)
                .single();
            const inTs = new Date(attRow.time_in);
            const outDate = new Date(nowStore);
            if (!isNaN(inTs.getTime()) && outDate >= inTs) {
                durationMinutes = Math.max(0, Math.floor((outDate - inTs) / 60000));
            }
        } catch (_) {}

        const { error } = await supabaseClient.from('event_attendance')
            .update({ time_out: outTs, updated_at: nowStore })
            .eq('attendance_id', attendanceId);
        if (error) return { success: false, message: error.message || 'Unable to save TIME OUT.' };
        return { success: true, message: 'Time OUT recorded ✅' };
    }

    return { success: false, message: 'Attendance state is not ready for this action.' };
}

function playScanBeep() {
    try {
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
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
// RENDER & AUTO-CONFIRM
// ══════════════════════════════════════════════════════════════
function renderResult(data, autoConfirm = false) {
    payload = data;
    const panel  = document.getElementById('result-panel');
    const action = data.action || '';
    const role   = data.role   || '';
    const person = data.person || {};
    const isErr  = ERR_ACTIONS.has(action);

    if (!data.success && !data.action)            setAv('av-e', '❓');
    else if (isErr && action !== 'ATTENDANCE_COMPLETE') setAv('av-w', '⚠️');
    else if (role === 'teacher')                  setAv('av-p', '👨‍🏫');
    else                                          setAv('av-s', '🎓');

    const fullName = [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' ');
    setName(fullName || 'Unknown', role === 'teacher' ? 'Teacher' : 'Student');

    const items = [];
    if (role === 'student') {
        items.push(['ID', person.stud_id || '—']);
        if (data.event_name)       items.push(['Event',       data.event_name]);
        if (data.event_location)   items.push(['Location',    data.event_location]);
        if (data.event_date)       items.push(['Date',        data.event_date]);
        if (data.event_time_start) items.push(['Time',        `${data.event_time_start}${data.event_time_end ? ' - ' + data.event_time_end : ''}`]);
    } else {
        items.push(['Employee ID', person.employee_id || '—']);
    }

    document.getElementById('rinfo').innerHTML = items.map(([l, v]) =>
        `<div class="ii"><div class="il">${l}</div><div class="iv">${v}</div></div>`).join('');

    const { mc, ic } = msgCls(action, data);
    setMsg(mc, ic, data.message);

    const cb = document.getElementById('btn-confirm');
    cb.disabled = false; cb.style.opacity = '1';

    if (!isErr && (action === 'IN' || action === 'OUT')) {
        const { lbl, bc, ico } = actBtn(action);
        cb.innerHTML  = `<i class="fa-solid ${ico}"></i> ${lbl}`;
        cb.className  = `btn-c ${bc}`;
        cb.style.display = 'flex';

        if (autoConfirm) {
            cb.disabled = true;
            document.getElementById('btn-reset').disabled = true;
            cb.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            requestAnimationFrame(() => {
                document.getElementById('btn-reset').disabled = false;
                void doConfirm();
            });
        }
    } else {
        cb.style.display = 'none';
    }

    showPanel(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function restoreConfirmBtn(cb, action) {
    cb.disabled = false; cb.style.opacity = '1';
    const { lbl, bc, ico } = actBtn(action);
    cb.innerHTML = `<i class="fa-solid ${ico}"></i> ${lbl}`;
    cb.className = `btn-c ${bc}`;
}

function showPanel(el) { el.classList.remove('show'); void el.offsetWidth; el.style.display = 'block'; el.classList.add('show'); }
function setAv(cls, emoji) { const el = document.getElementById('rav'); el.className = `av ${cls}`; el.textContent = emoji; }
function setName(name, role) { document.getElementById('rname').textContent = name; document.getElementById('rrole').textContent = role; }
function setMsg(cls, icon, txt) { const el = document.getElementById('rmsg'); el.className = `sm ${cls}`; el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${txt}</span>`; }

function msgCls(action) {
    if (action === 'IN')  return { mc: 'ms', ic: 'fa-check' };
    if (action === 'OUT') return { mc: 'ms', ic: 'fa-right-from-bracket' };
    if (action === 'TEACHER_GREETING') return { mc: 'mi', ic: 'fa-hand' };
    if (action === 'ATTENDANCE_COMPLETE') return { mc: 'mi', ic: 'fa-check-double' };
    if (['EVENT_NOT_STARTED', 'ALREADY_TIMED_IN', 'NO_TIME_IN_FOUND'].includes(action)) return { mc: 'mw', ic: 'fa-hourglass-half' };
    return { mc: 'me', ic: 'fa-circle-xmark' };
}

function actBtn(action) {
    return ({
        IN:      { lbl: 'Confirm IN',      bc: 'bg',  ico: 'fa-right-to-bracket' },
        OUT:     { lbl: 'Confirm OUT',     bc: 'bg',  ico: 'fa-right-from-bracket' }
    }[action]) || { lbl: 'Confirm', bc: 'bg', ico: 'fa-check' };
}

// NEW: Dedicated reset function for continuous scanning flow
function resetFormForNextStudent() {
    document.getElementById('id_input').value = '';
    const p = document.getElementById('result-panel');
    p.style.display = 'none';
    p.classList.remove('show');
    payload = null;
    qrDecodeLocked = false;
    document.getElementById('id_input').focus();
    
    setTimeout(() => {
        lastDecodedId = '';
        lastDecodedAt = 0;
    }, QR_DUPLICATE_COOLDOWN_MS + 100);
}

function resetForm() {
    document.getElementById('id_input').value = '';
    const p = document.getElementById('result-panel');
    p.style.display = 'none';
    p.classList.remove('show');
    payload = null;
    qrDecodeLocked = false;
    document.getElementById('id_input').focus();
    if (resumeScannerAfterSuccess) {
        resumeScannerAfterSuccess = false;
        setTimeout(() => void openQRScanner(), 250);
    }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function format12HourTime(value) {
    if (!value) return '';
    const text = String(value).trim();
    if (!text) return '';
    if (/\b(AM|PM)\b/i.test(text)) return text.replace(/\s+/g, ' ').toUpperCase();
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return text;
    let hours = Number(match[1]);
    const minutes = match[2];
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${String(hours).padStart(2, '0')}:${minutes} ${suffix}`;
}

let toastTimer;
function showToast(msg, type = 's') {
    clearTimeout(toastTimer);
    document.getElementById('toast-msg').textContent = msg;
    document.getElementById('toast-icon').className  = type === 's' ? 'fa-solid fa-check-circle' : 'fa-solid fa-circle-xmark';
    const t = document.getElementById('toast');
    t.className = `show t${type}`;
    toastTimer = setTimeout(() => { t.className = ''; }, 4500);
}

// ══════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('footerYear').textContent = new Date().getFullYear();

    if (QR_DEBUG_MODE) {
        const debugEl = document.getElementById('qr-debug');
        if (debugEl) debugEl.style.display = 'block';
        setQrDebug('Debug enabled. Waiting for QR scan...');
    }

    // Live clock
    function tick() {
        const n = new Date();
        document.getElementById('live-clock').textContent =
            n.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
            + '  ·  '
            + n.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    tick(); setInterval(tick, 1000);

    // USB scanner gun — auto-confirm on Enter
    document.getElementById('id_input').addEventListener('keydown', e => {
        if (e.key !== 'Enter' && !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) {
            qrKeyboardActivitySeen = true;
            if (qrGunModeActive) clearQrGunSubmitTimer();
            if (isScanning) {
                stopScanner()
                    .then(() => resetScannerUi())
                    .catch(() => resetScannerUi());
            }
            clearQrCameraFallbackTimer();
        }

        if (e.key === 'Enter') {
            clearQrGunSubmitTimer();
            const id = document.getElementById('id_input').value.trim();
            if (id) lookupById(id, true);
        }
    });

    // Role switcher + ID formatter
    const idInput   = document.getElementById('id_input');
    const idLabel   = document.getElementById('id_label');
    const roleRadios = document.getElementsByName('role_select');

    function getSelectedRole() {
        return document.querySelector('input[name="role_select"]:checked').value;
    }

    roleRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            idInput.value = '';
            if (getSelectedRole() === 'teacher') {
                idLabel.innerHTML   = '<i class="fa-solid fa-id-card"></i> Employee ID Number';
                idInput.placeholder = 'e.g. 443562323';
            } else {
                idLabel.innerHTML   = '<i class="fa-solid fa-id-card"></i> Student ID Number';
                idInput.placeholder = 'e.g. K-001 or 5-123 or 10-1234';
            }
            idInput.focus();
        });
    });

    idInput.addEventListener('input', function () {
        let value = this.value;
        if (getSelectedRole() === 'student') {
            value = value.replace(/[^Kk0-9\-]/g, '').toUpperCase();
            this.value = value;
        } else {
            value = value.replace(/\D/g, '');
            this.value = value.slice(0, 9);
        }

        if (!qrGunModeActive) return;

        const trimmedValue = this.value.trim();
        clearQrGunSubmitTimer();

        if (!trimmedValue) return;

        const expectedComplete = getSelectedRole() === 'student'
            ? /^([Kk]|[1-9]|10)-\d{1,4}$/.test(trimmedValue)
            : /^\d{9}$/.test(trimmedValue);

        if (!expectedComplete) return;

        qrGunSubmitTimer = setTimeout(() => {
            const finalId = document.getElementById('id_input').value.trim();
            if (finalId) doLookup(true);
        }, 250);
    });

    document.getElementById('btn-lookup').addEventListener('click', () => doLookup(false));
    document.getElementById('btn-qr-gun').addEventListener('click', useQrGunMode);
    document.getElementById('btn-scan-qr').addEventListener('click', toggleQRScanner);
    document.getElementById('btn-confirm').addEventListener('click', doConfirm);
    document.getElementById('btn-reset').addEventListener('click', resetForm);

    document.getElementById('id_input').focus();

    scheduleQrCameraFallback();
});