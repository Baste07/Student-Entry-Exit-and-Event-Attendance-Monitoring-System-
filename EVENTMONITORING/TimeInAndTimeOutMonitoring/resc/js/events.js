/* ═══════════════════════════════════════════════════════════
   events.js — Events Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / events.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allEvents = [];
const todayISO = new Date().toLocaleDateString('en-CA');

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadEvents();
    bindEvents();
});

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadEvents() {
    setTableLoading(true);
    try {
        const { data, error } = await supabaseClient
            .from('events')
            .select('*')
            .order('event_date', { ascending: false });

        if (error) throw error;

        allEvents = data || [];
        updateBadges();
        renderTable(allEvents);
    } catch (err) {
        console.error('loadEvents error:', err);
        showTableError('Failed to load events: ' + (err.message || err));
    }
}

function updateBadges() {
    const total    = allEvents.length;
    const upcoming = allEvents.filter(e => e.event_date >= todayISO && e.status !== 'cancelled' && e.status !== 'completed').length;
    const past     = allEvents.filter(e => e.event_date < todayISO || e.status === 'completed').length;
    setText('badgeTotal', total);
    setText('badgeUpcoming', upcoming);
    setText('badgePast', past);
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

const typeColors = {
    assembly: '#8b5cf6', meeting: '#06b6d4', sports: '#f59e0b',
    ceremony: '#ec4899', exam: '#ef4444', holiday: '#22c55e', other: '#6b7280',
};

const statusColors = {
    upcoming: { bg: '#e0f2fe', text: '#0369a1' },
    ongoing:  { bg: '#dcfce7', text: '#166534' },
    completed:{ bg: '#f1f5f9', text: '#475569' },
    cancelled:{ bg: '#fee2e2', text: '#b91c1c' },
};

function renderTable(rows) {
    const tbody = document.getElementById('eventsTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="7" class="empty-cell">
                <i class="fa-solid fa-calendar-day" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No events found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(ev => {
        const typeColor = typeColors[ev.event_type] || '#6b7280';
        const status = ev.status || 'upcoming';
        const sc = statusColors[status] || statusColors.upcoming;

        const dateLabel = ev.event_date
            ? new Date(ev.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';
        const timeLabel = ev.time_start
            ? `${formatTime(ev.time_start)}${ev.time_end ? ' – ' + formatTime(ev.time_end) : ''}`
            : '—';

        return `
        <tr data-type="${escHtml(ev.event_type || '')}" data-status="${status}">
            <td><span class="primary-cell">${escHtml(ev.event_name || '')}</span></td>
            <td>${dateLabel}</td>
            <td>${timeLabel}</td>
            <td><span class="badge" style="background:${typeColor}20;color:${typeColor}">${escHtml(ev.event_type || '—')}</span></td>
            <td><span class="secondary-cell">${escHtml(ev.location || '—')}</span></td>
            <td><span class="badge" style="background:${sc.bg};color:${sc.text}">${escHtml(status)}</span></td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit event" onclick="editEvent('${ev.event_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete event" onclick="deleteEvent('${ev.event_id}', '${escHtml(ev.event_name)}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function formatTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':');
    const d = new Date();
    d.setHours(+h, +m, 0, 0);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ══════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('eventForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const eventId     = document.getElementById('eventId').value.trim();
    const eventName   = document.getElementById('eventName').value.trim();
    const eventDate   = document.getElementById('eventDate').value;
    const eventType   = document.getElementById('eventType').value;
    const timeStart   = document.getElementById('timeStart').value;
    const timeEnd     = document.getElementById('timeEnd').value;
    const location    = document.getElementById('location').value.trim();
    const status      = document.getElementById('status').value;
    const description = document.getElementById('description').value.trim();
    const isEdit       = eventId !== '';

    if (!eventName) return showValidationError('Event name is required.');
    if (!eventDate) return showValidationError('Event date is required.');
    if (!eventType) return showValidationError('Please select an event type.');
    if (timeStart && timeEnd && timeEnd <= timeStart) return showValidationError('End time must be after start time.');

    const btn  = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const payload = {
            event_name:  eventName,
            event_date:  eventDate,
            event_type:  eventType,
            time_start:  timeStart || null,
            time_end:    timeEnd || null,
            location:    location || null,
            status:      status,
            description: description || null,
        };

        let saveErr;
        if (isEdit) {
            const { error } = await supabaseClient.from('events').update(payload).eq('event_id', eventId);
            saveErr = error;
        } else {
            const { error } = await supabaseClient.from('events').insert(payload);
            saveErr = error;
        }
        if (saveErr) throw saveErr;

        showToast(isEdit ? 'Event updated successfully!' : 'Event added successfully!');
        btn.disabled = false; btn.innerHTML = orig;
        closeModal();
        await loadEvents();
    } catch (err) {
        console.error('Save event error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false; btn.innerHTML = orig;
    }
});

async function deleteEvent(eventId, eventName) {
    const confirmed = confirm(`Delete event "${eventName}"?\n\nThis will also remove any associated event attendance records.`);
    if (!confirmed) return;

    try {
        await supabaseClient.from('event_attendance').delete().eq('event_id', eventId);

        const { error } = await supabaseClient.from('events').delete().eq('event_id', eventId);
        if (error) throw error;

        showToast(`"${eventName}" deleted successfully.`);
        await loadEvents();
    } catch (err) {
        console.error('Delete event error:', err);
        alert('Error deleting event: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('eventForm').reset();
    document.getElementById('eventId').value = '';
    document.getElementById('status').value = 'upcoming';
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add Event';
    document.getElementById('submitBtnText').textContent = 'Add Event';
    clearAllValidation();
    openModal();
}

function editEvent(id) {
    const ev = allEvents.find(x => x.event_id === id);
    if (!ev) return;

    document.getElementById('eventId').value     = ev.event_id;
    document.getElementById('eventName').value   = ev.event_name || '';
    document.getElementById('eventDate').value   = ev.event_date || '';
    document.getElementById('eventType').value   = ev.event_type || '';
    document.getElementById('timeStart').value   = ev.time_start || '';
    document.getElementById('timeEnd').value     = ev.time_end || '';
    document.getElementById('location').value    = ev.location || '';
    document.getElementById('status').value      = ev.status || 'upcoming';
    document.getElementById('description').value = ev.description || '';

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Event';
    document.getElementById('submitBtnText').textContent = 'Update Event';
    clearAllValidation();
    openModal();
}

function openModal() {
    document.getElementById('eventModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('eventModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const type   = document.getElementById('typeFilter').value;
    const status = document.getElementById('statusFilter').value;

    document.querySelectorAll('#eventsTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const typeMatch   = !type || row.dataset.type === type;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && typeMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('typeFilter').addEventListener('change', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('typeFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });

    document.getElementById('eventModal').addEventListener('click', function (e) {
        if (e.target === this) closeModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('eventsTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading events…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('eventsTableBody').innerHTML = `
        <tr><td colspan="7" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
}

function showValidationError(message) {
    clearValidationError();
    const div = document.createElement('div');
    div.className = 'validation-error';
    div.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i><span>${escHtml(message)}</span>`;
    const form = document.getElementById('eventForm');
    form.parentElement.insertBefore(div, form);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => div.remove(), 6000);
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#eventModal input, #eventModal select, #eventModal textarea').forEach(el => { el.style.borderColor = ''; });
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
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