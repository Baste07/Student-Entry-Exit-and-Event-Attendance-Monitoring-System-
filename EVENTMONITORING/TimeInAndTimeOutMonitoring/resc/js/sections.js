/* ═══════════════════════════════════════════════════════════
   sections.js — Sections Management Logic (Supabase)
   TimeInAndTimeOutMonitoring / resc / js / sections.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allSections = [];
let allTeachersForSections = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    loadSections();
    bindEvents();
});

// ══════════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════════

async function loadSections() {
    setTableLoading(true);
    try {
        // Teachers, for the adviser dropdown
        const { data: teachers, error: tErr } = await supabaseClient
            .from('teachers')
            .select('teacher_id, first_name, last_name')
            .order('last_name', { ascending: true });
        if (tErr) throw tErr;
        allTeachersForSections = teachers || [];
        populateAdviserDropdown();

        // Sections, joined with adviser info
        const { data: sections, error: sErr } = await supabaseClient
            .from('sections')
            .select('*, teachers!adviser_id(teacher_id, first_name, last_name)')
            .order('grade_level', { ascending: true });
        if (sErr) throw sErr;

        // Student counts per section
        const { data: students, error: stuErr } = await supabaseClient
            .from('students')
            .select('student_id, section_id');
        if (stuErr) throw stuErr;

        const studentCountBySection = {};
        (students || []).forEach(s => {
            if (!s.section_id) return;
            studentCountBySection[s.section_id] = (studentCountBySection[s.section_id] || 0) + 1;
        });

        allSections = (sections || []).map(sec => ({
            ...sec,
            student_count: studentCountBySection[sec.section_id] || 0,
        }));

        populateGradeLevelFilter();
        updateBadges();
        renderTable(allSections);
    } catch (err) {
        console.error('loadSections error:', err);
        showTableError('Failed to load sections: ' + (err.message || err));
    }
}

function populateAdviserDropdown() {
    const select = document.getElementById('adviserId');
    select.innerHTML = '<option value="">-- No Adviser Assigned --</option>' +
        allTeachersForSections.map(t => `<option value="${t.teacher_id}">${escHtml(t.last_name)}, ${escHtml(t.first_name)}</option>`).join('');
}

function populateGradeLevelFilter() {
    const select = document.getElementById('gradeLevelFilter');
    const current = select.value;
    const grades = [...new Set(allSections.map(s => s.grade_level).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Grade Levels</option>' +
        grades.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join('');
    select.value = current;
}

function updateBadges() {
    setText('badgeTotal', allSections.length);
    setText('badgeStudents', allSections.reduce((sum, s) => sum + s.student_count, 0));
}

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════

function renderTable(rows) {
    const tbody = document.getElementById('sectionsTableBody');
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="7" class="empty-cell">
                <i class="fa-solid fa-school" style="font-size:36px;display:block;margin-bottom:10px;color:#dcfce7"></i>
                No sections found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(s => {
        const adviserName = s.teachers ? `${s.teachers.first_name} ${s.teachers.last_name}` : '<span style="color:#999;font-style:italic">Unassigned</span>';
        return `
        <tr data-grade="${escHtml(s.grade_level || '')}">
            <td><span class="primary-cell">${escHtml(s.section_name || '')}</span></td>
            <td><span class="badge info">${escHtml(s.grade_level || '—')}</span></td>
            <td>${s.teachers ? escHtml(adviserName) : adviserName}</td>
            <td>${escHtml(s.school_year || '—')}</td>
            <td>${escHtml(s.room || '—')}</td>
            <td><span class="badge status-active"><i class="fa-solid fa-users"></i> ${s.student_count}</span></td>
            <td>
                <div style="display:flex;gap:8px">
                    <button class="btn-edit" title="Edit section" onclick="editSection('${s.section_id}')">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                    <button class="btn-delete" title="Delete section" onclick="deleteSection('${s.section_id}', '${escHtml(s.section_name)}')">
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

document.getElementById('sectionForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const sectionId   = document.getElementById('sectionId').value.trim();
    const sectionName = document.getElementById('sectionName').value.trim();
    const gradeLevel  = document.getElementById('gradeLevel').value.trim();
    const adviserId   = document.getElementById('adviserId').value;
    const schoolYear  = document.getElementById('schoolYear').value.trim();
    const room        = document.getElementById('room').value.trim();
    const isEdit      = sectionId !== '';

    if (!sectionName) return showValidationError('Section name is required.');
    if (!gradeLevel) return showValidationError('Grade level is required.');

    const btn  = this.querySelector('.btn-submit');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking duplicates…';

    try {
        let dupQuery = supabaseClient
            .from('sections')
            .select('section_id')
            .eq('section_name', sectionName)
            .eq('grade_level', gradeLevel);

        if (isEdit) dupQuery = dupQuery.neq('section_id', sectionId);

        const { data: dups, error: dupErr } = await dupQuery;
        if (dupErr) throw dupErr;

        if (dups && dups.length > 0) {
            showValidationError(`Section "${gradeLevel} - ${sectionName}" already exists.`);
            btn.disabled = false; btn.innerHTML = orig;
            return;
        }

        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

        const payload = {
            section_name: sectionName,
            grade_level:  gradeLevel,
            adviser_id:   adviserId || null,
            school_year:  schoolYear || null,
            room:         room || null,
        };

        let saveErr;
        if (isEdit) {
            const { error } = await supabaseClient.from('sections').update(payload).eq('section_id', sectionId);
            saveErr = error;
        } else {
            const { error } = await supabaseClient.from('sections').insert(payload);
            saveErr = error;
        }
        if (saveErr) throw saveErr;

        showToast(isEdit ? 'Section updated successfully!' : 'Section added successfully!');
        btn.disabled = false; btn.innerHTML = orig;
        closeModal();
        await loadSections();
    } catch (err) {
        console.error('Save section error:', err);
        showValidationError(err.message || 'An error occurred. Please try again.');
        btn.disabled = false; btn.innerHTML = orig;
    }
});

async function deleteSection(sectionId, sectionName) {
    const confirmed = confirm(`Delete section "${sectionName}"?\n\nThis may affect students currently assigned to this section.`);
    if (!confirmed) return;

    try {
        const { data: linked, error: chkErr } = await supabaseClient
            .from('students')
            .select('student_id')
            .eq('section_id', sectionId)
            .limit(1);
        if (chkErr) throw chkErr;

        if (linked && linked.length > 0) {
            alert(`Cannot delete "${sectionName}" — students are still assigned to this section. Reassign them first.`);
            return;
        }

        const { error } = await supabaseClient.from('sections').delete().eq('section_id', sectionId);
        if (error) throw error;

        showToast(`"${sectionName}" deleted successfully.`);
        await loadSections();
    } catch (err) {
        console.error('Delete section error:', err);
        alert('Error deleting section: ' + (err.message || err));
    }
}

// ══════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════

function openAddModal() {
    document.getElementById('sectionForm').reset();
    document.getElementById('sectionId').value = '';
    document.getElementById('adviserId').value = '';
    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-plus"></i> Add Section';
    document.getElementById('submitBtnText').textContent = 'Add Section';
    clearAllValidation();
    openModal();
}

function editSection(id) {
    const s = allSections.find(x => x.section_id === id);
    if (!s) return;

    document.getElementById('sectionId').value   = s.section_id;
    document.getElementById('sectionName').value = s.section_name || '';
    document.getElementById('gradeLevel').value  = s.grade_level || '';
    document.getElementById('adviserId').value   = s.adviser_id || '';
    document.getElementById('schoolYear').value  = s.school_year || '';
    document.getElementById('room').value        = s.room || '';

    document.getElementById('modalTitle').innerHTML = '<i class="fa-solid fa-edit"></i> Edit Section';
    document.getElementById('submitBtnText').textContent = 'Update Section';
    clearAllValidation();
    openModal();
}

function openModal() {
    document.getElementById('sectionModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('sectionModal').classList.remove('active');
    document.body.style.overflow = '';
    setTimeout(clearAllValidation, 300);
}

// ══════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════

function applyFilters() {
    const q     = document.getElementById('searchInput').value.toLowerCase();
    const grade = document.getElementById('gradeLevelFilter').value;

    document.querySelectorAll('#sectionsTableBody tr').forEach(row => {
        if (row.id === 'loadingRow') return;
        const textMatch  = row.textContent.toLowerCase().includes(q);
        const gradeMatch = !grade || row.dataset.grade === grade;
        row.style.display = (textMatch && gradeMatch) ? '' : 'none';
    });
}

function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('gradeLevelFilter').addEventListener('change', applyFilters);

    document.getElementById('clearFilters').addEventListener('click', function () {
        document.getElementById('searchInput').value = '';
        document.getElementById('gradeLevelFilter').value = '';
        applyFilters();
    });

    document.getElementById('sectionModal').addEventListener('click', function (e) {
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
    const tbody = document.getElementById('sectionsTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading sections…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('sectionsTableBody').innerHTML = `
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
    const form = document.getElementById('sectionForm');
    form.parentElement.insertBefore(div, form);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => div.remove(), 6000);
}

function clearValidationError() {
    document.querySelectorAll('.validation-error').forEach(el => el.remove());
}

function clearAllValidation() {
    clearValidationError();
    document.querySelectorAll('#sectionModal input, #sectionModal select').forEach(el => { el.style.borderColor = ''; });
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