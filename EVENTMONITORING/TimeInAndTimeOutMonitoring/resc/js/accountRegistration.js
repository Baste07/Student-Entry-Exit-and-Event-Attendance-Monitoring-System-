/* ============================================================
   resc/js/accountRegistration.js
   Integrative Programming — Face Registration Logic
============================================================ */

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialized. Check config/.env.js');
        return;
    }

    const params = new URLSearchParams(window.location.search);

    // Auto-switch to professor tab if role=professor
    if (params.get('role') === 'professor') switchRole('professor');

    // Pre-fill student ID from URL
    const sid = params.get('student_id');
    if (sid && currentRole === 'student') {
        const idInput = document.getElementById('studentIdInput');
        idInput.value = sid;
        idInput.dispatchEvent(new Event('input'));
    }

    // Pre-fill Professor ID from URL
    const empId = params.get('employee_id');
    if (empId && currentRole === 'professor') {
        const empInput = document.getElementById('employeeIdInput');
        empInput.value = empId;
        empInput.dispatchEvent(new Event('input'));
    }
});

// ═══════════════════════════════════════════
// GLOBAL ELEMENTS & STATE
// ═══════════════════════════════════════════
let currentRole = 'student';
let studentData = null;
let professorData = null;
let studentTimer = null;
let isEngineOnline = false;
let isBooting = false; 
const REG_ENGINE_BASE = 'http://127.0.0.1:5001';
const ATT_ENGINE_BASE = 'http://127.0.0.1:5000';
const FACE_BUCKET = 'facial_data';
let currentCameraOwner = 'unknown';

const opencvFeed      = document.getElementById('opencvFeed');
const cameraLoading   = document.getElementById('cameraLoading');
const cameraContainer = document.getElementById('cameraContainer');
const captureStatus   = document.getElementById('captureStatus');
const dots            = [1,2,3,4,5].map(i => document.getElementById('dot'+i));

const studentIdInput   = document.getElementById('studentIdInput');
const empIdInput       = document.getElementById('employeeIdInput');
const studentScanBtn   = document.getElementById('studentScanBtn');
const professorScanBtn = document.getElementById('professorScanBtn');
const studentInfoCard  = document.getElementById('studentInfoCard');
const professorInfoCard = document.getElementById('professorInfoCard');
const switchCameraBtn = document.getElementById('switchCameraBtn');

// ═══════════════════════════════════════════
// CAMERA OWNERSHIP SWITCH
// ═══════════════════════════════════════════
// Calls BOTH engines' /camera_control so whichever one currently holds the
// camera device gets an explicit release call, regardless of call order.
// Success is judged by whether ANY response confirms owner === targetOwner —
// never by a single response's self-relative "owns_camera" field, since that
// field is only meaningful for the engine that answered it.
async function switchCameraOwner(targetOwner) {
    const endpoints = [REG_ENGINE_BASE, ATT_ENGINE_BASE].map(base => `${base}/camera_control`);
    let sawConfirmedOwner = false;

    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner: targetOwner, force: true })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success && data.owner === targetOwner) {
                    sawConfirmedOwner = true;
                }
            }
        } catch (_) {}
    }

    return { success: sawConfirmedOwner, owner: sawConfirmedOwner ? targetOwner : null };
}

async function fetchCameraOwnerStatus() {
    const endpoints = [`${REG_ENGINE_BASE}/camera_control`, `${ATT_ENGINE_BASE}/camera_control`];
    for (const url of endpoints) {
        try {
            const res = await fetch(url, { method: 'GET' });
            if (!res.ok) continue;
            const data = await res.json();
            return data.owner || 'none';
        } catch (_) {}
    }
    return 'unknown';
}

function renderCameraSwitchButton(owner = currentCameraOwner) {
    if (!switchCameraBtn) return;

    if (owner === 'registration') {
        switchCameraBtn.innerHTML = '<i class="fa-solid fa-camera"></i> Camera: Registration';
        switchCameraBtn.style.background = '#14532d';
    } else if (owner === 'attendance') {
        switchCameraBtn.innerHTML = '<i class="fa-solid fa-repeat"></i> Switch Camera from Attendance';
        switchCameraBtn.style.background = '#0b4e78';
    } else {
        switchCameraBtn.innerHTML = '<i class="fa-solid fa-repeat"></i> Use Camera for Registration';
        switchCameraBtn.style.background = '#14532d';
    }
}

if (switchCameraBtn) {
    switchCameraBtn.addEventListener('click', async () => {
        switchCameraBtn.disabled = true;
        switchCameraBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching...';
        try {
            const result = await switchCameraOwner('registration');
            if (result && result.success) {
                currentCameraOwner = result.owner || 'registration';
                captureStatus.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--green-bright)"></i> Camera switched to Registration engine.';
            } else {
                captureStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Failed to switch camera owner.';
            }
        } finally {
            switchCameraBtn.disabled = false;
            renderCameraSwitchButton(currentCameraOwner);
        }
    });
}

// ═══════════════════════════════════════════
// STUDENT ID AUTO-FORMATTER
// ═══════════════════════════════════════════

function formatStudentId(raw) {
    const sanitized = raw.replace(/[^0-9Kk\-]/g, '').toUpperCase();
    const dashIndex = sanitized.indexOf('-');
    const clean = sanitized.replace(/[^0-9K]/g, '');
    if (!clean) return '';

    // Kinder: K-XXXX
    if (clean[0] === 'K') {
        return 'K-' + clean.slice(1).slice(0, 4);
    }

    // Explicit dash after first digit (grade 1-9)
    if (dashIndex === 1 && /^[1-9]$/.test(clean[0])) {
        return clean[0] + '-' + clean.slice(1).slice(0, 4);
    }

    // Explicit dash after second digit (grade 10)
    if (dashIndex === 2 && clean.startsWith('10')) {
        return '10-' + clean.slice(2).slice(0, 4);
    }

    // Grade 10 auto-detect
    if (clean.startsWith('10')) {
        return '10-' + clean.slice(2).slice(0, 4);
    }

    // Grades 2-9: safe to auto-dash immediately (no ambiguity)
    if (/^[2-9]$/.test(clean[0])) {
        return clean[0] + '-' + clean.slice(1).slice(0, 4);
    }

    // Grade 1: wait for the next digit to decide between 1 and 10
    if (clean[0] === '1') {
        if (clean.length === 1) {
            return '1'; // no dash yet
        }
        // If we reach here, it's grade 1 (e.g., "12", "13"... "10" was caught above)
        return '1-' + clean.slice(1).slice(0, 4);
    }

    return clean;
}



async function hasFaceFiles(datasetPath) {
    if (!datasetPath) return false;

    try {
        const { data, error } = await supabaseClient.storage
            .from(FACE_BUCKET)
            .list(datasetPath, {
                limit: 20,
                offset: 0,
                sortBy: { column: 'name', order: 'asc' }
            });

        if (error) return false;

        return (data || []).some(f => {
            const name = (f?.name || '').toLowerCase();
            return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        });
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════
// NEW: DYNAMIC BUTTON STATE CONTROLLER
// ═══════════════════════════════════════════
function updateScanButtonsState() {
    const defaultText = '<i class="fa-solid fa-camera"></i> Scan & Register Face';
    
    const setBtnState = (btn, data) => {
        if (!btn) return;
        
        if (isBooting) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Engine Booting...';
        } else if (!isEngineOnline) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-power-off" style="color:#fca5a5;"></i> Please Start Engine First';
        } else if (!data) {
            btn.disabled = true;
            btn.innerHTML = defaultText;
        } else {
            btn.disabled = false;
            btn.innerHTML = defaultText;
        }
    };

    setBtnState(studentScanBtn, studentData);
    setBtnState(professorScanBtn, professorData);
}

// ═══════════════════════════════════════════
// ROLE SWITCHING
// ═══════════════════════════════════════════
function switchRole(role) {
    currentRole = role;
    document.getElementById('studentSection').style.display   = role === 'student'   ? '' : 'none';
    document.getElementById('professorSection').style.display = role === 'professor' ? '' : 'none';
    document.getElementById('btnStudent').classList.toggle('active',   role === 'student');
    document.getElementById('btnProfessor').classList.toggle('active', role === 'professor');

    const isProf = role === 'professor';
    document.getElementById('heroSub').textContent = isProf
        ? 'Look up your Employee ID, then launch the Lab Camera to register.'
        : 'Look up your Student ID, then launch the Lab Camera to register.';
}

// ═══════════════════════════════════════════
// CAMERA MODAL
// ═══════════════════════════════════════════
function resetDots() { dots.forEach(d => d.classList.remove('done')); }

function openCameraUI() {
    cameraContainer.style.display = 'flex';
    cameraLoading.style.display = 'block';
    opencvFeed.style.display = 'none';

    captureStatus.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Connecting to Background Engine...';
    opencvFeed.src = `${REG_ENGINE_BASE}/video_feed?t=${new Date().getTime()}`;

    opencvFeed.onload = () => {
        cameraLoading.style.display = 'none';
        opencvFeed.style.display = 'block';
        captureStatus.innerHTML = '<i class="fa-solid fa-bolt" style="color:var(--green-bright)"></i> OpenCV Feed Active';
        startProgressPolling();
    };

    opencvFeed.onerror = () => {
        cameraLoading.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="color:#ff4757"></i><p>Engine Offline.<br>Make sure you ran START_REGISTRATION.bat</p>';
        captureStatus.innerHTML = '';
    };
}

function closeCameraUI() {
    cameraContainer.style.display = 'none';
    opencvFeed.src = "";
    resetDots();
    if (progressPoller) { clearInterval(progressPoller); progressPoller = null; }
}

function clearStudentForm() {
    closeCameraUI();
    studentInfoCard.classList.remove('show');
    studentIdInput.value = '';
    studentData = null;
    ['s_firstName','s_middleName','s_lastName','s_gradeLevel','s_sectionName','s_email']
        .forEach(id => document.getElementById(id).value = '');
    ['displayName','displayCourse','displayYearSection','displayEmail']
        .forEach(id => document.getElementById(id).textContent = '');
    const idSuccess = document.getElementById('idSuccess');
    const idError = document.getElementById('idError');
    if (idSuccess) idSuccess.innerHTML = '';
    if (idError) idError.textContent = '';
    updateScanButtonsState();
    studentIdInput.focus();
}

function clearProfessorForm() {
    closeCameraUI();
    professorInfoCard.classList.remove('show');
    empIdInput.value = '';
    professorData = null;
    ['p_firstName','p_middleName','p_lastName','p_department','p_email']
        .forEach(id => document.getElementById(id).value = '');
    ['p_displayName','p_displayDept','p_displayEmpId','p_displayEmail']
        .forEach(id => document.getElementById(id).textContent = '');
    const pIdSuccess = document.getElementById('p_idSuccess');
    const pIdError = document.getElementById('p_idError');
    if (pIdSuccess) pIdSuccess.innerHTML = '';
    if (pIdError) pIdError.textContent = '';
    updateScanButtonsState();
    empIdInput.focus();
}

cameraContainer.addEventListener('click', e => { if (e.target === cameraContainer) closeCameraUI(); });

// ═══════════════════════════════════════════
// STUDENT SCAN BUTTON
// ═══════════════════════════════════════════
studentScanBtn.addEventListener('click', async () => {
    if (!studentData || !isEngineOnline) return;

    const btn = document.getElementById('studentScanBtn');
    btn.disabled = true;
    cameraContainer.style.display = 'flex';

    try {
        captureStatus.innerHTML = '<i class="fa-solid fa-broom fa-spin"></i> Purging old data & preparing camera...';
        
        await fetch(`${REG_ENGINE_BASE}/start_registration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id_number: studentData.stud_id,
                firstName: studentData.first_name,
                lastName:  studentData.last_name,
                role:      'student'
            })
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
        openCameraUI();

    } catch (err) {
        cameraContainer.style.display = 'none';
        alert("❌ Registration Error: " + err.message);
    } finally {
        btn.disabled = false;
    }
});

let progressPoller = null;
function startProgressPolling() {
    progressPoller = setInterval(async () => {
        try {
            const res = await fetch(`${REG_ENGINE_BASE}/status`);
            const data = await res.json();

            dots.forEach((dot, i) => dot.classList.toggle('done', i < data.count));

            if (data.syncing) {
                captureStatus.innerHTML = '<i class="fa-solid fa-cloud-arrow-up" style="color:var(--green-bright)"></i> Syncing to cloud...';
                dots.forEach(dot => dot.classList.add('done'));
            }

            if (data.completed) {
                clearInterval(progressPoller);
                progressPoller = null;
                captureStatus.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--green-bright)"></i> Registration Complete! Preparing for next registrant...';

                try {
                    captureStatus.innerHTML = '<i class="fa-solid fa-cloud-arrow-up" style="color:var(--green-bright)"></i> Notifying attendance engine...';
                    await triggerRebuildDebounced(false);
                    const ready = await waitForAttendanceEngineReady(20, 500);
                    if (ready) {
                        captureStatus.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--green-bright)"></i> Attendance engine updated.';
                    } else {
                        captureStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i> Engine update timed out; closing anyway.';
                    }
                } catch (e) {
                    console.error('Trigger rebuild failed', e);
                }

                setTimeout(() => {
                    if ((data.role || 'student') === 'professor') {
                        clearProfessorForm();
                    } else {
                        clearStudentForm();
                    }
                }, 1200);
            }
        } catch (_) {}
    }, 800);
}

async function waitForFlask(retries = 30, delayMs = 1500) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${REG_ENGINE_BASE}/status`, {
                method: 'GET',
                signal: AbortSignal.timeout(1500)
            });
            if (res.ok) return true;
        } catch (_) {}

        captureStatus.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Starting camera engine... (${i + 1}/${retries})`;
        await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
}

// ═══════════════════════════════════════════
// STUDENT ID INPUT LOGIC
// ═══════════════════════════════════════════
studentIdInput.addEventListener('input', function (e) {
    // Detect deletion actions (Backspace, Delete, Cut)
    const isDeleting = e.inputType && e.inputType.startsWith('delete');

    let val;
    if (isDeleting) {
        // On delete: only strip invalid characters, don't force-add dashes
        // so the user can backspace all the way to empty
        val = this.value.replace(/[^0-9Kk\-]/g, '').toUpperCase();
        if (this.value !== val) {
            this.value = val;
        }
    } else {
        // On typing / pasting: apply full auto-format
        const formatted = formatStudentId(this.value);
        if (this.value !== formatted) {
            this.value = formatted;
        }
        val = this.value;
    }

    clearTimeout(studentTimer);
    document.getElementById('idError').textContent = '';
    document.getElementById('idSuccess').innerHTML = '';
    studentInfoCard.classList.remove('show');

    studentData = null;
    updateScanButtonsState();

    if (val.length >= 3) {
        document.getElementById('idSuccess').innerHTML = 'Searching... <span class="loading"></span>';
        studentTimer = setTimeout(() => searchStudent(val), 600);
    }
});

async function searchStudent(studentId) {
    try {
        const { data } = await supabaseClient
            .from('students')
            .select('*')
            .eq('stud_id', studentId)
            .maybeSingle();

        document.getElementById('idSuccess').innerHTML = '';
        if (data) {
            studentData = data;
            await fillStudentFields(data);
            studentInfoCard.classList.add('show');
            document.getElementById('idSuccess').innerHTML = '<i class="fa-solid fa-check-circle"></i> Student found! Ready to scan.';
        } else {
            studentData = null;
            document.getElementById('idError').textContent = '⚠ Student not found.';
        }
        updateScanButtonsState();
    } catch (err) { console.error(err); }
}

async function fillStudentFields(data) {
    document.getElementById('s_firstName').value  = data.first_name  || '';
    document.getElementById('s_middleName').value = data.middle_name || '';
    document.getElementById('s_lastName').value   = data.last_name   || '';
    document.getElementById('s_email').value      = data.email       || '';

    let gradeLevel = 'N/A';
    let sectionName = 'N/A';
    
    if (data.section_id) {
        try {
            const { data: sectionData } = await supabaseClient
                .from('sections')
                .select('grade_level, section_name')
                .eq('section_id', data.section_id)
                .maybeSingle();
            
            if (sectionData) {
                gradeLevel = sectionData.grade_level || 'N/A';
                sectionName = sectionData.section_name || 'N/A';
            }
        } catch (err) {
            console.error('Error fetching section:', err);
        }
    }
    
    document.getElementById('s_gradeLevel').value = gradeLevel;
    document.getElementById('s_sectionName').value = sectionName;

    document.getElementById('displayName').textContent        = `${data.first_name} ${data.last_name}`;
    document.getElementById('displayCourse').textContent      = gradeLevel;
    document.getElementById('displayYearSection').textContent = `${gradeLevel} - ${sectionName}`;
    document.getElementById('displayEmail').textContent       = data.email || 'N/A';

    const badge = document.getElementById('studentFaceBadge');
    badge.className = 'status-badge not-registered';
    badge.textContent = 'Checking...';

    const hasFace = await hasFaceFiles(data.facial_dataset_path);
    if (!studentData || studentData.student_id !== data.student_id) return;

    if (hasFace) {
        badge.className = 'status-badge registered';
        badge.textContent = '✓ Face Registered';
    } else {
        badge.className = 'status-badge not-registered';
        badge.textContent = '⚠ Not Registered';
    }
}

// ═══════════════════════════════════════════
// STUDENT CLEAR
// ═══════════════════════════════════════════
document.getElementById('studentClearBtn').addEventListener('click', () => {
    clearStudentForm();
});

// ═══════════════════════════════════════════
// PROFESSOR LOGIC
// ═══════════════════════════════════════════
empIdInput.addEventListener('input', function () {
    const val = this.value.trim();
    professorData = null;
    updateScanButtonsState();
    
    if (val.length >= 3) setTimeout(() => searchProfessor(val), 600);
});

async function searchProfessor(id) {
    const { data } = await supabaseClient
        .from('teachers')
        .select('*')
        .eq('employee_id', id)
        .maybeSingle();

    if (data) {
        professorData = data;
        await fillProfessorFields(data);
        professorInfoCard.classList.add('show');
    } else {
        professorData = null;
    }
    updateScanButtonsState();
}

async function fillProfessorFields(data) {
    document.getElementById('p_firstName').value  = data.first_name  || '';
    document.getElementById('p_middleName').value = data.middle_name || '';
    document.getElementById('p_lastName').value   = data.last_name   || '';
    document.getElementById('p_department').value = 'N/A';
    document.getElementById('p_email').value      = data.email       || '';

    document.getElementById('p_displayName').textContent  = `${data.first_name} ${data.last_name}`;
    document.getElementById('p_displayDept').textContent  = 'N/A';
    document.getElementById('p_displayEmpId').textContent = data.employee_id || 'N/A';
    document.getElementById('p_displayEmail').textContent = data.email       || 'N/A';

    const badge = document.getElementById('professorFaceBadge');
    badge.className = 'status-badge not-registered';
    badge.textContent = 'Checking...';

    const hasFace = await hasFaceFiles(data.facial_dataset_path);
    if (!professorData || professorData.teacher_id !== data.teacher_id) return;

    if (hasFace) {
        badge.className = 'status-badge registered';
        badge.textContent = '✓ Face Registered';
    } else {
        badge.className = 'status-badge not-registered';
        badge.textContent = '⚠ Not Registered';
    }
}

// ═══════════════════════════════════════════
// PROFESSOR SCAN BUTTON
// ═══════════════════════════════════════════
professorScanBtn.addEventListener('click', async () => {
    if (!professorData || !isEngineOnline) return;

    const btn = document.getElementById('professorScanBtn');
    btn.disabled = true;
    cameraContainer.style.display = 'flex';

    try {
        captureStatus.innerHTML = '<i class="fa-solid fa-broom fa-spin"></i> Purging old data & preparing camera...';

        await fetch(`${REG_ENGINE_BASE}/start_registration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id_number: professorData.employee_id,
                firstName: professorData.first_name,
                lastName:  professorData.last_name,
                role:      'professor'
            })
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
        openCameraUI();

    } catch (err) {
        cameraContainer.style.display = 'none';
        alert("❌ Registration Error: " + err.message);
    } finally {
        btn.disabled = false;
    }
});

// ═══════════════════════════════════════════
// PROFESSOR CLEAR
// ═══════════════════════════════════════════
document.getElementById('professorClearBtn').addEventListener('click', () => {
    clearProfessorForm();
});

// ═══════════════════════════════════════════
// ENGINE STATUS POLLING
// ═══════════════════════════════════════════
let _rebuildTimer = null;
async function triggerRebuild(force = false) {
    try {
        await fetch('http://127.0.0.1:5000/trigger_rebuild', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: !!force })
        });
        return true;
    } catch (e) {
        console.error('triggerRebuild error', e);
        return false;
    }
}

function triggerRebuildDebounced(force = false, wait = 300) {
    return new Promise(resolve => {
        if (_rebuildTimer) clearTimeout(_rebuildTimer);
        _rebuildTimer = setTimeout(async () => {
            const ok = await triggerRebuild(force);
            resolve(ok);
        }, wait);
    });
}

async function waitForAttendanceEngineReady(retries = 20, delayMs = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch('http://127.0.0.1:5000/engine_status', { cache: 'no-store' });
            if (res.ok) {
                const json = await res.json();
                if (json.face_db_ready) return true;
            }
        } catch (_) {}
        await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
}

setInterval(async () => {
    if (isBooting) {
        updateScanButtonsState();
        return; 
    }

    try {
        const res = await fetch(`${REG_ENGINE_BASE}/status`, { method: 'HEAD' });
        isEngineOnline = res.ok;
        document.getElementById('stopEngineBtn').style.display = isEngineOnline ? 'inline-flex' : 'none';
        document.getElementById('startEngineNavBtn').style.display = isEngineOnline ? 'none' : 'inline-flex';
    } catch (_) {
        isEngineOnline = false;
        document.getElementById('stopEngineBtn').style.display = 'none';
        document.getElementById('startEngineNavBtn').style.display = 'inline-flex';
    }
    
    updateScanButtonsState();
}, 3000);

async function bootRegistrationEngine() {
    const startBtn = document.getElementById('startEngineNavBtn');
    isBooting = true; 
    updateScanButtonsState();
    
    startBtn.disabled = true;
    startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booting...';

    try {
        const triggerRes = await fetch('trigger_registration.php', { method: 'POST' });
        const triggerJson = await triggerRes.json().catch(() => ({}));

        if ((triggerJson.status || '') === 'running') {
            isEngineOnline = true;
        } else {
            const ready = await waitForFlask(45, 1000);
            if (!ready) {
                console.warn('Registration engine is still booting in background.');
            }
        }
    } catch (err) {
        console.error("Registration engine startup check failed:", err);
    } finally {
        isBooting = false; 
        startBtn.disabled = false;
        startBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
        updateScanButtonsState();
    }
}

async function stopEngine() {
    const confirmed = confirm('Are you sure you want to stop the engine?');
    if (!confirmed) return;

    isBooting = false; 

    try {
        await fetch(`${REG_ENGINE_BASE}/shutdown`, { method: 'POST' });
    } catch (_) {}

    const startBtn = document.getElementById('startEngineNavBtn');
    const stopBtn = document.getElementById('stopEngineBtn');
    
    stopBtn.style.display = 'none';
    startBtn.style.display = 'inline-flex';
    startBtn.disabled = false;
    startBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
    
    isEngineOnline = false;
    updateScanButtonsState();
}