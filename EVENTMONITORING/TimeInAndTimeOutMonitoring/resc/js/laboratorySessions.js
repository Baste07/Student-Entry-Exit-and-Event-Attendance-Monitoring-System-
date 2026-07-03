/* ============================================================
   laboratories.js — Laboratory Sessions Page Logic
   Path: TimeInAndTimeOutMonitoring/resc/js/laboratories.js

   Schema-aware notes:
   - lab_attendance.time_in / time_out  → timestamptz
   - lab_sessions.actual_end_time       → time without time zone
   - lab_schedules → laboratory_rooms   via lab_id FK
   - All PKs are UUID
   ============================================================ */

const PROFESSOR_START_WINDOW = 45; // minutes (must match professor app config)

// ── Date / Time Helpers ──────────────────────────────────

/** YYYY-MM-DD in local time */
const today = new Date().toLocaleDateString('en-CA');

/** e.g. "Monday" */
const currentDay = new Date().toLocaleDateString('en-US', { weekday: 'long' });

/** Returns current time as HH:MM:SS in local time */
function getCurrentTime() {
    const now = new Date();
    return [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join(':');
}

/**
 * Converts a "HH:MM" or "HH:MM:SS" time string into a full local Date
 * using today as the date base.
 */
function timeToDate(timeStr) {
    if (!timeStr) return null;
    const [h, m, s] = timeStr.split(':');
    const d = new Date();
    d.setHours(+h, +m, +(s || 0), 0);
    return d;
}

/** Format "HH:MM:SS" (time without timezone) → "12:30 PM" */
function formatTime(timeStr) {
    const d = timeToDate(timeStr);
    if (!d) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Format ISO / timestamptz string → "12:30 PM" */
function formatDateTime(dtStr) {
    if (!dtStr) return '';
    return new Date(dtStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function parseSessionLabFromNotes(notes) {
    const txt = String(notes || '');
    const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
    if (!m || !m[1]) return null;
    const label = m[1].trim();
    const parts = label.split(' - ');
    if (parts.length >= 2) {
        return { lab_code: parts[0].trim(), lab_name: parts.slice(1).join(' - ').trim(), building: null };
    }
    return { lab_code: label, lab_name: '', building: null };
}

// ══════════════════════════════════════════════════════════
// AUTO-END
// Sessions auto-complete when current time has passed their scheduled end_time.
//
// Schema notes:
//   lab_sessions.actual_end_time  → time without time zone  (store as "HH:MM:SS")
//   lab_attendance.time_out       → timestamptz             (store as ISO string)
//   lab_attendance.time_in        → timestamptz
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// AUTO-END & AUTO-VOID
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// AUTO-END & AUTO-VOID
// ══════════════════════════════════════════════════════════
async function autoEndSessions() {
    const currentTime = getCurrentTime();
    const now = new Date();
    let count = 0;

    // 1. Handle existing sessions (ongoing, dismissing, scheduled)
    const { data: sessions, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id,
            status,
            schedule_id,
            lab_schedules ( start_time, end_time )
        `)
        .in('status', ['ongoing', 'dismissing', 'scheduled'])
        .eq('session_date', today);

    if (!error && sessions?.length) {
        for (const session of sessions) {
            const startTime = session.lab_schedules?.start_time;
            const endTime = session.lab_schedules?.end_time;
            
            let isExpired = false;
            let isVoidedBy45MinRule = false;

            // Check the 2 rules
            if (endTime && currentTime > endTime) {
                isExpired = true;
            } else if (session.status === 'scheduled' && startTime) {
                const deadline = new Date(timeToDate(startTime).getTime() + PROFESSOR_START_WINDOW * 60000);
                if (now > deadline) {
                    isExpired = true;
                    isVoidedBy45MinRule = true;
                }
            }

            if (!isExpired) continue;

            if (session.status === 'scheduled') {
                const reason = isVoidedBy45MinRule ? 'System Auto-Void: 45-minute grace period elapsed' : 'System Auto-Void: Class ended without professor starting it';
                await supabaseClient.from('lab_sessions').update({
                    status:     'cancelled',
                    notes:      reason,
                    updated_at: new Date().toISOString()
                }).eq('session_id', session.session_id);
                count++;
            } else {
                const { error: sessionErr } = await supabaseClient.from('lab_sessions').update({
                    status:          'completed',
                    actual_end_time: endTime,
                    notes:           'System Auto-End: Schedule time elapsed',
                    updated_at:      new Date().toISOString()
                }).eq('session_id', session.session_id).in('status', ['ongoing', 'dismissing']);

                if (sessionErr) continue;

                const { data: stillInside } = await supabaseClient.from('lab_attendance')
                    .select('attendance_id, time_in')
                    .eq('session_id', session.session_id)
                    .not('time_in', 'is', null)
                    .is('time_out', null);

                if (stillInside?.length) {
                    const timeOutDate = timeToDate(endTime);
                    for (const att of stillInside) {
                        const timeInDate   = new Date(att.time_in);
                        const durationMins = Math.max(0, Math.floor((timeOutDate - timeInDate) / 60_000));
                        await supabaseClient.from('lab_attendance').update({
                            time_out:         timeOutDate.toISOString(),
                            duration_minutes: durationMins,
                            updated_at:       new Date().toISOString()
                        }).eq('attendance_id', att.attendance_id);
                    }
                }
                count++;
            }
        }
    }

    // 2. Handle phantom classes (Professor never scanned, so no session was ever created)
    const { data: schedules } = await supabaseClient
        .from('lab_schedules')
        .select(`schedule_id, start_time, end_time`)
        .eq('day_of_week', currentDay)
        .eq('status', 'active');

    if (schedules) {
        for (const sch of schedules) {
            let isExpired = false;
            
            if (sch.end_time && currentTime > sch.end_time) {
                isExpired = true;
            } else if (sch.start_time) {
                const deadline = new Date(timeToDate(sch.start_time).getTime() + PROFESSOR_START_WINDOW * 60000);
                if (now > deadline) {
                    isExpired = true;
                }
            }

            if (isExpired) {
                const { data: existingSess } = await supabaseClient
                    .from('lab_sessions')
                    .select('session_id')
                    .eq('schedule_id', sch.schedule_id)
                    .eq('session_date', today)
                    .maybeSingle();

                if (!existingSess) {
                    await supabaseClient.from('lab_sessions').insert({
                        schedule_id:  sch.schedule_id,
                        session_date: today,
                        status:       'cancelled',
                        notes:        'System Auto-Void: 45-minute grace period elapsed',
                        created_at:   new Date().toISOString(),
                        updated_at:   new Date().toISOString()
                    });
                    count++;
                }
            }
        }
    }
    return count;
}
// ══════════════════════════════════════════════════════════
// AUTO-TRANSITION: dismissing → ongoing ("STAY IN")
// When every student who timed in has timed out, revert to ongoing.
// ══════════════════════════════════════════════════════════
async function autoTransitionStayIn() {
    const { data: sessions, error } = await supabaseClient
        .from('lab_sessions')
        .select('session_id')
        .eq('status', 'dismissing')
        .eq('session_date', today);

    if (error) { console.error('autoTransitionStayIn fetch:', error); return 0; }
    if (!sessions?.length) return 0;

    let count = 0;

    for (const session of sessions) {
        const { count: stillInside, error: cntErr } = await supabaseClient
            .from('lab_attendance')
            .select('attendance_id', { count: 'exact', head: true })
            .eq('session_id', session.session_id)
            .not('time_in', 'is', null)
            .is('time_out', null);

        if (cntErr || stillInside > 0) continue;

        const { error: updateErr } = await supabaseClient
            .from('lab_sessions')
            .update({
                status:     'ongoing',
                updated_at: new Date().toISOString()
            })
            .eq('session_id', session.session_id)
            .eq('status', 'dismissing');

        if (!updateErr) count++;
    }

    return count;
}

// ══════════════════════════════════════════════════════════
// FETCH: Active sessions (ongoing / dismissing)
// ══════════════════════════════════════════════════════════
async function fetchActiveSessions() {
   const { data, error } = await supabaseClient
    .from('lab_sessions')
    .select(`
        session_id,
        actual_start_time,
        actual_dismiss_time,
        status,
        notes,
            lab_schedules (
                schedule_id,
                start_time,
                end_time,
                section,
                professor_id,
                subjects         ( subject_code, subject_name ),
                professors       ( first_name, last_name ),
                laboratory_rooms ( lab_code, lab_name, building )
            ),
            lab_attendance ( student_id )
        `)
        .eq('session_date', today)
        .in('status', ['ongoing', 'dismissing'])
        .order('session_id');

    if (error) { console.error('fetchActiveSessions:', error); return []; }

    return Promise.all((data || []).map(async s => {
        const scheduleId = s.lab_schedules?.schedule_id;

        const { count: totalEnrolled } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', scheduleId)
            .eq('status', 'enrolled');

        const studentsPresent = new Set((s.lab_attendance || []).map(a => a.student_id)).size;

        return {
            ...s,
            laboratory_rooms: parseSessionLabFromNotes(s.notes),
            students_present: studentsPresent,
            total_enrolled:   totalEnrolled || 0
        };
    }));
}

// ══════════════════════════════════════════════════════════
// FETCH: Scheduled sessions (within start window, not yet terminal)
// ══════════════════════════════════════════════════════════
async function fetchScheduledSessions() {
    const currentTime = getCurrentTime();

    const { data, error } = await supabaseClient
        .from('lab_schedules')
        .select(`
            schedule_id,
            start_time,
            end_time,
            section,
            subjects         ( subject_code, subject_name ),
            professors       ( first_name, last_name ),
            laboratory_rooms ( lab_code, lab_name, building ),
            lab_sessions     ( session_id, status, session_date )
        `)
        .eq('day_of_week', currentDay)
        .eq('status', 'active');

    if (error) { console.error('fetchScheduledSessions:', error); return []; }

    const filtered = (data || []).filter(sch => {
        const todaySessions = (sch.lab_sessions || []).filter(s => s.session_date === today);

        const hasBlockingSession = todaySessions.some(s =>
            ['ongoing', 'dismissing', 'completed', 'cancelled'].includes(s.status)
        );
        if (hasBlockingSession) return false;

        const minsSinceStart = (timeToDate(currentTime) - timeToDate(sch.start_time)) / 60_000;
        return minsSinceStart <= PROFESSOR_START_WINDOW;
    });

    return Promise.all(filtered.map(async sch => {
        const { count: totalEnrolled } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', sch.schedule_id)
            .eq('status', 'enrolled');

        const todaySession   = (sch.lab_sessions || []).find(s => s.session_date === today);
        const sessionStatus  = todaySession?.status || 'not_created';
        const minsSinceStart = (timeToDate(currentTime) - timeToDate(sch.start_time)) / 60_000;

        return {
            ...sch,
            session_status:   sessionStatus,
            total_enrolled:   totalEnrolled || 0,
            mins_since_start: minsSinceStart
        };
    })).then(list => list.sort((a, b) => a.start_time.localeCompare(b.start_time)));
}

// ══════════════════════════════════════════════════════════
// FETCH: Completed sessions today
// ══════════════════════════════════════════════════════════
async function fetchCompletedSessions() {
    const { data, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id,
            session_date,
            actual_start_time,
            actual_end_time,
            notes,
            lab_schedules (
                schedule_id,
                section,
                professor_id,
                subjects         ( subject_id, subject_code, subject_name ),
                professors       ( first_name, last_name ),
                laboratory_rooms ( lab_code, lab_name )
            ),
            lab_attendance ( student_id )
        `)
        .eq('session_date', today)
        .eq('status', 'completed')
        .order('actual_end_time', { ascending: false });

    if (error) { console.error('fetchCompletedSessions:', error); return []; }

    return Promise.all((data || []).map(async s => {
        const scheduleId = s.lab_schedules?.schedule_id;

        const { count: totalEnrolled } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', scheduleId)
            .eq('status', 'enrolled');

        const studentsAttended = new Set((s.lab_attendance || []).map(a => a.student_id)).size;

        return {
            ...s,
            laboratory_rooms: parseSessionLabFromNotes(s.notes),
            students_attended: studentsAttended,
            total_enrolled:    totalEnrolled || 0
        };
    }));
}

// ══════════════════════════════════════════════════════════
// FETCH: Cancelled / voided sessions today
// ══════════════════════════════════════════════════════════
async function fetchCancelledSessions() {
    const { data, error } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id,
            updated_at,
            notes,
            lab_schedules (
                schedule_id,
                section,
                start_time,
                subjects         ( subject_code, subject_name ),
                professors       ( first_name, last_name ),
                laboratory_rooms ( lab_code, lab_name )
            )
        `)
        .eq('session_date', today)
        .eq('status', 'cancelled')
        .order('updated_at', { ascending: false });

    if (error) { console.error('fetchCancelledSessions:', error); return []; }

    return Promise.all((data || []).map(async s => {
        const scheduleId = s.lab_schedules?.schedule_id;

        const { count: totalEnrolled } = await supabaseClient
            .from('schedule_enrollments')
            .select('enrollment_id', { count: 'exact', head: true })
            .eq('schedule_id', scheduleId)
            .eq('status', 'enrolled');

        return {
            ...s,
            laboratory_rooms: parseSessionLabFromNotes(s.notes),
            total_enrolled: totalEnrolled || 0
        };
    }));
}

// ══════════════════════════════════════════════════════════
// RENDER: Active session card
// ══════════════════════════════════════════════════════════
function renderActiveCard(s) {
    const sch  = s.lab_schedules;
    const subj = sch?.subjects;
    const prof = sch?.professors;
    const lab  = s.laboratory_rooms || sch?.laboratory_rooms;

const isDismissing = s.status === 'dismissing';
// STAY IN = was dismissed (actual_dismiss_time is set) but all students
// already left so autoTransitionStayIn() flipped it back to 'ongoing'
const isStayIn     = s.status === 'ongoing' && !!s.actual_dismiss_time;
    const pct          = s.total_enrolled > 0
        ? Math.round((s.students_present / s.total_enrolled) * 100) : 0;

    let statusClass, statusLabel;
    if (isDismissing) {
        statusClass = 'dismissing';
        statusLabel = `<i class="fa-solid fa-door-open"></i> DISMISSING`;
    } else if (isStayIn) {
        statusClass = 'ongoing';
        statusLabel = `<i class="fa-solid fa-rotate-left"></i> STAY IN`;
    } else {
        statusClass = 'ongoing';
        statusLabel = `<i class="fa-solid fa-broadcast-tower"></i> LIVE`;
    }

    return `
        <div class="card ${isDismissing ? 'dismissing' : 'ongoing'}">
            <span class="status ${statusClass}">${statusLabel}</span>

            <div class="card-title">${subj?.subject_code || ''}</div>
            <div class="card-subtitle">${subj?.subject_name || ''}</div>

            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || ''}</strong> — ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-building"></i> ${lab?.building || ''}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section: <strong>${sch?.section || ''}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${formatTime(sch?.start_time)} — ${formatTime(sch?.end_time)}</div>

            ${s.actual_start_time ? `
            <div class="detail" style="color:#166534;font-weight:600;">
                <i class="fa-solid fa-play-circle" style="color:#22c55e;"></i>
                Started at: <strong>${formatTime(s.actual_start_time)}</strong>
                <span style="font-size:11px;color:#888;font-weight:400;margin-left:4px;">(actual)</span>
            </div>` : ''}

            ${isDismissing ? `
            <div class="notice" style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;margin-top:10px">
                <i class="fa-solid fa-door-open"></i>
                <div><strong>Dismissal enabled</strong> — Students can now scan out and leave the lab. Will auto-revert to STAY IN when all students exit.</div>
            </div>` : ''}

            <div class="attendance-stat"><strong>${s.students_present}/${s.total_enrolled}</strong> present (${pct}%)</div>
           <button class="btn" onclick="location.href='studentAttendance.html?session_id=${s.session_id}'">
                <i class="fa-solid fa-eye"></i> View Students
            </button>
        </div>
    `;
}

// ══════════════════════════════════════════════════════════
// RENDER: Scheduled session card
// ══════════════════════════════════════════════════════════
function renderScheduledCard(s) {
    const subj      = s.subjects;
    const prof      = s.professors;
    const lab       = s.laboratory_rooms || s.lab_schedules?.laboratory_rooms;
    const isWaiting = s.session_status === 'scheduled';
    const minsUntil = (timeToDate(s.start_time) - timeToDate(getCurrentTime())) / 60_000;

    let noticeHtml;
    if (isWaiting) {
        noticeHtml = `
            <div class="notice waiting">
                <i class="fa-solid fa-user-clock"></i> Waiting for professor to start session
            </div>`;
    } else if (minsUntil > 0) {
        const hrs     = Math.floor(minsUntil / 60);
        const mins    = Math.floor(minsUntil % 60);
        const timeStr = hrs > 0 ? `${hrs}h ${mins > 0 ? mins + 'm' : ''}` : `${mins}m`;
        noticeHtml = `
            <div class="notice" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">
                <i class="fa-solid fa-hourglass-start"></i>
                Starts in ${timeStr.trim()} &mdash; at ${formatTime(s.start_time)}
            </div>`;
    } else {
        const overMins = Math.abs(Math.floor(minsUntil));
        const oHrs     = Math.floor(overMins / 60);
        const oMins    = overMins % 60;
        const overStr  = oHrs > 0 ? `${oHrs}h ${oMins > 0 ? oMins + 'm' : ''}` : `${oMins}m`;
        noticeHtml = `
            <div class="notice" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">
                <i class="fa-solid fa-triangle-exclamation"></i>
                Should have started ${overStr.trim()} ago &mdash; at ${formatTime(s.start_time)}
            </div>`;
    }

    return `
        <div class="card scheduled">
            <span class="status ${isWaiting ? 'waiting' : 'scheduled'}">${isWaiting ? '⏳ Waiting' : 'Scheduled'}</span>

            <div class="card-title">${subj?.subject_code || ''}</div>
            <div class="card-subtitle">${subj?.subject_name || ''}</div>

            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || ''}</strong> — ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-building"></i> ${lab?.building || ''}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section: <strong>${s.section || ''}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${formatTime(s.start_time)} — ${formatTime(s.end_time)}</div>

            ${noticeHtml}

            <div class="attendance-stat"><strong>${s.total_enrolled}</strong> students enrolled</div>
        </div>
    `;
}

// ══════════════════════════════════════════════════════════
// RENDER: Completed session card
// ══════════════════════════════════════════════════════════
function renderCompletedCard(s) {
    const sch          = s.lab_schedules;
    const subj         = sch?.subjects;
    const prof         = sch?.professors;
    const lab          = s.laboratory_rooms || sch?.laboratory_rooms;
    const pct          = s.total_enrolled > 0
        ? Math.round((s.students_attended / s.total_enrolled) * 100) : 0;
    const wasAutoEnded = (s.notes || '').includes('auto time out')
                      || (s.notes || '').includes('Auto-ended:');

    // actual_start_time / actual_end_time → "time without time zone" (HH:MM:SS)
    const startDisplay = formatTime(s.actual_start_time);
    const endDisplay   = formatTime(s.actual_end_time);
    const subjectId    = subj?.subject_id  || '';
    const professorId  = sch?.professor_id || '';

    return `
        <div class="card completed">
            <span class="status completed">${wasAutoEnded ? '⏰ Auto-Ended' : 'Completed'}</span>

            <div class="card-title">${subj?.subject_code || ''}</div>
            <div class="card-subtitle">${subj?.subject_name || ''}</div>

            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || ''}</strong> — ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section: <strong>${sch?.section || ''}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> ${startDisplay} — ${endDisplay}</div>

            ${wasAutoEnded ? `
            <div class="notice" style="background:#fffbeb;border-color:#fde68a;color:#92400e;margin-top:10px">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <div>Professor forgot to end the session. Students were auto timed-out at ${endDisplay}</div>
            </div>` : ''}

            <div class="attendance-stat"><strong>${s.students_attended}/${s.total_enrolled}</strong> attended (${pct}%)</div>
            <a class="btn-attendance"
               href="studentAttendance.html?date=${encodeURIComponent(s.session_date)}&session_id=${s.session_id}&subject_id=${subjectId}&professor_id=${professorId}">
                <i class="fa-solid fa-clipboard-user"></i> View Attendance
            </a>
        </div>
    `;
}
// ══════════════════════════════════════════════════════════
// RENDER: Cancelled / voided session card
// ══════════════════════════════════════════════════════════
function renderCancelledCard(s) {
    const sch         = s.lab_schedules;
    const subj        = sch?.subjects;
    const prof        = sch?.professors;
    const lab         = s.laboratory_rooms || sch?.laboratory_rooms;
    
    // Make it case-insensitive to catch 'Auto-Void', 'auto-void', etc.
    const notesLower  = (s.notes || '').toLowerCase(); 
    const isAutoVoid  = notesLower.includes('auto-void');
    const isAutoEnd   = notesLower.includes('auto time out') || notesLower.includes('auto-end');
    const cancelledAt = formatDateTime(s.updated_at); 

    let noticeContent;
    if (isAutoVoid) {
        noticeContent = `<strong>Auto-voided at ${cancelledAt}</strong><br>
            Professor did not start the session and the scheduled time has elapsed.`;
    } else if (isAutoEnd) {
        noticeContent = `<strong>Auto-ended at ${cancelledAt}</strong><br>
            Professor forgot to end the session. All students were auto timed-out.`;
    } else {
        noticeContent = `Voided at ${cancelledAt}`;
    }

    return `
        <div class="card cancelled">
            <span class="status cancelled">${isAutoVoid ? '🤖 Auto-Voided' : isAutoEnd ? '⏰ Auto-Ended' : 'Cancelled'}</span>

            <div class="card-title">${subj?.subject_code || ''}</div>
            <div class="card-subtitle">${subj?.subject_name || ''}</div>

            <div class="detail"><i class="fa-solid fa-door-open"></i> <strong>${lab?.lab_code || ''}</strong> — ${lab?.lab_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-chalkboard-teacher"></i> ${prof?.first_name || ''} ${prof?.last_name || ''}</div>
            <div class="detail"><i class="fa-solid fa-users"></i> Section: <strong>${sch?.section || ''}</strong></div>
            <div class="detail"><i class="fa-solid fa-clock"></i> Was scheduled: ${formatTime(sch?.start_time)}</div>

            <div class="notice cancelled">
                <i class="fa-solid fa-circle-exclamation"></i>
                <div>${noticeContent}</div>
            </div>

            <div class="attendance-stat"><strong>${s.total_enrolled}</strong> enrolled students affected</div>
        </div>
    `;
}

// ══════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════
function updateStats(active, scheduled, completed, cancelled) {
    const dismissingCnt = active.filter(s => s.status === 'dismissing').length;

    document.getElementById('activeCnt').textContent     = active.length;
    document.getElementById('scheduledCnt').textContent  = scheduled.length;
    document.getElementById('completedCnt').textContent  = completed.length;
    document.getElementById('cancelledCnt').textContent  = cancelled.length;
    document.getElementById('dismissingCnt').textContent = dismissingCnt;

    document.getElementById('activeCountBadge').textContent    = active.length;
    document.getElementById('scheduledCountBadge').textContent = scheduled.length;
    document.getElementById('completedCountBadge').textContent = completed.length;
    document.getElementById('cancelledCountBadge').textContent = cancelled.length;

    document.getElementById('dismissingStat').style.display = dismissingCnt > 0 ? 'flex' : 'none';
    document.getElementById('cancelledStat').style.display  = cancelled.length > 0 ? 'flex' : 'none';
}

function showNotices(autoEndedCount, stayInCount) {
    let html = '';

    if (stayInCount > 0) {
        html += `
            <div class="notice-bar green">
                <i class="fa-solid fa-rotate-left"></i>
                <strong>${stayInCount} session${stayInCount > 1 ? 's' : ''} auto-transitioned to STAY IN</strong>
                — All students who entered have now left. Session returned to ongoing status.
            </div>`;
    }

    if (autoEndedCount > 0) {
        html += `
            <div class="notice-bar yellow">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <strong>${autoEndedCount} session${autoEndedCount > 1 ? 's' : ''} auto-ended</strong>
                — Professor${autoEndedCount > 1 ? 's' : ''} forgot to end the session.
                All remaining students have been timed out.
            </div>`;
    }

    document.getElementById('noticeContainer').innerHTML = html;
}

// ══════════════════════════════════════════════════════════
// MAIN LOAD
// ══════════════════════════════════════════════════════════
async function loadPage() {
    // 1. Run auto-operations first (mirrors PHP logic at top of page)
    const [autoEndedCount, stayInCount] = await Promise.all([
        autoEndSessions(),
        autoTransitionStayIn()
    ]);

    // 2. Show notices
    showNotices(autoEndedCount, stayInCount);

    // 3. Fetch all session data in parallel
    const [active, scheduled, completed, cancelled] = await Promise.all([
        fetchActiveSessions(),
        fetchScheduledSessions(),
        fetchCompletedSessions(),
        fetchCancelledSessions()
    ]);

    // 4. Update stats bar
    updateStats(active, scheduled, completed, cancelled);

    // 5. Render Active
    document.getElementById('activeGrid').innerHTML = active.length
        ? active.map(renderActiveCard).join('')
        : `<div class="empty">
               <i class="fa-solid fa-desktop"></i>
               <h3>No Active Sessions</h3>
               <p>No ongoing sessions at the moment</p>
           </div>`;

    // 6. Render Scheduled
    document.getElementById('scheduledGrid').innerHTML = scheduled.length
        ? scheduled.map(renderScheduledCard).join('')
        : `<div class="empty">
               <i class="fa-solid fa-calendar-xmark"></i>
               <h3>No More Sessions Today</h3>
               <p>All sessions completed or expired</p>
           </div>`;

    // 7. Render Completed (hidden when empty)
    const completedSection = document.getElementById('completedSection');
    if (completed.length > 0) {
        completedSection.style.display = 'block';
        document.getElementById('completedGrid').innerHTML = completed.map(renderCompletedCard).join('');
    } else {
        completedSection.style.display = 'none';
    }

    // 8. Render Cancelled (hidden when empty)
    const cancelledSection = document.getElementById('cancelledSection');
    if (cancelled.length > 0) {
        cancelledSection.style.display = 'block';
        document.getElementById('cancelledGrid').innerHTML = cancelled.map(renderCancelledCard).join('');
    } else {
        cancelledSection.style.display = 'none';
    }
}

// Initial load + auto-refresh every 60 seconds (mirrors PHP page reload)
loadPage();
setInterval(loadPage, 60_000);