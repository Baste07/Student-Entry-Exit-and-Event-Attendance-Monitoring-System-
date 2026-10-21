/* Local school-time schedule comparisons for Event management.
 * Event dates and times are stored as Manila wall-clock date/time columns.
 * An omitted time means the corresponding boundary is the start/end of day.
 */
(function (root) {
    'use strict';

    function nextDate(date) {
        const value = new Date(date + 'T00:00:00Z');
        if (Number.isNaN(value.getTime())) return null;
        value.setUTCDate(value.getUTCDate() + 1);
        return value.toISOString().slice(0, 10);
    }

    function timeValue(value, fallback) {
        if (!value) return fallback;
        const text = String(value);
        if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(text)) return fallback;
        return text.length === 5 ? text + ':00' : text;
    }

    function interval(event) {
        const firstDate = event?.event_date;
        const lastDate = event?.end_date || firstDate;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate || '') ||
            !/^\d{4}-\d{2}-\d{2}$/.test(lastDate || '') ||
            lastDate < firstDate) return null;
        const endDay = event.time_end ? lastDate : nextDate(lastDate);
        if (!endDay) return null;
        const start = firstDate + 'T' + timeValue(event.time_start, '00:00:00');
        const end = endDay + 'T' + timeValue(event.time_end, '00:00:00');
        return start < end ? { start, end } : null;
    }

    function overlaps(first, second) {
        const a = interval(first);
        const b = interval(second);
        return !!a && !!b && a.start < b.end && b.start < a.end;
    }

    function normalizeLocation(location) {
        return String(location || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    }

    function overlappingEvents(candidate, events, excludeEventId = null) {
        if (candidate?.status === 'cancelled') return [];
        return (events || []).filter(event =>
            event.event_id !== excludeEventId &&
            event.status !== 'cancelled' &&
            overlaps(candidate, event)
        );
    }

    function locationConflicts(candidate, events, excludeEventId = null) {
        const location = normalizeLocation(candidate?.location);
        if (!location) return [];
        return overlappingEvents(candidate, events, excludeEventId)
            .filter(event => normalizeLocation(event.location) === location);
    }

    function locationConflictIds(events) {
        const groups = new Map();
        const conflicts = new Set();
        for (const event of events || []) {
            if (event.status === 'cancelled' || !event.event_id) continue;
            const key = normalizeLocation(event.location);
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(event);
        }
        for (const group of groups.values()) {
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    if (overlaps(group[i], group[j])) {
                        conflicts.add(group[i].event_id);
                        conflicts.add(group[j].event_id);
                    }
                }
            }
        }
        return conflicts;
    }

    function participantConflicts(studentIds, overlapping, rosterRows) {
        const selected = new Set(studentIds || []);
        const matching = new Map();
        const byEvent = new Map((overlapping || []).map(event => [event.event_id, event]));
        for (const row of rosterRows || []) {
            if (!selected.has(row.student_id) || !byEvent.has(row.event_id)) continue;
            if (!matching.has(row.event_id)) {
                matching.set(row.event_id, { event: byEvent.get(row.event_id), studentIds: new Set() });
            }
            matching.get(row.event_id).studentIds.add(row.student_id);
        }
        return [...matching.values()];
    }

    const api = Object.freeze({
        interval, overlaps, normalizeLocation, overlappingEvents,
        locationConflicts, locationConflictIds, participantConflicts,
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.EventScheduleConflicts = api;
})(typeof window !== 'undefined' ? window : globalThis);
