/* ============================================================
   homepage.js — Public Lab Sessions Homepage
   Path: TimeInAndTimeOutMonitoring/resc/js/homepage.js
   ============================================================ */

const PROFESSOR_START_WINDOW = 45; // minutes before a session is dropped from scheduled list
const OVERDUE_GRACE_MINUTES  = 5;  // minutes AFTER start time before showing "Overdue"

// ── Date / Time Helpers ──────────────────────────────────

const today      = new Date().toLocaleDateString('en-CA');
const currentDay = new Date().toLocaleDateString('en-US', { weekday: 'long' });

function getCurrentTime() {
    const n = new Date();
    return [n.getHours(), n.getMinutes(), n.getSeconds()]
        .map(v => String(v).padStart(2, '0')).join(':');
}

function timeToDate(t) {
    if (!t) return null;
    const [h, m, s] = t.split(':');
    const d = new Date();
    d.setHours(+h, +m, +(s || 0), 0);
    return d;
}

function formatTime(t) {
    const d = timeToDate(t);
    if (!d) return '—';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function parseSessionLabFromNotes(notes) {
    const txt = String(notes || '');
    const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
    if (!m || !m[1]) return null;
    const label = m[1].trim();
    const parts = label.split(' - ');
    if (parts.length >= 2) {
        return { lab_code: parts[0].trim(), lab_name: parts.slice(1).join(' - ').trim(), building: null };
    }
    return { lab_code: label, lab_name: '', building: null };
}

// ── Live Clock ───────────────────────────────────────────

function tickClock() {
    const now = new Date();
    document.getElementById('liveClock').textContent =
        now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    document.getElementById('liveDate').textContent =
        now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

tickClock();
setInterval(tickClock, 1000);
document.getElementById('footerYear').textContent = new Date().getFullYear();

// ── Fetch: Active sessions ───────────────────────────────

async function fetchActive() {
    const { data, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id, actual_start_time, actual_dismiss_time, status, notes,
            lab_schedules (
                schedule_id, start_time, end_time, section,
                subjects         ( subject_code, subject_name ),
                professors       ( first_name, last_name ),
                laboratory_rooms ( lab_code, lab_name, building )
            ),
            lab_attendance ( student_id )
        `)
        .eq('session_date', today)
        .in('status', ['ongoing', 'dismissing']);

    if (error) { console.error('fetchActive:', error); return []; }

    return Promise.all((data || []).map(async s => {
        const { count } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', s.lab_schedules?.schedule_id)
            .eq('status', 'enrolled');

        return {
            ...s,
            laboratory_rooms: parseSessionLabFromNotes(s.notes),
            students_present: new Set((s.lab_attendance || []).map(a => a.student_id)).size,
            total_enrolled:   count || 0
        };
    }));
}

// ── Fetch: Scheduled sessions ────────────────────────────

async function fetchScheduled() {
    const currentTime = getCurrentTime();

    const { data, error } = await supabaseClient
        .from('lab_schedules')
        .select(`
            schedule_id, start_time, end_time, section,
            subjects         ( subject_code, subject_name ),
            professors       ( first_name, last_name ),
            laboratory_rooms ( lab_code, lab_name, building ),
            lab_sessions     ( session_id, status, session_date )
        `)
        .eq('day_of_week', currentDay)
        .eq('status', 'active');

    if (error) { console.error('fetchScheduled:', error); return []; }

    const filtered = (data || []).filter(sch => {
        const todaySess = (sch.lab_sessions || []).filter(s => s.session_date === today);
        if (todaySess.some(s => ['ongoing', 'dismissing', 'completed', 'cancelled'].includes(s.status))) return false;
        const minsElapsed = (timeToDate(currentTime) - timeToDate(sch.start_time)) / 60_000;
        return minsElapsed <= PROFESSOR_START_WINDOW;
    });

    return Promise.all(filtered.map(async sch => {
        const { count } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', sch.schedule_id)
            .eq('status', 'enrolled');

        const todaySess  = (sch.lab_sessions || []).find(s => s.session_date === today);
        const minsUntil  = (timeToDate(sch.start_time) - timeToDate(currentTime)) / 60_000;

        return {
            ...sch,
            session_status: todaySess?.status || 'not_created',
            total_enrolled: count || 0,
            mins_until:     minsUntil
        };
    })).then(l => l.sort((a, b) => a.start_time.localeCompare(b.start_time)));
}

// ── Fetch: Completed sessions ────────────────────────────

async function fetchCompleted() {
    const { data, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id, actual_start_time, actual_end_time, notes,
            lab_schedules (
                schedule_id, section,
                subjects         ( subject_code, subject_name ),
                professors       ( first_name, last_name ),
                laboratory_rooms ( lab_code, lab_name )
            ),
            lab_attendance ( student_id )
        `)
        .eq('session_date', today)
        .eq('status', 'completed')
        .order('actual_end_time', { ascending: false });

    if (error) { console.error('fetchCompleted:', error); return []; }

    return Promise.all((data || []).map(async s => {
        const { count } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', s.lab_schedules?.schedule_id)
            .eq('status', 'enrolled');

        return {
            ...s,
            laboratory_rooms: parseSessionLabFromNotes(s.notes),
            students_attended: new Set((s.lab_attendance || []).map(a => a.student_id)).size,
            total_enrolled:    count || 0
        };
    }));
}

// ── Render: Active card ──────────────────────────────────

function renderActive(s) {
    const sch  = s.lab_schedules;
    const subj = sch?.subjects;
    const prof = sch?.professors;
    const lab  = s.laboratory_rooms || sch?.laboratory_rooms;

    const isDismissing = s.status === 'dismissing';
    const isStayIn     = s.status === 'ongoing' && !!s.actual_dismiss_time;
    const pct = s.total_enrolled > 0
        ? Math.round((s.students_present / s.total_enrolled) * 100) : 0;

    let statusLabel, statusCls, noteHtml;

    if (isDismissing) {
        statusLabel = '<i class="fa-solid fa-door-open"></i> Dismissing';
        statusCls   = 'dismissing';
        noteHtml    = `<div class="note dismissing"><i class="fa-solid fa-door-open"></i><span>Dismissal enabled — students may scan out and leave.</span></div>`;
    } else if (isStayIn) {
        statusLabel = '<i class="fa-solid fa-rotate-left"></i> Stay In';
        statusCls   = 'live';
        noteHtml    = `<div class="note ongoing"><i class="fa-solid fa-rotate-left"></i><span>All students exited — session reverted to Stay In mode.</span></div>`;
    } else {
        statusLabel = '<i class="fa-solid fa-broadcast-tower"></i> Live';
        statusCls   = 'live';
        noteHtml    = `<div class="note ongoing"><i class="fa-solid fa-circle-check"></i><span>Session is active. Students can scan in.</span></div>`;
    }

    return `
        <div class="card ${isDismissing ? 'dismissing' : 'ongoing'}">
            <span class="status ${statusCls}">${statusLabel}</span>
            <div class="card-subject">${subj?.subject_code || '—'}</div>
            <div class="card-name">${subj?.subject_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || '—'}</strong> &mdash; ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-building"></i> ${lab?.building || '—'}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section <strong>${sch?.section || '—'}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${formatTime(sch?.start_time)} &mdash; ${formatTime(sch?.end_time)}</div>
            ${s.actual_start_time ? `<div class="detail" style="color:#166534;font-weight:600;"><i class="fa-solid fa-play-circle" style="color:#22c55e"></i> Started ${formatTime(s.actual_start_time)}</div>` : ''}
            ${noteHtml}
            <div class="card-footer">
                <span>${s.students_present} / ${s.total_enrolled} students present</span>
                <span class="att-pill"><i class="fa-solid fa-user-check"></i> ${pct}%</span>
            </div>
        </div>`;
}

// ── Render: Scheduled card ───────────────────────────────

function renderScheduled(s) {
    const subj = s.subjects;
    const prof = s.professors;
    const lab  = s.laboratory_rooms;

    const isWaiting = s.session_status === 'scheduled';
    const minsUntil = s.mins_until;

    let statusLabel, statusCls, noteHtml;

    if (isWaiting) {
        // Professor has created the session but hasn't started it yet
        statusLabel = '⏳ Waiting';
        statusCls   = 'waiting';
        noteHtml    = `<div class="note waiting"><i class="fa-solid fa-user-clock"></i><span>Waiting for professor to start the session.</span></div>`;

    } else if (minsUntil > 0) {
        // Still in the future — show countdown
        const h = Math.floor(minsUntil / 60);
        const m = Math.floor(minsUntil % 60);
        const t = h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}` : `${m}m`;
        statusLabel = 'Scheduled';
        statusCls   = 'scheduled';
        noteHtml    = `<div class="note ongoing"><i class="fa-solid fa-hourglass-start"></i><span>Starts in <strong>${t.trim()}</strong> &mdash; at ${formatTime(s.start_time)}</span></div>`;

    } else if (minsUntil > -OVERDUE_GRACE_MINUTES) {
        // ── GRACE PERIOD: 0 to -5 minutes — still show as "Starting" ──
        const minsLate = Math.abs(Math.ceil(minsUntil));
        const graceLeft = OVERDUE_GRACE_MINUTES - minsLate;
        statusLabel = '🕐 Starting';
        statusCls   = 'waiting';
        noteHtml    = `<div class="note waiting">
                            <i class="fa-solid fa-hourglass-half"></i>
                            <span>Just started — waiting for professor.
                            Marked overdue in <strong>${graceLeft}m</strong>.</span>
                       </div>`;

    } else {
        // ── OVERDUE: more than 5 minutes past start time ──
        const over = Math.abs(Math.floor(minsUntil));
        const oh   = Math.floor(over / 60);
        const om   = over % 60;
        const ot   = oh > 0 ? `${oh}h ${om > 0 ? om + 'm' : ''}` : `${om}m`;
        statusLabel = 'Overdue';
        statusCls   = 'overdue';
        noteHtml    = `<div class="note overdue"><i class="fa-solid fa-triangle-exclamation"></i><span>Should have started <strong>${ot.trim()}</strong> ago.</span></div>`;
    }

    return `
        <div class="card scheduled">
            <span class="status ${statusCls}">${statusLabel}</span>
            <div class="card-subject">${subj?.subject_code || '—'}</div>
            <div class="card-name">${subj?.subject_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || '—'}</strong> &mdash; ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-building"></i> ${lab?.building || '—'}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section <strong>${s.section || '—'}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${formatTime(s.start_time)} &mdash; ${formatTime(s.end_time)}</div>
            ${noteHtml}
            <div class="card-footer">
                <span>${s.total_enrolled} students enrolled</span>
            </div>
        </div>`;
}

// ── Render: Completed card ───────────────────────────────

function renderCompleted(s) {
    const sch  = s.lab_schedules;
    const subj = sch?.subjects;
    const prof = sch?.professors;
    const lab  = s.laboratory_rooms || sch?.laboratory_rooms;

    const pct     = s.total_enrolled > 0
        ? Math.round((s.students_attended / s.total_enrolled) * 100) : 0;
    const wasAuto = (s.notes || '').includes('auto time out');

    return `
        <div class="card completed">
            <span class="status completed">${wasAuto ? '⏰ Auto-ended' : 'Completed'}</span>
            <div class="card-subject">${subj?.subject_code || '—'}</div>
            <div class="card-name">${subj?.subject_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || '—'}</strong> &mdash; ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section <strong>${sch?.section || '—'}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${formatTime(s.actual_start_time)} &mdash; ${formatTime(s.actual_end_time)}</div>
            <div class="card-footer">
                <span>${s.students_attended} / ${s.total_enrolled} attended</span>
                <span class="att-pill"><i class="fa-solid fa-user-check"></i> ${pct}%</span>
            </div>
        </div>`;
}

// ── Main Load ────────────────────────────────────────────

async function loadPage() {
    const icon = document.getElementById('refreshIcon');
    icon.classList.add('fa-spin');

    const [active, scheduled, completed] = await Promise.all([
        fetchActive(),
        fetchScheduled(),
        fetchCompleted()
    ]);

    // Update hero stats
    const dismissingCnt = active.filter(s => s.status === 'dismissing').length;
    document.getElementById('statActive').textContent     = active.length;
    document.getElementById('statDismissing').textContent = dismissingCnt;
    document.getElementById('statScheduled').textContent  = scheduled.length;
    document.getElementById('statCompleted').textContent  = completed.length;

    // Update section badges
    document.getElementById('activeBadge').textContent    = active.length;
    document.getElementById('scheduledBadge').textContent = scheduled.length;
    document.getElementById('completedBadge').textContent = completed.length;

    // Render grids
    document.getElementById('activeGrid').innerHTML = active.length
        ? active.map(renderActive).join('')
        : `<div class="empty">
               <i class="fa-solid fa-desktop"></i>
               <h3>No Active Sessions</h3>
               <p>No lab sessions are currently running.</p>
           </div>`;

    document.getElementById('scheduledGrid').innerHTML = scheduled.length
        ? scheduled.map(renderScheduled).join('')
        : `<div class="empty">
               <i class="fa-solid fa-calendar-xmark"></i>
               <h3>No Upcoming Sessions</h3>
               <p>All sessions have started or none are scheduled for the rest of today.</p>
           </div>`;

    // Completed — hidden when empty
    const completedBlock = document.getElementById('completedBlock');
    if (completed.length > 0) {
        completedBlock.style.display = 'block';
        document.getElementById('completedGrid').innerHTML = completed.map(renderCompleted).join('');
    } else {
        completedBlock.style.display = 'none';
    }

    // Refresh label
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    document.getElementById('refreshLabel').textContent = `Last updated ${now} · auto-refreshes every 30s`;
    icon.classList.remove('fa-spin');
}

// Initial load + auto-refresh every 30 seconds
loadPage();
setInterval(loadPage, 30_000);