/* ============================================================
   homepage.js — School Attendance Dashboard
   ============================================================ */

// ── Date / Time Helpers ──────────────────────────────────

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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function formatEventDate(date) {
    if (!date) return 'Date not specified';
    return new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

function eventDateLabel(event) {
    const startDate = formatEventDate(event.event_date);
    if (!event.end_date || event.end_date === event.event_date) return startDate;
    return `${startDate} – ${formatEventDate(event.end_date)}`;
}

function eventTimeLabel(event) {
    if (!event.time_start && !event.time_end) return 'All day';
    return `${event.time_start ? formatTime(event.time_start) : '—'} – ${event.time_end ? formatTime(event.time_end) : '—'}`;
}

// ── Dynamic Status Computation (mirrors events.js) ───────

function getManilaNow() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}

function computeEventStatus(event) {
    if (event.status === 'cancelled') return 'cancelled';

    const now = getManilaNow();
    const todayStr = now.toLocaleDateString('en-CA');
    const currentTime = now.toTimeString().slice(0, 8); // "HH:MM:SS"

    const startDate = event.event_date;
    const endDate = event.end_date || event.event_date;
    const startTime = event.time_start;
    const endTime = event.time_end;

    if (endDate < todayStr) return 'completed';

    if (endDate === todayStr) {
        if (endTime && currentTime >= endTime) return 'completed';
        if (startTime && currentTime < startTime) return 'upcoming';
        return 'ongoing';
    }

    if (startDate > todayStr) return 'upcoming';

    if (startDate === todayStr) {
        if (startTime && currentTime < startTime) return 'upcoming';
        return 'ongoing';
    }

    if (startDate < todayStr && endDate > todayStr) return 'ongoing';

    return 'upcoming';
}

// ── Push any status changes to Supabase ──────────────────
// The DB status column is the single source of truth for the whole app
// (dashboard + events admin page). Previously only the events admin page
// wrote status transitions back to Supabase, so if nobody had that page
// open, events stayed stuck on stale statuses (e.g. "upcoming" long after
// they'd started). The dashboard now performs the same sync.
async function syncEventStatuses(events) {
    const updates = [];

    events.forEach(ev => {
        if (ev.status === 'cancelled') return;
        const computed = computeEventStatus(ev);
        if (computed !== ev.status) {
            updates.push({ event_id: ev.event_id, status: computed });
            ev.status = computed; // reflect immediately so this page renders correctly too
        }
    });

    if (updates.length === 0) return;

    await Promise.all(updates.map(async upd => {
        try {
            const { error } = await supabaseClient
                .from('events')
                .update({ status: upd.status, updated_at: new Date().toISOString() })
                .eq('event_id', upd.event_id);
            if (error) throw error;
        } catch (err) {
            console.error('Dashboard status sync failed for', upd.event_id, err);
        }
    }));
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

// ══════════════════════════════════════════════════════════
// EVENTS FETCH & RENDER
// ══════════════════════════════════════════════════════════

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
    const pageSize = 500;
    const events = [];

    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabaseClient
            .from('events')
            .select('event_id, event_name, event_date, end_date, time_start, time_end, event_type, location, description, target_grade_level, target_section, status')
            .order('event_date', { ascending: true })
            .order('event_id', { ascending: true })
            .range(offset, offset + pageSize - 1);

        if (error) throw error;

        const page = data || [];
        events.push(...page);
        if (page.length < pageSize) break;
    }

    await EventTargets.attach(supabaseClient, events);
    return events;
}

const typeColors = {
    assembly: '#176aa4', meeting: '#06b6d4', sports: '#f59e0b',
    ceremony: '#ec4899', exam: '#ef4444', holiday: '#22c55e', other: '#6b7280',
};

function safeTargetSummary(event) {
    return escapeHtml(EventTargets.summary(event));
}

function renderEventDetails(event) {
    const audience = safeTargetSummary(event) || 'Audience details unavailable';
    const description = event.description?.trim()
        ? escapeHtml(event.description.trim())
        : 'No event description provided.';

    return `
        <div class="event-details">
            <div class="event-detail">
                <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
                <div><span>Date</span><strong>${escapeHtml(eventDateLabel(event))}</strong></div>
            </div>
            <div class="event-detail">
                <i class="fa-solid fa-clock" aria-hidden="true"></i>
                <div><span>Time</span><strong>${escapeHtml(eventTimeLabel(event))}</strong></div>
            </div>
            <div class="event-detail">
                <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                <div><span>Location</span><strong>${escapeHtml(event.location?.trim() || 'Location not specified')}</strong></div>
            </div>
            <div class="event-detail">
                <i class="fa-solid fa-users" aria-hidden="true"></i>
                <div><span>Audience</span><strong>${audience}</strong></div>
            </div>
        </div>
        <p class="event-desc">${description}</p>`;
}

// ── Ongoing event with live attendance count ──
function renderOngoingEventCard(ev, presentCount) {
    const color = typeColors[ev.event_type?.toLowerCase()] || '#6b7280';

    return `
        <div class="card event-card event-card--ongoing">
            <div class="event-header">
                <span class="event-type" style="background:${color}20; color:${color}">${escapeHtml(ev.event_type || 'Event')}</span>
                <span class="event-status-badge ongoing">
                    <i class="fa-solid fa-circle-play"></i> LIVE
                </span>
            </div>
            <h3 class="event-name">${escapeHtml(ev.event_name || 'Untitled Event')}</h3>
            ${renderEventDetails(ev)}
            <div class="event-attendance-summary">
                <span>
                    <i class="fa-solid fa-users"></i> Attendance
                </span>
                <strong>${presentCount} <small>checked in</small></strong>
            </div>
        </div>`;
}

function renderEvent(ev) {
    const color = typeColors[ev.event_type?.toLowerCase()] || '#6b7280';
    const status = ev.status === 'completed'
        ? { label: 'Completed', icon: 'fa-check-circle', className: 'completed' }
        : { label: 'Upcoming', icon: 'fa-calendar-check', className: 'upcoming' };

    return `
        <div class="card event-card event-card--${status.className}">
            <div class="event-header">
                <span class="event-type" style="background:${color}20; color:${color}">${escapeHtml(ev.event_type || 'Event')}</span>
                <span class="event-status-badge ${status.className}"><i class="fa-solid ${status.icon}"></i> ${status.label}</span>
            </div>
            <h3 class="event-name">${escapeHtml(ev.event_name || 'Untitled Event')}</h3>
            ${renderEventDetails(ev)}
        </div>`;
}

// ══════════════════════════════════════════════════════════
// MAIN LOAD
// ══════════════════════════════════════════════════════════

let isPageLoading = false;

async function loadPage() {
    if (isPageLoading) return;
    isPageLoading = true;

    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('fa-spin');

    try {
        const workingEvents = await fetchAllEvents();
        await syncEventStatuses(workingEvents);

        // Split events by (now up-to-date) status for the three rows
        const ongoingEvents   = workingEvents.filter(ev => ev.status === 'ongoing');
        const upcomingEvents  = workingEvents.filter(ev => ev.status !== 'ongoing' && ev.status !== 'completed' && ev.status !== 'cancelled');
        const completedEvents = workingEvents.filter(ev => ev.status === 'completed');

        // ── ONGOING EVENTS (with live attendance) ──
        const ongoingSection = document.getElementById('ongoingEventsSection');
        const ongoingGrid    = document.getElementById('ongoingEventsGrid');
        const badgeOngoing   = document.getElementById('ongoingEventsBadge');
        if (badgeOngoing) badgeOngoing.textContent = ongoingEvents.length;
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

        // ── Upcoming Events ──
        const badgeEvents = document.getElementById('eventsBadge');
        if (badgeEvents) badgeEvents.textContent = upcomingEvents.length;

        const eventsGrid = document.getElementById('eventsGrid');
        if (eventsGrid) {
            eventsGrid.innerHTML = upcomingEvents.length
                ? upcomingEvents.map(renderEvent).join('')
                : `<div class="empty">
                   <i class="fa-solid fa-calendar-xmark"></i>
                   <h3>No Events</h3>
                   <p>No upcoming events to display.</p>
               </div>`;
        }

        // ── Completed Events ──
        const badgeCompleted = document.getElementById('completedEventsBadge');
        if (badgeCompleted) badgeCompleted.textContent = completedEvents.length;

        const completedGrid = document.getElementById('completedEventsGrid');
        if (completedGrid) {
            completedGrid.innerHTML = completedEvents.length
                ? completedEvents.map(renderEvent).join('')
                : `<div class="empty">
                   <i class="fa-solid fa-calendar-xmark"></i>
                   <h3>No Completed Events</h3>
                   <p>Completed events will appear here.</p>
               </div>`;
        }

        // ── Refresh label ──
        const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const refreshLabel = document.getElementById('refreshLabel');
        if (refreshLabel) refreshLabel.textContent = `Last updated ${now} · auto-refreshes every 5s`;
    } catch (error) {
        console.error('Homepage event load failed:', error);
        for (const id of ['ongoingEventsGrid', 'eventsGrid', 'completedEventsGrid']) {
            const grid = document.getElementById(id);
            if (grid) grid.innerHTML = '<div class="empty" role="alert"><h3>Events could not be loaded</h3><p>Please refresh the page or try again shortly.</p></div>';
        }
        const refreshLabel = document.getElementById('refreshLabel');
        if (refreshLabel) refreshLabel.textContent = 'Unable to refresh events. Retrying in 5 seconds.';
    } finally {
        if (icon) icon.classList.remove('fa-spin');
        isPageLoading = false;
    }
}

// Initial load + auto-refresh every 5 seconds
loadPage();
setInterval(loadPage, 5_000);
