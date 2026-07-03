/* ============================================================
   resc/js/professorsManagement.js
   Replaces PHP mysqli calls with Supabase JS client.
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

let allProfessors = [];
let reportRows = [];
let META = { total: 0, inSession: 0, schedules: 0, facial: 0, date: '' };
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

document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        console.error('Supabase client not initialized.');
        return;
    }
    
    // Set report date
    const now = new Date();
    META.date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    document.getElementById('rmGenDate').textContent = `Generated ${META.date}`;

    await loadProfessorsData();
    initFilters();
    initRealTimeValidation();
});

// ────────────────────────────────────────────
// LOAD ALL PROFESSORS DATA
// ────────────────────────────────────────────
async function loadProfessorsData() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const currentDay = days[new Date().getDay()];
        const nowTimeStr = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Manila' }).substring(0,8);

        // 1. Fetch active schedules count
        const { count: totalSchedules } = await supabaseClient
            .from('lab_schedules')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active');
        META.schedules = totalSchedules || 0;

        // 2. Fetch Professors, joined with Departments and Schedules
        const { data: professors, error } = await supabaseClient
            .from('professors')
            .select(`
                *,
                departments ( department_name ),
                lab_schedules (
                    schedule_id, section, day_of_week, start_time, end_time, status,
                    subjects ( subject_code, subject_name ),
                    lab_sessions ( session_date, status )
                )
            `)
            .order('last_name', { ascending: true });

        if (error) throw error;

        const professorsWithFace = await Promise.all((professors || []).map(async prof => ({
            ...prof,
            has_face_images: await hasFaceFilesInStorage(prof.facial_dataset_path)
        })));

        allProfessors = [];
        reportRows = [];
        META.inSession = 0;
        META.facial = 0;
        
        let activeProfessorsCount = 0;

        // Process data
        professorsWithFace.forEach(prof => {
            if (prof.status === 'active') activeProfessorsCount++;
            if (prof.has_face_images) META.facial++;

            // Filter active schedules
            const activeSchedules = prof.lab_schedules ? prof.lab_schedules.filter(s => s.status === 'active') : [];
            
            // Build Subjects string
            const subjectsSet = new Set();
            activeSchedules.forEach(s => {
                if(s.subjects) subjectsSet.add(`${s.subjects.subject_code} (${s.section})`);
            });
            const subjectsTaught = Array.from(subjectsSet).join(', ');

            // Check if currently in session
            let inSessionObj = null;
            for (let s of activeSchedules) {
                if (s.day_of_week === currentDay && nowTimeStr >= s.start_time && nowTimeStr <= s.end_time) {
                    const todaySession = s.lab_sessions.find(ls => ls.session_date === todayStr && ['scheduled', 'ongoing'].includes(ls.status));
                    if (todaySession) {
                        inSessionObj = { code: s.subjects?.subject_code, section: s.section };
                        META.inSession++;
                        break;
                    }
                }
            }

            // Extract the actual department name from the joined table
            const deptName = prof.departments ? prof.departments.department_name : '—';

            const enrichedProf = {
                ...prof,
                fullName: `${prof.first_name} ${prof.middle_name || ''} ${prof.last_name}`.replace(/\s+/g, ' ').trim(),
                departmentName: deptName,
                scheduleCount: activeSchedules.length,
                subjectsTaught: subjectsTaught,
                inSessionObj: inSessionObj,
                sessionStatus: inSessionObj ? 'in-session' : 'available',
                faceStatus: prof.has_face_images ? 'registered' : 'not-registered'
            };

            allProfessors.push(enrichedProf);

            // Add to report rows
            reportRows.push({
                employee_id: prof.employee_id,
                last_name: prof.last_name,
                first_name: prof.first_name,
                middle_name: prof.middle_name || '—',
                department: deptName,
                email: prof.email,
                face_status: prof.has_face_images ? 'Registered' : 'Not Registered',
                status: prof.status,
                active_schedules: activeSchedules.length,
                sessions_done: 0,
                subjects: Array.from(new Set(activeSchedules.map(s => s.subjects?.subject_code))).join(', ')
            });
        });

        META.total = activeProfessorsCount;

        // Update UI Stats
        document.getElementById('statTotal').textContent = META.total;
        document.getElementById('statInSession').textContent = META.inSession;
        document.getElementById('statSchedules').textContent = META.schedules;
        document.getElementById('statFaceReg').textContent = META.facial;

        // NEW: Populate dropdowns based on available data
        populateDynamicFilters();

        renderTable(allProfessors);

    } catch (error) {
        console.error('Error loading professors:', error);
        document.getElementById('professorsTableBody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:red;">Error loading data.</td></tr>`;
    }
}

function renderTable(data) {
    const tbody = document.getElementById('professorsTableBody');
    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:20px;color:#6b7280;">No professors found.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(prof => `
        <tr data-status="${prof.status}" data-session="${prof.sessionStatus}" data-face="${prof.faceStatus}">
            <td><strong>${escapeHtml(prof.employee_id)}</strong></td>
            <td><strong>${escapeHtml(prof.last_name)}</strong></td>
            <td>${escapeHtml(prof.first_name)}</td>
            <td>${escapeHtml(prof.middle_name || '-')}</td>
            <td>${escapeHtml(prof.suffix || '-')}</td>
            <td>${escapeHtml(prof.departmentName)}</td>
            <td>${escapeHtml(prof.email)}</td>
            <td>
                ${prof.subjectsTaught ? `<span class="subjects-taught">${escapeHtml(prof.subjectsTaught)}</span>` : `<span style="color:#999;font-style:italic">No schedules</span>`}
            </td>
            <td>
                ${prof.faceStatus === 'registered' 
                    ? `<span class="action-icon face-reg registered"><i class="fas fa-check"></i></span>`
                    : `<span class="action-icon face-reg" onclick="openFaceRegModal('${prof.employee_id}')"><i class="fas fa-times"></i></span>`
                }
            </td>
            <td>
                ${prof.inSessionObj 
                    ? `<span class="status-indicator in-session"><span class="status-dot active"></span> In Session</span>
                       <div class="session-badge"><i class="fa-solid fa-chalkboard"></i> ${escapeHtml(prof.inSessionObj.code)}</div>`
                    : `<span class="status-indicator available"><span class="status-dot inactive"></span> Available</span>`
                }
            </td>
        </tr>
    `).join('');
}

// ────────────────────────────────────────────
// FILTERS
// ────────────────────────────────────────────
function populateDynamicFilters() {
    const deptFilter = document.getElementById('deptFilter');
    const subjFilter = document.getElementById('subjectFilter');

    if (!deptFilter || !subjFilter) return;

    const depts = [...new Set(allProfessors.map(p => p.departmentName).filter(d => d && d !== '—'))].sort();

    const allSubjs = [];
    allProfessors.forEach(p => {
        if (p.lab_schedules) {
            p.lab_schedules.forEach(s => {
                if (s.status === 'active' && s.subjects?.subject_code) {
                    allSubjs.push(s.subjects.subject_code);
                }
            });
        }
    });
    const subjects = [...new Set(allSubjs)].sort();

    deptFilter.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    subjFilter.innerHTML = '<option value="">All Subjects</option>' + subjects.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

function initFilters() {
    const search  = document.getElementById('searchInput');
    const status  = document.getElementById('statusFilter');
    const session = document.getElementById('sessionFilter');
    const face    = document.getElementById('faceFilter');
    const dept    = document.getElementById('deptFilter');
    const subj    = document.getElementById('subjectFilter');

    function apply() {
        const q  = search.value.toLowerCase().trim();
        const st = status.value;
        const se = session.value;
        const fc = face.value;
        const dp = dept?.value;
        const sb = subj?.value;
        
        const filtered = allProfessors.filter(p => {
            const matchQ  = !q || p.fullName.toLowerCase().includes(q) || p.employee_id.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
            const matchSt = !st || p.status === st;
            const matchSe = !se || p.sessionStatus === se;
            const matchFc = !fc || p.faceStatus === fc;
            const matchDp = !dp || p.departmentName === dp;
            const matchSb = !sb || (p.subjectsTaught && p.subjectsTaught.includes(sb));

            return matchQ && matchSt && matchSe && matchFc && matchDp && matchSb;
        });
        renderTable(filtered);
    }

    search.addEventListener('input', apply);
    [status, session, face, dept, subj].forEach(el => {
        if(el) el.addEventListener('change', apply);
    });

    document.getElementById('clearFilters').addEventListener('click', () => {
        search.value = ''; status.value = ''; session.value = ''; face.value = '';
        if(dept) dept.value = '';
        if(subj) subj.value = '';
        renderTable(allProfessors);
    });
}

// ────────────────────────────────────────────
// MODALS & UTILS
// ────────────────────────────────────────────
function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.style.display = 'flex';
    setTimeout(() => m.classList.add('active'), 10);
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove('active');
    
    setTimeout(() => {
        m.style.display = 'none';
        if (id === 'faceRegModal') {
            document.getElementById('profIdSearch').value = '';
            document.getElementById('profStudentInfo').innerHTML = '';
            document.getElementById('profFaceStatus').innerHTML = '';
            document.getElementById('profFaceStatus').className = 'face-status';
            const rb = document.getElementById('profRegisterFaceBtn');
            if (rb) rb.style.display = 'none';
        }
    }, 200);
}

function openFaceRegModal(employeeId) {
    openModal('faceRegModal');
    document.getElementById('profIdSearch').value = employeeId;
    searchProfessor(); 
}

window.addEventListener('click', e => {
    if (e.target.classList.contains('prof-modal')) closeModal(e.target.id);
});

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
// REPORT MODAL LOGIC (With Duplicate Prevention & White Banner)
// ────────────────────────────────────────────
let existingReportsToday = []; 

async function openReportModal() {
    document.getElementById('rmTotalChip').textContent = META.total;
    document.getElementById('rmSchedulesChip').textContent = META.schedules;
    document.getElementById('rmFaceChip').textContent = META.facial;
    
    const tbody = document.getElementById('rmTableBody');
    if (!reportRows || reportRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:40px;color:#9ca3af">No data available.</td></tr>`;
    } else {
        tbody.innerHTML = reportRows.map((r, i) => `
            <tr>
                <td style="color:#9ca3af;font-size:11px">${i+1}</td>
                <td style="font-weight:700;color:#166534;font-size:12px">${escapeHtml(r.employee_id)}</td>
                <td style="font-weight:600">${escapeHtml(r.last_name)}</td>
                <td>${escapeHtml(r.first_name)}</td>
                <td style="color:#6b7280">${escapeHtml(r.middle_name)}</td>
                <td style="font-size:12px">${escapeHtml(r.department)}</td>
                <td style="font-size:12px">${escapeHtml(r.email)}</td>
                <td><span class="rm-badge ${r.face_status==='Registered'?'registered':'not-registered'}">${r.face_status}</span></td>
                <td><span class="rm-badge ${r.status}">${r.status}</span></td>
                <td style="text-align:center"><strong>${r.active_schedules}</strong></td>
                <td style="text-align:center"><strong>${r.sessions_done}</strong></td>
                <td style="font-size:11.5px;color:#6b7280;max-width:180px;word-break:break-word">${escapeHtml(r.subjects || '—')}</td>
            </tr>
        `).join('');
    }
    
    document.getElementById('rmOverlay').classList.add('on');

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', 'professors')
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

function closeReportModal() {
    document.getElementById('rmOverlay').classList.remove('on');
}

function checkDuplicateWarning(exportType) {
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const reportName = `Professors Report — ${dateStr} (${exportType})`;
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
    const reportName = `Professors Report — ${dateStr} (${exportType})`;
    const payload = { report_type: 'professors', report_name: reportName, filters: JSON.stringify({}), report_data: JSON.stringify(reportRows) };

    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;
        
        if (exportType === 'Manual Save') {
            if (typeof showToast === 'function') showToast('Report saved successfully!', true);
            else alert('Report saved successfully!');
        }
        
        existingReportsToday.push({ name: payload.report_name, dataString: payload.report_data }); 
    } catch (err) {
        console.error('Auto-save error:', err);
    }
}

async function printReport() {
    if (!checkDuplicateWarning('Print')) return;

    const { deptLogo, deptName } = getDeptLogos(); // ✅ dynamic department info

    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr  = `${dateStr} at ${timeStr}`;

    const cols = ['#','Emp ID','Last Name','First Name','M.I.','Department','Face Status','Status','Schedules','Sessions Done','Subjects'];

    const rows = reportRows.map((r, i) => {
        let faceColor = r.face_status.toLowerCase() === 'registered' ? '#166534' : '#d97706';
        let statusColor = r.status.toLowerCase() === 'active' ? '#166534' : '#dc2626';
        let mi = r.middle_name ? r.middle_name.substring(0,2) + '.' : '—';
        
        return `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i + 1}</td>
            <td><strong>${r.employee_id}</strong></td>
            <td><strong>${r.last_name}</strong></td>
            <td>${r.first_name}</td>
            <td>${mi}</td>
            <td>${r.department}</td>
            <td><span style="color: ${faceColor}; font-weight: bold;">${r.face_status.toUpperCase()}</span></td>
            <td><span style="color: ${statusColor}; font-weight: bold;">${r.status.toUpperCase()}</span></td>
            <td style="text-align:center">${r.active_schedules}</td>
            <td style="text-align:center">${r.sessions_done}</td>
            <td style="font-size:9px">${(r.subjects || '—').substring(0, 45)}</td>
        </tr>`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Professors Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        .header-container { background-color: #ffffff; color: #000000; text-align: center; margin-bottom: 20px; padding: 20px 15px; border: 2px solid #000000; border-radius: 8px; }
        .logos-text-wrapper { display: flex; justify-content: center; align-items: center; gap: 25px; margin-bottom: 10px; }
        .logo-img { height: 50px; width: auto; object-fit: contain; }
        .univ-title { font-size: 18px; font-weight: bold; color: #000000; line-height: 1.2; letter-spacing: 0.5px;}
        .college-title { font-size: 11px; color: #444444; letter-spacing: 1px; text-transform: uppercase;}
        .report-title { font-size: 16px; font-weight: bold; color: #000000; margin-top: 12px; text-transform: uppercase; letter-spacing: 1px;}
        .report-meta { font-size: 11px; color: #555555; margin-top: 5px; }
        table{width:100%;border-collapse:collapse; margin-top: 10px; border: 1px solid #000000 !important;}
        th{background:#ffffff; color:#000000; padding:8px 10px; text-align:center; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; border: 1px solid #000000 !important;}
        td{padding:8px 10px; border: 1px solid #000000 !important; font-size:11px; text-align:center;}
        td:nth-child(2), td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(11) {text-align:left;}
        tr:nth-child(even){background:#f9fafb;}
        .footer{margin-top:20px;text-align:center;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:10px}
        @media print{body{padding:0px}}
    </style></head><body>
    <div class="header-container">
        <div class="logos-text-wrapper">
            <img src="../resc/assets/plp_logo.png" class="logo-img" alt="PLP Logo">
            <div><div class="univ-title">PAMANTASAN NG LUNGSOD NG PASIG</div><div class="college-title">${deptName}</div></div>
            <img src="${deptLogo}" class="logo-img" alt="Department Logo">
        </div>
        <div class="report-title">Professors Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;&middot;&nbsp; Total Professors: ${META.total} &nbsp;&middot;&nbsp; Face Registered: ${META.facial} &nbsp;&middot;&nbsp; Active Schedules: ${META.schedules}</div>
    </div>
    <table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="footer">Laboratory Attendance System &nbsp;&middot;&nbsp; ${nowStr}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
    w.document.close();
    await autoSaveReport('Print');
}

async function downloadPDF() {
    if (!checkDuplicateWarning('PDF')) return;
    if (!window.jspdf) { alert('PDF library not loaded yet. Please try again.'); return; }

    try {
        const { deptLogo, deptName } = getDeptLogos(); // ✅ dynamic department info

        const { jsPDF } = window.jspdf;
        const doc     = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const now     = new Date();
        const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const nowStr  = `${dateStr} at ${timeStr}`;
        const pageW   = doc.internal.pageSize.width;

        function loadImage(src) {
            return new Promise((resolve) => {
                const img = new Image(); img.crossOrigin = 'anonymous';
                img.onload = () => { try { const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0); resolve(canvas.toDataURL('image/png')); } catch(e) { resolve(null); } };
                img.onerror = () => resolve(null); img.src = src;
            });
        }

        // ✅ Use deptLogo instead of hardcoded ccs_logo.png
        const [plpData, ccsData] = await Promise.all([
            loadImage('../resc/assets/plp_logo.png'),
            loadImage(deptLogo)
        ]);
        const centerX = pageW / 2, headerHeight = 45;
        
        doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.1);
        doc.rect(10, 5, pageW - 20, headerHeight, 'S');
        
        if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, 18, 18);
        if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 67, 10, 18, 18);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
        doc.setFontSize(9); doc.setTextColor(60, 60, 60); doc.setFont('helvetica', 'normal');
        doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' }); // ✅ dynamic
        doc.setFontSize(14); doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'bold');
        doc.text('PROFESSORS REPORT', centerX, 33, { align: 'center' });
        doc.setFontSize(8); doc.setTextColor(80, 80, 80); doc.setFont('helvetica', 'normal');
        doc.text(`Generated: ${nowStr}  ·  Total Professors: ${META.total}  ·  Face Registered: ${META.facial}  ·  Active Schedules: ${META.schedules}`, centerX, 39, { align: 'center' });

        const head = [['#','Emp ID','Last Name','First Name','M.I.','Department','Face Status','Status','Schedules','Sessions Done','Subjects']];
        const body = reportRows.map((r, i) => [
            i + 1, r.employee_id, r.last_name, r.first_name, r.middle_name ? r.middle_name.substring(0,2) + '.' : '—',
            r.department, r.face_status.toUpperCase(), r.status.toUpperCase(),
            r.active_schedules, r.sessions_done, r.subjects ? r.subjects.substring(0, 45) + (r.subjects.length > 45 ? '...' : '') : '—'
        ]);

        doc.autoTable({
            head, body, startY: headerHeight + 10, margin: { left: 14, right: 14 }, theme: 'grid',
            headStyles: { fillColor: [255, 255, 255], fontSize: 7.5, fontStyle: 'bold', textColor: [0,0,0], lineColor: [0,0,0], lineWidth: 0.1, halign: 'center', valign: 'middle' },
            styles: { fontSize: 7.5, cellPadding: 3, valign: 'middle', lineColor: [0,0,0], lineWidth: 0.1, textColor: [0,0,0] },
            columnStyles: { 0:{cellWidth:10,halign:'center'}, 1:{cellWidth:20,halign:'center',fontStyle:'bold'}, 2:{cellWidth:30,fontStyle:'bold'}, 3:{cellWidth:30}, 6:{cellWidth:20,halign:'center',fontStyle:'bold'}, 7:{cellWidth:15,halign:'center',fontStyle:'bold'}, 8:{cellWidth:20,halign:'center'}, 9:{cellWidth:20,halign:'center'} },
            didParseCell(d) {
                if (d.column.index === 6 && d.section === 'body') { const s = (d.cell.text[0] || '').toLowerCase(); if (s === 'registered') { d.cell.styles.textColor = [22, 101, 52]; } if (s === 'not registered') { d.cell.styles.textColor = [217, 119, 6]; } }
                if (d.column.index === 7 && d.section === 'body') { const s = (d.cell.text[0] || '').toLowerCase(); if (s === 'active') { d.cell.styles.textColor = [22, 101, 52]; } if (s === 'inactive') { d.cell.styles.textColor = [220, 38, 38]; } }
            }
        });

        const pages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(156, 163, 175); doc.text(`Laboratory Attendance System  ·  Page ${i} of ${pages}  ·  ${nowStr}`, pageW / 2, doc.internal.pageSize.height - 8, { align: 'center' }); }
        doc.save(`Professors_Report_${now.toISOString().split('T')[0]}.pdf`);
        await autoSaveReport('PDF');
    } catch (err) {
        console.error('PDF generation error:', err);
        if (typeof showToast === 'function') showToast('There was an error generating the PDF.', true);
    }
}

// ── Excel ──────────────────────────────────────────────────
async function exportExcel() {
    if (!checkDuplicateWarning('Excel')) return;

    if (!window.XLSX) {
        if (typeof showToast === 'function') showToast('Excel library not loaded. Please refresh the page.', true);
        else alert('Excel library not loaded.');
        return; 
    }
    
    const wb = XLSX.utils.book_new();
    const headers = ['#','Employee ID','Last Name','First Name','Middle Name','Department','Email','Face Status','Status','Active Schedules','Sessions Done','Subjects'];
                  
    const rows = reportRows.map((r, i) => [
        i + 1, r.employee_id, r.last_name, r.first_name, r.middle_name,
        r.department, r.email, r.face_status, r.status.toUpperCase(),
        r.active_schedules, r.sessions_done, r.subjects || ''
    ]);

    const dataSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Professors');
    XLSX.writeFile(wb, `Professors_Report_${new Date().toISOString().split('T')[0]}.xlsx`);

    await autoSaveReport('Excel');
}

// XML export removed.

function initRealTimeValidation() {}

// ── FACE REGISTRATION SEARCH & REDIRECT ──
async function searchProfessor() {
    const empId = document.getElementById('profIdSearch').value.trim();
    const searchBtn = document.getElementById('profSearchBtn');
    const resultDiv = document.getElementById('profSearchResult');
    
    if (!empId) { showToast('Please enter an Employee ID.'); return; }

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';
    
    resultDiv.style.display = 'none'; 
    resultDiv.classList.remove('active');

    try {
        const { data: p, error } = await supabaseClient
            .from('professors')
            .select('employee_id, first_name, last_name, facial_dataset_path')
            .eq('employee_id', empId)
            .single();

        if (error || !p) {
            showToast('Professor not found.');
            document.getElementById('profRegisterFaceBtn').style.display = 'none';
            return;
        }

        const hasFace = await hasFaceFilesInStorage(p.facial_dataset_path);
        const statusDiv = document.getElementById('profFaceStatus');
        statusDiv.className = 'face-status ' + (hasFace ? 'registered' : 'not-registered');
        statusDiv.innerHTML = hasFace
            ? '<i class="fa-solid fa-check-circle"></i> Facial data already registered'
            : '<i class="fa-solid fa-exclamation-circle"></i> Facial data not registered yet';

        const rb = document.getElementById('profRegisterFaceBtn');
        rb.style.display = hasFace ? 'none' : 'flex';

        document.getElementById('profStudentInfo').innerHTML = `
            <div class="info-item"><label>Employee ID</label><div class="value">${escapeHtml(p.employee_id)}</div></div>
            <div class="info-item"><label>Full Name</label><div class="value">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div></div>
        `;
        
        resultDiv.style.display = 'block';
        setTimeout(() => resultDiv.classList.add('active'), 10);
        
    } catch (err) {
        showToast('Error: ' + err.message);
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-search"></i> Search Professor';
    }
}

function redirectToProfFaceReg() {
    const empId = document.getElementById('profIdSearch').value.trim();
    window.top.location.href = '../students/accountRegistration.html?role=professor&employee_id=' + encodeURIComponent(empId);
}