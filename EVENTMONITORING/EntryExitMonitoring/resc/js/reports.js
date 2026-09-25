/* ============================================================
   StudentEntryExit/resc/js/reports.js
============================================================ */
'use strict';

let chartInstance = null;
let reportData    = [];
let currentReportType = 'daily';

document.addEventListener('DOMContentLoaded', () => {
    // Default: current week
    const today   = new Date();
    const monday  = new Date(today);
    monday.setDate(today.getDate() - today.getDay() + 1);
    document.getElementById('reportFrom').value = toLocalIsoDate(monday);
    document.getElementById('reportTo').value   = toLocalIsoDate(today);
});

async function generateReport() {
    const type = document.getElementById('reportType').value;
    const from = document.getElementById('reportFrom').value;
    const to   = document.getElementById('reportTo').value;
    currentReportType = type;

    if (!from) { UIFeedback.fieldError(document.getElementById('reportFrom'), 'Start date is required.'); return; }
    if (!to) { UIFeedback.fieldError(document.getElementById('reportTo'), 'End date is required.'); return; }
    if (from > to) { UIFeedback.fieldError(document.getElementById('reportTo'), 'End date must be on or after the start date.'); return; }

    if (!supabaseClient) {
        showReportError('The database client is unavailable. Please sign in again and reload the page.');
        console.error('[reports] Supabase client is unavailable.');
        return;
    }

    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    console.info('[reports] Supabase session state', {
        authenticated: Boolean(sessionData?.session),
        sessionError: sessionError?.message || null
    });
    console.info('[reports] Generating report', { type, from, to });

    document.getElementById('emptyState').style.display   = 'none';
    document.getElementById('analyticsPanel').style.display = 'none';
    document.getElementById('chartPanel').style.display   = 'none';
    document.getElementById('tablePanel').style.display   = 'none';

    try {
        const { data: logs, error } = await supabaseClient
            .from('entry_exit_logs')
            .select(`
                log_type, scan_method, log_date, log_timestamp,
                students ( stud_id, first_name, last_name, section_id,
                    sections ( grade_level, section_name )
                )
            `)
            .gte('log_date', from)
            .lte('log_date', to)
            .order('log_date', { ascending: true });

        console.info('[reports] entry_exit_logs query result', {
            from,
            to,
            rowCount: logs?.length ?? 0,
            firstRow: logs?.[0] ?? null,
            error: error ?? null
        });

        if (error) {
            showReportError('Unable to load report data. Please try again.');
            console.error('[reports] entry_exit_logs query error:', error);
            return;
        }

        if (!logs || logs.length === 0) {
            document.getElementById('emptyState').style.display = 'block';
            document.getElementById('emptyState').querySelector('p').textContent = 'No data found for selected range.';
            UIFeedback.toast({ type: 'info', title: 'No records', message: 'No records were found for this date range.' }); return;
        }

        switch (type) {
            case 'daily':   buildDailyReport(logs, from, to);   break;
            case 'weekly':  buildWeeklyReport(logs, from, to);  break;
            case 'student': buildStudentReport(logs);            break;
            case 'grade':   buildGradeReport(logs);              break;
        }
    } catch (e) {
        console.error('[reports] generateReport error:', e);
        showReportError('Unable to generate the report. Please try again.');
    }
}

/* ── Daily: entries & exits per day ── */
function buildDailyReport(logs, from, to) {
    const days = {};
    // Populate all days in range
    const cur = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (cur <= end) {
        const d = toLocalIsoDate(cur);
        days[d] = { entries: 0, exits: 0, studentIds: new Set() };
        cur.setDate(cur.getDate() + 1);
    }
    logs.forEach(l => {
        if (!days[l.log_date]) days[l.log_date] = { entries: 0, exits: 0, studentIds: new Set() };
        if (l.log_type === 'entry') days[l.log_date].entries++;
        else                        days[l.log_date].exits++;
        if (l.log_type === 'entry' && l.students?.stud_id) days[l.log_date].studentIds.add(l.students.stud_id);
    });

    reportData = Object.entries(days).map(([date, v]) => ({
        date, entries: v.entries, exits: v.exits,
        uniqueStudents: v.studentIds.size
    }));

    updateDailyAnalytics(reportData);

    // Chart
    renderChart(
        reportData.map(r => r.date),
        [
            { label: 'Unique Students Entered', data: reportData.map(r => r.uniqueStudents), backgroundColor: 'rgba(47,143,206,.72)', borderColor: '#176aa4', borderWidth: 2 },
            { label: 'Entry Scans', data: reportData.map(r => r.entries), backgroundColor: 'rgba(16,185,129,.55)', borderColor: '#059669', borderWidth: 2 },
            { label: 'Exits',   data: reportData.map(r => r.exits),   backgroundColor: 'rgba(239,68,68,.6)',  borderColor: '#dc2626', borderWidth: 2 }
        ],
        'Daily Entry-Exit Count'
    );

    // Table
    renderTable(
        ['Date', 'Unique Students', 'Entry Scans', 'Exits', 'Total Scans'],
        reportData.map(r => [r.date, r.uniqueStudents, r.entries, r.exits, r.entries + r.exits]),
        'Daily Summary'
    );
}

function updateDailyAnalytics(rows) {
    const panel = document.getElementById('analyticsPanel');
    if (!panel) return;
    panel.style.display = 'block';
    const uniqueTotal = rows.reduce((sum, row) => sum + row.uniqueStudents, 0);
    const average = rows.length ? uniqueTotal / rows.length : 0;
    const peak = rows.reduce((best, row) => row.uniqueStudents > best.uniqueStudents ? row : best, { date: null, uniqueStudents: 0 });
    const peakDate = peak.date ? new Date(`${peak.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
    document.getElementById('analyticsUniqueStudents').textContent = uniqueTotal;
    document.getElementById('analyticsAverageStudents').textContent = average.toFixed(1);
    document.getElementById('analyticsPeakDay').textContent = peakDate;
    document.getElementById('analyticsPeakCount').textContent = peak.date ? `${peak.uniqueStudents} unique students entered` : 'No entry data';
    document.getElementById('analyticsEntryScans').textContent = rows.reduce((sum, row) => sum + row.entries, 0);
}

/* ── Weekly: group by ISO week ── */
function buildWeeklyReport(logs) {
    const weeks = {};
    logs.forEach(l => {
        const d   = new Date(l.log_date);
        const wk  = getISOWeek(d);
        const key = `Week ${wk.week} (${wk.year})`;
        if (!weeks[key]) weeks[key] = { entries: 0, exits: 0 };
        if (l.log_type === 'entry') weeks[key].entries++;
        else                        weeks[key].exits++;
    });

    reportData = Object.entries(weeks).map(([week, v]) => ({ week, ...v }));

    renderChart(
        reportData.map(r => r.week),
        [
            { label: 'Entries', data: reportData.map(r => r.entries), backgroundColor: 'rgba(16,185,129,.7)', borderColor: '#059669', borderWidth: 2 },
            { label: 'Exits',   data: reportData.map(r => r.exits),   backgroundColor: 'rgba(239,68,68,.6)',  borderColor: '#dc2626', borderWidth: 2 }
        ],
        'Weekly Entry-Exit Count'
    );

    renderTable(
        ['Week', 'Entries', 'Exits', 'Total'],
        reportData.map(r => [r.week, r.entries, r.exits, r.entries + r.exits]),
        'Weekly Summary'
    );
}

/* ── Per-student ── */
function buildStudentReport(logs) {
    const students = {};
    logs.forEach(l => {
        const s   = l.students || {};
        const section = s.sections || {};
        const key = s.stud_id || 'unknown';
        if (!students[key]) students[key] = {
            stud_id: s.stud_id, name: `${s.last_name}, ${s.first_name}`,
            grade: section.grade_level, section: section.section_name,
            entries: 0, exits: 0
        };
        if (l.log_type === 'entry') students[key].entries++;
        else                        students[key].exits++;
    });

    reportData = Object.values(students).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // No chart for per-student (too many bars); just table
    document.getElementById('chartPanel').style.display = 'none';
    renderTable(
        ['Student ID', 'Name', 'Grade', 'Section', 'Entries', 'Exits', 'Total'],
        reportData.map(r => [r.stud_id, r.name, r.grade, r.section, r.entries, r.exits, r.entries + r.exits]),
        'Per-Student Summary'
    );
}

/* ── Per-grade ── */
function buildGradeReport(logs) {
    const grades = {};
    logs.forEach(l => {
        const g = l.students?.sections?.grade_level || 'Unknown';
        if (!grades[g]) grades[g] = { entries: 0, exits: 0 };
        if (l.log_type === 'entry') grades[g].entries++;
        else                        grades[g].exits++;
    });

    reportData = Object.entries(grades)
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([grade, v]) => ({ grade, ...v }));

    renderChart(
        reportData.map(r => `Grade ${r.grade}`),
        [
            { label: 'Entries', data: reportData.map(r => r.entries), backgroundColor: 'rgba(16,185,129,.7)', borderColor: '#059669', borderWidth: 2 },
            { label: 'Exits',   data: reportData.map(r => r.exits),   backgroundColor: 'rgba(239,68,68,.6)',  borderColor: '#dc2626', borderWidth: 2 }
        ],
        'Per-Grade Entry-Exit Count'
    );

    renderTable(
        ['Grade', 'Entries', 'Exits', 'Total'],
        reportData.map(r => [`Grade ${r.grade}`, r.entries, r.exits, r.entries + r.exits]),
        'Per-Grade Summary'
    );
}

function renderChart(labels, datasets, title) {
    document.getElementById('chartPanel').style.display = 'block';
    document.getElementById('chartTitle').textContent   = title;
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const ctx = document.getElementById('reportChart').getContext('2d');
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
        }
    });
}

function renderTable(headers, rows, title) {
    document.getElementById('tablePanel').style.display = 'block';
    document.getElementById('tableTitle').textContent   = title;
    document.getElementById('reportTableHead').innerHTML =
        `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
    document.getElementById('reportTableBody').innerHTML = rows.length === 0
        ? `<tr><td colspan="${headers.length}" style="text-align:center;padding:24px;color:#6a8092;">No data.</td></tr>`
        : rows.map(r => `<tr>${r.map(c => `<td>${c ?? '—'}</td>`).join('')}</tr>`).join('');
}

function exportCSV() {
    if (!reportData || reportData.length === 0) { UIFeedback.toast({ type: 'info', message: 'Generate a report first.' }); return; }
    try {
    const type = document.getElementById('reportType').value;
    let headers, rows;
    if (type === 'student') {
        headers = ['Student ID','Name','Grade','Section','Entries','Exits','Total'];
        rows = reportData.map(r => [r.stud_id, r.name, r.grade, r.section, r.entries, r.exits, r.entries + r.exits]);
    } else if (type === 'grade') {
        headers = ['Grade','Entries','Exits','Total'];
        rows = reportData.map(r => [`Grade ${r.grade}`, r.entries, r.exits, r.entries + r.exits]);
    } else if (type === 'weekly') {
        headers = ['Week','Entries','Exits','Total'];
        rows = reportData.map(r => [r.week, r.entries, r.exits, r.entries + r.exits]);
    } else {
        headers = ['Date','Unique Students','Entry Scans','Exits','Total Scans'];
        rows = reportData.map(r => [r.date, r.uniqueStudents, r.entries, r.exits, r.entries + r.exits]);
    }
    const csv  = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `report_${type}_${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click(); URL.revokeObjectURL(url);
    UIFeedback.success('CSV exported.', 'Export complete');
    } catch (error) {
        console.error('CSV export failed:', error);
        UIFeedback.error('The CSV could not be exported. Please try again.', 'Export failed');
    }
}

function exportPDF() {
    if (!reportData || reportData.length === 0) { UIFeedback.toast({ type: 'info', message: 'Generate a report first.' }); return; }
    if (!window.jspdf) { UIFeedback.error('PDF export is unavailable. Please reload the page and try again.', 'Export unavailable'); return; }
    try {
    const { jsPDF } = window.jspdf;
    const doc  = new jsPDF();
    const type = document.getElementById('reportType').value;
    const from = document.getElementById('reportFrom').value;
    const to   = document.getElementById('reportTo').value;

    doc.setFontSize(16); doc.setFont('helvetica','bold');
    doc.text('Entry-Exit Module — Report', 14, 18);
    doc.setFontSize(10); doc.setFont('helvetica','normal');
    doc.text(`Type: ${type} | Date range: ${from} to ${to}`, 14, 26);
    doc.text(`Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`, 14, 32);

    let head, body;
    if (type === 'student') {
        head = [['Student ID','Name','Grade','Section','Entries','Exits','Total']];
        body = reportData.map(r => [r.stud_id, r.name, r.grade, r.section, r.entries, r.exits, r.entries + r.exits]);
    } else if (type === 'grade') {
        head = [['Grade','Entries','Exits','Total']];
        body = reportData.map(r => [`Grade ${r.grade}`, r.entries, r.exits, r.entries + r.exits]);
    } else if (type === 'weekly') {
        head = [['Week','Entries','Exits','Total']];
        body = reportData.map(r => [r.week, r.entries, r.exits, r.entries + r.exits]);
    } else {
        head = [['Date','Unique Students','Entry Scans','Exits','Total Scans']];
        body = reportData.map(r => [r.date, r.uniqueStudents, r.entries, r.exits, r.entries + r.exits]);
    }

    doc.autoTable({ head, body, startY: 38, styles: { fontSize: 9 }, headStyles: { fillColor: [11,78,120] } });
    doc.save(`report_${type}_${new Date().toLocaleDateString('en-CA')}.pdf`);
    UIFeedback.success('PDF exported.', 'Export complete');
    } catch (error) {
        console.error('PDF export failed:', error);
        UIFeedback.error('The PDF could not be exported. Please try again.', 'Export failed');
    }
}

function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return { week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7), year: d.getUTCFullYear() };
}

function toLocalIsoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function showReportError(message) {
    const emptyState = document.getElementById('emptyState');
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent = message;
    UIFeedback.error(message, 'Report failed');
}
