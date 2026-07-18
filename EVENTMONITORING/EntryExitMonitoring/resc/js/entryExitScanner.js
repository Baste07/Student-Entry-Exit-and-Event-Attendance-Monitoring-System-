'use strict';

/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
const FLASK_BASE          = 'http://127.0.0.1:5000';
const ENGINE_STATUS_URL   = `${FLASK_BASE}/engine_status`;
const VIDEO_FEED_URL      = `${FLASK_BASE}/video_feed`;
const ATTENDEE_STREAM_URL = `${FLASK_BASE}/attendee_stream`;

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

    if (online) {
        pill.className = 'engine-pill online';
        pill.innerHTML = '<i class="fa-solid fa-circle"></i> Face Engine Online';
        if (engineState) engineState.textContent = 'Online';
        if (stripStatus) stripStatus.innerHTML   = '<span class="pulse"></span> Online';
    } else {
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

    // Engine pill only relevant in face mode
    const pill = document.getElementById('enginePill');
    if (pill) pill.style.display = mode === 'face' ? 'inline-flex' : 'none';

    // Update mode tile
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
function startScanner() {
    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('btnStop').style.display  = 'flex';
    const scannerState = document.getElementById('scannerState');
    if (scannerState) scannerState.textContent = 'Active';

    if (currentMode === 'face') startFaceMode();
    else                        startQRMode();
}

function stopScanner() {
    // Stop face stream + SSE
    const stream = document.getElementById('faceStream');
    stream.src = ''; stream.style.display = 'none';
    document.getElementById('faceStreamOff').style.display = 'flex';
    if (sseSource) { sseSource.close(); sseSource = null; }

    // Stop QR
    if (qrScanner) { qrScanner.stop().catch(() => {}); qrScanner = null; }

    setStatus('faceStatus', 'idle', '<i class="fa-solid fa-circle-info"></i> Scanner stopped');
    setStatus('qrStatus',   'idle', '<i class="fa-solid fa-qrcode"></i> QR scanner stopped');

    document.getElementById('btnStart').style.display = 'flex';
    document.getElementById('btnStop').style.display  = 'none';

    const scannerState = document.getElementById('scannerState');
    if (scannerState) scannerState.textContent = 'Idle';
}

/* ══════════════════════════════════════════════════
   FACE MODE — MJPEG stream + SSE from Flask :5000
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
            if (!data || !data.student_id) return;
            if (isInCooldown(data.student_id)) return;
            setCooldown(data.student_id);
            await logEntryById(data.student_id, 'face', data);
        } catch (_) {}
    };

    sseSource.onerror = () => {
        setStatus('faceStatus', 'offline',
            '<i class="fa-solid fa-triangle-exclamation"></i> Lost connection to face engine');
    };
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
   LOGGING — by UUID (face recognition)
══════════════════════════════════════════════════ */
async function logEntryById(studentUUID, method, meta = {}) {
    try {
        const today   = new Date().toLocaleDateString('en-CA');
        const logType = await determineLogType(studentUUID, today);
        const isLate  = await checkIfLate();

        const { error } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    studentUUID,
            log_type:      logType,
            scan_method:   method,
            log_date:      today,
            log_timestamp: new Date().toISOString(),
            is_late:       isLate && logType === 'entry'
        });

        if (error) throw error;

        const displayMeta = (meta.name)
            ? { name: meta.name, stud_id: meta.stud_id, grade_level: meta.grade_level, section_name: meta.section_name }
            : await fetchStudentMeta(studentUUID);

        showResult(displayMeta, logType, isLate);
        flashStatus('faceStatus', logType, isLate, displayMeta.name || '');

    } catch (e) {
        console.error('[entryExitScanner] logEntryById:', e);
        setStatus('faceStatus', 'error',
            '<i class="fa-solid fa-triangle-exclamation"></i> Failed to log. Check connection.');
    }
}

/* ══════════════════════════════════════════════════
   LOGGING — by stud_id (QR or manual)
══════════════════════════════════════════════════ */
async function logEntryByStudId(studId, method) {
    try {
        const { data: rows, error } = await supabaseClient
            .from('students')
            .select('id, stud_id, first_name, last_name, grade_level, section_name')
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
        const logType = await determineLogType(student.id, today);
        const isLate  = await checkIfLate();

        const { error: insErr } = await supabaseClient.from('entry_exit_logs').insert({
            student_id:    student.id,
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
        showResult(displayMeta, logType, isLate);
        const sid = currentMode === 'face' ? 'faceStatus' : 'qrStatus';
        flashStatus(sid, logType, isLate, displayMeta.name);

    } catch (e) {
        console.error('[entryExitScanner] logEntryByStudId:', e);
        const sid = currentMode === 'face' ? 'faceStatus' : 'qrStatus';
        setStatus(sid, 'error',
            '<i class="fa-solid fa-triangle-exclamation"></i> Log failed. Check connection.');
    }
}

/* ══════════════════════════════════════════════════
   MANUAL ENTRY
══════════════════════════════════════════════════ */
function openManual()  { document.getElementById('manualModal').classList.add('open'); }
function closeManual() { document.getElementById('manualModal').classList.remove('open'); }

async function submitManual() {
    const studId = document.getElementById('manualStudId').value.trim();
    if (!studId) return;
    closeManual();
    await logEntryByStudId(studId, 'manual');
    document.getElementById('manualStudId').value = '';
}

/* ══════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════ */
async function determineLogType(studentId, today) {
    if (!AUTO_EXIT) return 'entry';
    try {
        const { data } = await supabaseClient
            .from('entry_exit_logs')
            .select('log_type')
            .eq('student_id', studentId)
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

async function fetchStudentMeta(uuid) {
    try {
        const { data } = await supabaseClient
            .from('students')
            .select('stud_id, first_name, last_name, grade_level, section_name')
            .eq('id', uuid).limit(1);
        if (data && data[0]) {
            const s = data[0];
            return {
                name:         `${s.last_name}, ${s.first_name}`,
                stud_id:      s.stud_id,
                grade_level:  s.grade_level,
                section_name: s.section_name
            };
        }
    } catch (_) {}
    return { name: '—', stud_id: '—', grade_level: '—', section_name: '—' };
}

function showResult(meta, logType, isLate) {
    document.getElementById('resultName').textContent = meta.name || '—';
    document.getElementById('resultMeta').textContent =
        `${meta.stud_id || '—'} · Grade ${meta.grade_level || '—'} — ${meta.section_name || '—'}`;
    const typeBadge = logType === 'entry'
        ? '<span class="rbadge rbadge-entry"><i class="fa-solid fa-door-open"></i> Entry</span>'
        : '<span class="rbadge rbadge-exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
    const lateBadge = (isLate && logType === 'entry')
        ? '<span class="rbadge rbadge-late"><i class="fa-solid fa-clock"></i> Late</span>' : '';
    document.getElementById('resultBadges').innerHTML = typeBadge + lateBadge;
    document.getElementById('resultStrip').classList.add('show');
}

function flashStatus(statusId, logType, isLate, name) {
    const icon  = logType === 'entry' ? 'fa-door-open' : 'fa-right-from-bracket';
    const label = logType === 'entry' ? 'Entry Logged' : 'Exit Logged';
    const cls   = (isLate && logType === 'entry') ? 'late' : 'success';
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