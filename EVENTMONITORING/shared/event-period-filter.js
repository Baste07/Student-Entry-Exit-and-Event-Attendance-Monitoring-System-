/* Shared scheduled-Event reporting periods. Event dates are Manila calendar DATE values. */
(function (root) {
    'use strict';

    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

    function isoDate(year, month, day = 1) {
        return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    function addDays(date, days) {
        if (!DATE_PATTERN.test(date || '')) return null;
        const value = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(value.getTime())) return null;
        value.setUTCDate(value.getUTCDate() + days);
        return value.toISOString().slice(0, 10);
    }

    function manilaToday(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(now);
        const get = type => parts.find(part => part.type === type)?.value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    }

    function formatDate(date) {
        if (!DATE_PATTERN.test(date || '')) return '';
        return new Intl.DateTimeFormat('en-PH', {
            timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'
        }).format(new Date(`${date}T00:00:00Z`));
    }

    function getPeriodRange(selection = {}, now = new Date()) {
        const today = manilaToday(now);
        const currentYear = Number(today.slice(0, 4));
        const currentMonth = Number(today.slice(5, 7));
        const mode = ['monthly', 'quarterly', 'custom'].includes(selection.mode) ? selection.mode : 'monthly';

        if (mode === 'monthly') {
            const year = Number(selection.year) || currentYear;
            const month = Number(selection.month) || currentMonth;
            if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
                return { mode, valid: false, error: 'Choose a valid month and year.' };
            }
            const nextYear = month === 12 ? year + 1 : year;
            const nextMonth = month === 12 ? 1 : month + 1;
            return {
                mode, year, month, valid: true,
                start: isoDate(year, month),
                endExclusive: isoDate(nextYear, nextMonth),
                label: `${MONTHS[month - 1]} ${year}`
            };
        }

        if (mode === 'quarterly') {
            const year = Number(selection.year) || currentYear;
            const quarter = Number(selection.quarter) || Math.floor((currentMonth - 1) / 3) + 1;
            if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
                return { mode, valid: false, error: 'Choose a valid quarter and year.' };
            }
            const startMonth = (quarter - 1) * 3 + 1;
            const nextYear = quarter === 4 ? year + 1 : year;
            const nextMonth = quarter === 4 ? 1 : startMonth + 3;
            return {
                mode, year, quarter, valid: true,
                start: isoDate(year, startMonth),
                endExclusive: isoDate(nextYear, nextMonth),
                label: `Q${quarter} ${year}`
            };
        }

        const from = DATE_PATTERN.test(selection.from || '') ? selection.from : null;
        const to = DATE_PATTERN.test(selection.to || '') ? selection.to : null;
        if (from && to && from > to) {
            return { mode, valid: false, error: 'Date To must be on or after Date From.' };
        }
        const label = from && to ? `Custom: ${formatDate(from)} – ${formatDate(to)}`
            : from ? `Custom: From ${formatDate(from)}`
                : to ? `Custom: Through ${formatDate(to)}` : 'Custom: All dates';
        return { mode, valid: true, start: from, endExclusive: to ? addDays(to, 1) : null, from, to, label };
    }

    function eventOverlapsRange(event, range) {
        if (!range?.valid || !DATE_PATTERN.test(event?.event_date || '')) return false;
        const start = event.event_date;
        const end = DATE_PATTERN.test(event.end_date || '') && event.end_date >= start ? event.end_date : start;
        return (!range.start || end >= range.start) && (!range.endExclusive || start < range.endExclusive);
    }

    function filterEvents(events, range) {
        return (events || []).filter(event => eventOverlapsRange(event, range));
    }

    function availableYears(events, now = new Date()) {
        const current = Number(manilaToday(now).slice(0, 4));
        const years = new Set([current - 1, current, current + 1]);
        for (const event of events || []) {
            for (const date of [event?.event_date, event?.end_date]) {
                if (DATE_PATTERN.test(date || '')) years.add(Number(date.slice(0, 4)));
            }
        }
        return [...years].filter(Number.isInteger).sort((a, b) => b - a);
    }

    function createController(options) {
        const doc = options.document || root.document;
        const ids = options.ids || {};
        const element = name => doc.getElementById(ids[name]);
        const mode = element('mode');
        const month = element('month');
        const quarter = element('quarter');
        const year = element('year');
        const custom = element('custom');
        const from = element('from');
        const to = element('to');
        const label = element('label');
        if (![mode, month, quarter, year, custom, from, to].every(Boolean)) {
            throw new Error('Event period controls are incomplete.');
        }

        const today = manilaToday(options.now || new Date());
        const currentYear = today.slice(0, 4);
        const currentMonth = String(Number(today.slice(5, 7)));
        const currentQuarter = String(Math.floor((Number(currentMonth) - 1) / 3) + 1);

        function updateVisibility() {
            const selected = mode.value;
            element('monthGroup').hidden = selected !== 'monthly';
            element('quarterGroup').hidden = selected !== 'quarterly';
            element('yearGroup').hidden = selected === 'custom';
            custom.hidden = selected !== 'custom';
        }

        function selection() {
            return { mode: mode.value, month: month.value, quarter: quarter.value, year: year.value, from: from.value, to: to.value };
        }

        function range() {
            const result = getPeriodRange(selection(), options.now || new Date());
            if (label) label.textContent = result.valid ? result.label : result.error;
            return result;
        }

        function emit() {
            updateVisibility();
            const result = range();
            if (typeof options.onChange === 'function') options.onChange(result);
        }

        function syncYears(events) {
            const selected = year.value || currentYear;
            const years = availableYears(events, options.now || new Date());
            if (!years.map(String).includes(selected)) years.push(Number(selected));
            year.replaceChildren(...years.sort((a, b) => b - a).map(value => new Option(String(value), String(value))));
            year.value = selected;
        }

        function reset(config = {}) {
            mode.value = 'monthly';
            month.value = currentMonth;
            quarter.value = currentQuarter;
            syncYears(options.events || []);
            year.value = currentYear;
            from.value = '';
            to.value = '';
            updateVisibility();
            range();
            if (config.emit !== false && typeof options.onChange === 'function') options.onChange(range());
        }

        for (const control of [mode, month, quarter, year, from, to]) control.addEventListener('change', emit);
        syncYears(options.events || []);
        reset({ emit: false });
        return { getRange: range, reset, syncYears, updateVisibility };
    }

    const api = Object.freeze({
        MONTHS, manilaToday, getPeriodRange, eventOverlapsRange,
        filterEvents, availableYears, createController
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.EventPeriodFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
