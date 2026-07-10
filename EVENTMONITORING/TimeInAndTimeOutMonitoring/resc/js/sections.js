/* ═══════════════════════════════════════════════════════════
   sections.js — Sections Management Logic (Supabase)
   K-10 Attendance System — Read-Only View
   ═══════════════════════════════════════════════════════════ */

'use strict';

let allSections = [];
let allTeachersForSections = [];
let allSchoolYears = [];

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
        // Load teachers for adviser names
        const { data: teachers, error: tErr } = await supabaseClient
            .from('teachers')
            .select('teacher_id, first_name, last_name')
            .order('last_name', { ascending: true });
        if (tErr) throw tErr;
        allTeachersForSections = teachers || [];

        // Load school years for names
        const { data: schoolYears, error: syErr } = await supabaseClient
            .from('school_years')
            .select('id, name');
        if (syErr) throw syErr;
        allSchoolYears = schoolYears || [];

        // Load sections with adviser info
        const { data: sections, error: sErr } = await supabaseClient
            .from('sections')
            .select('*, teachers!adviser_id(teacher_id, first_name, last_name)')
            .order('grade_level', { ascending: true })
            .order('section_name', { ascending: true });
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

        updateBadges();
        renderTable(allSections);
    } catch (err) {
        console.error('loadSections error:', err);
        showTableError('Failed to load sections: ' + (err.message || err));
    }
}

function getSchoolYearName(schoolYearId) {
    const sy = allSchoolYears.find(s => s.id === schoolYearId);
    return sy ? sy.name : '—';
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
            <tr><td colspan="5" class="empty-cell">
                <i class="fa-solid fa-school" style="font-size:36px;display:block;margin-bottom:10px;color:#e0f2fe"></i>
                No sections found.
            </td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(s => {
        const adviserName = s.teachers
            ? `${s.teachers.first_name} ${s.teachers.last_name}`
            : '<span style="color:#999;font-style:italic">Unassigned</span>';
        const schoolYearName = getSchoolYearName(s.school_year_id);

        return `
        <tr data-grade="${escHtml(s.grade_level || '')}">
            <td><span class="primary-cell">${escHtml(s.section_name || '')}</span></td>
            <td><span class="badge info">${escHtml(s.grade_level || '—')}</span></td>
            <td>${s.teachers ? escHtml(adviserName) : adviserName}</td>
            <td>${escHtml(schoolYearName)}</td>
            <td><span class="badge status-active"><i class="fa-solid fa-users"></i> ${s.student_count}</span></td>
        </tr>`;
    }).join('');
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
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════

function setTableLoading(on) {
    const tbody = document.getElementById('sectionsTableBody');
    if (on) tbody.innerHTML = `<tr id="loadingRow"><td colspan="5" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading sections…</td></tr>`;
}

function showTableError(msg) {
    document.getElementById('sectionsTableBody').innerHTML = `
        <tr><td colspan="5" class="empty-cell" style="color:#dc2626">
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