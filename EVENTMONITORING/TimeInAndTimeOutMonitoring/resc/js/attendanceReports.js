/* ============================================================
   resc/js/attendanceReports.js
   Combined Lab/Class + Event Attendance Reporting
============================================================ */

'use strict';

let activeTab = 'lab';           // 'lab' | 'event'
let allLabRows = [];
let allEventRows = [];
let filteredRows = [];
let statusChart = null;
let breakdownChart = null;

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialised. Check config/.env.js');
        return;
    }
    bindEvents();
    await Promise.all([loadLabAttendance(), loadEventAttendance()]);
    renderActiveTab();
});

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt)) return '—';
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(t) {
    if (!t) return '—';
    const dt = new Date(t);
    if (isNaN(dt)) return '—';
    return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.toggle('error', isError);
    toast.classList.add('on');
    setTimeout(() => toast.classList.remove('on'), 2800);
}

function statusBadge(status) {
    const s = (status || 'present').toLowerCase();
    const map = { present: 'status-present', late: 'status-late', absent: 'status-absent', excused: 'status-excused' };
    const cls = map[s] || 'status-present';
    return `<span class="status-badge ${cls}">${escapeHtml(s)}</span>`;
}

/* ══════════════════════════════════════════════════════════
   DATA LOADING
══════════════════════════════════════════════════════════ */

async function loadLabAttendance() {
    try {
        const { data, error } = await supabaseClient
            .from('lab_attendance')
            .select(`
                attendance_id, time_in, time_out, time_in_status, late_minutes, duration_minutes,
                students ( student_id, id_number, first_name, last_name, course, year_level, section ),
                lab_sessions (
                    session_id, session_date,
                    lab_schedules (
                        schedule_id, section,
                        subjects ( subject_code, subject_name ),
                        professors ( first_name, last_name )
                    )
                )
            `)
            .order('time_in', { ascending: false });

        if (error) throw error;

        allLabRows = (data || [])
            .filter(d => d.students)
            .map(d => {
                const st = d.students || {};
                const sess = d.lab_sessions || {};
                const sch = (sess && sess.lab_schedules) || {};
                const subj = sch.subjects || {};
                const prof = sch.professors || {};
                const status = d.time_in_status || (d.late_minutes > 0 ? 'late' : 'present');

                return {
                    id: d.attendance_id,
                    name: `${st.first_name || ''} ${st.last_name || ''}`.trim(),
                    id_number: st.id_number || '—',
                    course: st.course || '—',
                    section: st.section || sch.section || '—',
                    subject: subj.subject_code ? `${subj.subject_code} - ${subj.subject_name || ''}` : '—',
                    professor: prof.first_name ? `${prof.first_name} ${prof.last_name || ''}` : '—',
                    date: sess.session_date || d.time_in,
                    time_in: d.time_in,
                    time_out: d.time_out,
                    late_minutes: d.late_minutes || 0,
                    status: status,
                };
            });
    } catch (err) {
        console.error('loadLabAttendance error:', err);
        showToast('Failed to load lab attendance: ' + (err.message || err), true);
    }
}

async function loadEventAttendance() {
    try {
        const [attRes, eventsRes] = await Promise.all([
            supabaseClient
                .from('event_attendance')
                .select('*, students(student_id, first_name, last_name, id_number, lrn, course, section), teachers(teacher_id, first_name, last_name, employee_id)')
                .order('created_at', { ascending: false }),
            supabaseClient
                .from('events')
                .select('event_id, event_name, event_date'),
        ]);

        if (attRes.error) throw attRes.error;
        if (eventsRes.error) throw eventsRes.error;

        const eventsMap = {};
        (eventsRes.data || []).forEach(ev => { eventsMap[ev.event_id] = ev; });

        allEventRows = (attRes.data || []).map(r => {
            const person = r.students || r.teachers;
            const role = r.students ? 'Student' : 'Teacher';
            const idNum = r.students ? (person && (person.id_number || person.lrn)) : (person && person.employee_id);
            const ev = eventsMap[r.event_id] || {};

            return {
                id: r.attendance_id,
                name: person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : 'Unknown',
                role: role,
                id_number: idNum || '—',
                event: ev.event_name || '—',
                date: ev.event_date || r.created_at,
                time_in: r.time_in,
                time_out: r.time_out,
                status: r.status || 'present',
            };
        });
    } catch (err) {
        console.error('loadEventAttendance error:', err);
        showToast('Failed to load event attendance: ' + (err.message || err), true);
    }
}

/* ══════════════════════════════════════════════════════════
   TABS
══════════════════════════════════════════════════════════ */

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.report-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('labFilterOnly').style.display = tab === 'lab' ? '' : 'none';
    document.getElementById('eventFilterOnly').style.display = tab === 'event' ? '' : 'none';
    const lbl = document.getElementById('breakdownLabel');
    if (lbl) lbl.textContent = tab === 'lab' ? 'Subject' : 'Event';
    resetFilters();
}

/* ══════════════════════════════════════════════════════════
   FILTERING
══════════════════════════════════════════════════════════ */

function bindEvents() {
    document.querySelectorAll('.report-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    ['filterSearch', 'filterStatus', 'filterFrom', 'filterTo', 'filterCourse', 'filterEvent'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', renderActiveTab);
        if (el) el.addEventListener('change', renderActiveTab);
    });

    const resetBtn = document.getElementById('btnResetFilters');
    if (resetBtn) resetBtn.addEventListener('click', resetFilters);

    const pdfBtn = document.getElementById('btnExportPdf');
    if (pdfBtn) pdfBtn.addEventListener('click', exportPdf);

    const excelBtn = document.getElementById('btnExportExcel');
    if (excelBtn) excelBtn.addEventListener('click', exportExcel);
}

function resetFilters() {
    ['filterSearch', 'filterFrom', 'filterTo', 'filterCourse', 'filterEvent'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const statusEl = document.getElementById('filterStatus');
    if (statusEl) statusEl.value = '';
    renderActiveTab();
}

function applyFilters(rows) {
    const search = (document.getElementById('filterSearch')?.value || '').toLowerCase().trim();
    const status = document.getElementById('filterStatus')?.value || '';
    const from = document.getElementById('filterFrom')?.value || '';
    const to = document.getElementById('filterTo')?.value || '';
    const course = (document.getElementById('filterCourse')?.value || '').toLowerCase().trim();
    const eventName = (document.getElementById('filterEvent')?.value || '').toLowerCase().trim();

    return rows.filter(r => {
        if (search && !(`${r.name} ${r.id_number}`.toLowerCase().includes(search))) return false;
        if (status && (r.status || '').toLowerCase() !== status) return false;
        if (from && r.date && new Date(r.date) < new Date(from)) return false;
        if (to && r.date && new Date(r.date) > new Date(to + 'T23:59:59')) return false;
        if (activeTab === 'lab' && course && !((r.course || '').toLowerCase().includes(course))) return false;
        if (activeTab === 'event' && eventName && !((r.event || '').toLowerCase().includes(eventName))) return false;
        return true;
    });
}

/* ══════════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════════ */

function renderActiveTab() {
    const source = activeTab === 'lab' ? allLabRows : allEventRows;
    filteredRows = applyFilters(source);
    renderStats(filteredRows);
    renderTable(filteredRows);
    renderCharts(filteredRows);
}

function renderStats(rows) {
    const total = rows.length;
    const present = rows.filter(r => (r.status || '').toLowerCase() === 'present').length;
    const late = rows.filter(r => (r.status || '').toLowerCase() === 'late').length;
    const absent = rows.filter(r => ['absent', 'excused'].includes((r.status || '').toLowerCase())).length;

    document.getElementById('statTotal').textContent = total;
    document.getElementById('statPresent').textContent = present;
    document.getElementById('statLate').textContent = late;
    document.getElementById('statAbsent').textContent = absent;
}

function renderTable(rows) {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    if (activeTab === 'lab') {
        thead.innerHTML = `
            <tr>
                <th>Student</th><th>ID Number</th><th>Course / Section</th>
                <th>Subject</th><th>Date</th><th>Time In</th><th>Time Out</th>
                <th>Late (min)</th><th>Status</th>
            </tr>`;
    } else {
        thead.innerHTML = `
            <tr>
                <th>Name</th><th>Role</th><th>ID Number</th><th>Event</th>
                <th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th>
            </tr>`;
    }

    if (!rows.length) {
        const colspan = activeTab === 'lab' ? 9 : 8;
        tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state"><i class="fa-solid fa-file-circle-question"></i><p>No attendance records found.</p></td></tr>`;
        document.getElementById('recordCountDisplay').textContent = '0';
        return;
    }

    if (activeTab === 'lab') {
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td><span class="mono">${escapeHtml(r.name)}</span></td>
                <td>${escapeHtml(r.id_number)}</td>
                <td>${escapeHtml(r.course)} - ${escapeHtml(r.section)}</td>
                <td>${escapeHtml(r.subject)}</td>
                <td>${formatDate(r.date)}</td>
                <td>${formatTime(r.time_in)}</td>
                <td>${formatTime(r.time_out)}</td>
                <td>${r.late_minutes || 0}</td>
                <td>${statusBadge(r.status)}</td>
            </tr>`).join('');
    } else {
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td><span class="mono">${escapeHtml(r.name)}</span></td>
                <td>${escapeHtml(r.role)}</td>
                <td>${escapeHtml(r.id_number)}</td>
                <td>${escapeHtml(r.event)}</td>
                <td>${formatDate(r.date)}</td>
                <td>${formatTime(r.time_in)}</td>
                <td>${formatTime(r.time_out)}</td>
                <td>${statusBadge(r.status)}</td>
            </tr>`).join('');
    }

    document.getElementById('recordCountDisplay').textContent = rows.length;
}

/* ══════════════════════════════════════════════════════════
   CHARTS
══════════════════════════════════════════════════════════ */

function renderCharts(rows) {
    renderStatusChart(rows);
    renderBreakdownChart(rows);
}

function renderStatusChart(rows) {
    const counts = { present: 0, late: 0, absent: 0, excused: 0 };
    rows.forEach(r => {
        const s = (r.status || 'present').toLowerCase();
        if (counts[s] !== undefined) counts[s]++;
    });

    const ctx = document.getElementById('statusChart');
    if (!ctx) return;
    if (statusChart) statusChart.destroy();

    statusChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Present', 'Late', 'Absent', 'Excused'],
            datasets: [{
                data: [counts.present, counts.late, counts.absent, counts.excused],
                backgroundColor: ['#40916c', '#d97706', '#dc2626', '#2563eb'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11.5, family: 'Nunito Sans' } } } },
        },
    });
}

function renderBreakdownChart(rows) {
    const groupKey = activeTab === 'lab' ? 'subject' : 'event';
    const counts = {};
    rows.forEach(r => {
        const key = r[groupKey] || 'Unspecified';
        counts[key] = (counts[key] || 0) + 1;
    });

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    const ctx = document.getElementById('breakdownChart');
    if (!ctx) return;
    if (breakdownChart) breakdownChart.destroy();

    breakdownChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: entries.map(e => e[0]),
            datasets: [{
                label: 'Records',
                data: entries.map(e => e[1]),
                backgroundColor: '#2d6a4f',
                borderRadius: 6,
                maxBarThickness: 36,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { font: { size: 11, family: 'Nunito Sans' } }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { precision: 0, font: { size: 11, family: 'Nunito Sans' } } },
            },
        },
    });
}

/* ══════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════ */

function exportExcel() {
    if (!filteredRows.length) { showToast('No records to export.', true); return; }

    const rows = activeTab === 'lab'
        ? filteredRows.map(r => ({
            'Student': r.name, 'ID Number': r.id_number, 'Course': r.course, 'Section': r.section,
            'Subject': r.subject, 'Date': formatDate(r.date), 'Time In': formatTime(r.time_in),
            'Time Out': formatTime(r.time_out), 'Late (min)': r.late_minutes, 'Status': r.status,
        }))
        : filteredRows.map(r => ({
            'Name': r.name, 'Role': r.role, 'ID Number': r.id_number, 'Event': r.event,
            'Date': formatDate(r.date), 'Time In': formatTime(r.time_in), 'Time Out': formatTime(r.time_out),
            'Status': r.status,
        }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, activeTab === 'lab' ? 'Lab Attendance' : 'Event Attendance');
    const fname = `attendance-report-${activeTab}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    showToast('Excel report exported.');
}

function exportPdf() {
    if (!filteredRows.length) { showToast('No records to export.', true); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });

    doc.setFontSize(16);
    doc.text(activeTab === 'lab' ? 'Lab / Class Attendance Report' : 'Event Attendance Report', 14, 16);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 22);

    const head = activeTab === 'lab'
        ? [['Student', 'ID Number', 'Course/Section', 'Subject', 'Date', 'Time In', 'Time Out', 'Late (min)', 'Status']]
        : [['Name', 'Role', 'ID Number', 'Event', 'Date', 'Time In', 'Time Out', 'Status']];

    const body = activeTab === 'lab'
        ? filteredRows.map(r => [r.name, r.id_number, `${r.course} - ${r.section}`, r.subject, formatDate(r.date), formatTime(r.time_in), formatTime(r.time_out), r.late_minutes, r.status])
        : filteredRows.map(r => [r.name, r.role, r.id_number, r.event, formatDate(r.date), formatTime(r.time_in), formatTime(r.time_out), r.status]);

    doc.autoTable({
        head, body, startY: 28, styles: { fontSize: 8 },
        headStyles: { fillColor: [26, 71, 49] },
    });

    const fname = `attendance-report-${activeTab}-${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fname);
    showToast('PDF report exported.');
}