/* ============================================================
   manualAttendance.js
   TimeInAndTimeOutMonitoring / resc / js / manualAttendance.js
============================================================ */

const PROFESSOR_START_WINDOW = 45;
const STUDENT_GRACE_MINUTES  = 15;
const PROF_EARLY_WINDOW_MINS = 30;

const ERR_ACTIONS = new Set([
    'NOT_ENROLLED', 'NO_SCHEDULE', 'SESSION_NOT_STARTED', 'SESSION_ENDED',
    'TOO_EARLY', 'NO_VALID_SCHEDULE', 'CANNOT_TIME_OUT', 'COMPLETED'
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

// ── Native BarcodeDetector fast-path state ──
let nativeDetectorStop = null;

let availableLaboratories = [];
let machineLabAssignment = null;
let machineLabLoaded = false;

const labModalOverlay = document.getElementById('labModalOverlay');
const labModalSelect  = document.getElementById('labModalSelect');
const labModalSaveBtn = document.getElementById('labModalSaveBtn');
const labModalState   = document.getElementById('labModalState');
const labModalNote    = document.getElementById('labModalNote');

// ══════════════════════════════════════════════════════════════
// LAB MODAL
// ══════════════════════════════════════════════════════════════
function machineLabLabel(lab) {
    if (!lab || !lab.configured) return 'Unassigned';
    const code = String(lab.lab_code || '').trim();
    const name = String(lab.lab_name || '').trim();
    if (code && name) return `${code} - ${name}`;
    if (code) return code;
    if (name) return name;
    return 'Configured';
}

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

function formatScheduleSummary(schedule) {
    if (!schedule) return '';
    if (typeof schedule === 'string') return schedule;
    if (typeof schedule !== 'object') return String(schedule);
    const section = schedule.section ? `(${schedule.section})` : '—';
    const lab = schedule.lab_code || schedule.lab_name || '—';
    const day = schedule.day_of_week || '';
    return `${section} - ${lab}${day ? ` ${day}` : ''}`.replace(/\s+/g, ' ').trim();
}

function formatScheduleDetails(schedule) {
    if (!schedule || typeof schedule !== 'object') return '';
    const day   = schedule.day_of_week || '';
    const start = format12HourTime(schedule.start_time || schedule.start_time_display);
    const end   = format12HourTime(schedule.end_time   || schedule.end_time_display);
    return [day, start && end ? `${start} - ${end}` : (start || end)].filter(Boolean).join(' | ');
}

function renderMachineLabModal() {
    if (labModalState) {
        labModalState.textContent = machineLabLoaded
            ? (machineLabAssignment && machineLabAssignment.configured ? 'Locked' : 'Unassigned')
            : 'Loading...';
        labModalState.style.background = machineLabAssignment && machineLabAssignment.configured ? '#edf7ef' : '#fff7ed';
        labModalState.style.color      = machineLabAssignment && machineLabAssignment.configured ? '#1a4731' : '#9a3412';
    }
    if (labModalNote) {
        if (!machineLabLoaded) {
            labModalNote.textContent = 'Loading terminal assignment and laboratory list...';
        } else if (!machineLabAssignment || !machineLabAssignment.configured) {
            labModalNote.innerHTML = '<span style="color:#b45309;font-weight:700;">This terminal is not locked yet.</span> Choose the correct laboratory before continuing with manual attendance.';
        } else {
            labModalNote.innerHTML = `This terminal is currently locked to <strong>${machineLabLabel(machineLabAssignment)}</strong>. You can change it here if needed.`;
        }
    }
    if (labModalSaveBtn) labModalSaveBtn.disabled = !availableLaboratories.length;
}

function populateLabModalSelect() {
    if (!labModalSelect) return;
    const currentLabId = machineLabAssignment && machineLabAssignment.lab_id != null
        ? String(machineLabAssignment.lab_id) : '';
    labModalSelect.innerHTML = '<option value="">Select a laboratory...</option>';
    if (!availableLaboratories.length) {
        labModalSelect.innerHTML = '<option value="">No laboratories found</option>';
        labModalSelect.disabled = true;
        return;
    }
    availableLaboratories.forEach(lab => {
        const option = document.createElement('option');
        option.value = String(lab.lab_id);
        option.textContent = `${lab.lab_code || 'Lab'} - ${lab.lab_name || 'Unnamed'}`;
        if (lab.building) option.textContent += ` (${lab.building})`;
        if (currentLabId && currentLabId === String(lab.lab_id)) option.selected = true;
        labModalSelect.appendChild(option);
    });
    labModalSelect.disabled = false;
}

async function loadLaboratoriesForModal() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        availableLaboratories = [];
        populateLabModalSelect();
        renderMachineLabModal();
        return;
    }
    try {
        const { data, error } = await supabaseClient
            .from('laboratory_rooms')
            .select('lab_id, lab_code, lab_name, building')
            .order('lab_code', { ascending: true });
        if (error) throw error;
        availableLaboratories = Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Failed to load laboratories:', err);
        availableLaboratories = [];
    }
    populateLabModalSelect();
    renderMachineLabModal();
}

async function loadMachineLabAssignment() {
    try {
        const res  = await fetch('machine_lab_config.php', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        machineLabAssignment = data.assignment || null;
    } catch (err) {
        console.error('Failed to load machine lab assignment:', err);
        machineLabAssignment = { configured: false };
    } finally {
        machineLabLoaded = true;
        populateLabModalSelect();
        renderMachineLabModal();
    }
}

function openLabModal() {
    if (!labModalOverlay) return;
    labModalOverlay.classList.add('on');
    renderMachineLabModal();
}

function closeLabModal() {
    if (!labModalOverlay) return;
    labModalOverlay.classList.remove('on');
}

async function saveMachineLabAssignment() {
    if (!labModalSelect || labModalSelect.disabled) return;
    const selectedLabId = labModalSelect.value;
    const selectedLab   = availableLaboratories.find(lab => String(lab.lab_id) === String(selectedLabId));
    if (!selectedLab) { showToast('Please select a laboratory before saving.', 'e'); return; }

    if (labModalSaveBtn) {
        labModalSaveBtn.disabled = true;
        labModalSaveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }
    try {
        const res  = await fetch('machine_lab_config.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lab_id:   selectedLab.lab_id,
                lab_code: selectedLab.lab_code,
                lab_name: selectedLab.lab_name,
                building: selectedLab.building
            })
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || 'Unable to save laboratory assignment.');
        machineLabAssignment = json.assignment || null;
        populateLabModalSelect();
        renderMachineLabModal();
        showToast(`Manual attendance is now locked to ${machineLabLabel(machineLabAssignment)}.`, 's');
        closeLabModal();
    } catch (err) {
        console.error(err);
        showToast(`Could not save the laboratory lock: ${err.message || err}`, 'e');
    } finally {
        if (labModalSaveBtn) {
            labModalSaveBtn.disabled = false;
            labModalSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Assignment';
        }
    }
}

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
    // Stop native BarcodeDetector loop first
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

// ── Config: 30 fps cap (120 is ignored by html5-qrcode), large adaptive qrbox ──
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
            useBarCodeDetectorIfSupported: true   // uses native Chrome BarcodeDetector inside html5-qrcode too
        },
        rememberLastUsedCamera: false,
        showTorchButtonIfSupported: true,
        formatsToSupport: (typeof Html5QrcodeSupportedFormats !== 'undefined')
            ? [Html5QrcodeSupportedFormats.QR_CODE]
            : undefined
    };
}

// ── Camera constraints: width/height top-level, advanced only for non-standard props ──
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
        // Pass cameraConfig directly — do NOT also put it in videoConstraints
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

    // Prefer the full local-camera profile first for consistent scan speed/quality.
    if (await tryStartScanner(buildDeviceCameraConfig(deviceId), qrConfig, onDecode)) return true;

    // Fallbacks for browsers/drivers that reject advanced constraints with exact deviceId.
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

// ══════════════════════════════════════════════════════════════
// CAMERA SELECTION
//
// ROOT CAUSE OF THE BUG:
//   Browsers only reveal real device labels (e.g. "Logitech C920"
//   vs "Integrated Camera") AFTER a getUserMedia permission grant.
//   The old code called getCameras() first, got empty/generic labels,
//   could not identify the built-in camera, and silently fell through
//   to the first device — which is almost always the laptop camera.
//
// FIX:
//   Call ensureCameraPermission() (a throwaway getUserMedia) BEFORE
//   getCameras() so labels are populated. Then the priority ordering
//   correctly skips built-in cameras in favour of external webcams.
// ══════════════════════════════════════════════════════════════
async function startScannerWithFallback(onDecode) {
    const qrConfig = getQrScannerConfig();
    showToast('Scanning for webcam...', 's');

    // ── Step 1: Trigger permission prompt BEFORE enumerating devices ──
    // This unlocks real device labels in the browser so we can tell
    // external webcams apart from the built-in laptop camera.
    try {
        await ensureCameraPermission();
    } catch (permErr) {
        // Permission denied or API unsupported — fall through.
        // getCameras() and tryStartScanner will surface the right error below.
        console.warn('Camera permission pre-check failed:', permErr);
    }

    // ── Step 2: Enumerate cameras now that labels are available ──
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

        // ── Step 3: If every camera is built-in, don't auto-start ──
        // Only bail when there are multiple cameras and NONE qualify as external.
        // With a single camera there's no choice — proceed normally.
        if (hasMultipleCameras && !nonLaptopCandidates.length) {
            showToast('No external webcam found. Click Scan QR to start local camera.', 's');
            return;
        }

        // ── Step 4: Try previously remembered camera first ──
        const preferredCameraId = getPreferredQrCameraId();
        if (preferredCameraId) {
            const rememberedCamera    = labeledDevices.find(cam => String(cam.id) === String(preferredCameraId));
            const rememberedIsAllowed = rememberedCamera && (!hasMultipleCameras || !rememberedCamera.preferredLaptop);
            if (rememberedIsAllowed) {
                if (await tryStartDeviceCamera(rememberedCamera.id, qrConfig, onDecode)) return;
            } else if (rememberedCamera?.preferredLaptop) {
                // Previously saved camera is actually built-in — clear it so we re-pick
                localStorage.removeItem('manual_attendance_qr_camera_id');
            }
        }

        // ── Step 5: Priority-ordered selection — external first, built-in last ──
        //
        //   Priority 1: Keyword-matched USB/external webcams (Logitech, Brio, C920…)
        //   Priority 2: Non-laptop cameras NOT at device index 0
        //               (index 0 is the built-in on most laptops even without labels)
        //   Priority 3: Non-laptop cameras at device index 0
        //   Priority 4: Cameras with unknown/empty labels (virtual / driver devices)
        //   Priority 5: Laptop / integrated cameras — absolute last resort
        const keywordExternal   = nonLaptopCandidates.filter(cam => cam.preferredExternal);
        const otherNonLaptop    = nonLaptopCandidates.filter(cam => !cam.preferredExternal);
        const unknownCandidates = labeledDevices.filter(cam => !cam.preferredLaptop && !nonLaptopCandidates.includes(cam));
        const laptopCandidates  = labeledDevices.filter(cam => cam.preferredLaptop);

        const nonPrimaryNonLaptop = otherNonLaptop.filter(cam => cam.originalIndex !== 0);
        const primaryNonLaptop    = otherNonLaptop.filter(cam => cam.originalIndex === 0);

        const orderedDevices = hasMultipleCameras
            ? [...keywordExternal, ...nonPrimaryNonLaptop, ...primaryNonLaptop, ...unknownCandidates, ...laptopCandidates]
            : labeledDevices; // single camera — no ordering needed

        for (const cam of orderedDevices) {
            if (await tryStartDeviceCamera(cam.id, qrConfig, onDecode)) {
                setPreferredQrCameraId(cam.id);
                return;
            }
        }

        showToast('No webcam matched. Falling back to local camera.', 's');
    }

    // ── Step 6: Last-resort facingMode constraints (no device list) ──
    // "user" facing typically matches the webcam direction on desktops.
    if (await tryStartScanner(buildCameraConfig('user'),        qrConfig, onDecode)) return;
    if (await tryStartScanner(buildCameraConfig('environment'), qrConfig, onDecode)) return;

    throw new Error(devices && devices.length ? 'CAMERA_START_FAILED' : 'NO_CAMERA_FOUND');
}

// ══════════════════════════════════════════════════════════════
// NATIVE BARCODE DETECTOR FAST-PATH (~60 fps, GPU-accelerated)
// Runs in parallel with html5-qrcode as a zero-latency layer.
// Supported in Chrome 83+, Edge 83+. Falls back silently otherwise.
// ══════════════════════════════════════════════════════════════
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
                return; // stop — onDetect sets qrDecodeLocked; next scan blocked
            }
        } catch (_) {}
        if (active) requestAnimationFrame(scan);
    };

    requestAnimationFrame(scan);
    return () => { active = false; }; // caller stores this to stop the loop
}

// ══════════════════════════════════════════════════════════════
// SCANNER OPEN / TOGGLE
// ══════════════════════════════════════════════════════════════
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
        // Kill native detector so it doesn't fire again while we process
        if (nativeDetectorStop) { nativeDetectorStop(); nativeDetectorStop = null; }
        processQrResult(decodedText);
    };

    try {
        await startScannerWithFallback(onDecode);

        // Hook in native BarcodeDetector on the video element html5-qrcode created
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
// QR RESULT PROCESSING
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
            if (/^\d{2}-\d{4,5}$/.test(text)) return text;
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
                parsed.student_id || parsed.studentId || parsed.id_number || parsed.id || parsed.employee_id || ''
            );
            if (maybeId) return maybeId;
        } catch (_) {}
    }

    // URL payload
    if (/^https?:\/\//i.test(normalized) || normalized.includes('?')) {
        try {
            const url     = new URL(normalized, window.location.href);
            const maybeId = collectCandidates(
                url.searchParams.get('student_id'),
                url.searchParams.get('studentId'),
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
    const labeledStudent = normalized.match(/student\s*id\s*[:#-]?\s*([0-9]{2}-[0-9]{4,5})/i);
    if (labeledStudent) return labeledStudent[1];

    const labeledEmp = normalized.match(/employee\s*id\s*[:#-]?\s*([0-9]{6,12}|EMP\d+)/i);
    if (labeledEmp) return labeledEmp[1];

    // Plain pattern fallback
    const studentMatch  = normalized.match(/\b\d{2}-\d{4,5}\b/);
    if (studentMatch)  return studentMatch[0];

    const profCodeMatch = normalized.match(/\bEMP\d+\b/i);
    if (profCodeMatch) return profCodeMatch[0];

    const numericEmp   = normalized.match(/\b\d{9}\b/);
    if (numericEmp)    return numericEmp[0];

    return '';
}

function isValidDetectedId(id) {
    const val = String(id || '').trim();
    return /^\d{2}-\d{4,5}$/.test(val) || /^EMP\d+$/i.test(val) || /^\d{9}$/.test(val);
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

    // Auto-select role from ID pattern
    const studentRadio = document.querySelector('input[name="role_select"][value="student"]');
    const profRadio    = document.querySelector('input[name="role_select"][value="professor"]');

    if (/^\d{2}-\d{4,5}$/.test(finalId)) {
        if (studentRadio && !studentRadio.checked) {
            studentRadio.checked = true;
            studentRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } else {
        if (profRadio && !profRadio.checked) {
            profRadio.checked = true;
            profRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (/^\d+$/.test(finalId)) finalId = finalId.slice(0, 9);
    }

    document.getElementById('id_input').value = finalId;
    showToast(`ID Detected: ${finalId}`, 's');

    // Kick off lookup+auto-confirm; qrDecodeLocked stays true until doConfirm clears it
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
        const today      = getTodayStr();
        const currentDay = getDayName();
        const now        = new Date();

        const { data: student } = await supabaseClient
            .from('students')
            .select('student_id, id_number, first_name, middle_name, last_name, status')
            .eq('id_number', id)
            .maybeSingle();

        if (student) {
            const result = await getStudentStatus(student, today, currentDay, now);
            renderResult({ role: 'student', person: student, ...result }, autoConfirm);
            return;
        }

        const { data: professor } = await supabaseClient
            .from('professors')
            .select('professor_id, employee_id, first_name, middle_name, last_name, status')
            .eq('employee_id', id)
            .maybeSingle();

        if (professor) {
            const result = await getProfessorStatus(professor, today, currentDay, now);
            renderResult({ role: 'professor', person: professor, ...result }, autoConfirm);
            return;
        }

        renderResult({ success: false, action: null, message: 'ID not found. Check your Student ID or Employee ID and try again.' }, false);

    } catch (err) {
        showToast('Could not complete lookup. Please try again.', 'e');
    }
}

// ══════════════════════════════════════════════════════════════
// STUDENT STATUS
// ══════════════════════════════════════════════════════════════
async function getStudentStatus(student, today, currentDay, now) {
    const sid = student.student_id;

    const { data: enrollments } = await supabaseClient
        .from('schedule_enrollments').select('schedule_id').eq('student_id', sid).eq('status', 'enrolled');

    if (!enrollments || !enrollments.length)
        return { success: true, action: 'NOT_ENROLLED', message: 'You are not enrolled in any subject with a schedule today.' };

    const scheduleIds = enrollments.map(e => e.schedule_id);

    const { data: activeSessions } = await supabaseClient
        .from('lab_sessions').select('session_id, schedule_id, status, actual_start_time, session_date, notes')
        .in('schedule_id', scheduleIds).in('status', ['ongoing', 'dismissing']);

    const parseSessionLabFromNotes = (notes) => {
        const txt = String(notes || '');
        const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
        if (!m || !m[1]) return null;
        const label = m[1].trim();
        const parts = label.split(' - ');
        if (parts.length >= 2) return { lab_code: parts[0].trim(), lab_name: parts.slice(1).join(' - ').trim() };
        return { lab_code: label, lab_name: '' };
    };

    if (activeSessions && activeSessions.length > 0) {
        const sess = activeSessions[0];
        const { data: schData } = await supabaseClient
            .from('lab_schedules')
            .select('section, start_time, end_time, day_of_week, subjects(subject_code, subject_name), laboratory_rooms(lab_code, lab_name)')
            .eq('schedule_id', sess.schedule_id)
            .single();

        const scheduleData = {
            schedule_id:  sess.schedule_id,
            subject_code: schData?.subjects?.subject_code || '—',
            subject_name: schData?.subjects?.subject_name || '',
            section:      schData?.section || '',
            lab_code:     (parseSessionLabFromNotes(sess.notes) && parseSessionLabFromNotes(sess.notes).lab_code) || schData?.laboratory_rooms?.lab_code || '—',
            lab_name:     (parseSessionLabFromNotes(sess.notes) && parseSessionLabFromNotes(sess.notes).lab_name) || schData?.laboratory_rooms?.lab_name || '',
            day_of_week:  schData?.day_of_week || currentDay,
            start_time:   format12HourTime(schData?.start_time),
            end_time:     format12HourTime(schData?.end_time)
        };
        const subjectCard  = scheduleData.subject_name ? `${scheduleData.subject_code} ${scheduleData.subject_name}`.trim() : scheduleData.subject_code;
        const schedInfo    = formatScheduleSummary(scheduleData);
        const schedDetails = formatScheduleDetails(scheduleData);

        const { data: att } = await supabaseClient
            .from('lab_attendance').select('attendance_id, time_in, time_out')
            .eq('session_id', sess.session_id).eq('student_id', sid).maybeSingle();

        if (att && att.time_in && !att.time_out) {
            if (sess.status === 'ongoing') {
                return { success: true, action: 'CANNOT_TIME_OUT', session_id: sess.session_id, schedule_id: sess.schedule_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, message: 'Professor has not allowed dismissal yet.' };
            }
            return { success: true, action: 'OUT', session_id: sess.session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, is_late: false, late_minutes: 0, message: 'Ready to record TIME OUT.' };
        } else if (!att) {
            return { success: true, action: 'IN', session_id: sess.session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, is_late: false, late_minutes: 0, message: 'Ready to record TIME IN.' };
        }
    }

    const { data: schedules } = await supabaseClient
        .from('lab_schedules').select('schedule_id, start_time, end_time, section, subjects(subject_code, subject_name), laboratory_rooms(lab_code, lab_name)')
        .in('schedule_id', scheduleIds).eq('day_of_week', currentDay).eq('status', 'active').order('start_time');
    const { data: sessions } = await supabaseClient
        .from('lab_sessions').select('session_id, schedule_id, status, actual_start_time').in('schedule_id', scheduleIds).eq('session_date', today);

    const sessionMap = {};
    (sessions || []).forEach(s => { sessionMap[s.schedule_id] = s; });

    let best = null, priority = 99;
    for (const sch of (schedules || [])) {
        const sess   = sessionMap[sch.schedule_id];
        const status = sess ? sess.status : 'not_created';
        if (status === 'cancelled') continue;
        const rank = { ongoing: 1, dismissing: 1, scheduled: 2, not_created: 2, completed: 3 }[status] ?? 4;
        if (rank < priority) { priority = rank; best = { ...sch, session: sess, session_status: status }; }
        if (priority === 1) break;
    }

    if (!best) return { success: true, action: 'NO_VALID_SCHEDULE', message: 'No schedule for today.' };

    let session_id     = best.session ? best.session.session_id : null;
    let session_status = best.session_status;
    const scheduleData = {
        schedule_id:  best.schedule_id,
        subject_code: best.subjects?.subject_code || '—',
        subject_name: best.subjects?.subject_name || '',
        section:      best.section || '',
        lab_code:     best.laboratory_rooms?.lab_code || '—',
        lab_name:     best.laboratory_rooms?.lab_name || '',
        day_of_week:  currentDay,
        start_time:   format12HourTime(best.start_time),
        end_time:     format12HourTime(best.end_time)
    };
    const subjectCard  = scheduleData.subject_name ? `${scheduleData.subject_code} ${scheduleData.subject_name}`.trim() : scheduleData.subject_code;
    const schedInfo    = formatScheduleSummary(scheduleData);
    const schedDetails = formatScheduleDetails(scheduleData);

    if (!session_id) {
        const { data: newSession } = await supabaseClient
            .from('lab_sessions').insert({ schedule_id: best.schedule_id, session_date: today, status: 'scheduled', created_at: new Date().toISOString() }).select('session_id').single();
        if (newSession) { session_id = newSession.session_id; session_status = 'scheduled'; }
    }

    if (['scheduled', 'not_created'].includes(session_status)) {
        return { success: true, action: 'SESSION_NOT_STARTED', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, message: 'Professor has not started the session yet.' };
    }

    if (session_status === 'completed')
        return { success: true, action: 'SESSION_ENDED', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, message: 'The session has already ended.' };

    let is_late = false, late_minutes = 0;
    const actual_start = best.session?.actual_start_time;
    if (actual_start) {
        const sessStart   = secsToDateTime(today, tdToSecs(actual_start));
        const graceCutoff = new Date(sessStart.getTime() + STUDENT_GRACE_MINUTES * 60000);
        if (now > graceCutoff) { is_late = true; late_minutes = Math.floor((now - sessStart) / 60000); }
    }

    const { data: att } = await supabaseClient
        .from('lab_attendance').select('attendance_id, time_in, time_out').eq('session_id', session_id).eq('student_id', sid).maybeSingle();

    if (!att) return { success: true, action: 'IN', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, is_late, late_minutes, message: is_late ? `You are LATE by ${late_minutes} min. Ready to record TIME IN.` : 'Ready to record TIME IN.' };

    if (att.time_in && !att.time_out) {
        if (session_status === 'ongoing') return { success: true, action: 'CANNOT_TIME_OUT', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, message: 'Professor has not allowed dismissal yet.' };
        return { success: true, action: 'OUT', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, is_late: false, late_minutes: 0, message: 'Ready to record TIME OUT.' };
    }

    return { success: true, action: 'COMPLETED', session_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: schedDetails, message: 'Your attendance is complete.' };
}

// ══════════════════════════════════════════════════════════════
// PROFESSOR STATUS
// ══════════════════════════════════════════════════════════════
async function getProfessorStatus(professor, today, currentDay, now) {
    const pid = professor.professor_id;

    const { data: stuckSessions } = await supabaseClient
        .from('lab_sessions').select(`session_id, status, actual_dismiss_time, lab_schedules!inner (schedule_id, section, day_of_week, professor_id, subjects ( subject_code, subject_name ), laboratory_rooms ( lab_code ))`)
        .eq('lab_schedules.professor_id', pid).in('status', ['ongoing', 'dismissing']);

    if (stuckSessions && stuckSessions.length > 0) {
        const sess = stuckSessions[0];
        const sch  = sess.lab_schedules;
        const scheduleData = sch ? {
            schedule_id:  sch.schedule_id,
            subject_code: sch.subjects?.subject_code || '—',
            subject_name: sch.subjects?.subject_name || '',
            section:      sch.section || '',
            lab_code:     sch.laboratory_rooms?.lab_code || '—',
            lab_name:     sch.laboratory_rooms?.lab_name || '',
            day_of_week:  sch.day_of_week || currentDay,
            start_time:   '',
            end_time:     ''
        } : null;
        const subjectCard = scheduleData && scheduleData.subject_name
            ? `${scheduleData.subject_code} ${scheduleData.subject_name}`.trim()
            : (scheduleData ? scheduleData.subject_code : '');
        const si     = scheduleData ? formatScheduleSummary(scheduleData) : 'Active Session';
        const action = sess.status === 'ongoing' ? (sess.actual_dismiss_time ? 'END' : 'DISMISS') : 'END';
        return { success: true, action, session_id: sess.session_id, schedule_id: sch.schedule_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: si, schedule_details: formatScheduleDetails(scheduleData), message: actionMessage(action, si) };
    }

    const { data: todaySchedules } = await supabaseClient
        .from('lab_schedules').select('schedule_id, day_of_week, section, start_time, end_time, subjects(subject_code, subject_name), laboratory_rooms(lab_code)')
        .eq('professor_id', pid).eq('day_of_week', currentDay).eq('status', 'active').order('start_time');

    if (!todaySchedules || !todaySchedules.length)
        return { success: true, action: 'NO_SCHEDULE', message: 'No schedule for today.' };

    const todayIds = todaySchedules.map(s => s.schedule_id);
    const { data: todaySessions } = await supabaseClient
        .from('lab_sessions').select('session_id, schedule_id, status, actual_dismiss_time').in('schedule_id', todayIds).eq('session_date', today);

    const sessionMap = {};
    (todaySessions || []).forEach(s => { sessionMap[s.schedule_id] = s; });

    let closestFuture = null, closestTime = null;

    for (const sched of todaySchedules) {
        const sess      = sessionMap[sched.schedule_id];
        const status    = sess ? sess.status : 'not_created';
        const s         = secsToDateTime(today, tdToSecs(sched.start_time));
        const e         = secsToDateTime(today, tdToSecs(sched.end_time));
        const winOpen   = new Date(s.getTime() - PROF_EARLY_WINDOW_MINS * 60000);
        const scheduleData = {
            schedule_id:  sched.schedule_id,
            subject_code: sched.subjects?.subject_code || '—',
            subject_name: sched.subjects?.subject_name || '',
            section:      sched.section || '',
            lab_code:     sched.laboratory_rooms?.lab_code || '—',
            lab_name:     sched.laboratory_rooms?.lab_name || '',
            day_of_week:  currentDay,
            start_time:   fmt12(s),
            end_time:     fmt12(e)
        };
        const subjectCard = scheduleData.subject_name ? `${scheduleData.subject_code} ${scheduleData.subject_name}`.trim() : scheduleData.subject_code;
        const schedInfo   = formatScheduleSummary(scheduleData);

        if (status === 'cancelled') continue;
        if (now < winOpen) {
            if (!closestTime || s < closestTime) { closestFuture = sched; closestTime = s; }
            continue;
        }
        if (now > e && !['ongoing', 'dismissing'].includes(status)) continue;

        let session_id  = sess ? sess.session_id : null;
        let sess_status = status;

        if (!session_id) {
            const { data: newSession } = await supabaseClient
                .from('lab_sessions').insert({ schedule_id: sched.schedule_id, session_date: today, status: 'scheduled', created_at: new Date().toISOString() }).select('session_id').single();
            if (newSession) { session_id = newSession.session_id; sess_status = 'scheduled'; }
        }

        let action;
        if (['scheduled', 'not_created'].includes(sess_status)) action = 'START';
        else if (sess_status === 'ongoing')    action = sess?.actual_dismiss_time ? 'END' : 'DISMISS';
        else if (sess_status === 'dismissing') action = 'END';
        else if (sess_status === 'completed')  continue;
        else action = 'START';

        return { success: true, action, session_id, schedule_id: sched.schedule_id, schedule: scheduleData, subject_card: subjectCard, schedule_label: schedInfo, schedule_details: formatScheduleDetails(scheduleData), start: fmt12(s), end: fmt12(e), message: actionMessage(action, schedInfo) };
    }

    if (closestFuture) {
        const s    = secsToDateTime(today, tdToSecs(closestFuture.start_time));
        const w    = new Date(s.getTime() - PROF_EARLY_WINDOW_MINS * 60000);
        const mins = Math.floor((w - now) / 60000);
        return { success: true, action: 'TOO_EARLY', message: `Next class starts at ${fmt12(s)}. Window opens in ${mins} min.` };
    }

    return { success: true, action: 'NO_VALID_SCHEDULE', message: 'No schedule for today.' };
}

function actionMessage(action, sched) {
    return { START: `Ready to START session: ${sched}`, DISMISS: `Ready to ALLOW DISMISSAL for: ${sched}`, END: `Ready to END session: ${sched}.` }[action] || action;
}

// ══════════════════════════════════════════════════════════════
// CONFIRM
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
        if (d.role === 'professor') {
            res = await confirmProfessor(d.action, d.session_id, d.schedule_id, d.person.professor_id);
        } else {
            res = await confirmStudent(d.action, d.session_id, d.person.student_id, d.is_late, d.late_minutes);
        }

        showToast(res.message || 'Done', res.success ? 's' : 'e');

        if (res.success) {
            const isStudentAction = d.role === 'student' && ['IN', 'OUT'].includes(d.action);
            payload = null;

            // Brief pause so person can read the success message
            await new Promise(r => setTimeout(r, 1500));

            if (isStudentAction) {
                // Clear panel, unlock scanner for next student — camera stays open
                document.getElementById('id_input').value = '';
                const p = document.getElementById('result-panel');
                p.style.display = 'none';
                p.classList.remove('show');
                qrDecodeLocked = false; // ← unlock for next scan
            } else {
                await lookupById(savedId, false);
            }
        } else {
            restoreConfirmBtn(cb, d.action);
        }
    } catch (err) {
        showToast('Network error. Please try again.', 'e');
        restoreConfirmBtn(cb, d.action);
        qrDecodeLocked = false; // unlock so scanner can retry
    }
}

function getManualAttendanceClock() {
    const now = new Date();
    return { now, nowStore: now.toISOString(), nowLocalTime: now.toTimeString().slice(0, 8) };
}

async function confirmProfessor(action, session_id, schedule_id, professor_id) {
    if (['NO_SCHEDULE', 'TOO_EARLY', 'NO_VALID_SCHEDULE'].includes(action))
        return { success: true, message: 'No action needed.' };

    if (typeof supabaseClient === 'undefined' || !supabaseClient)
        return { success: false, message: 'Supabase client is not available.' };

    let resolvedSessionId = session_id;

    if (!resolvedSessionId && schedule_id) {
        const { data: sessionRow, error: sessionErr } = await supabaseClient
            .from('lab_sessions').select('session_id, status').eq('schedule_id', schedule_id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (sessionErr) return { success: false, message: sessionErr.message || 'Unable to resolve the session.' };
        resolvedSessionId = sessionRow?.session_id || null;
    }

    if (!resolvedSessionId) return { success: false, message: 'Missing session_id.' };

    const { nowStore, nowLocalTime } = getManualAttendanceClock();

    if (action === 'START') {
        const { error } = await supabaseClient.from('lab_sessions')
            .update({ status: 'ongoing', actual_start_time: nowLocalTime, updated_at: nowStore })
            .eq('session_id', resolvedSessionId);
        if (error) return { success: false, message: error.message || 'Unable to start the session.' };
        return { success: true, message: '✅ Session started — Students have 15 min grace period' };
    }

    if (action === 'DISMISS') {
        const { error } = await supabaseClient.from('lab_sessions')
            .update({ status: 'dismissing', actual_dismiss_time: nowLocalTime, updated_at: nowStore })
            .eq('session_id', resolvedSessionId);
        if (error) return { success: false, message: error.message || 'Unable to enable dismissal.' };
        return { success: true, message: '✅ Dismissal mode ON — Students may now time out' };
    }

    if (action === 'END') {
        const { error: sessionError } = await supabaseClient.from('lab_sessions')
            .update({ status: 'completed', actual_end_time: nowLocalTime, updated_at: nowStore })
            .eq('session_id', resolvedSessionId);
        if (sessionError) return { success: false, message: sessionError.message || 'Unable to end the session.' };

        const { data: openAttendances, error: attendanceErr } = await supabaseClient
            .from('lab_attendance').select('attendance_id, time_in, student_id')
            .eq('session_id', resolvedSessionId).not('time_in', 'is', null).is('time_out', null);
        if (attendanceErr) return { success: false, message: attendanceErr.message || 'Unable to close remaining attendance rows.' };

        for (const attendance of openAttendances || []) {
            let outTs = nowStore;
            let durationMinutes = 0;
            try {
                const inTs = new Date(attendance.time_in);
                const outDate = new Date(nowStore);
                if (!isNaN(inTs.getTime()) && outDate < inTs) {
                    outTs = attendance.time_in;
                    durationMinutes = 0;
                } else if (!isNaN(inTs.getTime())) {
                    durationMinutes = Math.max(0, Math.floor((outDate - inTs) / 60000));
                } else {
                    durationMinutes = Math.max(0, Math.floor((new Date(nowStore) - new Date()) / 60000));
                }
            } catch (_) {
                durationMinutes = Math.max(0, Math.floor((new Date(nowStore) - new Date()) / 60000));
            }

            const { error: updateError } = await supabaseClient.from('lab_attendance')
                .update({ time_out: outTs, duration_minutes: durationMinutes, updated_at: nowStore })
                .eq('attendance_id', attendance.attendance_id);
            if (updateError) return { success: false, message: updateError.message || 'Unable to close an active attendance row.' };
        }
        return { success: true, message: '✅ Session ended — remaining students timed out' };
    }

    return { success: true, message: 'No action' };
}

async function confirmStudent(action, session_id, student_id, is_late, late_minutes) {
    if (['NOT_ENROLLED', 'SESSION_NOT_STARTED', 'SESSION_ENDED', 'CANNOT_TIME_OUT', 'COMPLETED'].includes(action))
        return { success: true, message: 'No action needed.' };

    if (typeof supabaseClient === 'undefined' || !supabaseClient)
        return { success: false, message: 'Supabase client is not available.' };

    if (!session_id) return { success: false, message: 'Missing session_id.' };

    const { nowStore } = getManualAttendanceClock();

    if (action === 'OUT') {
        const { data: sessionRow, error: sessionErr } = await supabaseClient
            .from('lab_sessions').select('status').eq('session_id', session_id).maybeSingle();
        if (sessionErr) return { success: false, message: sessionErr.message || 'Unable to check the session status.' };
        if (sessionRow && sessionRow.status === 'ongoing')
            return { success: false, message: '❌ Time-out blocked — professor has not enabled dismissal yet.' };
    }

    const { data: rec, error: attendanceErr } = await supabaseClient
        .from('lab_attendance').select('attendance_id, time_in, time_out')
        .eq('session_id', session_id).eq('student_id', student_id).maybeSingle();
    if (attendanceErr) return { success: false, message: attendanceErr.message || 'Unable to load attendance record.' };

    if (rec === null && action === 'IN') {
        const { error } = await supabaseClient.from('lab_attendance').insert({
            session_id, student_id,
            time_in:      nowStore,
            time_in_status: is_late ? 'late' : 'on-time',
            late_minutes: Number(late_minutes) || 0,
            verified_by_facial_recognition: false,
            created_at:   nowStore
        });
        if (error) return { success: false, message: error.message || 'Unable to save TIME IN.' };
        return { success: true, message: `Time IN recorded ✅ — ${is_late ? `⚠ LATE by ${late_minutes || 0} min` : 'On Time'}` };
    }

    if (rec && rec.time_in && !rec.time_out && action === 'OUT') {
        let outTs = nowStore;
        let durationMinutes = 0;
        try {
            const inTs = new Date(rec.time_in);
            const outDate = new Date(nowStore);
            if (!isNaN(inTs.getTime()) && outDate < inTs) {
                outTs = rec.time_in;
                durationMinutes = 0;
            } else if (!isNaN(inTs.getTime())) {
                durationMinutes = Math.max(0, Math.floor((outDate - inTs) / 60000));
            } else {
                durationMinutes = Math.max(0, Math.floor((new Date(nowStore) - new Date()) / 60000));
            }
        } catch (_) {
            durationMinutes = Math.max(0, Math.floor((new Date(nowStore) - new Date()) / 60000));
        }

        const { error } = await supabaseClient.from('lab_attendance')
            .update({ time_out: outTs, duration_minutes: durationMinutes, updated_at: nowStore })
            .eq('attendance_id', rec.attendance_id);
        if (error) return { success: false, message: error.message || 'Unable to save TIME OUT.' };
        return { success: true, message: 'Time OUT recorded ✅' };
    }

    if (rec && rec.time_in && rec.time_out)
        return { success: true, message: 'Attendance already complete ✔' };

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
    else if (isErr && action !== 'COMPLETED')     setAv('av-w', '⚠️');
    else if (role === 'professor')                setAv('av-p', '👨‍🏫');
    else                                          setAv('av-s', '🎓');

    const fullName = [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' ');
    setName(fullName || 'Unknown', role === 'professor' ? 'Professor' : 'Student');

    const items = [];
    if (role === 'student') {
        items.push(['ID', person.id_number || '—']);
        if (data.subject_card)    items.push(['Subject',       data.subject_card]);
        if (data.schedule_label)  items.push(['Student & Lab', data.schedule_label]);
        if (data.schedule_details)items.push(['Time',          data.schedule_details]);
    } else {
        items.push(['Employee ID', person.employee_id || '—']);
        if (data.subject_card)    items.push(['Subject',       data.subject_card]);
        if (data.schedule_label)  items.push(['Student & Lab', data.schedule_label]);
        if (data.schedule_details)items.push(['Time',          data.schedule_details]);
    }

    document.getElementById('rinfo').innerHTML = items.map(([l, v]) =>
        `<div class="ii"><div class="il">${l}</div><div class="iv">${v}</div></div>`).join('');

    const { mc, ic } = msgCls(action, data);
    setMsg(mc, ic, data.message);

    const cb = document.getElementById('btn-confirm');
    cb.disabled = false; cb.style.opacity = '1';

    if (!isErr && data.session_id) {
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
    if (['START', 'DISMISS', 'END'].includes(action)) return { mc: 'ms', ic: 'fa-play' };
    if (action === 'COMPLETED') return { mc: 'mi', ic: 'fa-check-double' };
    if (['SESSION_NOT_STARTED', 'CANNOT_TIME_OUT', 'TOO_EARLY'].includes(action)) return { mc: 'mw', ic: 'fa-hourglass-half' };
    return { mc: 'me', ic: 'fa-circle-xmark' };
}

function actBtn(action) {
    return ({
        IN:      { lbl: 'Confirm IN',      bc: 'bg',  ico: 'fa-right-to-bracket' },
        OUT:     { lbl: 'Confirm OUT',     bc: 'bg',  ico: 'fa-right-from-bracket' },
        START:   { lbl: 'Start Session',   bc: 'bg',  ico: 'fa-play' },
        DISMISS: { lbl: 'Allow Time Out',  bc: 'bo',  ico: 'fa-door-open' },
        END:     { lbl: 'End Session',     bc: 'br2', ico: 'fa-stop' }
    }[action]) || { lbl: 'Confirm', bc: 'bg', ico: 'fa-check' };
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
function getTodayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function getDayName()  { return new Date().toLocaleDateString('en-US', { weekday: 'long' }); }
function tdToSecs(val) { if (!val) return 0; const p = String(val).split(':'); return p.length === 3 ? parseInt(p[0])*3600 + parseInt(p[1])*60 + parseInt(p[2]) : 0; }
function secsToDateTime(todayStr, secs) { const dt = new Date(todayStr + 'T00:00:00'); dt.setSeconds(dt.getSeconds() + secs); return dt; }
function fmt12(dt) { return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }); }

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
            if (getSelectedRole() === 'professor') {
                idLabel.innerHTML   = '<i class="fa-solid fa-id-card"></i> Employee ID Number';
                idInput.placeholder = 'e.g. 443562323';
            } else {
                idLabel.innerHTML   = '<i class="fa-solid fa-id-card"></i> Student ID Number';
                idInput.placeholder = 'e.g. 23-00269';
            }
            idInput.focus();
        });
    });

    idInput.addEventListener('input', function () {
        let value = this.value.replace(/\D/g, '');
        if (getSelectedRole() === 'student') {
            value = value.slice(0, 7);
            this.value = value.length > 2 ? value.slice(0, 2) + '-' + value.slice(2) : value;
        } else {
            this.value = value.slice(0, 9);
        }

        if (!qrGunModeActive) return;

        const trimmedValue = this.value.trim();
        clearQrGunSubmitTimer();

        if (!trimmedValue) return;

        const expectedComplete = getSelectedRole() === 'student'
            ? /^\d{2}-\d{4,5}$/.test(trimmedValue)
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

    if (labModalSaveBtn) labModalSaveBtn.addEventListener('click', saveMachineLabAssignment);

    loadMachineLabAssignment();
    loadLaboratoriesForModal();

    document.getElementById('id_input').focus();

    if (MANUAL_ACCESS_ROLE === 'super_admin') openLabModal();

    // Let a QR gun/keyboard scanner try first; camera starts as fallback if nothing types.
    scheduleQrCameraFallback();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLabModal();
});