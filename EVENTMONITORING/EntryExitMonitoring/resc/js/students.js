/* ============================================================
   StudentEntryExit/resc/js/students.js
============================================================ */
'use strict';

const PAGE_SIZE = 20;
let allStudents  = [];
let filteredStudents = [];
let currentPage  = 1;

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    loadStudents();
    bindFilters();
});

async function loadStudents() {
    const tbody = document.getElementById('studentsTableBody');
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('id, stud_id, first_name, last_name, grade_level, section_name, face_enrolled')
            .order('last_name', { ascending: true });

        if (error) throw error;
        allStudents = data || [];
        populateGradeFilter();
        applyFilters();
        updateBadges();
    } catch (e) {
        console.error('[students] load error:', e);
        tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">Failed to load students.</td></tr>`;
    }
}

function populateGradeFilter() {
    const grades = [...new Set(allStudents.map(s => s.grade_level).filter(Boolean))].sort();
    const sel = document.getElementById('gradeFilter');
    grades.forEach(g => {
        const o = document.createElement('option');
        o.value = g; o.textContent = `Grade ${g}`;
        sel.appendChild(o);
    });
}

function bindFilters() {
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('gradeFilter').addEventListener('change', applyFilters);
    document.getElementById('faceFilter').addEventListener('change', applyFilters);
    document.getElementById('clearFilters').addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        document.getElementById('gradeFilter').value = '';
        document.getElementById('faceFilter').value = '';
        applyFilters();
    });
}

function applyFilters() {
    const q     = document.getElementById('searchInput').value.toLowerCase();
    const grade = document.getElementById('gradeFilter').value;
    const face  = document.getElementById('faceFilter').value;

    filteredStudents = allStudents.filter(s => {
        const fullName = `${s.first_name} ${s.last_name}`.toLowerCase();
        const matchQ   = !q || fullName.includes(q) || (s.stud_id || '').toLowerCase().includes(q);
        const matchG   = !grade || String(s.grade_level) === grade;
        const matchF   = !face
            || (face === 'enrolled' && s.face_enrolled)
            || (face === 'pending'  && !s.face_enrolled);
        return matchQ && matchG && matchF;
    });

    currentPage = 1;
    renderTable();
    renderPagination();
}

function renderTable() {
    const tbody = document.getElementById('studentsTableBody');
    const start = (currentPage - 1) * PAGE_SIZE;
    const page  = filteredStudents.slice(start, start + PAGE_SIZE);

    if (page.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">No students found.</td></tr>`;
        return;
    }

    tbody.innerHTML = page.map(s => {
        const enrolled = s.face_enrolled
            ? '<span class="badge badge-enrolled"><i class="fa-solid fa-face-smile"></i> Enrolled</span>'
            : '<span class="badge badge-pending"><i class="fa-solid fa-circle-exclamation"></i> Pending</span>';
        return `<tr>
            <td>${s.stud_id || '—'}</td>
            <td>${s.last_name}, ${s.first_name}</td>
            <td>${s.grade_level || '—'}</td>
            <td>${s.section_name || '—'}</td>
            <td>${enrolled}</td>
            <td id="lastEntry-${s.id}">—</td>
            <td>
                <button class="btn-icon" onclick="viewLogs('${s.id}','${s.last_name}, ${s.first_name}')">
                    <i class="fa-solid fa-clock-rotate-left"></i> Logs
                </button>
            </td>
        </tr>`;
    }).join('');

    // Load last entry for each visible student
    page.forEach(s => loadLastEntry(s.id));
}

async function loadLastEntry(studentId) {
    try {
        const { data } = await supabaseClient
            .from('entry_exit_logs')
            .select('log_timestamp, log_type')
            .eq('student_id', studentId)
            .eq('log_type', 'entry')
            .order('log_timestamp', { ascending: false })
            .limit(1)
            .single();

        const el = document.getElementById(`lastEntry-${studentId}`);
        if (el && data) {
            el.textContent = new Date(data.log_timestamp).toLocaleDateString('en-US', {
                timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric'
            });
        }
    } catch (_) {}
}

function renderPagination() {
    const total = Math.ceil(filteredStudents.length / PAGE_SIZE);
    const pg    = document.getElementById('pagination');
    if (total <= 1) { pg.innerHTML = ''; return; }

    let html = '';
    for (let i = 1; i <= total; i++) {
        html += `<button class="page-btn${i === currentPage ? ' active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }
    pg.innerHTML = html;
}

function goToPage(page) {
    currentPage = page;
    renderTable();
    renderPagination();
}

function updateBadges() {
    const enrolled = allStudents.filter(s => s.face_enrolled).length;
    setEl('badgeTotal',   allStudents.length);
    setEl('badgeFaceReg', enrolled);
    setEl('badgePending', allStudents.length - enrolled);
}

async function viewLogs(studentId, studentName) {
    document.getElementById('logsModalTitle').innerHTML =
        `<i class="fa-solid fa-clock-rotate-left"></i> ${studentName} — Logs`;
    openModal('logsModal');

    const tbody = document.getElementById('studentLogsBody');
    tbody.innerHTML = `<tr><td colspan="4" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        const { data, error } = await supabaseClient
            .from('entry_exit_logs')
            .select('log_type, scan_method, log_date, log_timestamp')
            .eq('student_id', studentId)
            .order('log_timestamp', { ascending: false })
            .limit(50);

        if (error) throw error;
        if (!data || data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">No logs found.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(l => {
            const time = l.log_timestamp
                ? new Date(l.log_timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—';
            const typeBadge = l.log_type === 'entry'
                ? '<span class="badge badge-enrolled"><i class="fa-solid fa-door-open"></i> Entry</span>'
                : '<span class="badge badge-pending"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
            return `<tr>
                <td>${typeBadge}</td>
                <td>${l.scan_method || '—'}</td>
                <td>${l.log_date || '—'}</td>
                <td>${time}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">Error loading logs.</td></tr>`;
    }
}

function openModal(id)    { document.getElementById(id).classList.add('open'); }
function closeModal(id)   { document.getElementById(id).classList.remove('open'); }
function openFaceRegModal()  { openModal('faceRegModal'); }
function closeFaceRegModal() { closeModal('faceRegModal'); }
function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

function showToast(msg) {
    const t = document.getElementById('toast');
    const m = document.getElementById('toastMsg');
    if (!t || !m) return;
    m.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}