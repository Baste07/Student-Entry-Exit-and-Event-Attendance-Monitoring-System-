'use strict';

// Shared, read-only calculations for the operational dashboard and historical reports.
const GateAnalytics = (() => {
    const ZONE = 'Asia/Manila';
    const PAGE_SIZE = 500;
    const LOG_COLUMNS = 'id,student_id,employee_id,log_type,scan_method,log_timestamp,created_at,students(stud_id,first_name,last_name,section_id,sections(grade_level,section_name)),employees(emp_no,first_name,last_name,faculty,role)';
    const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' });
    const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long' });

    function manilaDate(value = new Date()) {
        const parts = dateFormatter.formatToParts(value);
        const part = type => parts.find(item => item.type === type).value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    }
    function manilaHour(value) { return Number(hourFormatter.format(value)); }
    function personKey(log) {
        if (Boolean(log.student_id) === Boolean(log.employee_id)) return null;
        if (log.student_id) return `student:${log.student_id}`;
        if (log.employee_id) return `employee:${log.employee_id}`;
        return null;
    }
    function normalize(logs, now = Date.now()) {
        let invalid = 0;
        let future = 0;
        const rows = [];
        for (const log of logs || []) {
            const key = personKey(log);
            const timestamp = log.log_timestamp ? new Date(log.log_timestamp).getTime() : NaN;
            if (!key || !['entry', 'exit'].includes(log.log_type) || !Number.isFinite(timestamp)) { invalid++; continue; }
            if (timestamp > now) { future++; continue; }
            const student = log.students || {};
            const employee = log.employees || {};
            const section = student.sections || {};
            const type = log.student_id ? 'student' : 'employee';
            const createdAt = log.created_at ? new Date(log.created_at).getTime() : NaN;
            rows.push({
                id: log.id, key, type, action: log.log_type,
                method: log.scan_method || 'unknown', timestamp, createdAt: Number.isFinite(createdAt) ? createdAt : timestamp, date: manilaDate(new Date(timestamp)),
                hour: manilaHour(new Date(timestamp)), weekday: weekdayFormatter.format(new Date(timestamp)),
                name: [type === 'student' ? student.first_name : employee.first_name, type === 'student' ? student.last_name : employee.last_name].filter(Boolean).join(' ') || 'Unknown person',
                identifier: type === 'student' ? student.stud_id || '' : employee.emp_no ?? '',
                grade: type === 'student' ? section.grade_level || '' : '',
                section: type === 'student' ? section.section_name || '' : '',
                sectionId: type === 'student' ? student.section_id || '' : '',
                role: type === 'employee' ? employee.role || '' : '',
                faculty: type === 'employee' ? employee.faculty || '' : ''
            });
        }
        rows.sort((a, b) => a.timestamp - b.timestamp || a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
        return { rows, invalid, future };
    }
    function filterRows(rows, filters = {}) {
        return rows.filter(row =>
            (!filters.from || row.date >= filters.from) &&
            (!filters.to || row.date <= filters.to) &&
            (!filters.personType || row.type === filters.personType) &&
            (!filters.grade || row.grade === filters.grade) &&
            (!filters.section || String(row.sectionId) === String(filters.section)) &&
            (!filters.action || row.action === filters.action) &&
            (!filters.method || row.method === filters.method)
        );
    }
    function pairVisits(rows) {
        const open = new Map();
        const latest = new Map();
        const completed = [];
        const unclosed = [];
        let unpairedExits = 0;
        let repeatedEntries = 0;
        for (const row of rows) {
            latest.set(row.key, row);
            if (row.action === 'entry') {
                if (open.has(row.key)) { unclosed.push({ entry: open.get(row.key), reason: 'Repeated Entry' }); repeatedEntries++; }
                open.set(row.key, row);
            } else if (open.has(row.key)) {
                const entry = open.get(row.key);
                completed.push({ entry, exit: row, durationMs: row.timestamp - entry.timestamp });
                open.delete(row.key);
            } else unpairedExits++;
        }
        for (const entry of open.values()) unclosed.push({ entry, reason: 'No later Exit' });
        return { latest, completed, unclosed, unpairedExits, repeatedEntries };
    }
    function summary(rows, now = Date.now()) {
        const entries = rows.filter(row => row.action === 'entry');
        const exits = rows.filter(row => row.action === 'exit');
        const people = new Set(rows.map(row => row.key));
        const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: 0, exits: 0 }));
        const dates = new Map();
        const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            .map(day => ({ day, entries: 0, exits: 0 }));
        const weekdayMap = new Map(weekdays.map(row => [row.day, row]));
        const types = { student: { entries: 0, exits: 0, people: new Set() }, employee: { entries: 0, exits: 0, people: new Set() } };
        const sections = new Map();
        const methods = new Map();
        for (const row of rows) {
            const field = row.action === 'entry' ? 'entries' : 'exits';
            hours[row.hour][field]++;
            if (!dates.has(row.date)) dates.set(row.date, { date: row.date, entries: 0, exits: 0, people: new Set() });
            const date = dates.get(row.date);
            date[field]++; date.people.add(row.key);
            weekdayMap.get(row.weekday)[field]++;
            types[row.type][field]++; types[row.type].people.add(row.key);
            methods.set(row.method, (methods.get(row.method) || 0) + 1);
            if (row.type === 'student') {
                const key = row.sectionId || 'unassigned';
                if (!sections.has(key)) sections.set(key, { key, grade: row.grade, section: row.section, entries: 0, exits: 0, people: new Set() });
                const section = sections.get(key);
                section[field]++; section.people.add(row.key);
            }
        }
        const visits = pairVisits(rows);
        const inside = [...visits.latest.values()].filter(row => row.action === 'entry').sort((a, b) => a.timestamp - b.timestamp);
        const durations = visits.completed.map(visit => visit.durationMs).sort((a, b) => a - b);
        const durationCount = durations.length;
        const median = durationCount ? (durations[Math.floor((durationCount - 1) / 2)] + durations[Math.floor(durationCount / 2)]) / 2 : null;
        const average = durationCount ? durations.reduce((a, b) => a + b, 0) / durationCount : null;
        const durationBuckets = [0, 0, 0, 0, 0, 0];
        for (const ms of durations) durationBuckets[ms < 3600000 ? 0 : ms < 10800000 ? 1 : ms < 21600000 ? 2 : ms < 32400000 ? 3 : ms < 43200000 ? 4 : 5]++;
        const peak = action => hours.reduce((best, hour) => hour[action] > (best?.[action] || 0) ? hour : best, null);
        return {
            entries: entries.length, exits: exits.length, uniquePeople: people.size,
            inside, studentsInside: inside.filter(row => row.type === 'student').length,
            employeesInside: inside.filter(row => row.type === 'employee').length,
            hours, peakEntry: peak('entries'), peakExit: peak('exits'),
            dates: [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ ...row, uniquePeople: row.people.size })),
            weekdays, types: Object.fromEntries(Object.entries(types).map(([key, row]) => [key, { entries: row.entries, exits: row.exits, uniquePeople: row.people.size }])),
            sections: [...sections.values()].map(row => ({ ...row, uniquePeople: row.people.size })).sort((a, b) => b.uniquePeople - a.uniquePeople || a.grade.localeCompare(b.grade)),
            methods: [...methods].map(([method, count]) => ({ method, count })).sort((a, b) => b.count - a.count),
            visits, averageStayMs: average, medianStayMs: median, longestStayMs: durationCount ? durations[durationCount - 1] : null,
            durationBuckets, now
        };
    }
    function hourLabel(hour) {
        const clock = value => `${String(value % 24).padStart(2, '0')}:00`;
        return `${clock(hour)}–${clock(hour + 1)}`;
    }
    function durationLabel(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '—';
        const minutes = Math.floor(ms / 60000);
        return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    }
    function displayTime(timestamp) {
        return new Date(timestamp).toLocaleString('en-PH', { timeZone: ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    async function fetchLogs(client, filters = {}) {
        const result = [];
        const fromUtc = filters.from ? `${filters.from}T00:00:00+08:00` : null;
        const toUtc = filters.to ? `${filters.to}T23:59:59.999+08:00` : null;
        for (let offset = 0; ; offset += PAGE_SIZE) {
            let query = client.from('entry_exit_logs').select(LOG_COLUMNS)
                .order('log_timestamp', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true });
            if (fromUtc) query = query.gte('log_timestamp', new Date(fromUtc).toISOString());
            if (toUtc) query = query.lte('log_timestamp', new Date(toUtc).toISOString());
            if (filters.since) query = query.gte('log_timestamp', filters.since);
            const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
            if (error) throw error;
            result.push(...(data || []));
            if (!data || data.length < PAGE_SIZE) break;
        }
        return result;
    }
    return { manilaDate, normalize, filterRows, pairVisits, summary, hourLabel, durationLabel, displayTime, fetchLogs };
})();

if (typeof window !== 'undefined') window.GateAnalytics = GateAnalytics;
if (typeof module !== 'undefined' && module.exports) module.exports = GateAnalytics;
