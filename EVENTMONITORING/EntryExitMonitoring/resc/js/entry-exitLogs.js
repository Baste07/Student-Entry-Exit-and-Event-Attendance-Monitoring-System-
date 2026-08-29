/* ============================================================
   EntryExitMonitoring/resc/js/entry-exitLogs.js
   Updated: supports both student and employee log rows
============================================================ */
'use strict';

const PAGE_SIZE = 25;
let allLogs      = [];
let filteredLogs = [];
let currentPage  = 1;

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    const today = new Date().toLocaleDateString('en-CA');
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value   = today;
    loadLogs();
    bindFilters();
});

async function loadLogs() {
    const tbody = document.getElementById('logsTableBody');
    tbody.innerHTML = `<tr><td colspan="9" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        const { data, error } = await supabaseClient
            .from('entry_exit_logs')
            .select(`
                id, log_type, scan_method, log_date, log_timestamp, is_late,
                student_id,
                employee_id,
                students ( stud_id, first_name, last_name, section_id ),
                employees ( emp_no, first_name, last_name )
            `)
            .order('log_timestamp', { ascending: false })
            .limit(1000);

        if (error) throw error;
        allLogs = data || [];
        applyFilters();
    } catch (e) {
        console.error('[entryExitLogs] load error:', e);
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Failed to load logs. Check console.</td></tr>`;
    }
}

function bindFilters() {
    ['searchInput','typeFilter','methodFilter','userTypeFilter','dateFrom','dateTo'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input',  applyFilters);
        el.addEventListener('change', applyFilters);
    });
    document.getElementById('clearFilters').addEventListener('click', () => {
        document.getElementById('searchInput').value   = '';
        document.getElementById('typeFilter').value    = '';
        document.getElementById('methodFilter').value  = '';
        const utf = document.getElementById('userTypeFilter');
        if (utf) utf.value = '';
        document.getElementById('dateFrom').value = '';
        document.getElementById('dateTo').value   = '';
        applyFilters();
    });
}

function applyFilters() {
    const q        = (document.getElementById('searchInput')?.value  || '').toLowerCase();
    const type     = (document.getElementById('typeFilter')?.value   || '');
    const method   = (document.getElementById('methodFilter')?.value || '');
    const userType = (document.getElementById('userTypeFilter')?.value || ''); // 'student'|'employee'|''
    const from     = (document.getElementById('dateFrom')?.value     || '');
    const to       = (document.getElementById('dateTo')?.value       || '');

    filteredLogs = allLogs.filter(l => {
        const isEmployee  = !!l.employee_id && !l.student_id;
        const s           = l.students   || {};
        const e           = l.employees  || {};

        const displayId   = isEmployee ? (e.emp_no   || '—') : (s.stud_id  || '—');
        const displayName = isEmployee
            ? `${e.first_name || ''} ${e.last_name || ''}`.trim().toLowerCase()
            : `${s.first_name || ''} ${s.last_name || ''}`.trim().toLowerCase();

        const searchable  = `${displayId} ${displayName}`.toLowerCase();
        const matchQ      = !q        || searchable.includes(q);
        const matchT      = !type     || l.log_type === type;
        const matchM      = !method   || (l.scan_method || '').toLowerCase() === method;
        const matchUT     = !userType || (userType === 'employee' ? isEmployee : !isEmployee);
        const matchF      = !from     || l.log_date >= from;
        const matchTo     = !to       || l.log_date <= to;

        return matchQ && matchT && matchM && matchUT && matchF && matchTo;
    });

    currentPage = 1;
    updateBadges();
    renderPage();
}

function updateBadges() {
    const totalEl = document.getElementById('badgeTotal');
    const entryEl = document.getElementById('badgeEntry');
    const exitEl  = document.getElementById('badgeExit');
    if (totalEl) totalEl.textContent = filteredLogs.length;
    if (entryEl) entryEl.textContent = filteredLogs.filter(l => l.log_type === 'entry').length;
    if (exitEl)  exitEl.textContent  = filteredLogs.filter(l => l.log_type === 'exit').length;
}

function renderPage() {
    const tbody  = document.getElementById('logsTableBody');
    const start  = (currentPage - 1) * PAGE_SIZE;
    const slice  = filteredLogs.slice(start, start + PAGE_SIZE);

    if (!slice.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">No logs found.</td></tr>`;
        renderPagination();
        return;
    }

    tbody.innerHTML = slice.map(l => {
        const isEmployee  = !!l.employee_id && !l.student_id;
        const s           = l.students  || {};
        const e           = l.employees || {};

        const displayId   = isEmployee ? escHtml(e.emp_no   || '—') : escHtml(s.stud_id  || '—');
        const displayName = isEmployee
            ? escHtml(`${e.last_name || '—'}, ${e.first_name || ''}`)
            : escHtml(`${s.last_name || '—'}, ${s.first_name || ''}`);

        // For students show grade/section; for employees show "Employee"
        const roleCellHtml = isEmployee
            ? `<td colspan="2"><span class="log-role-badge emp"><i class="fa-solid fa-user-tie"></i> Employee</span></td>`
            : `<td>${escHtml(s.grade_level || '—')}</td><td>${escHtml(s.section_name || '—')}</td>`;

        const typeBadge = l.log_type === 'entry'
            ? `<span class="log-badge entry"><i class="fa-solid fa-door-open"></i> Entry</span>`
            : `<span class="log-badge exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>`;

        const lateBadge = (l.is_late && l.log_type === 'entry')
            ? `<span class="log-badge late"><i class="fa-solid fa-clock"></i> Late</span>` : '';

        const methodLabel = {
            face: '<i class="fa-solid fa-face-smile"></i> Face',
            qr:   '<i class="fa-solid fa-qrcode"></i> QR',
            manual: '<i class="fa-solid fa-keyboard"></i> Manual'
        }[l.scan_method] || l.scan_method || '—';

        const ts   = l.log_timestamp ? new Date(l.log_timestamp) : null;
        const date = ts ? ts.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—';
        const time = ts ? ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

        return `<tr>
            <td style="font-weight:700;color:${isEmployee?'#5b21b6':'#166534'}">${displayId}</td>
            <td style="font-weight:600">${displayName}</td>
            ${roleCellHtml}
            <td>${typeBadge}${lateBadge}</td>
            <td>${methodLabel}</td>
            <td style="font-size:12.5px">${date}</td>
            <td style="font-size:12.5px">${time}</td>
        </tr>`;
    }).join('');

    renderPagination();
}

function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
    const el = document.getElementById('pagination');
    if (!el) return;
    el.innerHTML = '';

    if (totalPages <= 1) return;

    const prev = document.createElement('button');
    prev.textContent = '← Prev';
    prev.disabled = currentPage === 1;
    prev.onclick  = () => { currentPage--; renderPage(); };
    el.appendChild(prev);

    const info = document.createElement('span');
    info.textContent = ` Page ${currentPage} of ${totalPages} `;
    el.appendChild(info);

    const next = document.createElement('button');
    next.textContent = 'Next →';
    next.disabled = currentPage === totalPages;
    next.onclick  = () => { currentPage++; renderPage(); };
    el.appendChild(next);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}