/* ============================================================
   homepage.js — School Attendance Dashboard
   ============================================================ */

// ── Date / Time Helpers ──────────────────────────────────

const todayISO      = new Date().toLocaleDateString('en-CA');
const currentDay    = new Date().toLocaleDateString('en-US', { weekday: 'long' });

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

function formatDateTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Live Clock ───────────────────────────────────────────

function tickClock() {
    const now = new Date();
    const clock = document.getElementById('liveClock');
    const date  = document.getElementById('liveDate');
    if (clock) clock.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    if (date)  date.textContent  = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

tickClock();
setInterval(tickClock, 1000);
const footerYear = document.getElementById('footerYear');
if (footerYear) footerYear.textContent = new Date().getFullYear();

// ── Fetch: Today's Attendance Summary ────────────────────

async function fetchTodayAttendance() {
    try {
        const { data, error } = await supabaseClient
            .from('daily_attendance')
            .select('time_in_status, late_minutes, student_id, created_at')
            .eq('attendance_date', todayISO);

        if (error) { console.error('fetchTodayAttendance:', error); return null; }

        const records = data || [];
        const present = records.filter(r => r.time_in_status === 'on-time').length;
        const late    = records.filter(r => r.time_in_status === 'late').length;

        const studentIds = new Set(records.filter(r => r.student_id).map(r => r.student_id));

        return { total: records.length, present, late, studentCount: studentIds.size };
    } catch (err) {
        console.error('fetchTodayAttendance error:', err);
        return null;
    }
}

// ── Fetch: Student & Teacher Counts ────────────────────────

async function fetchPeopleCounts() {
    try {
        const [studentsRes, teachersRes, sectionsRes] = await Promise.all([
            supabaseClient.from('students').select('student_id', { count: 'exact', head: true }),
            supabaseClient.from('teachers').select('teacher_id', { count: 'exact', head: true }),
            supabaseClient.from('sections').select('section_id', { count: 'exact', head: true })
        ]);

        return {
            students: studentsRes.count || 0,
            teachers: teachersRes.count || 0,
            sections: sectionsRes.count || 0
        };
    } catch (err) {
        console.error('fetchPeopleCounts error:', err);
        return { students: 0, teachers: 0, sections: 0 };
    }
}

// ── Fetch: Recent Daily Attendance Records ───────────────

async function fetchRecentAttendance(limit = 10) {
    try {
        const { data, error } = await supabaseClient
            .from('daily_attendance')
            .select(`
                attendance_id, attendance_date, time_in, time_out, remarks, created_at,
                students ( student_id, first_name, last_name, stud_id, section_id, sections ( section_name, grade_level ) )
            `)
            .eq('attendance_date', todayISO)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) { console.error('fetchRecentAttendance:', error); return []; }
        return data || [];
    } catch (err) {
        console.error('fetchRecentAttendance error:', err);
        return [];
    }
}

// ══════════════════════════════════════════════════════════
// EVENTS FETCH & RENDER
// ══════════════════════════════════════════════════════════

async function fetchOngoingEvents() {
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('event_id, event_name, event_date, end_date, time_start, time_end, event_type, location, description, target_grade_level, target_section, status')
            .eq('status', 'ongoing')
            .order('time_start', { ascending: true });

        if (error) { console.error('fetchOngoingEvents:', error); return []; }
        return data || [];
    } catch (err) {
        console.error('fetchOngoingEvents error:', err);
        return [];
    }
}

async function fetchEventAttendanceCount(eventId) {
    try {
        const { count, error } = await supabaseClient
            .from('event_attendance')
            .select('attendance_id', { count: 'exact', head: true })
            .eq('event_id', eventId)
            .not('time_in', 'is', null);

        if (error) { console.error('fetchEventAttendanceCount:', error); return 0; }
        return count || 0;
    } catch (err) {
        console.error('fetchEventAttendanceCount error:', err);
        return 0;
    }
}

// ── Fetch ALL event statuses (upcoming + ongoing + completed) ──
async function fetchAllEvents() {
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('event_id, event_name, event_date, end_date, time_start, time_end, event_type, location, description, target_grade_level, target_section, status')
            .neq('status', 'cancelled')
            .order('event_date', { ascending: true })
            .limit(10);

        if (error) { console.error('fetchAllEvents:', error); return []; }
        return data || [];
    } catch (err) {
        console.error('fetchAllEvents error:', err);
        return [];
    }
}

const typeColors = {
    assembly: '#8b5cf6', meeting: '#06b6d4', sports: '#f59e0b',
    ceremony: '#ec4899', exam: '#ef4444', holiday: '#22c55e', other: '#6b7280',
};

const statusBadgeStyles = {
    upcoming:  { bg: '#e0f2fe', text: '#0369a1', icon: 'fa-calendar-day', label: 'Upcoming' },
    ongoing:   { bg: '#dcfce7', text: '#166534', icon: 'fa-circle-play', label: 'Ongoing' },
    completed: { bg: '#f1f5f9', text: '#475569', icon: 'fa-check-circle', label: 'Completed' },
};

// ── Original renderEvent (kept for compatibility) ──
function renderEvent(ev) {
    const eventDate = new Date(ev.event_date + 'T00:00:00');
    const isToday = ev.event_date === todayISO;
    const dateLabel = isToday ? 'Today' : eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const color = typeColors[ev.event_type?.toLowerCase()] || '#6b7280';

    // Show status badge if not upcoming
    let statusBadge = '';
    if (ev.status === 'ongoing') {
        statusBadge = `<span style="background:#dcfce7; color:#166534; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600; margin-left:8px;"><i class="fa-solid fa-circle-play"></i> Ongoing</span>`;
    } else if (ev.status === 'completed') {
        statusBadge = `<span style="background:#f1f5f9; color:#475569; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600; margin-left:8px;"><i class="fa-solid fa-check-circle"></i> Done</span>`;
    }

    return `
        <div class="card event-card">
            <div class="event-header">
                <span class="event-type" style="background:${color}20; color:${color}">${ev.event_type || 'Event'}</span>
                <span class="event-date">${dateLabel}</span>
            </div>
            <div class="event-name">${ev.event_name || 'Untitled Event'}${statusBadge}</div>
            <div class="event-meta">
                ${ev.location ? `<span><i class="fa-solid fa-location-dot"></i> ${ev.location}</span>` : ''}
            </div>
            ${ev.description ? `<div class="event-desc">${ev.description}</div>` : ''}
        </div>`;
}

// ── Ongoing event with attendance count ──
function renderOngoingEventCard(ev, presentCount) {
    const color = typeColors[ev.event_type?.toLowerCase()] || '#6b7280';
    const timeLabel = ev.time_start
        ? `${formatTime(ev.time_start)} – ${formatTime(ev.time_end)}`
        : 'All day';

    return `
        <div class="card event-card" style="border-left:4px solid #22c55e;">
            <div class="event-header" style="display:flex; justify-content:space-between; align-items:center;">
                <span class="event-type" style="background:${color}20; color:${color}">${ev.event_type || 'Event'}</span>
                <span style="background:#dcfce7; color:#166534; font-size:12px; padding:2px 8px; border-radius:4px; font-weight:600;">
                    <i class="fa-solid fa-circle-play"></i> LIVE
                </span>
            </div>
            <div class="event-name" style="font-size:18px; font-weight:700;">${ev.event_name || 'Untitled Event'}</div>
            <div class="event-meta" style="margin-bottom:12px;">
                <span><i class="fa-solid fa-clock"></i> ${timeLabel}</span>
                ${ev.location ? `<span style="margin-left:12px;"><i class="fa-solid fa-location-dot"></i> ${ev.location}</span>` : ''}
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:#f0fdf4; border-radius:8px;">
                <span style="color:#166534; font-size:14px; font-weight:600;">
                    <i class="fa-solid fa-users"></i> Attendance
                </span>
                <span style="font-size:24px; font-weight:800; color:#16a34a;">${presentCount} <span style="font-size:13px; font-weight:500; color:#6b7280;">present</span></span>
            </div>
        </div>`;
}

// ══════════════════════════════════════════════════════════
// EXISTING RENDERERS
// ══════════════════════════════════════════════════════════

function renderAttendanceStats(stats) {
    if (!stats) {
        return `
        <div class="card stat-card">
            <div class="stat-header">
                <i class="fa-solid fa-chart-pie" style="color:#6b7280"></i>
                <span class="status grey">No Data</span>
            </div>
            <div class="stat-value">—</div>
            <div class="stat-label">Attendance records unavailable</div>
        </div>`;
    }

    const pctPresent = stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 0;

    return `
        <div class="card stat-card">
            <div class="stat-header">
                <i class="fa-solid fa-chart-pie" style="color:#22c55e"></i>
                <span class="status live">Today</span>
            </div>
            <div class="stat-value">${stats.present}</div>
            <div class="stat-label">Present today (${pctPresent}%)</div>
            <div class="stat-breakdown">
                <span class="bd-item"><i class="fa-solid fa-check" style="color:#22c55e"></i> ${stats.present} On-time</span>
                <span class="bd-item"><i class="fa-solid fa-clock" style="color:#f59e0b"></i> ${stats.late} Late</span>
            </div>
        </div>`;
}

function renderPeopleCounts(counts) {
    return `
        <div class="card stat-card">
            <div class="stat-header">
                <i class="fa-solid fa-users" style="color:#3b82f6"></i>
                <span class="status scheduled">Directory</span>
            </div>
            <div class="stat-value">${counts.students + counts.teachers}</div>
            <div class="stat-label">Total people registered</div>
            <div class="stat-breakdown">
                <span class="bd-item"><i class="fa-solid fa-graduation-cap" style="color:#8b5cf6"></i> ${counts.students} Students</span>
                <span class="bd-item"><i class="fa-solid fa-chalkboard-user" style="color:#06b6d4"></i> ${counts.teachers} Teachers</span>
                <span class="bd-item"><i class="fa-solid fa-layer-group" style="color:#f59e0b"></i> ${counts.sections} Sections</span>
            </div>
        </div>`;
}

function renderRecentRecord(rec) {
    const student = rec.students;
    const name = student ? `${student.first_name || ''} ${student.last_name || ''}`.trim() : 'Unknown';
    const idNum = student ? student.stud_id : '';
    const sectionInfo = student?.sections ? `${student.sections.grade_level || ''} - ${student.sections.section_name || ''}` : '';

    const statusColors = { on_time: '#22c55e', late: '#f59e0b' };
    const statusIcon   = { on_time: 'fa-check', late: 'fa-clock' };
    const statusLabel  = rec.time_in_status === 'late' ? 'Late' : 'Present';
    const color = statusColors[rec.time_in_status] || '#6b7280';
    const icon  = statusIcon[rec.time_in_status] || 'fa-circle';

    return `
        <div class="card record-card">
            <div class="record-header">
                <span class="record-role student">Student</span>
                <span class="record-status" style="color:${color}">
                    <i class="fa-solid ${icon}"></i> ${statusLabel}
                </span>
            </div>
            <div class="record-name">${name || 'Unknown'}</div>
            <div class="record-meta">
                ${idNum ? `<span><i class="fa-solid fa-id-card"></i> ${idNum}</span>` : ''}
                ${sectionInfo ? `<span><i class="fa-solid fa-layer-group"></i> ${sectionInfo}</span>` : ''}
            </div>
            <div class="record-time">
                <i class="fa-solid fa-clock"></i> 
                ${rec.time_in ? formatTime(rec.time_in) : formatDateTime(rec.created_at)}
                ${rec.time_out ? ` → ${formatTime(rec.time_out)}` : ''}
            </div>
            ${rec.remarks ? `<div class="record-remarks">${rec.remarks}</div>` : ''}
        </div>`;
}

// ══════════════════════════════════════════════════════════
// MAIN LOAD
// ══════════════════════════════════════════════════════════

async function loadPage() {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('fa-spin');

    const [attendanceStats, peopleCounts, recentRecords, ongoingEvents, allEvents] = await Promise.all([
        fetchTodayAttendance(),
        fetchPeopleCounts(),
        fetchRecentAttendance(8),
        fetchOngoingEvents(),
        fetchAllEvents()
    ]);

    // ── Hero stats ──
    const totalPresent = attendanceStats?.present || 0;
    const totalLate    = attendanceStats?.late || 0;

    const statPresent = document.getElementById('statPresent');
    const statLate    = document.getElementById('statLate');
    if (statPresent) statPresent.textContent = totalPresent;
    if (statLate)    statLate.textContent    = totalLate;

    // ── Badges ──
    const badgeRecent   = document.getElementById('recentBadge');
    const badgeEvents   = document.getElementById('eventsBadge');
    if (badgeRecent) badgeRecent.textContent = recentRecords.length;
    if (badgeEvents)   badgeEvents.textContent = allEvents.length;

    // ── Stats grid ──
    const statsGrid = document.getElementById('statsGrid');
    if (statsGrid) {
        statsGrid.innerHTML = renderAttendanceStats(attendanceStats) + renderPeopleCounts(peopleCounts);
    }

    // ── Recent records ──
    const recentGrid = document.getElementById('recentGrid');
    if (recentGrid) {
        recentGrid.innerHTML = recentRecords.length
            ? recentRecords.map(renderRecentRecord).join('')
            : `<div class="empty">
                   <i class="fa-solid fa-clipboard-list"></i>
                   <h3>No Attendance Records Yet</h3>
                   <p>Attendance records will appear here once the facial recognition scanner is used or manual attendance is recorded.</p>
               </div>`;
    }

    // ── ONGOING EVENTS (with live attendance) ──
    // Check if the page has an ongoing events section
    const ongoingSection = document.getElementById('ongoingEventsSection');
    const ongoingGrid    = document.getElementById('ongoingEventsGrid');
    if (ongoingSection && ongoingGrid) {
        if (ongoingEvents.length > 0) {
            ongoingSection.style.display = '';
            const cards = await Promise.all(
                ongoingEvents.map(async ev => {
                    const count = await fetchEventAttendanceCount(ev.event_id);
                    return renderOngoingEventCard(ev, count);
                })
            );
            ongoingGrid.innerHTML = cards.join('');
        } else {
            ongoingSection.style.display = 'none';
        }
    }

    // ── ALL EVENTS (Upcoming + Ongoing + Completed) ──
    // This uses your ORIGINAL eventsGrid ID from the first version
    const eventsGrid = document.getElementById('eventsGrid');
    if (eventsGrid) {
        eventsGrid.innerHTML = allEvents.length
            ? allEvents.map(renderEvent).join('')
            : `<div class="empty">
                   <i class="fa-solid fa-calendar-xmark"></i>
                   <h3>No Events</h3>
                   <p>No upcoming, ongoing, or completed events to display.</p>
               </div>`;
    }

    // ── Refresh label ──
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const refreshLabel = document.getElementById('refreshLabel');
    if (refreshLabel) refreshLabel.textContent = `Last updated ${now} · auto-refreshes every 30s`;
    if (icon) icon.classList.remove('fa-spin');
}

// Initial load + auto-refresh every 30 seconds
loadPage();
setInterval(loadPage, 30_000);