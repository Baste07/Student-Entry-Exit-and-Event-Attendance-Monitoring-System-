/* ============================================================
   StudentEntryExit/resc/js/entryExitLogs.js
============================================================ */
'use strict';

const PAGE_SIZE = 25;
let allLogs      = [];
let filteredLogs = [];
let currentPage  = 1;

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    // Default date range: today
    const today = new Date().toLocaleDateString('en-CA');
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value   = today;

    loadLogs();
    bindFilters();
});

async function loadLogs() {
    const tbody = document.getElementById('logsTableBody');
    tbody.innerHTML = `<tr><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;

    try {
        const { data, error } = await supabaseClient
            .from('entry_exit_logs')
            .select(`
                id, log_type, scan_method, log_date, log_timestamp,
                students ( stud_id, first_name, last_name, grade_level, section_name )
            `)
            .order('log_timestamp', { ascending: false })
            .limit(1000); // cap for performance; refine with date filter below

        if (error) throw error;
        allLogs = data || [];
        applyFilters();
    } catch (e) {
        console.error('[entryExitLogs] load error:', e);
        tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">Failed to load logs.</td></tr>`;
    }
}

function bindFilters() {
    ['searchInput','typeFilter','methodFilter','dateFrom','dateTo'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
        document.getElementById(id).addEventListener('change', applyFilters);
    });
    document.getElementById('clearFilters').addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        document.getElementById('typeFilter').value  = '';
        document.getElementById('methodFilter').value = '';
        document.getElementById('dateFrom').value = '';
        document.getElementById('dateTo').value   = '';
        applyFilters();
    });
}

function applyFilters() {
    const q      = document.getElementById('searchInput').value.toLowerCase();
    const type   = document.getElementById('typeFilter').value;
    const method = document.getElementById('methodFilter').value;
    const from   = document.getElementById('dateFrom').value;
    const to     = document.getElementById('dateTo').value;

    filteredLogs = allLogs.filter(l => {
        const s        = l.students || {};
        const fullName = `${s.first_name || ''} ${s.last_name || ''}`.toLowerCase();
        const studId   = (s.stud_id || '').toLowerCase();
        const matchQ   = !q || fullName.includes(q) || studId.includes(q);
        const matchT   = !type   || l.log_type    === type;
        const matchM   = !method || (l.scan_method || '').toLowerCase() === method;
        const matchF   = !from   || l.log_date >= from;
        const matchTo  = !to     || l.log_date <= to;
        return matchQ && matchT && matchM && matchF && matchTo;
    });

    currentPage = 1;
    updateBadges();
    renderTable();
    renderPagination();
}

function updateBadges() {
    const entries = filteredLogs.filter(l => l.log_type === 'entry').length;
    const exits   = filteredLogs.filter(l => l.log_type === 'exit').length;
    setEl('badgeTotal',   filteredLogs.length);
    setEl('badgeEntries', entries);
    setEl('badgeExits',   exits);
}

function renderTable() {
    const tbody = document.getElementById('logsTableBody');
    const start = (currentPage - 1) * PAGE_SIZE;
    const page  = filteredLogs.slice(start, start + PAGE_SIZE);

    if (page.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">No records found.</td></tr>`;
        return;
    }

    tbody.innerHTML = page.map(l => {
        const s    = l.students || {};
        const name = `${s.last_name || '—'}, ${s.first_name || '—'}`;
        const time = l.log_timestamp
            ? new Date(l.log_timestamp).toLocaleTimeString('en-US', {
                timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit'
              })
            : '—';
        const typeBadge = l.log_type === 'entry'
            ? '<span class="badge badge-entry"><i class="fa-solid fa-door-open"></i> Entry</span>'
            : '<span class="badge badge-exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
        const methodBadge = methodBadgeHtml(l.scan_method);
        return `<tr>
            <td>${s.stud_id || '—'}</td>
            <td>${name}</td>
            <td>${s.grade_level || '—'}</td>
            <td>${s.section_name || '—'}</td>
            <td>${typeBadge}</td>
            <td>${methodBadge}</td>
            <td>${l.log_date || '—'}</td>
            <td>${time}</td>
        </tr>`;
    }).join('');
}

function renderPagination() {
    const total = Math.ceil(filteredLogs.length / PAGE_SIZE);
    const pg    = document.getElementById('pagination');
    if (total <= 1) { pg.innerHTML = ''; return; }
    let html = '';
    for (let i = 1; i <= total; i++) {
        html += `<button class="page-btn${i === currentPage ? ' active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }
    pg.innerHTML = html;
}

function goToPage(page) { currentPage = page; renderTable(); renderPagination(); }

function methodBadgeHtml(method) {
    switch ((method || '').toLowerCase()) {
        case 'face':   return '<span class="badge badge-face"><i class="fa-solid fa-face-smile"></i> Face</span>';
        case 'qr':     return '<span class="badge badge-qr"><i class="fa-solid fa-qrcode"></i> QR</span>';
        case 'manual': return '<span class="badge badge-manual"><i class="fa-solid fa-hand"></i> Manual</span>';
        default:       return `<span class="badge">${method || '—'}</span>`;
    }
}

function exportCSV() {
    if (filteredLogs.length === 0) { showToast('No data to export.'); return; }
    const headers = ['Student ID','Last Name','First Name','Grade','Section','Type','Method','Date','Time'];
    const rows = filteredLogs.map(l => {
        const s    = l.students || {};
        const time = l.log_timestamp
            ? new Date(l.log_timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '';
        return [
            s.stud_id || '', s.last_name || '', s.first_name || '',
            s.grade_level || '', s.section_name || '',
            l.log_type || '', l.scan_method || '',
            l.log_date || '', time
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `entry_exit_logs_${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported!');
}

function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

function showToast(msg) {
    const t = document.getElementById('toast');
    const m = document.getElementById('toastMsg');
    if (!t || !m) return;
    m.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}