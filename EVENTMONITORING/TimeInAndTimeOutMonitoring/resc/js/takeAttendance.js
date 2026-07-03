/* ============================================================
   takeAttendance.js
   Path: TimeInAndTimeOutMonitoring/resc/js/takeAttendance.js
============================================================ */

// ══════════════════════════════════════════════════
// GLOBAL ELEMENTS & STATE
// ══════════════════════════════════════════════════
const bootEngineBtn = document.getElementById('bootEngineBtn');
const startBtn      = document.getElementById('startBtn');
const stopBtn       = document.getElementById('stopBtn');
const stopEngineBtn = document.getElementById('stopEngineBtn'); // In the nav bar
const videoWrap     = document.getElementById('videoWrap');
const videoStream   = document.getElementById('videoStream');
const stripStatus   = document.getElementById('stripStatus');
const sessionState  = document.getElementById('sessionState');
const streamState   = document.getElementById('streamState');
const outputBox     = document.getElementById('outputBox');
const machineLabSummaryState = document.getElementById('machineLabSummaryState');
const machineLabSummaryLabel = document.getElementById('machineLabSummaryLabel');
const machineLabSummaryNote = document.getElementById('machineLabSummaryNote');
const machineLabOpenBtn = document.getElementById('machineLabOpenBtn');

const labAuthOverlay = document.getElementById('labAuthOverlay');
const labAuthUsername = document.getElementById('labAuthUsername');
const labAuthPassword = document.getElementById('labAuthPassword');
const labAuthError = document.getElementById('labAuthError');
const labAuthErrorMsg = document.getElementById('labAuthErrorMsg');
const labAuthSubmitBtn = document.getElementById('labAuthSubmitBtn');

const labModalOverlay = document.getElementById('labModalOverlay');

let isBooting = false; 
let isEngineOnline = false;
let isFaceDbReady = false;
let isMachineLabLoaded = false;
let machineLabAssignment = null;
let availableMachineLabs = [];
let currentFaceDbPhase = 'offline';
let _prevFaceDbPhase = currentFaceDbPhase;
let _prevRebuildSummaryTs = null;
let isLabAssignmentAuthVerified = false;

const LAB_ASSIGNMENT_AUTH_KEY = 'time_in_out_lab_assignment_superadmin_verified';

const machineLabSelect = document.getElementById('machineLabSelect');
const machineLabSaveBtn = document.getElementById('machineLabSaveBtn');
const machineLabState = document.getElementById('machineLabState');
const machineLabNote = document.getElementById('machineLabNote');

function getCurrentUser() {
    try {
        const raw = sessionStorage.getItem('user');
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function isCurrentUserSuperAdmin() {
    const user = getCurrentUser();
    return !!user && user.userType === 'admin' && user.adminLevel === 'super_admin';
}

function isLabAssignmentAuthorized() {
    return isLabAssignmentAuthVerified || sessionStorage.getItem(LAB_ASSIGNMENT_AUTH_KEY) === 'true' || isCurrentUserSuperAdmin();
}

function setLabAssignmentAuthorized() {
    isLabAssignmentAuthVerified = true;
    sessionStorage.setItem(LAB_ASSIGNMENT_AUTH_KEY, 'true');
}

function clearLabAuthState(clearUsername = false) {
    if (labAuthError) {
        labAuthError.classList.remove('show');
    }
    if (labAuthErrorMsg) {
        labAuthErrorMsg.textContent = '';
    }
    if (clearUsername && labAuthUsername) {
        labAuthUsername.value = '';
    }
    if (labAuthPassword) {
        labAuthPassword.value = '';
    }
}

function openLabAuthModal() {
    if (!labAuthOverlay) return;
    clearLabAuthState(true);
    labAuthOverlay.classList.add('show');
    if (labAuthUsername) labAuthUsername.focus();
}

function closeLabAuthModal() {
    if (!labAuthOverlay) return;
    labAuthOverlay.classList.remove('show');
    clearLabAuthState(true);
}

function openLabModal() {
    if (!labModalOverlay) return;
    labModalOverlay.classList.add('show');
    renderMachineLabLock();
    populateMachineLabSelect();
}

function closeLabModal() {
    if (!labModalOverlay) return;
    labModalOverlay.classList.remove('show');
}

async function ensureSuperAdminForLabAssignment() {
    if (isLabAssignmentAuthorized()) {
        openLabModal();
        return true;
    }

    openLabAuthModal();
    return false;
}

function renderStripStatus() {
    if (!isEngineOnline) {
        stripStatus.textContent = 'Offline';
        return;
    }

    if (isBooting || !isFaceDbReady) {
        const label = phaseLabel(currentFaceDbPhase);
        stripStatus.textContent = label;
        return;
    }

    if (!isMachineLabLoaded) {
        stripStatus.textContent = 'Loading terminal lock';
        return;
    }

    if (!machineLabAssignment || !machineLabAssignment.configured) {
        stripStatus.textContent = 'Lab unassigned';
        return;
    }

    stripStatus.innerHTML = '<div class="pulse"></div>Ready';
}

function renderTileStates() {
    const isLive = stopBtn.style.display !== 'none';

    if (isLive) {
        sessionState.textContent = 'Live';
        if (streamState) streamState.textContent = 'Camera Live';
    } else if (!isEngineOnline) {
        sessionState.textContent = 'Engine Off';
        if (streamState) streamState.textContent = 'Waiting Engine';
    } else if (!isMachineLabLoaded) {
        sessionState.textContent = 'Loading Lock';
        if (streamState) streamState.textContent = 'Waiting configuration';
    } else if (!machineLabAssignment || !machineLabAssignment.configured) {
        sessionState.textContent = 'Lab Unassigned';
        if (streamState) streamState.textContent = 'Configure terminal';
    } else if (!isFaceDbReady) {
        sessionState.textContent = 'Preparing';
        if (streamState) streamState.textContent = 'Initializing';
    } else {
        sessionState.textContent = 'Ready';
        if (streamState) streamState.textContent = 'Camera Standby';
    }

    refreshOutputVisibility();
}

function phaseLabel(phase) {
    const map = {
        starting: 'Initializing engine',
        loading_cache: 'Loading local cache',
        validating: 'Validating cache',
        rebuilding: 'Rebuilding from source',
        ready: 'Face DB ready',
        error: 'Face DB load error'
    };
    return map[phase] || 'Starting engine';
}

function formatMs(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
    return `${Math.round(ms)} ms`;
}

function machineLabLabel(lab) {
    if (!lab || !lab.configured) return 'Unassigned';
    const code = (lab.lab_code || '').trim();
    const name = (lab.lab_name || '').trim();
    if (code && name) return `${code} - ${name}`;
    if (code) return code;
    if (name) return name;
    return 'Configured';
}

function renderMachineLabLock() {
    const label = machineLabLabel(machineLabAssignment);
    if (machineLabSummaryState) {
        machineLabSummaryState.textContent = machineLabAssignment && machineLabAssignment.configured ? 'Locked' : 'Unassigned';
        machineLabSummaryState.style.background = machineLabAssignment && machineLabAssignment.configured ? '#eaf5ee' : '#fff7ed';
        machineLabSummaryState.style.color = machineLabAssignment && machineLabAssignment.configured ? '#1a4731' : '#9a3412';
    }

    if (machineLabSummaryLabel) {
        machineLabSummaryLabel.textContent = machineLabAssignment && machineLabAssignment.configured ? label : 'No laboratory assigned';
    }

    if (machineLabSummaryNote) {
        machineLabSummaryNote.textContent = machineLabAssignment && machineLabAssignment.configured
            ? 'This terminal is locked to one laboratory. Use the assignment dialog to change it.'
            : 'This terminal is not yet linked to a laboratory.';
    }

    if (machineLabOpenBtn) {
        machineLabOpenBtn.innerHTML = isLabAssignmentAuthorized()
            ? '<i class="fa-solid fa-user-shield"></i> Change Assignment'
            : '<i class="fa-solid fa-user-shield"></i> Authorize & Configure';
    }

    if (machineLabState) {
        machineLabState.textContent = machineLabAssignment && machineLabAssignment.configured ? 'Locked' : 'Unassigned';
        machineLabState.style.background = machineLabAssignment && machineLabAssignment.configured ? '#eaf5ee' : '#fff7ed';
        machineLabState.style.color = machineLabAssignment && machineLabAssignment.configured ? '#1a4731' : '#9a3412';
    }

    if (machineLabNote) {
        if (!isMachineLabLoaded) {
            machineLabNote.innerHTML = 'Loading terminal assignment from the local configuration file...';
        } else if (!machineLabAssignment || !machineLabAssignment.configured) {
            machineLabNote.innerHTML = '<span class="lab-lock-warning">This terminal is not locked yet.</span> Pick the correct laboratory and save it before running sessions.';
        } else {
            machineLabNote.innerHTML = `This terminal is currently locked to <strong>${label}</strong>. The setting is persisted on this PC.`;
        }
    }

    if (machineLabSaveBtn) {
        machineLabSaveBtn.disabled = !availableMachineLabs.length;
    }
}

function populateMachineLabSelect() {
    if (!machineLabSelect) return;

    const currentLabId = machineLabAssignment && machineLabAssignment.lab_id != null
        ? String(machineLabAssignment.lab_id)
        : '';

    machineLabSelect.innerHTML = '<option value="">Select a laboratory...</option>';

    if (!availableMachineLabs.length) {
        machineLabSelect.innerHTML = '<option value="">No laboratories found</option>';
        machineLabSelect.disabled = true;
        return;
    }

    availableMachineLabs.forEach(lab => {
        const option = document.createElement('option');
        option.value = String(lab.lab_id);
        option.textContent = `${lab.lab_code || 'Lab'} - ${lab.lab_name || 'Unnamed'}`;
        if (lab.building) option.textContent += ` (${lab.building})`;
        if (currentLabId && currentLabId === String(lab.lab_id)) option.selected = true;
        machineLabSelect.appendChild(option);
    });

    machineLabSelect.disabled = false;
}

async function fetchAvailableMachineLabs() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        availableMachineLabs = [];
        populateMachineLabSelect();
        renderMachineLabLock();
        return;
    }

    try {
        const { data, error } = await supabaseClient
            .from('laboratory_rooms')
            .select('lab_id, lab_code, lab_name, building')
            .order('lab_code', { ascending: true });

        if (error) throw error;
        availableMachineLabs = Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Failed to load laboratories:', err);
        availableMachineLabs = [];
    }

    populateMachineLabSelect();
    renderMachineLabLock();
}

async function fetchMachineLabAssignment() {
    try {
        const res = await fetch('machine_lab_config.php', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        machineLabAssignment = data.assignment || null;
    } catch (err) {
        console.error('Failed to load machine lab assignment:', err);
        machineLabAssignment = { configured: false };
    } finally {
        if (isCurrentUserSuperAdmin()) {
            setLabAssignmentAuthorized();
        }
        isMachineLabLoaded = true;
        populateMachineLabSelect();
        renderMachineLabLock();
        renderStripStatus();
        renderTileStates();
        updateSessionButtonState();
    }
}

async function saveMachineLabAssignment() {
    if (!machineLabSelect || machineLabSelect.disabled) return;

    const selectedLabId = machineLabSelect.value;
    const selectedLab = availableMachineLabs.find(lab => String(lab.lab_id) === String(selectedLabId));

    if (!selectedLab) {
        setOutput('error', 'fa-solid fa-circle-exclamation', 'Please select a laboratory before saving the machine lock.');
        return;
    }

    machineLabSaveBtn.disabled = true;
    machineLabSaveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const res = await fetch('machine_lab_config.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lab_id: selectedLab.lab_id,
                lab_code: selectedLab.lab_code,
                lab_name: selectedLab.lab_name,
                building: selectedLab.building
            })
        });

        const json = await res.json();
        if (!res.ok || !json.success) {
            throw new Error(json.message || 'Unable to save laboratory assignment.');
        }

        machineLabAssignment = json.assignment || null;
        localStorage.setItem('time_in_out_machine_lab_assignment', JSON.stringify(machineLabAssignment || {}));
        renderMachineLabLock();
        renderStripStatus();
        renderTileStates();
        updateSessionButtonState();
        setOutput('success', 'fa-solid fa-floppy-disk', `Machine locked to ${machineLabLabel(machineLabAssignment)}.`);
        closeLabModal();
    } catch (err) {
        console.error(err);
        setOutput('error', 'fa-solid fa-circle-exclamation', `Could not save the laboratory lock: ${err.message || err}`);
    } finally {
        machineLabSaveBtn.disabled = false;
        machineLabSaveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Assignment';
    }
}

async function submitLabAuthCredentials() {
    if (!labAuthSubmitBtn) return;

    const username = labAuthUsername ? labAuthUsername.value.trim() : '';
    const password = labAuthPassword ? labAuthPassword.value : '';

    if (!username || !password) {
        if (labAuthError) labAuthError.classList.add('show');
        if (labAuthErrorMsg) labAuthErrorMsg.textContent = 'Please enter both the superadmin username and password.';
        return;
    }

    labAuthSubmitBtn.disabled = true;
    labAuthSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) {
            throw new Error('Database connection not available.');
        }

        const buildQuery = () => supabaseClient
            .from('admins')
            .select('admin_id, admin_name, email, admin_level, status')
            .eq('status', 'active')
            .eq('admin_level', 'super_admin')
            .eq('password', password);

        const [emailResult, nameResult] = await Promise.all([
            buildQuery().eq('email', username).maybeSingle(),
            buildQuery().eq('admin_name', username).maybeSingle()
        ]);

        const adminData = emailResult.data || nameResult.data || null;
        const queryError = [emailResult.error, nameResult.error].find(err => err && err.code !== 'PGRST116');

        if (queryError) throw queryError;

        if (!adminData) {
            if (labAuthError) labAuthError.classList.add('show');
            if (labAuthErrorMsg) labAuthErrorMsg.textContent = 'Invalid superadmin credentials. Access to the lab picker is blocked.';
            if (labAuthPassword) labAuthPassword.value = '';
            if (labAuthPassword) labAuthPassword.focus();
            return;
        }

        setLabAssignmentAuthorized();
        closeLabAuthModal();
        openLabModal();
        renderMachineLabLock();
    } catch (err) {
        console.error('Superadmin verification failed:', err);
        if (labAuthError) labAuthError.classList.add('show');
        if (labAuthErrorMsg) labAuthErrorMsg.textContent = err.message || 'Could not verify superadmin credentials.';
    } finally {
        labAuthSubmitBtn.disabled = false;
        labAuthSubmitBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Verify & Continue';
    }
}

async function fetchEngineStatus() {
    try {
        const res = await fetch('http://127.0.0.1:5000/engine_status', { method: 'GET' });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

// ══════════════════════════════════════════════════
// NEW: DYNAMIC BUTTON CONTROLLER
// ══════════════════════════════════════════════════
function updateSessionButtonState() {
    // Only freeze button state while an attendance session is actively running.
    if (stopBtn.style.display !== 'none') return;

    if (isBooting) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Engine Booting...';
    } else if (!isEngineOnline) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-power-off" style="color:#fca5a5;"></i> Please Start Engine First';
    } else if (!isMachineLabLoaded) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading Terminal Lock...';
        setOutput('info', 'fa-solid fa-flask', 'Loading this machine\'s laboratory assignment...');
    } else if (!machineLabAssignment || !machineLabAssignment.configured) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-flask"></i> Configure Laboratory First';
        setOutput('error', 'fa-solid fa-flask', 'This terminal is not assigned to a laboratory yet. Choose the correct lab in the lock panel and save it before starting a session.');
    } else if (!isFaceDbReady) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-database"></i> Preparing Face Database...';
        setOutput('info', 'fa-solid fa-database', 'Preparing face data. Start Session will appear automatically when scanning is ready.');
    } else {
        startBtn.style.display = 'inline-flex';
        startBtn.disabled = false;
        startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Session';
    }

    renderTileStates();
}

// Set the initial state as soon as the page loads
renderStripStatus();
renderTileStates();
updateSessionButtonState();
if (machineLabOpenBtn) {
    machineLabOpenBtn.addEventListener('click', () => {
        // Always require credential verification before allowing lab changes
        isLabAssignmentAuthVerified = false;
        sessionStorage.removeItem(LAB_ASSIGNMENT_AUTH_KEY);
        openLabAuthModal();
    });
}
if (labAuthSubmitBtn) {
    labAuthSubmitBtn.addEventListener('click', submitLabAuthCredentials);
}
if (labAuthPassword) {
    labAuthPassword.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            submitLabAuthCredentials();
        }
    });
}
if (machineLabSaveBtn) {
    machineLabSaveBtn.addEventListener('click', saveMachineLabAssignment);
}
fetchAvailableMachineLabs();
fetchMachineLabAssignment();

// ══════════════════════════════════════════════════
// Real-time clock & Output Box
// ══════════════════════════════════════════════════
function updateTime() {
    const now = new Date();
    document.getElementById('timestamp').textContent =
        now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
        + ' · ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(updateTime, 1000);
updateTime();

function setOutput(type, icon, msg) {
    outputBox.style.display = 'block';
    outputBox.className = 'output-box show ' + type;
    outputBox.querySelector('i').className = 'fa-solid ' + icon;
    document.getElementById('outputText').innerHTML = msg;
}

function refreshOutputVisibility() {
    const isLive = stopBtn.style.display !== 'none';
    const shouldHide = isLive || (isEngineOnline && isFaceDbReady && machineLabAssignment && machineLabAssignment.configured);
    outputBox.style.display = shouldHide ? 'none' : 'block';
}

// ══════════════════════════════════════════════════
// ENGINE POLLING & STOP
// ══════════════════════════════════════════════════
setInterval(async () => {
    if (isBooting) {
        updateSessionButtonState();
        return; 
    }

    try {
        const res = await fetch('http://127.0.0.1:5000/', { method: 'GET' });
        isEngineOnline = (res.ok || res.status === 200);
        
        if (isEngineOnline) {
            if (stopEngineBtn) stopEngineBtn.style.display = 'inline-flex';
            bootEngineBtn.style.display = 'none';

            // Always poll backend readiness while online so hidden Start button can reappear.
            const status = await fetchEngineStatus();
            if (status) {
             
                isFaceDbReady = !!status.face_db_ready && status.face_db_phase === 'ready';
                const newPhase = status.face_db_phase || (isFaceDbReady ? 'ready' : 'starting');

                // Show popup when entering rebuilding phase
                if (newPhase === 'rebuilding' && _prevFaceDbPhase !== 'rebuilding') {
                    showNotif({
                        icon: '🔄',
                        title: 'Background Sync',
                        msg: 'Syncing facial data — changes detected in database. Recognition continues while syncing.',
                        buttons: [],
                        autoDismiss: 6
                    });
                }

                // When finishing rebuild, show summary toast if available
                if (_prevFaceDbPhase === 'rebuilding' && newPhase === 'ready') {
                    try {
                        const last = status.last_rebuild_summary || null;
                        if (last && last.timestamp && last.timestamp !== _prevRebuildSummaryTs) {
                            _prevRebuildSummaryTs = last.timestamp;
                            const a = last.added || 0;
                            const u = last.updated || 0;
                            const r = last.removed || 0;
                            const t = Math.round((last.duration_ms || 0));
                            showToast(`Background sync complete: +${a} added · ~${u} updated · -${r} removed · ${t}ms`, 'bg-success', 6000);
                        } else {
                            showToast('Background sync complete — database validated', 'bg-success', 4000);
                        }
                    } catch (e) {}
                }

                currentFaceDbPhase = newPhase;
                _prevFaceDbPhase = currentFaceDbPhase;
            }
            renderStripStatus();
            renderTileStates();
        }
    } catch (_) {
        isEngineOnline = false;
        isFaceDbReady = false;
        currentFaceDbPhase = 'offline';
        if (stopEngineBtn) stopEngineBtn.style.display = 'none';
        
        // Force reset the boot button to original state if engine dies
        bootEngineBtn.style.display = 'inline-flex';
        bootEngineBtn.disabled = false;
        bootEngineBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
        
        // If the engine crashes while a session is running, force stop the session
        if (startBtn.style.display === 'none') {
            stopAttendanceSession();
        }

        renderStripStatus();
        renderTileStates();
    }
    
    updateSessionButtonState(); // Update the "Start Session" button every 3 seconds
}, 3000);

// Hardware Boot Listener
bootEngineBtn.addEventListener('click', async () => {
    isBooting = true;
    currentFaceDbPhase = 'starting';
    renderStripStatus();
    renderTileStates();
    updateSessionButtonState(); // Forces "Booting..." state on the Start Session button
    
    bootEngineBtn.disabled = true;
    bootEngineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booting Engine...';
    setOutput('info', 'fa-solid fa-microchip fa-spin', '<span class="spin"></span> Starting Facial Recognition Engine...');

    try {
        await fetch('http://localhost/INTEG%20SYSTEM/SmartAcademicManagementSystem/TimeInAndTimeOutMonitoring/students/trigger_attendance.php', { method: 'POST' });
        
        await waitForFlask(60, 1000); 

        bootEngineBtn.style.display = 'none';
        setOutput('success', 'fa-solid fa-check', 'Engine Online! You can now start the session.');
        if (stopEngineBtn) stopEngineBtn.style.display = 'inline-flex';
    } catch (err) {
        if (bootEngineBtn.disabled) {
            alert("Failed to start engine: " + err.message);
        }
        setOutput('error', 'fa-solid fa-circle-exclamation', '❌ ' + err.message);
        bootEngineBtn.disabled = false;
        bootEngineBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
    } finally {
        isBooting = false;
        updateSessionButtonState(); // Unlocks the Start Session button
    }
});

// Manual Stop Engine Function
async function stopEngine() {
    const confirmed = confirm('Are you sure you want to stop the engine?');
    if (!confirmed) return;

    isBooting = false; 

    try {
        await fetch('http://127.0.0.1:5000/shutdown', { method: 'POST' });
    } catch (_) {}

    if (stopEngineBtn) stopEngineBtn.style.display = 'none';
    bootEngineBtn.style.display = 'inline-flex';
    bootEngineBtn.disabled = false;
    bootEngineBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
    
    stopAttendanceSession(); // Resets the UI if a session was active
    isEngineOnline = false;
    isFaceDbReady = false;
    currentFaceDbPhase = 'offline';
    renderStripStatus();
    renderTileStates();
    updateSessionButtonState(); 
}

async function waitForFlask(retries = 60, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch('http://127.0.0.1:5000/', { method: 'GET' });
            if (res.ok || res.status === 200) {
                const status = await fetchEngineStatus();
                if (status) {
                    
                isFaceDbReady = !!status.face_db_ready && status.face_db_phase === 'ready';
                    const phase = phaseLabel(status.face_db_phase);
                    const source = status.data_source === 'cache' ? 'cache' : 'remote';
                    const total = formatMs(status?.durations_ms?.total_startup);
                    const suffix = total ? ` (${total})` : '';
                    setOutput('success', 'fa-solid fa-check', `Engine online. ${phase} via ${source}${suffix}.`);
                }
                return true;
            }
        } catch (_) {}

        let msg = `<span class="spin"></span> Starting engine services... (${i + 1}/${retries})`;
        const status = await fetchEngineStatus();
        if (status) {
            const phase = phaseLabel(status.face_db_phase);
            const source = status.data_source === 'cache' ? 'cache' : 'remote';
            msg = `<span class="spin"></span> ${phase} (${source})... (${i + 1}/${retries})`;
        }
        setOutput('info', 'fa-solid fa-circle-notch fa-spin', msg);
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Engine did not respond. Check Task Manager for pythonw.exe');
}

// ══════════════════════════════════════════════════
// Start / Stop Class Session
// ══════════════════════════════════════════════════
startBtn.addEventListener('click', async () => {
    if (!isEngineOnline) return;

    if (!isFaceDbReady) {
        setOutput('info', 'fa-solid fa-database', 'Face database is still warming up. Please wait for Start Session to appear.');
        return;
    }

    startBtn.disabled = true;
    sessionState.textContent = 'Live';
    if (streamState) streamState.textContent = 'Camera Live';
    
    videoWrap.style.display  = 'block';
    videoStream.src = 'http://127.0.0.1:5000/video_feed?t=' + Date.now();
    
    startBtn.style.display   = 'none';
    stopBtn.style.display    = 'inline-flex';
    stripStatus.innerHTML    = '<div class="pulse"></div>Live';
    
    setOutput('success', 'fa-solid fa-circle-check', 'Attendance session is live! Ready for scans.');
});

stopBtn.addEventListener('click', () => {
    if (!confirm('Stop the current attendance session? Camera will close.')) return;
    stopAttendanceSession();
    setOutput('info', 'fa-solid fa-circle-info', 'Session ended. Click Start to resume.');
});

function stopAttendanceSession() {
    videoWrap.style.display = 'none';
    videoStream.src = "";
    stopBtn.style.display = 'none';
    startBtn.style.display = isFaceDbReady ? 'inline-flex' : 'none';
    renderStripStatus();
    renderTileStates();
    updateSessionButtonState(); // Ensures the button resets to the correct text
}

// ══════════════════════════════════════════════════
// NOTIFICATION HELPERS & SSE
// ══════════════════════════════════════════════════
const overlay           = document.getElementById('notifOverlay');
const notifIcon         = document.getElementById('notifIcon');
const notifTitle        = document.getElementById('notifTitle');
const notifMsg          = document.getElementById('notifMsg');
const notifBtns         = document.getElementById('notifBtns');
const lateBadge         = document.getElementById('lateBadge');
const dismissInfo       = document.getElementById('dismissInfo');
const cannotTimeOutInfo = document.getElementById('cannotTimeOutInfo');
const notifCountdown    = document.getElementById('notifCountdown');
const toast             = document.getElementById('toast');

let autoDismissTimer  = null;
let countdownInterval = null;
const pendingStudentActions = new Map();
const STUDENT_CONFIRM_DELAY_MS = 0;
const STUDENT_ACTION_PENDING_TTL_MS = 4000;
let professorPopupSuppressedUntil = 0;

function isStudentActionPending(actionKey) {
    if (!actionKey) return false;
    const now = Date.now();
    for (const [key, expiresAt] of pendingStudentActions.entries()) {
        if (expiresAt <= now) {
            pendingStudentActions.delete(key);
        }
    }
    const expiresAt = pendingStudentActions.get(actionKey);
    return typeof expiresAt === 'number' && expiresAt > now;
}

function markStudentActionPending(actionKey, ttlMs = STUDENT_ACTION_PENDING_TTL_MS) {
    if (!actionKey) return;
    pendingStudentActions.set(actionKey, Date.now() + Math.max(500, Number(ttlMs) || 0));
}

function clearStudentActionPending(actionKey) {
    if (!actionKey) return;
    pendingStudentActions.delete(actionKey);
}

function suppressProfessorPopups(durationMs = 2500) {
    professorPopupSuppressedUntil = Date.now() + durationMs;
}

function showToast(msg, colorClass, duration = 4000) {
    toast.textContent   = msg;
    toast.className     = colorClass;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, duration);
}

function showNotif({ icon, title, msg, lateTxt, dismissTxt, cannotTimeOutTxt, buttons, autoDismiss = 15 }) {
    clearTimeout(autoDismissTimer);
    clearInterval(countdownInterval);

    notifIcon.textContent  = icon;
    notifTitle.textContent = title;
    notifMsg.textContent   = msg;

    if (lateTxt) { lateBadge.innerHTML = `⚠️ ${lateTxt}`; lateBadge.classList.add('show'); }
    else         { lateBadge.classList.remove('show'); lateBadge.innerHTML = ''; }

    if (dismissTxt) { dismissInfo.innerHTML = dismissTxt; dismissInfo.classList.add('show'); }
    else            { dismissInfo.classList.remove('show'); dismissInfo.innerHTML = ''; }

    if (cannotTimeOutTxt) { cannotTimeOutInfo.innerHTML = cannotTimeOutTxt; cannotTimeOutInfo.classList.add('show'); }
    else                  { cannotTimeOutInfo.classList.remove('show'); cannotTimeOutInfo.innerHTML = ''; }

    notifBtns.innerHTML = '';
    buttons.forEach(btn => {
        const el       = document.createElement('button');
        el.className   = 'notif-confirm-btn ' + btn.color;
        el.textContent = btn.label;
        el.onclick     = () => { closeNotif(); if (btn.action) btn.action(); };
        notifBtns.appendChild(el);
    });

    let remaining = autoDismiss;
    if (remaining > 0) {
        notifCountdown.textContent = `Auto-dismiss in ${remaining}s`;
        countdownInterval = setInterval(() => {
            remaining--;
            notifCountdown.textContent = remaining > 0 ? `Auto-dismiss in ${remaining}s` : '';
            if (remaining <= 0) clearInterval(countdownInterval);
        }, 1000);
        autoDismissTimer = setTimeout(closeNotif, autoDismiss * 1000);
    } else {
        notifCountdown.textContent = '';
    }

    requestAnimationFrame(() => overlay.classList.add('show'));
}

function formatScheduleLines(schedule) {
    if (!schedule || typeof schedule !== 'object') return '';

    const section = schedule.section ? `(${schedule.section})` : '—';
    const lab = schedule.lab_code || schedule.lab_name || '—';
    const day = schedule.day_of_week || '';
    return `${section} - ${lab}${day ? ` ${day}` : ''}`.replace(/\s+/g, ' ').trim();
}

function formatSubjectLine(schedule) {
    if (!schedule || typeof schedule !== 'object') return '';
    const subjectCode = schedule.subject_code || schedule.subject || '—';
    const subjectName = schedule.subject_name ? ` ${schedule.subject_name}` : '';
    return `Subject: ${subjectCode}${subjectName}`.trim();
}

function formatTimeLine(schedule) {
    if (!schedule || typeof schedule !== 'object') return '';
    const day = schedule.day_of_week || '';
    const start = formatDisplayTime(schedule.start_time || schedule.start_time_display);
    const end = formatDisplayTime(schedule.end_time || schedule.end_time_display);
    const range = start && end ? `${start} - ${end}` : (start || end || '');
    return [day, range].filter(Boolean).join(' | ');
}

function formatModalBody(schedule) {
    const lines = [];
    const subjectLine = formatSubjectLine(schedule);
    const scheduleLine = formatScheduleLines(schedule);
    const timeLine = formatTimeLine(schedule);

    if (subjectLine) lines.push(subjectLine);
    if (scheduleLine) lines.push(`Student & Lab: ${scheduleLine}`);
    if (timeLine) lines.push(`Time: ${timeLine}`);

    return lines.join('\n\n');
}

function formatDisplayTime(value) {
    if (!value) return '';
    const text = String(value).trim();
    if (!text) return '';

    if (/\b(AM|PM)\b/i.test(text)) {
        return text.replace(/\s+/g, ' ').toUpperCase();
    }

    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return text;

    let hours = Number(match[1]);
    const minutes = match[2];
    const seconds = match[3] || '00';
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${String(hours).padStart(2, '0')}:${minutes} ${suffix}`;
}

function closeNotif() {
    clearTimeout(autoDismissTimer);
    clearInterval(countdownInterval);
    overlay.classList.remove('show');
    notifCountdown.textContent = '';
}

overlay.addEventListener('click', e => { if (e.target === overlay) closeNotif(); });

// Listen to Face Recognition Events
if (window.EventSource) {
    const src = new EventSource('http://127.0.0.1:5000/attendee_stream');
    src.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.action === 'LOADING') return;
            d.role === 'student' ? handleStudentEvent(d) : handleProfessorEvent(d);
        } catch (err) { console.error('SSE parse error:', err); }
    };
}

// ══════════════════════════════════════════════════
// STUDENT & PROFESSOR HANDLERS
// ══════════════════════════════════════════════════
function handleStudentEvent(d) {
    const name = d.name || 'Student';
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const actionKey = `${d.student_id || ''}|${d.session_id || ''}|${d.action || ''}`;
    const scheduleText = formatModalBody(d.schedule);

    const withSchedule = (msg) => scheduleText ? `${msg}\n\n${scheduleText}` : msg;

    switch (d.action) {
        case 'IN':
            if (isStudentActionPending(actionKey)) return;
            markStudentActionPending(actionKey);
            showNotif({ 
                icon: d.is_late ? '⚠️' : '🟢',
                title: d.is_late ? 'Saving Time IN — Late...' : 'Saving Time IN...',
                msg: withSchedule(`${name}\nTime: ${time}`),
                lateTxt: d.is_late ? `You are LATE by ${d.late_minutes} minute${d.late_minutes !== 1 ? 's' : ''}` : null,
                buttons: [],   
                    autoDismiss: 0 
            });
            setTimeout(() => confirmStudent(d, actionKey), STUDENT_CONFIRM_DELAY_MS);
            break;
        case 'OUT':
            if (isStudentActionPending(actionKey)) return;
            markStudentActionPending(actionKey);
            showNotif({ 
                icon: '🔵', title: 'Saving Time OUT...', msg: withSchedule(`${name}\nTime: ${time}`),
                    buttons: [], autoDismiss: 0 
            });
            setTimeout(() => confirmStudent(d, actionKey), STUDENT_CONFIRM_DELAY_MS);
            break;
        case 'COMPLETED':
            showNotif({ 
                icon: '✅', title: 'Attendance Complete', 
                msg: withSchedule(`${name}\nYou have already timed in and timed out for this session.`), 
                buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 4 
            });
            break;
        case 'NOT_ENROLLED':
            showNotif({ icon: '📋', title: 'Not Enrolled', msg: withSchedule(d.error), buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 4 });
            break;
        case 'SESSION_NOT_STARTED':
            showNotif({ icon: '⏳', title: 'Session Not Started Yet', 
                msg: withSchedule(d.error || 'Your professor has not started the session yet. Please wait.'),
                buttons: [{ label: 'OK', color: 'orange' }], autoDismiss: 8 });
        break;

        case 'ALL_DONE':
             showNotif({ icon: '✅', title: 'All Classes Done', 
              msg: withSchedule(d.error || 'You have no more classes for today. Great job!'),
               buttons: [{ label: 'OK', color: 'gray' }], autoDismiss: 5 });
             break;
        case 'CANNOT_TIME_OUT':
            showNotif({ icon: '🔐', title: 'Cannot Time Out', msg: withSchedule(name), cannotTimeOutTxt: d.error, buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 6 });
            break;
        case 'SESSION_CANCELLED':
            showNotif({ icon: '🚫', title: 'Session Voided', msg: withSchedule(d.error), buttons: [{ label: 'Dismiss', color: 'red' }], autoDismiss: 4 });
            break;
        case 'SESSION_ENDED':
            showNotif({ icon: '⏹', title: 'Session Ended', msg: withSchedule(d.error), buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 4 });
            break;
    }
}
function handleProfessorEvent(d) {
    const name = d.name || 'Professor';
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const scheduleText = formatModalBody(d.schedule);

    const withSchedule = (msg) => scheduleText ? `${msg}\n\n${scheduleText}` : msg;

    if (Date.now() < professorPopupSuppressedUntil) return;
    
    switch (d.action) {
        case 'START':
            showNotif({ 
                icon: '👨‍🏫', 
                title: name,
                msg: withSchedule('Professor\n\nTap Confirm to START the session.'),
                buttons: [
                    { label: '▶ Start Session', color: 'green', action: () => confirmProfessor(d) },
                    { label: 'Dismiss', color: 'gray' }
                ], 
                autoDismiss: 0
            });
            break;
        case 'DISMISS':
            showNotif({
                icon: '🚪',
                title: name,
                msg: withSchedule('Professor\n\nAllow students to TIME OUT and leave the lab.'),
                buttons: [
                    { label: '▶ Allow Time Out', color: 'orange', action: () => confirmProfessor(d) },
                    { label: 'Dismiss', color: 'gray' }
                ],
                autoDismiss: 0
            });
            break;
        case 'END':
            showNotif({
                icon: '⏹',
                title: name,
                msg: withSchedule('Professor\n\nEnd the session completely?'),
                buttons: [
                    { label: '⏹ End Session', color: 'red', action: () => confirmProfessor(d) },
                    { label: 'Dismiss', color: 'gray' }
                ],
                autoDismiss: 0
            });
            break;
            
        // ── ERROR HANDLERS ──
        case 'NO_SCHEDULE':
        case 'NO_VALID_SCHEDULE':
            showNotif({
                icon: '📅',
                title: 'No Valid Schedule',
                msg: withSchedule(d.error || 'No active professor schedule was found.'),
                buttons: [{ label: 'Dismiss', color: 'gray' }],
                autoDismiss: 5
            });
            break;
        case 'TOO_EARLY':
            showNotif({
                icon: '⏳',
                title: 'Too Early',
                msg: withSchedule(d.error || 'Please wait until the start window opens.'),
                buttons: [{ label: 'OK', color: 'orange' }],
                autoDismiss: 8
            });
            break;
        case 'WRONG_LAB':
            showNotif({ 
                icon: '⚠️', title: 'Wrong Laboratory', msg: withSchedule(d.error), 
                buttons: [{ label: 'Dismiss', color: 'red' }], autoDismiss: 6 
            });
            break;
            
        // ── NEW: SMART JUMP HANDLERS FOR PROFESSOR ──
        case 'ALL_DONE':
            showNotif({ 
                icon: '🎉', title: 'All Done!', msg: withSchedule(d.error), 
                buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 4 
            });
            break;
        case 'SESSION_ENDED':
            showNotif({ 
                icon: '✅', title: 'Session Completed', msg: withSchedule(d.error), 
                buttons: [{ label: 'Dismiss', color: 'gray' }], autoDismiss: 4 
            });
            break;
        case 'SESSION_CANCELLED':
            showNotif({ 
                icon: '🚫', title: 'Session Voided', msg: withSchedule(d.error), 
                buttons: [{ label: 'Dismiss', color: 'red' }], autoDismiss: 5 
            });
            break;
    }
}

function confirmStudent(d, actionKey = null) {
    fetch('http://127.0.0.1:5000/confirm_attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
    })
    .then(r => r.json())
    .then(res => {
        closeNotif();
        showToast(res.message, d.is_late ? 'amber' : 'green');
    })
    .catch(() => {
        closeNotif();
        showToast('❌ Error saving attendance', 'red');
    })
    .finally(() => {
        if (!actionKey) return;
        setTimeout(() => clearStudentActionPending(actionKey), 500);
    });
}

function confirmProfessor(d) {
    // Close the modal immediately when confirming
    closeNotif();
    suppressProfessorPopups(2500);
    
    fetch('http://127.0.0.1:5000/confirm_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
    })
    .then(r => r.json())
    .then(res => showToast(res.message, 'purple'))
    .catch(() => showToast('❌ Error updating session', 'red'));
}