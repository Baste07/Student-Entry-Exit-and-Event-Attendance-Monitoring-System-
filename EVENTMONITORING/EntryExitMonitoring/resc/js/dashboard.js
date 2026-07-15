/* ============================================================
   StudentEntryExit/resc/js/dashboard.js
============================================================ */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
    if (!supabaseClient) { console.error('Supabase not initialised.'); return; }
    loadStats();
    loadRecentLogs();
    // Refresh every 30s for live feel
    setInterval(() => { loadStats(); loadRecentLogs(); }, 30000);
});

function getManilaNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
}

async function loadStats() {
    const today = getManilaNow().toLocaleDateString('en-CA'); // YYYY-MM-DD

    try {
        // Total students
        const { count: totalStudents } = await supabaseClient
            .from('students')
            .select('*', { count: 'exact', head: true });

        // All entry-exit logs for today
        const { data: todayLogs } = await supabaseClient
            .from('entry_exit_logs')
            .select('student_id, log_type')
            .eq('log_date', today);

        const entries = (todayLogs || []).filter(l => l.log_type === 'entry');
        const exits   = (todayLogs || []).filter(l => l.log_type === 'exit');

        // "Currently inside" = students who have an entry but whose last record is an entry
        const studentLastLog = {};
        (todayLogs || []).forEach(l => { studentLastLog[l.student_id] = l.log_type; });
        const insideCount = Object.values(studentLastLog).filter(t => t === 'entry').length;

        setEl('statTotalStudents', totalStudents ?? 0);
        setEl('statEnteredToday',  entries.length);
        setEl('statInsideCampus',  insideCount);
        setEl('statExitedToday',   exits.length);
    } catch (e) {
        console.error('[dashboard] loadStats error:', e);
    }
}

async function loadRecentLogs() {
    const tbody = document.getElementById('recentLogsBody');
    try {
        const { data: logs, error } = await supabaseClient
            .from('entry_exit_logs')
            .select(`
                id, log_type, scan_method, log_timestamp,
                students ( stud_id, first_name, last_name, grade_level, section_name )
            `)
            .order('log_timestamp', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!logs || logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">No activity yet today.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(log => {
            const s   = log.students || {};
            const name = `${s.last_name || '—'}, ${s.first_name || '—'}`;
            const time = log.log_timestamp
                ? new Date(log.log_timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '—';
            const typeBadge   = log.log_type === 'entry'
                ? '<span class="badge badge-entry"><i class="fa-solid fa-door-open"></i> Entry</span>'
                : '<span class="badge badge-exit"><i class="fa-solid fa-right-from-bracket"></i> Exit</span>';
            const methodBadge = methodBadgeHtml(log.scan_method);
            return `<tr>
                <td>${name}</td>
                <td>${s.stud_id || '—'}</td>
                <td>${s.grade_level || '—'} — ${s.section_name || '—'}</td>
                <td>${typeBadge}</td>
                <td>${methodBadge}</td>
                <td>${time}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        console.error('[dashboard] loadRecentLogs error:', e);
        tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">Failed to load logs.</td></tr>`;
    }
}

function methodBadgeHtml(method) {
    switch ((method || '').toLowerCase()) {
        case 'face':   return '<span class="badge badge-face"><i class="fa-solid fa-face-smile"></i> Face</span>';
        case 'qr':     return '<span class="badge badge-qr"><i class="fa-solid fa-qrcode"></i> QR</span>';
        case 'manual': return '<span class="badge badge-manual"><i class="fa-solid fa-hand"></i> Manual</span>';
        default:       return `<span class="badge">${method || '—'}</span>`;
    }
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function showToast(msg) {
    const t = document.getElementById('toast');
    const m = document.getElementById('toastMsg');
    if (!t || !m) return;
    m.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}