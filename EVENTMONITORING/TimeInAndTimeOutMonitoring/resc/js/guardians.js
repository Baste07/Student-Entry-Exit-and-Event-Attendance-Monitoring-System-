/* ═══════════════════════════════════════════════════════════
   guardians.js — Guardians Management Logic (Supabase)
   K-10 Attendance System — Read-Only View
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allGuardians = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadGuardians();
    bindEvents();
});

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadGuardians() {
    setTableLoading(true);
    try {
        const { data: guardians, error: gErr } = await supabaseClient
            .from('guardians')
            .select('*, student_guardians(student_id, is_primary_contact, students(student_id, first_name, last_name, stud_id))')
            .order('last_name', { ascending: true });
        if (gErr) throw gErr;

        allGuardians = (guardians || []).map(g => ({
            ...g,
            linked_students: (g.student_guardians || []).map(link => link.students).filter(Boolean),
        }));

        populateRelationshipFilter();
        updateBadges();
        renderTable(allGuardians);
    } catch (err) {
        console.error('loadGuardians error:', err);
        showTableError('Failed to load guardians: ' + (err.message || err));
    }
}

function populateRelationshipFilter() {
    const select = document.getElementById('relationshipFilter');
    if (!select) return;
    const current = select.value;
    const relationships = [...new Set(allGuardians.map(g => g.relationship).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Relationships</option>' +
        relationships.map(r => `<option value="${escHtml(r)}">${escHtml(capitalizeRelationship(r))}</option>`).join('');
    select.value = current;
}

function capitalizeRelationship(rel) {
    if (!rel) return '';
    return rel.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function updateBadges() {
    setText('badgeTotal', allGuardians.length);
    setText('badgeLinked', allGuardians.reduce((sum, g) => sum + g.linked_students.length, 0));
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

function renderTable(rows) {
    const tbody = document.getElementById('guardiansTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="9" class="empty-cell">
                <i class="fa-solid fa-user-shield" style="font-size:36px;display:block;margin-bottom:10px;color:#e0f2fe"></i>
                No guardians found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(g => {
        const count = g.linked_students.length;
        const linkedCell = count === 0
            ? '<span style="color:#999;font-style:italic">None</span>'
            : `<button type="button" class="badge status-active" style="border:none;cursor:pointer;" onclick='openViewModal(${JSON.stringify(g.linked_students).replace(/'/g, "&#39;")})'>
                    <i class="fa-solid fa-users"></i> ${count} Student${count > 1 ? 's' : ''}
               </button>`;

        return `
        <tr data-relationship="${escHtml(g.relationship || '')}">
            <td><span class="primary-cell">${escHtml(g.last_name || '')}</span></td>
            <td>${escHtml(g.first_name || '')}</td>
            <td><span class="secondary-cell">${escHtml(g.middle_name || '—')}</span></td>
            <td><span class="badge info">${escHtml(capitalizeRelationship(g.relationship))}</span></td>
            <td>${escHtml(g.phone_number || '—')}</td>
            <td>${escHtml(g.alternate_phone_number || '—')}</td>
            <td>${escHtml(g.email || '—')}</td>
            <td><span class="secondary-cell">${escHtml(truncate(g.address, 40))}</span></td>
            <td>${linkedCell}</td>
        </tr>`;
    }).join('');
}

function truncate(str, len) {
    if (!str) return '—';
    return str.length > len ? str.substring(0, len) + '…' : str;
}

// ══════════════════════════════════════════════════════════
// LINKED STUDENTS MODAL
// ══════════════════════════════════════════════════════════

function openViewModal(students) {
    const list = document.getElementById('linkedStudentsList');
    if (!students || students.length === 0) {
        list.innerHTML = '<li>No linked students.</li>';
    } else {
        list.innerHTML = students.map(s => `
            <li>
                <span>${escHtml((s.first_name || '') + ' ' + (s.last_name || ''))}</span>
                <span class="tag">${escHtml(s.stud_id || '')}</span>
            </li>`).join('');
    }
    document.getElementById('viewStudentsModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeViewModal() {
    document.getElementById('viewStudentsModal').classList.remove('active');
    document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q   = document.getElementById('searchInput').value.toLowerCase();
    const rel = document.getElementById('relationshipFilter').value;

    document.querySelectorAll('#guardiansTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch = row.textContent.toLowerCase().includes(q);
        const relMatch  = !rel || row.dataset.relationship === rel;
        row.style.display = (textMatch && relMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('relationshipFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('relationshipFilter').value = '';
        applyFilters();
    });

    document.getElementById('viewStudentsModal').addEventListener('click', function (e) {
        if (e.target === this) closeViewModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeViewModal();
    });
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('guardiansTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="9" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading guardians…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('guardiansTableBody').innerHTML = `
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