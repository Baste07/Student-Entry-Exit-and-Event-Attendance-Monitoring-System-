/* ═══════════════════════════════════════════════════════════
   eventAttendance.js — Event Attendance (Fixed for Student Data)
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allEventsList   = [];
let currentEventId   = '';
let currentEvent     = null;
let currentRecords   = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    init();
    bindEvents();
});

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════

async function init() {
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('event_id, event_name, event_date, end_date, time_start, time_end, event_type, location, target_grade_level, target_section, status')
            .neq('status', 'cancelled')
            .order('event_date', { ascending: false });

        if (error) throw error;

        allEventsList = data || [];

        const select = document.getElementById('eventSelect');
        select.innerHTML = '<option value="">-- Select an Event --</option>' +
            allEventsList.map(ev => {
                const dateStr = formatDate(ev.event_date);
                const statusIcon = ev.status === 'ongoing' ? '🔴 ' : (ev.status === 'upcoming' ? '🔵 ' : '✅ ');
                return `<option value="${ev.event_id}">${statusIcon}${escHtml(ev.event_name)} (${dateStr})</option>`;
            }).join('');
    } catch (err) {
        console.error('init error:', err);
        showToast('Failed to load events: ' + (err.message || err), true);
    }
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ══════════════════════════════════════════════════════════
// DATA LOADING (per selected event)
// ══════════════════════════════════════════════════════════

async function loadAttendanceForEvent(eventId) {
    currentEventId = eventId;
    currentEvent = allEventsList.find(ev => ev.event_id === eventId) || null;

    const hint = document.getElementById('eventTargetHint');
    const controlsCard = document.getElementById('controlsCard');
    const tableContainer = document.getElementById('tableContainer');
    const emptyState = document.getElementById('emptyState');
    const eventStats = document.getElementById('eventStats');

    if (!eventId) {
        currentRecords = [];
        updateBadges();
        if (hint) hint.textContent = '';
        if (controlsCard) controlsCard.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'none';
        if (eventStats) eventStats.style.display = 'none';
        document.getElementById('attendanceTableBody').innerHTML = `
            <tr id="loadingRow"><td colspan="7" class="loading-cell">
                <i class="fa-solid fa-calendar-day" style="font-size:28px; color: var(--blue-light); margin-bottom:12px; display:block;"></i>
                Select an event above to view attendance records.
            </td></tr>`;
        return;
    }

    // Show target hint
    if (hint) {
        hint.textContent = currentEvent && currentEvent.target_grade_level
            ? `Target: ${currentEvent.target_grade_level}${currentEvent.target_section ? ' – ' + currentEvent.target_section : ' (all sections)'}`
            : 'Target: All students';
    }

    setTableLoading(true);
    if (controlsCard) controlsCard.style.display = '';
    if (eventStats) eventStats.style.display = '';

    try {
        // Fetch event attendance with student details
        const { data, error } = await supabaseClient
            .from('event_attendance')
            .select(`
                attendance_id,
                event_id,
                student_id,
                time_in,
                time_out,
                verified_by_facial_recognition,
                remarks,
                created_at,
                students (
                    student_id,
                    first_name,
                    last_name,
                    stud_id,
                    section_id,
                    sections (
                        grade_level,
                        section_name
                    )
                )
            `)
            .eq('event_id', eventId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        currentRecords = data || [];
        updateBadges();

        if (currentRecords.length === 0) {
            if (tableContainer) tableContainer.style.display = 'none';
            if (emptyState) emptyState.style.display = '';
        } else {
            if (tableContainer) tableContainer.style.display = '';
            if (emptyState) emptyState.style.display = 'none';
            renderTable(currentRecords);
        }
    } catch (err) {
        console.error('loadAttendanceForEvent error:', err);
        showToast('Failed to load attendance: ' + (err.message || err), true);
        if (tableContainer) tableContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = '';
    }
}

function updateBadges() {
    // Count based on time_in presence (since event_attendance doesn't have a status column)
    const present = currentRecords.filter(r => r.time_in !== null).length;
    const absent = currentRecords.filter(r => r.time_in === null).length;
    const total = currentRecords.length;

    // For late, we'd need time comparison - simplified here
    const late = 0;

    setText('badgePresent', present);
    setText('badgeLate', late);
    setText('badgeAbsent', absent);
    setText('badgeTotal', total);
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

function renderTable(rows) {
    const tbody = document.getElementById('attendanceTableBody');
    const recordCount = document.getElementById('recordCount');
    
    if (recordCount) recordCount.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '';
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const student = r.students;
        const name = student ? `${student.first_name || ''} ${student.last_name || ''}`.trim() : 'Unknown';
        const studId = student ? student.stud_id : '—';
        const sectionInfo = student?.sections 
            ? `${student.sections.grade_level || ''} - ${student.sections.section_name || ''}` 
            : '—';

        // Determine status based on time_in
        let status = 'absent';
        let statusClass = 'absent';
        if (r.time_in) {
            status = 'present';
            statusClass = 'present';
            // Could add late logic here by comparing time_in with event start time
        }

        return `
        <tr data-status="${statusClass}">
            <td><span class="primary-cell">${escHtml(name)}</span></td>
            <td>${escHtml(studId)}</td>
            <td><span class="secondary-cell">${escHtml(sectionInfo)}</span></td>
            <td><span class="badge ${statusClass}"><i class="fa-solid fa-${status === 'present' ? 'check' : 'xmark'}"></i> ${status}</span></td>
            <td>${r.time_in ? formatTime(r.time_in) : '—'}</td>
            <td>${r.time_out ? formatTime(r.time_out) : '—'}</td>
            <td><span class="secondary-cell">${escHtml(truncate(r.remarks, 40))}</span></td>
        </tr>`;
    }).join('');
}

function truncate(str, len) {
    if (!str) return '—';
    return str.length > len ? str.substring(0, len) + '…' : str;
}

function formatTime(t) {
    if (!t) return '—';
    // Handle both time string and timestamp
    if (typeof t === 'string' && t.includes('T')) {
        const d = new Date(t);
        if (!isNaN(d)) {
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }
    }
    // Handle HH:MM:SS format
    const [h, m] = t.split(':');
    const d = new Date();
    d.setHours(+h, +m, 0, 0);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const status = document.getElementById('statusFilter').value;

    document.querySelectorAll('#attendanceTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('eventSelect').addEventListener('change', function () {
        loadAttendanceForEvent(this.value);
    });

    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('attendanceTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px; color: var(--blue-bright); margin-bottom:12px; display:block;"></i> Loading attendance records…</td></tr>`;
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.className = 'toast on' + (isError ? ' error' : '');
    setTimeout(() => toast.className = 'toast', 4000);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}