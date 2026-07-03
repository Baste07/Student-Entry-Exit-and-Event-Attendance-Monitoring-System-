/* ============================================================
   resc/js/voidedSessions.js
============================================================ */

// ── Get department logos from session ─────────────────────────
function getDeptLogos() {
    try {
        const user = JSON.parse(sessionStorage.getItem('user') || '{}');
        return {
            deptLogo: user.departmentLogo || '../resc/assets/ccs_logo.png',
            deptName: user.department     || 'College of Computer Studies',
            deptCode: user.departmentCode || 'CCS',
        };
    } catch (e) {
        return {
            deptLogo: '../resc/assets/ccs_logo.png',
            deptName: 'College of Computer Studies',
            deptCode: 'CCS',
        };
    }
}

let allSessions = [];
let filteredSessions = [];

function parseSessionLabFromNotes(notes) {
    const txt = String(notes || '');
    const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
    if (!m || !m[1]) return null;
    const label = m[1].trim();
    const parts = label.split(' - ');
    if (parts.length >= 2) {
        return { lab_id: null, lab_code: parts[0].trim(), building: null };
    }
    return { lab_id: null, lab_code: label, building: null };
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        alert("Supabase client not found. Please check config/.env.js");
        return;
    }
    initAutoFilters();
    await loadDropdownData();
    await fetchSessions();
});

function initAutoFilters() {
    const search = document.getElementById('filterSearch');
    const professor = document.getElementById('filterProfessor');
    const subject = document.getElementById('filterSubject');
    const lab = document.getElementById('filterLab');
    const dateFrom = document.getElementById('filterDateFrom');
    const dateTo = document.getElementById('filterDateTo');

    if (search) {
        search.addEventListener('input', applyFilters);
        search.addEventListener('keyup', applyFilters);
    }
    [professor, subject, lab, dateFrom, dateTo].forEach((el) => {
        if (el) el.addEventListener('change', applyFilters);
    });
}

async function loadDropdownData() {
    const { data: profs } = await supabaseClient.from('professors').select('professor_id, first_name, last_name').eq('status', 'active');
    if (profs) {
        const sel = document.getElementById('filterProfessor');
        profs.forEach(p => sel.add(new Option(`${p.first_name} ${p.last_name}`, p.professor_id)));
    }
    const { data: subs } = await supabaseClient.from('subjects').select('subject_id, subject_code');
    if (subs) {
        const sel = document.getElementById('filterSubject');
        subs.forEach(s => sel.add(new Option(s.subject_code, s.subject_id)));
    }
    const { data: labs } = await supabaseClient.from('laboratory_rooms').select('lab_id, lab_code');
    if (labs) {
        const sel = document.getElementById('filterLab');
        labs.forEach(l => sel.add(new Option(l.lab_code, l.lab_id)));
    }
}

async function fetchSessions() {
    document.getElementById('resultsCountText').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching data...';
    const { data, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id, session_date, status, actual_start_time, actual_end_time, notes,
            lab_schedules (
                section, start_time, end_time, day_of_week,
                subjects (subject_id, subject_code, subject_name),
                professors (professor_id, first_name, last_name),
                laboratory_rooms (lab_id, lab_code, building)
            )
        `)
        .order('session_date', { ascending: false });

    if (error) { console.error(error); alert("Error fetching data from Supabase"); return; }
    allSessions = (data || []).map(s => ({
        ...s,
        laboratory_rooms: parseSessionLabFromNotes(s.notes) || null
    }));
    applyFilters();
}

function applyFilters() {
    const search = document.getElementById('filterSearch').value.toLowerCase();
    const profId = document.getElementById('filterProfessor').value;
    const subId  = document.getElementById('filterSubject').value;
    const labId  = document.getElementById('filterLab').value;
    const dateF  = document.getElementById('filterDateFrom').value;
    const dateT  = document.getElementById('filterDateTo').value;

    filteredSessions = allSessions.filter(s => {
        const sch = s.lab_schedules;
        // prefer session-level lab if present
        const sessionLab = s.laboratory_rooms || sch.laboratory_rooms;
        if (!sch) return false;
        let match = true;
        if (search) {
            const profName = `${sch.professors.first_name} ${sch.professors.last_name}`.toLowerCase();
            const subCode = sch.subjects.subject_code.toLowerCase();
            if (!profName.includes(search) && !subCode.includes(search) && !sch.section.toLowerCase().includes(search)) match = false;
        }
        if (profId && sch.professors.professor_id != profId) match = false;
        if (subId && sch.subjects.subject_id != subId) match = false;
        if (labId && sessionLab.lab_id != labId) match = false;
        if (dateF && s.session_date < dateF) match = false;
        if (dateT && s.session_date > dateT) match = false;
        return match;
    });
    renderTable();
    updateStats();
}

function resetFilters() {
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterProfessor').value = '';
    document.getElementById('filterSubject').value = '';
    document.getElementById('filterLab').value = '';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    applyFilters();
}

function renderTable() {
    const tbody = document.getElementById('sessionsTableBody');
    tbody.innerHTML = '';
    document.getElementById('resultsCountText').innerHTML = `Showing <strong>${filteredSessions.length}</strong> sessions`;

    if (filteredSessions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="empty"><h3>No sessions found</h3></td></tr>`;
        return;
    }

    filteredSessions.forEach((s, index) => {
        const sch = s.lab_schedules;
        const sessionLab = s.laboratory_rooms || sch.laboratory_rooms;
        const profName = `${sch.professors.first_name} ${sch.professors.last_name}`;
        const s_start = sch.start_time.substring(0, 5);
        const s_end   = sch.end_time.substring(0, 5);
        const a_start = s.actual_start_time ? s.actual_start_time.substring(0, 5) : '—';
        const a_end   = s.actual_end_time ? s.actual_end_time.substring(0, 5) : '—';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td>
                <div style="font-weight:600">${s.session_date}</div>
                <div style="font-size:11px;color:var(--s500)">${sch.day_of_week}</div>
            </td>
            <td>
                <div class="subj-code">${sch.subjects.subject_code}</div>
                <div class="subj-name">${sch.subjects.subject_name}</div>
            </td>
            <td>${profName}</td>
            <td><span class="badge" style="background:var(--s100);color:var(--s900)">${sch.section}</span></td>
            <td><strong>${sessionLab.lab_code}</strong></td>
            <td>
                <div class="t-sched">${s_start} – ${s_end}</div>
                <div class="t-actual">${a_start} – ${a_end}</div>
            </td>
            <td><span class="badge ${s.status}">${s.status.toUpperCase()}</span></td>
            <td>${s.status === 'completed' ? `<a href="#" class="act-btn act-view"><i class="fa-solid fa-users"></i></a>` : `—`}</td>
            <td><button class="btn-del-row" onclick="deleteSession(${s.session_id})"><i class="fa-solid fa-trash"></i></button></td>
        `;
        tbody.appendChild(tr);
    });
}

function updateStats() {
    const container = document.getElementById('statusPillsContainer');
    const counts = { total: filteredSessions.length, completed: 0, cancelled: 0, ongoing: 0, scheduled: 0 };
    filteredSessions.forEach(s => counts[s.status] = (counts[s.status] || 0) + 1);
    container.innerHTML = `
        <div class="pill p-all on"><i class="fa-solid fa-border-all"></i> All <b>${counts.total}</b></div>
        ${counts.completed ? `<div class="pill p-done"><i class="fa-solid fa-check"></i> Completed <b>${counts.completed}</b></div>` : ''}
        ${counts.cancelled ? `<div class="pill p-void"><i class="fa-solid fa-ban"></i> Voided <b>${counts.cancelled}</b></div>` : ''}
        ${counts.ongoing   ? `<div class="pill p-live"><i class="fa-solid fa-tower-broadcast"></i> Ongoing <b>${counts.ongoing}</b></div>` : ''}
    `;
}

async function deleteSession(id) {
    if (!confirm(`Are you sure you want to delete Session ID: ${id}?`)) return;
    const { error } = await supabaseClient.from('lab_sessions').delete().eq('session_id', id);
    if (!error) { alert("Session deleted successfully."); fetchSessions(); }
    else { alert("Error deleting session."); }
}

function showDeleteAll() { document.getElementById('delAllModal').classList.add('on'); }
function closeDelAll()   { document.getElementById('delAllModal').classList.remove('on'); }

async function deleteAllSessions() {
    const { error } = await supabaseClient.from('lab_sessions').delete().neq('session_id', 0);
    if (!error) { alert("All sessions have been wiped."); closeDelAll(); fetchSessions(); }
    else { alert("Error wiping sessions."); }
}

// ── Report State ──────────────────────────────────────────────
let META = {};
let existingReportsToday = [];

async function openReportModal() {
    document.getElementById('rmModal').classList.add('on');
    const tbody = document.getElementById('reportTableBody');
    tbody.innerHTML = '';
    const reportData = filteredSessions.filter(s => s.status === 'completed');

    const completed = reportData.length;
    const cancelled = filteredSessions.filter(s => s.status === 'cancelled').length;
    const ongoing   = filteredSessions.filter(s => s.status === 'ongoing').length;
    const genDate   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const profSel = document.getElementById('filterProfessor');
    const subSel  = document.getElementById('filterSubject');
    const labSel  = document.getElementById('filterLab');
    const filterStr = [
        profSel.value ? profSel.options[profSel.selectedIndex].text : null,
        subSel.value  ? subSel.options[subSel.selectedIndex].text   : null,
        labSel.value  ? labSel.options[labSel.selectedIndex].text   : null,
    ].filter(Boolean).join(', ') || 'All';

    META = { total: filteredSessions.length, completed, cancelled, ongoing, filters: filterStr, date: genDate };
    document.getElementById('reportMetaText').innerText = `Generated ${genDate} · ${completed} completed records`;

    reportData.forEach((s, i) => {
        const sch = s.lab_schedules;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${i+1}</td>
            <td>${s.session_date}</td>
            <td>${sch.day_of_week}</td>
            <td><b>${sch.subjects.subject_code}</b></td>
            <td>${sch.professors.first_name} ${sch.professors.last_name}</td>
            <td><span style="background:var(--g100);color:var(--g800);padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">${sch.section}</span></td>
            <td>${sch.laboratory_rooms.lab_code}</td>
            <td>${sch.start_time.substring(0,5)}</td>
            <td>${s.actual_start_time ? s.actual_start_time.substring(0,5) : '—'}</td>
            <td>${s.actual_end_time ? s.actual_end_time.substring(0,5) : '—'}</td>
            <td><span class="rm-badge ${s.status}">${s.status.toUpperCase()}</span></td>
        `;
        tbody.appendChild(tr);
    });

    window.REPORT_DATA = reportData;

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', 'sessions')
            .like('report_name', `%${dateStr}%`);
        existingReportsToday = data ? data.map(d => ({
            name: d.report_name,
            dataString: typeof d.report_data === 'string' ? d.report_data : JSON.stringify(d.report_data)
        })) : [];
    } catch (e) { existingReportsToday = []; }
}

function closeReportModal() { document.getElementById('rmModal').classList.remove('on'); }

function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Session History Report — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(window.REPORT_DATA);
    const isExactDuplicate = existingReportsToday.some(r => r.name === reportName && r.dataString === currentDataString);
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true;
}

async function saveReport() {
    if (!checkDuplicateWarning('Manual Save')) return;
    const btn = document.querySelector('.rm-btn[onclick="saveReport()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
    await autoSaveReport('Manual Save');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to Reports'; }
}

async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Session History Report — ${dateStr} (${exportType})`;
    const currentFilters = {
        search:    document.getElementById('filterSearch').value,
        professor: document.getElementById('filterProfessor').options[document.getElementById('filterProfessor').selectedIndex]?.text || 'All',
        subject:   document.getElementById('filterSubject').options[document.getElementById('filterSubject').selectedIndex]?.text   || 'All',
        lab:       document.getElementById('filterLab').options[document.getElementById('filterLab').selectedIndex]?.text           || 'All',
    };
    const payload = {
        report_type: 'sessions',
        report_name: reportName,
        filters:     JSON.stringify(currentFilters),
        report_data: JSON.stringify(window.REPORT_DATA)
    };
    existingReportsToday.push({ name: payload.report_name, dataString: payload.report_data });
    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;
        showToast(exportType === 'Manual Save' ? 'Report saved successfully!' : `${exportType} downloaded & report saved!`);
    } catch (err) {
        console.error('Auto-save error:', err);
        showToast('Action complete but failed to save report: ' + err.message, true);
    }
}

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.className = 'toast on' + (isError ? ' error' : '');
    setTimeout(() => t.className = 'toast', 4000);
}

function loadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

// ── Print ─────────────────────────────────────────────────────
async function printReport() {
    if (!checkDuplicateWarning('Print')) return;

    // ✅ Read from sessionStorage BEFORE the HTML string
    const { deptLogo, deptName } = getDeptLogos();

    const cols = ['#','Date','Day','Subject Code','Professor','Section','Lab','Sched Time','Actual Start','Actual End','Status'];
    const nowStr = new Date().toLocaleString();

    const rows = window.REPORT_DATA.map((r, i) => {
        const sch = r.lab_schedules;
        let statusColor = '#64748b';
        const s = r.status.toLowerCase();
        if (s === 'completed')                     statusColor = '#166534';
        if (s === 'cancelled')                     statusColor = '#dc2626';
        if (s === 'ongoing' || s === 'dismissing') statusColor = '#d97706';
        if (s === 'scheduled')                     statusColor = '#2563eb';
        return `<tr>
            <td>${i + 1}</td>
            <td>${r.session_date}</td>
            <td>${sch.day_of_week}</td>
            <td><strong>${sch.subjects.subject_code}</strong></td>
            <td>${sch.professors.last_name}</td>
            <td>${sch.section}</td>
            <td><strong>${sch.laboratory_rooms.lab_code}</strong></td>
            <td>${sch.start_time.substring(0,5)}</td>
            <td>${r.actual_start_time ? r.actual_start_time.substring(0,5) : '—'}</td>
            <td>${r.actual_end_time ? r.actual_end_time.substring(0,5) : '—'}</td>
            <td><span style="color:${statusColor};font-weight:bold;">${r.status.toUpperCase()}</span></td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Session History Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        .header-container{background-color:#ffffff;color:#000000;text-align:center;margin-bottom:20px;padding:20px 15px;border:2px solid #000000;border-radius:8px;}
        .logos-text-wrapper{display:flex;justify-content:center;align-items:center;gap:25px;margin-bottom:10px;}
        .logo-img{height:50px;width:auto;object-fit:contain;}
        .univ-title{font-size:18px;font-weight:bold;color:#000000;line-height:1.2;letter-spacing:0.5px;}
        .college-title{font-size:11px;color:#444444;letter-spacing:1px;text-transform:uppercase;}
        .report-title{font-size:16px;font-weight:bold;color:#000000;margin-top:12px;text-transform:uppercase;letter-spacing:1px;}
        .report-meta{font-size:11px;color:#555555;margin-top:5px;}
        table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #000000 !important;}
        th{background:#ffffff;color:#000000;padding:8px 10px;border:1px solid #000000 !important;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
        td{padding:8px 10px;border:1px solid #000000 !important;font-size:11px;text-align:center;}
        td:nth-child(4),td:nth-child(5){text-align:left;}
        tr:nth-child(even){background:#f9fafb;}
        .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        @media print{body{padding:0px}}
    </style></head><body>
    <div class="header-container">
        <div class="logos-text-wrapper">
            <img src="../resc/assets/plp_logo.png" class="logo-img" alt="PLP Logo">
            <div>
                <div class="univ-title">PAMANTASAN NG LUNGSOD NG PASIG</div>
                <div class="college-title">${deptName}</div>
            </div>
            <img src="${deptLogo}" class="logo-img" alt="Department Logo">
        </div>
        <div class="report-title">Session History Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Completed Records: ${META.completed} &nbsp;&middot;&nbsp; Filters: ${META.filters}</div>
    </div>
    <table>
        <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
    </table>
    <div class="footer">Laboratory Attendance System &nbsp;&middot;&nbsp; ${nowStr}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
    w.document.close();
    await autoSaveReport('Print');
}

// ── PDF ───────────────────────────────────────────────────────
async function downloadPDF() {
    if (!checkDuplicateWarning('PDF')) return;

    const { deptLogo, deptName } = getDeptLogos(); // ✅ before anything else

    const { jsPDF } = window.jspdf;
    const nowStr = new Date().toLocaleString();

    const [plpData, ccsData] = await Promise.all([
        loadImage('../resc/assets/plp_logo.png'),
        loadImage(deptLogo)  // ✅ dynamic
    ]);

    const doc = new jsPDF('landscape');
    const pageW = doc.internal.pageSize.width;
    const centerX = pageW / 2;
    const headerHeight = 45;

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.1);
    doc.rect(10, 5, pageW - 20, headerHeight, 'S');

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' }); // ✅ dynamic
    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text('SESSION HISTORY REPORT', centerX, 33, { align: 'center' });
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text(`Generated: ${nowStr}  ·  Completed Records: ${META.completed}`, centerX, 39, { align: 'center' });

    if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, 18, 18);
    if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 67, 10, 18, 18); // ccsData now holds deptLogo

    doc.autoTable({
        head: [['#','Date','Day','Subject','Professor','Section','Lab','Sched\nTime','Actual\nStart','Actual\nEnd','Status']],
        body: window.REPORT_DATA.map((r, i) => {
            const sch = r.lab_schedules;
            return [
                i + 1, r.session_date, sch.day_of_week, sch.subjects.subject_code,
                sch.professors.last_name, sch.section, sch.laboratory_rooms.lab_code,
                sch.start_time.substring(0,5),
                r.actual_start_time ? r.actual_start_time.substring(0,5) : '—',
                r.actual_end_time   ? r.actual_end_time.substring(0,5)   : '—',
                r.status.toUpperCase()
            ];
        }),
        startY: headerHeight + 10,
        theme: 'grid',
        headStyles: { fillColor: [255,255,255], textColor: [0,0,0], lineColor: [0,0,0], lineWidth: 0.1, halign: 'center' },
        styles: { lineColor: [0,0,0], lineWidth: 0.1, fontSize: 7.5, textColor: [0,0,0] },
        didParseCell(d) {
            if (d.column.index === 10 && d.section === 'body') {
                const s = (d.cell.text[0] || '').toLowerCase();
                if (s === 'completed') { d.cell.styles.textColor = [22,101,52]; }
                else if (s === 'cancelled') { d.cell.styles.textColor = [220,38,38]; }
            }
        }
    });

    doc.save(`Session_History_Report_${new Date().toISOString().split('T')[0]}.pdf`);
    await autoSaveReport('PDF');
}

// ── CSV ───────────────────────────────────────────────────────
async function exportCSV() {
    if (!checkDuplicateWarning('CSV')) return;
    const cols = ['#','Date','Day','Subject Code','Professor','Section','Lab','Sched Time','Actual Start','Actual End','Status'];
    const lines = [
        cols.join(','),
        ...window.REPORT_DATA.map((s, i) => {
            const sch = s.lab_schedules;
            return [
                i + 1,
                `"${s.session_date}"`,
                `"${sch.day_of_week}"`,
                `"${sch.subjects.subject_code}"`,
                `"${sch.professors.last_name}"`,
                `"${sch.section}"`,
                `"${sch.laboratory_rooms.lab_code}"`,
                `"${sch.start_time.substring(0,5)}"`,
                `"${s.actual_start_time ? s.actual_start_time.substring(0,5) : ''}"`,
                `"${s.actual_end_time   ? s.actual_end_time.substring(0,5)   : ''}"`,
                `"${s.status}"`
            ].join(',');
        })
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `Session_History_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    await autoSaveReport('CSV');
}

// ── Excel ─────────────────────────────────────────────────────
async function exportExcel() {
    if (!checkDuplicateWarning('Excel')) return;
    if (!window.XLSX) { return exportCSV(); }

    const wb = XLSX.utils.book_new();
    const summaryData = [
        ['Session History Report'],
        ['Generated', new Date().toLocaleString()],
        ['Filters',   META.filters],
        [''],
        ['Total Sessions',     META.total],
        ['Completed',          META.completed],
        ['Cancelled / Voided', META.cancelled],
        ['Ongoing',            META.ongoing],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    summarySheet['!cols'] = [{ wch: 22 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

    const headers = ['#','Date','Day','Subject Code','Professor','Section','Lab','Sched Time','Actual Start','Actual End','Status'];
    const rows = window.REPORT_DATA.map((r, i) => {
        const sch = r.lab_schedules;
        return [
            i + 1, r.session_date, sch.day_of_week, sch.subjects.subject_code,
            `${sch.professors.first_name} ${sch.professors.last_name}`,
            sch.section, sch.laboratory_rooms.lab_code,
            sch.start_time.substring(0,5),
            r.actual_start_time ? r.actual_start_time.substring(0,5) : '—',
            r.actual_end_time   ? r.actual_end_time.substring(0,5)   : '—',
            r.status.toUpperCase()
        ];
    });
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    dataSheet['!cols'] = [
        {wch:5},{wch:14},{wch:12},{wch:16},{wch:24},
        {wch:12},{wch:10},{wch:13},{wch:14},{wch:14},{wch:14}
    ];
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Session History');
    XLSX.writeFile(wb, `Session_History_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    await autoSaveReport('Excel');
}

// ── XML ───────────────────────────────────────────────────────
async function exportXML() {
    if (!checkDuplicateWarning('XML')) return;

    const { deptLogo, deptName } = getDeptLogos(); // ✅ before anything else

    const xmlEscape = (value) => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const generatedAt = new Date().toISOString();
    const generatedAtReadable = new Date().toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const [plpData, ccsData] = await Promise.all([
        loadImage('../resc/assets/plp_logo.png'),
        loadImage(deptLogo) // ✅ dynamic
    ]);

    const plpLogoSrc = plpData || '../resc/assets/plp_logo.png';
    const ccsLogoSrc = ccsData || deptLogo; // ✅ fallback to URL directly

    const rowsXml = window.REPORT_DATA.map((r, i) => {
        const sch = r.lab_schedules || {};
        const subject = sch.subjects || {};
        const prof = sch.professors || {};
        const lab = sch.laboratory_rooms || {};
        return `
    <session>
        <row_number>${i + 1}</row_number>
        <session_date>${xmlEscape(r.session_date)}</session_date>
        <day>${xmlEscape(sch.day_of_week || '')}</day>
        <subject_code>${xmlEscape(subject.subject_code || '')}</subject_code>
        <professor>${xmlEscape(`${prof.first_name || ''} ${prof.last_name || ''}`.trim())}</professor>
        <section>${xmlEscape(sch.section || '')}</section>
        <lab_code>${xmlEscape(lab.lab_code || '')}</lab_code>
        <scheduled_time>${xmlEscape((sch.start_time || '').substring(0,5))}</scheduled_time>
        <actual_start>${xmlEscape(r.actual_start_time ? r.actual_start_time.substring(0,5) : '')}</actual_start>
        <actual_end>${xmlEscape(r.actual_end_time ? r.actual_end_time.substring(0,5) : '')}</actual_end>
        <status>${xmlEscape(r.status || '')}</status>
    </session>`;
    }).join('');

    const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
    <xsl:output method="html" indent="yes" encoding="UTF-8"/>
    <xsl:template match="/">
        <html><head><meta charset="UTF-8"/><title>Session History Report</title>
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111;background:#f3f4f6}
            .header-container{background-color:#ffffff;text-align:center;margin-bottom:20px;padding:20px 15px;border:2px solid #000;border-radius:8px;}
            .logos-text-wrapper{display:flex;justify-content:center;align-items:center;gap:25px;margin-bottom:10px;}
            .logo-img{height:50px;width:auto;object-fit:contain;}
            .univ-title{font-size:18px;font-weight:bold;color:#000;line-height:1.2;}
            .college-title{font-size:11px;color:#444;letter-spacing:1px;text-transform:uppercase;}
            .report-title{font-size:16px;font-weight:bold;color:#000;margin-top:12px;text-transform:uppercase;letter-spacing:1px;}
            .report-meta{font-size:11px;color:#555;margin-top:5px;}
            table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #000;background:#fff}
            th{background:#fff;color:#000;padding:8px 10px;border:1px solid #000;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;white-space:nowrap}
            td{padding:8px 10px;border:1px solid #000;font-size:11px;text-align:center;color:#111}
            td.left{text-align:left}
            tr:nth-child(even){background:#f9fafb;}
            .status{font-weight:bold}
            .completed{color:#166534}.cancelled{color:#dc2626}.ongoing,.dismissing{color:#d97706}.scheduled{color:#2563eb}
            .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        </style></head>
        <body><div class="header-container">
            <div class="logos-text-wrapper">
                <img src="${plpLogoSrc}" class="logo-img" alt="PLP Logo"/>
                <div>
                    <div class="univ-title">PAMANTASAN NG LUNGSOD NG PASIG</div>
                    <div class="college-title">${deptName}</div>
                </div>
                <img src="${ccsLogoSrc}" class="logo-img" alt="Department Logo"/>
            </div>
            <div class="report-title">Session History Report</div>
            <div class="report-meta">
                Generated: <xsl:value-of select="session_history_report/meta/generated_at_readable"/> &#160;&#183;&#160;
                Completed Records: <xsl:value-of select="session_history_report/meta/completed_records"/> &#160;&#183;&#160;
                Filters: <xsl:value-of select="session_history_report/meta/filters"/>
            </div>
        </div>
        <table><thead><tr>
            <th>#</th><th>Date</th><th>Day</th><th>Subject Code</th><th>Professor</th>
            <th>Section</th><th>Lab</th><th>Sched Time</th><th>Actual Start</th><th>Actual End</th><th>Status</th>
        </tr></thead>
        <tbody>
            <xsl:for-each select="session_history_report/sessions/session">
            <tr>
                <td><xsl:value-of select="row_number"/></td>
                <td><xsl:value-of select="session_date"/></td>
                <td><xsl:value-of select="day"/></td>
                <td class="left"><strong><xsl:value-of select="subject_code"/></strong></td>
                <td class="left"><xsl:value-of select="professor"/></td>
                <td><xsl:value-of select="section"/></td>
                <td><strong><xsl:value-of select="lab_code"/></strong></td>
                <td><xsl:value-of select="scheduled_time"/></td>
                <td><xsl:value-of select="actual_start"/></td>
                <td><xsl:value-of select="actual_end"/></td>
                <td><span>
                    <xsl:attribute name="class">
                        <xsl:text>status </xsl:text>
                        <xsl:value-of select="translate(status,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')"/>
                    </xsl:attribute>
                    <xsl:value-of select="translate(status,'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ')"/>
                </span></td>
            </tr>
            </xsl:for-each>
        </tbody></table>
        <div class="footer">Laboratory Attendance System &#160;&#183;&#160; <xsl:value-of select="session_history_report/meta/generated_at_readable"/></div>
        </body></html>
    </xsl:template>
</xsl:stylesheet>`;

    const xslDataUri = `data:text/xsl;charset=UTF-8,${encodeURIComponent(xsl)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${xslDataUri}"?>
<session_history_report>
    <meta>
        <generated_at>${generatedAt}</generated_at>
        <generated_at_readable>${xmlEscape(generatedAtReadable)}</generated_at_readable>
        <total_sessions>${xmlEscape(META.total || 0)}</total_sessions>
        <completed_records>${xmlEscape(META.completed || 0)}</completed_records>
        <cancelled_records>${xmlEscape(META.cancelled || 0)}</cancelled_records>
        <ongoing_records>${xmlEscape(META.ongoing || 0)}</ongoing_records>
        <filters>${xmlEscape(META.filters || 'All')}</filters>
    </meta>
    <sessions>${rowsXml}
    </sessions>
</session_history_report>`;

    const fileName = `Session_History_Report_${new Date().toISOString().split('T')[0]}.xml`;
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
    await autoSaveReport('XML');
}