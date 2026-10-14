(function (root) {
    'use strict';

    const PAGE_SIZE = 500;
    const PROFILE_BATCH_SIZE = 100;
    const SPOOF_COLUMNS = 'spoof_log_id,student_id,employee_id,liveness_score,is_spoof,source_module,detected_name,reason,detected_at';
    const SOURCE_LABELS = Object.freeze({ daily_attendance: 'Daily Attendance', entry_exit: 'Entry / Exit' });
    const dateFormatter = new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric'
    });
    const timeFormatter = new Intl.DateTimeFormat('en-PH', {
        timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
    const stampFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    });

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
    }

    function dateValue(value) {
        const date = new Date(value);
        if (!value || Number.isNaN(date.getTime())) return { date: '—', time: '—', stamp: '' };
        const parts = stampFormatter.formatToParts(date);
        const part = type => parts.find(item => item.type === type).value;
        return {
            date: dateFormatter.format(date),
            time: timeFormatter.format(date),
            stamp: `${part('year')}-${part('month')}-${part('day')}`
        };
    }

    function sourceLabel(value) {
        return SOURCE_LABELS[value] || (value ? String(value).replace(/_/g, ' ') : 'Unknown Source');
    }

    function personName(profile) {
        return [profile?.first_name, profile?.middle_name, profile?.last_name, profile?.suffix]
            .map(value => String(value || '').trim()).filter(Boolean).join(' ');
    }

    function resolveRow(row, students, employees) {
        const profile = row.student_id ? students.get(row.student_id) : employees.get(row.employee_id);
        return {
            ...row,
            display_name: personName(profile) || String(row.detected_name || '').trim() || 'Unknown User',
            display_id: (row.student_id ? profile?.stud_id : profile?.emp_no) || 'Unavailable'
        };
    }

    function filterRows(rows, { search = '', source = 'all', date = '' } = {}) {
        const query = String(search).trim().toLowerCase();
        return rows.filter(row => {
            const haystack = `${row.display_name} ${row.display_id} ${row.reason || ''} ${sourceLabel(row.source_module)}`.toLowerCase();
            return (!query || haystack.includes(query)) &&
                (source === 'all' || row.source_module === source) &&
                (!date || dateValue(row.detected_at).stamp === date);
        });
    }

    function summary(rows, now = new Date()) {
        const today = dateValue(now).stamp;
        return {
            total: rows.length,
            today: rows.filter(row => dateValue(row.detected_at).stamp === today).length,
            attendance: rows.filter(row => row.source_module === 'daily_attendance' || row.source_module === 'entry_exit').length
        };
    }

    function renderRow(row) {
        const when = dateValue(row.detected_at);
        const score = Number(row.liveness_score);
        const detail = (row.reason || 'Liveness check failed') +
            (row.liveness_score === null || row.liveness_score === undefined || !Number.isFinite(score)
                ? '' : ` Score: ${score.toFixed(4)}.`);
        const blocked = row.is_spoof === true;
        return `<tr>
            <td>${escapeHtml(when.date)}</td>
            <td>${escapeHtml(when.time)}</td>
            <td><strong>${escapeHtml(row.display_name)}</strong></td>
            <td>${escapeHtml(row.display_id)}</td>
            <td>${escapeHtml(sourceLabel(row.source_module))}</td>
            <td class="spoof-reason">${escapeHtml(detail)}</td>
            <td><span class="spoof-badge${blocked ? '' : ' neutral'}">${blocked ? 'Blocked' : 'Detected'}</span></td>
        </tr>`;
    }

    async function fetchAll(client) {
        const rows = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
            const { data, error } = await client.from('spoof_attempts')
                .select(SPOOF_COLUMNS)
                .order('detected_at', { ascending: false })
                .order('spoof_log_id', { ascending: false })
                .range(offset, offset + PAGE_SIZE - 1);
            if (error) throw error;
            const batch = data || [];
            rows.push(...batch);
            if (batch.length < PAGE_SIZE) return rows;
        }
    }

    async function loadProfileMap(client, table, idColumn, columns, ids, logger) {
        const profiles = new Map();
        try {
            for (let offset = 0; offset < ids.length; offset += PROFILE_BATCH_SIZE) {
                const { data, error } = await client.from(table)
                    .select(columns).in(idColumn, ids.slice(offset, offset + PROFILE_BATCH_SIZE));
                if (error) throw error;
                for (const profile of data || []) profiles.set(profile[idColumn], profile);
            }
        } catch (error) {
            logger.warn(`${table} profiles unavailable for spoof attempts`, error?.code || 'unknown');
        }
        return profiles;
    }

    async function resolveProfiles(client, rows, logger) {
        const studentIds = [...new Set(rows.map(row => row.student_id).filter(Boolean))];
        const employeeIds = [...new Set(rows.map(row => row.employee_id).filter(Boolean))];
        const [students, employees] = await Promise.all([
            loadProfileMap(client, 'students', 'student_id',
                'student_id,stud_id,first_name,middle_name,last_name,suffix', studentIds, logger),
            loadProfileMap(client, 'employees', 'employee_id',
                'employee_id,emp_no,first_name,middle_name,last_name,suffix', employeeIds, logger)
        ]);
        return rows.map(row => resolveRow(row, students, employees));
    }

    function createController({ client, doc, feedback, logger = console, now = () => new Date() }) {
        const state = { rows: [], search: '', source: 'all', date: '' };
        const element = id => doc.getElementById(id);
        const body = element('spoofTableBody');
        const refreshButton = element('refreshSpoofBtn');
        const setCounts = values => {
            element('totalSpoofCount').textContent = values?.total ?? '—';
            element('todaySpoofCount').textContent = values?.today ?? '—';
            element('attendanceSpoofCount').textContent = values?.attendance ?? '—';
        };
        const render = () => {
            const filtered = filterRows(state.rows, state);
            body.innerHTML = filtered.length
                ? filtered.map(renderRow).join('')
                : '<tr><td colspan="7" class="empty-state">No spoofing attempts found.</td></tr>';
        };
        const load = async () => {
            refreshButton.disabled = true;
            body.innerHTML = '<tr><td colspan="7" class="empty-state">Loading spoofing attempts...</td></tr>';
            try {
                const rows = await fetchAll(client);
                state.rows = await resolveProfiles(client, rows, logger);
                setCounts(summary(state.rows, now()));
                render();
            } catch (error) {
                state.rows = [];
                setCounts(null);
                body.innerHTML = '<tr><td colspan="7" class="empty-state">Unable to load security records. Refresh and try again.</td></tr>';
                logger.error('Failed to load spoof attempts', error?.code || 'unknown');
                feedback?.toast?.({ type: 'error', message: 'Spoofing attempts could not be loaded.' });
            } finally {
                refreshButton.disabled = false;
            }
        };
        const bind = () => {
            element('spoofSearch').addEventListener('input', event => {
                state.search = event.target.value;
                render();
            });
            element('spoofSourceFilter').addEventListener('change', event => {
                state.source = event.target.value;
                render();
            });
            element('spoofDateFilter').addEventListener('change', event => {
                state.date = event.target.value;
                render();
            });
            refreshButton.addEventListener('click', load);
        };
        return { state, render, load, bind };
    }

    async function start({ routeReady, authorize, loadHeader, loadSidebar, ...options }) {
        if (routeReady && !await routeReady) return null;
        if (!authorize()) return null;
        loadHeader();
        loadSidebar('spoof-attempts');
        const controller = createController(options);
        controller.bind();
        await controller.load();
        return controller;
    }

    const api = { dateValue, filterRows, summary, renderRow, fetchAll, resolveProfiles, createController, start };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SpoofAttempts = api;
})(typeof window !== 'undefined' ? window : globalThis);
