/* ═══════════════════════════════════════════════════════════
    teachers.js — Employee Management Logic (Supabase)
   K-10 Attendance System — Read-Only View
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
            .from('employees')
            .select('employee_id, emp_no, first_name, last_name, middle_name, suffix, faculty, phone_number, email, role, status')
            .order('last_name', { ascending: true });

        if (error) throw error;

        allTeachers = data || [];
        populateRoleFilter();
        populateFacultyFilter();
        updateBadges();
        renderTable(allTeachers);
    } catch (err) {
        console.error('loadTeachers error:', err);
        showTableError('Failed to load teachers: ' + (err.message || err));
    }
}

function populateFacultyFilter() {
    const select = document.getElementById('facultyFilter');
    if (!select) return;
    const current = select.value;
    const faculties = [...new Set(allTeachers.map(t => t.faculty).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Faculties</option>' +
        faculties.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join('');
    select.value = current;
}

function populateRoleFilter() {
    const select = document.getElementById('roleFilter');
    if (!select) return;
    const current = select.value;
    const roles = [...new Set(allTeachers.map(t => t.role).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Roles</option>' +
        roles.map(role => `<option value="${escHtml(role)}">${escHtml(role.replace(/\b\w/g, char => char.toUpperCase()))}</option>`).join('');
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
            <tr><td colspan="10" class="empty-cell">
                <i class="fa-solid fa-chalkboard-user" style="font-size:36px;display:block;margin-bottom:10px;color:#e0f2fe"></i>
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
        <tr data-faculty="${escHtml(t.faculty || '')}" data-role="${escHtml(t.role || '')}" data-status="${status}">
            <td><span class="primary-cell">${escHtml(t.emp_no ?? '—')}</span></td>
            <td>${escHtml(t.last_name || '')}</td>
            <td>${escHtml(t.first_name || '')}</td>
            <td><span class="secondary-cell">${escHtml(t.middle_name || '—')}</span></td>
            <td>${escHtml(t.suffix || '—')}</td>
            <td>${escHtml(t.faculty || '—')}</td>
            <td>${escHtml(t.phone_number || '—')}</td>
            <td>${escHtml(t.email || '—')}</td>
            <td>${escHtml((t.role || 'teacher').replace(/\b\w/g, char => char.toUpperCase()))}</td>
            <td>${statusBadge}</td>
        </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const fac    = document.getElementById('facultyFilter').value;
    const status = document.getElementById('statusFilter').value;
    const role   = document.getElementById('roleFilter').value;

    document.querySelectorAll('#teachersTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const facMatch    = !fac || row.dataset.faculty === fac;
        const roleMatch   = !role || row.dataset.role === role;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && facMatch && roleMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('facultyFilter').addEventListener('change', applyFilters);
    document.getElementById('roleFilter').addEventListener('change', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('facultyFilter').value = '';
        document.getElementById('roleFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
    });
}

function downloadTeacherReport() {
    const columns = [
        ['Employee ID', 'emp_no'],
        ['Last Name', 'last_name'],
        ['First Name', 'first_name'],
        ['Middle Name', 'middle_name'],
        ['Suffix', 'suffix'],
        ['Faculty', 'faculty'],
        ['Phone Number', 'phone_number'],
        ['Email', 'email'],
        ['Role', 'role'],
        ['Status', 'status']
    ];
    const csvEscape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [
        columns.map(([heading]) => csvEscape(heading)).join(','),
        ...allTeachers.map(teacher => columns.map(([, key]) => csvEscape(teacher[key] || '')).join(','))
    ].join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `employees-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function openFaceRegModal() {
    const modal = document.getElementById('faceRegModal');
    const searchInput = document.getElementById('faceEmployeeNumber');
    const result = document.getElementById('faceEmployeeResult');
    const continueButton = document.getElementById('faceEmployeeContinueButton');
    result.hidden = true;
    result.textContent = '';
    continueButton.hidden = true;
    modal.classList.add('active');
    searchInput.focus();
}

function closeFaceRegModal() {
    const modal = document.getElementById('faceRegModal');
    modal.classList.remove('active');
    document.getElementById('faceEmployeeNumber').value = '';
    document.getElementById('faceEmployeeResult').hidden = true;
    document.getElementById('faceEmployeeContinueButton').hidden = true;
}

async function searchEmployeeForFace() {
    const input = document.getElementById('faceEmployeeNumber');
    const searchButton = document.getElementById('faceEmployeeSearchButton');
    const result = document.getElementById('faceEmployeeResult');
    const continueButton = document.getElementById('faceEmployeeContinueButton');
    const employeeNumber = input.value.trim();

    result.hidden = true;
    continueButton.hidden = true;
    if (!employeeNumber) {
        showToast('Enter an employee number to continue.', true);
        input.focus();
        return;
    }

    searchButton.disabled = true;
    searchButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';
    try {
        const { data: employee, error } = await supabaseClient
            .from('employees')
            .select('emp_no, first_name, middle_name, last_name, suffix')
            .eq('emp_no', employeeNumber)
            .maybeSingle();
        if (error) throw error;
        if (!employee) {
            result.textContent = 'No employee was found with that employee number.';
            result.hidden = false;
            return;
        }

        result.innerHTML = `<strong>${escHtml(employee.emp_no)}</strong> — ${escHtml([
            employee.first_name, employee.middle_name, employee.last_name, employee.suffix
        ].filter(Boolean).join(' '))}`;
        result.hidden = false;
        continueButton.dataset.employeeNumber = employee.emp_no;
        continueButton.hidden = false;
    } catch (error) {
        console.error('Employee lookup for face registration failed:', error);
        showToast('Could not search for the employee. Please try again.', true);
    } finally {
        searchButton.disabled = false;
        searchButton.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Find Employee';
    }
}

function continueToFaceRegistration() {
    const employeeNumber = document.getElementById('faceEmployeeContinueButton').dataset.employeeNumber;
    if (!employeeNumber) {
        showToast('Search for an employee before continuing.', true);
        return;
    }
    window.location.href = `../students/accountRegistration.html?role=professor&employee_id=${encodeURIComponent(employeeNumber)}`;
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('teachersTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="10" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading employees…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('teachersTableBody').innerHTML = `
        <tr><td colspan="10" class="empty-cell" style="color:#dc2626">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:36px;display:block;margin-bottom:10px"></i>
            ${escHtml(msg)}
        </td></tr>`;
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