/* ═══════════════════════════════════════════════════════════
   guardians.js — Guardians Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / guardians.js
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
            .select('*, student_guardians(student_id, is_primary_contact, students(student_id, first_name, last_name, lrn))')
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
    const current = select.value;
    const relationships = [...new Set(allGuardians.map(g => g.relationship).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Relationships</option>' +
        relationships.map(r => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join('');
    select.value = current;
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
            <tr><td colspan="8" class="empty-cell">
                <i class="fa-solid fa-user-shield" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
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
            <td><span class="badge info">${escHtml(g.relationship || '—')}</span></td>
            <td>${escHtml(g.phone_number || '—')}</td>
            <td>${escHtml(g.email || '—')}</td>
            <td><span class="secondary-cell">${escHtml(truncate(g.address, 40))}</span></td>
            <td>${linkedCell}</td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit guardian" onclick="editGuardian('${g.guardian_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete guardian" onclick="deleteGuardian('${g.guardian_id}', '${escHtml((g.first_name || '') + ' ' + (g.last_name || ''))}')">
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
                <span class="tag">${escHtml(s.lrn || '')}</span>
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
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════

document.getElementById('guardianForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const guardianId            = document.getElementById('guardianId').value.trim();
    const firstName              = document.getElementById('firstName').value.trim();
    const middleName             = document.getElementById('middleName').value.trim();
    const lastName               = document.getElementById('lastName').value.trim();
    const relationship           = document.getElementById('relationship').value;
    const phoneNumber            = document.getElementById('phoneNumber').value.trim();
    const alternatePhoneNumber   = document.getElementById('alternatePhoneNumber').value.trim();
    const email                  = document.getElementById('email').value.trim();
    const address                = document.getElementById('address').value.trim();
    const isEdit                 = guardianId !== '';

    if (!firstName || !lastName) return showValidationError('First and last name are required.');
    if (!relationship) return showValidationError('Please select a relationship.');
    if (!phoneNumber) return showValidationError('Phone number is required.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showValidationError('Please enter a valid email address.');

    const btn  = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const payload = {
            first_name:              firstName,
            middle_name:             middleName || null,
            last_name:               lastName,
            relationship:            relationship,
            phone_number:            phoneNumber,
            alternate_phone_number:  alternatePhoneNumber || null,
            email:                   email || null,
            address:                 address || null,
        };

        let saveErr;
        if (isEdit) {
            const { error } = await supabaseClient.from('guardians').update(payload).eq('guardian_id', guardianId);
            saveErr = error;
        } else {
            const { error } = await supabaseClient.from('guardians').insert(payload);
            saveErr = error;
        }
        if (saveErr) throw saveErr;

        showToast(isEdit ? 'Guardian updated successfully!' : 'Guardian added successfully!');
        btn.disabled = false; btn.innerHTML = orig;
        closeModal();
        await loadGuardians();
    } catch (err) {
        console.error('Save guardian error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false; btn.innerHTML = orig;
    }
});

async function deleteGuardian(guardianId, guardianName) {
    const confirmed = confirm(`Delete guardian "${guardianName}"?\n\nThis will remove the guardian's links to any students.`);
    if (!confirmed) return;

    try {
        await supabaseClient.from('student_guardians').delete().eq('guardian_id', guardianId);

        const { error } = await supabaseClient.from('guardians').delete().eq('guardian_id', guardianId);
        if (error) throw error;

        showToast(`"${guardianName}" deleted successfully.`);
        await loadGuardians();
    } catch (err) {
        console.error('Delete guardian error:', err);
        alert('Error deleting guardian: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('guardianForm').reset();
    document.getElementById('guardianId').value = '';
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add Guardian';
    document.getElementById('submitBtnText').textContent = 'Add Guardian';
    clearAllValidation();
    openModal();
}

function editGuardian(id) {
    const g = allGuardians.find(x => x.guardian_id === id);
    if (!g) return;

    document.getElementById('guardianId').value             = g.guardian_id;
    document.getElementById('firstName').value               = g.first_name || '';
    document.getElementById('middleName').value              = g.middle_name || '';
    document.getElementById('lastName').value                = g.last_name || '';
    document.getElementById('relationship').value            = g.relationship || '';
    document.getElementById('phoneNumber').value              = g.phone_number || '';
    document.getElementById('alternatePhoneNumber').value     = g.alternate_phone_number || '';
    document.getElementById('email').value                    = g.email || '';
    document.getElementById('address').value                  = g.address || '';

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Guardian';
    document.getElementById('submitBtnText').textContent = 'Update Guardian';
    clearAllValidation();
    openModal();
}

function openModal() {
    document.getElementById('guardianModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('guardianModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
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

    document.getElementById('guardianModal').addEventListener('click', function (e) {
        if (e.target === this) closeModal();
    });
    document.getElementById('viewStudentsModal').addEventListener('click', function (e) {
        if (e.target === this) closeViewModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeModal(); closeViewModal(); }
    });
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('guardiansTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading guardians…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('guardiansTableBody').innerHTML = `
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
    const form = document.getElementById('guardianForm');
    form.parentElement.insertBefore(div, form);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => div.remove(), 6000);
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#guardianModal input, #guardianModal select, #guardianModal textarea').forEach(el => { el.style.borderColor = ''; });
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