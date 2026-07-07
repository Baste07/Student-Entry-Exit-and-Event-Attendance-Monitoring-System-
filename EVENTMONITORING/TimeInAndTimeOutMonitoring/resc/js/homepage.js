/* ============================================================
   homepage.js — School Attendance Dashboard
   Simplified for greeting-only facial recognition engine
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
    document.getElementById('liveClock').textContent =
        now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    document.getElementById('liveDate').textContent =
        now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

tickClock();
setInterval(tickClock, 1000);
document.getElementById('footerYear').textContent = new Date().getFullYear();

// ── Fetch: Today's Attendance Summary ────────────────────

async function fetchTodayAttendance() {
    try {
        const { data, error } = await supabaseClient
            .from('daily_attendance')
            .select('status, student_id, teacher_id, created_at')
            .eq('date', todayISO);

        if (error) { console.error('fetchTodayAttendance:', error); return null; }

        const records = data || [];
        const present = records.filter(r => r.status === 'present').length;
        const absent  = records.filter(r => r.status === 'absent').length;
        const late    = records.filter(r => r.status === 'late').length;
        const excused = records.filter(r => r.status === 'excused').length;

        // Get unique people who checked in today
        const studentIds = new Set(records.filter(r => r.student_id).map(r => r.student_id));
        const teacherIds = new Set(records.filter(r => r.teacher_id).map(r => r.teacher_id));

        return {
            total: records.length,
            present,
            absent,
            late,
            excused,
            studentCount: studentIds.size,
            teacherCount: teacherIds.size
        };
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
                attendance_id, status, date, time_in, time_out, remarks, created_at,
                students ( student_id, first_name, last_name, lrn, section_id, sections ( section_name, grade_level ) ),
                teachers ( teacher_id, first_name, last_name, employee_id )
            `)
            .eq('date', todayISO)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) { console.error('fetchRecentAttendance:', error); return []; }
        return data || [];
    } catch (err) {
        console.error('fetchRecentAttendance error:', err);
        return [];
    }
}

// ── Fetch: Upcoming Events ───────────────────────────────

async function fetchUpcomingEvents() {
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('event_id, event_name, event_date, event_type, location, description')
            .gte('event_date', todayISO)
            .order('event_date', { ascending: true })
            .limit(5);

        if (error) { console.error('fetchUpcomingEvents:', error); return []; }
        return data || [];
    } catch (err) {
        console.error('fetchUpcomingEvents error:', err);
        return [];
    }
}

// ── Render: Attendance Stat Card ─────────────────────────

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

    const totalPeople = stats.studentCount + stats.teacherCount;
    const pctPresent = totalPeople > 0 ? Math.round((stats.present / totalPeople) * 100) : 0;

    return `
        <div class="card stat-card">
            <div class="stat-header">
                <i class="fa-solid fa-chart-pie" style="color:#22c55e"></i>
                <span class="status live">Today</span>
            </div>
            <div class="stat-value">${stats.present}</div>
            <div class="stat-label">Present today (${pctPresent}%)</div>
            <div class="stat-breakdown">
                <span class="bd-item"><i class="fa-solid fa-check" style="color:#22c55e"></i> ${stats.present} Present</span>
                <span class="bd-item"><i class="fa-solid fa-clock" style="color:#f59e0b"></i> ${stats.late} Late</span>
                <span class="bd-item"><i class="fa-solid fa-xmark" style="color:#ef4444"></i> ${stats.absent} Absent</span>
                <span class="bd-item"><i class="fa-solid fa-notes-medical" style="color:#3b82f6"></i> ${stats.excused} Excused</span>
            </div>
        </div>`;
}

// ── Render: People Count Card ────────────────────────────

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

// ── Render: Recent Recognition Card ──────────────────────

function renderRecentRecord(rec) {
    const student = rec.students;
    const teacher = rec.teachers;
    const person = student || teacher;
    const role = student ? 'Student' : (teacher ? 'Teacher' : 'Unknown');
    const name = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';
    const idNum = student ? student.lrn : (teacher ? teacher.employee_id : '');
    const sectionInfo = student?.sections ? `${student.sections.grade_level || ''} - ${student.sections.section_name || ''}` : '';

    const statusColors = {
        present:  '#22c55e',
        late:     '#f59e0b',
        absent:   '#ef4444',
        excused:  '#3b82f6'
    };
    const statusIcon = {
        present:  'fa-check',
        late:     'fa-clock',
        absent:   'fa-xmark',
        excused:  'fa-notes-medical'
    };
    const color = statusColors[rec.status] || '#6b7280';
    const icon  = statusIcon[rec.status] || 'fa-circle';

    return `
        <div class="card record-card">
            <div class="record-header">
                <span class="record-role ${role.toLowerCase()}">${role}</span>
                <span class="record-status" style="color:${color}">
                    <i class="fa-solid ${icon}"></i> ${rec.status ? rec.status.charAt(0).toUpperCase() + rec.status.slice(1) : '—'}
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

// ── Render: Event Card ──────────────────────────────────

function renderEvent(ev) {
    const eventDate = new Date(ev.event_date);
    const isToday = ev.event_date === todayISO;
    const dateLabel = isToday ? 'Today' : eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const typeColors = {
        assembly:   '#8b5cf6',
        meeting:    '#06b6d4',
        sports:     '#f59e0b',
        ceremony:   '#ec4899',
        exam:       '#ef4444',
        holiday:    '#22c55e',
        other:      '#6b7280'
    };
    const color = typeColors[ev.event_type?.toLowerCase()] || '#6b7280';

    return `
        <div class="card event-card">
            <div class="event-header">
                <span class="event-type" style="background:${color}20; color:${color}">${ev.event_type || 'Event'}</span>
                <span class="event-date">${dateLabel}</span>
            </div>
            <div class="event-name">${ev.event_name || 'Untitled Event'}</div>
            <div class="event-meta">
                ${ev.location ? `<span><i class="fa-solid fa-location-dot"></i> ${ev.location}</span>` : ''}
            </div>
            ${ev.description ? `<div class="event-desc">${ev.description}</div>` : ''}
        </div>`;
}

// ── Main Load ────────────────────────────────────────────

async function loadPage() {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('fa-spin');

    const [attendanceStats, peopleCounts, recentRecords, upcomingEvents] = await Promise.all([
        fetchTodayAttendance(),
        fetchPeopleCounts(),
        fetchRecentAttendance(8),
        fetchUpcomingEvents()
    ]);

    // Update hero stats
    const totalPresent = attendanceStats?.present || 0;
    const totalLate    = attendanceStats?.late || 0;
    const totalAbsent  = attendanceStats?.absent || 0;
    const totalExcused = attendanceStats?.excused || 0;

    const statPresent  = document.getElementById('statPresent');
    const statLate     = document.getElementById('statLate');
    const statAbsent   = document.getElementById('statAbsent');
    const statExcused  = document.getElementById('statExcused');

    if (statPresent) statPresent.textContent = totalPresent;
    if (statLate)    statLate.textContent    = totalLate;
    if (statAbsent)  statAbsent.textContent  = totalAbsent;
    if (statExcused) statExcused.textContent = totalExcused;

    // Update badges
    const badgeRecent = document.getElementById('recentBadge');
    const badgeEvents = document.getElementById('eventsBadge');
    if (badgeRecent) badgeRecent.textContent = recentRecords.length;
    if (badgeEvents)  badgeEvents.textContent  = upcomingEvents.length;

    // Render stats grid
    const statsGrid = document.getElementById('statsGrid');
    if (statsGrid) {
        statsGrid.innerHTML = renderAttendanceStats(attendanceStats) + renderPeopleCounts(peopleCounts);
    }

    // Render recent records
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

    // Render events
    const eventsGrid = document.getElementById('eventsGrid');
    if (eventsGrid) {
        eventsGrid.innerHTML = upcomingEvents.length
            ? upcomingEvents.map(renderEvent).join('')
            : `<div class="empty">
                   <i class="fa-solid fa-calendar-xmark"></i>
                   <h3>No Upcoming Events</h3>
                   <p>No events are scheduled for today or the near future.</p>
               </div>`;
    }

    // Refresh label
    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const refreshLabel = document.getElementById('refreshLabel');
    if (refreshLabel) refreshLabel.textContent = `Last updated ${now} · auto-refreshes every 30s`;
    if (icon) icon.classList.remove('fa-spin');
}

// Initial load + auto-refresh every 30 seconds
loadPage();
setInterval(loadPage, 30_000);