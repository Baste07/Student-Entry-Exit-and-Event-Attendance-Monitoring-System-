'use strict';

let dashboardRawLogs = [];
let dashboardCharts = {};
let dashboardLoading = false;

document.addEventListener('DOMContentLoaded', () => {
    if (document.body?.dataset.gateDashboardVersion !== '20260925d') {
        reloadGatePage('gate_dashboard_version', '20260925d');
        return;
    }
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        showDashboardFailure('The database connection is unavailable.');
        return;
    }
    refreshDashboard(true);
    window.setInterval(() => refreshDashboard(false), 60000);
});

function reloadGatePage(parameter, version) {
    const url = new URL(window.location.href);
    if (url.searchParams.get(parameter) === version) {
        document.body.insertAdjacentHTML('afterbegin', '<p role="alert" style="padding:16px;background:#fff2f2;color:#991b1b">The old dashboard is cached. Reload this tab with Ctrl+Shift+R.</p>');
        return;
    }
    url.searchParams.set(parameter, version);
    sessionStorage.setItem('allowed_admin_route', url.pathname);
    window.location.replace(url.href);
}

function dashboardText(id, value) { document.getElementById(id).textContent = value; }
function dashboardEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function dashboardPersonDetail(row) {
    return row.type === 'student' ? [row.grade, row.section].filter(Boolean).join(' · ') || 'Unassigned' : [row.role, row.faculty].filter(Boolean).join(' · ') || 'Employee';
}
function dashboardMethod(method) { return ({ face: 'Face', qr: 'QR', manual: 'Manual' })[method] || method || 'Unknown'; }
function showDashboardFailure(message) {
    const status = document.getElementById('dashboardStatus');
    status.textContent = message;
    status.classList.add('error');
    UIFeedback.error(message, 'Gate dashboard unavailable');
}

async function refreshDashboard(initial) {
    if (dashboardLoading) return;
    dashboardLoading = true;
    try {
        const previousIds = new Set(dashboardRawLogs.map(row => row.id));
        const since = !initial && dashboardRawLogs.length ? dashboardRawLogs[dashboardRawLogs.length - 1].log_timestamp : null;
        const fresh = await GateAnalytics.fetchLogs(supabaseClient, since ? { since } : {});
        dashboardRawLogs.push(...fresh.filter(row => !previousIds.has(row.id)));
        dashboardRawLogs.sort((a, b) => new Date(a.log_timestamp) - new Date(b.log_timestamp) || new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id)));
        const normalized = GateAnalytics.normalize(dashboardRawLogs);
        const all = GateAnalytics.summary(normalized.rows);
        const todayDate = GateAnalytics.manilaDate();
        const today = GateAnalytics.summary(GateAnalytics.filterRows(normalized.rows, { from: todayDate, to: todayDate }));
        renderDashboard(all, today, normalized);
        const status = document.getElementById('dashboardStatus');
        status.textContent = `Updated ${new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })} · Records are refreshed every minute.`;
        status.classList.remove('error');
        const { count, error } = await supabaseClient.from('students').select('*', { count: 'exact', head: true });
        if (!error) dashboardText('statTotalStudents', count ?? 0);
    } catch (error) {
        console.error('[gate dashboard] load failed:', error);
        showDashboardFailure('Could not load gate analytics. Please refresh and try again.');
    } finally { dashboardLoading = false; }
}

function renderDashboard(all, today, normalized) {
    dashboardText('statEnteredToday', today.entries.toLocaleString());
    dashboardText('statExitedToday', today.exits.toLocaleString());
    dashboardText('statUniqueToday', today.uniquePeople.toLocaleString());
    dashboardText('statInside', all.inside.length.toLocaleString());
    dashboardText('statStudentsInside', all.studentsInside.toLocaleString());
    dashboardText('statEmployeesInside', all.employeesInside.toLocaleString());
    dashboardText('statPeakEntry', today.peakEntry ? GateAnalytics.hourLabel(today.peakEntry.hour) : '—');
    dashboardText('statPeakExit', today.peakExit ? GateAnalytics.hourLabel(today.peakExit.hour) : '—');
    dashboardText('peakEntryCount', today.peakEntry ? `${today.peakEntry.entries} recorded entries` : 'No entries today');
    dashboardText('peakExitCount', today.peakExit ? `${today.peakExit.exits} recorded exits` : 'No exits today');
    dashboardText('insideCount', all.inside.length);
    dashboardText('unclosedCount', all.visits.unclosed.length);
    dashboardText('qualityNote', `${all.visits.unpairedExits} Exit records without an earlier Entry; ${all.visits.repeatedEntries} repeated Entry sequences; ${normalized.invalid} invalid or unidentified records; ${normalized.future} future-dated records omitted.`);
    dashboardText('dashboardTypeNote', `Today's recorded actions: ${today.types.student.uniquePeople} unique students and ${today.types.employee.uniquePeople} unique employees.`);
    dashboardRows('insideBody', all.inside, row => `<td><strong>${dashboardEscape(row.name)}</strong></td><td>${dashboardEscape(row.type)}</td><td>${dashboardEscape(dashboardPersonDetail(row))}</td><td>${dashboardEscape(GateAnalytics.displayTime(row.timestamp))}</td><td>${GateAnalytics.durationLabel(Math.max(0, all.now - row.timestamp))}</td>`, 5);
    dashboardRows('unclosedBody', [...all.visits.unclosed].sort((a, b) => b.entry.timestamp - a.entry.timestamp), visit => `<td><strong>${dashboardEscape(visit.entry.name)}</strong></td><td>${dashboardEscape(visit.entry.type)}</td><td>${dashboardEscape(GateAnalytics.displayTime(visit.entry.timestamp))}</td><td>${GateAnalytics.durationLabel(Math.max(0, all.now - visit.entry.timestamp))}</td><td>${dashboardEscape(visit.reason)}</td>`, 5);
    dashboardRows('recentLogsBody', normalized.rows.slice(-20).reverse(), row => `<td><strong>${dashboardEscape(row.name)}</strong></td><td>${dashboardEscape(row.identifier || '—')}</td><td>${dashboardEscape(dashboardPersonDetail(row))}</td><td><span class="badge badge-${row.action}">${dashboardEscape(row.action)}</span></td><td>${dashboardEscape(dashboardMethod(row.method))}</td><td>${dashboardEscape(GateAnalytics.displayTime(row.timestamp))}</td>`, 6);
    renderDashboardChart('hourly', 'hourlyChart', 'hourlyEmpty', today.entries + today.exits > 0, {
        type: 'bar', data: { labels: today.hours.map(row => GateAnalytics.hourLabel(row.hour)), datasets: [
            { label: 'Entries', data: today.hours.map(row => row.entries), backgroundColor: '#16916e' },
            { label: 'Exits', data: today.hours.map(row => row.exits), backgroundColor: '#d45d60' }
        ] }, options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
    renderDashboardChart('type', 'typeChart', 'typeEmpty', today.entries + today.exits > 0, {
        type: 'bar', data: { labels: ['Students', 'Employees'], datasets: [
            { label: 'Entries', data: [today.types.student.entries, today.types.employee.entries], backgroundColor: '#16916e' },
            { label: 'Exits', data: [today.types.student.exits, today.types.employee.exits], backgroundColor: '#d45d60' }
        ] }, options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
}

function dashboardRows(id, rows, cells, columns) {
    document.getElementById(id).innerHTML = rows.length ? rows.slice(0, 100).map(row => `<tr>${cells(row)}</tr>`).join('') + (rows.length > 100 ? `<tr><td colspan="${columns}" class="loading-cell">Showing the first 100 of ${rows.length} records.</td></tr>` : '') : `<tr><td colspan="${columns}" class="loading-cell">No records to show.</td></tr>`;
}
function renderDashboardChart(key, canvasId, emptyId, hasData, config) {
    dashboardCharts[key]?.destroy();
    delete dashboardCharts[key];
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    canvas.hidden = !hasData;
    empty.hidden = hasData;
    if (hasData && window.Chart) dashboardCharts[key] = new window.Chart(canvas, config);
    else if (hasData) { canvas.hidden = true; empty.textContent = 'The chart library is unavailable.'; empty.hidden = false; }
}
