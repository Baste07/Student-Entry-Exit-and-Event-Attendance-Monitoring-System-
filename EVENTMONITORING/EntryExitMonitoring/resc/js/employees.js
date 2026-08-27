/* ============================================================
   resc/js/employees.js
   Employees List — Entry/Exit Module — Supabase integration
   Mirrors students.js but for the employees table
============================================================ */
'use strict';

let allEmployees = [];
let reportRows   = [];
let META = { total: 0, registered: 0, pending: 0, date: '' };
const FACE_BUCKET = 'facial_data';

// ── Check if employee has actual face files in storage ──────
async function hasFaceFilesInStorage(datasetPath) {
    if (!datasetPath) return false;
    try {
        const { data, error } = await supabaseClient.storage
            .from(FACE_BUCKET)
            .list(datasetPath, { limit: 20, offset: 0, sortBy: { column: 'name', order: 'asc' } });
        if (error) return false;
        return (data || []).some(f => {
            const name = (f?.name || '').toLowerCase();
            return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
        });
    } catch { return false; }
}

function resolveHasFace(emp) {
    if (emp && typeof emp.has_face_images === 'boolean') return emp.has_face_images;
    return !!emp?.facial_dataset_path;
}

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!supabaseClient) {
        showToast('⚠️ Supabase not configured. Check config/.env.js', false);
        return;
    }
    await loadEmployees();
    initFilters();
});

// ══════════════════════════════════════════════════════════
// 1. LOAD EMPLOYEES FROM SUPABASE
// ══════════════════════════════════════════════════════════
async function loadEmployees() {
    try {
        const { data: employees, error } = await supabaseClient
            .from('employees')
            .select(`
                employee_id,
                emp_no,
                first_name,
                middle_name,
                last_name,
                suffix,
                email,
                phone_number,
                profile_picture,
                facial_dataset_path,
                status,
                created_at
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        allEmployees = await Promise.all((employees || []).map(async e => ({
            ...e,
            has_face_images: await hasFaceFilesInStorage(e.facial_dataset_path)
        })));

        const total      = allEmployees.length;
        const registered = allEmployees.filter(e => resolveHasFace(e)).length;
        const pending    = total - registered;

        META = {
            total, registered, pending,
            date: new Date().toLocaleString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            })
        };

        document.getElementById('statTotal').textContent      = total;
        document.getElementById('statRegistered').textContent = registered;
        document.getElementById('statPending').textContent    = pending;

        renderTable(allEmployees);
        buildReportRows();

    } catch (err) {
        console.error('loadEmployees error:', err);
        document.getElementById('employeesTableBody').innerHTML =
            `<tr><td colspan="9" style="text-align:center;padding:40px;color:#dc2626">
                <i class="fa-solid fa-circle-exclamation"></i> Failed to load employees: ${err.message}
            </td></tr>`;
    }
}

// ══════════════════════════════════════════════════════════
// 2. RENDER TABLE
// ══════════════════════════════════════════════════════════
function renderTable(employees) {
    const tbody = document.getElementById('employeesTableBody');

    if (!employees.length) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af">
            <i class="fa-solid fa-user-tie" style="font-size:32px;display:block;margin-bottom:10px;color:#ede9fe"></i>
            No employees found.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = employees.map(e => {
        const hasFace  = resolveHasFace(e);
        const dateReg  = e.created_at
            ? new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';
        const statusCls = (e.status || 'active').toLowerCase();
        const faceData  = hasFace ? 'registered' : 'not-registered';

        return `<tr data-id="${e.employee_id}" data-status="${statusCls}" data-face="${faceData}">
            <td style="font-weight:700;color:#5b21b6">${escHtml(e.emp_no || '-')}</td>
            <td style="font-weight:600">${escHtml(e.last_name)}</td>
            <td>${escHtml(e.first_name)}</td>
            <td>${escHtml(e.middle_name || '-')}</td>
            <td>${escHtml(e.suffix || '-')}</td>
            <td style="font-size:12.5px;color:#6b7280">${escHtml(e.email || '-')}</td>
            <td>
                <span class="rm-badge ${statusCls}">${capitalize(statusCls)}</span>
            </td>
            <td>
                ${hasFace
                    ? `<span class="action-icon face-reg reg-done" title="Facial data registered"><i class="fas fa-check"></i></span>`
                    : `<span class="action-icon face-reg" title="Register facial data"
                         onclick="openFaceRegModal('${escHtml(e.emp_no)}')">
                         <i class="fas fa-times"></i>
                       </span>`
                }
            </td>
            <td style="font-size:12.5px">${dateReg}</td>
        </tr>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// 3. FILTERS & SEARCH
// ══════════════════════════════════════════════════════════
function initFilters() {
    const searchInput  = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const faceFilter   = document.getElementById('faceFilter');
    const sortFilter   = document.getElementById('sortFilter');
    const clearBtn     = document.getElementById('clearFilters');

    [searchInput, statusFilter, faceFilter, sortFilter].forEach(el => {
        if (el) {
            el.addEventListener('input',  applyFilters);
            el.addEventListener('change', applyFilters);
        }
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            searchInput.value  = '';
            statusFilter.value = '';
            faceFilter.value   = '';
            sortFilter.value   = '';
            applyFilters();
        });
    }
}

function applyFilters() {
    const q   = (document.getElementById('searchInput')?.value  || '').toLowerCase().trim();
    const st  = (document.getElementById('statusFilter')?.value || '');
    const fc  = (document.getElementById('faceFilter')?.value   || '');
    const so  = (document.getElementById('sortFilter')?.value   || '');

    let filtered = allEmployees.filter(e => {
        const fullName   = `${e.first_name || ''} ${e.middle_name || ''} ${e.last_name || ''}`.toLowerCase();
        const searchable = `${e.emp_no || ''} ${fullName} ${e.email || ''}`.toLowerCase();
        const matchQ  = !q  || searchable.includes(q);
        const matchSt = !st || (e.status || 'active').toLowerCase() === st;
        const hasFace = resolveHasFace(e);
        const matchFc = !fc || (fc === 'registered' ? hasFace : !hasFace);
        return matchQ && matchSt && matchFc;
    });

    if (so === 'az') filtered.sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));
    if (so === 'za') filtered.sort((a, b) => (b.last_name || '').localeCompare(a.last_name || ''));

    renderTable(filtered);
}

// ══════════════════════════════════════════════════════════
// 4. FACE REGISTRATION — search and redirect
// ══════════════════════════════════════════════════════════
async function searchEmployee() {
    const empNo     = document.getElementById('employeeIdSearch').value.trim();
    const searchBtn = document.getElementById('searchBtn');
    const searchRes = document.getElementById('searchResult');

    if (!empNo) { showToast('Please enter an Employee Number.', false); return; }

    searchBtn.disabled = true;
    searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

    try {
        const { data: e, error } = await supabaseClient
            .from('employees')
            .select('employee_id, emp_no, first_name, middle_name, last_name, suffix, email, facial_dataset_path')
            .eq('emp_no', empNo)
            .single();

        if (error || !e) {
            showToast('Employee not found.', false);
            searchRes.classList.remove('active');
            return;
        }

        const hasFace = await hasFaceFilesInStorage(e.facial_dataset_path);
        document.getElementById('faceStatusEl').className = 'face-status ' + (hasFace ? 'registered' : 'not-registered');
        document.getElementById('faceStatusEl').innerHTML = hasFace
            ? '<i class="fa-solid fa-check-circle"></i> Facial data already registered'
            : '<i class="fa-solid fa-exclamation-circle"></i> Facial data not registered yet';

        const rb = document.getElementById('registerFaceBtn');
        rb.style.display = hasFace ? 'none' : 'block';
        rb.dataset.empNo = e.emp_no;

        document.getElementById('employeeInfo').innerHTML = `
            <div class="info-item"><label>Employee No.</label><div class="value">${escHtml(e.emp_no)}</div></div>
            <div class="info-item"><label>Full Name</label><div class="value">${escHtml(e.first_name)} ${escHtml(e.middle_name || '')} ${escHtml(e.last_name)} ${escHtml(e.suffix || '')}</div></div>
            <div class="info-item"><label>Email</label><div class="value">${escHtml(e.email || '-')}</div></div>
        `;
        searchRes.classList.add('active');

    } catch (err) {
        showToast('Error: ' + err.message, false);
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-search"></i> Search Employee';
    }
}

function openFaceRegModal(empNo) {
    openModal('faceRegModal');
    document.getElementById('employeeIdSearch').value = empNo || '';
    if (empNo) searchEmployee();
}

function redirectToFaceReg() {
    const empNo = document.getElementById('registerFaceBtn').dataset.empNo;
    // accountRegistration.html already supports role=professor&employee_id=EMP_NO
    window.top.location.href =
        '../../TimeInAndTimeOutMonitoring/students/accountRegistration.html'
        + '?role=professor&employee_id=' + encodeURIComponent(empNo);
}

// ══════════════════════════════════════════════════════════
// 5. REPORT MODAL
// ══════════════════════════════════════════════════════════
function buildReportRows() {
    reportRows = allEmployees.map(e => ({
        emp_no:       e.emp_no || '-',
        first_name:   e.first_name,
        middle_name:  e.middle_name || '—',
        last_name:    e.last_name,
        suffix:       e.suffix || '—',
        email:        e.email || '—',
        face_status:  resolveHasFace(e) ? 'Registered' : 'Not Registered',
        status:       e.status || 'active',
        date_added:   e.created_at
            ? new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-'
    }));
}

function openReportModal() {
    document.getElementById('rmGenDate').innerHTML =
        `Generated ${META.date} &nbsp;·&nbsp; <span id="rmTotal">${META.total}</span> employees`;
    document.getElementById('rmChipTotal').textContent      = META.total;
    document.getElementById('rmChipRegistered').textContent = META.registered;
    document.getElementById('rmChipPending').textContent    = META.pending;
    document.getElementById('rmOverlay').classList.add('on');

    if (!allEmployees.length) {
        document.getElementById('rmTableBody').innerHTML =
            `<tr><td colspan="9" style="text-align:center;padding:40px;color:#9ca3af">No data available.</td></tr>`;
        return;
    }

    document.getElementById('rmTableBody').innerHTML = allEmployees.map((e, i) => {
        const hasFace = resolveHasFace(e);
        const faceLabel = hasFace ? 'Registered' : 'Not Registered';
        const faceClass = hasFace ? 'registered' : 'not-registered';
        const status = (e.status || 'active').toLowerCase();
        const dateReg = e.created_at
            ? new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
            : '-';
        return `<tr>
            <td style="color:#9ca3af;font-size:11px">${i + 1}</td>
            <td style="font-weight:700;color:#5b21b6;font-size:12px">${escHtml(e.emp_no || '-')}</td>
            <td style="font-weight:600">${escHtml(e.last_name)}</td>
            <td>${escHtml(e.first_name)}</td>
            <td style="color:#6b7280">${escHtml(e.middle_name || '—')}</td>
            <td style="font-size:12px">${escHtml(e.email || '—')}</td>
            <td><span class="rm-badge ${faceClass}">${faceLabel}</span></td>
            <td><span class="rm-badge ${status}">${capitalize(status)}</span></td>
            <td style="font-size:11.5px;color:#6b7280">${dateReg}</td>
        </tr>`;
    }).join('');

    buildReportRows();
}

function closeReportModal() {
    document.getElementById('rmOverlay').classList.remove('on');
}

async function printReport() {
    const now = new Date();
    const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    const cols = ['#','Emp No.','Last Name','First Name','Middle Name','Email','Face Status','Status','Date Added'];
    const rows = reportRows.map((r, i) =>
        `<tr class="${i % 2 === 1 ? 'even' : ''}">
            <td>${i+1}</td><td><strong>${r.emp_no}</strong></td>
            <td><strong>${r.last_name}</strong></td><td>${r.first_name}</td><td>${r.middle_name}</td>
            <td>${r.email}</td>
            <td><span style="color:${r.face_status==='Registered'?'#166534':'#d97706'};font-weight:bold">${r.face_status.toUpperCase()}</span></td>
            <td><span style="color:${r.status==='active'?'#166534':'#dc2626'};font-weight:bold">${r.status.toUpperCase()}</span></td>
            <td>${r.date_added}</td>
        </tr>`
    ).join('');

    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Employees List Report</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:Arial,sans-serif;padding:20px;font-size:11px;color:#111}
        .header-container{background:#fff;text-align:center;margin-bottom:20px;padding:20px 15px;border:2px solid #000;border-radius:8px}
        .report-title{font-size:16px;font-weight:bold;margin-top:12px;text-transform:uppercase;letter-spacing:1px}
        .report-meta{font-size:11px;color:#555;margin-top:5px}
        table{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #000}
        th{background:#fff;color:#000;padding:8px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;border:1px solid #000}
        td{padding:8px 10px;border:1px solid #000;font-size:11px;text-align:center}
        td:nth-child(2),td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6){text-align:left}
        tr:nth-child(even){background:#f9fafb}
        @media print{body{padding:0}}
    </style></head><body>
    <div class="header-container">
        <div class="report-title">Employees List Report</div>
        <div class="report-meta">Generated: ${nowStr} &nbsp;·&nbsp; Total: ${META.total} &nbsp;·&nbsp; Face Registered: ${META.registered} &nbsp;·&nbsp; Pending: ${META.pending}</div>
    </div>
    <table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script></body></html>`);
    w.document.close();
}

async function downloadPDF() {
    if (!window.jspdf) { showToast('PDF library not loaded. Please try again.', false); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const now    = new Date();
    const nowStr = `${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    const pageW  = doc.internal.pageSize.width;
    const centerX = pageW / 2;
    const headerH = 40;

    doc.setDrawColor(0,0,0); doc.setLineWidth(0.1);
    doc.rect(10, 5, pageW - 20, headerH, 'S');
    doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(0,0,0);
    doc.text('EMPLOYEES LIST REPORT', centerX, 22, { align: 'center' });
    doc.setFontSize(8); doc.setFont('helvetica','normal'); doc.setTextColor(80,80,80);
    doc.text(`Generated: ${nowStr}  ·  Total: ${META.total}  ·  Face Registered: ${META.registered}  ·  Pending: ${META.pending}`, centerX, 32, { align: 'center' });

    doc.autoTable({
        head: [['#','Emp No.','Last Name','First Name','M.I.','Email','Face','Status','Date Added']],
        body: reportRows.map((r,i) => [i+1, r.emp_no, r.last_name, r.first_name, (r.middle_name||'').substring(0,2)+'.', r.email, r.face_status.toUpperCase(), r.status.toUpperCase(), r.date_added]),
        startY: headerH + 10,
        margin: { left: 10, right: 10 },
        theme: 'grid',
        headStyles: { fillColor:[255,255,255], fontSize:6.5, fontStyle:'bold', textColor:[0,0,0], lineColor:[0,0,0], lineWidth:0.1, halign:'center' },
        styles: { fontSize:6.5, cellPadding:2, lineColor:[0,0,0], lineWidth:0.1, textColor:[0,0,0] },
        didParseCell(d) {
            if (d.column.index === 6 && d.section === 'body') {
                d.cell.styles.textColor = (d.cell.text[0]||'').toLowerCase() === 'registered' ? [22,101,52] : [217,119,6];
            }
        }
    });

    doc.save(`Employees_Report_${now.toISOString().split('T')[0]}.pdf`);
}

function exportCSV() {
    const cols  = ['#','Emp No.','Last Name','First Name','Middle Name','Email','Face Status','Status','Date Added'];
    const lines = [cols.join(','), ...reportRows.map((r,i) =>
        [i+1,`"${r.emp_no}"`,`"${r.last_name}"`,`"${r.first_name}"`,`"${r.middle_name}"`,`"${r.email}"`,`"${r.face_status}"`,r.status,`"${r.date_added}"`].join(',')
    )];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `Employees_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════
// 6. MODAL HELPERS
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
            document.getElementById('employeeIdSearch').value = '';
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
// 7. UTILITIES
// ══════════════════════════════════════════════════════════
function showToast(msg) {
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