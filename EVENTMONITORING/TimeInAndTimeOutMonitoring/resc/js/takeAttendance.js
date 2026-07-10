/* ============================================================
   takeAttendance.js — School Attendance Edition
   Simplified for greeting-only facial recognition engine
============================================================ */

// ══════════════════════════════════════════════════
// GLOBAL ELEMENTS & STATE
// ══════════════════════════════════════════════════
const bootEngineBtn = document.getElementById('bootEngineBtn');
const startBtn      = document.getElementById('startBtn');
const stopBtn       = document.getElementById('stopBtn');
const stopEngineBtn = document.getElementById('stopEngineBtn');
const videoWrap     = document.getElementById('videoWrap');
const videoStream   = document.getElementById('videoStream');
const stripStatus   = document.getElementById('stripStatus');
const sessionState  = document.getElementById('sessionState');
const streamState   = document.getElementById('streamState');
const outputBox     = document.getElementById('outputBox');
const toast         = document.getElementById('toast');

// Greeting overlay elements
const greetOverlay   = document.getElementById('greetOverlay');
const greetCard      = document.getElementById('greetCard');
const greetAvatar    = document.getElementById('greetAvatar');
const greetName      = document.getElementById('greetName');
const greetMsg       = document.getElementById('greetMsg');
const greetCountdown = document.getElementById('greetCountdown');

let isBooting = false; 
let isEngineOnline = false;
let isFaceDbReady = false;
let currentFaceDbPhase = 'offline';
let _prevFaceDbPhase = currentFaceDbPhase;
let _prevRebuildSummaryTs = null;

let greetTimer = null;
let greetCountdownInterval = null;

// ══════════════════════════════════════════════════
// GREETING OVERLAY
// ══════════════════════════════════════════════════
function showGreeting(name, message, isSpoof = false) {
    clearTimeout(greetTimer);
    clearInterval(greetCountdownInterval);

    greetName.textContent = name || '';
    greetMsg.textContent = message || '';

    if (isSpoof) {
        greetCard.classList.add('spoof');
        greetAvatar.textContent = '❌';
    } else {
        greetCard.classList.remove('spoof');
        greetAvatar.textContent = '👋';
    }

    let remaining = 3;
    greetCountdown.textContent = `Auto-dismiss in ${remaining}s`;
    greetCountdownInterval = setInterval(() => {
        remaining--;
        greetCountdown.textContent = remaining > 0 ? `Auto-dismiss in ${remaining}s` : '';
        if (remaining <= 0) clearInterval(greetCountdownInterval);
    }, 1000);

    greetOverlay.classList.add('on');
    greetTimer = setTimeout(dismissGreeting, 3500);
}

function dismissGreeting() {
    clearTimeout(greetTimer);
    clearInterval(greetCountdownInterval);
    greetOverlay.classList.remove('on');
}

// Close greeting on click outside
greetOverlay.addEventListener('click', e => {
    if (e.target === greetOverlay) dismissGreeting();
});

// ══════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════
function renderStripStatus() {
    if (!isEngineOnline) {
        stripStatus.textContent = 'Offline';
        return;
    }
    if (isBooting || !isFaceDbReady) {
        stripStatus.textContent = phaseLabel(currentFaceDbPhase);
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

function updateSessionButtonState() {
    // Only freeze button state while a session is actively running.
    if (stopBtn.style.display !== 'none') return;

    if (isBooting) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Engine Booting...';
    } else if (!isEngineOnline) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fa-solid fa-power-off" style="color:#fca5a5;"></i> Please Start Engine First';
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

// Set initial state
renderStripStatus();
renderTileStates();
updateSessionButtonState();

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
    const shouldHide = isLive || (isEngineOnline && isFaceDbReady);
    outputBox.style.display = shouldHide ? 'none' : 'block';
}

function showToast(msg, colorClass, duration = 4000) {
    toast.textContent   = msg;
    toast.className     = colorClass;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, duration);
}

// ══════════════════════════════════════════════════
// ENGINE STATUS POLLING
// ══════════════════════════════════════════════════
async function fetchEngineStatus() {
    try {
        const res = await fetch('http://127.0.0.1:5000/engine_status', { method: 'GET' });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

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

            const status = await fetchEngineStatus();
            if (status) {
                isFaceDbReady = !!status.face_db_ready && status.face_db_phase === 'ready';
                const newPhase = status.face_db_phase || (isFaceDbReady ? 'ready' : 'starting');

                // Show popup when entering rebuilding phase
                if (newPhase === 'rebuilding' && _prevFaceDbPhase !== 'rebuilding') {
                    showToast('Syncing facial data — changes detected in database. Recognition continues while syncing.', 'bg-info', 6000);
                }

                // When finishing rebuild, show summary toast if available
                // When finishing rebuild, show a PROMINENT popup with the summary
                if (_prevFaceDbPhase === 'rebuilding' && newPhase === 'ready') {
                    try {
                        const last = status.last_rebuild_summary || null;
                        if (last && last.timestamp && last.timestamp !== _prevRebuildSummaryTs) {
                            _prevRebuildSummaryTs = last.timestamp;
                            const a = last.added || 0;
                            const u = last.updated || 0;
                            const r = last.removed || 0;
                            const k = last.kept || 0;
                            const t = Math.round((last.duration_ms || 0));

                            // 🎯 PROMINENT MODAL POPUP with rebuild stats
                            showNotif({
                                icon: '🔄',
                                title: 'Face Database Sync Complete',
                                msg: [
                                    `➕ Added: ${a} face profile(s)`,
                                    `🔄 Updated: ${u} face profile(s)`,
                                    `❌ Removed: ${r} face profile(s)`,
                                    `✅ Unchanged: ${k} face profile(s)`,
                                    ``,
                                    `⏱️ Duration: ${t} ms`
                                ].join('\n'),
                                buttons: [{ label: 'OK', color: 'green' }],
                                autoDismiss: 10
                            });

                            // Optional: keep the small toast as a secondary confirmation
                            showToast(`Sync complete: +${a} · ~${u} · -${r} · ${t}ms`, 'bg-success', 5000);
                        } else {
                            showNotif({
                                icon: '✅',
                                title: 'Face Database Validated',
                                msg: 'No changes detected. Your existing cache is up to date.',
                                buttons: [{ label: 'OK', color: 'green' }],
                                autoDismiss: 6
                            });
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

        bootEngineBtn.style.display = 'inline-flex';
        bootEngineBtn.disabled = false;
        bootEngineBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';

        if (startBtn.style.display === 'none') {
            stopAttendanceSession();
        }

        renderStripStatus();
        renderTileStates();
    }

    updateSessionButtonState();
}, 3000);

// ══════════════════════════════════════════════════
// ENGINE START / STOP
// ══════════════════════════════════════════════════
bootEngineBtn.addEventListener('click', async () => {
    isBooting = true;
    currentFaceDbPhase = 'starting';
    renderStripStatus();
    renderTileStates();
    updateSessionButtonState();

    bootEngineBtn.disabled = true;
    bootEngineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booting Engine...';
    setOutput('info', 'fa-solid fa-microchip fa-spin', '<span class="spin"></span> Starting Facial Recognition Engine...');

    try {
        await fetch('http://localhost/CAPSTONEFINAL/EVENTMONITORING/TimeInAndTimeOutMonitoring/students/trigger_attendance.php', { method: 'POST' });

        await waitForFlask(60, 1000); 

        bootEngineBtn.style.display = 'none';
        setOutput('success', 'fa-solid fa-check', 'Engine Online! You can now start the session.');
        if (stopEngineBtn) stopEngineBtn.style.display = 'inline-flex';
    } catch (err) {
        alert("Failed to start engine: " + err.message);
        setOutput('error', 'fa-solid fa-circle-exclamation', '❌ ' + err.message);
        bootEngineBtn.disabled = false;
        bootEngineBtn.innerHTML = '<i class="fa-solid fa-power-off"></i> Start Engine';
    } finally {
        isBooting = false;
        updateSessionButtonState();
    }
});

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

    stopAttendanceSession();
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
// SESSION START / STOP
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
    updateSessionButtonState();
}

// ══════════════════════════════════════════════════
// SSE — GREETING STREAM
// ══════════════════════════════════════════════════
if (window.EventSource) {
    const src = new EventSource('http://127.0.0.1:5000/attendee_stream');
    src.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            handleRecognitionEvent(d);
        } catch (err) { console.error('SSE parse error:', err); }
    };
    src.onerror = () => {
        console.log('SSE connection lost, will retry...');
    };
}

function handleRecognitionEvent(d) {
    // The simplified engine sends: { "message": "HELLO JOHN DOE", "name": "JOHN DOE" }
    // Or for spoof: { "message": "SPOOF DETECTED", "name": "...", "reason": "..." }

    const name = d.name || '';
    const message = d.message || '';

    if (message.includes('SPOOF') || message.includes('spoof')) {
        showGreeting(name, d.reason || 'Liveness check failed. Please present a real face.', true);
        showToast('Spoof detected — please use a real face', 'red', 4000);
        return;
    }

    if (message.startsWith('HELLO') || message.startsWith('Hello')) {
        showGreeting(name, message, false);
        return;
    }

    // Fallback for any other messages
    showGreeting(name, message, false);
}