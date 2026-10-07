'use strict';

let gateAnalyticsRange = null;
let gateAnalyticsSource = [];
let gateAnalyticsExport = null;
let gateAnalyticsChart = null;
let gateAnalyticsRequest = 0;
let gateAnalyticsQuality = { invalid: 0, future: 0 };
let gateAnalyticsView = null;
let gateActiveTab = 'weekday';

document.addEventListener('DOMContentLoaded', () => {
    const type = document.getElementById('reportType');
    type.addEventListener('change', () => {
        gateAnalyticsRequest++;
        gateResetDisplay();
        const analytics = type.value === 'analytics';
        document.getElementById('analyticsFilters').hidden = !analytics;
        if (analytics) generateGateAnalyticsReport();
    });
    for (const id of ['personTypeFilter', 'gradeFilter', 'sectionFilter', 'actionFilter', 'methodFilter']) {
        document.getElementById(id).addEventListener('change', () => {
            if (id === 'personTypeFilter') {
                const employeeOnly = document.getElementById(id).value === 'employee';
                if (employeeOnly) {
                    document.getElementById('gradeFilter').value = '';
                    document.getElementById('sectionFilter').value = '';
                }
                document.getElementById('gradeFilter').disabled = employeeOnly;
                document.getElementById('sectionFilter').disabled = employeeOnly;
            }
            if (id === 'gradeFilter') populateGateSections();
            if (gateAnalyticsRange === gateSelectedRange()) renderGateAnalytics();
        });
    }
    document.getElementById('resetAnalyticsFilters').addEventListener('click', () => {
        for (const id of ['personTypeFilter', 'gradeFilter', 'sectionFilter', 'actionFilter', 'methodFilter']) {
            document.getElementById(id).value = '';
        }
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
        gateAnalyticsRange = null;
        gateResetDisplay();
        const from = document.getElementById('reportFrom').value;
        const to = document.getElementById('reportTo').value;
        if (type.value === 'analytics' && from && to && to >= from) generateGateAnalyticsReport();
    });
    for (const tab of ['weekday', 'time', 'trends']) {
        document.getElementById(`gate${gateTabName(tab)}Tab`).addEventListener('click', () => gateSelectTab(tab));
    }
    // reports.js initializes the default Manila date range before this listener.
    if (type.value === 'analytics') generateGateAnalyticsReport();
});

function gateSelectedRange() {
    return `${document.getElementById('reportFrom').value}|${document.getElementById('reportTo').value}`;
}
function gateResetDisplay() {
    document.getElementById('reportLoading').hidden = true;
    document.getElementById('gateAnalyticsPanel').hidden = true;
    document.getElementById('analyticsPanel').style.display = 'none';
    document.getElementById('chartPanel').style.display = 'none';
    document.getElementById('tablePanel').style.display = 'none';
    document.getElementById('emptyState').style.display = 'block';
    gateAnalyticsExport = null;
    gateAnalyticsView = null;
    reportData = [];
    gateDestroyCharts();
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
}
function gateTabName(tab) { return tab === 'weekday' ? 'Weekday' : tab === 'time' ? 'Time' : 'Trends'; }
function gateSelectTab(tab) {
    gateActiveTab = tab;
    for (const name of ['weekday', 'time', 'trends']) {
        const selected = name === tab;
        const button = document.getElementById(`gate${gateTabName(name)}Tab`);
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
        document.getElementById(`gate${gateTabName(name)}Panel`).hidden = !selected;
    }
    if (gateAnalyticsView) renderGateChart();
}
function gateText(id, value) { document.getElementById(id).textContent = value; }
function gateEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function gateNumber(value) { return Number(value).toLocaleString('en-PH', { maximumFractionDigits: 1 }); }
function setGateOptions(id, first, options) {
    const select = document.getElementById(id);
    const old = select.value;
    select.replaceChildren(new Option(first, ''));
    for (const option of options) select.add(new Option(option.label, option.value));
    if (options.some(option => String(option.value) === old)) select.value = old;
}
function populateGateFilters() {
    const grades = [...new Set(gateAnalyticsSource.map(row => row.grade).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    setGateOptions('gradeFilter', 'All Grades', grades.map(grade => ({ value: grade, label: grade })));
    populateGateSections();
}
function populateGateSections() {
    const grade = document.getElementById('gradeFilter').value;
    const sections = new Map();
    for (const row of gateAnalyticsSource) {
        if (row.sectionId && (!grade || row.grade === grade)) {
            sections.set(String(row.sectionId), `${row.grade} · ${row.section}`);
        }
    }
    setGateOptions('sectionFilter', 'All Sections', [...sections]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })));
}
async function generateGateAnalyticsReport() {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    if (!from) return UIFeedback.fieldError(document.getElementById('reportFrom'), 'Start date is required.');
    if (!to || to < from) return UIFeedback.fieldError(document.getElementById('reportTo'), 'End date must be on or after the start date.');
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        return UIFeedback.error('The database connection is unavailable.', 'Analytics unavailable');
    }
    const request = ++gateAnalyticsRequest;
    gateAnalyticsRange = null;
    gateAnalyticsExport = null;
    document.getElementById('reportLoading').hidden = false;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gateAnalyticsPanel').hidden = true;
    try {
        const raw = await GateAnalytics.fetchLogs(supabaseClient, { from, to });
        if (request !== gateAnalyticsRequest) return;
        const normalized = GateAnalytics.normalize(raw);
        gateAnalyticsSource = normalized.rows;
        gateAnalyticsQuality = { invalid: normalized.invalid, future: normalized.future };
        gateAnalyticsRange = gateSelectedRange();
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
    const rows = GateAnalytics.filterRows(gateAnalyticsSource, gateFilterValues());
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const view = GateAnalytics.studentActivity(rows, { from, to });
    gateAnalyticsView = view;
    gateAnalyticsExport = view.daily;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('gateAnalyticsPanel').hidden = false;
    gateText('gatePeriod', `Selected period: ${from} to ${to} · Manila time`);
    gateText('gateBusiestDay', view.reliable ? view.busiest.day : 'Not enough data');
    gateText('gateBusiestExplanation', view.reliable
        ? `${view.busiest.day} has the highest average student arrivals across observed school days.`
        : 'More recorded school days are needed for a reliable comparison.');
    gateText('gateAverageDaily', view.averageDailyStudents === null ? '—' : gateNumber(view.averageDailyStudents));
    gateText('gateAverageExplanation', view.observedDates
        ? `Unique students per date across ${view.observedDates} observed arrival ${view.observedDates === 1 ? 'date' : 'dates'}.`
        : 'No recorded student arrivals match these filters.');
    gateText('gatePeakArrival', view.peakArrival?.label || '—');
    gateText('gatePeakArrivalExplanation', view.peakArrival
        ? `${gateNumber(view.peakArrival.arrivals)} first arrivals in this 30-minute period.` : 'No student Entry records match these filters.');
    gateText('gatePeakExit', view.peakExit?.label || '—');
    gateText('gatePeakExitExplanation', view.peakExit
        ? `${gateNumber(view.peakExit.departures)} last exits in this 30-minute period.` : 'No student Exit records match these filters.');
    gateText('gateWeekdayExplanation', gateWeekdayExplanation(view));
    gateText('gateTimeExplanation', gateTimeExplanation(view));
    gateText('gateTrendExplanation', gateTrendExplanation(view));
    gateText('gateTransactionNote', `${gateNumber(view.entryScans)} student Entry scans and ${gateNumber(view.exitScans)} student Exit scans. These are gate transactions, not unique students; repeat scans are included.`);
    const filters = gateFilterValues();
    const filterNote = filters.personType === 'employee'
        ? 'This view measures students; choose Students or All People to see student activity.'
        : filters.action === 'exit' ? 'Arrival measures need Entry records; choose Entry and Exit or Entry to see them.'
            : filters.method ? 'Arrival and exit times use the first and last records matching the selected scan method.' : '';
    gateText('gateAnalyticsNote', `${filterNote} ${gateAnalyticsQuality.invalid} invalid or unidentified records and ${gateAnalyticsQuality.future} future-dated records were excluded. Grade and section filters use students’ current records, not a historical snapshot.`.trim());
    gateTable('gateWeekdayBody', view.weekdays, day => `<td>${day.rank ? `#${day.rank}` : '—'}</td><td>${gateEscape(day.day)}${day === view.busiest && day.average !== null ? ' <span class="gate-busiest-tag">Highest observed</span>' : ''}</td><td>${day.average === null ? 'No arrivals' : gateNumber(day.average)}</td><td>${day.observedDates}</td><td>${day.totalUniqueArrivals}</td><td>${day.differencePercent === null ? '—' : `${day.differencePercent > 0 ? '+' : ''}${gateNumber(day.differencePercent)}%`}</td>`, 6);
    gateTable('gateDailyBody', view.daily, day => `<td>${gateEscape(day.date)}</td><td>${day.uniqueArrivals}</td><td>${day.entryScans}</td><td>${day.exitScans}</td>`, 4);
    renderGateChart();
}
function gateWeekdayExplanation(view) {
    if (!view.busiest) return 'There is not enough Entry & Exit data yet to identify a busiest school day.';
    if (!view.reliable) return `${view.busiest.day} has the highest observed average (${gateNumber(view.busiest.average)} unique student arrivals). Based on ${view.busiest.observedDates} observed ${view.busiest.day}${view.busiest.observedDates === 1 ? '' : 's'}, there is not enough data across all five school weekdays to identify a reliable busiest day. Only dates with recorded arrivals are included.`;
    const difference = view.busiest.differencePercent;
    const comparison = Math.abs(difference) < .5 ? 'close to the weekday average' :
        `${gateNumber(Math.abs(difference))}% ${difference > 0 ? 'higher' : 'lower'} than the weekday average`;
    return `${view.busiest.day} is the busiest school day. Based on ${view.busiest.observedDates} observed ${view.busiest.day}s, an average of ${gateNumber(view.busiest.average)} unique students entered school. This is ${comparison}. ${view.leastActive.day} had the lowest observed average at ${gateNumber(view.leastActive.average)} students.`;
}
function gateTimeExplanation(view) {
    if (!view.peakArrival && !view.peakExit) return 'There are no student Entry or Exit times to compare for these filters.';
    const arrival = view.peakArrival ? `The busiest arrival period is ${view.peakArrival.label}, with ${gateNumber(view.peakArrival.arrivals)} first arrivals.` : 'No student arrivals were recorded.';
    const exit = view.peakExit ? `The busiest exit period is ${view.peakExit.label}, with ${gateNumber(view.peakExit.departures)} last exits.` : 'No student exits were recorded.';
    return `${arrival} ${exit}`;
}
function gateTrendExplanation(view) {
    if (!view.observedDates) return 'No observed dates contain a student arrival for these filters.';
    return `${gateNumber(view.totalUniqueArrivals)} daily unique student arrivals were recorded across ${view.observedDates} observed ${view.observedDates === 1 ? 'date' : 'dates'}. The average was ${gateNumber(view.averageDailyStudents)} students per observed date. A student can be counted once on each different date they entered.`;
}
function gateTable(id, rows, cells, span) {
    document.getElementById(id).innerHTML = rows.length ? rows.slice(0, 100).map(row => `<tr>${cells(row)}</tr>`).join('') +
        (rows.length > 100 ? `<tr><td colspan="${span}" class="gate-empty-cell">Showing the first 100 of ${rows.length} observed dates.</td></tr>` : '') :
        `<tr><td colspan="${span}" class="gate-empty-cell">No matching student records.</td></tr>`;
}
function gateDestroyCharts() { if (gateAnalyticsChart) gateAnalyticsChart.destroy(); gateAnalyticsChart = null; }
function gateChart(canvasId, emptyId, hasData, config) {
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    canvas.hidden = !hasData;
    empty.hidden = hasData;
    if (hasData && window.Chart) gateAnalyticsChart = new window.Chart(canvas, config);
    else if (hasData) { canvas.hidden = true; empty.textContent = 'The chart library is unavailable.'; empty.hidden = false; }
}
function gateTrendRows(view) {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    const grouping = days <= 45 ? 'daily' : days <= 180 ? 'weekly' : 'monthly';
    const groups = new Map();
    for (const date of view.daily.filter(row => row.uniqueArrivals > 0)) {
        const key = grouping === 'daily' ? date.date : grouping === 'weekly' ? gateWeekStart(date.date) : date.date.slice(0, 7);
        if (!groups.has(key)) groups.set(key, { label: key, count: 0 });
        groups.get(key).count += date.uniqueArrivals;
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function gateWeekStart(day) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
}
function renderGateChart() {
    gateDestroyCharts();
    const view = gateAnalyticsView;
    if (!view) return;
    if (gateActiveTab === 'weekday') {
        document.querySelector('.gate-weekday-chart').style.height = `${Math.max(280, view.weekdays.length * 48 + 70)}px`;
        gateChart('gateWeekdayChart', 'gateWeekdayEmpty', view.ranked.length > 0, {
            type: 'bar', data: { labels: view.weekdays.map(row => row.day), datasets: [{
                label: 'Average unique student arrivals per observed date',
                data: view.weekdays.map(row => row.average),
                backgroundColor: view.weekdays.map(row => row === view.busiest ? '#0b4e78' : '#6baed6'),
                borderRadius: 5, maxBarThickness: 28
            }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, indexAxis: 'y',
                scales: { x: { beginAtZero: true, title: { display: true, text: 'Average students per observed date' } } },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label(context) {
                    const row = view.weekdays[context.dataIndex];
                    return `${gateNumber(row.average)} unique students on average; ${row.observedDates} observed ${row.observedDates === 1 ? 'date' : 'dates'}; ${row.totalUniqueArrivals} daily unique arrivals total`;
                } } } } }
        });
    } else if (gateActiveTab === 'time') {
        const used = view.buckets.filter(row => row.arrivals || row.departures);
        const buckets = used.length ? view.buckets.slice(Math.max(0, used[0].bucket - 1), Math.min(48, used[used.length - 1].bucket + 2)) : [];
        gateChart('gateTimeChart', 'gateTimeEmpty', buckets.length > 0, { type: 'bar',
            data: { labels: buckets.map(row => row.label), datasets: [
                { label: 'First student arrivals', data: buckets.map(row => row.arrivals), backgroundColor: '#16916e' },
                { label: 'Last student exits', data: buckets.map(row => row.departures), backgroundColor: '#d45d60' }
            ] }, options: { responsive: true, maintainAspectRatio: false, animation: false,
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxRotation: 45, minRotation: 45, autoSkip: true } } },
                plugins: { tooltip: { callbacks: { label(context) { return `${context.dataset.label}: ${context.parsed.y} students`; } } } } } });
    } else {
        const trend = gateTrendRows(view);
        gateChart('gateTrendChart', 'gateTrendEmpty', trend.length > 0, { type: 'line',
            data: { labels: trend.map(row => row.label), datasets: [{ label: 'Sum of daily unique student arrivals',
                data: trend.map(row => row.count), borderColor: '#0b4e78', backgroundColor: '#2f8fce', tension: .2 }] },
            options: { responsive: true, maintainAspectRatio: false, animation: false,
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                plugins: { tooltip: { callbacks: { label(context) { return `${context.parsed.y} daily unique student arrivals`; } } } } } });
    }
}
function exportGateAnalyticsCSV() {
    if (!gateAnalyticsExport?.length) return UIFeedback.toast({ type: 'info', message: 'Generate student analytics first.' });
    const rows = [['Date', 'Unique Student Arrivals', 'Entry Scans', 'Exit Scans'],
        ...gateAnalyticsExport.map(row => [row.date, row.uniqueArrivals, row.entryScans, row.exitScans])];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'student_gate_analytics_daily.csv'; link.click(); URL.revokeObjectURL(url);
    UIFeedback.success('Filtered daily student analytics exported to CSV.');
}
function exportGateAnalyticsPDF() {
    if (!gateAnalyticsExport?.length) return UIFeedback.toast({ type: 'info', message: 'Generate student analytics first.' });
    try {
        if (!window.jspdf?.jsPDF) throw new Error('PDF library unavailable');
        const pdf = new window.jspdf.jsPDF();
        pdf.text('Student Entry & Exit Analytics', 14, 18);
        pdf.setFontSize(9);
        pdf.text(`Date range: ${document.getElementById('reportFrom').value} to ${document.getElementById('reportTo').value}`, 14, 25);
        pdf.autoTable({ startY: 31, head: [['Date', 'Unique Student Arrivals', 'Entry Scans', 'Exit Scans']],
            body: gateAnalyticsExport.map(row => [row.date, row.uniqueArrivals, row.entryScans, row.exitScans]) });
        pdf.save('student_gate_analytics_daily.pdf');
        UIFeedback.success('Filtered daily student analytics exported to PDF.');
    } catch (error) {
        console.error('[gate analytics] PDF export failed:', error);
        UIFeedback.error('Could not export student analytics to PDF.');
    }
}
