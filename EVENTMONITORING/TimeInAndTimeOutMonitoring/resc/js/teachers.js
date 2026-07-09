/* ═══════════════════════════════════════════════════════════
   teachers.js — Teachers Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / teachers.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allTeachers = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadTeachers();
    bindEvents();
});

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadTeachers() {
    setTableLoading(true);
    try {
        const { data, error } = await supabaseClient
            .from('teachers')
            .select('*')
            .order('last_name', { ascending: true });

        if (error) throw error;

        allTeachers = data || [];
        populateDepartmentFilter();
        updateBadges();
        renderTable(allTeachers);
    } catch (err) {
        console.error('loadTeachers error:', err);
        showTableError('Failed to load teachers: ' + (err.message || err));
    }
}

function populateDepartmentFilter() {
    const select = document.getElementById('departmentFilter');
    const current = select.value;
    const departments = [...new Set(allTeachers.map(t => t.department).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Departments</option>' +
        departments.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join('');
    select.value = current;
}

function updateBadges() {
    const total = allTeachers.length;
    const active = allTeachers.filter(t => (t.status || 'active') === 'active').length;
    const inactive = total - active;
    setText('badgeTotal', total);
    setText('badgeActive', active);
    setText('badgeInactive', inactive);
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

function renderTable(rows) {
    const tbody = document.getElementById('teachersTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="9" class="empty-cell">
                <i class="fa-solid fa-chalkboard-user" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No teachers found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(t => {
        const status = t.status || 'active';
        const statusBadge = status === 'active'
            ? '<span class="badge status-active">Active</span>'
            : '<span class="badge status-inactive">Inactive</span>';

        return `
        <tr data-department="${escHtml(t.department || '')}" data-status="${status}">
            <td><span class="primary-cell">${escHtml(t.employee_id || '')}</span></td>
            <td>${escHtml(t.last_name || '')}</td>
            <td>${escHtml(t.first_name || '')}</td>
            <td><span class="secondary-cell">${escHtml(t.department || '—')}</span></td>
            <td>${escHtml(t.position || '—')}</td>
            <td>${escHtml(t.contact_number || '—')}</td>
            <td>${escHtml(t.email || '—')}</td>
            <td>${statusBadge}</td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit teacher" onclick="editTeacher('${t.teacher_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete teacher" onclick="deleteTeacher('${t.teacher_id}', '${escHtml((t.first_name || '') + ' ' + (t.last_name || ''))}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('teacherForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const teacherId      = document.getElementById('teacherId').value.trim();
    const employeeId     = document.getElementById('employeeId').value.trim();
    const firstName      = document.getElementById('firstName').value.trim();
    const middleName     = document.getElementById('middleName').value.trim();
    const lastName       = document.getElementById('lastName').value.trim();
    const department     = document.getElementById('department').value.trim();
    const position       = document.getElementById('position').value.trim();
    const email          = document.getElementById('email').value.trim();
    const contactNumber  = document.getElementById('contactNumber').value.trim();
    const status         = document.getElementById('status').value;
    const isEdit          = teacherId !== '';

    if (!employeeId) return showValidationError('Employee ID is required.');
    if (!firstName || !lastName) return showValidationError('First and last name are required.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showValidationError('Please enter a valid email address.');

    const btn  = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking duplicates…';

    try {
        let dupQuery = supabaseClient
            .from('teachers')
            .select('teacher_id, employee_id')
            .eq('employee_id', employeeId);

        if (isEdit) dupQuery = dupQuery.neq('teacher_id', teacherId);

        const { data: dups, error: dupErr } = await dupQuery;
        if (dupErr) throw dupErr;

        if (dups && dups.length > 0) {
            showValidationError(`Employee ID "${employeeId}" is already in use.`);
            btn.disabled = false; btn.innerHTML = orig;
            return;
        }

        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

        const payload = {
            employee_id:     employeeId,
            first_name:      firstName,
            middle_name:     middleName || null,
            last_name:       lastName,
            department:      department || null,
            position:        position || null,
            email:           email || null,
            contact_number:  contactNumber || null,
            status:          status,
        };

        let saveErr;
        if (isEdit) {
            const { error } = await supabaseClient.from('teachers').update(payload).eq('teacher_id', teacherId);
            saveErr = error;
        } else {
            const { error } = await supabaseClient.from('teachers').insert(payload);
            saveErr = error;
        }
        if (saveErr) throw saveErr;

        showToast(isEdit ? 'Teacher updated successfully!' : 'Teacher added successfully!');
        btn.disabled = false; btn.innerHTML = orig;
        closeModal();
        await loadTeachers();
    } catch (err) {
        console.error('Save teacher error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false; btn.innerHTML = orig;
    }
});

async function deleteTeacher(teacherId, teacherName) {
    const confirmed = confirm(`Delete teacher "${teacherName}"?\n\nThis may affect associated sections, schedules, and attendance records.`);
    if (!confirmed) return;

    try {
        const { error } = await supabaseClient.from('teachers').delete().eq('teacher_id', teacherId);
        if (error) throw error;

        showToast(`"${teacherName}" deleted successfully.`);
        await loadTeachers();
    } catch (err) {
        console.error('Delete teacher error:', err);
        alert('Error deleting teacher: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('teacherForm').reset();
    document.getElementById('teacherId').value = '';
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add Teacher';
    document.getElementById('submitBtnText').textContent = 'Add Teacher';
    clearAllValidation();
    openModal();
}

function editTeacher(id) {
    const t = allTeachers.find(x => x.teacher_id === id);
    if (!t) return;

    document.getElementById('teacherId').value     = t.teacher_id;
    document.getElementById('employeeId').value    = t.employee_id || '';
    document.getElementById('firstName').value     = t.first_name || '';
    document.getElementById('middleName').value    = t.middle_name || '';
    document.getElementById('lastName').value      = t.last_name || '';
    document.getElementById('department').value    = t.department || '';
    document.getElementById('position').value      = t.position || '';
    document.getElementById('email').value         = t.email || '';
    document.getElementById('contactNumber').value = t.contact_number || '';
    document.getElementById('status').value        = t.status || 'active';

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Teacher';
    document.getElementById('submitBtnText').textContent = 'Update Teacher';
    clearAllValidation();
    openModal();
}

function openModal() {
    document.getElementById('teacherModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('teacherModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const dept   = document.getElementById('departmentFilter').value;
    const status = document.getElementById('statusFilter').value;

    document.querySelectorAll('#teachersTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const deptMatch   = !dept || row.dataset.department === dept;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && deptMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('departmentFilter').addEventListener('change', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('departmentFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });

    document.getElementById('teacherModal').addEventListener('click', function (e) {
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
    const tbody = document.getElementById('teachersTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="9" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading teachers…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('teachersTableBody').innerHTML = `
        <tr><td colspan="9" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
}

function showValidationError(message) {
    clearValidationError();
    const div = document.createElement('div');
    div.className = 'validation-error';
    div.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i><span>${escHtml(message)}</span>`;
    const form = document.getElementById('teacherForm');
    form.parentElement.insertBefore(div, form);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => div.remove(), 6000);
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#teacherModal input, #teacherModal select').forEach(el => { el.style.borderColor = ''; });
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