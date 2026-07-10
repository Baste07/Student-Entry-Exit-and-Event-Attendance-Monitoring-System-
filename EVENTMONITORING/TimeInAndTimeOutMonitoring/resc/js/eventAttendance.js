/* ═══════════════════════════════════════════════════════════
   eventAttendance.js — Event Attendance Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / eventAttendance.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allEventsList   = [];
let allStudentsList  = [];
let allTeachersList  = [];
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
        const [eventsRes, studentsRes, teachersRes] = await Promise.all([
            supabaseClient.from('events').select('event_id, event_name, event_date, target_grade_level, target_section').order('event_date', { ascending: false }),
            supabaseClient.from('students').select('student_id, first_name, last_name, lrn, year_level, section').order('last_name', { ascending: true }),
            supabaseClient.from('teachers').select('teacher_id, first_name, last_name, employee_id').order('last_name', { ascending: true }),
        ]);

        if (eventsRes.error) throw eventsRes.error;
        if (studentsRes.error) throw studentsRes.error;
        if (teachersRes.error) throw teachersRes.error;

        allEventsList  = eventsRes.data || [];
        allStudentsList = studentsRes.data || [];
        allTeachersList = teachersRes.data || [];

        const select = document.getElementById('eventSelect');
        select.innerHTML = '<option value="">-- Select an Event --</option>' +
            allEventsList.map(ev => `<option value="${ev.event_id}">${escHtml(ev.event_name)} (${formatDate(ev.event_date)})</option>`).join('');
    } catch (err) {
        console.error('init error:', err);
        showTableError('Failed to load initial data: ' + (err.message || err));
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
    document.getElementById('btnAddAttendance').disabled = !eventId;

    const hint = document.getElementById('eventTargetHint');
    if (hint) {
        hint.textContent = currentEvent && currentEvent.target_grade_level
            ? `Needed for this event: ${currentEvent.target_grade_level}${currentEvent.target_section ? ' – ' + currentEvent.target_section : ' (all sections)'}`
            : '';
    }

    if (!eventId) {
        currentRecords = [];
        updateBadges();
        document.getElementById('attendanceTableBody').innerHTML = `
            <tr id="loadingRow"><td colspan="8" class="loading-cell">
                <i class="fa-solid fa-calendar-day" style="font-size:20px;"></i>
                Select an event above to view its attendance.
            </td></tr>`;
        return;
    }

    setTableLoading(true);
    try {
        const { data, error } = await supabaseClient
            .from('event_attendance')
            .select('*, students(student_id, first_name, last_name, lrn), teachers(teacher_id, first_name, last_name, employee_id)')
            .eq('event_id', eventId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        currentRecords = data || [];
        updateBadges();
        renderTable(currentRecords);
    } catch (err) {
        console.error('loadAttendanceForEvent error:', err);
        showTableError('Failed to load attendance: ' + (err.message || err));
    }
}

function updateBadges() {
    const present = currentRecords.filter(r => r.status === 'present').length;
    const late    = currentRecords.filter(r => r.status === 'late').length;
    const absent  = currentRecords.filter(r => r.status === 'absent').length;
    setText('badgePresent', present);
    setText('badgeLate', late);
    setText('badgeAbsent', absent);
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

const statusColors = {
    present: { bg: '#dcfce7', text: '#166534' },
    late:    { bg: '#fef3c7', text: '#92400e' },
    absent:  { bg: '#fee2e2', text: '#b91c1c' },
    excused: { bg: '#e0f2fe', text: '#0369a1' },
};

function renderTable(rows) {
    const tbody = document.getElementById('attendanceTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="8" class="empty-cell">
                <i class="fa-solid fa-calendar-check" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No attendance records for this event yet.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const person = r.students || r.teachers;
        const role   = r.students ? 'student' : 'teacher';
        const name   = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown';
        const idNum  = r.students ? (person && person.lrn) : (person && person.employee_id);
        const sc     = statusColors[r.status] || statusColors.present;

        return `
        <tr data-role="${role}" data-status="${escHtml(r.status || '')}">
            <td><span class="primary-cell">${escHtml(name)}</span></td>
            <td><span class="badge info">${role === 'student' ? 'Student' : 'Teacher'}</span></td>
            <td>${escHtml(idNum || '—')}</td>
            <td><span class="badge" style="background:${sc.bg};color:${sc.text}">${escHtml(r.status || '')}</span></td>
            <td>${r.time_in ? formatTime(r.time_in) : '—'}</td>
            <td>${r.time_out ? formatTime(r.time_out) : '—'}</td>
            <td><span class="secondary-cell">${escHtml(truncate(r.remarks, 40))}</span></td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit record" onclick="editRecord('${r.attendance_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete record" onclick="deleteRecord('${r.attendance_id}', '${escHtml(name)}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function truncate(str, len) {
    if (!str) return '—';
    return str.length > len ? str.substring(0, len) + '…' : str;
}

function formatTime(t) {
    if (!t) return '—';
    const [h, m] = t.split(':');
    const d = new Date();
    d.setHours(+h, +m, 0, 0);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ══════════════════════════════════════════════════════════
// PERSON DROPDOWN (role-dependent)
// ══════════════════════════════════════════════════════════

// A student is "needed" for the event if their grade level matches the
// event's target grade level, and (when the event specifies a section)
// their section matches too. No target grade level on the event = open to all.
function isStudentEligibleForEvent(student, event) {
    if (!event || !event.target_grade_level) return true;
    if ((student.year_level || '').trim() !== event.target_grade_level.trim()) return false;
    if (event.target_section && (student.section || '').trim() !== event.target_section.trim()) return false;
    return true;
}

function populatePersonDropdown(role, selectedId) {
    const select = document.getElementById('personId');

    if (role === 'teacher') {
        select.innerHTML = '<option value="" disabled selected>-- Select --</option>' +
            allTeachersList.map(p =>
                `<option value="${p.teacher_id}">${escHtml(p.last_name)}, ${escHtml(p.first_name)}${p.employee_id ? ' — ' + escHtml(p.employee_id) : ''}</option>`
            ).join('');
        if (selectedId) select.value = selectedId;
        return;
    }

    let eligible = currentEvent
        ? allStudentsList.filter(s => isStudentEligibleForEvent(s, currentEvent))
        : allStudentsList;

    // If editing a record for a student outside the current target group
    // (e.g. added before the event's target was set), keep them selectable
    // so the existing record can still be edited.
    if (selectedId && !eligible.some(s => s.student_id === selectedId)) {
        const existing = allStudentsList.find(s => s.student_id === selectedId);
        if (existing) eligible = [existing, ...eligible];
    }

    if (currentEvent && currentEvent.target_grade_level && eligible.length === 0) {
        select.innerHTML = '<option value="" disabled selected>-- No students match this event\'s target grade/section --</option>';
        return;
    }

    select.innerHTML = '<option value="" disabled selected>-- Select --</option>' +
        eligible.map(p =>
            `<option value="${p.student_id}">${escHtml(p.last_name)}, ${escHtml(p.first_name)}${p.lrn ? ' — ' + escHtml(p.lrn) : ''}</option>`
        ).join('');

    if (selectedId) select.value = selectedId;
}

// ══════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('attendanceForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    if (!currentEventId) return showValidationError('Please select an event first.');

    const attendanceId = document.getElementById('attendanceId').value.trim();
    const personRole   = document.getElementById('personRole').value;
    const personId      = document.getElementById('personId').value;
    const status        = document.getElementById('status').value;
    const timeIn        = document.getElementById('timeIn').value;
    const timeOut       = document.getElementById('timeOut').value;
    const remarks       = document.getElementById('remarks').value.trim();
    const isEdit         = attendanceId !== '';

    if (!personId) return showValidationError('Please select a person.');
    if (timeIn && timeOut && timeOut <= timeIn) return showValidationError('Time out must be after time in.');

    if (personRole === 'student' && currentEvent && currentEvent.target_grade_level) {
        const student = allStudentsList.find(s => s.student_id === personId);
        if (!student || !isStudentEligibleForEvent(student, currentEvent)) {
            const target = currentEvent.target_grade_level + (currentEvent.target_section ? ' – ' + currentEvent.target_section : '');
            return showValidationError(`This student is not part of the event's target group (${target}).`);
        }
    }

    const btn  = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        // Prevent duplicate attendance entries for the same person + event
        let dupQuery = supabaseClient
            .from('event_attendance')
            .select('attendance_id')
            .eq('event_id', currentEventId);

        dupQuery = personRole === 'teacher'
            ? dupQuery.eq('teacher_id', personId)
            : dupQuery.eq('student_id', personId);

        if (isEdit) dupQuery = dupQuery.neq('attendance_id', attendanceId);

        const { data: dups, error: dupErr } = await dupQuery;
        if (dupErr) throw dupErr;

        if (dups && dups.length > 0) {
            showValidationError('This person already has an attendance record for this event.');
            btn.disabled = false; btn.innerHTML = orig;
            return;
        }

        const payload = {
            event_id:   currentEventId,
            student_id: personRole === 'student' ? personId : null,
            teacher_id: personRole === 'teacher' ? personId : null,
            status:     status,
            time_in:    timeIn || null,
            time_out:   timeOut || null,
            remarks:    remarks || null,
        };

        let saveErr;
        if (isEdit) {
            const { error } = await supabaseClient.from('event_attendance').update(payload).eq('attendance_id', attendanceId);
            saveErr = error;
        } else {
            const { error } = await supabaseClient.from('event_attendance').insert(payload);
            saveErr = error;
        }
        if (saveErr) throw saveErr;

        showToast(isEdit ? 'Attendance record updated!' : 'Attendance record saved!');
        btn.disabled = false; btn.innerHTML = orig;
        closeModal();
        await loadAttendanceForEvent(currentEventId);
    } catch (err) {
        console.error('Save attendance error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false; btn.innerHTML = orig;
    }
});

async function deleteRecord(attendanceId, name) {
    const confirmed = confirm(`Delete attendance record for "${name}"?`);
    if (!confirmed) return;

    try {
        const { error } = await supabaseClient.from('event_attendance').delete().eq('attendance_id', attendanceId);
        if (error) throw error;

        showToast(`Record for "${name}" deleted.`);
        await loadAttendanceForEvent(currentEventId);
    } catch (err) {
        console.error('Delete attendance error:', err);
        alert('Error deleting record: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    if (!currentEventId) return;
    document.getElementById('attendanceForm').reset();
    document.getElementById('attendanceId').value = '';
    document.getElementById('personRole').value = 'student';
    populatePersonDropdown('student');
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Record Attendance';
    document.getElementById('submitBtnText').textContent = 'Save Record';
    clearAllValidation();
    openModal();
}

function editRecord(id) {
    const r = currentRecords.find(x => x.attendance_id === id);
    if (!r) return;

    const role = r.students ? 'student' : 'teacher';
    const personId = r.students ? r.student_id : r.teacher_id;

    document.getElementById('attendanceId').value = r.attendance_id;
    document.getElementById('personRole').value = role;
    populatePersonDropdown(role, personId);
    document.getElementById('status').value  = r.status || 'present';
    document.getElementById('timeIn').value  = r.time_in || '';
    document.getElementById('timeOut').value = r.time_out || '';
    document.getElementById('remarks').value = r.remarks || '';

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Attendance Record';
    document.getElementById('submitBtnText').textContent = 'Update Record';
    clearAllValidation();
    openModal();
}

function openModal() {
    document.getElementById('attendanceModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('attendanceModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const role   = document.getElementById('roleFilter').value;
    const status = document.getElementById('statusFilter').value;

    document.querySelectorAll('#attendanceTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const roleMatch   = !role || row.dataset.role === role;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && roleMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('eventSelect').addEventListener('change', function () {
        loadAttendanceForEvent(this.value);
    });

    document.getElementById('personRole').addEventListener('change', function () {
        populatePersonDropdown(this.value);
    });

    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('roleFilter').addEventListener('change', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('roleFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });

    document.getElementById('attendanceModal').addEventListener('click', function (e) {
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
    const tbody = document.getElementById('attendanceTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading attendance…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('attendanceTableBody').innerHTML = `
        <tr><td colspan="8" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
}

function showValidationError(message) {
    clearValidationError();
    const div = document.createElement('div');
    div.className = 'validation-error';
    div.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i><span>${escHtml(message)}</span>`;
    const form = document.getElementById('attendanceForm');
    form.parentElement.insertBefore(div, form);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => div.remove(), 6000);
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#attendanceModal input, #attendanceModal select, #attendanceModal textarea').forEach(el => { el.style.borderColor = ''; });
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