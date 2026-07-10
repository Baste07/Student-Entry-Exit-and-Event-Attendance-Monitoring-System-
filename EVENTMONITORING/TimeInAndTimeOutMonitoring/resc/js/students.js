/* ============================================================
   resc/js/students.js
   K-10 Students List — Supabase integration
============================================================ */

// ── State ──────────────────────────────────────────────────
let allStudents  = [];
let allSections  = [];
let reportRows   = [];
let META = { total: 0, registered: 0, pending: 0, date: '' };
const FACE_BUCKET = 'facial_data';

async function hasFaceFilesInStorage(datasetPath) {
    if (!datasetPath) return false;
    try {
        const { data, error } = await supabaseClient.storage
            .from(FACE_BUCKET)
            .list(datasetPath, {
                limit: 20,
                offset: 0,
                sortBy: { column: 'name', order: 'asc' }
            });
        if (error) return false;
        return (data || []).some(f => {
            const name = (f?.name || '').toLowerCase();
            return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        });
    } catch {
        return false;
    }
}

function resolveHasFace(student) {
    if (student && typeof student.has_face_images === 'boolean') {
        return student.has_face_images;
    }
    return !!student?.facial_dataset_path;
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        showToast('⚠️ Supabase not configured. Check config/.env.js', false);
        return;
    }
    await loadSections();
    await loadStudents();
    initFilters();
});

// ══════════════════════════════════════════════════════════
// 1. LOAD SECTIONS FROM SUPABASE
// ══════════════════════════════════════════════════════════
async function loadSections() {
    try {
        const { data: sections, error } = await supabaseClient
            .from('sections')
            .select('section_id, grade_level, section_name, adviser_id, school_year_id')
            .order('grade_level', { ascending: true })
            .order('section_name', { ascending: true });

        if (error) throw error;
        allSections = sections || [];
    } catch (err) {
        console.error('loadSections error:', err);
        allSections = [];
    }
}

function getSectionById(sectionId) {
    return allSections.find(s => s.section_id === sectionId) || null;
}

// ══════════════════════════════════════════════════════════
// 2. LOAD STUDENTS FROM SUPABASE
// ══════════════════════════════════════════════════════════
async function loadStudents() {
    try {
        const { data: students, error } = await supabaseClient
            .from('students')
            .select(`
                student_id,
                stud_id,
                first_name,
                middle_name,
                last_name,
                suffix,
                birth_date,
                gender,
                section_id,
                facial_dataset_path,
                profile_picture,
                status,
                address,
                school_year_id,
                created_at
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        allStudents = await Promise.all((students || []).map(async s => ({
            ...s,
            has_face_images: await hasFaceFilesInStorage(s.facial_dataset_path)
        })));

        // Populate dropdowns based on available data
        populateDynamicFilters();

        const total      = allStudents.length;
        const registered = allStudents.filter(s => resolveHasFace(s)).length;
        const pending    = total - registered;

        META = {
            total,
            registered,
            pending,
            date: new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        };

        document.getElementById('statTotal').textContent      = total;
        document.getElementById('statRegistered').textContent = registered;
        document.getElementById('statPending').textContent    = pending;

        renderTable(allStudents);
        await buildReportRows();

    } catch (err) {
        console.error('loadStudents error:', err);
        document.getElementById('studentsTableBody').innerHTML =
            `<tr><td colspan="10" style="text-align:center;padding:40px;color:#dc2626">
                <i class="fa-solid fa-circle-exclamation"></i> Failed to load students: ${err.message}
            </td></tr>`;
    }
}

// ══════════════════════════════════════════════════════════
// 3. RENDER TABLE
// ══════════════════════════════════════════════════════════
function renderTable(students) {
    const tbody = document.getElementById('studentsTableBody');

    if (!students.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#9ca3af">
            <i class="fa-solid fa-users" style="font-size:32px;display:block;margin-bottom:10px;color:#dcfce7"></i>
            No students found.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const hasFace = resolveHasFace(s);
        const section = getSectionById(s.section_id);
        const gradeLevel = section ? section.grade_level : '-';
        const sectionName = section ? section.section_name : '-';
        const dateReg = s.created_at
            ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';
        const statusCls = (s.status || 'active').toLowerCase();
        const faceData  = hasFace ? 'registered' : 'not-registered';

        return `<tr data-id="${s.student_id}" data-status="${statusCls}" data-face="${faceData}">
            <td style="font-weight:700;color:#166534">${escHtml(s.stud_id || '-')}</td>
            <td style="font-weight:600">${escHtml(s.last_name)}</td>
            <td>${escHtml(s.first_name)}</td>
            <td>${escHtml(s.middle_name || '-')}</td>
            <td>${escHtml(s.suffix || '-')}</td>
            <td>${escHtml(gradeLevel)}</td>
            <td>${escHtml(sectionName)}</td>
            <td>${escHtml(s.gender || '-')}</td>
            <td>
                ${hasFace
                    ? `<span class="action-icon face-reg reg-done" title="Facial data registered"><i class="fas fa-check"></i></span>`
                    : `<span class="action-icon face-reg" title="Register facial data"
                         onclick="openFaceRegModal('${escHtml(s.stud_id)}')">
                         <i class="fas fa-times"></i>
                       </span>`
                }
            </td>
            <td style="font-size:12.5px">${dateReg}</td>
        </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// 4. FILTERS & SEARCH
// ══════════════════════════════════════════════════════════
function populateDynamicFilters() {
    const sectionFilter = document.getElementById('sectionFilter');
    if (!sectionFilter) return;

    // Get unique sections from loaded sections data
    const sections = [...allSections].sort((a, b) => {
        const gradeOrder = ['Kinder','Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8','Grade 9','Grade 10'];
        const aIdx = gradeOrder.indexOf(a.grade_level);
        const bIdx = gradeOrder.indexOf(b.grade_level);
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.section_name.localeCompare(b.section_name);
    });

    sectionFilter.innerHTML = '<option value="">All Sections</option>' +
        sections.map(s => `<option value="${s.section_id}">${escHtml(s.grade_level)} - ${escHtml(s.section_name)}</option>`).join('');

    // Ensure listeners are bound and apply current filters
    try { bindFilterListeners(); applyFilters(); } catch (_) {}
}

function initFilters() {
    const searchInput  = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const faceFilter   = document.getElementById('faceFilter');
    const sortFilter   = document.getElementById('sortFilter');
    const gradeFilter  = document.getElementById('gradeFilter');
    const sectionFilter = document.getElementById('sectionFilter');

    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
        searchInput.addEventListener('keyup', applyFilters);
    }

    bindFilterListeners();
    window.applyStudentFilters = applyFilters;

    const clearBtn = document.getElementById('clearFilters');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            statusFilter.value = '';
            faceFilter.value = '';
            sortFilter.value = '';
            if (gradeFilter) gradeFilter.value = '';
            if (sectionFilter) sectionFilter.value = '';
            applyFilters();
        });
    }
}

function bindFilterListeners() {
    const els = ['statusFilter','faceFilter','sortFilter','gradeFilter','sectionFilter'];
    els.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.dataset._filtersBound === '1') return;
        el.addEventListener('change', applyFilters);
        el.dataset._filtersBound = '1';
    });
}

function applyFilters() {
    const searchInput = document.getElementById('searchInput');
    const q   = (searchInput?.value || '').toLowerCase().trim();
    const st  = document.getElementById('statusFilter').value;
    const fc  = document.getElementById('faceFilter').value;
    const so  = document.getElementById('sortFilter').value;
    const gr  = (document.getElementById('gradeFilter')?.value || '').toString().trim();
    const sec = (document.getElementById('sectionFilter')?.value || '').toString().trim();

    let filtered = allStudents.filter(s => {
        const section = getSectionById(s.section_id);
        const fullName = `${s.first_name || ''} ${s.middle_name || ''} ${s.last_name || ''}`.toLowerCase();
        const searchable = `${s.stud_id || ''} ${fullName} ${s.gender || ''} ${section ? section.grade_level : ''} ${section ? section.section_name : ''}`.toLowerCase();

        // 1. Text Search
        const matchQ  = !q || searchable.includes(q);

        // 2. Status & Face Check
        const matchSt = !st || (s.status || 'active').toLowerCase() === st;
        const hasFace = resolveHasFace(s);
        const matchFc = !fc || (fc === 'registered' ? hasFace : !hasFace);

        // 3. Grade Level & Section Check
        const matchGr = !gr || (section && section.grade_level === gr);
        const matchSec = !sec || (s.section_id && s.section_id === sec);

        return matchQ && matchSt && matchFc && matchGr && matchSec;
    });

    if (so === 'az') filtered.sort((a, b) => a.last_name.localeCompare(b.last_name));
    if (so === 'za') filtered.sort((a, b) => b.last_name.localeCompare(a.last_name));

    renderTable(filtered);
}

// ══════════════════════════════════════════════════════════
// 5. FACE REGISTRATION SEARCH
// ══════════════════════════════════════════════════════════
async function searchStudent() {
    const studentId    = document.getElementById('studentIdSearch').value.trim();
    const searchBtn    = document.getElementById('searchBtn');
    const searchResult = document.getElementById('searchResult');

    if (!studentId) { showToast('Please enter a Student ID.', false); return; }

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

    try {
        const { data: s, error } = await supabaseClient
            .from('students')
            .select('student_id, stud_id, first_name, middle_name, last_name, suffix, gender, section_id, facial_dataset_path, birth_date')
            .eq('stud_id', studentId)
            .single();

        if (error || !s) {
            showToast('Student not found.', false);
            searchResult.classList.remove('active');
            return;
        }

        const hasFace = await hasFaceFilesInStorage(s.facial_dataset_path);
        document.getElementById('faceStatus').className = 'face-status ' + (hasFace ? 'registered' : 'not-registered');
        document.getElementById('faceStatus').innerHTML = hasFace
            ? '<i class="fa-solid fa-check-circle"></i> Facial data already registered'
            : '<i class="fa-solid fa-exclamation-circle"></i> Facial data not registered yet';

        const rb = document.getElementById('registerFaceBtn');
        rb.style.display = hasFace ? 'none' : 'block';
        rb.dataset.studentId = s.stud_id;

        const section = getSectionById(s.section_id);
        const gradeSec = section ? `${section.grade_level} - ${section.section_name}` : '-';

        document.getElementById('studentInfo').innerHTML = `
            <div class="info-item"><label>Student ID</label><div class="value">${escHtml(s.stud_id)}</div></div>
            <div class="info-item"><label>Full Name</label><div class="value">${escHtml(s.first_name)} ${escHtml(s.middle_name || '')} ${escHtml(s.last_name)} ${escHtml(s.suffix || '')}</div></div>
            <div class="info-item"><label>Grade & Section</label><div class="value">${escHtml(gradeSec)}</div></div>
            <div class="info-item"><label>Gender</label><div class="value">${escHtml(s.gender || '-')}</div></div>
            <div class="info-item"><label>Birth Date</label><div class="value">${s.birth_date ? new Date(s.birth_date).toLocaleDateString('en-US') : '-'}</div></div>
        `;
        searchResult.classList.add('active');

    } catch (err) {
        showToast('Error: ' + err.message, false);
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-search"></i> Search Student';
    }
}

function openFaceRegModal(studId) {
    openModal('faceRegModal');
    document.getElementById('studentIdSearch').value = studId || '';
    if (studId) searchStudent();
}

function redirectToFaceReg() {
    const sid = document.getElementById('registerFaceBtn').dataset.studentId;
    // Adjust path to match where your face registration page lives
    window.top.location.href =
        '../../TimeInAndTimeOutMonitoring/students/accountRegistration.html'
        + '?role=student&student_id=' + encodeURIComponent(sid);
}

// ══════════════════════════════════════════════════════════
// 6. REPORT MODAL
// ══════════════════════════════════════════════════════════
async function buildReportRows() {
    const enriched = [];
    if (!Array.isArray(allStudents)) {
        console.warn('[students] buildReportRows: allStudents is not an array', allStudents);
        reportRows = [];
        return;
    }

    for (const s of allStudents) {
        try {
            let attendances = 0;

            const attendRes = await supabaseClient
                .from('daily_attendance')
                .select('attendance_id', { count: 'exact', head: true })
                .eq('student_id', s.student_id);

            if (attendRes.error) {
                console.error('[students] daily_attendance error for', s.student_id, attendRes.error);
            } else {
                attendances = attendRes.count || 0;
            }

            const section = getSectionById(s.section_id);
            const dateReg = s.created_at
                ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
                : '-';

            enriched.push({
                stud_id:           s.stud_id || '-',
                first_name:        s.first_name,
                middle_name:       s.middle_name || '—',
                last_name:         s.last_name,
                suffix:            s.suffix || '—',
                grade_level:       section ? section.grade_level : '—',
                section_name:      section ? section.section_name : '—',
                gender:            s.gender || '—',
                face_status:       resolveHasFace(s) ? 'Registered' : 'Not Registered',
                status:            s.status || 'active',
                total_attendances: attendances || 0,
                date_registered:   dateReg,
            });
        } catch (e) {
            console.error('[students] buildReportRows iteration failed for', s.student_id, e);
        }
    }

    reportRows = enriched;
    console.debug('[students] buildReportRows completed, rows:', reportRows.length);
}

let existingReportsToday = [];

async function openReportModal() {
    const tbody = document.getElementById('rmTableBody');
    document.getElementById('rmGenDate').innerHTML =
        `Generated ${META.date} &nbsp;·&nbsp; <span id="rmTotal">${META.total}</span> students`;
    document.getElementById('rmChipTotal').textContent      = META.total;
    document.getElementById('rmChipRegistered').textContent = META.registered;
    document.getElementById('rmChipPending').textContent    = META.pending;

    document.getElementById('rmOverlay').classList.add('on');

    // Render students immediately from allStudents
    if (!allStudents.length) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:40px;color:#9ca3af">No data available.</td></tr>`;
        return;
    }

    tbody.innerHTML = allStudents.map((s, i) => {
        const hasFace   = resolveHasFace(s);
        const faceLabel = hasFace ? 'Registered' : 'Not Registered';
        const faceClass = hasFace ? 'registered' : 'not-registered';
        const status    = (s.status || 'active').toLowerCase();
        const section   = getSectionById(s.section_id);
        const gradeLevel = section ? section.grade_level : '—';
        const sectionName = section ? section.section_name : '—';
        const dateReg   = s.created_at
            ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';

        return `<tr data-rowid="${escHtml(String(s.student_id))}">
            <td style="color:#9ca3af;font-size:11px">${i + 1}</td>
            <td style="font-weight:700;color:#166534;font-size:12px">${escHtml(s.stud_id || '-')}</td>
            <td style="font-weight:600">${escHtml(s.last_name)}</td>
            <td>${escHtml(s.first_name)}</td>
            <td style="color:#6b7280">${escHtml(s.middle_name || '—')}</td>
            <td style="font-size:12px">${escHtml(gradeLevel)}</td>
            <td style="text-align:center">${escHtml(sectionName)}</td>
            <td style="text-align:center">${escHtml(s.gender || '—')}</td>
            <td><span class="rm-badge ${faceClass}">${faceLabel}</span></td>
            <td><span class="rm-badge ${status}">${capitalize(status)}</span></td>
            <td style="text-align:center" class="cell-attend"><i class="fa-solid fa-spinner fa-spin" style="color:#9ca3af;font-size:10px"></i></td>
            <td style="font-size:11.5px;color:#6b7280;white-space:nowrap">${dateReg}</td>
        </tr>`;
    }).join('');

    // Load attendance counts in background
    loadReportCounts();

    // Rebuild reportRows for export
    buildReportRows();

    // Check for duplicate reports today
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('attendance_reports').select('report_type, filters')
            .eq('report_type', 'students').like('report_type', `%${dateStr}%`);
        existingReportsToday = data
            ? data.map(d => ({ name: d.report_type, dataString: typeof d.filters === 'string' ? d.filters : JSON.stringify(d.filters) }))
            : [];
    } catch (e) {
        existingReportsToday = [];
    }
}

// Fetch counts per student and update cells live
async function loadReportCounts() {
    for (const s of allStudents) {
        const row = document.querySelector(`tr[data-rowid="${CSS.escape(String(s.student_id))}"]`);
        if (!row) continue;

        const attendCell = row.querySelector('.cell-attend');

        try {
            const attendRes = await supabaseClient
                .from('daily_attendance')
                .select('attendance_id', { count: 'exact', head: true })
                .eq('student_id', s.student_id);

            if (attendCell) attendCell.innerHTML = `<strong>${attendRes.count || 0}</strong>`;
        } catch (e) {
            if (attendCell) attendCell.textContent = '—';
        }
    }
}

function closeReportModal() {
    document.getElementById('rmOverlay').classList.remove('on');
}

function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Students Report — ${dateStr} (${exportType})`;
    const currentDataString = JSON.stringify(reportRows);
    const isExactDuplicate = existingReportsToday.some(r => r.name === reportName && r.dataString === currentDataString);
    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }
    return true;
}

async function saveReport() {
    if (!checkDuplicateWarning('Manual Save')) return;
    const btn = document.querySelector('.rm-btn[onclick="saveReport()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
    await autoSaveReport('Manual Save');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to Reports'; }
}

async function autoSaveReport(exportType) {
    const dateStr    = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Students Report — ${dateStr} (${exportType})`;
    const payload = {
        report_type: 'students',
        report_name: reportName,
        filters: JSON.stringify({}),
        report_data: JSON.stringify(reportRows)
    };
    try {
        const { error } = await supabaseClient.from('attendance_reports').insert([payload]);
        if (error) throw error;
        if (exportType === 'Manual Save') showToast('Report saved successfully!', true);
        else console.log(`[Auto-Save] ${exportType} report archived.`);
        existingReportsToday.push({ name: payload.report_name, dataString: payload.report_data });
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}

async function printReport() {
    if (!checkDuplicateWarning('Print')) return;

    const now = new Date();
    const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    const cols = ['#','Student ID','Last Name','First Name','Middle Name','Grade Level','Section','Gender','Face Status','Status','Attendances','Date Registered'];
    const rows = reportRows.map((r, i) => {
        let faceColor = r.face_status.toLowerCase() === 'registered' ? '#166534' : '#d97706';
        let statusColor = r.status.toLowerCase() === 'active' ? '#166534' : (r.status.toLowerCase() === 'inactive' ? '#dc2626' : '#2563eb');
        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i + 1}</td><td><strong>${r.stud_id}</strong></td>
            <td><strong>${r.last_name}</strong></td><td>${r.first_name}</td><td>${r.middle_name}</td>
            <td>${r.grade_level}</td><td style="text-align:center">${r.section_name}</td>
            <td style="text-align:center">${r.gender}</td>
            <td><span style="color:${faceColor};font-weight:bold">${r.face_status.toUpperCase()}</span></td>
            <td><span style="color:${statusColor};font-weight:bold">${r.status.toUpperCase()}</span></td>
            <td style="text-align:center">${r.total_attendances}</td>
            <td>${r.date_registered}</td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Students List Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        .header-container{background-color:#ffffff;color:#000000;text-align:center;margin-bottom:20px;padding:20px 15px;border:2px solid #000000;border-radius:8px;}
        .logos-text-wrapper{display:flex;justify-content:center;align-items:center;gap:25px;margin-bottom:10px}
        .logo-img{height:50px;width:auto;object-fit:contain}
        .univ-title{font-size:18px;font-weight:bold;color:#000000;line-height:1.2}
        .college-title{font-size:11px;color:#444444;letter-spacing:1px;text-transform:uppercase}
        .report-title{font-size:16px;font-weight:bold;color:#000000;margin-top:12px;text-transform:uppercase;letter-spacing:1px}
        .report-meta{font-size:11px;color:#555555;margin-top:5px}
        table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #000000 !important}
        th{background:#ffffff;color:#000000;padding:8px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;border:1px solid #000000 !important}
        td{padding:8px 10px;border:1px solid #000000 !important;font-size:11px;text-align:center}
        td:nth-child(2),td:nth-child(3),td:nth-child(4),td:nth-child(5){text-align:left}
        tr:nth-child(even){background:#f9fafb}
        .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        @media print{body{padding:0px}}
    </style></head><body>
    <div class="header-container">
        <div class="logos-text-wrapper">
            <img src="../resc/assets/school_logo.png" class="logo-img" alt="School Logo">
            <div>
                <div class="univ-title">K-10 SCHOOL NAME</div>
                <div class="college-title">Attendance Management System</div>
            </div>
        </div>
        <div class="report-title">Students List Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Total: ${META.total} &nbsp;&middot;&nbsp; Face Registered: ${META.registered} &nbsp;&middot;&nbsp; Pending: ${META.pending}</div>
    </div>
    <table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="footer">K-10 Attendance System &nbsp;&middot;&nbsp; ${nowStr}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script></body></html>`);
    w.document.close();
    await autoSaveReport('Print');
}

async function downloadPDF() {
    if (!checkDuplicateWarning('PDF')) return;
    if (!window.jspdf) { showToast('PDF library not loaded yet. Please try again.', true); return; }
    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const now = new Date();
        const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
        const pageW = doc.internal.pageSize.width;

        function loadImage(src) {
            return new Promise((resolve) => {
                const img = new Image(); img.crossOrigin = 'anonymous';
                img.onload = () => { try { const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); resolve(canvas.toDataURL('image/png')); } catch(e) { resolve(null); } };
                img.onerror = () => resolve(null); img.src = src;
            });
        }

        const [schoolLogoData] = await Promise.all([
            loadImage('../resc/assets/school_logo.png')
        ]);

        const centerX = pageW / 2, headerHeight = 45;
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.1);
        doc.rect(10, 5, pageW - 20, headerHeight, 'S');

        const logoSize = 18;
        if (schoolLogoData) doc.addImage(schoolLogoData, 'PNG', centerX - 85, 10, logoSize, logoSize);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text('K-10 SCHOOL NAME', centerX, 18, { align: 'center' });
        doc.setFontSize(9); doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal');
        doc.text('ATTENDANCE MANAGEMENT SYSTEM', centerX, 23, { align: 'center' });
        doc.setFontSize(14); doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold');
        doc.text('STUDENTS LIST REPORT', centerX, 33, { align: 'center' });
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${nowStr}  ·  Total: ${META.total}  ·  Face Registered: ${META.registered}  ·  Pending: ${META.pending}`, centerX, 39, { align: 'center' });

        const head = [['#','Student ID','Last Name','First Name','M.I.','Grade','Section','Gender','Face','Status','Att','Date']];
        const body = reportRows.map((r, i) => [i+1, r.stud_id, r.last_name, r.first_name, (r.middle_name || '').substring(0,2)+'.', r.grade_level, r.section_name, r.gender, r.face_status.toUpperCase(), r.status.toUpperCase(), r.total_attendances, r.date_registered]);

        doc.autoTable({
            head, body,
            startY: headerHeight + 10,
            margin: { left: 10, right: 10 },
            theme: 'grid',
            headStyles: { fillColor: [255,255,255], fontSize: 6.5, fontStyle: 'bold', textColor: [0,0,0], lineColor: [0,0,0], lineWidth: 0.1, halign: 'center', valign: 'middle' },
            styles: { fontSize: 6.5, cellPadding: 2, valign: 'middle', lineColor: [0,0,0], lineWidth: 0.1, textColor: [0,0,0] },
            columnStyles: { 0:{cellWidth:7,halign:'center'}, 1:{cellWidth:18,halign:'center',fontStyle:'bold'}, 2:{cellWidth:20}, 3:{cellWidth:20}, 4:{cellWidth:10}, 5:{cellWidth:18,halign:'center'}, 6:{cellWidth:15,halign:'center'}, 7:{cellWidth:12,halign:'center'}, 8:{cellWidth:18,halign:'center',fontStyle:'bold'}, 9:{cellWidth:15,halign:'center',fontStyle:'bold'}, 10:{cellWidth:10,halign:'center'}, 11:{cellWidth:18,halign:'center'} },
            didParseCell(d) {
                if (d.column.index === 8 && d.section === 'body') { const s=(d.cell.text[0]||'').toLowerCase(); if(s==='registered'){d.cell.styles.textColor=[22,101,52];} if(s==='not registered'){d.cell.styles.textColor=[217,119,6];} }
                if (d.column.index === 9 && d.section === 'body') { const s=(d.cell.text[0]||'').toLowerCase(); if(s==='active'){d.cell.styles.textColor=[22,101,52];} if(s==='inactive'){d.cell.styles.textColor=[220,38,38];} if(s==='graduated'){d.cell.styles.textColor=[37,99,235];} }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156,163,175); doc.text(`K-10 Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`, pageW/2, doc.internal.pageSize.height-8, { align: 'center' }); }
        doc.save(`Students_Report_${now.toISOString().split('T')[0]}.pdf`);
        await autoSaveReport('PDF');
    } catch (err) {
        console.error('PDF generation error:', err);
        showToast('There was an error generating the PDF.', true);
    }
}

async function exportCSV() {
    if (!checkDuplicateWarning('CSV')) return;
    const cols = ['#','Student ID','Last Name','First Name','Middle Name','Grade Level','Section','Gender','Face Status','Status','Total Attendances','Date Registered'];
    const lines = [cols.join(','), ...reportRows.map((r, i) => [i+1,`"${r.stud_id}"`,`"${r.last_name}"`,`"${r.first_name}"`,`"${r.middle_name}"`,`"${r.grade_level}"`,`"${r.section_name}"`,`"${r.gender}"`,`"${r.face_status}"`,r.status,r.total_attendances,`"${r.date_registered}"`].join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `Students_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    await autoSaveReport('CSV');
}

async function exportExcel() {
    if (!checkDuplicateWarning('Excel')) return;
    if (!window.XLSX) return exportCSV();
    const wb = XLSX.utils.book_new();
    const headers = ['#','Student ID','Last Name','First Name','Middle Name','Grade Level','Section','Gender','Face Status','Status','Total Attendances','Date Registered'];
    const rows = reportRows.map((r, i) => [i+1, r.stud_id, r.last_name, r.first_name, r.middle_name, r.grade_level, r.section_name, r.gender, r.face_status, r.status.toUpperCase(), r.total_attendances, r.date_registered]);
    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Students');
    XLSX.writeFile(wb, `Students_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    await autoSaveReport('Excel');
}

// ══════════════════════════════════════════════════════════
// 7. MODAL HELPERS
// ══════════════════════════════════════════════════════════
function openModal(id) {
    const m = document.getElementById(id);
    m.style.display = 'flex';
    setTimeout(() => m.classList.add('active'), 10);
}

function closeModal(id) {
    const m = document.getElementById(id);
    m.classList.remove('active');
    setTimeout(() => {
        m.style.display = 'none';
        if (id === 'faceRegModal') {
            document.getElementById('studentIdSearch').value = '';
            document.getElementById('searchResult').classList.remove('active');
        }
    }, 200);
}

window.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeReportModal();
        ['faceRegModal'].forEach(id => {
            const m = document.getElementById(id);
            if (m && m.classList.contains('active')) closeModal(id);
        });
    }
});

// ══════════════════════════════════════════════════════════
// 8. UTILITIES
// ══════════════════════════════════════════════════════════
function showToast(msg, showLink) {
    const t = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 4000);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}