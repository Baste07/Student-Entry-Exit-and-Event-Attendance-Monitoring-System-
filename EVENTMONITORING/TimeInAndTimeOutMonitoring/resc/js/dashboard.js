/**
 * ============================================================
 * DASHBOARD JAVASCRIPT — SUPABASE VERSION
 * Original code preserved exactly.
 * Only change: setSidebarActive() removed — active link is
 * now handled automatically by loadSidebar('dashboard')
 * in sidebar.js, so the old parent.document iframe hack
 * is no longer needed.
 * ============================================================
 */

// ────────────────────────────────────────────
// INITIALIZE
// ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadDashboardData();
});

// ────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────

function formatDate(date = new Date()) {
    return date.toISOString().split('T')[0];
}

function formatTime(time) {
    const [hours, minutes] = time.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
}

function getCurrentDay() {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[new Date().getDay()];
}

function getCurrentTime() {
    return new Date().toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'Asia/Manila'
    }).substring(0, 8);
}

// ────────────────────────────────────────────
// LOAD ALL DASHBOARD DATA
// ────────────────────────────────────────────

async function loadDashboardData() {
    if (!supabaseClient) {
        console.error('Supabase client not available');
        return;
    }

    try {
        await Promise.all([
            loadAdminProfile(),
            loadStatistics(),
            loadLaboratories()
        ]);

        console.log('✅ Dashboard loaded');

    } catch (error) {
        console.error('Dashboard error:', error);
    }
}

// ────────────────────────────────────────────
// LOAD ADMIN PROFILE
// ────────────────────────────────────────────

async function loadAdminProfile() {
    try {
        const userDataStr = sessionStorage.getItem('user');
        if (!userDataStr) return;

        const userData = JSON.parse(userDataStr);

        const displayName = userData.firstName
            ? `${userData.firstName} ${userData.lastName}`
            : userData.email;

        document.getElementById('adminName').textContent = displayName;
        document.getElementById('adminRole').textContent =
            userData.adminLevel === 'super_admin' ? 'Super Admin' : 'Admin';

        console.log('✅ Profile loaded:', displayName);

    } catch (error) {
        console.error('Profile error:', error);
    }
}

// ────────────────────────────────────────────
// LOAD STATISTICS
// ────────────────────────────────────────────

async function loadStatistics() {
    try {
        const { count: totalSchedules } = await supabaseClient
            .from('lab_schedules')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        const { count: totalStudents } = await supabaseClient
            .from('students')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        const { count: totalProfessors } = await supabaseClient
            .from('professors')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        const { count: totalReports } = await supabaseClient
            .from('attendance_reports')
            .select('*', { count: 'exact', head: true });

        document.getElementById('totalSchedules').textContent  = totalSchedules  || 0;
        document.getElementById('totalStudents').textContent   = totalStudents   || 0;
        document.getElementById('totalProfessors').textContent = totalProfessors || 0;
        document.getElementById('totalReports').textContent    = totalReports    || 0;

        console.log('✅ Statistics loaded');

    } catch (error) {
        console.error('Statistics error:', error);
    }
}

// ────────────────────────────────────────────
// LOAD LABORATORIES
// ────────────────────────────────────────────

async function loadLaboratories() {
    try {
        const today = formatDate();

        const { data: labs, error } = await supabaseClient
            .from('laboratory_rooms')
            .select('*')
            .order('lab_code', { ascending: true });

        if (error) throw error;

        if (!labs || labs.length === 0) {
            document.getElementById('labGrid').innerHTML =
                '<p class="no-schedules">No laboratories found in the database.</p>';
            return;
        }

        const labsWithData = await Promise.all(labs.map(async (lab) => {

            const { count: totalSchedules } = await supabaseClient
                .from('lab_schedules')
                .select('*', { count: 'exact', head: true })
                .eq('lab_id', lab.lab_id)
                .eq('status', 'active');

            const { data: sessions } = await supabaseClient
                .from('lab_sessions')
                .select(`
                    session_id, status, session_date, actual_start_time, lab_id,
                    lab_schedules!inner (
                        lab_id,
                        section,
                        start_time,
                        end_time,
                        subjects ( subject_code, subject_name ),
                        professors ( first_name, middle_name, last_name )
                    )
                `)
                .eq('session_date', today)
                .in('status', ['ongoing', 'dismissing'])
                .eq('lab_schedules.lab_id', lab.lab_id)
                .limit(1);

            let currentSession = null;
            let presentCount   = 0;
            let statusText     = 'Available';
            let isOccupied     = false;
            let isDismissing   = false;

            if (sessions && sessions.length > 0) {
                const session = sessions[0];
                currentSession = session;
                isDismissing   = session.status === 'dismissing';
                isOccupied     = true;

                const { count } = await supabaseClient
                    .from('lab_attendance')
                    .select('*', { count: 'exact', head: true })
                    .eq('session_id', session.session_id)
                    .is('time_out', null);

                presentCount = count || 0;
                const subjCode = session.lab_schedules?.subjects?.subject_code || session.lab_schedules?.subjects?.subject_code;
                statusText   = isDismissing
                    ? `Dismissing: ${subjCode}`
                    : `Ongoing: ${subjCode}`;

            } else if (lab.status === 'maintenance') {
                statusText = 'Maintenance';
            } else {
                const { data: scheduled } = await supabaseClient
                    .from('lab_sessions')
                    .select('session_id, lab_schedules!inner(lab_id)')
                    .eq('session_date', today)
                    .eq('lab_schedules.lab_id', lab.lab_id)
                    .eq('status', 'scheduled')
                    .limit(1);

                if (scheduled && scheduled.length > 0) statusText = 'Session Pending';
            }

            return {
                ...lab,
                totalSchedules: totalSchedules || 0,
                currentSession,
                presentCount,
                statusText,
                isOccupied,
                isDismissing
            };
        }));

        displayLaboratories(labsWithData);
        console.log('✅ Laboratories loaded:', labsWithData.length);

    } catch (error) {
        console.error('Laboratories error:', error);
        document.getElementById('labGrid').innerHTML =
            '<p class="no-schedules">Failed to load laboratories.</p>';
    }
}

// ────────────────────────────────────────────
// DISPLAY LABORATORIES
// ────────────────────────────────────────────

function displayLaboratories(labs) {
    const container = document.getElementById('labGrid');
    let html = '';

    labs.forEach(lab => {
        const percentage    = lab.capacity > 0 ? (lab.presentCount / lab.capacity) * 100 : 0;
        const statusClass   = lab.statusText === 'Maintenance' ? 'maintenance'
            : lab.isOccupied ? (lab.isDismissing ? 'dismissing' : 'occupied')
            : lab.statusText === 'Session Pending' ? 'pending' : 'available';
        const headerClass   = lab.isOccupied ? (lab.isDismissing ? 'dismissing' : 'occupied')
            : lab.statusText === 'Session Pending' ? 'pending' : '';
        const progressClass = percentage >= 80 ? 'high' : '';

        html += `
            <div class="lab-card" id="lab-${lab.lab_id}" onclick="toggleLabSchedules('${lab.lab_id}')">
                <div class="lab-card-header ${headerClass}">
                    <span class="lab-status-badge ${statusClass}">
                        ${lab.isDismissing              ? '🚪 DISMISSING'
                          : lab.isOccupied              ? '● IN USE'
                          : lab.statusText === 'Maintenance'     ? 'MAINTENANCE'
                          : lab.statusText === 'Session Pending' ? '⏳ PENDING'
                          : '✓ AVAILABLE'}
                    </span>
                    <div class="lab-top">
                        <div class="lab-info">
                            <h4>${lab.lab_code}</h4>
                            <span>${lab.lab_name}</span>
                        </div>
                    </div>
                    <div class="lab-meta">
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-building"></i>
                            <span>${lab.building}</span>
                        </div>
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-layer-group"></i>
                            <span>${lab.floor}</span>
                        </div>
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-calendar-check"></i>
                            <span>${lab.totalSchedules} schedules</span>
                        </div>
                    </div>
                </div>

                ${lab.currentSession ? `
                <div class="current-session-info">
                    <div class="current-session-title">
                        <i class="fa-solid fa-broadcast-tower"></i> Current Session
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-book"></i>
                        <strong>${lab.currentSession.lab_schedules.subjects.subject_code}</strong>
                        – ${lab.currentSession.lab_schedules.subjects.subject_name}
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-chalkboard-teacher"></i>
                        ${lab.currentSession.lab_schedules.professors.first_name}
                        ${lab.currentSession.lab_schedules.professors.last_name}
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-users"></i>
                        Section: ${lab.currentSession.lab_schedules.section}
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-clock"></i>
                        ${formatTime(lab.currentSession.lab_schedules.start_time)} –
                        ${formatTime(lab.currentSession.lab_schedules.end_time)}
                    </div>
                    ${lab.isDismissing ? `
                    <div class="dismissing-session-info">
                        <i class="fa-solid fa-door-open"></i>
                        Students may now scan out — dismissal enabled
                    </div>` : ''}
                </div>
                ` : lab.statusText === 'Session Pending' ? `
                <div class="pending-session-info">
                    <i class="fa-solid fa-user-clock"></i>
                    Waiting for professor to start the session
                </div>` : ''}

                <div class="lab-progress-container">
                    <div class="lab-progress-bar ${progressClass}" style="width:${percentage}%"></div>
                </div>

                <div class="lab-footer">
                    <span class="lab-count">${lab.presentCount}/${lab.capacity} Occupancy</span>
                    <span class="lab-capacity-text">${Math.round(percentage)}%</span>
                </div>

                <button class="schedules-toggle"
                        onclick="event.stopPropagation(); toggleLabSchedules('${lab.lab_id}')">
                    <i class="fa-solid fa-chevron-down"></i>
                    <span>View All Schedules</span>
                </button>

                <div class="schedules-container" id="schedules-${lab.lab_id}">
                    <div class="schedules-content" id="schedules-content-${lab.lab_id}"></div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// ────────────────────────────────────────────
// LAB SCHEDULES EXPANSION
// ────────────────────────────────────────────

async function toggleLabSchedules(labId) {
    const card    = document.getElementById('lab-' + labId);
    const content = document.getElementById('schedules-content-' + labId);

    if (card.classList.contains('expanded')) {
        card.classList.remove('expanded');
        return;
    }

    document.querySelectorAll('.lab-card').forEach(c => c.classList.remove('expanded'));
    card.classList.add('expanded');

    if (!content.dataset.loaded) {
        content.innerHTML = '<p class="no-schedules"><i class="fa-solid fa-spinner fa-spin"></i> Loading schedules...</p>';
        try {
            await loadLabSchedules(labId, content);
            content.dataset.loaded = 'true';
        } catch (err) {
            content.innerHTML = '<p class="no-schedules">Error loading schedules.</p>';
        }
    }
}

// ────────────────────────────────────────────
// LOAD LAB SCHEDULES
// ────────────────────────────────────────────

async function loadLabSchedules(labId, container) {
    const { data: schedules, error } = await supabaseClient
        .from('lab_schedules')
        .select(`
            *,
            subjects ( subject_code, subject_name ),
            professors ( first_name, middle_name, last_name )
        `)
        .eq('lab_id', labId)
        .eq('status', 'active')
        .order('day_of_week', { ascending: true })
        .order('start_time',  { ascending: true });

    if (error) throw error;

    const schedulesPlus = await Promise.all(schedules.map(async (s) => {
        const { count: enrolledCount } = await supabaseClient
            .from('schedule_enrollments')
            .select('*', { count: 'exact', head: true })
            .eq('schedule_id', s.schedule_id);

        const now         = getCurrentTime();
        const today       = getCurrentDay();
        const isActiveNow = s.day_of_week === today && now >= s.start_time && now <= s.end_time;

        return { ...s, enrolledCount: enrolledCount || 0, isActiveNow };
    }));

    displayLabSchedules(container, schedulesPlus);
}

// ────────────────────────────────────────────
// DISPLAY LAB SCHEDULES
// ────────────────────────────────────────────

function displayLabSchedules(container, schedules) {
    if (!schedules || schedules.length === 0) {
        container.innerHTML = '<p class="no-schedules"><i class="fa-solid fa-calendar-xmark"></i> No schedules for this laboratory.</p>';
        return;
    }

    const order   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const grouped = {};
    order.forEach(d => { grouped[d] = schedules.filter(s => s.day_of_week === d); });

    let html = '';

    order.forEach(day => {
        if (!grouped[day].length) return;

        html += `
            <div class="schedule-day-group">
                <div class="day-header">
                    <i class="fa-solid fa-calendar"></i> ${day}
                    <span class="schedule-count-badge">${grouped[day].length}</span>
                </div>
        `;

        grouped[day].forEach(s => {
            const prof = `${s.professors.first_name} ${s.professors.middle_name || ''} ${s.professors.last_name}`.trim();
            const time = `${formatTime(s.start_time)} – ${formatTime(s.end_time)}`;

            html += `
                <div class="schedule-item ${s.isActiveNow ? 'active-now' : ''}">
                    <div class="schedule-time">
                        ${time}
                        ${s.isActiveNow ? '<span class="active-now-badge">● LIVE</span>' : ''}
                    </div>
                    <div class="schedule-subject">${s.subjects.subject_code} – ${s.subjects.subject_name}</div>
                    <div class="schedule-detail">👨‍🏫 ${prof} · Section: ${s.section}</div>
                    <div class="schedule-detail">🎓 ${s.semester} ${s.school_year} · ✅ ${s.enrolledCount} enrolled</div>
                </div>
            `;
        });

        html += '</div>';
    });

    container.innerHTML = html;
}

// expose to inline onclick handlers
window.toggleLabSchedules = toggleLabSchedules;