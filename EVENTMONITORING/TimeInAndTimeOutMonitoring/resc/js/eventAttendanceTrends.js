'use strict';

// The scanner and manual attendance flows both use a 15-minute grace period.
// Event dates/times are school-local (Asia/Manila); attendance timestamps are timestamptz.
const EVENT_LATE_GRACE_MINUTES = 15;
const PAGE_SIZE = 500;
const EVENT_CHUNK_SIZE = 80;
const DETAIL_LIMIT = 200;
const MANILA_TIME_ZONE = 'Asia/Manila';
const ANALYTICS_PAGE_VERSION = '20260925c';
const state = {
    events: [], participants: [], attendance: [], charts: {}, loadedRange: null,
    view: null, detailTab: 'late', requestId: 0
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    if (!ensureCurrentPage()) return;
    const from = document.getElementById('trendDateFrom');
    from.value = defaultFromDate();
    document.getElementById('trendDateTo').value = manilaDate();
    document.getElementById('btnApplyTrends').addEventListener('click', loadRange);
    document.getElementById('btnResetTrends').addEventListener('click', resetFilters);
    document.getElementById('trendEventType').addEventListener('change', populateEventOptions);
    document.getElementById('trendStatus').addEventListener('change', populateEventOptions);
    document.getElementById('trendGrade').addEventListener('change', populateSectionOptions);
    document.getElementById('btnExportExcel').addEventListener('click', exportExcel);
    document.getElementById('btnExportPdf').addEventListener('click', exportPdf);
    document.getElementById('detailSearch').addEventListener('input', renderDetails);
    document.querySelectorAll('.detail-tab').forEach(button => button.addEventListener('click', () => {
        state.detailTab = button.dataset.detail;
        document.querySelectorAll('.detail-tab').forEach(tab => {
            const selected = tab === button;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
        });
        renderDetails();
    }));
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return showFailure('The database connection is unavailable.');
    loadRange();
});

// A browser may keep the previous HTML while fetching this updated script. Request
// the current document once, then stop rather than throwing on missing controls.
function ensureCurrentPage() {
    if (document.body?.dataset.eventAnalyticsVersion === ANALYTICS_PAGE_VERSION) return true;
    const url = new URL(window.location.href);
    if (url.searchParams.get('analytics_version') !== ANALYTICS_PAGE_VERSION) {
        url.searchParams.set('analytics_version', ANALYTICS_PAGE_VERSION);
        sessionStorage.setItem('allowed_admin_route', url.pathname);
        window.location.replace(url.href);
    } else {
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.style.cssText = 'margin:16px;padding:16px;border:1px solid #f3b4b4;border-radius:8px;background:#fff5f5;color:#9b1c1c';
        message.textContent = 'The previous analytics page is still cached. Reload this tab with Ctrl+Shift+R to see the current dashboard.';
        (document.querySelector('.container') || document.body).prepend(message);
    }
    return false;
}

function field(id) { return document.getElementById(id); }
function value(id) { return field(id).value; }
function setText(id, text) { field(id).textContent = text; }
function escapeHtml(input) {
    return String(input ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function manilaDate(timestamp = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: MANILA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
    const get = part => parts.find(item => item.type === part).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function defaultFromDate() {
    const today = manilaDate().split('-').map(Number);
    const date = new Date(Date.UTC(today[0] - 1, today[1] - 1, today[2]));
    return date.toISOString().slice(0, 10);
}
function displayDate(iso) {
    return iso ? new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: MANILA_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}
function displayTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-PH', { timeZone: MANILA_TIME_ZONE, hour: 'numeric', minute: '2-digit' });
}
function displayClock(clock) {
    if (!clock) return '—';
    const [hours, minutes] = clock.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '—';
    return new Date(Date.UTC(2020, 0, 1, hours, minutes)).toLocaleTimeString('en-PH', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
}
function percentage(numerator, denominator) { return denominator ? numerator / denominator * 100 : 0; }
function percentLabel(number) { return `${number.toFixed(1)}%`; }
function rosterKey(eventId, studentId) { return `${eventId}:${studentId}`; }
function validTimestamp(timestamp) {
    const milliseconds = timestamp ? new Date(timestamp).getTime() : NaN;
    return Number.isFinite(milliseconds) ? milliseconds : null;
}
function eventStartMs(event) {
    if (!event?.event_date || !event?.time_start) return null;
    const milliseconds = new Date(`${event.event_date}T${event.time_start}+08:00`).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
}
function lateInfo(attendance, event) {
    if (!attendance?.timeIn) return { late: false, minutes: null, relativeMinutes: null };
    const start = eventStartMs(event);
    const checkIn = validTimestamp(attendance.timeIn);
    if (start !== null && checkIn !== null) {
        const relativeMinutes = (checkIn - start) / 60000;
        const late = relativeMinutes > EVENT_LATE_GRACE_MINUTES;
        return { late, minutes: late ? Math.floor(relativeMinutes) : 0, relativeMinutes };
    }
    const remarks = String(attendance.remarks || '');
    const match = remarks.match(/late by\s+(\d+)\s+min/i);
    if (match) return { late: true, minutes: Number(match[1]), relativeMinutes: null };
    return { late: /late/i.test(remarks), minutes: null, relativeMinutes: null };
}
function studentName(student) {
    return [student?.first_name, student?.middle_name, student?.last_name].filter(Boolean).join(' ') || 'Unknown student';
}
function sectionInfo(student) {
    const section = student?.sections;
    return { grade: section?.grade_level || '', name: section?.section_name || '', id: student?.section_id || '' };
}

// A record represents one expected student-event assignment. Attendance outside the
// roster and employee attendance are intentionally excluded from participation rates.
function normalizeAnalytics(events, participants, attendance, filters = {}) {
    const eventById = new Map(events.map(event => [String(event.event_id), event]));
    const allRosterKeys = new Set();
    const roster = new Map();
    let duplicateParticipants = 0;
    for (const participant of participants) {
        const event = eventById.get(String(participant.event_id));
        if (!event || !participant.student_id) continue;
        const key = rosterKey(event.event_id, participant.student_id);
        if (allRosterKeys.has(key)) duplicateParticipants++;
        allRosterKeys.add(key);
        const student = participant.students || null;
        const section = sectionInfo(student);
        if (filters.grade && section.grade !== filters.grade) continue;
        if (filters.section && String(section.id) !== String(filters.section)) continue;
        if (!roster.has(key)) roster.set(key, { key, event, student, section, attendance: null });
    }

    const attendanceByKey = new Map();
    let duplicateAttendance = 0;
    for (const row of attendance) {
        if (!row.student_id || !eventById.has(String(row.event_id))) continue;
        const key = rosterKey(row.event_id, row.student_id);
        if (attendanceByKey.has(key)) duplicateAttendance++;
        const previous = attendanceByKey.get(key) || { timeIn: null, timeOut: null, remarks: '' };
        const incoming = validTimestamp(row.time_in);
        const current = validTimestamp(previous.timeIn);
        if (incoming !== null && (current === null || incoming < current)) {
            previous.timeIn = row.time_in;
            previous.remarks = row.remarks || '';
        }
        const outgoing = validTimestamp(row.time_out);
        const priorOut = validTimestamp(previous.timeOut);
        if (outgoing !== null && (priorOut === null || outgoing > priorOut)) previous.timeOut = row.time_out;
        attendanceByKey.set(key, previous);
    }

    let outsideRoster = 0;
    for (const [key, record] of attendanceByKey) {
        if (record.timeIn && !allRosterKeys.has(key)) outsideRoster++;
    }
    for (const [key, record] of roster) {
        const matching = attendanceByKey.get(key);
        record.attendance = matching?.timeIn ? matching : null;
        if (record.attendance && validTimestamp(record.attendance.timeOut) !== null && validTimestamp(record.attendance.timeOut) < validTimestamp(record.attendance.timeIn)) {
            record.attendance = { ...record.attendance, timeOut: null };
        }
    }
    return { records: [...roster.values()], duplicateParticipants, duplicateAttendance, outsideRoster };
}

function summarizeAnalytics(events, normalized) {
    const eventRows = events.map(event => ({
        event, expected: 0, attended: 0, onTime: 0, late: 0, noShows: 0,
        pending: 0, timedOut: 0, missingTimeOut: 0
    }));
    const byEvent = new Map(eventRows.map(row => [String(row.event.event_id), row]));
    const sections = new Map();
    const details = { late: [], noShow: [], missing: [] };
    const lateMinuteValues = [];
    const arrivals = [0, 0, 0, 0, 0, 0];
    let unscheduledArrivals = 0;
    for (const record of normalized.records) {
        const group = byEvent.get(String(record.event.event_id));
        const attended = Boolean(record.attendance?.timeIn);
        const timedOut = attended && Boolean(record.attendance.timeOut);
        const late = attended ? lateInfo(record.attendance, record.event) : null;
        const completedEvent = record.event.status === 'completed';
        group.expected++;
        if (attended) {
            group.attended++;
            if (late.late) {
                group.late++;
                details.late.push({ ...record, lateMinutes: late.minutes });
                if (Number.isFinite(late.minutes)) lateMinuteValues.push(late.minutes);
            } else group.onTime++;
            if (timedOut) group.timedOut++;
            else {
                group.missingTimeOut++;
                if (completedEvent) details.missing.push(record);
            }
            if (late.relativeMinutes === null) unscheduledArrivals++;
            else if (late.relativeMinutes < -30) arrivals[0]++;
            else if (late.relativeMinutes < -15) arrivals[1]++;
            else if (late.relativeMinutes < 0) arrivals[2]++;
            else if (late.relativeMinutes <= 15) arrivals[3]++;
            else if (late.relativeMinutes <= 30) arrivals[4]++;
            else arrivals[5]++;
        } else if (completedEvent) {
            group.noShows++;
            details.noShow.push(record);
        } else group.pending++;

        const sectionKey = record.section.id || '__unassigned__';
        if (!sections.has(sectionKey)) sections.set(sectionKey, { label: record.section.grade ? `${record.section.grade} · ${record.section.name || 'Section'}` : 'Unassigned', expected: 0, attended: 0 });
        const section = sections.get(sectionKey);
        section.expected++;
        if (attended) section.attended++;
    }
    const totals = eventRows.reduce((result, row) => {
        for (const metric of ['expected', 'attended', 'onTime', 'late', 'noShows', 'pending', 'timedOut', 'missingTimeOut']) result[metric] += row[metric];
        return result;
    }, { expected: 0, attended: 0, onTime: 0, late: 0, noShows: 0, pending: 0, timedOut: 0, missingTimeOut: 0 });
    totals.attendanceRate = percentage(totals.attended, totals.expected);
    totals.noShowRate = percentage(totals.noShows, totals.expected);
    totals.onTimeRate = percentage(totals.onTime, totals.attended);
    totals.lateRate = percentage(totals.late, totals.attended);
    totals.completionRate = percentage(totals.timedOut, totals.attended);
    totals.averageLateMinutes = lateMinuteValues.length ? lateMinuteValues.reduce((a, b) => a + b, 0) / lateMinuteValues.length : null;
    return { eventRows, sectionRows: [...sections.values()], details, totals, arrivals, unscheduledArrivals, ...normalized };
}

function weekKey(day) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const year = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    return `${year}-W${String(Math.ceil((((date - yearStart) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}
function trendPoints(eventRows, grouping) {
    if (grouping === 'event') return eventRows.map(row => ({
        label: `${displayDate(row.event.event_date)} · ${row.event.event_name || 'Unnamed event'}`,
        expected: row.expected, attended: row.attended,
        rate: row.expected ? percentage(row.attended, row.expected) : null
    }));
    const periods = new Map();
    for (const row of eventRows) {
        const day = row.event.event_date;
        const key = grouping === 'weekly' ? weekKey(day) : grouping === 'monthly' ? day.slice(0, 7) : day;
        if (!periods.has(key)) periods.set(key, { label: key, expected: 0, attended: 0 });
        const period = periods.get(key);
        period.expected += row.expected;
        period.attended += row.attended;
    }
    return [...periods.values()].sort((a, b) => a.label.localeCompare(b.label)).map(period => ({ ...period, rate: period.expected ? percentage(period.attended, period.expected) : null }));
}

async function fetchPages(queryForPage) {
    const result = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await queryForPage(offset).range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        result.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
    }
    return result;
}
async function fetchForEvents(table, columns, eventIds, orderColumn) {
    const rows = [];
    for (let index = 0; index < eventIds.length; index += EVENT_CHUNK_SIZE) {
        const ids = eventIds.slice(index, index + EVENT_CHUNK_SIZE);
        const chunk = await fetchPages(offset => supabaseClient.from(table).select(columns).in('event_id', ids).order(orderColumn, { ascending: true }));
        rows.push(...chunk);
    }
    return rows;
}
async function loadRange() {
    const from = value('trendDateFrom');
    const to = value('trendDateTo');
    if (from && to && from > to) {
        UIFeedback.fieldError(field('trendDateTo'), 'Date To must be on or after Date From.');
        return;
    }
    const rangeKey = `${from}|${to}`;
    if (state.loadedRange === rangeKey) return render();
    const request = ++state.requestId;
    field('trendLoading').hidden = false;
    field('trendError').hidden = true;
    field('btnApplyTrends').disabled = true;
    try {
        const events = await fetchPages(() => {
            let query = supabaseClient.from('events').select('event_id,event_name,event_date,end_date,time_start,time_end,event_type,status')
                .order('event_date', { ascending: true }).order('event_id', { ascending: true });
            if (from) query = query.gte('event_date', from);
            if (to) query = query.lte('event_date', to);
            return query;
        });
        const activeEvents = events.filter(event => event.status !== 'cancelled');
        const ids = activeEvents.map(event => event.event_id);
        const [participants, attendance] = ids.length ? await Promise.all([
            fetchForEvents('event_participants', 'event_id,student_id,participant_id,students(student_id,stud_id,first_name,middle_name,last_name,section_id,sections(section_id,grade_level,section_name))', ids, 'participant_id'),
            fetchForEvents('event_attendance', 'attendance_id,event_id,student_id,time_in,time_out,remarks', ids, 'attendance_id')
        ]) : [[], []];
        if (request !== state.requestId) return;
        Object.assign(state, { events: activeEvents, participants, attendance, loadedRange: rangeKey });
        populateFilters();
        render();
    } catch (error) {
        if (request !== state.requestId) return;
        console.error('[Event analytics] load failed:', error);
        showFailure('Unable to load event attendance analytics. Please try again.');
    } finally {
        if (request === state.requestId) {
            field('trendLoading').hidden = true;
            field('btnApplyTrends').disabled = false;
        }
    }
}

function setOptions(id, firstLabel, options) {
    const select = field(id);
    const old = select.value;
    select.replaceChildren(new Option(firstLabel, ''));
    for (const option of options) select.add(new Option(option.label, option.value));
    if (options.some(option => option.value === old)) select.value = old;
}
function populateFilters() {
    const types = [...new Set(state.events.map(event => event.event_type).filter(Boolean))].sort();
    setOptions('trendEventType', 'All Types', types.map(type => ({ value: type, label: type })));
    const grades = [...new Set(state.participants.map(row => sectionInfo(row.students).grade).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    setOptions('trendGrade', 'All Grades', grades.map(grade => ({ value: grade, label: grade })));
    populateSectionOptions();
    populateEventOptions();
}
function populateSectionOptions() {
    const grade = value('trendGrade');
    const sections = new Map();
    for (const row of state.participants) {
        const section = sectionInfo(row.students);
        if (section.id && (!grade || grade === section.grade)) sections.set(section.id, `${section.grade} · ${section.name}`);
    }
    setOptions('trendSection', 'All Sections', [...sections].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })));
}
function populateEventOptions() {
    const type = value('trendEventType');
    const status = value('trendStatus');
    const options = state.events.filter(event => (!type || event.event_type === type) && (!status || event.status === status))
        .map(event => ({ value: String(event.event_id), label: `${event.event_name || 'Unnamed event'} (${displayDate(event.event_date)})` }));
    setOptions('trendEvent', 'All Events', options);
}
function resetFilters() {
    ['trendEvent', 'trendGrade', 'trendSection', 'trendEventType', 'trendStatus'].forEach(id => { field(id).value = ''; });
    field('trendGrouping').value = 'event';
    field('trendDateFrom').value = defaultFromDate();
    field('trendDateTo').value = manilaDate();
    field('detailSearch').value = '';
    populateFilters();
    loadRange();
}
function selectedEvents() {
    const eventId = value('trendEvent');
    const type = value('trendEventType');
    const status = value('trendStatus');
    return state.events.filter(event => (!eventId || String(event.event_id) === eventId) && (!type || event.event_type === type) && (!status || event.status === status));
}
function render() {
    const events = selectedEvents();
    destroyCharts();
    field('trendError').hidden = true;
    field('trendEmpty').hidden = events.length > 0;
    field('trendResults').hidden = events.length === 0;
    field('btnExportExcel').disabled = events.length === 0;
    field('btnExportPdf').disabled = events.length === 0;
    if (!events.length) { state.view = null; return; }
    const eventIds = new Set(events.map(event => String(event.event_id)));
    const normalized = normalizeAnalytics(events, state.participants.filter(row => eventIds.has(String(row.event_id))), state.attendance.filter(row => eventIds.has(String(row.event_id))), {
        grade: value('trendGrade'), section: value('trendSection')
    });
    state.view = summarizeAnalytics(events, normalized);
    renderKpis(state.view);
    renderCharts(state.view);
    renderSummary(state.view);
    renderDetails();
}

function renderKpis(view) {
    const totals = view.totals;
    const ongoing = view.eventRows.some(row => row.event.status === 'ongoing');
    const selected = value('trendEvent');
    const event = selected ? view.eventRows.find(row => String(row.event.event_id) === selected)?.event : null;
    setText('viewTitle', event ? event.event_name || 'Unnamed event' : `${view.eventRows.length} event${view.eventRows.length === 1 ? '' : 's'} selected`);
    setText('viewSubtitle', event ? `${displayDate(event.event_date)} · ${event.status || 'Unknown status'}` : 'Student-event assignments are counted once per event.');
    setText('statExpected', totals.expected.toLocaleString());
    setText('statAttended', totals.attended.toLocaleString());
    setText('statAttendanceRate', percentLabel(totals.attendanceRate));
    setText('statNoShows', totals.noShows.toLocaleString());
    setText('statOnTime', totals.onTime.toLocaleString());
    setText('statLate', totals.late.toLocaleString());
    setText('statCompletion', percentLabel(totals.completionRate));
    setText('statAverageLate', totals.averageLateMinutes === null ? 'N/A' : `${totals.averageLateMinutes.toFixed(1)} min`);
    setText('attendanceRateNote', ongoing ? 'Attendance so far · attended ÷ expected' : 'Attended ÷ expected');
    setText('noShowNote', `${percentLabel(totals.noShowRate)} of expected · completed events only`);
    setText('onTimeRate', `${percentLabel(totals.onTimeRate)} of attendees`);
    setText('lateRate', `${percentLabel(totals.lateRate)} of attendees`);
    setText('completionLabel', ongoing ? 'Time-Out Completion So Far' : 'Time-Out Completion');
    setText('completionNote', `${totals.timedOut} timed out ÷ ${totals.attended} timed in`);

    const notes = [];
    if (!totals.expected) notes.push('No assigned participants match these filters.');
    if (totals.pending) notes.push(`${totals.pending} roster slot${totals.pending === 1 ? '' : 's'} in ongoing or upcoming events are awaiting check-in, not classified as no-shows.`);
    if (ongoing) notes.push('Time-Out completion for ongoing events is still in progress.');
    if (view.outsideRoster) notes.push(`${view.outsideRoster} recorded student check-in${view.outsideRoster === 1 ? '' : 's'} without a matching roster assignment are excluded from participation rates.`);
    if (view.duplicateParticipants || view.duplicateAttendance) notes.push(`Duplicate source rows were counted once (${view.duplicateParticipants} roster, ${view.duplicateAttendance} attendance).`);
    if (view.unscheduledArrivals) notes.push(`${view.unscheduledArrivals} arrival${view.unscheduledArrivals === 1 ? '' : 's'} without a usable scheduled start are omitted from the arrival chart.`);
    if (!notes.length) notes.push('No Show means an assigned student in a completed event with no Time-In. Missing Time-Out is counted separately.');
    setText('analyticsNote', notes.join(' '));
}

function destroyCharts() {
    Object.values(state.charts).forEach(chart => chart.destroy());
    state.charts = {};
}
function createChart(key, canvasId, emptyId, config, hasData) {
    const canvas = field(canvasId);
    const empty = field(emptyId);
    canvas.hidden = !hasData;
    empty.hidden = hasData;
    if (!hasData) return;
    if (!window.Chart) {
        canvas.hidden = true;
        empty.textContent = 'Charts are unavailable. Please check the Chart.js connection.';
        empty.hidden = false;
        return;
    }
    state.charts[key] = new window.Chart(canvas, config);
}
function rateChartOptions(horizontal, rows) {
    const scale = horizontal ? 'x' : 'y';
    return {
        responsive: true, maintainAspectRatio: false, animation: false,
        indexAxis: horizontal ? 'y' : 'x',
        plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label(context) {
                const row = rows[context.dataIndex];
                return ` ${percentLabel(row.rate || 0)} · ${row.attended} attended / ${row.expected} expected`;
            } } }
        },
        scales: {
            [scale]: { min: 0, max: 100, ticks: { callback: value => `${value}%` } },
            [horizontal ? 'y' : 'x']: { ticks: { autoSkip: !horizontal, maxRotation: horizontal ? 0 : 45 } }
        }
    };
}
function renderCharts(view) {
    const points = trendPoints(view.eventRows, value('trendGrouping'));
    createChart('trend', 'attendanceTrendChart', 'trendChartEmpty', {
        type: 'line', data: { labels: points.map(point => point.label), datasets: [{ label: 'Attendance rate', data: points.map(point => point.rate), borderColor: '#176aa4', backgroundColor: 'rgba(47,143,206,.14)', pointRadius: 4, fill: true, tension: .2, spanGaps: false }] },
        options: rateChartOptions(false, points)
    }, points.some(point => point.expected));

    const sectionRows = view.sectionRows.filter(row => row.expected).map(row => ({ ...row, rate: percentage(row.attended, row.expected) }))
        .sort((a, b) => b.rate - a.rate || a.label.localeCompare(b.label));
    createChart('section', 'sectionChart', 'sectionChartEmpty', {
        type: 'bar', data: { labels: sectionRows.map(row => row.label), datasets: [{ label: 'Attendance rate', data: sectionRows.map(row => row.rate), backgroundColor: '#22a6b8', borderRadius: 5 }] },
        options: rateChartOptions(true, sectionRows)
    }, sectionRows.length > 0);

    const totals = view.totals;
    const statusLabels = ['On Time', 'Late', 'No Show'];
    const statusValues = [totals.onTime, totals.late, totals.noShows];
    const statusColors = ['#059669', '#f59e0b', '#dc5b5b'];
    if (totals.pending) { statusLabels.push('Awaiting Check-In'); statusValues.push(totals.pending); statusColors.push('#87a9c0'); }
    createChart('status', 'statusChart', 'statusChartEmpty', {
        type: 'doughnut', data: { labels: statusLabels, datasets: [{ data: statusValues, backgroundColor: statusColors, borderWidth: 2, borderColor: '#fff' }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '58%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: context => ` ${context.label}: ${context.parsed} roster slots` } } } }
    }, totals.expected > 0);

    const arrivalLabels = ['>30 min early', '15–30 min early', '0–15 min early', '0–15 min after', '15–30 min after', '>30 min after'];
    createChart('arrival', 'arrivalChart', 'arrivalChartEmpty', {
        type: 'bar', data: { labels: arrivalLabels, datasets: [{ label: 'Arrivals', data: view.arrivals, backgroundColor: ['#30a7bd', '#30a7bd', '#30a7bd', '#2f8fce', '#e6a73f', '#e27758'], borderRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxRotation: 45 } } } }
    }, view.arrivals.some(Boolean));

    const comparisons = view.eventRows.filter(row => row.expected).map(row => ({ ...row, rate: percentage(row.attended, row.expected) }))
        .sort((a, b) => b.rate - a.rate || a.event.event_date.localeCompare(b.event.event_date));
    createChart('events', 'attendanceByEventChart', 'eventChartEmpty', {
        type: 'bar', data: { labels: comparisons.map(row => `${row.event.event_name || 'Unnamed event'} · ${displayDate(row.event.event_date)}`), datasets: [{ label: 'Attendance rate', data: comparisons.map(row => row.rate), backgroundColor: '#2f8fce', borderRadius: 5 }] },
        options: rateChartOptions(true, comparisons)
    }, comparisons.length > 0);

    createChart('completion', 'checkInOutChart', 'completionChartEmpty', {
        type: 'doughnut', data: { labels: ['Timed Out', 'Awaiting Time-Out'], datasets: [{ data: [totals.timedOut, totals.missingTimeOut], backgroundColor: ['#176aa4', '#a8cadf'], borderWidth: 2, borderColor: '#fff' }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '58%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: context => ` ${context.label}: ${context.parsed} attendees` } } } }
    }, totals.attended > 0);
}

function renderSummary(view) {
    const body = field('eventTrendTableBody');
    body.innerHTML = view.eventRows.map(row => {
        const event = row.event;
        const rate = percentage(row.attended, row.expected);
        const completion = percentage(row.timedOut, row.attended);
        const noShow = event.status === 'completed' ? String(row.noShows) : 'In progress';
        return `<tr><td><strong>${escapeHtml(event.event_name || 'Unnamed event')}</strong></td><td>${escapeHtml(displayDate(event.event_date))}</td><td>${escapeHtml(event.status || 'Unknown')}</td><td>${row.expected}</td><td>${row.attended}</td><td class="${rate >= 80 ? 'rate-good' : 'rate-low'}">${row.expected ? percentLabel(rate) : 'N/A'}</td><td>${row.onTime}</td><td>${row.late}</td><td>${noShow}</td><td>${row.timedOut}</td><td>${row.attended ? percentLabel(completion) : 'N/A'}</td></tr>`;
    }).join('');
}

function renderDetails() {
    if (!state.view) return;
    const view = state.view;
    setText('lateCount', view.details.late.length);
    setText('noShowCount', view.details.noShow.length);
    setText('missingCount', view.details.missing.length);
    const tab = state.detailTab;
    const columns = tab === 'late' ? ['Student', 'Grade', 'Section', 'Event', 'Scheduled Start', 'Time-In', 'Minutes Late']
        : tab === 'noShow' ? ['Student', 'Grade', 'Section', 'Event', 'Event Date', 'Status']
            : ['Student', 'Grade', 'Section', 'Event', 'Time-In', 'Status'];
    field('detailTableHead').innerHTML = `<tr>${columns.map(column => `<th>${column}</th>`).join('')}</tr>`;
    const query = value('detailSearch').trim().toLowerCase();
    const rows = view.details[tab].filter(record => {
        if (!query) return true;
        return `${studentName(record.student)} ${record.student?.stud_id || ''} ${record.event.event_name || ''}`.toLowerCase().includes(query);
    }).sort((a, b) => b.event.event_date.localeCompare(a.event.event_date) || studentName(a.student).localeCompare(studentName(b.student)));
    field('detailTableBody').innerHTML = rows.length ? rows.slice(0, DETAIL_LIMIT).map(record => {
        const name = escapeHtml(studentName(record.student));
        const grade = escapeHtml(record.section.grade || '—');
        const section = escapeHtml(record.section.name || '—');
        const event = escapeHtml(record.event.event_name || 'Unnamed event');
        if (tab === 'late') return `<tr><td><strong>${name}</strong></td><td>${grade}</td><td>${section}</td><td>${event}</td><td>${escapeHtml(displayClock(record.event.time_start))}</td><td>${escapeHtml(displayTime(record.attendance.timeIn))}</td><td>${Number.isFinite(record.lateMinutes) ? record.lateMinutes : '—'}</td></tr>`;
        if (tab === 'noShow') return `<tr><td><strong>${name}</strong></td><td>${grade}</td><td>${section}</td><td>${event}</td><td>${escapeHtml(displayDate(record.event.event_date))}</td><td>No Show</td></tr>`;
        return `<tr><td><strong>${name}</strong></td><td>${grade}</td><td>${section}</td><td>${event}</td><td>${escapeHtml(displayTime(record.attendance.timeIn))}</td><td>Missing Time-Out</td></tr>`;
    }).join('') : `<tr><td colspan="${columns.length}" class="muted">No matching ${tab === 'noShow' ? 'no-show' : tab === 'missing' ? 'missing Time-Out' : 'late'} records.</td></tr>`;
    setText('detailLimitNote', rows.length > DETAIL_LIMIT ? `Showing the first ${DETAIL_LIMIT} of ${rows.length} matching records. Narrow the filters or search to see more.` : `${rows.length} matching record${rows.length === 1 ? '' : 's'}.`);
}

function exportRows() {
    return (state.view?.eventRows || []).map(row => ({
        'Event': row.event.event_name || 'Unnamed event',
        'Event Date': row.event.event_date,
        'Status': row.event.status || 'Unknown',
        'Expected': row.expected,
        'Attended': row.attended,
        'Attendance Rate': row.expected ? percentLabel(percentage(row.attended, row.expected)) : 'N/A',
        'On Time': row.onTime,
        'Late': row.late,
        'No Shows': row.event.status === 'completed' ? row.noShows : 'In progress',
        'Awaiting Check-In': row.pending,
        'Timed Out': row.timedOut,
        'Completion Rate': row.attended ? percentLabel(percentage(row.timedOut, row.attended)) : 'N/A'
    }));
}
function exportExcel() {
    if (!state.view) return;
    if (!window.XLSX) return UIFeedback.error('The Excel export library is unavailable. Please refresh and try again.');
    try {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows()), 'Event Analytics');
        XLSX.writeFile(workbook, 'event_attendance_analytics.xlsx');
        UIFeedback.success('Filtered event analytics exported to Excel.');
    } catch (error) {
        console.error('[Event analytics] Excel export failed:', error);
        UIFeedback.error('Could not export event analytics to Excel.');
    }
}
function exportPdf() {
    if (!state.view) return;
    if (!window.jspdf?.jsPDF) return UIFeedback.error('The PDF export library is unavailable. Please refresh and try again.');
    try {
        const rows = exportRows();
        const pdf = new window.jspdf.jsPDF({ orientation: 'landscape' });
        if (typeof pdf.autoTable !== 'function') throw new Error('PDF table library unavailable');
        pdf.setFontSize(16);
        pdf.text('Event Attendance Analytics', 14, 16);
        pdf.setFontSize(9);
        pdf.text(`Filtered events: ${rows.length}   Expected: ${state.view.totals.expected}   Attended: ${state.view.totals.attended}   Rate: ${percentLabel(state.view.totals.attendanceRate)}`, 14, 23);
        pdf.autoTable({ startY: 29, head: [Object.keys(rows[0])], body: rows.map(Object.values), styles: { fontSize: 7 }, headStyles: { fillColor: [11, 78, 120] } });
        pdf.save('event_attendance_analytics.pdf');
        UIFeedback.success('Filtered event analytics exported to PDF.');
    } catch (error) {
        console.error('[Event analytics] PDF export failed:', error);
        UIFeedback.error('Could not export event analytics to PDF.');
    }
}
function showFailure(message) {
    state.view = null;
    destroyCharts();
    field('trendResults').hidden = true;
    field('trendEmpty').hidden = true;
    field('btnExportExcel').disabled = true;
    field('btnExportPdf').disabled = true;
    field('trendError').textContent = message;
    field('trendError').hidden = false;
    UIFeedback.error(message, 'Analytics unavailable');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeAnalytics, summarizeAnalytics, trendPoints, lateInfo, percentage, eventStartMs };
}
