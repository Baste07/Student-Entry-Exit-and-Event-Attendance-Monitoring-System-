/* Display normalized Event targets, with a legacy-field fallback. */
(function (root) {
    'use strict';

    function legacySummary(event) {
        if (!event || !event.target_grade_level) return 'Individually selected students';
        return event.target_grade_level + (event.target_section
            ? ': ' + event.target_section : ': All Sections');
    }

    function summary(event) {
        if (event?.targetSummaryUnavailable) return 'Target details unavailable';
        const targets = event?.normalizedTargets;
        if (!Array.isArray(targets) || targets.length === 0) return legacySummary(event);
        const gradeOrder = grade => grade === 'Kinder' ? 0 : Number(grade?.match(/^Grade (\d+)$/)?.[1] || 99);
        return [...targets].sort((a, b) => gradeOrder(a.grade_level) - gradeOrder(b.grade_level)).map(target => {
            if (target.all_sections) return `${target.grade_level}: All Sections`;
            const names = (target.event_grade_target_sections || [])
                .map(link => link.sections?.section_name)
                .filter(Boolean).sort((a, b) => a.localeCompare(b));
            return `${target.grade_level}: ${names.join(', ') || 'Selected Sections'}`;
        }).join('; ');
    }

    async function attach(client, events) {
        const ids = [...new Set((events || []).map(event => event.event_id).filter(Boolean))];
        if (ids.length === 0) return events;
        const { data, error } = await client.from('event_grade_targets')
            .select('event_id, school_year_id, grade_level, all_sections, event_grade_target_sections(section_id, sections(section_name))')
            .in('event_id', ids);
        // Before the approved migration is installed, legacy displays still work.
        if (error) {
            if (['42P01', 'PGRST205'].includes(error.code)) {
                for (const event of events) event.normalizedTargets = [];
            } else {
                for (const event of events) event.targetSummaryUnavailable = true;
                console.warn('Event target summaries unavailable:', error.code);
            }
            return events;
        }
        const byEvent = new Map();
        for (const target of data || []) {
            if (!byEvent.has(target.event_id)) byEvent.set(target.event_id, []);
            byEvent.get(target.event_id).push(target);
        }
        for (const event of events) {
            event.normalizedTargets = byEvent.get(event.event_id) || [];
        }
        return events;
    }

    root.EventTargets = { attach, summary, legacySummary };
    if (typeof module !== 'undefined' && module.exports) module.exports = root.EventTargets;
})(typeof window !== 'undefined' ? window : globalThis);
