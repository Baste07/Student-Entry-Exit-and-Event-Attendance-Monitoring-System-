/* ============================================================
   EntryExitMonitoring/resc/js/entry-exitLogs.js
   Updated: supports both student and employee log rows
============================================================ */
'use strict';

const PAGE_SIZE = 25;
const EXPORT_HEADERS = ['ID / EMP NO.', 'Name', 'Grade', 'Section / Role', 'Type', 'Method', 'Status', 'Date', 'Time'];
let allLogs      = [];
let filteredLogs = [];
let currentPage  = 1;

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    const today = manilaTodayISO();
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
                students ( stud_id, current_grade_level, first_name, last_name, section_id,
                    sections ( section_name )
                ),
                employees ( emp_no, first_name, last_name, faculty, role )
            `)
            .order('log_timestamp', { ascending: false })
            .limit(1000);

        if (error) throw error;
        allLogs = data || [];
        applyFilters();
    } catch (e) {
        console.error('[entryExitLogs] load error:', e);
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Failed to load logs. Please try again.</td></tr>`;
        UIFeedback.error('Entry and exit logs could not be loaded. Please try again.', 'Load failed');
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
    const entryEl = document.getElementById('badgeEntries');
    const exitEl  = document.getElementById('badgeExits');
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
        const section = s.sections || {};
        const employeeRole = e.faculty || e.role || 'Employee';
        const roleCellHtml = isEmployee
            ? `<td colspan="2"><span class="log-role-badge emp"><i class="fa-solid fa-user-tie"></i> ${escHtml(employeeRole)}</span></td>`
            : `<td>${escHtml(s.current_grade_level || '—')}</td><td>${escHtml(section.section_name || '—')}</td>`;

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

        const { date, time } = formatManilaLogTimestamp(l.log_timestamp);

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

function formatManilaLogTimestamp(timestamp) {
    const instant = timestamp ? new Date(timestamp) : null;
    if (!instant || Number.isNaN(instant.getTime())) return { date: '—', time: '—' };
    const timeZone = 'Asia/Manila';
    return {
        date: instant.toLocaleDateString('en-US', { timeZone, month: 'short', day: '2-digit', year: 'numeric' }),
        time: instant.toLocaleTimeString('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
    };
}

function getFilteredExportRows() {
    return filteredLogs.map(log => {
        const isEmployee = !!log.employee_id && !log.student_id;
        const person = isEmployee ? (log.employees || {}) : (log.students || {});
        const { date, time } = formatManilaLogTimestamp(log.log_timestamp);
        return [
            String((isEmployee ? person.emp_no : person.stud_id) || '—'),
            `${person.last_name || '—'}, ${person.first_name || ''}`.trim(),
            isEmployee ? '—' : String(person.current_grade_level || '—'),
            String(isEmployee ? (person.faculty || person.role || 'Employee') : (person.sections?.section_name || '—')),
            log.log_type === 'entry' ? 'Entry' : 'Exit',
            ({ face: 'Face', qr: 'QR', manual: 'Manual' })[(log.scan_method || '').toLowerCase()] || String(log.scan_method || '—'),
            !isEmployee && log.log_type === 'entry' && typeof log.is_late === 'boolean'
                ? (log.is_late ? 'Late' : 'On Time') : '—',
            date,
            time
        ];
    });
}

function manilaTodayISO(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function exportFileName(extension, now = new Date()) {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    const datePart = from && to ? `${from}-to-${to}` : manilaTodayISO(now);
    return `entry-exit-logs-${datePart}.${extension}`;
}

function csvCell(value, forceText = false) {
    const text = String(value ?? '');
    // A leading tab makes spreadsheet cells text, including mutable IDs and formula-like input.
    const safe = forceText || /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `\t${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
}

function exportCSV() {
    const rows = getFilteredExportRows();
    if (!rows.length) { UIFeedback.toast({ type: 'info', message: 'No records to export.' }); return; }
    try {
        const csv = [EXPORT_HEADERS, ...rows].map((row, index) =>
            row.map((cell, column) => csvCell(cell, index > 0 && column === 0)).join(',')
        ).join('\r\n');
        const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = exportFileName('csv');
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        UIFeedback.success('Entry-Exit logs exported successfully as CSV.');
    } catch (error) {
        console.error('Entry-Exit CSV export failed:', error);
        UIFeedback.error('The CSV could not be exported. Please try again.');
    }
}

function exportPDF() {
    const rows = getFilteredExportRows();
    if (!rows.length) { UIFeedback.toast({ type: 'info', message: 'No records to export.' }); return; }
    if (!window.jspdf?.jsPDF) {
        UIFeedback.error('PDF export is unavailable. Please reload the page and try again.');
        return;
    }
    try {
        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        if (typeof doc.autoTable !== 'function') {
            UIFeedback.error('PDF export is unavailable. Please reload the page and try again.');
            return;
        }
        const width = doc.internal.pageSize.width;
        const from = document.getElementById('dateFrom').value;
        const to = document.getElementById('dateTo').value;
        const labels = { entry: 'Entry', exit: 'Exit', face: 'Face', qr: 'QR', manual: 'Manual',
            student: 'Students', employee: 'Employees' };
        const filter = id => document.getElementById(id).value;
        const dateRange = from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Through ${to}` : 'All dates';
        const generated = new Date().toLocaleString('en-US', {
            timeZone: 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });

        doc.setFillColor(11, 78, 120);
        doc.rect(10, 10, width - 20, 20, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text('El Tres Eres Cencia Escuela', 15, 18);
        doc.setFontSize(11);
        doc.text('Entry-Exit Attendance Logs', 15, 25);
        doc.setTextColor(32, 54, 75);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.text(`Date Range: ${dateRange}`, 10, 38);
        doc.text(`Filters: User Type: ${labels[filter('userTypeFilter')] || 'All'}  |  Log Type: ${labels[filter('typeFilter')] || 'All'}  |  Method: ${labels[filter('methodFilter')] || 'All'}`, 10, 44);
        const searchLines = doc.splitTextToSize(`Search: ${filter('searchInput') || 'All'}`, width - 20);
        const displayedSearch = searchLines.slice(0, 2);
        if (searchLines.length > 2) displayedSearch[1] = `${displayedSearch[1].slice(0, -3)}...`;
        doc.text(displayedSearch, 10, 50);
        const generatedY = 50 + displayedSearch.length * 4.5;
        doc.text(`Generated: ${generated} (Asia/Manila)  |  Records: ${rows.length}`, 10, generatedY);

        doc.autoTable({
            head: [EXPORT_HEADERS], body: rows, startY: generatedY + 6,
            margin: { left: 10, right: 10, top: 15, bottom: 15 },
            theme: 'grid', showHead: 'everyPage', rowPageBreak: 'avoid',
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle', textColor: [32, 54, 75] },
            headStyles: { fillColor: [11, 78, 120], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
            columnStyles: {
                0: { cellWidth: 24 }, 1: { cellWidth: 54 }, 2: { cellWidth: 21 },
                3: { cellWidth: 44 }, 4: { cellWidth: 18 }, 5: { cellWidth: 22 },
                6: { cellWidth: 20 }, 7: { cellWidth: 35 }, 8: { cellWidth: 29 }
            }
        });
        const pages = doc.internal.getNumberOfPages();
        for (let page = 1; page <= pages; page++) {
            doc.setPage(page);
            doc.setFontSize(8);
            doc.setTextColor(106, 128, 146);
            doc.text(`Page ${page} of ${pages}`, width - 10, doc.internal.pageSize.height - 7, { align: 'right' });
        }
        doc.save(exportFileName('pdf'));
        UIFeedback.success('Entry-Exit logs exported successfully as PDF.');
    } catch (error) {
        console.error('Entry-Exit PDF export failed:', error);
        UIFeedback.error('The PDF could not be exported. Please try again.');
    }
}
