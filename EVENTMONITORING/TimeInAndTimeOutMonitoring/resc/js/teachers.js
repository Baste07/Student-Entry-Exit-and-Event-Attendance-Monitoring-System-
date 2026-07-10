/* ═══════════════════════════════════════════════════════════
   teachers.js — Teachers Management Logic (Supabase)
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
            .from('teachers')
            .select('*')
            .order('last_name', { ascending: true });

        if (error) throw error;

        allTeachers = data || [];
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
        <tr data-faculty="${escHtml(t.faculty || '')}" data-status="${status}">
            <td><span class="primary-cell">${escHtml(t.employee_id || '')}</span></td>
            <td>${escHtml(t.last_name || '')}</td>
            <td>${escHtml(t.first_name || '')}</td>
            <td><span class="secondary-cell">${escHtml(t.middle_name || '—')}</span></td>
            <td>${escHtml(t.suffix || '—')}</td>
            <td>${escHtml(t.faculty || '—')}</td>
            <td>${escHtml(t.phone_number || '—')}</td>
            <td>${escHtml(t.email || '—')}</td>
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

    document.querySelectorAll('#teachersTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch   = row.textContent.toLowerCase().includes(q);
        const facMatch    = !fac || row.dataset.faculty === fac;
        const statusMatch = !status || row.dataset.status === status;
        row.style.display = (textMatch && facMatch && statusMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('facultyFilter').addEventListener('change', applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('facultyFilter').value = '';
        document.getElementById('statusFilter').value = '';
        applyFilters();
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