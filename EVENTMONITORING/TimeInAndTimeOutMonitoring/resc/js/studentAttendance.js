/* ============================================================
   resc/js/studentAttendance.js
   Replaces PHP queries with Supabase JS client for Attendance
============================================================ */

// ── Get department logos from session ─────────────────────────
function getDeptLogos() {
    try {
        const user = JSON.parse(sessionStorage.getItem('user') || '{}');
        return {
            deptLogo: user.departmentLogo || '../resc/assets/ccs_logo.png',
            deptName: user.department || 'College of Computer Studies',
            deptCode: user.departmentCode || 'CCS',
        };
    } catch (e) {
        return {
            deptLogo: '../resc/assets/ccs_logo.png',
            deptName: 'College of Computer Studies',
            deptCode: 'CCS',
        };
    }
}

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let META = {};
let sessionMode = false;
let currentSessionId = null;
let scheduleEnrollmentCounts = {};
let attendanceCharts = {
    subjectBreakdown: null,
    professorBreakdown: null,
    semesterBreakdown: null,
};
let attendanceChartsModal = {
    subjectBreakdown: null,
    professorBreakdown: null,
    semesterBreakdown: null,
};
let _engineLastPhase = null;
let _engineLastSummaryTs = null;
function startEngineStatusPolling(intervalMs = 5000) {
    if (typeof fetchEngineStatus !== 'function') return;
    fetchEngineStatus();
    setInterval(fetchEngineStatus, intervalMs);
}

function initAutoFilters() {
    const search = document.getElementById('filterSearch');
    const date = document.getElementById('filterDate');
    const subject = document.getElementById('filterSubject');
    const course = document.getElementById('filterCourse');
    const lab = document.getElementById('filterLab');
    const prof = document.getElementById('filterProf');
    const section = document.getElementById('filterSection');
    const status = document.getElementById('filterStatus');
    const chartGroupBy = document.getElementById('chartGroupBy');

    if (search) {
        search.addEventListener('input', executeClientFilter);
        search.addEventListener('keyup', executeClientFilter);
    }

    if (date) {
        date.addEventListener('change', () => {
            populateDynamicFilters();
            executeClientFilter();
        });
    }

    [subject, course, lab, prof, section, status].forEach((el) => {
        if (el) el.addEventListener('change', executeClientFilter);
    });

    if (chartGroupBy) {
        chartGroupBy.addEventListener('change', updateAttendanceCharts);
    }
}

// ────────────────────────────────────────────
// 1. DATA LOADING & DYNAMIC DROPDOWNS
// ────────────────────────────────────────────
function populateDynamicFilters() {
    const date = document.getElementById('filterDate').value;
    const baseData = date ? allAttendance.filter(a => a.session_date === date) : allAttendance;

    const subMap = new Map();
    const labMap = new Map();
    const profMap = new Map();
    const secSet = new Set();
    const courseSet = new Set(); // ← ADD THIS
    const semSet = new Set();

    baseData.forEach(a => {
        if (a.subject_id) subMap.set(a.subject_id, { id: a.subject_id, code: a.subject_code, name: a.subject_name });
        if (a.lab_id) labMap.set(a.lab_id, { id: a.lab_id, code: a.lab_code, name: a.lab_name });
        if (a.professor_id) profMap.set(a.professor_id, { id: a.professor_id, name: a.professor_name });
        const ys = getYearSectionDisplay(a);
        if (ys && ys !== '—') secSet.add(ys);
        if (a.course) courseSet.add(a.course); // ← ADD THIS
        const semLabel = getSemesterLabel(a);
        if (semLabel) semSet.add(semLabel);
    });

    const currentSub = document.getElementById('filterSubject').value;
    const currentLab = document.getElementById('filterLab').value;
    const currentProf = document.getElementById('filterProf').value;
    const currentSec = document.getElementById('filterSection').value;
    const currentCourse = document.getElementById('filterCourse').value; // ← ADD THIS
    // Preserve per-chart selects so repopulating options doesn't unexpectedly reset user selections
    const currentChartSubject = document.getElementById('chartSubjectSelect')?.value || '';
    const currentChartProfessor = document.getElementById('chartProfessorSelect')?.value || '';
    const currentChartSemester = document.getElementById('chartSemesterSelect')?.value || '';
    const currentChartSubjectSemester = document.getElementById('chartSubjectSemesterSelect')?.value || '';
    const currentChartProfessorSemester = document.getElementById('chartProfessorSemesterSelect')?.value || '';

    populateSelect('filterSubject', Array.from(subMap.values()).sort((a,b) => a.code.localeCompare(b.code)), s => s.id, s => `${s.code} - ${s.name}`);
    populateSelect('filterLab', Array.from(labMap.values()).sort((a,b) => a.code.localeCompare(b.code)), l => l.id, l => `${l.code} - ${l.name}`);
    try {
        const chartSub = document.getElementById('chartSubjectSelect');
        if (chartSub) {
            const opts = Array.from(subMap.values()).sort((a,b) => a.code.localeCompare(b.code))
                .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' - ' + s.name)}</option>`).join('');
            chartSub.innerHTML = `<option value="">All Subjects</option>${opts}`;
            // restore previous chart subject selection if still available
            if (currentChartSubject && subMap.has(currentChartSubject)) chartSub.value = currentChartSubject;
            if (!chartSub._bound) {
                chartSub.addEventListener('change', () => { updateSubjectChart(); });
                chartSub._bound = true;
            }
        }
    } catch (e) {
        // ignore transient UI sync errors
    }
    if (currentLab && labMap.has(currentLab)) document.getElementById('filterLab').value = currentLab;
    if (currentProf && profMap.has(currentProf)) document.getElementById('filterProf').value = currentProf;
    if (currentSec && secSet.has(currentSec)) document.getElementById('filterSection').value = currentSec;

    // Populate chart-local selects for the graph modal only
    try {
        const chartSub = document.getElementById('chartSubjectSelect');
        if (chartSub) {
            const opts = Array.from(subMap.values()).sort((a,b) => a.code.localeCompare(b.code))
                .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' - ' + s.name)}</option>`).join('');
            chartSub.innerHTML = `<option value="">All Subjects</option>${opts}`;
            if (currentChartSubject && subMap.has(currentChartSubject)) chartSub.value = currentChartSubject;
            if (!chartSub._bound) {
                chartSub.addEventListener('change', () => { updateSubjectChart(); });
                chartSub._bound = true;
            }
        }

        const chartProf = document.getElementById('chartProfessorSelect');
        if (chartProf) {
            const pop = Array.from(profMap.values()).sort((a,b) => a.name.localeCompare(b.name))
                .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
            chartProf.innerHTML = `<option value="">All Professors</option>${pop}`;
            if (currentChartProfessor && profMap.has(currentChartProfessor)) chartProf.value = currentChartProfessor;
            if (!chartProf._bound) {
                chartProf.addEventListener('change', () => { updateProfessorChart(); });
                chartProf._bound = true;
            }
        }
        // Populate semester selects for modal (global + per-chart)
        const chartSem = document.getElementById('chartSemesterSelect');
        const chartSubSem = document.getElementById('chartSubjectSemesterSelect');
        const chartProfSem = document.getElementById('chartProfessorSemesterSelect');
        const semOpts = Array.from(semSet).sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

        if (chartSem) {
            chartSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;
            if (currentChartSemester && Array.from(semSet).includes(currentChartSemester)) chartSem.value = currentChartSemester;
            if (!chartSem._bound) {
                chartSem.addEventListener('change', () => { updateSemesterChart(); });
                chartSem._bound = true;
            }
        }

        if (chartSubSem) {
            chartSubSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;
            if (currentChartSubjectSemester && Array.from(semSet).includes(currentChartSubjectSemester)) chartSubSem.value = currentChartSubjectSemester;
            if (!chartSubSem._bound) {
                chartSubSem.addEventListener('change', () => { updateSubjectChart(); });
                chartSubSem._bound = true;
            }
        }

        if (chartProfSem) {
            chartProfSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;
            if (currentChartProfessorSemester && Array.from(semSet).includes(currentChartProfessorSemester)) chartProfSem.value = currentChartProfessorSemester;
            if (!chartProfSem._bound) {
                chartProfSem.addEventListener('change', () => { updateProfessorChart(); });
                chartProfSem._bound = true;
            }
        }
    } catch (e) {
        // ignore UI sync errors
    }
}

function populateSelect(id, data, valFn, textFn) {
    const select = document.getElementById(id);
    const defaultText = select.options[0].text;
    const options = data ? data.map(item => `<option value="${valFn(item)}">${escapeHtml(textFn(item))}</option>`).join('') : '';
    select.innerHTML = `<option value="">${defaultText}</option>${options}`;
}

function parseSessionLabFromNotes(notes) {
    const txt = String(notes || '');
    const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
    if (!m || !m[1]) return null;
    const label = m[1].trim();
    const parts = label.split(' - ');
    if (parts.length >= 2) {
        return { lab_code: parts[0].trim(), lab_name: parts.slice(1).join(' - ').trim() };
    }
    return { lab_code: label, lab_name: '' };
}

async function loadAttendanceData() {
    const tbody = document.getElementById('attendanceBody');
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading attendance data...</p></td></tr>`;

    let query = supabaseClient
        .from('lab_attendance')
        .select(`
            attendance_id, time_in, time_out, time_in_status, late_minutes, duration_minutes, verified_by_facial_recognition,
            students ( student_id, id_number, first_name, middle_name, last_name, course, year_level, section, profile_picture ),
            lab_sessions ( 
                session_id, session_date, status, actual_start_time, notes,
                lab_schedules (
                    schedule_id, section, day_of_week, start_time, end_time, semester, school_year,
                    subjects ( subject_id, subject_code, subject_name ),
                    professors ( professor_id, first_name, last_name ),
                    laboratory_rooms ( lab_id, lab_code, lab_name )
                )
            )
        `)
        .order('time_in', { ascending: false });
    
    try {
        const { data, error } = await query;
        if (error) {
            console.error('Supabase error details:', error);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            console.error('Error details:', error.details);
            console.error('Error hint:', error.hint);
            throw error;
        }

        allAttendance = data.filter(d => d.lab_sessions && d.students && d.lab_sessions.lab_schedules).map(d => {
            const st = d.students;
            const sess = d.lab_sessions;
            const sch = sess.lab_schedules;
            const sessLab = parseSessionLabFromNotes(sess.notes);
            
            return {
                attendance_id: d.attendance_id,
                time_in: d.time_in,
                time_out: d.time_out,
                time_in_status: d.time_in_status,
                late_minutes: d.late_minutes || 0,
                duration_minutes: d.duration_minutes,
                verified_by_facial_recognition: d.verified_by_facial_recognition,
                
                student_id: st.student_id,
                id_number: st.id_number,
                student_name: `${st.first_name} ${st.last_name}`,
                student_full_name: `${st.first_name} ${st.middle_name || ''} ${st.last_name}`.replace(/\s+/g, ' ').trim(),
                course: st.course,
                year_level: st.year_level,
                student_section: st.section,
                profile_picture: st.profile_picture,
                initials: (st.first_name[0] + st.last_name[0]).toUpperCase(),

                session_id: sess.session_id,
                session_status: sess.status,
                session_date: sess.session_date,
                actual_start_time: sess.actual_start_time,
                schedule_id: sch.schedule_id,
                class_section: sch.section,
                day_of_week: sch.day_of_week,
                sched_start: sch.start_time,
                sched_end: sch.end_time,
                semester: sch.semester,
                school_year: sch.school_year,
                
                subject_id: sch.subjects.subject_id,
                subject_code: sch.subjects.subject_code,
                subject_name: sch.subjects.subject_name,
                
                professor_id: sch.professors.professor_id,
                professor_name: `${sch.professors.first_name} ${sch.professors.last_name}`,
                
                // Prefer the session's actual laboratory when available
                lab_id: sch.laboratory_rooms.lab_id,
                lab_code: (sessLab && sessLab.lab_code) || sch.laboratory_rooms.lab_code,
                lab_name: (sessLab && sessLab.lab_name) || sch.laboratory_rooms.lab_name
            };
        });

        document.querySelectorAll('.stats-row .skeleton, #attendanceBody .skeleton, #rmTableBody .skeleton').forEach(el => el.classList.remove('skeleton'));
        scheduleEnrollmentCounts = {};
        const scheduleIds = [...new Set(allAttendance.map(a => a.schedule_id).filter(Boolean))];
        if (scheduleIds.length > 0) {
            const { data: enrolledRows, error: enrolledError } = await supabaseClient
                .from('schedule_enrollments')
                .select('schedule_id, student_id')
                .eq('status', 'enrolled')
                .in('schedule_id', scheduleIds);

            if (enrolledError) {
                console.error('Error fetching schedule enrollment counts:', enrolledError);
            } else {
                const enrollmentMap = new Map();
                (enrolledRows || []).forEach((row) => {
                    if (!row.schedule_id) return;
                    if (!enrollmentMap.has(row.schedule_id)) {
                        enrollmentMap.set(row.schedule_id, new Set());
                    }
                    enrollmentMap.get(row.schedule_id).add(row.student_id);
                });

                scheduleIds.forEach((scheduleId) => {
                    scheduleEnrollmentCounts[scheduleId] = enrollmentMap.has(scheduleId)
                        ? enrollmentMap.get(scheduleId).size
                        : 0;
                });
            }
        }

        // Populate dropdowns based on the fetched data
        populateDynamicFilters();
        
        executeClientFilter(); 

    } catch (error) {
        console.error('Error fetching attendance:', error);
        const msg = (error && (error.message || error.toString())) || 'Unknown error';
        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="empty-state" style="color:var(--red)">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <p>Error loading attendance: ${escapeHtml(msg)}</p>
                    <p style="font-size:13px;color:var(--text-muted);margin-top:8px">If this persists, check your Supabase configuration in config/.env.js and ensure the app can reach the Supabase endpoint.</p>
                </td>
            </tr>`;

        // If running locally, populate with lightweight mock data so the UI can be tested.
        try {
            const host = window.location.hostname || '';
            if (host.includes('localhost') || host === '127.0.0.1') {
                const today = new Date();
                const yyyy = today.getFullYear();
                const mm = String(today.getMonth() + 1).padStart(2, '0');
                const dd = String(today.getDate()).padStart(2, '0');
                const dateStr = `${yyyy}-${mm}-${dd}`;
                const sampleScheduleId = 9999;
                allAttendance = [
                    {
                        attendance_id: 'm1', time_in: `${dateStr}T08:10:00`, time_out: `${dateStr}T10:00:00`, time_in_status: 'on_time', late_minutes: 0, duration_minutes: 110, verified_by_facial_recognition: false,
                        student_id: 1, id_number: 'S1001', student_name: 'Juan Dela Cruz', student_full_name: 'Juan M Dela Cruz', course: 'BSIT', year_level: '1', student_section: 'A', profile_picture: null, initials: 'JD',
                        session_id: 111, session_status: 'completed', session_date: dateStr, actual_start_time: `${dateStr}T08:00:00`, schedule_id: sampleScheduleId, class_section: 'A', day_of_week: 'Mon', sched_start: '08:00', sched_end: '10:00', semester: '2nd', school_year: '2025-2026',
                        subject_id: 201, subject_code: 'COMP105', subject_name: 'Information Management', professor_id: 301, professor_name: 'Juanito Alvarez', lab_id: 401, lab_code: 'LAB1', lab_name: 'Computer Lab 1'
                    },
                    {
                        attendance_id: 'm2', time_in: null, time_out: null, time_in_status: 'absent', late_minutes: 0, duration_minutes: null, verified_by_facial_recognition: false,
                        student_id: 2, id_number: 'S1002', student_name: 'Maria Clara', student_full_name: 'Maria Clara', course: 'BSIT', year_level: '1', student_section: 'A', profile_picture: null, initials: 'MC',
                        session_id: 111, session_status: 'completed', session_date: dateStr, actual_start_time: `${dateStr}T08:00:00`, schedule_id: sampleScheduleId, class_section: 'A', day_of_week: 'Mon', sched_start: '08:00', sched_end: '10:00', semester: '2nd', school_year: '2025-2026',
                        subject_id: 201, subject_code: 'COMP105', subject_name: 'Information Management', professor_id: 301, professor_name: 'Juanito Alvarez', lab_id: 401, lab_code: 'LAB1', lab_name: 'Computer Lab 1', is_absent: true
                    }
                ];

                scheduleEnrollmentCounts = {};
                scheduleEnrollmentCounts[sampleScheduleId] = 20;

                populateDynamicFilters();
                executeClientFilter();
                showToast('Supabase unreachable — showing local mock data');
            }
        } catch (e) {
            // ignore mock fallback errors
        }
    }
}

// ─────────────────────────────────────────────────────────
// SESSION MODE: load enrolled-but-not-timed-in students
// ─────────────────────────────────────────────────────────
async function loadAbsentStudents(sessionId) {
    // 1. Fetch session + its schedule
    const { data: session, error: sessErr } = await supabaseClient
        .from('lab_sessions')
        .select(`
            session_id, session_date, actual_start_time, notes,
            lab_schedules (
                schedule_id, section, day_of_week, start_time, end_time,
                subjects     ( subject_id, subject_code, subject_name ),
                professors   ( professor_id, first_name, last_name ),
                laboratory_rooms ( lab_id, lab_code, lab_name )
            )
        `)
        .eq('session_id', sessionId)
        .single();

    if (sessErr || !session) { console.error('loadAbsentStudents – session fetch:', sessErr); return; }

    const sch  = session.lab_schedules;
    session.laboratory_rooms = parseSessionLabFromNotes(session.notes) || sch?.laboratory_rooms;

    // 2. Show info banner
    showSessionBanner(session);

    // 3. Fetch all enrolled students for this schedule
    const { data: enrollments, error: enrErr } = await supabaseClient
        .from('schedule_enrollments')
        .select(`
            students (
                student_id, id_number,
                first_name, middle_name, last_name,
                course, year_level, section, profile_picture
            )
        `)
        .eq('schedule_id', sch.schedule_id)
        .eq('status', 'enrolled');

    if (enrErr || !enrollments) { console.error('loadAbsentStudents – enrollments fetch:', enrErr); return; }

    // 4. Build the set of student IDs that already timed in this session
    const timedInIds = new Set(
        allAttendance
            .filter(a => a.session_id === sessionId)
            .map(a => a.student_id)
    );

    // 5. Build "ghost" absent records for everyone else
    const absentRecords = enrollments
        .filter(e => e.students && !timedInIds.has(e.students.student_id))
        .map(e => {
            const st = e.students;
            return {
                attendance_id: `absent_${st.student_id}_${sessionId}`,
                time_in:    null,
                time_out:   null,
                time_in_status: 'absent',
                late_minutes:   0,
                duration_minutes: null,
                verified_by_facial_recognition: false,
                is_absent: true,

                student_id:        st.student_id,
                id_number:         st.id_number,
                student_name:      `${st.first_name} ${st.last_name}`,
                student_full_name: `${st.first_name} ${st.middle_name || ''} ${st.last_name}`.replace(/\s+/g, ' ').trim(),
                course:        st.course,
                year_level:    st.year_level,
                student_section: st.section,
                profile_picture: st.profile_picture,
                initials: ((st.first_name?.[0] || '') + (st.last_name?.[0] || '')).toUpperCase(),

                session_id:        session.session_id,
                session_date:      session.session_date,
                actual_start_time: session.actual_start_time,
                class_section: sch.section,
                day_of_week:   sch.day_of_week,
                sched_start:   sch.start_time,
                sched_end:     sch.end_time,

                subject_id:   sch.subjects.subject_id,
                subject_code: sch.subjects.subject_code,
                subject_name: sch.subjects.subject_name,

                professor_id:   sch.professors.professor_id,
                professor_name: `${sch.professors.first_name} ${sch.professors.last_name}`,

                lab_id:   sch.laboratory_rooms.lab_id,
                lab_code: sch.laboratory_rooms.lab_code,
                lab_name: sch.laboratory_rooms.lab_name
            };
        });

    allAttendance = [...allAttendance, ...absentRecords];
    populateDynamicFilters();
    executeClientFilter();
}

function showSessionBanner(session) {
    // Don't add twice
    if (document.getElementById('sessionBanner')) return;
    const sch  = session.lab_schedules;
    const subj = sch.subjects;
    const lab  = session.laboratory_rooms || sch.laboratory_rooms;

    const banner = document.createElement('div');
    banner.id = 'sessionBanner';
    banner.style.cssText = [
        'background:#f0fdf4', 'border:1px solid #bbf7d0', 'border-radius:10px',
        'padding:12px 18px', 'margin-bottom:16px', 'display:flex',
        'align-items:center', 'gap:12px', 'font-size:13px', 'color:#166534',
        'flex-wrap:wrap'
    ].join(';');
    banner.innerHTML = `
        <i class="fa-solid fa-desktop" style="font-size:18px;flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
            <strong>${escapeHtml(subj.subject_code)} — ${escapeHtml(subj.subject_name)}</strong>
            &nbsp;·&nbsp; Section: <strong>${escapeHtml(sch.section)}</strong>
            &nbsp;·&nbsp; ${escapeHtml(lab.lab_code)}
            &nbsp;·&nbsp; <span style="font-weight:400">Showing full class roster (timed in + not yet timed in)</span>
        </div>
        <a href="laboratorySessions.html"
           style="margin-left:auto;color:#166534;font-size:12px;text-decoration:none;white-space:nowrap;font-weight:600">
            <i class="fa-solid fa-arrow-left"></i> Back to Sessions
        </a>
    `;

    const hr = document.querySelector('.main-content hr');
    if (hr) hr.after(banner);
}

// ────────────────────────────────────────────
// 2. FILTERING & RENDERING
// ────────────────────────────────────────────
window.applyFilters = function() {
    executeClientFilter();
}

window.resetFilters = function() {
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterDate').value = '';
    document.getElementById('filterSubject').value = '';
    document.getElementById('filterCourse').value = '';
    document.getElementById('filterLab').value = '';
    document.getElementById('filterProf').value = '';
    document.getElementById('filterSection').value = '';
    document.getElementById('filterStatus').value = '';
    populateDynamicFilters();
    executeClientFilter();
}
function executeClientFilter() {
    const q    = document.getElementById('filterSearch').value.toLowerCase().trim();
    const date = document.getElementById('filterDate').value;
    const sub  = document.getElementById('filterSubject').value;
    const course = document.getElementById('filterCourse').value;
    const lab  = document.getElementById('filterLab').value;
    const prof = document.getElementById('filterProf').value;
    const sec  = document.getElementById('filterSection').value;
    const stat = document.getElementById('filterStatus').value;

    filteredAttendance = allAttendance.filter(a => {
        // Absent (ghost) rows only appear in session mode
        if (a.is_absent && !sessionMode) return false;

        if (date && a.session_date !== date) return false;
        if (sub  && a.subject_id  != sub)  return false;
        if (course && String(a.course || '') !== course) return false;
        if (lab  && a.lab_id      != lab)  return false;
        if (prof && a.professor_id != prof) return false;
        if (sec  && getYearSectionDisplay(a) !== sec) return false;

        // When in session mode, lock to this session
        if (sessionMode && currentSessionId && a.session_id !== currentSessionId) return false;

        if (stat) {
            if (stat === 'not_timed_in' && !a.is_absent)                            return false;
            if (stat !== 'not_timed_in' && a.is_absent)                             return false;
            if (stat === 'present'      && (a.time_out !== null || a.is_absent))    return false;
            if (stat === 'completed'    && (a.time_out === null  || a.is_absent))   return false;
            if (stat === 'late'         && (a.time_in_status !== 'late' || a.is_absent)) return false;
        }

        if (q) {
            const searchStr = `${a.student_name} ${a.id_number}`.toLowerCase();
            if (!searchStr.includes(q)) return false;
        }

        return true;
    });

    updateStats();
    renderTable();
    updateAttendanceCharts();
}

function getChartFilterState(chart) {
    // chart: 'subject' | 'professor' | 'semester' | undefined
    switch (chart) {
        case 'subject':
            return {
                subject: document.getElementById('chartSubjectSelect')?.value || '',
                semester: document.getElementById('chartSubjectSemesterSelect')?.value || ''
            };
        case 'professor':
            return {
                professor: document.getElementById('chartProfessorSelect')?.value || '',
                semester: document.getElementById('chartProfessorSemesterSelect')?.value || ''
            };
        case 'semester':
            return {
                semester: document.getElementById('chartSemesterSelect')?.value || ''
            };
        default:
            return {
                subject: document.getElementById('chartSubjectSelect')?.value || '',
                professor: document.getElementById('chartProfessorSelect')?.value || '',
                semester: document.getElementById('chartSemesterSelect')?.value || ''
            };
    }
}

function getChartBaseAttendance(filters) {
    // filters: object returned by getChartFilterState(chart)
    const f = filters || getChartFilterState();

    return allAttendance.filter((row) => {
        if (f.subject && String(row.subject_id) !== String(f.subject)) return false;
        if (f.professor && String(row.professor_id) !== String(f.professor)) return false;
        if (f.semester && String(getSemesterLabel(row)) !== String(f.semester)) return false;
        if (sessionMode && currentSessionId && row.session_id !== currentSessionId) return false;
        // Only include sessions that have been completed so the chart reflects finalized data
        if ((row.session_status || '').toString().toLowerCase() !== 'completed') return false;
        return true;
    });
}

function getSemesterLabel(row) {
    const semester = row?.semester ? String(row.semester).trim() : '';
    const schoolYear = row?.school_year ? String(row.school_year).trim() : '';
    if (semester && schoolYear) return `${semester} ${schoolYear}`;
    if (semester) return semester;
    if (schoolYear) return schoolYear;
    return 'Unassigned Semester';
}

function createGroupMap() {
    return new Map();
}

function addGroupValue(groupMap, key, label, summary) {
    if (!key) return;
    if (!groupMap.has(key)) {
        groupMap.set(key, {
            label,
            total: 0,
            present: 0,
            late: 0,
            absent: 0,
        });
    }

    const target = groupMap.get(key);
    target.total += summary.total;
    target.present += summary.present;
    target.late += summary.late;
    target.absent += summary.absent;
}

function summarizeAttendanceGroups(baseAttendance) {
    const bySchedule = new Map();

    baseAttendance.forEach((row) => {
        if (!row.schedule_id) return;
        if (!bySchedule.has(row.schedule_id)) {
            bySchedule.set(row.schedule_id, []);
        }
        bySchedule.get(row.schedule_id).push(row);
    });

    const subjectGroups = createGroupMap();
    const professorGroups = createGroupMap();
    const semesterGroups = createGroupMap();

    bySchedule.forEach((rows) => {
        const reference = rows[0];
        if (!reference) return;

        const actualRows = rows.filter((row) => !row.is_absent);
        const present = actualRows.filter((row) => row.time_in_status !== 'late').length;
        const late = actualRows.filter((row) => row.time_in_status === 'late').length;
        const enrolled = scheduleEnrollmentCounts[reference.schedule_id] ?? actualRows.length;
        const absent = Math.max(enrolled - actualRows.length, 0);

        const summary = {
            total: enrolled,
            present,
            late,
            absent,
        };

        const subjectLabel = reference.subject_code
            ? `${reference.subject_code}${reference.subject_name ? ` - ${reference.subject_name}` : ''}`
            : 'Unknown Subject';
        const professorLabel = reference.professor_name || 'Unknown Professor';
        const semesterLabel = getSemesterLabel(reference);

        addGroupValue(subjectGroups, reference.subject_id || subjectLabel, subjectLabel, summary);
        addGroupValue(professorGroups, reference.professor_id || professorLabel, professorLabel, summary);
        addGroupValue(semesterGroups, semesterLabel, semesterLabel, summary);
    });

    return {
        subject: Array.from(subjectGroups.values()),
        professor: Array.from(professorGroups.values()),
        semester: Array.from(semesterGroups.values()),
    };
}

function compressGroupList(items, limit = 8) {
    const sorted = [...items].sort((a, b) => b.total - a.total);
    if (sorted.length <= limit) return sorted;

    const visible = sorted.slice(0, Math.max(limit - 1, 1));
    const rest = sorted.slice(Math.max(limit - 1, 1));
    const others = rest.reduce((acc, item) => {
        acc.total += item.total;
        acc.present += item.present;
        acc.late += item.late;
        acc.absent += item.absent;
        return acc;
    }, { label: 'Others', total: 0, present: 0, late: 0, absent: 0 });

    return [...visible, others];
}

function destroyChart(chartInstance) {
    if (chartInstance && typeof chartInstance.destroy === 'function') {
        chartInstance.destroy();
    }
}

function renderAttendanceChart(canvas, previousChart, config) {
    if (!canvas || typeof Chart === 'undefined') return null;

    destroyChart(previousChart);

    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels: config.labels,
            datasets: [
                {
                    label: config.mode === 'percentage' ? 'Present %' : 'Present',
                    data: config.present,
                    backgroundColor: '#40916c',
                    borderRadius: 6,
                    stack: 'attendance',
                },
                {
                    label: config.mode === 'percentage' ? 'Late %' : 'Late',
                    data: config.late,
                    backgroundColor: '#d97706',
                    borderRadius: 6,
                    stack: 'attendance',
                },
                {
                    label: config.mode === 'percentage' ? 'Absent %' : 'Absent',
                    data: config.absent,
                    backgroundColor: '#dc2626',
                    borderRadius: 6,
                    stack: 'attendance',
                },
            ],
        },
        options: (function() {
            const indexAxis = config.indexAxis || 'x';
            const axisIsY = indexAxis === 'y';
            return {
                indexAxis,
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { usePointStyle: true, boxWidth: 10, padding: 16 }
                    },
                    tooltip: {
                        callbacks: {
                            label(context) {
                                const suffix = config.mode === 'percentage' ? '%' : '';
                                const val = config.indexAxis === 'y'
                                    ? context.parsed.x
                                    : context.parsed.y;
                                return `${context.dataset.label}: ${val}${suffix}`;
                            }
                        }
                    },
                    title: { display: Boolean(config.title), text: config.title || '' }
                },
                scales: (function() {
                    if (axisIsY) {
                        return {
                            x: {
                                stacked: true,
                                beginAtZero: true,
                                max: config.mode === 'percentage' ? 100 : undefined,
                                ticks: { color: '#5a7265', callback(value) { return config.mode === 'percentage' ? `${value}%` : value; } },
                                grid: { color: 'rgba(212, 230, 217, 0.6)' }
                            },
                            y: { stacked: true, ticks: { color: '#5a7265', maxRotation: 30, minRotation: 0 }, grid: { display: false } }
                        };
                    }
                    return {
                        x: { stacked: true, ticks: { color: '#5a7265', maxRotation: 30, minRotation: 0 }, grid: { display: false } },
                        y: { stacked: true, beginAtZero: true, max: config.mode === 'percentage' ? 100 : undefined, ticks: { color: '#5a7265', callback(value) { return config.mode === 'percentage' ? `${value}%` : value; } }, grid: { color: 'rgba(212, 230, 217, 0.6)' } }
                    };
                })()
            };
        })(),
    });
}

function updateAttendanceCharts() {
    renderAttendanceChartsFor(
        {
            subjectCanvas: document.getElementById('graphAttendanceSubjectChart'),
            professorCanvas: document.getElementById('graphAttendanceProfessorChart'),
            semesterCanvas: document.getElementById('graphSemesterAttendanceChart'),
        },
        attendanceChartsModal
    );
}

function buildAttendanceChartConfigs() {
    // Build per-chart attendance using each chart's own filters
    const baseAttendanceForSubjects = getChartBaseAttendance(getChartFilterState('subject'));
    const groupedSubjects = summarizeAttendanceGroups(baseAttendanceForSubjects);

    const baseAttendanceForProfessor = getChartBaseAttendance(getChartFilterState('professor'));
    const groupedProfessor = summarizeAttendanceGroups(baseAttendanceForProfessor);

    const baseAttendanceForSemester = getChartBaseAttendance(getChartFilterState('semester'));
    const groupedSemesterOnly = summarizeAttendanceGroups(baseAttendanceForSemester);

    const subjectItems = compressGroupList(groupedSubjects.subject || [], 8);
    const professorItems = compressGroupList(groupedProfessor.professor || [], 8);
    const semesterItems = groupedSemesterOnly.semester || [];

    return {
        subjectConfig: {
            title: 'Subject attendance breakdown',
            labels: subjectItems.map((item) => item.label),
            present: subjectItems.map((item) => item.present),
            late: subjectItems.map((item) => item.late),
            absent: subjectItems.map((item) => item.absent),
            mode: 'counts',
        },
        professorConfig: {
            title: 'Professor attendance breakdown',
            labels: professorItems.map((item) => item.label),
            present: professorItems.map((item) => item.present),
            late: professorItems.map((item) => item.late),
            absent: professorItems.map((item) => item.absent),
            mode: 'counts',
        },
        semesterConfig: {
            title: 'Semester percentage share',
            labels: semesterItems.map((item) => item.label),
            present: semesterItems.map((item) => item.total > 0 ? Number(((item.present / item.total) * 100).toFixed(1)) : 0),
            late: semesterItems.map((item) => item.total > 0 ? Number(((item.late / item.total) * 100).toFixed(1)) : 0),
            absent: semesterItems.map((item) => item.total > 0 ? Number(((item.absent / item.total) * 100).toFixed(1)) : 0),
            mode: 'percentage',
            indexAxis: 'y',
        },
    };
}

// Render/update only a single chart so other charts don't animate when unrelated filters change
function updateSubjectChart() {
    const canvases = { subjectCanvas: document.getElementById('graphAttendanceSubjectChart') };
    const { subjectConfig } = buildAttendanceChartConfigs();
    attendanceChartsModal.subjectBreakdown = renderAttendanceChart(canvases.subjectCanvas, attendanceChartsModal.subjectBreakdown, subjectConfig);
}

function updateProfessorChart() {
    const canvases = { professorCanvas: document.getElementById('graphAttendanceProfessorChart') };
    const { professorConfig } = buildAttendanceChartConfigs();
    attendanceChartsModal.professorBreakdown = renderAttendanceChart(canvases.professorCanvas, attendanceChartsModal.professorBreakdown, professorConfig);
}

function updateSemesterChart() {
    const canvases = { semesterCanvas: document.getElementById('graphSemesterAttendanceChart') };
    const { semesterConfig } = buildAttendanceChartConfigs();
    attendanceChartsModal.semesterBreakdown = renderAttendanceChart(canvases.semesterCanvas, attendanceChartsModal.semesterBreakdown, semesterConfig);
}

function renderAttendanceChartsFor(canvases, chartState) {
    if ((!canvases?.subjectCanvas || !canvases?.professorCanvas || !canvases?.semesterCanvas) || typeof Chart === 'undefined') return;

    if (!Chart.defaults.plugins.legend) {
        Chart.defaults.plugins.legend = {};
    }
    Chart.defaults.font.family = "'Nunito Sans', sans-serif";

    const { subjectConfig, professorConfig, semesterConfig } = buildAttendanceChartConfigs();

    chartState.subjectBreakdown = renderAttendanceChart(canvases.subjectCanvas, chartState.subjectBreakdown, subjectConfig);
    chartState.professorBreakdown = renderAttendanceChart(canvases.professorCanvas, chartState.professorBreakdown, professorConfig);
    chartState.semesterBreakdown = renderAttendanceChart(canvases.semesterCanvas, chartState.semesterBreakdown, semesterConfig);
}

function updateStats() {
    META.total    = filteredAttendance.length;
    META.stillIn  = 0;
    META.timedOut = 0;
    META.late     = 0;
    META.absent   = 0;
    const uniqueSessions = new Set();

    filteredAttendance.forEach(a => {
        if (a.is_absent) { META.absent++; return; }
        if (!a.time_out) META.stillIn++;
        else             META.timedOut++;
        if (a.time_in_status === 'late') META.late++;
        uniqueSessions.add(a.session_id);
    });

    META.onTime   = (META.stillIn + META.timedOut) - META.late;
    META.sessions = uniqueSessions.size;

    document.getElementById('statTotal').textContent    = META.total;
    document.getElementById('statStillIn').textContent  = META.stillIn;
    document.getElementById('statTimedOut').textContent = META.timedOut;
    document.getElementById('statLate').textContent     = META.late;
    document.getElementById('statSessions').textContent = META.sessions;
    document.getElementById('recordCountBadge').textContent = META.total;

    // Only update absent elements if they exist (session mode)
    const absentEl = document.getElementById('statAbsent');
    if (absentEl) absentEl.textContent = META.absent;

    const absentCard = document.getElementById('statAbsentCard');
    if (absentCard) absentCard.style.display = META.absent > 0 ? '' : 'none';
}
function renderTable() {
    const tbody = document.getElementById('attendanceBody');
    if (filteredAttendance.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="empty-state">
            <i class="fa-solid fa-clipboard-list"></i>
            <h3>No attendance records found</h3>
            <p>Try adjusting your filters or select a different date.</p>
        </td></tr>`;
        return;
    }

    const now = new Date();

    tbody.innerHTML = filteredAttendance.map((row, i) => {

        // ── ABSENT / NOT-YET-TIMED-IN ROW ──────────────────────
        if (row.is_absent) {
            const avatarImg = row.profile_picture
                ? `<img src="../students/uploads/${escapeHtml(row.profile_picture)}" alt="">`
                : row.initials;
            const yearSection = getYearSectionDisplay(row);
            return `
                <tr style="opacity:.75;background:#fef2f2">
                    <td><span class="time-val absent">${i + 1}</span></td>
                    <td>
                        <div class="student-cell">
                            <div class="student-avatar" style="background:#fecaca;color:#991b1b">${avatarImg}</div>
                            <div>
                                <div class="student-name">${escapeHtml(row.student_name)}</div>
                                <div class="student-id">${escapeHtml(row.id_number)}</div>
                            </div>
                        </div>
                    </td>
                    <td>
                        <div style="font-weight:700;font-size:13px;color:var(--green-dark)">${escapeHtml(row.subject_code)}</div>
                        <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(row.subject_name || '—')}</div>
                    </td>
                    <td><span class="time-val">${escapeHtml(row.course || '—')}</span></td>
                    <td><span class="badge badge-gray">${escapeHtml(yearSection)}</span></td>
                    <td><span class="time-val">${escapeHtml(row.lab_code)}</span></td>
                    <td><span class="time-val" style="color:#9ca3af">—</span></td>
                    <td><span class="time-val" style="color:#9ca3af">—</span></td>
                    <td><span class="time-val" style="color:#9ca3af">—</span></td>
                    <td><span class="badge" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600">
                        <i class="fa-solid fa-circle-minus"></i> Not In
                    </span></td>
                    <td><i class="fa-solid fa-circle-xmark" style="color:var(--text-muted);font-size:16px" title="N/A"></i></td>
                    <td></td>
                </tr>`;
        }

        // ── EXISTING TIMED-IN ROW (unchanged logic) ────────────
        const isStillIn = !row.time_out;
        const isLate    = row.time_in_status === 'late';
        const yearSection = getYearSectionDisplay(row);

        let badgeClass, badgeTxt;
        if (isStillIn)       { badgeClass = 'badge-blue';  badgeTxt = '● Inside'; }
        else if (row.time_out){ badgeClass = 'badge-green'; badgeTxt = '✓ Done';  }
        else                  { badgeClass = 'badge-gray';  badgeTxt = '— No record'; }

        const statusBadge = isLate
            ? `<span class="badge badge-amber"><i class="fa-solid fa-clock"></i> Late</span>`
            : `<span class="badge ${badgeClass}">${badgeTxt}</span>`;

        const avatarImg = row.profile_picture
            ? `<img src="../students/uploads/${escapeHtml(row.profile_picture)}" alt="">`
            : row.initials;

        let dur = row.duration_minutes ? `${row.duration_minutes}m` : '—';
        if (isStillIn && row.time_in) {
            const mins = Math.round((now - new Date(row.time_in)) / 60000);
            dur = `${mins}m (ongoing)`;
        }

        const tInFormat  = row.time_in  ? new Date(row.time_in).toLocaleTimeString('en-US',  {hour:'numeric',minute:'2-digit'}) : '—';
        const tOutFormat = row.time_out ? new Date(row.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})
            : (isStillIn ? '<span class="badge badge-blue" style="font-size:10px">Still inside</span>' : '—');
        const dChipFormat = row.time_in ? new Date(row.time_in).toLocaleDateString('en-US', {month:'short', day:'numeric'}) : '';

        return `
            <tr onclick="showDetail('${row.attendance_id}')" style="cursor:pointer">
                <td><span class="time-val absent">${i + 1}</span></td>
                <td>
                    <div class="student-cell">
                        <div class="student-avatar">${avatarImg}</div>
                        <div>
                            <div class="student-name">${escapeHtml(row.student_name)}</div>
                            <div class="student-id">${escapeHtml(row.id_number)}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <div style="font-weight:700;font-size:13px;color:var(--green-dark)">${escapeHtml(row.subject_code)}</div>
                    <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(row.subject_name || '—')}</div>
                </td>
                <td><span class="time-val">${escapeHtml(row.course || '—')}</span></td>
                <td><span class="badge badge-gray">${escapeHtml(yearSection)}</span></td>
                <td><span class="time-val">${escapeHtml(row.lab_code)}</span></td>
                <td>
                    <span class="time-val">${tInFormat}</span>
                    <span class="duration-chip">${dChipFormat}</span>
                </td>
                <td><span class="time-val">${tOutFormat}</span></td>
                <td><span class="time-val" style="font-size:12px">${dur}</span></td>
                <td>${statusBadge}</td>
                <td>
                    ${row.verified_by_facial_recognition
                        ? '<i class="fa-solid fa-circle-check" style="color:var(--green-bright);font-size:16px" title="Face verified"></i>'
                        : '<i class="fa-solid fa-circle-xmark" style="color:var(--text-muted);font-size:16px" title="Manual"></i>'}
                </td>
                <td>
                    <button class="filter-btn" onclick="event.stopPropagation();showDetail('${row.attendance_id}')">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                </td>
            </tr>`;
    }).join('');
}

// Initialization on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Ensure supabase client exists (config.js should create it)
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        console.warn('Supabase client not initialized on DOMContentLoaded. Proceeding — loadAttendanceData may fail.');
    }

    // session mode when opened for a specific session
    const urlParams = new URLSearchParams(window.location.search);
    currentSessionId = urlParams.get('session_id');
    if (currentSessionId) sessionMode = true;

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    if (!sessionMode) {
        const dateEl = document.getElementById('filterDate');
        if (dateEl) dateEl.value = `${yyyy}-${mm}-${dd}`;
    }

    META.genDate = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    await loadAttendanceData();

    if (sessionMode) {
        await loadAbsentStudents(currentSessionId);
    }

    initAutoFilters();
    startEngineStatusPolling();
});

// ────────────────────────────────────────────
// 3. DETAIL MODAL
// ────────────────────────────────────────────
window.showDetail = function(id) {
    const row = filteredAttendance.find(a => a.attendance_id === id);
    if (!row) return;
    const yearSection = getYearSectionDisplay(row);

    const timeIn = row.time_in ? new Date(row.time_in).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : '—';
    const timeOut = row.time_out ? new Date(row.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : 'Still inside';
    
    let dur = row.duration_minutes ? `${row.duration_minutes}m` : '—';
    if (!row.time_out && row.time_in) {
        const mins = Math.round((new Date() - new Date(row.time_in)) / 60000);
        dur = `${mins}m (ongoing)`;
    }

    const face = row.verified_by_facial_recognition
        ? '<span class="badge badge-green"><i class="fa-solid fa-circle-check"></i> Verified</span>'
        : '<span class="badge badge-gray">Manual</span>';
    
    const status = row.time_in_status === 'late'
        ? `<span class="badge badge-amber">Late ${row.late_minutes > 0 ? '('+row.late_minutes+' min)' : ''}</span>`
        : '<span class="badge badge-green">On Time</span>';

    const actStart = row.actual_start_time ? formatTime12Hour(row.actual_start_time) : '';
    const schedStart = formatTime12Hour(row.sched_start);
    const schedEnd = formatTime12Hour(row.sched_end);

    document.getElementById('modalContent').innerHTML = `
        <div class="modal-row"><span class="modal-label">Student</span><span class="modal-val">${escapeHtml(row.student_full_name)}</span></div>
        <div class="modal-row"><span class="modal-label">ID Number</span><span class="modal-val mono">${escapeHtml(row.id_number)}</span></div>
        <div class="modal-row"><span class="modal-label">Course</span><span class="modal-val">${escapeHtml(row.course)}</span></div>
        <div class="modal-row"><span class="modal-label">Subject</span><span class="modal-val">${escapeHtml(row.subject_code)} — ${escapeHtml(row.subject_name)}</span></div>
        <div class="modal-row"><span class="modal-label">Section</span><span class="modal-val">${escapeHtml(yearSection)}</span></div>
        <div class="modal-row"><span class="modal-label">Laboratory</span><span class="modal-val mono">${escapeHtml(row.lab_code)}</span></div>
        <div class="modal-row"><span class="modal-label">Schedule</span><span class="modal-val">${row.day_of_week} &nbsp; ${schedStart} – ${schedEnd}</span></div>
        <div class="modal-row"><span class="modal-label">Professor</span><span class="modal-val">${escapeHtml(row.professor_name)}</span></div>
        ${actStart ? `<div class="modal-row"><span class="modal-label">Prof Started At</span><span class="modal-val mono" style="color:var(--green-bright);font-weight:700">▶ ${actStart}</span></div>` : ''}
        <div class="modal-row"><span class="modal-label">Session Date</span><span class="modal-val">${row.session_date}</span></div>
        <div class="modal-row"><span class="modal-label">Time In</span><span class="modal-val mono">${timeIn}</span></div>
        <div class="modal-row"><span class="modal-label">Time Out</span><span class="modal-val mono">${timeOut}</span></div>
        <div class="modal-row"><span class="modal-label">Duration</span><span class="modal-val mono">${dur}</span></div>
        <div class="modal-row"><span class="modal-label">Arrival Status</span><span class="modal-val">${status}</span></div>
        <div class="modal-row"><span class="modal-label">Face Recognition</span><span class="modal-val">${face}</span></div>
    `;
    document.getElementById('detailModal').classList.add('on');
}

window.closeModal = function() { document.getElementById('detailModal').classList.remove('on'); }

// ────────────────────────────────────────────
// 4. REPORT MODAL & EXPORT
// ────────────────────────────────────────────

let existingReportsToday = []; 

window.fetchTodayReports = async function() {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', 'attendance')
            .like('report_name', `%${dateStr}%`); 
            
        if (data) {
            existingReportsToday = data.map(d => ({
                name: d.report_name,
                dataString: typeof d.report_data === 'string' ? d.report_data : JSON.stringify(d.report_data)
            }));
        } else {
            existingReportsToday = [];
        }
    } catch (e) {
        existingReportsToday = [];
    }
};

window.openReportModal = async function() {
    document.getElementById('rmDisplayDate').textContent = document.getElementById('filterDate').value || 'All Dates';
    document.getElementById('rmRecordCount').textContent = META.total;
    document.getElementById('rmGenDate').textContent = META.genDate;

    document.getElementById('rmTotalChip').textContent = META.total;
    document.getElementById('rmStillInChip').textContent = META.stillIn;
    document.getElementById('rmTimedOutChip').textContent = META.timedOut;
    document.getElementById('rmLateChip').textContent = META.late;
    document.getElementById('rmOnTimeChip').textContent = META.onTime;

    const tbody = document.getElementById('rmTableBody');
    tbody.innerHTML = filteredAttendance.map((row, i) => {
        let dur = row.duration_minutes ? `${row.duration_minutes}m` : '—';
        if (!row.time_out && row.time_in) {
            const mins = Math.round((new Date() - new Date(row.time_in)) / 60000);
            dur = `${mins}m (ongoing)`;
        }
        const yearSection = getYearSectionDisplay(row);
        
        const timeIn = row.time_in ? new Date(row.time_in).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : '—';
        const timeOut = row.time_out ? new Date(row.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : (!row.time_out && row.time_in ? 'Still inside' : '—');
        const schedule = buildScheduleLabel(row);
        
        const isLate = row.time_in_status === 'late';
        const status = isLate ? `Late ${row.late_minutes > 0 ? '('+row.late_minutes+'m)' : ''}` : 'On Time';
        
        return `
        <tr>
            <td style="color:var(--text-muted);font-size:11px">${i+1}</td>
            <td style="font-family:var(--mono);font-size:11.5px;font-weight:700;color:var(--green-dark)">${escapeHtml(row.id_number)}</td>
            <td style="font-weight:700">${escapeHtml(row.student_name)}</td>
            <td style="font-size:12px">${escapeHtml(row.course || '—')}</td>
            <td><span style="background:var(--surface);color:var(--green-dark);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid var(--border)">${escapeHtml(yearSection)}</span></td>
            <td style="font-weight:800;color:var(--green-dark);font-size:12px">${escapeHtml(row.subject_code)}<br><span style="color:var(--text-muted);font-size:10.5px;font-weight:400">${escapeHtml(row.subject_name || '—')}</span></td>
            <td style="font-family:var(--mono);font-size:11.5px;font-weight:600">${escapeHtml(row.lab_code)}</td>
            <td style="font-size:12px">${escapeHtml(row.professor_name)}</td>
            <td style="font-size:11px">${escapeHtml(schedule)}</td>
            <td style="font-family:var(--mono);font-size:11.5px">${row.session_date}</td>
            <td style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--green-dark)">${timeIn}</td>
            <td style="font-family:var(--mono);font-size:11.5px">${timeOut}</td>
            <td style="font-family:var(--mono);font-size:11px">${dur}</td>
            <td><span class="rm-badge ${isLate ? 'inactive' : 'active'}">${status}</span></td>
            <td><span class="rm-badge ${row.verified_by_facial_recognition ? 'active' : 'not-registered'}">${row.verified_by_facial_recognition ? 'Face' : 'Manual'}</span></td>
        </tr>`;
    }).join('');
    
    document.getElementById('rmOverlay').classList.add('on');
    await window.fetchTodayReports(); 
};

window.openGraphModal = function() {
    const overlay = document.getElementById('graphOverlay');
    if (!overlay) return;

    overlay.classList.add('on');
    updateAttendanceCharts();
};

window.closeReportModal = function() { document.getElementById('rmOverlay').classList.remove('on'); }

window.closeGraphModal = function() {
    document.getElementById('graphOverlay')?.classList.remove('on');
    destroyChart(attendanceChartsModal.subjectBreakdown);
    destroyChart(attendanceChartsModal.professorBreakdown);
    destroyChart(attendanceChartsModal.semesterBreakdown);
    attendanceChartsModal.subjectBreakdown = null;
    attendanceChartsModal.professorBreakdown = null;
    attendanceChartsModal.semesterBreakdown = null;
};

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (typeof closeModal === 'function') closeModal();
        closeReportModal();
        closeGraphModal();
    }
});

function formatTime12Hour(timeString) {
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    let h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${minutes} ${ampm}`;
}

function buildScheduleLabel(row) {
    const day = row?.day_of_week || '';
    const start = row?.sched_start ? formatTime12Hour(row.sched_start) : '';
    const end = row?.sched_end ? formatTime12Hour(row.sched_end) : '';

    if (day && start && end) return `${day} ${start} - ${end}`;
    if (day && start) return `${day} ${start}`;
    if (start && end) return `${start} - ${end}`;
    if (day) return day;
    return '—';
}

function formatYearSection(yearLevel, section, classSection) {
    const y = (yearLevel !== null && yearLevel !== undefined && String(yearLevel).trim() !== '')
        ? String(yearLevel).trim()
        : '';
    const sec = section ? String(section).trim().toUpperCase() : '';
    if (y && sec) return `${y}${sec}`;

    const cls = classSection ? String(classSection).trim() : '';
    if (!cls) return '—';

    const m = cls.match(/(\d+)\s*-?\s*([A-Za-z])$/);
    if (m) return `${m[1]}${m[2].toUpperCase()}`;

    const tail = cls.split('-').pop()?.trim();
    return tail || cls;
}

function getYearSectionDisplay(row) {
    return formatYearSection(row?.year_level, row?.student_section, row?.class_section);
}

function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const filterDate = document.getElementById('filterDate').value || 'All Dates';
    const reportName = `Attendance Report [${filterDate}] — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(filteredAttendance);
    
    const isExactDuplicate = existingReportsToday.some(r => 
        r.name === reportName && r.dataString === currentDataString
    );
    
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true; 
}

async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const filterDate = document.getElementById('filterDate').value || 'All Dates';
    const reportName = `Attendance Report [${filterDate}] — ${dateStr} (${exportType})`;

    const payload = {
        report_type: 'attendance',
        report_name: reportName,
        filters:     JSON.stringify({ date: filterDate }),
        report_data: JSON.stringify(filteredAttendance)
    };

    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;
        
        existingReportsToday.push({
            name: payload.report_name,
            dataString: payload.report_data
        }); 
        
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}

// ── PRINT ──────────────────────────────────────────────────
window.printReport = async function() {
    if (filteredAttendance.length === 0) { alert("No records to print."); return; }
    if (!checkDuplicateWarning('Print')) return;

    // Dynamically retrieve department data
    const { deptLogo, deptName, deptCode } = getDeptLogos();

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr  = `${dateStr} at ${timeStr}`;
    const filterD = document.getElementById('filterDate').value || 'All Dates';

    // Simplified table columns for a cleaner attendance table. Redundant session metadata
    // (subject, course, lab, professor, schedule, year/section) is shown under the report header.
    const cols = ['#','Student ID','Name','Time In','Time Out','Dur.','Status','Face'];

    // Build metadata block from the first record (assumes rows are for the same session)
    const metaRec = filteredAttendance[0] || {};
    const metaHtml = `
        <div class="report-details">
            <div class="detail-item">
                <span class="detail-label">Subject:</span>
                <span class="detail-value">${escapeHtml(metaRec.subject_code || '')} — ${escapeHtml(metaRec.subject_name || '')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Course:</span>
                <span class="detail-value">${escapeHtml(metaRec.course || '')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Yr&Sec:</span>
                <span class="detail-value">${escapeHtml(getYearSectionDisplay(metaRec))}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Lab:</span>
                <span class="detail-value">${escapeHtml(metaRec.lab_code || '')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Professor:</span>
                <span class="detail-value">${escapeHtml(metaRec.professor_name || '')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Schedule:</span>
                <span class="detail-value">${escapeHtml(buildScheduleLabel(metaRec))}</span>
            </div>
        </div>`;

    const rows = filteredAttendance.map((r, i) => {
        let dur = r.duration_minutes ? `${r.duration_minutes}m` : '—';
        if (!r.time_out && r.time_in) {
            const mins = Math.round((new Date() - new Date(r.time_in)) / 60000);
            dur = `${mins}m (ong.)`;
        }
        const tIn = r.time_in ? new Date(r.time_in).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : '—';
        const tOut = r.time_out ? new Date(r.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : (!r.time_out && r.time_in ? 'In Lab' : '—');
        const isLate = r.time_in_status === 'late';
        const status = isLate ? `Late (${r.late_minutes}m)` : 'On Time';
        const statusColor = isLate ? '#dc2626' : '#166534';
        const face = r.verified_by_facial_recognition ? 'Face' : 'Manual';
        const faceColor = r.verified_by_facial_recognition ? '#166534' : '#d97706';

        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i+1}</td>
            <td><strong>${r.id_number}</strong></td>
            <td><strong>${r.student_full_name || r.student_name}</strong></td>
            <td>${tIn}</td>
            <td>${tOut}</td>
            <td>${dur}</td>
            <td><span style="color: ${statusColor}; font-weight: bold;">${status.toUpperCase()}</span></td>
            <td><span style="color: ${faceColor}; font-weight: bold;">${face.toUpperCase()}</span></td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Attendance Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:10px;color:#111}
        
        .header-container { 
            background-color: #ffffff; color: #000000; text-align: center; 
            margin-bottom: 20px; padding: 20px 15px; border: 2px solid #000000; border-radius: 8px;
        }
        .logos-text-wrapper { display: flex; justify-content: center; align-items: center; gap: 25px; margin-bottom: 10px; }
        .logo-img { height: 50px; width: auto; object-fit: contain; }
        .univ-title { font-size: 18px; font-weight: bold; color: #000000; line-height: 1.2; letter-spacing: 0.5px;}
        .college-title { font-size: 11px; color: #444444; letter-spacing: 1px; text-transform: uppercase;}
        .report-title { font-size: 16px; font-weight: bold; color: #000000; margin-top: 12px; text-transform: uppercase; letter-spacing: 1px;}
        .report-meta { font-size: 11px; color: #555555; margin-top: 5px; }
        .report-details {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid #d1d5db;
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 6px 16px;
            text-align: left;
            font-size: 10.5px;
        }
        .detail-item { display: flex; gap: 6px; min-width: 0; }
        .detail-label { font-weight: 700; color: #111827; min-width: 58px; white-space: nowrap; }
        .detail-value { color: #111827; word-break: break-word; }

        @media (max-width: 980px) {
            .report-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 700px) {
            .report-details { grid-template-columns: 1fr; }
        }
        
        table{width:100%;border-collapse:collapse; margin-top: 10px; border: 1px solid #000000 !important;}
        th{background:#ffffff;color:#000000;padding:8px 8px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px; border: 1px solid #000000 !important;}
        td{padding:8px 8px;border:1px solid #000000 !important;font-size:10px; text-align:center;}
        td:nth-child(2), td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(8) {text-align:left;} 
        tr:nth-child(even){background:#f9fafb;}
        .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        @media print{body{padding:0px}}
    </style></head><body>
    
    <div class="header-container">
        <div class="logos-text-wrapper">
            <img src="../resc/assets/plp_logo.png" class="logo-img" alt="PLP Logo">
            <div>
                <div class="univ-title">PAMANTASAN NG LUNGSOD NG PASIG</div>
                <div class="college-title">${deptName}</div>
            </div>
            <img src="${deptLogo}" class="logo-img" alt="${deptCode} Logo">
        </div>
        <div class="report-title">STUDENT ATTENDANCE REPORT</div>
        <div class="report-meta">Date: ${filterD} &nbsp;&middot;&nbsp; Generated: ${nowStr} &nbsp;&middot;&nbsp; Total Records: ${filteredAttendance.length}</div>
        ${metaHtml}
    </div>

    <table>
        <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
    </table>
    <div class="footer">Laboratory Attendance System &nbsp;&middot;&nbsp; ${nowStr}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
    w.document.close();

    await autoSaveReport('Print');
};

// ── PDF ────────────────────────────────────────────────────
window.downloadPDF = async function() {
    if (filteredAttendance.length === 0) { alert("No records to export."); return; }
    if (!checkDuplicateWarning('PDF')) return;

    if (!window.jspdf) {
        alert('PDF library not loaded yet. Please try again.');
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc     = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const now     = new Date();
        const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const nowStr  = `${dateStr} at ${timeStr}`;
        const filterD = document.getElementById('filterDate').value || 'All Dates';
        const pageW   = doc.internal.pageSize.width;

        function loadImage(src) {
            return new Promise((resolve) => {
                const img = new Image(); img.crossOrigin = 'anonymous';
                img.onload = () => { try { const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); resolve(canvas.toDataURL('image/png')); } catch(e) { resolve(null); } };
                img.onerror = () => resolve(null); img.src = src;
            });
        }

        const { deptLogo, deptName, deptCode } = getDeptLogos();
        const [plpData, ccsData] = await Promise.all([
            loadImage('../resc/assets/plp_logo.png'),
            loadImage(deptLogo)
        ]);

        const centerX = pageW / 2;
        const headerHeight = 45; 
        
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.1);
        doc.rect(10, 5, pageW - 20, headerHeight, 'S');
        
        const logoSize = 18;
        if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, logoSize, logoSize);
        if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 67, 10, logoSize, logoSize);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
        
        doc.setFontSize(9); doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal');
        doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' });
        
        doc.setFontSize(14); doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold');
        doc.text('STUDENT ATTENDANCE REPORT', centerX, 33, { align: 'center' });
        
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Date: ${filterD}  ·  Generated: ${nowStr}  ·  Total Records: ${filteredAttendance.length}`, centerX, 39, { align: 'center' });

        // Put session metadata under header in the PDF too
        const meta = filteredAttendance[0] || {};
        doc.setFontSize(9); doc.setTextColor(0,0,0); doc.setFont('helvetica', 'normal');
        const metaText = `Subject: ${meta.subject_code || ''} - ${meta.subject_name || ''}  ·  Course: ${meta.course || ''}  ·  Yr&Sec: ${getYearSectionDisplay(meta)}  ·  Lab: ${meta.lab_code || ''}  ·  Professor: ${(meta.professor_name||'')}  ·  ${buildScheduleLabel(meta)}`;
        doc.text(metaText, centerX, 43, { align: 'center' });

        const head = [['#','Student ID','Name','Time In','Time Out','Dur.','Status','Face']];
        const body = filteredAttendance.map((r, i) => {
            let dur = r.duration_minutes ? `${r.duration_minutes}m` : '—';
            if (!r.time_out && r.time_in) {
                const mins = Math.round((new Date() - new Date(r.time_in)) / 60000);
                dur = `${mins}m (ong.)`;
            }
            const tIn = r.time_in ? new Date(r.time_in).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : '—';
            const tOut = r.time_out ? new Date(r.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : (!r.time_out && r.time_in ? 'In Lab' : '—');
            const isLate = r.time_in_status === 'late';
            const status = isLate ? `Late (${r.late_minutes}m)` : 'On Time';
            const face = r.verified_by_facial_recognition ? 'Face' : 'Manual';

            return [i + 1, r.id_number, r.student_full_name || r.student_name, tIn, tOut, dur, status.toUpperCase(), face.toUpperCase()];
        });

        doc.autoTable({
            head, body,
            startY: headerHeight + 12,
            margin: { left: 10, right: 10 },
            tableWidth: 'auto',
            theme: 'grid',
            headStyles: { fillColor: [255,255,255], fontSize: 8, fontStyle: 'bold', textColor: [0,0,0], lineColor: [0,0,0], lineWidth: 0.1, halign: 'center', valign: 'middle' },
            styles: { fontSize: 8, cellPadding: 2, valign: 'middle', lineColor: [0,0,0], lineWidth: 0.1, textColor: [0,0,0] },
            columnStyles: {
                0: { cellWidth: 8, halign: 'center' },
                1: { cellWidth: 20, halign: 'left', fontStyle: 'bold' },
                2: { halign: 'left', fontStyle: 'bold' },
                3: { cellWidth: 16, halign: 'center' },
                4: { cellWidth: 16, halign: 'center' },
                5: { cellWidth: 12, halign: 'center' },
                6: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
                7: { cellWidth: 12, halign: 'center', fontStyle: 'bold' }
            },
            didParseCell(d) {
                if (d.column.index === 6 && d.section === 'body') {
                    const s = (d.cell.text[0] || '').toLowerCase();
                    if (s.includes('late')) { d.cell.styles.textColor = [220, 38, 38]; }
                    else { d.cell.styles.textColor = [22, 101, 52]; }
                }
                if (d.column.index === 7 && d.section === 'body') {
                    const s = (d.cell.text[0] || '').toLowerCase();
                    if (s === 'face' || s === 'registered') { d.cell.styles.textColor = [22, 101, 52]; }
                    if (s === 'manual') { d.cell.styles.textColor = [217, 119, 6]; }
                }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156, 163, 175);
            doc.text(`Laboratory Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`,
                pageW / 2, doc.internal.pageSize.height - 8, { align: 'center' });
        }

        doc.save(`Attendance_Report_${filterD.replace(/\//g,'-')}.pdf`);
        await autoSaveReport('PDF');

    } catch (err) {
        console.error('PDF generation error:', err);
        alert('There was an error generating the PDF. Check the console.');
    }
};

// ── EXCEL ────────────────────────────────────────────────────
window.exportExcel = async function() {
    if (filteredAttendance.length === 0) { alert("No records to export."); return; }
    if (!checkDuplicateWarning('Excel')) return;

    if (!window.XLSX) {
        alert('Excel library not loaded. Please refresh the page.');
        return;
    }

    const wb = XLSX.utils.book_new();
    
    const headers = ['#', 'Student ID', 'Student Name', 'Time In', 'Time Out', 'Duration', 'Status', 'Face Recognition'];

    const rows = filteredAttendance.map((r, i) => {
        let dur = r.duration_minutes ? `${r.duration_minutes}m` : '—';
        if (!r.time_out && r.time_in) {
            const mins = Math.round((new Date() - new Date(r.time_in)) / 60000);
            dur = `${mins}m (ongoing)`;
        }
        const yearSection = getYearSectionDisplay(r);
        
        const tIn = r.time_in ? new Date(r.time_in).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : '—';
        const tOut = r.time_out ? new Date(r.time_out).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) : (!r.time_out && r.time_in ? 'In Lab' : '—');
        const schedule = buildScheduleLabel(r);
        
        const isLate = r.time_in_status === 'late';
        const status = isLate ? `Late (${r.late_minutes}m)` : 'On Time';
        const face = r.verified_by_facial_recognition ? 'Registered' : 'Manual';

        return [i + 1, r.id_number, r.student_full_name || r.student_name, tIn, tOut, dur, status, face];
    });
    // Add metadata rows above the table
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr = `${dateStr} at ${timeStr}`;
    const meta = filteredAttendance[0] || {};

    const metaRow1 = ['Report Generated', nowStr];
    const metaRow2 = [
        'Subject', `${meta.subject_code || ''} - ${meta.subject_name || ''}`,
        'Course', meta.course || '', 'Yr&Sec', getYearSectionDisplay(meta), 'Lab', meta.lab_code || '', 'Professor', (meta.professor_name||''), 'Schedule', buildScheduleLabel(meta)
    ];

    const sheetData = [metaRow1, metaRow2, [], headers, ...rows];
    const dataSheet = XLSX.utils.aoa_to_sheet(sheetData);

    dataSheet['!cols'] = [
        { wch: 6 }, { wch: 15 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 18 }
    ];

    XLSX.utils.book_append_sheet(wb, dataSheet, 'Attendance Records');
    
    const filterD = document.getElementById('filterDate') ? document.getElementById('filterDate').value : 'All_Dates';
    XLSX.writeFile(wb, `Attendance_Report_${filterD.replace(/\//g,'-')}.xlsx`);
    
    await autoSaveReport('Excel');
};

