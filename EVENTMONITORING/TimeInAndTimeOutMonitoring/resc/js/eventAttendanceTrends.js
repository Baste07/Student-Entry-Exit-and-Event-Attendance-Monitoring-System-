'use strict';

// The scanner and manual attendance flows read the same Event grace setting.
// Event dates/times are school-local (Asia/Manila); attendance timestamps are timestamptz.
let EVENT_LATE_GRACE_MINUTES = 15;
const PAGE_SIZE = 500;
const EVENT_CHUNK_SIZE = 80;
const DETAIL_LIMIT = 200;
const MANILA_TIME_ZONE = 'Asia/Manila';
const ANALYTICS_PAGE_VERSION = '20261008';
const state = {
    events: [], participants: [], attendance: [], charts: {}, loadedRange: null,
    view: null, completedView: null, performance: null, detailTab: 'late',
    activeTab: 'overview', requestId: 0
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    if (!ensureCurrentPage()) return;
    const from = document.getElementById('trendDateFrom');
    from.value = defaultFromDate();
    document.getElementById('trendDateTo').value = manilaDate();
    document.getElementById('btnApplyTrends').addEventListener('click', loadRange);
    document.getElementById('btnResetTrends').addEventListener('click', resetFilters);
    for (const id of ['trendEventType', 'trendStatus']) field(id).addEventListener('change', () => {
        populateEventOptions();
        render();
    });
    field('trendGrade').addEventListener('change', () => {
        field('trendSection').value = '';
        populateSectionOptions();
        render();
    });
    for (const id of ['trendEvent', 'trendSection', 'trendGrouping']) field(id).addEventListener('change', render);
    for (const id of ['trendDateFrom', 'trendDateTo']) field(id).addEventListener('change', loadRange);
    for (const tab of ['overview', 'performance', 'breakdown', 'trends']) {
        field(`analytics${tab[0].toUpperCase() + tab.slice(1)}Tab`).addEventListener('click', () => selectTab(tab));
    }
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
    return { grade: student?.current_grade_level || '', name: section?.section_name || '', id: student?.section_id || '' };
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

// Rate uses the expected student roster; turnout counts distinct recorded people.
// Grade/section filters narrow turnout to the selected roster because employee and
// out-of-roster attendance rows do not carry a reliable student-grade snapshot.
function performanceAnalytics(events, normalized, attendance, filters = {}, today = manilaDate()) {
    const summary = summarizeAnalytics(events, normalized);
    const rosterKeys = new Set(normalized.records.map(record => record.key));
    const eventIds = new Set(events.map(event => String(event.event_id)));
    const restrictedRoster = Boolean(filters.grade || filters.section);
    const turnout = new Map();
    let scanRows = 0;
    for (const row of attendance) {
        const eventId = String(row.event_id);
        if (!eventIds.has(eventId) || validTimestamp(row.time_in) === null) continue;
        let person = null;
        if (row.student_id) {
            if (restrictedRoster && !rosterKeys.has(rosterKey(eventId, row.student_id))) continue;
            person = `student:${row.student_id}`;
        } else if (row.employee_id && !restrictedRoster) person = `employee:${row.employee_id}`;
        if (!person) continue;
        if (!turnout.has(eventId)) turnout.set(eventId, new Set());
        turnout.get(eventId).add(person);
        scanRows++;
    }
    const rows = summary.eventRows.map(row => ({
        ...row,
        rate: row.expected ? percentage(row.attended, row.expected) : null,
        recordedTurnout: turnout.get(String(row.event.event_id))?.size || 0
    }));
    const completed = rows.filter(row => row.event.status === 'completed'
        && /^\d{4}-\d{2}-\d{2}$/.test(row.event.event_date || '')
        && row.event.event_date <= today
        && (!row.event.end_date || row.event.end_date <= today));
    const rated = completed.filter(row => row.expected > 0);
    const ranked = [...rated].sort((a, b) => b.rate - a.rate
        || a.event.event_date.localeCompare(b.event.event_date)
        || String(a.event.event_id).localeCompare(String(b.event.event_id)));
    // Ties follow the displayed one-decimal rate, avoiding equal-looking winners.
    const displayedRate = row => Number(row.rate.toFixed(1));
    const best = ranked.length ? ranked.filter(row => displayedRate(row) === displayedRate(ranked[0])) : [];
    const lowest = ranked.length ? ranked.filter(row => displayedRate(row) === displayedRate(ranked[ranked.length - 1])) : [];
    const maxTurnout = completed.reduce((maximum, row) => Math.max(maximum, row.recordedTurnout), 0);
    const largest = maxTurnout ? completed.filter(row => row.recordedTurnout === maxTurnout) : [];
    const attention = rated.filter(row => row.rate < 70);
    const totals = rated.reduce((sum, row) => {
        for (const key of ['expected', 'attended', 'noShows', 'onTime', 'late']) sum[key] += row[key];
        return sum;
    }, { expected: 0, attended: 0, noShows: 0, onTime: 0, late: 0 });
    totals.rate = totals.expected ? percentage(totals.attended, totals.expected) : null;
    return { rows, completed, rated, ranked, best, lowest, largest, attention, totals, scanRows };
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
        const eventSettings = await AppSettings.load(supabaseClient, 'event', { missingTableDefaults: true });
        const grace = Number(eventSettings.late_grace_minutes);
        if (!Number.isInteger(grace) || grace < 0 || grace > 99) throw new Error('Invalid event grace setting');
        EVENT_LATE_GRACE_MINUTES = grace;
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
            fetchForEvents('event_participants', 'event_id,student_id,participant_id,students(student_id,stud_id,current_grade_level,first_name,middle_name,last_name,section_id,sections(section_id,section_name))', ids, 'participant_id'),
            fetchForEvents('event_attendance', 'attendance_id,event_id,student_id,employee_id,time_in,time_out,remarks', ids, 'attendance_id')
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
    if (!events.length) {
        state.view = null;
        state.completedView = null;
        state.performance = null;
        return;
    }
    const eventIds = new Set(events.map(event => String(event.event_id)));
    const participants = state.participants.filter(row => eventIds.has(String(row.event_id)));
    const attendance = state.attendance.filter(row => eventIds.has(String(row.event_id)));
    const filters = { grade: value('trendGrade'), section: value('trendSection') };
    const normalized = normalizeAnalytics(events, participants, attendance, filters);
    state.view = summarizeAnalytics(events, normalized);
    state.performance = performanceAnalytics(events, normalized, attendance, filters);
    field('btnExportExcel').disabled = state.performance.completed.length === 0;
    field('btnExportPdf').disabled = state.performance.completed.length === 0;
    const completedIds = new Set(state.performance.completed.map(row => String(row.event.event_id)));
    const completedEvents = events.filter(event => completedIds.has(String(event.event_id)));
    state.completedView = summarizeAnalytics(completedEvents, normalizeAnalytics(completedEvents, participants, attendance, filters));
    renderOverview();
    renderPerformance();
    renderBreakdown();
    renderTrends();
    renderDetails();
    selectTab(state.activeTab);
}

function selectTab(tab) {
    state.activeTab = tab;
    for (const name of ['overview', 'performance', 'breakdown', 'trends']) {
        const id = `analytics${name[0].toUpperCase() + name.slice(1)}`;
        const selected = name === tab;
        field(`${id}Tab`).classList.toggle('active', selected);
        field(`${id}Tab`).setAttribute('aria-pressed', String(selected));
        field(`${id}Panel`).hidden = !selected;
    }
    renderActiveChart();
}
function eventLabel(row) { return row.event.event_name || 'Unnamed event'; }
function listEventNames(rows) {
    return rows.map(row => eventLabel(row)).join(', ');
}
function renderOverview() {
    const report = state.performance;
    const totals = report.totals;
    const selected = value('trendEvent');
    const event = selected ? report.rows.find(row => String(row.event.event_id) === selected) : null;
    setText('viewTitle', event ? eventLabel(event) : `${report.rows.length} event${report.rows.length === 1 ? '' : 's'} selected`);
    const from = value('trendDateFrom'), to = value('trendDateTo');
    setText('viewSubtitle', `${from || 'All dates'} to ${to || 'today'} · ${report.completed.length} completed event${report.completed.length === 1 ? '' : 's'} in performance · Manila dates`);
    setText('statAttendanceRate', totals.rate === null ? 'N/A' : percentLabel(totals.rate));
    setText('attendanceRateNote', totals.expected
        ? `${totals.attended} of ${totals.expected} expected students attended across ${report.rated.length} completed event${report.rated.length === 1 ? '' : 's'} with participant lists.`
        : 'No completed event with an expected-student list matches these filters.');
    setText('statBestEvent', report.best.length ? (report.best.length === 1 ? eventLabel(report.best[0]) : `${report.best.length} tied events`) : 'N/A');
    setText('bestEventNote', report.best.length
        ? `${listEventNames(report.best)}: ${percentLabel(report.best[0].rate)}; ${report.best.map(row => `${row.attended} of ${row.expected}`).join('; ')} expected students attended.`
        : 'A completed event needs an expected-student list for this comparison.');
    setText('statLargestTurnout', report.largest.length ? (report.largest.length === 1 ? eventLabel(report.largest[0]) : `${report.largest.length} tied events`) : 'N/A');
    setText('largestTurnoutNote', report.largest.length
        ? `${listEventNames(report.largest)}: ${report.largest[0].recordedTurnout} unique people recorded a Time-In.`
        : 'No completed event has a recorded Time-In.');
    setText('statAttention', report.rated.length ? String(report.attention.length) : 'N/A');
    setText('attentionNote', report.rated.length
        ? `${report.attention.length} of ${report.rated.length} completed events with participant lists were below the stated 70% attendance threshold.`
        : 'The 70% threshold needs a completed event with an expected-student list.');
    const notes = [];
    notes.push(`${report.scanRows} matching valid Time-In record${report.scanRows === 1 ? '' : 's'} were considered for turnout. Attendance-rate and turnout metrics count each person once per event, not once per scan.`);
    if (!report.completed.length) notes.push('No completed events in the selected period. Ongoing, upcoming, cancelled, and future-dated events are not scored as completed.');
    if (report.completed.some(row => !row.expected)) notes.push('A completed event without a participant roster has no attendance percentage or no-show count.');
    if (state.view.outsideRoster) notes.push(`${state.view.outsideRoster} student check-in${state.view.outsideRoster === 1 ? '' : 's'} outside the expected roster are excluded from attendance rates but included in recorded turnout when grade and section are unfiltered.`);
    if (state.view.duplicateParticipants || state.view.duplicateAttendance) notes.push(`Duplicate source rows were counted once for unique-person metrics (${state.view.duplicateParticipants} roster, ${state.view.duplicateAttendance} attendance).`);
    if (value('trendGrade') || value('trendSection')) notes.push('Grade and section filters use each student’s current profile. Recorded turnout is limited to the matching roster because other check-ins have no reliable grade snapshot.');
    notes.push('Attendance rate measures expected students with a Time-In. Recorded turnout counts unique people with a Time-In, including people outside the expected-student list when grade and section are unfiltered.');
    setText('analyticsNote', notes.join(' '));
    field('eventInsight').hidden = !event;
    if (!event) return;
    setText('insightTitle', `${eventLabel(event)} · ${displayDate(event.event.event_date)}`);
    setText('insightExpected', event.expected.toLocaleString());
    setText('insightAttended', event.attended.toLocaleString());
    const isCompleted = report.completed.includes(event);
    setText('insightRate', isCompleted && event.expected ? percentLabel(event.rate) : 'N/A');
    setText('insightNoShow', isCompleted && event.expected ? event.noShows.toLocaleString() : 'N/A');
    setText('insightExplanation', !isCompleted
        ? 'This event is not yet a completed, past event. Attendance and no-show performance is not finalized.'
        : !event.expected
            ? 'There is no expected-student list for this event, so an attendance percentage or no-show count cannot be calculated reliably.'
            : `${event.attended} of ${event.expected} expected students recorded a Time-In (${percentLabel(event.rate)}). ${event.noShows} had no recorded attendance. This describes the records, not the reason for attendance.`);
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
            [horizontal ? 'y' : 'x']: { ticks: {
                autoSkip: !horizontal, maxRotation: horizontal ? 0 : 45,
                callback: horizontal ? function (tick) {
                    const label = this.getLabelForValue(tick);
                    const limit = window.innerWidth <= 520 ? 18 : 34;
                    return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
                } : undefined
            } }
        }
    };
}
function performanceExplanation(report) {
    const best = report.best, lowest = report.lowest;
    if (!report.rated.length) return 'No completed event with an expected-student list is available for an attendance-rate comparison.';
    if (report.rated.length === 1) return `Only ${eventLabel(best[0])} has a comparable attendance rate: ${percentLabel(best[0].rate)}, with ${best[0].attended} of ${best[0].expected} expected students attending. More completed events are needed to compare performance.`;
    if (best.length === report.rated.length) return `All ${report.rated.length} completed events with participant lists tied at ${percentLabel(best[0].rate)} attendance. Recorded turnout is a separate count and may differ between them.`;
    return `${listEventNames(best)} ${best.length === 1 ? 'had' : 'tied for'} the highest attendance rate at ${percentLabel(best[0].rate)}. ${best.map(row => `${row.attended} of ${row.expected}`).join('; ')} expected students attended. ${listEventNames(lowest)} ${lowest.length === 1 ? 'had' : 'tied for'} the lowest rate at ${percentLabel(lowest[0].rate)}. Largest recorded turnout is counted separately and may be a different event.`;
}
function renderPerformance() {
    const report = state.performance;
    const explanation = performanceExplanation(report);
    setText('performanceExplanation', `${explanation}${report.ranked.length > 20 ? ' The chart shows the first 20 events by rate; the comparison table lists all completed events.' : ''}`);
    field('eventTrendTableBody').innerHTML = report.completed.length
        ? report.completed.map(row => `<tr><td><strong>${escapeHtml(eventLabel(row))}</strong></td><td>${escapeHtml(displayDate(row.event.event_date))}</td><td>${row.expected}</td><td>${row.attended}</td><td>${row.expected ? percentLabel(row.rate) : 'N/A — no expected list'}</td><td>${row.expected ? row.noShows : 'N/A'}</td><td>${row.recordedTurnout}</td></tr>`).join('')
        : '<tr><td colspan="7" class="muted">No completed events match these filters.</td></tr>';
}
function renderBreakdown() {
    const totals = state.performance.totals;
    setText('breakdownExplanation', totals.expected
        ? `${totals.onTime} expected students arrived on time, ${totals.late} arrived after the grace period, and ${totals.noShows} had no recorded Time-In. ${percentLabel(percentage(totals.noShows, totals.expected))} of the ${totals.expected} expected student-event places had no recorded attendance. Missing Time-Out is separate from no attendance.`
        : 'No completed event with an expected-student list is available for a reliable attendance breakdown.');
}
function trendNarrative(report) {
    const chronological = [...report.rated].sort((a, b) => a.event.event_date.localeCompare(b.event.event_date)
        || String(a.event.event_id).localeCompare(String(b.event.event_id)));
    if (chronological.length < 3) return `Only ${chronological.length} comparable completed event${chronological.length === 1 ? ' is' : 's are'} available, so an attendance trend cannot be determined yet.`;
    const recent = chronological.slice(-3).map(row => row.rate);
    if (recent[1] - recent[0] >= 1 && recent[2] - recent[1] >= 1) return 'The last three comparable events each had a higher attendance rate than the one before it.';
    if (recent[0] - recent[1] >= 1 && recent[1] - recent[2] >= 1) return 'The last three comparable events each had a lower attendance rate than the one before it.';
    if (Math.max(...recent) - Math.min(...recent) <= 5) return 'Attendance rates across the last three comparable events stayed within five percentage points of one another.';
    return 'Attendance rates across the last three comparable events varied; there is no consistent increase or decline.';
}
function renderTrends() {
    setText('trendExplanation', trendNarrative(state.performance));
}
function renderActiveChart() {
    destroyCharts();
    const report = state.performance;
    if (!report) return;
    if (state.activeTab === 'performance') {
        const rows = report.ranked.slice(0, 20);
        field('attendanceByEventChart').parentElement.style.height = `${Math.max(300, Math.min(1000, rows.length * 48 + 80))}px`;
        createChart('events', 'attendanceByEventChart', 'eventChartEmpty', {
            type: 'bar',
            data: { labels: rows.map(row => `${eventLabel(row)} · ${displayDate(row.event.event_date)}`),
                datasets: [{ label: 'Attendance rate', data: rows.map(row => row.rate),
                    backgroundColor: rows.map(row => report.best.includes(row) ? '#0b4e78' : report.lowest.includes(row) ? '#d97706' : '#6baed6'),
                    borderRadius: 5, maxBarThickness: 28 }] },
            options: rateChartOptions(true, rows)
        }, rows.length > 0);
    } else if (state.activeTab === 'breakdown') {
        const totals = report.totals;
        createChart('status', 'statusChart', 'statusChartEmpty', {
            type: 'doughnut',
            data: { labels: ['On time', 'Late', 'No recorded attendance'],
                datasets: [{ data: [totals.onTime, totals.late, totals.noShows], backgroundColor: ['#059669', '#d97706', '#d45d60'], borderWidth: 2, borderColor: '#fff' }] },
            options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '58%', plugins: { legend: { position: 'bottom' } } }
        }, totals.expected > 0);
    } else if (state.activeTab === 'trends') {
        const chronological = [...report.rated].sort((a, b) => a.event.event_date.localeCompare(b.event.event_date));
        const points = trendPoints(chronological, value('trendGrouping'));
        createChart('trend', 'attendanceTrendChart', 'trendChartEmpty', {
            type: 'line',
            data: { labels: points.map(point => point.label), datasets: [{
                label: 'Attendance rate', data: points.map(point => point.rate),
                borderColor: '#176aa4', backgroundColor: 'rgba(47,143,206,.14)',
                pointRadius: 4, fill: true, tension: .2, spanGaps: false
            }] },
            options: rateChartOptions(false, points)
        }, points.length > 0);
    }
}

function renderDetails() {
    if (!state.completedView) return;
    const view = state.completedView;
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
    return (state.performance?.completed || []).map(row => ({
        'Event': row.event.event_name || 'Unnamed event',
        'Event Date': row.event.event_date,
        'Status': row.event.status || 'Unknown',
        'Expected Students': row.expected,
        'Expected Students Who Attended': row.attended,
        'Attendance Rate': row.expected ? percentLabel(row.rate) : 'N/A',
        'Recorded Turnout': row.recordedTurnout,
        'On Time': row.onTime,
        'Late': row.late,
        'No Recorded Attendance': row.expected ? row.noShows : 'N/A'
    }));
}
function exportExcel() {
    if (!state.performance?.completed.length) return;
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
    if (!state.performance?.completed.length) return;
    if (!window.jspdf?.jsPDF) return UIFeedback.error('The PDF export library is unavailable. Please refresh and try again.');
    try {
        const rows = exportRows();
        const pdf = new window.jspdf.jsPDF({ orientation: 'landscape' });
        if (typeof pdf.autoTable !== 'function') throw new Error('PDF table library unavailable');
        pdf.setFontSize(16);
        pdf.text('Event Attendance Analytics', 14, 16);
        pdf.setFontSize(9);
        pdf.text(`Completed events: ${rows.length}   Expected: ${state.performance.totals.expected}   Attended: ${state.performance.totals.attended}   Rate: ${state.performance.totals.rate === null ? 'N/A' : percentLabel(state.performance.totals.rate)}`, 14, 23);
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
    module.exports = { normalizeAnalytics, summarizeAnalytics, performanceAnalytics, performanceExplanation,
        trendNarrative, trendPoints, lateInfo, percentage, percentLabel, eventStartMs };
}
