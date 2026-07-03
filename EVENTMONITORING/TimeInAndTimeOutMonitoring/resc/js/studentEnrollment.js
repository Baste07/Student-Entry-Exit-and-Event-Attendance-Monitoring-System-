/* ============================================================
   resc/js/enrollment.js
   Replaces PHP queries with Supabase JS client for Enrollments
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

let allStudents = [];
let reportRows = [];
let META = { total: 0, enrolled: 0, enrollments: 0, notEnrolled: 0, date: '' };

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialized.');
        return;
    }
    
    META.date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    document.getElementById('rmGenDate').textContent = `Generated ${META.date}`;

    await loadStudentsData();
    initFilters();
});

function notifyUser(message, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) {
        alert(message);
        return;
    }

    const iconClass = isError ? 'fa-triangle-exclamation' : 'fa-circle-check';
    toast.innerHTML = `<i class="fa-solid ${iconClass}"></i><span>${escapeHtml(message)}</span>`;
    toast.style.background = isError ? 'var(--red)' : 'var(--green-dark)';
    toast.className = `toast on ${isError ? 'error' : 'success'}`;
    setTimeout(() => toast.classList.remove('on'), 3500);
}

// ────────────────────────────────────────────
// 1. DATA LOADING 
// ────────────────────────────────────────────
async function loadStudentsData() {
    try {
        // 1. Fetch active students
        const { data: students, error: studentErr } = await supabaseClient
            .from('students')
            .select('*')
            .eq('status', 'active')
            .order('last_name', { ascending: true });

        if (studentErr) throw studentErr;

        // 2. Fetch active enrollments with nested schedule and subject info
        // Supabase automatically joins based on Foreign Keys
        const { data: enrollments, error: enrollErr } = await supabaseClient
            .from('schedule_enrollments')
            .select(`
                student_id, enrollment_id,
                lab_schedules (
                    schedule_id, section, day_of_week, start_time, end_time, semester, school_year,
                    subjects ( subject_code, subject_name ),
                    professors ( first_name, last_name ),
                    laboratory_rooms ( lab_code, lab_name )
                )
            `)
            .eq('status', 'enrolled');

        if (enrollErr) throw enrollErr;

        // Group enrollments by student_id to avoid N+1 queries later
        const enrollmentsByStudent = {};
        let totalEnrollmentCount = 0;
        const uniqueSubjects = new Set(); 

        enrollments.forEach(e => {
            totalEnrollmentCount++;
            if (!enrollmentsByStudent[e.student_id]) enrollmentsByStudent[e.student_id] = [];
            enrollmentsByStudent[e.student_id].push(e);

            if (e.lab_schedules && e.lab_schedules.subjects) {
                const sub = e.lab_schedules.subjects;
                uniqueSubjects.add(JSON.stringify({ code: sub.subject_code, name: sub.subject_name }));
            }
        });

        // Populate Dropdowns
        populateFilterDropdowns(uniqueSubjects, students);

        // Map data to students
        META.total = students.length;
        META.enrolled = 0;
        META.enrollments = totalEnrollmentCount;
        
        allStudents = students.map(student => {
            const studentEnrollments = enrollmentsByStudent[student.student_id] || [];
            if (studentEnrollments.length > 0) META.enrolled++;

            // Extract unique subject codes for badges and filtering
            const subjectCodes = [...new Set(studentEnrollments.map(e => e.lab_schedules?.subjects?.subject_code).filter(Boolean))];

            return {
                ...student,
                fullName: `${student.first_name} ${student.middle_name ? student.middle_name + ' ' : ''}${student.last_name}`,
                enrollmentCount: studentEnrollments.length,
                subjectCodes: subjectCodes,
                enrollmentData: studentEnrollments, // Storing this so we don't need to fetch on click!
                hasFace: !!student.facial_dataset_path
            };
        });

        META.notEnrolled = META.total - META.enrolled;

        // Update UI Stats
        document.getElementById('statTotal').textContent = META.total;
        document.getElementById('statEnrolled').textContent = META.enrolled;
        document.getElementById('statEnrollments').textContent = META.enrollments;

        // Prep Report Data
        reportRows = allStudents.map(s => ({
            id_number: s.id_number,
            first_name: s.first_name,
            last_name: s.last_name,
            middle_name: s.middle_name || '—',
            course: s.course || '—',
            year_level: s.year_level || '—',
            section: s.section || '—',
            email: s.email || '—',
            face_status: s.hasFace ? 'Registered' : 'Not Registered',
            enrollment_count: s.enrollmentCount,
            subjects: s.subjectCodes.join(', ')
        }));

        renderTable(allStudents);

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('studentsTableBody').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red);">Error loading data.</td></tr>`;
    }
}

function populateFilterDropdowns(uniqueSubjects, students) {
    // Subjects (existing)
    const subjSelect = document.getElementById('subjectFilter');
    const parsedSubjects = Array.from(uniqueSubjects).map(s => JSON.parse(s)).sort((a,b) => a.code.localeCompare(b.code));
    subjSelect.innerHTML = '<option value="">All Subjects</option>' + 
        parsedSubjects.map(s => `<option value="${s.code}">${s.code} — ${s.name}</option>`).join('');

    // Sections (existing)
    const secSelect = document.getElementById('sectionFilter');
    const sections = [...new Set(students.map(s => s.section).filter(Boolean))].sort();
    secSelect.innerHTML = '<option value="">All Sections</option>' + 
        sections.map(s => `<option value="${s}">${s}</option>`).join('');

    // ── NEW: Courses ──────────────────────────────────────
    const courseSelect = document.getElementById('courseFilter');
    const courses = [...new Set(students.map(s => s.course).filter(Boolean))].sort();
    courseSelect.innerHTML = '<option value="">All Courses</option>' +
        courses.map(c => `<option value="${c}">${c}</option>`).join('');

    // ── NEW: Year & Section combined ──────────────────────
    const yrSecSelect = document.getElementById('yearSectionFilter');
    const yrSecs = [...new Set(students.map(s => {
        if (s.year_level && s.section) return `${s.year_level}${s.section}`;
        if (s.year_level) return `${s.year_level}yr`;
        if (s.section) return s.section;
        return null;
    }).filter(Boolean))].sort();
    yrSecSelect.innerHTML = '<option value="">All Yr &amp; Sec</option>' +
        yrSecs.map(ys => `<option value="${ys}">${ys}</option>`).join('');
}

function renderTable(data) {
    const tbody = document.getElementById('studentsTableBody');
    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted);">No students found matching filters.</td></tr>`;
        return;
    }

    let html = '';
    data.forEach(s => {
        let yearSection = '-';
        if (s.year_level && s.section) yearSection = s.year_level + s.section;
        else if (s.year_level) yearSection = s.year_level + 'yr';
        else if (s.section) yearSection = s.section;

        const enrollmentStatus = s.enrollmentCount > 0 ? 'enrolled' : 'not-enrolled';
        const faceIcon = s.hasFace 
            ? '<i class="fa-solid fa-check-circle face-status-icon registered" title="Face registered"></i>' 
            : '<i class="fa-solid fa-exclamation-circle face-status-icon pending" title="Not registered"></i>';

        const pills = s.subjectCodes.length > 0 
            ? `<div class="subject-pills" id="pills-${s.student_id}" style="display:none">
                 ${s.subjectCodes.map(code => `<span class="subject-pill">${code}</span>`).join('')}
               </div>` 
            : '';

        html += `
            <tr class="student-row" 
                data-student-id="${s.student_id}" 
                data-section="${s.section || ''}" 
                data-enrollment="${enrollmentStatus}" 
              
               data-subjects="${s.subjectCodes.join(',')}"


               data-course="${s.course || ''}"
            data-yrsec="${s.year_level && s.section ? s.year_level + s.section : s.year_level ? s.year_level + 'yr' : s.section || ''}"
                onclick="toggleEnrollmentDetails(this)">
                
                <td><i class="fa-solid fa-chevron-right expand-icon"></i></td>
                <td><strong>${escapeHtml(s.id_number)}</strong></td>
                <td>
                    <strong>${escapeHtml(s.fullName)}</strong>
                    ${pills}
                </td>
                <td>${escapeHtml(s.course || '-')}</td>
                <td><span class="section-badge">${escapeHtml(yearSection)}</span></td>
                <td>${escapeHtml(s.email || '-')}</td>
                <td>${faceIcon}</td>
                <td>
                    <span class="enrollment-count-badge ${s.enrollmentCount === 0 ? 'zero' : ''}">
                        <i class="fa-solid fa-book"></i>
                        ${s.enrollmentCount} subject${s.enrollmentCount !== 1 ? 's' : ''}
                    </span>
                </td>
            </tr>
            <tr class="enrollment-details" id="details-${s.student_id}">
                <td colspan="8">
                    <div class="enrollment-content">
                        <div class="enrollment-grid" id="grid-${s.student_id}"></div>
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

// ────────────────────────────────────────────
// 2. FILTERS
// ────────────────────────────────────────────
function initFilters() {
    const search = document.getElementById('searchInput');
    const section = document.getElementById('sectionFilter');
    const subject = document.getElementById('subjectFilter');
    const enrollment = document.getElementById('enrollmentFilter');
    const course = document.getElementById('courseFilter');       // ← NEW
    const yrSec = document.getElementById('yearSectionFilter');   // ← NEW

    function apply() {
        const query = search.value.toLowerCase().trim();
        const sec = section.value;
        const sub = subject.value;
        const enr = enrollment.value;
        const crs = course.value;         // ← NEW
        const ys  = yrSec.value;          // ← NEW

        document.querySelectorAll('.subject-pills').forEach(pills => {
            pills.style.display = sub ? 'flex' : 'none';
        });

        document.querySelectorAll('.student-row').forEach(row => {
            const studentSubjects = row.dataset.subjects.split(',');
            const rowCourse = row.dataset.course;       // ← NEW (set in renderTable below)
            const rowYrSec  = row.dataset.yrsec;        // ← NEW (set in renderTable below)
            
            const visible = 
                (!query || row.textContent.toLowerCase().includes(query)) &&
                (!sec || row.dataset.section === sec) &&
                (!enr || row.dataset.enrollment === enr) &&
                (!sub || studentSubjects.includes(sub)) &&
                (!crs || rowCourse === crs) &&           // ← NEW
                (!ys  || rowYrSec  === ys);              // ← NEW

            row.style.display = visible ? '' : 'none';
            
            const detailsRow = row.nextElementSibling;
            if (detailsRow && detailsRow.classList.contains('enrollment-details')) {
                if (!visible) {
                    detailsRow.style.display = 'none';
                    detailsRow.classList.remove('active');
                    row.classList.remove('expanded');
                } else {
                    detailsRow.style.display = '';
                }
            }
        });
    }

    search.addEventListener('input', apply);
    [section, subject, enrollment, course, yrSec].forEach(el => el.addEventListener('change', apply)); // ← updated

    document.getElementById('clearFilters').addEventListener('click', () => {
        search.value = ''; section.value = ''; subject.value = ''; 
        enrollment.value = ''; course.value = ''; yrSec.value = ''; // ← updated
        apply();
    });
}

// ────────────────────────────────────────────
// 3. EXPAND ROW (Render from pre-fetched data)
// ────────────────────────────────────────────
window.toggleEnrollmentDetails = function(row) {
    const studentId = row.dataset.studentId;
    const detailsRow = document.getElementById('details-' + studentId);
    const grid = document.getElementById('grid-' + studentId);

    // Collapse if already open
    if (row.classList.contains('expanded')) {
        row.classList.remove('expanded');
        detailsRow.classList.remove('active');
        return;
    }

    // Collapse all others
    document.querySelectorAll('.student-row').forEach(r => r.classList.remove('expanded'));
    document.querySelectorAll('.enrollment-details').forEach(d => d.classList.remove('active'));

    // Open clicked row
    row.classList.add('expanded');
    detailsRow.classList.add('active');

    // Render data
    if (!grid.dataset.rendered) {
        const student = allStudents.find(s => s.student_id === studentId);
        
        if (!student.enrollmentData || student.enrollmentData.length === 0) {
            grid.innerHTML = '<p class="no-enrollments"><i class="fa-solid fa-inbox"></i> This student is not enrolled in any active schedules.</p>';
        } else {
            // Map the Supabase nested structure for the HTML template
            const formattedEnrollments = student.enrollmentData.map(e => ({
                subject_code: e.lab_schedules?.subjects?.subject_code,
                subject_name: e.lab_schedules?.subjects?.subject_name,
                section: e.lab_schedules?.section,
                professor_name: `${e.lab_schedules?.professors?.first_name} ${e.lab_schedules?.professors?.last_name}`,
                day_of_week: e.lab_schedules?.day_of_week,
                start_time: e.lab_schedules?.start_time,
                end_time: e.lab_schedules?.end_time,
                lab_code: e.lab_schedules?.laboratory_rooms?.lab_code,
                lab_name: e.lab_schedules?.laboratory_rooms?.lab_name,
                semester: e.lab_schedules?.semester,
                school_year: e.lab_schedules?.school_year
            }));
            
            displayEnrollments(grid, formattedEnrollments);
        }
        grid.dataset.rendered = 'true';
    }
};

function displayEnrollments(grid, enrollments) {
    grid.innerHTML = enrollments.map(e => `
        <div class="subject-card">
            <div class="subject-header">${escapeHtml(e.subject_code)}</div>
            <div class="subject-detail"><i class="fa-solid fa-book"></i>${escapeHtml(e.subject_name)}</div>
            <div class="subject-detail"><i class="fa-solid fa-users"></i>Section: ${escapeHtml(e.section)}</div>
            <div class="subject-detail"><i class="fa-solid fa-chalkboard-teacher"></i>${escapeHtml(e.professor_name)}</div>
            <div class="subject-detail"><i class="fa-solid fa-calendar"></i>
                <span class="day-badge">${e.day_of_week}</span>
                ${formatTime12Hour(e.start_time)} - ${formatTime12Hour(e.end_time)}
            </div>
            <div class="subject-detail"><i class="fa-solid fa-door-open"></i>${escapeHtml(e.lab_code)} - ${escapeHtml(e.lab_name)}</div>
            <div class="subject-detail"><i class="fa-solid fa-graduation-cap"></i>${e.semester} ${e.school_year}</div>
        </div>
    `).join('');
}

function formatTime12Hour(timeString) {
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    let h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${minutes} ${ampm}`;
}

// ────────────────────────────────────────────
// 4. UTILS & MODALS
// ────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

window.openReportModal = async function() {
    await fetchTodayReports();

    document.getElementById('rmTotalChip').textContent = META.total;
    document.getElementById('rmEnrolledChip').textContent = META.enrolled;
    document.getElementById('rmEnrollmentsChip').textContent = META.enrollments;
    document.getElementById('rmNotEnrolledChip').textContent = META.notEnrolled;

    const tbody = document.getElementById('rmTableBody');
    tbody.innerHTML = reportRows.map((r, i) => `
        <tr>
            <td style="color:var(--text-muted);font-size:12px">${i+1}</td>
            <td><strong style="color:var(--green-dark);font-size:13px">${escapeHtml(r.id_number)}</strong></td>
            <td style="font-weight:700">${escapeHtml(r.last_name)}</td>
            <td>${escapeHtml(r.first_name)}</td>
            <td style="color:var(--text-muted)">${escapeHtml(r.middle_name)}</td>
            <td style="font-size:12px">${escapeHtml(r.course)}</td>
            <td style="text-align:center">${escapeHtml(r.year_level)}</td>
            <td style="text-align:center"><span style="background:var(--surface);color:var(--green-dark);padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid var(--border);">${escapeHtml(r.section)}</span></td>
            <td style="font-size:11.5px">${escapeHtml(r.email)}</td>
            <td><span class="rm-badge ${r.face_status==='Registered'?'registered':'not-registered'}">${r.face_status}</span></td>
            <td style="text-align:center"><strong>${r.enrollment_count}</strong></td>
            <td style="font-size:11.5px;color:var(--green-dark);font-weight:700;max-width:180px;word-break:break-word">${escapeHtml(r.subjects || '—')}</td>
        </tr>
    `).join('');
    
    document.getElementById('rmOverlay').classList.add('on');
}
window.closeReportModal = function() { document.getElementById('rmOverlay').classList.remove('on'); }

// ────────────────────────────────────────────
// 5. EXPORT / REPORTS (With Duplicate Prevention & Green Banner)
// ────────────────────────────────────────────

let existingReportsToday = []; // Tracks reports to prevent exact duplicates

// ── Smart Duplicate Check Helper ──
function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Enrollment Report — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(reportRows);
    
    const isExactDuplicate = existingReportsToday.some(r => 
        r.name === reportName && r.dataString === currentDataString
    );
    
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true; 
}

// ── Auto-save helper ──────────────────────────────────────────
async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Enrollment Report — ${dateStr} (${exportType})`;

    const payload = {
        report_type: 'enrollment',
        report_name: reportName,
        filters:     JSON.stringify({}),
        report_data: JSON.stringify(reportRows)
    };

    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;

        notifyUser(`${exportType} exported and report saved.`);
        
        existingReportsToday.push({
            name: payload.report_name,
            dataString: payload.report_data
        }); 
        
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}

// ── Pre-fetch Duplicates (Call this when opening your Report Modal) ──
window.fetchTodayReports = async function() {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', 'enrollment')
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

// ── Print ──────────────────────────────────────────────────
window.printReport = async function() {
    if (!checkDuplicateWarning('Print')) return;

    // Dynamically retrieve department data
    const { deptLogo, deptName, deptCode } = getDeptLogos();

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr  = `${dateStr} at ${timeStr}`;

    const cols = ['#','Student ID','Last Name','First Name','M.I.','Course','Year','Section','Email','Face Status','Enrolled Subjects','Subject Codes'];

    const rows = reportRows.map((r, i) => {
        let faceColor = r.face_status.toLowerCase() === 'registered' ? '#166534' : '#d97706';
        let mi = r.middle_name ? r.middle_name.substring(0,2) + '.' : '—';
        let subs = r.subjects ? r.subjects.substring(0, 50) + (r.subjects.length > 50 ? '...' : '') : '—';
        
        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i + 1}</td>
            <td><strong>${r.id_number}</strong></td>
            <td><strong>${r.last_name}</strong></td>
            <td>${r.first_name}</td>
            <td>${mi}</td>
            <td>${r.course}</td>
            <td style="text-align:center">${r.year_level}</td>
            <td style="text-align:center">${r.section}</td>
            <td style="font-size:9px">${r.email}</td>
            <td><span style="color: ${faceColor}; font-weight: bold;">${r.face_status.toUpperCase()}</span></td>
            <td style="text-align:center">${r.enrollment_count}</td>
            <td style="font-size:9px;max-width:180px;word-break:break-word;">${subs}</td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Enrollment Report</title>
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
        th{background:#ffffff; color:#000000; padding:8px 10px; text-align:center; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; border: 1px solid #000000 !important;}
        td{padding:8px 10px; border: 1px solid #000000 !important; font-size:11px; text-align:center;}
        td:nth-child(2), td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6) {text-align:left;}
        td:last-child {text-align:left;}
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
        <div class="report-title">Student Enrollment Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Total Students Enrolled: ${reportRows.length}</div>
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

        const { deptLogo, deptName, deptCode } = getDeptLogos();
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
        doc.text('STUDENT ENROLLMENT REPORT', centerX, 33, { align: 'center' });
        
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${nowStr}  ·  Total Students: ${reportRows.length}`, centerX, 39, { align: 'center' });

        const head = [['#','Student ID','Last Name','First Name','M.I.','Course','Yr','Section','Email','Face Status','Enrolled\nSubjects','Subject Codes']];
        const body = reportRows.map((r, i) => {
            const mi = r.middle_name ? r.middle_name.substring(0,2) + '.' : '—';
            return [
                i + 1, r.id_number, r.last_name, r.first_name, mi,
                r.course, r.year_level, r.section, r.email,
                r.face_status.toUpperCase(), r.enrollment_count,
                r.subjects || '—'
            ];
        });

        doc.autoTable({
            head, body,
            startY: headerHeight + 10,
            margin: { left: 10, right: 10 },
            theme: 'grid',
            headStyles: { 
                fillColor: [255, 255, 255], 
                fontSize: 6.5, 
                fontStyle: 'bold', 
                textColor: [0, 0, 0], 
                lineColor: [0, 0, 0], 
                lineWidth: 0.1,
                halign: 'center', 
                valign: 'middle' 
            },
            styles: { 
                fontSize: 6.5, 
                cellPadding: 2, 
                valign: 'middle',
                lineColor: [0, 0, 0], 
                lineWidth: 0.1,
                textColor: [0, 0, 0]
            },
            columnStyles: {
                0: { cellWidth: 7, halign: 'center' },
                1: { cellWidth: 16, halign: 'center', fontStyle: 'bold' },
                2: { cellWidth: 20, fontStyle: 'bold' },
                3: { cellWidth: 20 },
                4: { cellWidth: 8 },
                5: { cellWidth: 12, halign: 'center' },
                6: { cellWidth: 8, halign: 'center' },
                7: { cellWidth: 14, halign: 'center' },
                8: { cellWidth: 35 },
                9: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
                10: { cellWidth: 14, halign: 'center' },
                11: { cellWidth: 'auto', halign: 'left' }
            },
            didParseCell(d) {
                if (d.column.index === 9 && d.section === 'body') {
                    const s = (d.cell.text[0] || '').toLowerCase();
                    if (s === 'registered') { d.cell.styles.textColor = [22, 101, 52]; }
                    if (s === 'not registered') { d.cell.styles.textColor = [217, 119, 6]; }
                }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156, 163, 175);
            doc.text(`Laboratory Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`,
                pageW / 2, doc.internal.pageSize.height - 8, { align: 'center' });
        }

        doc.save(`Enrollment_Report_${new Date().toISOString().split('T')[0]}.pdf`);

        await autoSaveReport('PDF');

    } catch (err) {
        console.error('PDF generation error:', err);
        if (typeof showToast === 'function') showToast('There was an error generating the PDF.', true);
    }
};

// ── CSV ────────────────────────────────────────────────────
window.exportCSV = async function() {
    if (!checkDuplicateWarning('CSV')) return;

    const cols = ['#','Student ID','Last Name','First Name','Middle Name','Course','Year','Section','Email','Face Status','Enrolled Subjects','Subject Codes'];
    const lines = [
        cols.join(','),
        ...reportRows.map((r,i) => [
            i+1, r.id_number, `"${r.last_name}"`, `"${r.first_name}"`, `"${r.middle_name||''}"`,
            r.course, r.year_level, r.section, `"${r.email}"`, r.face_status, r.enrollment_count,
            `"${(r.subjects||'').replace(/"/g,'""')}"`
        ].join(','))
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/csv'}));
    a.download = `Enrollment_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    
    await autoSaveReport('CSV');
};

// ── Excel ──────────────────────────────────────────────────
window.exportExcel = async function() {
    if (!checkDuplicateWarning('Excel')) return;

    if (!window.XLSX) {
        return window.exportCSV(); // Fallback
    }
    const wb = XLSX.utils.book_new();

    const headers = ['#','Student ID','Last Name','First Name','Middle Name','Course','Year','Section','Email','Face Status','Enrolled Subjects','Subject Codes'];
                  
    const rows = reportRows.map((r, i) => [
        i + 1, r.id_number, r.last_name, r.first_name, r.middle_name || '',
        r.course, r.year_level, r.section, r.email, r.face_status.toUpperCase(),
        r.enrollment_count, r.subjects || ''
    ]);

    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Enrollments');

    XLSX.writeFile(wb, `Enrollment_Report_${new Date().toISOString().split('T')[0]}.xlsx`);

    await autoSaveReport('Excel');
};

