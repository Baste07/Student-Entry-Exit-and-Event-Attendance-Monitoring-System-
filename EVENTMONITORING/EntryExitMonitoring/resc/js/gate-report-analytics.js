'use strict';

let gateAnalyticsRange = null;
let gateAnalyticsSource = [];
let gateAnalyticsExport = null;
let gateAnalyticsCharts = {};
let gateAnalyticsRequest = 0;
let gateAnalyticsQuality = { invalid: 0, future: 0 };

document.addEventListener('DOMContentLoaded', () => {
    const type = document.getElementById('reportType');
    type.addEventListener('change', () => {
        gateAnalyticsRequest++;
        document.getElementById('reportLoading').hidden = true;
        const analytics = type.value === 'analytics';
        document.getElementById('analyticsFilters').hidden = !analytics;
        document.getElementById('gateAnalyticsPanel').hidden = true;
        document.getElementById('analyticsPanel').style.display = 'none';
        document.getElementById('chartPanel').style.display = 'none';
        document.getElementById('tablePanel').style.display = 'none';
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('emptyState').querySelector('p').textContent = 'Choose a date range, then click Generate.';
        gateAnalyticsExport = null;
        gateAnalyticsRange = null;
        reportData = [];
        gateDestroyCharts();
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    });
    for (const id of ['personTypeFilter', 'gradeFilter', 'sectionFilter', 'actionFilter', 'methodFilter']) {
        document.getElementById(id).addEventListener('change', () => {
            if (id === 'personTypeFilter') {
                const employeeOnly = document.getElementById('personTypeFilter').value === 'employee';
                if (employeeOnly) {
                    document.getElementById('gradeFilter').value = '';
                    document.getElementById('sectionFilter').value = '';
                }
                document.getElementById('gradeFilter').disabled = employeeOnly;
                document.getElementById('sectionFilter').disabled = employeeOnly;
            }
            if (id === 'gradeFilter') populateGateSections();
            if (gateAnalyticsRange === `${document.getElementById('reportFrom').value}|${document.getElementById('reportTo').value}`) renderGateAnalytics();
        });
    }
    document.getElementById('resetAnalyticsFilters').addEventListener('click', () => {
        for (const id of ['personTypeFilter', 'gradeFilter', 'sectionFilter', 'actionFilter', 'methodFilter']) document.getElementById(id).value = '';
        document.getElementById('gradeFilter').disabled = false;
        document.getElementById('sectionFilter').disabled = false;
        populateGateSections();
        const today = GateAnalytics.manilaDate();
        const monday = new Date(`${today}T00:00:00Z`);
        monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
        document.getElementById('reportFrom').value = monday.toISOString().slice(0, 10);
        document.getElementById('reportTo').value = today;
        generateGateAnalyticsReport();
    });
    for (const id of ['reportFrom', 'reportTo']) document.getElementById(id).addEventListener('change', () => {
        gateAnalyticsRequest++;
        document.getElementById('reportLoading').hidden = true;
        gateAnalyticsExport = null;
        gateAnalyticsRange = null;
        reportData = [];
        document.getElementById('gateAnalyticsPanel').hidden = true;
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('emptyState').querySelector('p').textContent = 'Date range changed. Click Generate to load the selected period.';
    });
});

function gateText(id, text) { document.getElementById(id).textContent = text; }
function gateEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function gateDetail(row) {
    return row.type === 'student' ? [row.grade, row.section].filter(Boolean).join(' · ') || 'Unassigned' : [row.role, row.faculty].filter(Boolean).join(' · ') || 'Employee';
}
function setGateOptions(id, first, options) {
    const select = document.getElementById(id);
    const old = select.value;
    select.replaceChildren(new Option(first, ''));
    for (const option of options) select.add(new Option(option.label, option.value));
    if (options.some(option => String(option.value) === old)) select.value = old;
}
function populateGateFilters() {
    const grades = [...new Set(gateAnalyticsSource.map(row => row.grade).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    setGateOptions('gradeFilter', 'All Grades', grades.map(grade => ({ value: grade, label: grade })));
    populateGateSections();
}
function populateGateSections() {
    const grade = document.getElementById('gradeFilter').value;
    const sections = new Map();
    for (const row of gateAnalyticsSource) {
        if (row.sectionId && (!grade || row.grade === grade)) sections.set(String(row.sectionId), `${row.grade} · ${row.section}`);
    }
    setGateOptions('sectionFilter', 'All Sections', [...sections].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })));
}

async function generateGateAnalyticsReport() {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    if (!from) return UIFeedback.fieldError(document.getElementById('reportFrom'), 'Start date is required.');
    if (!to || to < from) return UIFeedback.fieldError(document.getElementById('reportTo'), 'End date must be on or after the start date.');
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return UIFeedback.error('The database connection is unavailable.', 'Analytics unavailable');
    const key = `${from}|${to}`;
    const request = ++gateAnalyticsRequest;
    gateAnalyticsRange = null;
    gateAnalyticsExport = null;
    document.getElementById('reportLoading').hidden = false;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gateAnalyticsPanel').hidden = true;
    document.getElementById('analyticsPanel').style.display = 'none';
    document.getElementById('chartPanel').style.display = 'none';
    document.getElementById('tablePanel').style.display = 'none';
    try {
        const raw = await GateAnalytics.fetchLogs(supabaseClient, { from, to });
        if (request !== gateAnalyticsRequest) return;
        const normalized = GateAnalytics.normalize(raw);
        gateAnalyticsSource = normalized.rows;
        gateAnalyticsQuality = { invalid: normalized.invalid, future: normalized.future };
        gateAnalyticsRange = key;
        populateGateFilters();
        renderGateAnalytics();
    } catch (error) {
        if (request !== gateAnalyticsRequest) return;
        console.error('[gate analytics] load failed:', error);
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('emptyState').querySelector('p').textContent = 'Unable to load gate analytics. Please try again.';
        UIFeedback.error('Unable to load gate analytics. Please try again.', 'Analytics unavailable');
    } finally {
        if (request === gateAnalyticsRequest) document.getElementById('reportLoading').hidden = true;
    }
}
function gateFilterValues() {
    return {
        personType: document.getElementById('personTypeFilter').value,
        grade: document.getElementById('gradeFilter').value,
        section: document.getElementById('sectionFilter').value,
        action: document.getElementById('actionFilter').value,
        method: document.getElementById('methodFilter').value
    };
}
function renderGateAnalytics() {
    if (document.getElementById('reportType').value !== 'analytics') return;
    const filters = gateFilterValues();
    const rows = GateAnalytics.filterRows(gateAnalyticsSource, filters);
    gateDestroyCharts();
    gateAnalyticsExport = null;
    if (!rows.length) {
        document.getElementById('gateAnalyticsPanel').hidden = true;
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('emptyState').querySelector('p').textContent = 'No gate activity matches these filters.';
        return;
    }
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gateAnalyticsPanel').hidden = false;
    const view = GateAnalytics.summary(rows);
    const pairable = !filters.action && !filters.method;
    gateText('gateEntries', view.entries.toLocaleString());
    gateText('gateExits', view.exits.toLocaleString());
    gateText('gateUnique', view.uniquePeople.toLocaleString());
    gateText('gateUnclosed', pairable ? view.visits.unclosed.length : 'N/A');
    gateText('gatePeakEntry', view.peakEntry ? GateAnalytics.hourLabel(view.peakEntry.hour) : '—');
    gateText('gatePeakExit', view.peakExit ? GateAnalytics.hourLabel(view.peakExit.hour) : '—');
    gateText('gatePeakEntryCount', view.peakEntry ? `${view.peakEntry.entries} entries` : 'No entries');
    gateText('gatePeakExitCount', view.peakExit ? `${view.peakExit.exits} exits` : 'No exits');
    gateText('gateAverageStay', pairable ? GateAnalytics.durationLabel(view.averageStayMs) : 'N/A');
    gateText('gateMedianStay', pairable ? GateAnalytics.durationLabel(view.medianStayMs) : 'N/A');
    gateText('gateTypeDescription', `Recorded actions by person type: ${view.types.student.uniquePeople} unique students and ${view.types.employee.uniquePeople} unique employees.`);
    const quality = pairable ? `${view.visits.unpairedExits} unpaired Exit records and ${view.visits.repeatedEntries} repeated Entry sequences in the selected range.` : 'Visit pairing is unavailable when filtering to one action or scan method.';
    const busiest = view.dates.reduce((best, day) => day.entries + day.exits > (best?.entries || 0) + (best?.exits || 0) ? day : best, null);
    gateText('gateAnalyticsNote', `${quality} ${busiest ? `Busiest date: ${busiest.date} with ${busiest.entries + busiest.exits} recorded actions.` : ''} Visits may cross the selected date boundaries. Unified lateness is omitted because face scans record is_late=false regardless of arrival time. ${gateAnalyticsQuality.invalid} invalid or unidentified records and ${gateAnalyticsQuality.future} future-dated records were excluded.`);
    gateText('gateUnclosedCount', pairable ? view.visits.unclosed.length : 'N/A');
    gateTable('gateUnclosedBody', pairable ? [...view.visits.unclosed].sort((a, b) => b.entry.timestamp - a.entry.timestamp) : [], visit => `<td>${gateEscape(visit.entry.name)}</td><td>${gateEscape(visit.entry.type)}</td><td>${gateEscape(gateDetail(visit.entry))}</td><td>${gateEscape(GateAnalytics.displayTime(visit.entry.timestamp))}</td><td>${gateEscape(visit.reason)}</td>`, 5);
    gateTable('gateStayBody', pairable ? [...view.visits.completed].sort((a, b) => b.durationMs - a.durationMs) : [], visit => `<td>${gateEscape(visit.entry.name)}</td><td>${gateEscape(visit.entry.type)}</td><td>${gateEscape(GateAnalytics.displayTime(visit.entry.timestamp))}</td><td>${gateEscape(GateAnalytics.displayTime(visit.exit.timestamp))}</td><td>${GateAnalytics.durationLabel(visit.durationMs)}</td>`, 5);
    gateTable('gateDailyBody', view.dates, day => `<td>${day.date}</td><td>${day.entries}</td><td>${day.exits}</td><td>${day.uniquePeople}</td>`, 4);
    gateAnalyticsExport = view.dates.map(day => ({ date: day.date, entries: day.entries, exits: day.exits, uniquePeople: day.uniquePeople }));
    renderGateCharts(view, pairable);
}

function gateTable(id, rows, cells, span) {
    document.getElementById(id).innerHTML = rows.length ? rows.slice(0, 100).map(row => `<tr>${cells(row)}</tr>`).join('') + (rows.length > 100 ? `<tr><td colspan="${span}" class="gate-empty-cell">Showing the first 100 of ${rows.length} records. Narrow the filters to see more.</td></tr>` : '') : `<tr><td colspan="${span}" class="gate-empty-cell">No matching records.</td></tr>`;
}
function gateDestroyCharts() { Object.values(gateAnalyticsCharts).forEach(chart => chart.destroy()); gateAnalyticsCharts = {}; }
function gateChart(key, canvasId, emptyId, hasData, config) {
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    canvas.hidden = !hasData;
    empty.hidden = hasData;
    if (hasData && window.Chart) gateAnalyticsCharts[key] = new window.Chart(canvas, config);
    else if (hasData) { canvas.hidden = true; empty.textContent = 'The chart library is unavailable.'; empty.hidden = false; }
}
function gateBarOptions(horizontal = false) {
    return { responsive: true, maintainAspectRatio: false, animation: false, indexAxis: horizontal ? 'y' : 'x', scales: { [horizontal ? 'x' : 'y']: { beginAtZero: true, ticks: { precision: 0 } } } };
}
function gateTrendRows(view) {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    const grouping = days <= 45 ? 'daily' : days <= 180 ? 'weekly' : 'monthly';
    const grouped = new Map();
    for (const day of view.dates) {
        const key = grouping === 'daily' ? day.date : grouping === 'weekly' ? gateWeekKey(day.date) : day.date.slice(0, 7);
        if (!grouped.has(key)) grouped.set(key, { label: key, entries: 0, exits: 0 });
        grouped.get(key).entries += day.entries;
        grouped.get(key).exits += day.exits;
    }
    if (grouping === 'daily') {
        const date = new Date(`${from}T00:00:00Z`);
        while (date.toISOString().slice(0, 10) <= to) {
            const key = date.toISOString().slice(0, 10);
            if (!grouped.has(key)) grouped.set(key, { label: key, entries: 0, exits: 0 });
            date.setUTCDate(date.getUTCDate() + 1);
        }
    }
    return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function gateWeekKey(day) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const year = date.getUTCFullYear();
    const first = new Date(Date.UTC(year, 0, 1));
    return `${year}-W${String(Math.ceil((((date - first) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}
function renderGateCharts(view, pairable) {
    const trend = gateTrendRows(view);
    gateChart('trend', 'gateTrendChart', 'gateTrendEmpty', trend.length > 0, { type: 'line', data: { labels: trend.map(row => row.label), datasets: [
        { label: 'Entries', data: trend.map(row => row.entries), borderColor: '#16916e', backgroundColor: '#16916e', tension: .2 },
        { label: 'Exits', data: trend.map(row => row.exits), borderColor: '#d45d60', backgroundColor: '#d45d60', tension: .2 }
    ] }, options: gateBarOptions() });
    const usedHours = view.hours.filter(row => row.entries || row.exits);
    const hours = usedHours.length ? view.hours.slice(Math.max(0, usedHours[0].hour - 1), Math.min(24, usedHours[usedHours.length - 1].hour + 2)) : [];
    gateChart('hourly', 'gateHourlyChart', 'gateHourlyEmpty', hours.length > 0, { type: 'bar', data: { labels: hours.map(row => GateAnalytics.hourLabel(row.hour)), datasets: [
        { label: 'Entries', data: hours.map(row => row.entries), backgroundColor: '#16916e' },
        { label: 'Exits', data: hours.map(row => row.exits), backgroundColor: '#d45d60' }
    ] }, options: gateBarOptions() });
    gateChart('type', 'gateTypeChart', 'gateTypeEmpty', view.entries + view.exits > 0, { type: 'bar', data: { labels: ['Students', 'Employees'], datasets: [
        { label: 'Entries', data: [view.types.student.entries, view.types.employee.entries], backgroundColor: '#16916e' },
        { label: 'Exits', data: [view.types.student.exits, view.types.employee.exits], backgroundColor: '#d45d60' }
    ] }, options: gateBarOptions() });
    const sections = view.sections.filter(row => row.grade || row.section);
    document.getElementById('gateSectionChart').parentElement.style.height = `${Math.max(290, Math.min(1000, sections.length * 34 + 80))}px`;
    gateChart('section', 'gateSectionChart', 'gateSectionEmpty', sections.length > 0, { type: 'bar', data: { labels: sections.map(row => `${row.grade} · ${row.section}`), datasets: [
        { label: 'Unique Students', data: sections.map(row => row.uniquePeople), backgroundColor: '#2f8fce' },
        { label: 'Entries', data: sections.map(row => row.entries), backgroundColor: '#16916e' },
        { label: 'Exits', data: sections.map(row => row.exits), backgroundColor: '#d45d60' }
    ] }, options: gateBarOptions(true) });
    gateChart('weekday', 'gateWeekdayChart', 'gateWeekdayEmpty', view.entries + view.exits > 0, { type: 'bar', data: { labels: view.weekdays.map(row => row.day), datasets: [
        { label: 'Entries', data: view.weekdays.map(row => row.entries), backgroundColor: '#16916e' },
        { label: 'Exits', data: view.weekdays.map(row => row.exits), backgroundColor: '#d45d60' }
    ] }, options: gateBarOptions() });
    const methodCounts = new Map(view.methods.map(row => [row.method, row.count]));
    const methodNames = ['face', 'qr', 'manual', ...[...methodCounts.keys()].filter(method => !['face', 'qr', 'manual'].includes(method))];
    gateChart('method', 'gateMethodChart', 'gateMethodEmpty', view.methods.length > 0, { type: 'doughnut', data: { labels: methodNames.map(method => ({ face: 'Face', qr: 'QR', manual: 'Manual' })[method] || method), datasets: [{ data: methodNames.map(method => methodCounts.get(method) || 0), backgroundColor: ['#2f8fce', '#16a085', '#e5a54b', '#94a3b8'] }] }, options: { responsive: true, maintainAspectRatio: false, animation: false } });
    gateChart('stay', 'gateStayChart', 'gateStayEmpty', pairable && view.visits.completed.length > 0, { type: 'bar', data: { labels: ['<1h', '1–3h', '3–6h', '6–9h', '9–12h', '12h+'], datasets: [{ label: 'Completed visits', data: view.durationBuckets, backgroundColor: '#2f8fce' }] }, options: gateBarOptions() });
}

function exportGateAnalyticsCSV() {
    if (!gateAnalyticsExport?.length) return UIFeedback.toast({ type: 'info', message: 'Generate gate analytics first.' });
    try {
        const rows = [['Date', 'Entries', 'Exits', 'Unique People'], ...gateAnalyticsExport.map(row => [row.date, row.entries, row.exits, row.uniquePeople])];
        const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'gate_analytics_daily.csv'; link.click(); URL.revokeObjectURL(url);
        UIFeedback.success('Filtered daily gate analytics exported to CSV.');
    } catch (error) {
        console.error('[gate analytics] CSV export failed:', error);
        UIFeedback.error('Could not export gate analytics to CSV.');
    }
}
function exportGateAnalyticsPDF() {
    if (!gateAnalyticsExport?.length) return UIFeedback.toast({ type: 'info', message: 'Generate gate analytics first.' });
    try {
        if (!window.jspdf?.jsPDF) throw new Error('PDF library unavailable');
        const pdf = new window.jspdf.jsPDF();
        pdf.text('Gate Analytics - Daily Summary', 14, 18);
        pdf.setFontSize(9);
        pdf.text(`Date range: ${document.getElementById('reportFrom').value} to ${document.getElementById('reportTo').value}`, 14, 25);
        pdf.autoTable({ startY: 31, head: [['Date', 'Entries', 'Exits', 'Unique People']], body: gateAnalyticsExport.map(row => [row.date, row.entries, row.exits, row.uniquePeople]) });
        pdf.save('gate_analytics_daily.pdf');
        UIFeedback.success('Filtered daily gate analytics exported to PDF.');
    } catch (error) {
        console.error('[gate analytics] PDF export failed:', error);
        UIFeedback.error('Could not export gate analytics to PDF.');
    }
}
