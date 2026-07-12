/**
 * ============================================================
 * DASHBOARD JAVASCRIPT — SUPABASE VERSION
 * School Attendance System — Events, Students, Teachers, Reports
 * ============================================================
 */

// ────────────────────────────────────────────
// INITIALIZE
// ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadDashboardData();
    initProfileModal();
});

// ────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────

function formatDate(date = new Date()) {
    return date.toISOString().split('T')[0];
}

function formatTime(time) {
    if (!time) return '—';
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
            loadRecentEvents()
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
            : (userData.lastName || userData.email);

        document.getElementById('adminName').textContent = displayName;
        document.getElementById('adminRole').textContent =
            userData.adminLevel === 'super_admin' ? 'Super Admin' : 'Admin';

        if (userData.departmentLogo) {
            document.getElementById('profilePic').src = userData.departmentLogo;
        }

        console.log('✅ Profile loaded:', displayName);

    } catch (error) {
        console.error('Profile error:', error);
    }
}

// ────────────────────────────────────────────
// VIEW PROFILE MODAL
// ────────────────────────────────────────────

function initProfileModal() {
    const trigger = document.getElementById('viewProfileBtn');
    const modal   = document.getElementById('profileModal');
    if (!trigger || !modal) return;

    trigger.addEventListener('click', openProfileModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeProfileModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) closeProfileModal();
    });
}

function openProfileModal() {
    try {
        const userDataStr = sessionStorage.getItem('user');
        if (!userDataStr) return;
        const userData = JSON.parse(userDataStr);

        const displayName = userData.firstName
            ? `${userData.firstName} ${userData.lastName}`
            : (userData.lastName || userData.email);

        document.getElementById('profileModalName').textContent  = displayName || '—';
        document.getElementById('profileModalRole').textContent  =
            userData.adminLevel === 'super_admin' ? 'Super Admin' : 'Admin';
        document.getElementById('profileModalEmpId').textContent = userData.employeeId || '—';
        document.getElementById('profileModalEmail').textContent = userData.email || '—';
        document.getElementById('profileModalDept').textContent  = userData.department || '—';
        document.getElementById('profileModalLevel').textContent =
            userData.adminLevel === 'super_admin' ? 'Super Admin (full access)' : 'Admin';

        const loginTime = userData.loginTime ? new Date(userData.loginTime) : null;
        document.getElementById('profileModalLoginTime').textContent = loginTime
            ? loginTime.toLocaleString('en-US', {
                dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila'
              })
            : '—';

        if (userData.departmentLogo) {
            document.getElementById('profileModalPic').src = userData.departmentLogo;
        }

        document.getElementById('profileModal').classList.add('active');
    } catch (err) {
        console.error('Failed to open profile modal:', err);
    }
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('active');
}

window.closeProfileModal = closeProfileModal;

// ────────────────────────────────────────────
// LOAD STATISTICS
// ────────────────────────────────────────────

async function loadStatistics() {
    try {
        // Active Events (upcoming or ongoing)
        const { count: totalEvents } = await supabaseClient
            .from('events')
            .select('*', { count: 'exact', head: true })
            .in('status', ['upcoming', 'scheduled', 'ongoing']);

        // Active Students
        const { count: totalStudents } = await supabaseClient
            .from('students')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        // Active Teachers
        const { count: totalTeachers } = await supabaseClient
            .from('teachers')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');

        // Generated Reports
        const { count: totalReports } = await supabaseClient
            .from('attendance_reports')
            .select('*', { count: 'exact', head: true });

        document.getElementById('totalEvents').textContent    = totalEvents    || 0;
        document.getElementById('totalStudents').textContent   = totalStudents   || 0;
        document.getElementById('totalTeachers').textContent   = totalTeachers   || 0;
        document.getElementById('totalReports').textContent    = totalReports    || 0;

        console.log('✅ Statistics loaded');

    } catch (error) {
        console.error('Statistics error:', error);
    }
}

// ────────────────────────────────────────────
// LOAD RECENT EVENTS
// ────────────────────────────────────────────

async function loadRecentEvents() {
    try {
        const today = formatDate();

        const { data: events, error } = await supabaseClient
            .from('events')
            .select(`
                *,
                event_participants(count)
            `)
            .gte('event_date', today)
            .in('status', ['upcoming', 'scheduled', 'ongoing'])
            .order('event_date', { ascending: true })
            .order('time_start', { ascending: true })
            .limit(6);

        if (error) throw error;

        if (!events || events.length === 0) {
            document.getElementById('eventsGrid').innerHTML =
                '<p class="no-schedules">No upcoming events found.</p>';
            return;
        }

        const eventsWithAttendance = await Promise.all(events.map(async (event) => {
            const { count: attendedCount } = await supabaseClient
                .from('event_attendance')
                .select('*', { count: 'exact', head: true })
                .eq('event_id', event.event_id)
                .not('time_in', 'is', null);

            const { count: totalParticipants } = await supabaseClient
                .from('event_participants')
                .select('*', { count: 'exact', head: true })
                .eq('event_id', event.event_id);

            const now = getCurrentTime();
            const isOngoing = event.status === 'ongoing' || 
                (event.event_date === today && event.time_start <= now && event.time_end >= now);

            return {
                ...event,
                attendedCount: attendedCount || 0,
                totalParticipants: totalParticipants || 0,
                isOngoing
            };
        }));

        displayEvents(eventsWithAttendance);
        console.log('✅ Events loaded:', eventsWithAttendance.length);

    } catch (error) {
        console.error('Events error:', error);
        document.getElementById('eventsGrid').innerHTML =
            '<p class="no-schedules">Failed to load events.</p>';
    }
}

// ────────────────────────────────────────────
// DISPLAY EVENTS
// ────────────────────────────────────────────

function displayEvents(events) {
    const container = document.getElementById('eventsGrid');
    let html = '';

    events.forEach(event => {
        const percentage = event.totalParticipants > 0 
            ? (event.attendedCount / event.totalParticipants) * 100 
            : 0;
        
        const statusClass = event.status === 'ongoing' || event.isOngoing ? 'occupied'
            : event.status === 'upcoming' ? 'pending'
            : 'available';
        
        const headerClass = event.status === 'ongoing' || event.isOngoing ? 'occupied'
            : event.status === 'upcoming' ? 'pending'
            : '';
        
        const progressClass = percentage >= 80 ? 'high' : '';

        const statusText = event.status === 'ongoing' || event.isOngoing ? '● ONGOING'
            : event.status === 'upcoming' ? '⏳ UPCOMING'
            : event.status === 'scheduled' ? '📅 SCHEDULED'
            : '✓ COMPLETED';

        const statusBadgeClass = event.status === 'ongoing' || event.isOngoing ? 'occupied'
            : event.status === 'upcoming' ? 'pending'
            : 'available';

        html += `
            <div class="lab-card" id="event-${event.event_id}">
                <div class="lab-card-header ${headerClass}">
                    <span class="lab-status-badge ${statusBadgeClass}">
                        ${statusText}
                    </span>
                    <div class="lab-top">
                        <div class="lab-info">
                            <h4>${escapeHtml(event.event_name)}</h4>
                            <span>${escapeHtml(event.event_type || 'General Event')}</span>
                        </div>
                    </div>
                    <div class="lab-meta">
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-calendar"></i>
                            <span>${formatDateDisplay(event.event_date)}</span>
                        </div>
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-clock"></i>
                            <span>${formatTime(event.time_start)} – ${formatTime(event.time_end)}</span>
                        </div>
                        <div class="lab-meta-item">
                            <i class="fa-solid fa-location-dot"></i>
                            <span>${escapeHtml(event.location || 'TBA')}</span>
                        </div>
                    </div>
                </div>

                ${event.isOngoing ? `
                <div class="current-session-info">
                    <div class="current-session-title">
                        <i class="fa-solid fa-broadcast-tower"></i> Live Attendance
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-users"></i>
                        <strong>${event.attendedCount}</strong> students checked in
                    </div>
                    <div class="current-session-detail">
                        <i class="fa-solid fa-user-check"></i>
                        ${event.totalParticipants} total participants
                    </div>
                </div>
                ` : event.status === 'upcoming' ? `
                <div class="pending-session-info">
                    <i class="fa-solid fa-user-clock"></i>
                    Starts at ${formatTime(event.time_start)} — waiting to begin
                </div>
                ` : ''}

                <div class="lab-progress-container">
                    <div class="lab-progress-bar ${progressClass}" style="width:${percentage}%"></div>
                </div>

                <div class="lab-footer">
                    <span class="lab-count">${event.attendedCount}/${event.totalParticipants || 0} Attendance</span>
                    <span class="lab-capacity-text">${Math.round(percentage)}%</span>
                </div>

                <button class="schedules-toggle"
                        onclick="event.stopPropagation(); toggleEventDetails('${event.event_id}')">
                    <i class="fa-solid fa-chevron-down"></i>
                    <span>View Event Details</span>
                </button>

                <div class="schedules-container" id="details-${event.event_id}">
                    <div class="schedules-content" id="details-content-${event.event_id}">
                        <div class="schedule-item">
                            <div class="schedule-subject">Description</div>
                            <div class="schedule-detail">${escapeHtml(event.description || 'No description provided.')}</div>
                        </div>
                        <div class="schedule-item">
                            <div class="schedule-subject">Target Audience</div>
                            <div class="schedule-detail">
                                ${event.target_grade_level ? `Grade Level: ${escapeHtml(event.target_grade_level)}` : 'All grade levels'}
                                ${event.target_section ? ` · Section: ${escapeHtml(event.target_section)}` : ''}
                            </div>
                        </div>
                        ${event.end_date && event.end_date !== event.event_date ? `
                        <div class="schedule-item">
                            <div class="schedule-subject">Multi-day Event</div>
                            <div class="schedule-detail">Ends on ${formatDateDisplay(event.end_date)}</div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// ────────────────────────────────────────────
// EVENT DETAILS EXPANSION
// ────────────────────────────────────────────

function toggleEventDetails(eventId) {
    const card = document.getElementById('event-' + eventId);
    
    if (card.classList.contains('expanded')) {
        card.classList.remove('expanded');
        return;
    }

    document.querySelectorAll('.lab-card').forEach(c => c.classList.remove('expanded'));
    card.classList.add('expanded');
}

window.toggleEventDetails = toggleEventDetails;

// ────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────

function formatDateDisplay(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}