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
    document.getElementById('reportFrom').value = monday.toLocaleDateString('en-CA');
    document.getElementById('reportTo').value   = today.toLocaleDateString('en-CA');
});

async function generateReport() {
    const type = document.getElementById('reportType').value;
    const from = document.getElementById('reportFrom').value;
    const to   = document.getElementById('reportTo').value;
    currentReportType = type;

    if (!from || !to) { showToast('Please select a date range.'); return; }
    if (from > to)    { showToast('Date From must be before Date To.'); return; }

    document.getElementById('emptyState').style.display   = 'none';
    document.getElementById('chartPanel').style.display   = 'none';
    document.getElementById('tablePanel').style.display   = 'none';

    try {
        const { data: logs, error } = await supabaseClient
            .from('entry_exit_logs')
            .select(`
                log_type, scan_method, log_date, log_timestamp,
                students ( stud_id, first_name, last_name, grade_level, section_name )
            `)
            .gte('log_date', from)
            .lte('log_date', to)
            .order('log_date', { ascending: true });

        if (error) throw error;

        if (!logs || logs.length === 0) {
            document.getElementById('emptyState').style.display = 'block';
            document.getElementById('emptyState').querySelector('p').textContent = 'No data found for selected range.';
            showToast('No records found.'); return;
        }

        switch (type) {
            case 'daily':   buildDailyReport(logs, from, to);   break;
            case 'weekly':  buildWeeklyReport(logs, from, to);  break;
            case 'student': buildStudentReport(logs);            break;
            case 'grade':   buildGradeReport(logs);              break;
        }
    } catch (e) {
        console.error('[reports] generateReport error:', e);
        showToast('Error generating report.');
    }
}

/* ── Daily: entries & exits per day ── */
function buildDailyReport(logs, from, to) {
    const days = {};
    // Populate all days in range
    const cur = new Date(from);
    const end = new Date(to);
    while (cur <= end) {
        const d = cur.toLocaleDateString('en-CA');
        days[d] = { entries: 0, exits: 0 };
        cur.setDate(cur.getDate() + 1);
    }
    logs.forEach(l => {
        if (!days[l.log_date]) days[l.log_date] = { entries: 0, exits: 0 };
        if (l.log_type === 'entry') days[l.log_date].entries++;
        else                        days[l.log_date].exits++;
    });

    reportData = Object.entries(days).map(([date, v]) => ({ date, ...v }));

    // Chart
    renderChart(
        reportData.map(r => r.date),
        [
            { label: 'Entries', data: reportData.map(r => r.entries), backgroundColor: 'rgba(16,185,129,.7)', borderColor: '#059669', borderWidth: 2 },
            { label: 'Exits',   data: reportData.map(r => r.exits),   backgroundColor: 'rgba(239,68,68,.6)',  borderColor: '#dc2626', borderWidth: 2 }
        ],
        'Daily Entry-Exit Count'
    );

    // Table
    renderTable(
        ['Date', 'Entries', 'Exits', 'Total'],
        reportData.map(r => [r.date, r.entries, r.exits, r.entries + r.exits]),
        'Daily Summary'
    );
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
        const key = s.stud_id || 'unknown';
        if (!students[key]) students[key] = {
            stud_id: s.stud_id, name: `${s.last_name}, ${s.first_name}`,
            grade: s.grade_level, section: s.section_name,
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
        const g = l.students?.grade_level || 'Unknown';
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
    if (!reportData || reportData.length === 0) { showToast('Generate a report first.'); return; }
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
        headers = ['Date','Entries','Exits','Total'];
        rows = reportData.map(r => [r.date, r.entries, r.exits, r.entries + r.exits]);
    }
    const csv  = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `report_${type}_${new Date().toLocaleDateString('en-CA')}.csv`;
    a.click(); URL.revokeObjectURL(url);
    showToast('CSV exported!');
}

function exportPDF() {
    if (!reportData || reportData.length === 0) { showToast('Generate a report first.'); return; }
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
        head = [['Date','Entries','Exits','Total']];
        body = reportData.map(r => [r.date, r.entries, r.exits, r.entries + r.exits]);
    }

    doc.autoTable({ head, body, startY: 38, styles: { fontSize: 9 }, headStyles: { fillColor: [11,78,120] } });
    doc.save(`report_${type}_${new Date().toLocaleDateString('en-CA')}.pdf`);
    showToast('PDF exported!');
}

function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return { week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7), year: d.getUTCFullYear() };
}

function showToast(msg) {
    const t = document.getElementById('toast');
    const m = document.getElementById('toastMsg');
    if (!t || !m) return;
    m.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}