/* ============================================================
   homepage.js — School Attendance Dashboard
   ============================================================ */

// ── Date / Time Helpers ──────────────────────────────────

const todayISO = new Date().toLocaleDateString('en-CA');

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

// ── Dynamic Status Computation (mirrors events.js) ───────

function getManilaNow() {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}

function computeEventStatus(event) {
    if (event.status === 'cancelled') return 'cancelled';

    const now = getManilaNow();
    const todayStr = now.toLocaleDateString('en-CA');
    const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

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

    for (const upd of updates) {
        try {
            const { error } = await supabaseClient
                .from('events')
                .update({ status: upd.status, updated_at: new Date().toISOString() })
                .eq('event_id', upd.event_id);
            if (error) throw error;
        } catch (err) {
            console.error('Dashboard status sync failed for', upd.event_id, err);
            // Leave ev.status as the computed value for this render; the next
            // 30-second refresh will retry the write.
        }
    }
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

// ── Ongoing event with live attendance count ──
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

// ══════════════════════════════════════════════════════════
// MAIN LOAD
// ══════════════════════════════════════════════════════════

async function loadPage() {
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('fa-spin');

    const [allEvents, ongoingFromDB] = await Promise.all([
        fetchAllEvents(),
        fetchOngoingEvents()
    ]);

    // Merge the two fetches (dedup by event_id) into one working set so status
    // sync covers everything the dashboard knows about, including events that
    // should be "ongoing" now but haven't been flagged that way in the DB yet.
    const eventMap = new Map();
    allEvents.forEach(ev => eventMap.set(ev.event_id, ev));
    ongoingFromDB.forEach(ev => { if (!eventMap.has(ev.event_id)) eventMap.set(ev.event_id, ev); });
    const workingEvents = Array.from(eventMap.values());

    // Keep Supabase in sync before rendering — see syncEventStatuses above.
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

    // ── Badge ──
    const badgeEvents = document.getElementById('eventsBadge');
    if (badgeEvents) badgeEvents.textContent = upcomingEvents.length;

    // ── Upcoming Events ──
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
    if (refreshLabel) refreshLabel.textContent = `Last updated ${now} · auto-refreshes every 30s`;
    if (icon) icon.classList.remove('fa-spin');
}

// Initial load + auto-refresh every 30 seconds
loadPage();
setInterval(loadPage, 30_000);