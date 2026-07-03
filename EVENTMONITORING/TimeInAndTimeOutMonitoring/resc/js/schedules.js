/* ============================================================
   resc/js/schedules.js
   Replaces PHP queries with Supabase JS client for Schedules
============================================================ */

// ── Get department logos from session ─────────────────────────
function getDeptLogos() {
    try {
        const user = JSON.parse(sessionStorage.getItem('user') || '{}');
        return {
            deptLogo: user.departmentLogo || '../resc/assets/ccs_logo.png',
            deptName: user.department     || 'College of Computer Studies',
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

let allSchedules = [];
let META = { total: 0, active: 0, inactive: 0, date: '' };
let currentActiveSemester = { term: '', label: '' };
const SCHEDULE_STATUSES = new Set(['active', 'inactive']);
const DAY_VALUES = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialized.');
        return;
    }
    
    META.date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    document.getElementById('rmGenDate').textContent = `Generated ${META.date}`;

    // Set default School Year in modal form
    const yr = new Date().getFullYear();
    document.getElementById('schoolYear').value = `${yr}-${yr+1}`;

    await loadDropdowns();
    bindSchedulePreviewEvents();
    await loadSchedulesData();
    initFilters();
    initConflictChecker();
});

function bindSchedulePreviewEvents() {
    ['professorId', 'subjectId', 'section', 'labId', 'dayOfWeek', 'startTime', 'endTime', 'schedStatus'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', updateSchedulePreview);
            element.addEventListener('input', updateSchedulePreview);
        }
    });
}

function updateScheduleProgress() {
    const requiredIds = [
        'professorId', 'subjectId', 'section', 'labId',
        'dayOfWeek', 'startTime', 'endTime', 'semester', 'schoolYear', 'schedStatus'
    ];

    const filled = requiredIds.reduce((count, id) => {
        const element = document.getElementById(id);
        if (!element) return count;
        return element.value && String(element.value).trim() !== '' ? count + 1 : count;
    }, 0);

    const percent = Math.round((filled / requiredIds.length) * 100);
    const progressText = document.getElementById('scheduleProgressText');
    const progressHint = document.getElementById('scheduleProgressHint');
    const progressBar = document.getElementById('scheduleProgressBar');

    if (progressText) progressText.textContent = `Form completion: ${percent}%`;
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressHint) {
        progressHint.textContent = percent >= 100
            ? 'Ready to save.'
            : `Filled ${filled}/${requiredIds.length} required fields.`;
    }
}

function getSelectedText(selectId) {
    const element = document.getElementById(selectId);
    if (!element) return '--';
    const selected = element.options?.[element.selectedIndex];
    return selected && selected.textContent ? selected.textContent.trim() : '--';
}

function updateSchedulePreview() {
    const professor = getSelectedText('professorId');
    const subject = getSelectedText('subjectId');
    const section = getSelectedText('section');
    const day = document.getElementById('dayOfWeek')?.value || '--';
    const start = document.getElementById('startTime')?.value || '';
    const end = document.getElementById('endTime')?.value || '';
    const semester = document.getElementById('semesterDisplay')?.value || currentActiveSemester.term || '--';
    const schoolYear = document.getElementById('schoolYearDisplay')?.value || currentActiveSemester.schoolYear || '--';

    const previewMap = [
        ['previewProfessor', professor],
        ['previewSubject', subject],
        ['previewSection', section],
        ['previewTime', day === '--' && !start && !end ? '--' : `${day}${start && end ? `, ${formatTimeStr(start)} - ${formatTimeStr(end)}` : ''}`],
        ['previewSemester', semester],
        ['previewSchoolYear', schoolYear]
    ];

    previewMap.forEach(([id, value]) => {
        const target = document.getElementById(id);
        if (target) target.textContent = value || '--';
    });

    updateScheduleProgress();
}

function normalizeSemesterText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/semester/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSemesterTerm(value) {
    const normalized = normalizeSemesterText(value);
    if (!normalized) return '';

    const match = normalized.match(/^(1st|2nd|3rd|4th)/);
    if (match) return match[1];

    if (normalized.includes('first')) return '1st';
    if (normalized.includes('second')) return '2nd';
    if (normalized.includes('third')) return '3rd';
    if (normalized.includes('fourth')) return '4th';

    return normalized.split(' ')[0] || '';
}

function semesterMatchesActive(importSemester, activeSemesterName) {
    const imported = normalizeSemesterText(importSemester);
    const active = normalizeSemesterText(activeSemesterName);
    if (!imported || !active) return false;
    return imported === active || imported.includes(active) || active.includes(imported);
}

function syncActiveSemesterField(semesterTerm = currentActiveSemester.term, semesterLabel = currentActiveSemester.label) {
    const semesterDisplay = document.getElementById('semesterDisplay');
    const semesterValue = document.getElementById('semester');
    const schoolYearDisplay = document.getElementById('schoolYearDisplay');
    const schoolYearValue = document.getElementById('schoolYear');
    const activeSchoolYear = semesterLabel && semesterLabel.match(/\d{4}-\d{4}/)
        ? semesterLabel.match(/\d{4}-\d{4}/)[0]
        : currentActiveSemester.schoolYear || '';

    if (semesterDisplay) {
        semesterDisplay.innerHTML = '';
        if (semesterTerm) {
            const option = document.createElement('option');
            option.value = semesterTerm;
            option.textContent = `${semesterTerm} Semester`;
            option.selected = true;
            semesterDisplay.appendChild(option);
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No active semester';
            option.selected = true;
            semesterDisplay.appendChild(option);
        }
    }

    if (schoolYearDisplay) {
        schoolYearDisplay.value = activeSchoolYear || '';
    }

    if (semesterValue) {
        semesterValue.value = semesterTerm || '';
        semesterValue.defaultValue = semesterTerm || '';
    }

    if (schoolYearValue) {
        schoolYearValue.value = activeSchoolYear || '';
        schoolYearValue.defaultValue = activeSchoolYear || '';
    }

    updateSchedulePreview();
}

function hasTimeOverlap(startA, endA, startB, endB) {
    return startA < endB && endA > startB;
}

async function hasActiveScheduleConflict(payload, excludeScheduleId = '') {
    const { data, error } = await supabaseClient
        .from('lab_schedules')
        .select('schedule_id, professor_id, lab_id, start_time, end_time')
        .eq('day_of_week', payload.day_of_week)
        .eq('status', 'active');

    if (error) throw error;

    return (data || []).some((row) => {
        if (excludeScheduleId && row.schedule_id === excludeScheduleId) return false;
        const overlaps = hasTimeOverlap(payload.start_time, payload.end_time, row.start_time, row.end_time);
        if (!overlaps) return false;
        return row.professor_id === payload.professor_id || row.lab_id === payload.lab_id;
    });
}

async function loadDropdowns() {
    try {
        // 1. Fetch ALL semesters to populate dropdowns, and identify the active one
        const { data: semestersData } = await supabaseClient
            .from('semesters')
            .select('id, name, start_date, is_active')
            .order('start_date', { ascending: false });

        const activeSem = semestersData?.find(s => s.is_active === true) || null;
        currentActiveSemester = activeSem ? {
            term: extractSemesterTerm(activeSem.name),
            label: activeSem.name,
            schoolYear: activeSem.name.match(/\d{4}-\d{4}/)?.[0] || `${new Date(activeSem.start_date).getFullYear()}-${new Date(activeSem.start_date).getFullYear() + 1}`
        } : { term: '', label: '' };

        // Extract School Year from name (e.g., "2025-2026" from "2nd Semester 2025-2026")
        let activeSchoolYear = '';
        if (activeSem) {
            const yearMatch = activeSem.name.match(/\d{4}-\d{4}/);
            activeSchoolYear = yearMatch ? yearMatch[0] : `${new Date(activeSem.start_date).getFullYear()}-${new Date(activeSem.start_date).getFullYear() + 1}`;
        }

        // Populate Modal Form Semester Dropdown and Auto-Select Active
        syncActiveSemesterField();

        // Auto-fill School Year and keep it locked to the active semester record
        syncActiveSemesterField();

        // Populate Semester Filter Dropdown at the top of the page
        const semesterFilter = document.getElementById('semesterFilter');
        if (semesterFilter) {
            semesterFilter.innerHTML = '<option value="all">All Semesters</option>' +
                (semestersData || []).map(sem => {
                    const semesterTerm = extractSemesterTerm(sem.name);
                    return `<option value="${escapeHtml(semesterTerm)}">${escapeHtml(semesterTerm)} Semester</option>`;
                }).join('');
        }

        // Fetch active professors
        const { data: profs } = await supabaseClient
            .from('professors').select('professor_id, employee_id, first_name, last_name').eq('status', 'active').order('last_name');

        // 2. Fetch subjects, but ONLY those linked to the active semester
        let subjectQuery = supabaseClient
            .from('subjects')
            .select('subject_id, subject_code, subject_name')
            .order('subject_code');

        if (activeSem) {
            subjectQuery = subjectQuery.eq('semester_id', activeSem.id);
        }
        const { data: subjects } = await subjectQuery;

        // Fetch active/reserved labs
        const { data: labs } = await supabaseClient
            .from('laboratory_rooms').select('lab_id, lab_code, lab_name').in('status', ['available', 'reserved']).order('lab_code');

        // Fetch course, year, and section from students table
        const { data: studentsData } = await supabaseClient
            .from('students').select('course, year_level, section');

        const uniqueSections = [...new Set((studentsData || []).map(s => {
            const course = s.course ? s.course.trim() : '';
            const year   = s.year_level ? s.year_level.toString().trim() : '';
            const sec    = s.section ? s.section.trim() : '';

            if (!course && !year && !sec) return null;

            let combined = '';
            if (course) combined += course;
            if (course && (year || sec)) combined += '-';
            combined += `${year}${sec}`;

            return combined;
        }).filter(Boolean))].sort();

        // Populate Form Dropdowns
        populateSelect('professorId', profs, p => p.professor_id, p => `${p.first_name} ${p.last_name} (${p.employee_id})`);

        // This subject dropdown will now ONLY contain subjects from the active semester!
        populateSelect('subjectId', subjects, s => s.subject_id, s => `${s.subject_code} - ${s.subject_name}`);

        populateSelect('labId', labs, l => l.lab_id, l => `${l.lab_code} - ${l.lab_name}`);

        const secSelect = document.getElementById('section');
        secSelect.innerHTML = '<option value="" disabled selected>-- Select Section --</option>' +
            uniqueSections.map(sec => `<option value="${sec}">${sec}</option>`).join('');

        // Populate Filter Dropdown for Labs
        const labFilter = document.getElementById('labFilter');
        if (labFilter) {
            labFilter.innerHTML = '<option value="all">All Laboratories</option>' +
                (labs || []).map(l => `<option value="${l.lab_code}">${l.lab_code} - ${l.lab_name}</option>`).join('');
        }

    } catch (error) {
        console.error("Error loading dropdowns:", error);
    }
}
function populateSelect(id, data, valFn, textFn) {
    const select = document.getElementById(id);
    const options = data ? data.map(item => `<option value="${valFn(item)}">${escapeHtml(textFn(item))}</option>`).join('') : '';
    select.innerHTML = `<option value="" disabled selected>-- Select Option --</option>${options}`;
}

async function loadSchedulesData() {
    try {
        const { data, error } = await supabaseClient
            .from('lab_schedules')
            .select(`
                *,
                professors ( professor_id, first_name, last_name, employee_id ),
                subjects ( subject_id, subject_code, subject_name ),
                laboratory_rooms ( lab_id, lab_code, lab_name ),
                schedule_enrollments ( 
                    enrollment_id, 
                    status,
                    students ( student_id, course, year_level, section )
                ),
                lab_sessions ( session_id, status )
            `)
            .order('day_of_week')
            .order('start_time');

        if (error) throw error;

        META.total = data.length;
        META.active = 0;
        allSchedules = data.map(s => {
            if (s.status === 'active') META.active++;
            
            // Calculate enrolled students and determine the representative section
            let enrolledStudentsList = [];
            if (s.schedule_enrollments) {
                 enrolledStudentsList = s.schedule_enrollments
                    .filter(e => e.status === 'enrolled' && e.students)
                    .map(e => e.students);
            }
            
            const enrolled_count = enrolledStudentsList.length;
            
            // Determine the "Students" column format (e.g., BSIT-3A) based on the first enrolled student.
            // If you want to show a summary of multiple sections if they are mixed, you would handle that here.
            // For now, we will use the section stored in the lab_schedules table, assuming it matches the format you want.
            // If the schedule table's 'section' field is just "A", but you want "BSIT-3A", you must fetch it from the enrolled students.
            
            let displaySection = s.section; // Fallback to schedule's section
            if (enrolledStudentsList.length > 0) {
                 // Attempt to build the string from the first enrolled student's data
                 const firstStudent = enrolledStudentsList[0];
                 const course = firstStudent.course ? firstStudent.course.trim() : '';
                 const year   = firstStudent.year_level ? firstStudent.year_level.toString().trim() : '';
                 const sec    = firstStudent.section ? firstStudent.section.trim() : '';
                 
                 let combined = '';
                 if (course) combined += course;
                 if (course && (year || sec)) combined += '-';
                 combined += `${year}${sec}`;
                 
                 if (combined) {
                     displaySection = combined;
                 }
            }


            const sessionsDone = s.lab_sessions ? s.lab_sessions.filter(ls => ls.status === 'completed').length : 0;

            return {
                ...s,
                profFullName: s.professors ? `${s.professors.first_name} ${s.professors.last_name}` : 'Unknown',
                enrolled_count: enrolled_count,
                sessions_done: sessionsDone,
                display_section: displaySection // Use this for the "Students" column
            };
        });

        META.inactive = META.total - META.active;

        document.getElementById('statTotal').textContent = META.total;
        document.getElementById('statActive').textContent = META.active;
        document.getElementById('statInactive').textContent = META.inactive;


        // NEW: Populate dropdowns dynamically based on loaded schedules
        populateDynamicFilters();
        renderTable(allSchedules);

    } catch (error) {
        console.error('Error loading schedules:', error);
        document.getElementById('schedulesBody').innerHTML = `<tr><td colspan="11" style="text-align:center;color:red;">Error loading data.</td></tr>`;
    }
}

// Format time to 12-Hour AM/PM
function formatTimeStr(timeString) {
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    let h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h.toString().padStart(2, '0')}:${minutes} ${ampm}`;
}

function renderTable(data) {
    const tbody = document.getElementById('schedulesBody');
    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:20px;color:var(--text-muted);">No schedules found.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(s => `
        <tr data-day="${s.day_of_week}" data-status="${s.status}" data-lab="${s.laboratory_rooms?.lab_code || ''}">
            <td class="col-id"><strong class="sched-id">#${s.schedule_id.split('-')[0]}</strong></td>
            <td class="col-prof">
                <div class="professor-chip">
                    <span>${escapeHtml(s.profFullName)}</span>
                    <small>${s.professors?.employee_id || ''}</small>
                </div>
            </td>
            <td class="col-subject">
                <strong class="subject-code">${s.subjects?.subject_code || ''}</strong>
                <span class="muted-line subject-name">${escapeHtml(s.subjects?.subject_name || '')}</span>
            </td>
            <td class="col-students"><span class="students-label">${escapeHtml(s.display_section)}</span></td>
            <td class="col-day"><span class="day-badge">${s.day_of_week}</span></td>
            <td class="col-time">
                <div class="time-stack">
                    <span><i class="fa-solid fa-clock"></i> ${formatTimeStr(s.start_time)}</span>
                    <span>${formatTimeStr(s.end_time)}</span>
                </div>
            </td>
            <td class="col-lab">
                <div class="lab-chip">
                    <span class="lab-code">${s.laboratory_rooms?.lab_code || ''}</span>
                    <small class="lab-name">${escapeHtml(s.laboratory_rooms?.lab_name || '')}</small>
                </div>
            </td>
            <td class="col-semester">
                <strong class="sem-term">${s.semester}</strong>
                <span class="muted-line sem-year">${s.school_year}</span>
            </td>
            <td class="col-status"><span class="status-badge ${s.status}">${s.status}</span></td>
            <td class="col-enrolled">
                <strong class="enrolled-count">${s.enrolled_count}</strong>
                <span class="muted-line">students</span>
            </td>
            <td class="col-actions">
                <div class="table-actions">
                    <button class="action-btn view" title="View Enrollments" onclick="viewEnrollments('${s.schedule_id}')"><i class="fa-solid fa-users"></i> Students</button>
                    <button class="action-btn edit" title="Edit Schedule" onclick='editSchedule(${JSON.stringify(s).replace(/'/g, "&#39;")})'><i class="fa-solid fa-edit"></i> Edit</button>
                    <button class="action-btn delete" title="Delete Schedule" onclick="deleteSchedule('${s.schedule_id}', '${s.subjects?.subject_code} - ${s.section}')"><i class="fa-solid fa-trash"></i> Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}
// ────────────────────────────────────────────
// 2. FILTERS
// ────────────────────────────────────────────
function populateDynamicFilters() {
    const subjectFilter = document.getElementById('subjectFilter');
    const sectionFilter = document.getElementById('sectionFilter');

    if (!subjectFilter || !sectionFilter) return;

    // Get unique subjects
    const subjects = [...new Set(allSchedules.map(s => s.subjects?.subject_code).filter(Boolean))].sort();
    
    // Get unique student sections (e.g., "BSIT-3A")
    const sections = [...new Set(allSchedules.map(s => s.display_section).filter(Boolean))].sort();

    subjectFilter.innerHTML = '<option value="all">All Subjects</option>' + subjects.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    sectionFilter.innerHTML = '<option value="all">All Students</option>' + sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

function initFilters() {
    const search = document.getElementById('searchInput');
    const day = document.getElementById('dayFilter');
    const status = document.getElementById('statusFilter');
    const lab = document.getElementById('labFilter');
    
    // New filters
    const subject = document.getElementById('subjectFilter');
    const semester = document.getElementById('semesterFilter');
    const section = document.getElementById('sectionFilter');

    function apply() {
        const q = search.value.toLowerCase().trim();
        const d = day.value, st = status.value, l = lab.value;
        const sb = subject?.value || 'all', sem = semester?.value || 'all', sec = section?.value || 'all';
        
        const filtered = allSchedules.filter(s => {
            const searchStr = `${s.profFullName} ${s.subjects?.subject_code} ${s.subjects?.subject_name} ${s.display_section} ${s.laboratory_rooms?.lab_code}`.toLowerCase();
            
            const matchQ = !q || searchStr.includes(q);
            const matchD = d === 'all' || s.day_of_week === d;
            const matchSt = st === 'all' || s.status === st;
            const matchL = l === 'all' || s.laboratory_rooms?.lab_code === l;
            
            const matchSb = sb === 'all' || s.subjects?.subject_code === sb;
            const matchSem = sem === 'all' || s.semester === sem;
            const matchSec = sec === 'all' || s.display_section === sec;

            return matchQ && matchD && matchSt && matchL && matchSb && matchSem && matchSec;
        });
        renderTable(filtered);
    }

    search.addEventListener('input', apply);
    [day, status, lab, subject, semester, section].forEach(el => {
        if(el) el.addEventListener('change', apply);
    });

    document.getElementById('clearFilters').addEventListener('click', () => {
        search.value = ''; day.value = 'all'; status.value = 'all'; lab.value = 'all';
        if(subject) subject.value = 'all';
        if(semester) semester.value = 'all';
        if(section) section.value = 'all';
        apply();
    });

    apply();
}

// ────────────────────────────────────────────
// 3. ADD/EDIT & CONFLICT CHECKING
// ────────────────────────────────────────────
document.getElementById('addScheduleBtn').addEventListener('click', () => {
    document.getElementById('scheduleForm').reset();
    document.getElementById('scheduleId').value = '';
    syncActiveSemesterField();
    updateSchedulePreview();
    document.getElementById('schedModalTitleText').textContent = 'Add Schedule';
    document.getElementById('submitBtnText').textContent = 'Save Schedule';
    document.getElementById('conflictWarning').style.display = 'none';
    updateScheduleProgress();
    openSchedModal('scheduleModal');
});

function editSchedule(s) {
    document.getElementById('scheduleId').value = s.schedule_id;
    document.getElementById('professorId').value = s.professor_id;
    document.getElementById('subjectId').value = s.subject_id;
    document.getElementById('section').value = s.display_section; // Use the formatted string for the form
    document.getElementById('labId').value = s.lab_id;
    document.getElementById('dayOfWeek').value = s.day_of_week;
    document.getElementById('startTime').value = s.start_time;
    document.getElementById('endTime').value = s.end_time;
    syncActiveSemesterField();
    updateSchedulePreview();
    document.getElementById('schedStatus').value = s.status;
    updateScheduleProgress();
    
    document.getElementById('schedModalTitleText').textContent = 'Edit Schedule';
    document.getElementById('submitBtnText').textContent = 'Update Schedule';
    document.getElementById('conflictWarning').style.display = 'none';
    openSchedModal('scheduleModal');
}

// Conflict Checker (Real-Time JS Logic)
function initConflictChecker() {
    ['professorId', 'labId', 'dayOfWeek', 'startTime', 'endTime'].forEach(id => {
        document.getElementById(id).addEventListener('change', checkConflict);
    });
}

function checkConflict() {
    const profId = document.getElementById('professorId').value;
    const labId = document.getElementById('labId').value;
    const day = document.getElementById('dayOfWeek').value;
    const start = document.getElementById('startTime').value;
    const end = document.getElementById('endTime').value;
    const schedId = document.getElementById('scheduleId').value;

    if (!profId || !labId || !day || !start || !end) return;

    // Filter local active schedules for overlap
    const conflicts = allSchedules.filter(s => {
        if (s.status !== 'active') return false;
        if (schedId && s.schedule_id === schedId) return false; // Ignore self when editing
        if (s.day_of_week !== day) return false;
        
        // Time overlap logic (A starts before B ends AND A ends after B starts)
        const overlapsTime = start < s.end_time && end > s.start_time;
        
        // Conflict if times overlap AND (it's the same lab OR same professor)
        return overlapsTime && (s.lab_id === labId || s.professor_id === profId);
    });

    const warnDiv = document.getElementById('conflictWarning');
    const submitBtn = document.getElementById('submitBtn');

    if (conflicts.length > 0) {
        let html = `<h4><i class="fa-solid fa-exclamation-triangle"></i> Schedule Conflict!</h4>`;
        conflicts.forEach(c => {
            html += `<div class="conflict-item">
                <strong>${c.subjects?.subject_code} - ${c.display_section}</strong><br>
                Professor: ${c.profFullName}<br>
                Lab: ${c.laboratory_rooms?.lab_code}<br>
                Time: ${formatTimeStr(c.start_time)} - ${formatTimeStr(c.end_time)}
            </div>`;
        });
        html += `<p style="margin-top:10px;font-weight:700">Please adjust time, professor, or laboratory.</p>`;
        warnDiv.innerHTML = html;
        warnDiv.style.display = 'block';
        submitBtn.disabled = true;
    } else {
        warnDiv.style.display = 'none';
        submitBtn.disabled = false;
    }
}

// Form Submission
document.getElementById('scheduleForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const st = document.getElementById('startTime').value;
    const et = document.getElementById('endTime').value;
    if (et <= st) {
        alert('End time must be after start time.');
        return;
    }

    const btn = document.getElementById('submitBtn');
    const ogText = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    const id = document.getElementById('scheduleId').value;
    const formData = new FormData(this);
    const payload = Object.fromEntries(formData.entries());
    delete payload.schedule_id; // Let DB handle/keep ID
    
    // Save the selected format (e.g. BSIT-3A) into the section column
    payload.section = formData.get('section');

    try {
        let savedScheduleId = id;
        
        if (id) {
            const { error } = await supabaseClient.from('lab_schedules').update(payload).eq('schedule_id', id);
            if (error) throw error;
        } else {
            const { data, error } = await supabaseClient.from('lab_schedules').insert([payload]).select();
            if (error) throw error;
            savedScheduleId = data[0].schedule_id;
        }
        
        // ── AUTO-ENROLL STUDENTS MATCHING THE SECTION ──
        await autoEnrollStudents(savedScheduleId, payload.section);

        showToast("Schedule saved and students enrolled!");
        closeSchedModal('scheduleModal');
        await loadSchedulesData();
    } catch (err) {
        alert("Error saving: " + err.message);
    } finally {
        btn.disabled = false; btn.innerHTML = ogText;
    }
});

// ── AUTO-ENROLL LOGIC ──
async function autoEnrollStudents(scheduleId, sectionString) {
     try {
         // Parse the selected section string (e.g., "BSIT-3A")
         let targetCourse = '';
         let targetYear = null;
         let targetSection = '';

         if (sectionString.includes('-')) {
             const parts = sectionString.split('-');
             targetCourse = parts[0];
             // Expecting formats like "3A", "1B"
             if (parts[1] && parts[1].length > 0) {
                  targetYear = parseInt(parts[1][0]);
                  targetSection = parts[1].substring(1);
             }
         }

         // Fetch matching students
         let query = supabaseClient.from('students').select('student_id').eq('status', 'active');
         
         if (targetCourse) query = query.eq('course', targetCourse);
         if (targetYear) query = query.eq('year_level', targetYear);
         if (targetSection) query = query.eq('section', targetSection);

         const { data: matchedStudents, error: fetchErr } = await query;
         if (fetchErr) throw fetchErr;

         if (matchedStudents && matchedStudents.length > 0) {
              // Prepare bulk insert payload
              const enrollments = matchedStudents.map(student => ({
                  schedule_id: scheduleId,
                  student_id: student.student_id,
                  status: 'enrolled'
              }));

              // Delete existing enrollments for this schedule first to avoid duplicates
              await supabaseClient.from('schedule_enrollments').delete().eq('schedule_id', scheduleId);
              
              // Insert new enrollments
              const { error: enrollErr } = await supabaseClient.from('schedule_enrollments').insert(enrollments);
              if (enrollErr) throw enrollErr;
         }
     } catch (err) {
         console.error("Auto-enrollment failed:", err);
         throw err;
     }
}


async function deleteSchedule(id, info) {
    if (!confirm(`Delete schedule for: ${info}?\n\nWarning: Associated sessions and enrollments may be deleted.`)) return;
    try {
        const { error } = await supabaseClient.from('lab_schedules').delete().eq('schedule_id', id);
        if (error) throw error;
        showToast("Schedule removed.");
        await loadSchedulesData();
    } catch(err) {
        alert("Error deleting: " + err.message);
    }
}

// ────────────────────────────────────────────
// 4. VIEW ENROLLMENTS
// ────────────────────────────────────────────
async function viewEnrollments(scheduleId) {
    const s = allSchedules.find(x => x.schedule_id === scheduleId);
    document.getElementById('enrollScheduleInfo').textContent = `${s.subjects.subject_code} | Sec: ${s.display_section} | ${s.day_of_week} ${formatTimeStr(s.start_time)} | Lab: ${s.laboratory_rooms.lab_code}`;
    
    document.getElementById('enrollmentsList').innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;
    openSchedModal('enrollmentsModal');

    try {
        const { data, error } = await supabaseClient
            .from('schedule_enrollments')
            .select(`
                status, created_at,
                students ( student_id, id_number, first_name, last_name, course, year_level, section, facial_dataset_path )
            `)
            .eq('schedule_id', scheduleId)
            .eq('status', 'enrolled');

        if (error) throw error;

        // We filter out any null student records in case of foreign key mismatches
        const validEnrollments = data.filter(e => e.students);

        document.getElementById('enrollCount').textContent = validEnrollments.length;
        const faceReg = validEnrollments.filter(e => e.students.facial_dataset_path).length;
        document.getElementById('faceRegCount').textContent = faceReg;
        document.getElementById('pendingCount').textContent = validEnrollments.length - faceReg;

        const tbody = document.getElementById('enrollmentsList');
        if (validEnrollments.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted)">No students enrolled.</td></tr>';
            return;
        }

        // Sort by last name locally
        validEnrollments.sort((a,b) => a.students.last_name.localeCompare(b.students.last_name));

        tbody.innerHTML = validEnrollments.map(e => {
            const st = e.students;
            const hasFace = !!st.facial_dataset_path;
            const faceHtml = hasFace 
                ? '<span style="color:var(--green-dark);font-weight:700"><i class="fa-solid fa-check-circle"></i> Registered</span>'
                : '<span style="color:#d97706;font-weight:700"><i class="fa-solid fa-exclamation-circle"></i> Pending</span>';
            const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '-';

            return `<tr>
                <td><strong>${escapeHtml(st.id_number)}</strong></td>
                <td><strong>${escapeHtml(st.first_name)} ${escapeHtml(st.last_name)}</strong></td>
                <td>${escapeHtml(st.course || '-')}</td>
                <td>${st.year_level || ''}${st.section || ''}</td>
                <td>${faceHtml}</td>
                <td>${date}</td>
            </tr>`;
        }).join('');

    } catch (err) {
        document.getElementById('enrollmentsList').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--red)">Error loading enrollments.</td></tr>`;
    }
}

// ────────────────────────────────────────────
// 5. UTILS & MODALS
// ────────────────────────────────────────────
function openSchedModal(id) { document.getElementById(id).classList.add('active'); }
function closeSchedModal(id) { document.getElementById(id).classList.remove('active'); }

async function openReportModal() {
    await fetchTodayReports();

    document.getElementById('rmTotalChip').textContent = META.total;
    document.getElementById('rmActiveChip').textContent = META.active;
    document.getElementById('rmInactiveChip').textContent = META.inactive;

    const tbody = document.getElementById('rmTableBody');
    tbody.innerHTML = allSchedules.map((r, i) => `
        <tr>
            <td style="color:var(--text-muted);font-size:11px">${i+1}</td>
            <td style="font-weight:800;color:var(--green-dark);font-size:12px">#${r.schedule_id.split('-')[0]}</td>
            <td><strong>${escapeHtml(r.profFullName)}</strong><br><small style="color:var(--text-muted)">${r.professors?.employee_id || ''}</small></td>
            <td style="font-weight:800;color:var(--green-dark)">${r.subjects?.subject_code || ''}</td>
            <td style="font-size:12px;color:var(--text-body)">${escapeHtml(r.subjects?.subject_name || '')}</td>
            <td style="font-weight:700">${escapeHtml(r.display_section)}</td>
            <td><span class="day-badge">${r.day_of_week}</span></td>
            <td style="white-space:nowrap;font-size:12px">${formatTimeStr(r.start_time)} – ${formatTimeStr(r.end_time)}</td>
            <td style="font-size:12px">${r.laboratory_rooms?.lab_code || ''}<br><span style="color:var(--text-muted);font-size:10.5px">${escapeHtml(r.laboratory_rooms?.lab_name || '')}</span></td>
            <td style="font-size:12px">${r.semester}</td>
            <td style="font-size:12px">${r.school_year}</td>
            <td><span class="rm-badge ${r.status}">${r.status}</span></td>
            <td style="text-align:center"><strong>${r.enrolled_count}</strong></td>
            <td style="text-align:center"><strong>${r.sessions_done}</strong></td>
        </tr>
    `).join('');
    
    document.getElementById('rmOverlay').classList.add('on');
}
function closeReportModal() { document.getElementById('rmOverlay').classList.remove('on'); }

function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 3000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
// ────────────────────────────────────────────
// 6. REPORTS (Print / PDF / CSV / Excel)
// ────────────────────────────────────────────

let existingReportsToday = []; // Tracks reports to prevent exact duplicates

// ── Smart Duplicate Check Helper ──
function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Schedules Report — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(allSchedules);
    
    const isExactDuplicate = existingReportsToday.some(r => 
        r.name === reportName && r.dataString === currentDataString
    );
    
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true; 
}

// ── Pre-fetch Duplicates (Call this when opening your Report Modal) ──
async function fetchTodayReports() {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', 'schedules')
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
}

// ── Auto-save helper ──────────────────────────────────────────
async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Schedules Report — ${dateStr} (${exportType})`;

    const payload = {
        report_type: 'schedules',
        report_name: reportName,
        filters:     JSON.stringify({}),
        report_data: JSON.stringify(allSchedules)
    };

    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;
        
        if (typeof showToast === 'function') showToast(`${exportType} exported and report saved.`);
        
        existingReportsToday.push({
            name: payload.report_name,
            dataString: payload.report_data
        }); 
        
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}
async function printReport() {
    if (!checkDuplicateWarning('Print')) return;

    if (existingReportsToday.length === 0) await fetchTodayReports();

    // Dynamically retrieve department data
    const { deptLogo, deptName } = getDeptLogos();

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr  = `${dateStr} at ${timeStr}`;

    const cols = ['#','Subject','Professor','Section','Lab','Day','Time','Sem / SY','Status','Enrolled','Sessions'];

    const rows = allSchedules.map((r, i) => {
        let statusColor = r.status.toLowerCase() === 'active' ? '#166534' : '#dc2626';
        let timeString = `${formatTimeStr(r.start_time)} - ${formatTimeStr(r.end_time)}`;
        
        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i + 1}</td>
            <td><strong>${r.subjects?.subject_code || '—'}</strong></td>
            <td>${r.profFullName || '—'}</td>
            <td>${r.display_section || '—'}</td>
            <td><strong>${r.laboratory_rooms?.lab_code || '—'}</strong></td>
            <td>${r.day_of_week}</td>
            <td>${timeString}</td>
            <td>${r.semester} / ${r.school_year}</td>
            <td><span style="color: ${statusColor}; font-weight: bold;">${r.status.toUpperCase()}</span></td>
            <td style="text-align:center">${r.enrolled_count || 0}</td>
            <td style="text-align:center">${r.sessions_done || 0}</td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Schedules Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        
        /* ── INK-SAVER WHITE BANNER HEADER ── */
        .header-container { 
            background-color: #ffffff; 
            color: #000000;
            text-align: center; 
            margin-bottom: 20px; 
            padding: 20px 15px; 
            border: 2px solid #000000;
            border-radius: 8px;
        }
        .logos-text-wrapper { display: flex; justify-content: center; align-items: center; gap: 25px; margin-bottom: 10px; }
        .logo-img { height: 50px; width: auto; object-fit: contain; }
        .univ-title { font-size: 18px; font-weight: bold; color: #000000; line-height: 1.2; letter-spacing: 0.5px;}
        .college-title { font-size: 11px; color: #444444; letter-spacing: 1px; text-transform: uppercase;}
        .report-title { font-size: 16px; font-weight: bold; color: #000000; margin-top: 12px; text-transform: uppercase; letter-spacing: 1px;}
        .report-meta { font-size: 11px; color: #555555; margin-top: 5px; }
        
        table{width:100%;border-collapse:collapse; margin-top: 10px; border: 1px solid #000000 !important;}
        th{background:#ffffff; color:#000000; padding:8px 10px; text-align:center; font-size:10px; font-weight:700; text-transform:uppercase; border: 1px solid #000000 !important;}
        td{padding:8px 10px; border: 1px solid #000000 !important; font-size:11px; text-align:center;}
        td:nth-child(2), td:nth-child(3) {text-align:left;}
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
            <img src="${deptLogo}" class="logo-img" alt="Department Logo">
        </div>
        <div class="report-title">Schedules Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Total Schedules: ${allSchedules.length}</div>
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
}

async function downloadPDF() {
    if (!checkDuplicateWarning('PDF')) return;

    if (!window.jspdf) {
        if (typeof showToast === 'function') showToast('PDF library not loaded yet. Please try again.', true);
        else alert('PDF library not loaded yet. Please try again.');
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc     = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const now     = new Date();
        const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const nowStr  = `${dateStr} at ${timeStr}`;
        const pageW   = doc.internal.pageSize.width;

        function loadImage(src) {
            return new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width; canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/png'));
                    } catch(e) { resolve(null); }
                };
                img.onerror = () => resolve(null);
                img.src = src;
            });
        }

        const { deptLogo, deptName } = getDeptLogos();
        const [plpData, ccsData] = await Promise.all([
            loadImage('../resc/assets/plp_logo.png'),
            loadImage(deptLogo)
        ]);

        const centerX = pageW / 2;
        const headerHeight = 45;
        
        // ── DRAW THIN HEADER BORDER (WHITE BG) ──
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.1);
        doc.rect(10, 5, pageW - 20, headerHeight, 'S');

        const logoSize = 18;
        if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, logoSize, logoSize);
        if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 67, 10, logoSize, logoSize);

        // ── CENTERED HEADER TEXT (BLACK) ──
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
        
        doc.setFontSize(9); doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal');
        doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' });
        
        doc.setFontSize(14); doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold');
        doc.text('SCHEDULES REPORT', centerX, 33, { align: 'center' });
        
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${nowStr}  ·  Total Schedules: ${allSchedules.length}`, centerX, 39, { align: 'center' });

        const head = [['#','Subject','Professor','Section','Lab','Day','Time','Sem / SY','Status','Enrolled','Sessions']];
        const body = allSchedules.map((r, i) => {
            let timeString = `${formatTimeStr(r.start_time)} - ${formatTimeStr(r.end_time)}`;
            return [
                i + 1, 
                r.subjects?.subject_code || '—', 
                r.profFullName || '—', 
                r.display_section || '—', 
                r.laboratory_rooms?.lab_code || '—',
                r.day_of_week, 
                timeString,
                `${r.semester} / ${r.school_year}`,
                r.status.toUpperCase(),
                r.enrolled_count || 0,
                r.sessions_done || 0
            ];
        });

        doc.autoTable({
            head, 
            body,
            startY: headerHeight + 10,
            margin: { left: 14, right: 14 },
            theme: 'grid',
            headStyles: { 
                fillColor: [255, 255, 255], 
                fontSize: 7.5, 
                fontStyle: 'bold', 
                textColor: [0, 0, 0], 
                lineColor: [0, 0, 0], 
                lineWidth: 0.1,
                halign: 'center', 
                valign: 'middle'
            },
            styles: { 
                fontSize: 7.5, 
                cellPadding: 3, 
                valign: 'middle',
                lineColor: [0, 0, 0], 
                lineWidth: 0.1,
                textColor: [0, 0, 0]
            },
            columnStyles: {
                0: { cellWidth: 10, halign: 'center' },
                1: { halign: 'center', fontStyle: 'bold' },
                2: { halign: 'left' },
                3: { halign: 'center' },
                4: { halign: 'center', fontStyle: 'bold' },
                5: { halign: 'center' },
                6: { halign: 'center' },
                7: { halign: 'center' },
                8: { halign: 'center', fontStyle: 'bold' },
                9: { cellWidth: 16, halign: 'center' },
                10: { cellWidth: 16, halign: 'center' }
            },
            didParseCell(d) {
                if (d.column.index === 8 && d.section === 'body') {
                    const s = (d.cell.text[0] || '').toLowerCase();
                    if (s === 'active') { d.cell.styles.textColor = [22, 101, 52]; }
                    else { d.cell.styles.textColor = [220, 38, 38]; }
                }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156, 163, 175);
            doc.text(`Laboratory Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`,
                pageW / 2, doc.internal.pageSize.height - 8, { align: 'center' });
        }

        doc.save(`Schedules_Report_${new Date().toISOString().split('T')[0]}.pdf`);
        await autoSaveReport('PDF');

    } catch (err) {
        console.error('PDF generation error:', err);
        if (typeof showToast === 'function') showToast('There was an error generating the PDF.', true);
    }
}

// ── CSV ────────────────────────────────────────────────────
async function exportCSV() {
    if (!checkDuplicateWarning('CSV')) return;

    const cols = ['#','Schedule ID','Professor','Employee ID','Subject Code','Subject Name','Section','Day','Start Time','End Time','Laboratory','Lab Name','Semester','School Year','Status','Enrolled','Sessions Done'];
    const lines = [
        cols.join(','),
        ...allSchedules.map((r,i) => [
            i+1, r.schedule_id, `"${r.profFullName}"`, r.professors?.employee_id, r.subjects?.subject_code, `"${r.subjects?.subject_name}"`, r.display_section, r.day_of_week, `"${formatTimeStr(r.start_time)}"`, `"${formatTimeStr(r.end_time)}"`, r.laboratory_rooms?.lab_code, `"${r.laboratory_rooms?.lab_name}"`, r.semester, r.school_year, r.status, r.enrolled_count || 0, r.sessions_done || 0
        ].join(','))
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/csv'}));
    a.download = `Schedules_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    
    await autoSaveReport('CSV');
}

// ── Excel ──────────────────────────────────────────────────
async function exportExcel() {
    if (!checkDuplicateWarning('Excel')) return;

    if (!window.XLSX) {
        return exportCSV(); // Fallback to CSV if SheetJS is missing
    }
    const wb = XLSX.utils.book_new();

    const headers = ['#','Schedule ID','Professor','Employee ID','Subject Code','Subject Name','Section','Day','Start Time','End Time','Laboratory','Lab Name','Semester','School Year','Status','Enrolled','Sessions Done'];
                  
    const rows = allSchedules.map((r, i) => [
        i + 1, r.schedule_id, r.profFullName, r.professors?.employee_id, r.subjects?.subject_code, r.subjects?.subject_name, r.display_section, r.day_of_week, formatTimeStr(r.start_time), formatTimeStr(r.end_time), r.laboratory_rooms?.lab_code, r.laboratory_rooms?.lab_name, r.semester, r.school_year, r.status.toUpperCase(), r.enrolled_count || 0, r.sessions_done || 0
    ]);

    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Schedules');

    XLSX.writeFile(wb, `Schedules_Report_${new Date().toISOString().split('T')[0]}.xlsx`);

    await autoSaveReport('Excel');
}

