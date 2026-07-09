/* ============================================================
   resc/js/reports.js
   Export Audit Log Manager
============================================================ */

let allReports = [];
let filteredReports = [];

const typeConfig = {
    'sessions':     { label: 'Session Report',     icon: 'fa-desktop',            col: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
    'attendance':   { label: 'Attendance Report',  icon: 'fa-clipboard-user',     col: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
    'professor':    { label: 'Professor Report',   icon: 'fa-chalkboard-teacher', col: '#92400e', bg: '#fffbeb', border: '#fde68a' },
    'professors':   { label: 'Professors Report',  icon: 'fa-chalkboard-teacher', col: '#92400e', bg: '#fffbeb', border: '#fde68a' },
    'student':      { label: 'Student Report',     icon: 'fa-user-graduate',      col: '#6b21a8', bg: '#faf5ff', border: '#e9d5ff' },
    'students':     { label: 'Students List',      icon: 'fa-users',              col: '#6b21a8', bg: '#faf5ff', border: '#e9d5ff' },
    'schedules':    { label: 'Schedules Report',   icon: 'fa-calendar-days',      col: '#0f766e', bg: '#f0fdfa', border: '#99f6e4' },
    'enrollment':   { label: 'Enrollment Report',  icon: 'fa-user-plus',          col: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
    'laboratories': { label: 'Laboratories Report',icon: 'fa-flask',              col: '#0369a1', bg: '#f0f9ff', border: '#bae6fd' },
    'subjects':     { label: 'Subjects Report',    icon: 'fa-book',               col: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' }
};

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) return;
    initAutoFilters();
    await loadReportsData();
});

function initAutoFilters() {
    const search = document.getElementById('filterSearch');
    const type = document.getElementById('filterType');
    const from = document.getElementById('filterFrom');
    const to = document.getElementById('filterTo');

    if (search) {
        search.addEventListener('input', executeClientFilter);
        search.addEventListener('keyup', executeClientFilter);
    }

    [type, from, to].forEach((el) => {
        if (el) el.addEventListener('change', executeClientFilter);
    });
}

// ────────────────────────────────────────────
// 1. LOAD & RENDER TABLE (Audit History)
// ────────────────────────────────────────────
async function loadReportsData() {
    const tbody = document.getElementById('reportsBody');
    try {
        const { data, error } = await supabaseClient
            .from('las_reports')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        allReports = data;
        executeClientFilter();
        document.querySelectorAll('.stats-row .skeleton, #reportsBody .skeleton').forEach(el => el.classList.remove('skeleton'));
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state" style="color:var(--red)"><i class="fa-solid fa-triangle-exclamation"></i><p>Error loading export logs.</p></td></tr>`;
    }
}

window.applyFilters = function() { executeClientFilter(); }
window.resetFilters = function() {
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterType').value = '';
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    executeClientFilter();
}

function executeClientFilter() {
    const q = document.getElementById('filterSearch').value.toLowerCase().trim();
    const type = document.getElementById('filterType').value;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;

    filteredReports = allReports.filter(r => {
        if (type && r.report_type !== type) return false;
        const rDate = r.created_at.split('T')[0];
        if (from && rDate < from) return false;
        if (to && rDate > to) return false;
        if (q && !`${r.report_name} ${r.report_id}`.toLowerCase().includes(q)) return false;
        return true;
    });

    updateStats();
    renderTable();
}

function updateStats() {
    let s_sess = 0, s_att = 0, s_prof = 0, s_stu = 0;
    allReports.forEach(r => {
        if (r.report_type === 'sessions') s_sess++;
        else if (r.report_type === 'attendance') s_att++;
        else if (r.report_type === 'professor' || r.report_type === 'professors') s_prof++;
        else if (r.report_type === 'student' || r.report_type === 'students' || r.report_type === 'enrollment') s_stu++;
    });

    document.getElementById('statTotalAll').textContent = allReports.length;
    document.getElementById('statSessions').textContent = s_sess;
    document.getElementById('statAttendance').textContent = s_att;
    document.getElementById('statProfessor').textContent = s_prof;
    document.getElementById('statStudent').textContent = s_stu;

    document.getElementById('recordCountDisplay').textContent = filteredReports.length;
    document.getElementById('btnDeleteAll').style.display = allReports.length > 0 ? 'inline-flex' : 'none';
}

function renderTable() {
    const tbody = document.getElementById('reportsBody');
    if (filteredReports.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><h3>No logs found</h3><p>Generated reports will appear here automatically.</p></td></tr>`;
        return;
    }

    tbody.innerHTML = filteredReports.map((r) => {
        const tc = typeConfig[r.report_type] || { label: r.report_type, icon: 'fa-file', col: '#555', bg: '#f5f5f5', border: '#ddd' };
        let filtersObj = {}; try { filtersObj = JSON.parse(r.filters || '{}'); } catch(e){}
        let chips = [];
        
        // Parse filter data nicely
        if (filtersObj.date_from || filtersObj.date_to) chips.push(`${filtersObj.date_from || '...'} → ${filtersObj.date_to || '...'}`);
        if (filtersObj.professor_name) chips.push(filtersObj.professor_name);
        if (filtersObj.subject_code) chips.push(filtersObj.subject_code);
        if (filtersObj.status) chips.push(filtersObj.status.charAt(0).toUpperCase() + filtersObj.status.slice(1));
        
        const filterDisplay = chips.length > 0 ? chips.join(' &middot; ') : '<span style="color:var(--s300);font-style:italic">All Data / Default Filters</span>';
        const d = new Date(r.created_at);

        return `
            <tr>
                <td class="mono" style="color:var(--s500)">${r.report_id}</td>
                <td>
                    <div style="font-weight:700;color:var(--green-dark)">${escapeHtml(r.report_name)}</div>
                    <div class="mono" style="font-size:10px;color:var(--text-muted);margin-top:2px">ID #${r.report_id}</div>
                </td>
                <td>
                    <span class="type-badge" style="background:${tc.bg}; color:${tc.col}; border:1px solid ${tc.border}">
                        <i class="fa-solid ${tc.icon}"></i> ${tc.label}
                    </span>
                </td>
                <td style="font-size:11.5px;color:var(--s500);max-width:240px">${filterDisplay}</td>
                <td>
                    <div style="font-size:12.5px;font-weight:600">${d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}</div>
                    <div class="mono" style="font-size:10.5px;color:var(--text-muted)">${d.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'})}</div>
                </td>
                <td style="text-align:center;">
                    <button class="act-btn act-del" style="margin:0 auto;" onclick="deleteReport('${r.report_id}')"><i class="fa-solid fa-trash"></i> Delete</button>
                </td>
            </tr>`;
    }).join('');
}

// ────────────────────────────────────────────
// 2. LOG DELETIONS
// ────────────────────────────────────────────
window.deleteReport = async function(id) {
    if (!confirm("Are you sure you want to delete this log entry?")) return;
    try {
        await supabaseClient.from('las_reports').delete().eq('report_id', id);
        showToast('Log deleted.');
        await loadReportsData();
    } catch (err) { showToast('Error deleting log.', 'error'); }
}

window.openDelAllModal = function() { document.getElementById('delAllModal').classList.add('on'); }
window.closeDelAllModal = function() { document.getElementById('delAllModal').classList.remove('on'); }

window.executeDeleteAll = async function() {
    try {
        await supabaseClient.from('las_reports').delete().neq('report_id', 0);
        document.getElementById('delAllModal').classList.remove('on');
        showToast('All export logs cleared.');
        await loadReportsData();
    } catch (err) { showToast('Error clearing logs.', 'error'); }
}

// ────────────────────────────────────────────
// 3. UTILITIES
// ────────────────────────────────────────────
function escapeHtml(str) { return String(str||'').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> <span>${msg}</span>`;
    t.className = `toast on ${type}`;
    t.style.background = type === 'success' ? 'var(--green-dark)' : 'var(--red)';
    setTimeout(() => t.classList.remove('on'), 3500);
}