// admin-subjects.js
let allSubjects      = [];
let allDepartments   = [];
let allSemesters     = [];
let subjectModal     = null;
let deleteModal      = null;
let importModal      = null;
let subjectToDelete  = null;

// ── Import state ──────────────────────────────────────────
let importParsedRows  = [];
let importStep        = 1;   // 1 = upload, 2 = preview, 3 = progress

document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof checkSupabaseConnection === 'function') checkSupabaseConnection();

        subjectModal = new bootstrap.Modal(document.getElementById('subjectModal'));
        deleteModal  = new bootstrap.Modal(document.getElementById('deleteConfirmModal'));
        importModal  = new bootstrap.Modal(document.getElementById('importModal'));

        setupEventListeners();
        await Promise.all([loadDepartments(), loadSemesters()]);
        await loadSubjects();

    } catch (err) {
        console.error('Init error:', err);
    }
});

// ── Event Listeners ───────────────────────────────────────
function setupEventListeners() {
    document.getElementById('btnOpenAddModal')?.addEventListener('click', openAddModal);
    document.getElementById('btnOpenImportModal')?.addEventListener('click', openImportModal);
    document.getElementById('saveSubjectBtn')?.addEventListener('click', saveSubject);
    document.getElementById('confirmDeleteBtn')?.addEventListener('click', executeDelete);
    document.getElementById('importNextBtn')?.addEventListener('click', handleImportNext);
    document.getElementById('importDownloadTplBtn')?.addEventListener('click', downloadSubjectTemplate);
    document.querySelector('.search-input')?.addEventListener('input', applyFilters);
    document.getElementById('departmentFilter')?.addEventListener('change', applyFilters);
    document.getElementById('semesterFilter')?.addEventListener('change', applyFilters);

    // Reset import state when modal closes
    document.getElementById('importModal')?.addEventListener('hidden.bs.modal', resetImportModal);
}

// ── Load Departments ──────────────────────────────────────
async function loadDepartments() {
    const { data, error } = await supabaseClient
        .from('departments')
        .select('id, department_name, department_code')
        .eq('is_active', true)
        .order('department_name');

    if (error) { console.error('loadDepartments:', error); return; }
    allDepartments = data || [];

    // Populate filter dropdown
    const filterSel = document.getElementById('departmentFilter');
    filterSel.innerHTML = '<option value="all">All Departments</option>'
        + allDepartments.map(d =>
            `<option value="${d.id}">${escapeHtml(d.department_name)} (${escapeHtml(d.department_code)})</option>`
          ).join('');

    // Populate form dropdown
    populateDeptSelect('deptId');

    // Populate import modal dropdown
    populateDeptSelect('importDeptId', true);

    // Update stat
    document.getElementById('statDepts').textContent = allDepartments.length;
}

function populateDeptSelect(elId, addBlank = false) {
    const sel = document.getElementById(elId);
    if (!sel) return;
    const blank = addBlank
        ? '<option value="">Select department...</option>'
        : '<option value="" disabled selected>Select department...</option>';
    sel.innerHTML = blank + allDepartments.map(d =>
        `<option value="${d.id}">${escapeHtml(d.department_name)} (${escapeHtml(d.department_code)})</option>`
    ).join('');
}

// ── Load Semesters ────────────────────────────────────────
async function loadSemesters() {
    const { data, error } = await supabaseClient
        .from('semesters')
        .select('id, name')
        .eq('is_active', true)
        .order('start_date', { ascending: false });

    if (error) { console.error('loadSemesters:', error); return; }
    allSemesters = data || [];

    const opts = allSemesters.map(s =>
        `<option value="${s.id}">${escapeHtml(s.name)}</option>`
    ).join('');

    const formSel = document.getElementById('semesterId');
    if (formSel) formSel.innerHTML = '<option value="" disabled selected>-- Select Semester --</option>' + opts;

    const filterSel = document.getElementById('semesterFilter');
    if (filterSel) filterSel.innerHTML = '<option value="all">All Semesters</option>' + opts;
}

// ── Load Subjects ─────────────────────────────────────────
async function loadSubjects() {
    const tbody = document.getElementById('subjectsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4"><div class="spinner-border text-success" role="status"></div></td></tr>';

    try {
        const { data, error } = await supabaseClient
            .from('subjects')
            .select('*, semesters(id, name), departments(id, department_name, department_code)')
            .order('subject_code');

        if (error) throw error;
        allSubjects = data || [];

        document.getElementById('statTotal').textContent = allSubjects.length;
        document.getElementById('statUnits').textContent =
            allSubjects.reduce((s, x) => s + (parseFloat(x.units) || 0), 0);

        displaySubjects(allSubjects);

    } catch (err) {
        console.error('loadSubjects:', err);
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger py-4">Failed to load: ${err.message}</td></tr>`;
    }
}

// ── Display / Filter ──────────────────────────────────────
function displaySubjects(rows) {
    const tbody = document.getElementById('subjectsTableBody');

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">No subjects found.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(s => {
        const deptName = s.departments
            ? `${escapeHtml(s.departments.department_name)} <small class="text-muted">(${escapeHtml(s.departments.department_code)})</small>`
            : '<span class="text-muted">—</span>';
        return `
        <tr>
            <td class="fw-bold">${escapeHtml(s.subject_code)}</td>
            <td>
                <div>${escapeHtml(s.subject_name)}</div>
                ${s.description ? `<small class="text-muted">${escapeHtml(s.description.substring(0,50))}…</small>` : ''}
            </td>
            <td>${deptName}</td>
            <td><span class="badge bg-light text-dark border">${s.semesters ? escapeHtml(s.semesters.name) : 'Unassigned'}</span></td>
            <td><span class="badge bg-secondary">${s.units}</span></td>
            <td>
                <div class="action-buttons">
                    <button class="btn-icon" title="Edit" onclick="editSubject('${s.subject_id}')">
                        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger" title="Delete" onclick="promptDelete('${s.subject_id}','${escapeHtml(s.subject_code)}')">
                        <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function applyFilters() {
    const q    = document.querySelector('.search-input').value.toLowerCase();
    const dept = document.getElementById('departmentFilter').value;
    const sem  = document.getElementById('semesterFilter').value;

    const filtered = allSubjects.filter(s => {
        const textMatch = s.subject_code.toLowerCase().includes(q) || s.subject_name.toLowerCase().includes(q);
        const deptMatch = dept === 'all' || s.department_id === dept;
        const semMatch  = sem  === 'all' || s.semester_id  === sem;
        return textMatch && deptMatch && semMatch;
    });

    displaySubjects(filtered);
}

// ── Add / Edit ────────────────────────────────────────────
function openAddModal() {
    document.getElementById('subjectForm').reset();
    document.getElementById('subjectId').value = '';
    document.getElementById('modalTitle').textContent = 'Add New Subject';
    subjectModal.show();
}

function editSubject(id) {
    const s = allSubjects.find(x => x.subject_id === id);
    if (!s) return;

    document.getElementById('subjectId').value    = s.subject_id;
    document.getElementById('subjectCode').value  = s.subject_code;
    document.getElementById('subjectName').value  = s.subject_name;
    document.getElementById('deptId').value       = s.department_id || '';
    document.getElementById('semesterId').value   = s.semester_id   || '';
    document.getElementById('units').value        = s.units         || '';
    document.getElementById('description').value  = s.description   || '';

    document.getElementById('modalTitle').textContent = 'Edit Subject';
    subjectModal.show();
}

async function saveSubject() {
    const subjectId   = document.getElementById('subjectId').value.trim();
    const subjectCode = document.getElementById('subjectCode').value.trim().toUpperCase();
    const subjectName = document.getElementById('subjectName').value.trim();
    const deptId      = document.getElementById('deptId').value;
    const semesterId  = document.getElementById('semesterId').value;
    const units       = document.getElementById('units').value;
    const desc        = document.getElementById('description').value.trim();
    const isEdit      = subjectId !== '';

    if (!subjectCode || !subjectName || !deptId || !semesterId || !units) {
        return showAlert('Please fill in all required fields.', 'warning');
    }

    const btn = document.getElementById('saveSubjectBtn');
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving…';
    btn.disabled  = true;

    try {
        // Duplicate check
        let dupQ = supabaseClient.from('subjects')
            .select('subject_id')
            .or(`subject_code.eq.${subjectCode},subject_name.ilike.${subjectName}`)
            .eq('department_id', deptId);
        if (isEdit) dupQ = dupQ.neq('subject_id', subjectId);
        const { data: dups } = await dupQ;
        if (dups?.length) throw new Error('A subject with this code or name already exists in this department.');

        const payload = {
            subject_code:  subjectCode,
            subject_name:  subjectName,
            department_id: deptId,
            semester_id:   semesterId,
            units:         parseFloat(units),
            description:   desc || null,
            updated_at:    new Date().toISOString()
        };

        let err;
        if (isEdit) {
            ({ error: err } = await supabaseClient.from('subjects').update(payload).eq('subject_id', subjectId));
        } else {
            payload.status = 'active';
            ({ error: err } = await supabaseClient.from('subjects').insert(payload));
        }
        if (err) throw err;

        showAlert(isEdit ? 'Subject updated!' : 'Subject added!', 'success');
        subjectModal.hide();
        await loadSubjects();

    } catch (err) {
        showAlert(err.message || 'Error saving subject.', 'danger');
    } finally {
        btn.innerHTML = 'Save Subject';
        btn.disabled  = false;
    }
}

// ── Delete ────────────────────────────────────────────────
function promptDelete(id, code) {
    subjectToDelete = id;
    document.getElementById('deleteSubjectCode').textContent = code;
    deleteModal.show();
}

async function executeDelete() {
    if (!subjectToDelete) return;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Deleting…';
    btn.disabled  = true;

    try {
        const { data: linked } = await supabaseClient.from('lab_schedules')
            .select('schedule_id').eq('subject_id', subjectToDelete).eq('status','active').limit(1);
        if (linked?.length) throw new Error('Cannot delete: subject has active schedules.');

        const { error } = await supabaseClient.from('subjects').delete().eq('subject_id', subjectToDelete);
        if (error) throw error;

        showAlert('Subject deleted.', 'success');
        deleteModal.hide();
        await loadSubjects();

    } catch (err) {
        showAlert(err.message, 'danger');
    } finally {
        btn.innerHTML = 'Delete';
        btn.disabled  = false;
        subjectToDelete = null;
    }
}

// ════════════════════════════════════════════════════════════
// BULK IMPORT
// ════════════════════════════════════════════════════════════
function openImportModal() {
    resetImportModal();
    importModal.show();
}

function resetImportModal() {
    importStep       = 1;
    importParsedRows = [];
    document.getElementById('importStep1').style.display   = '';
    document.getElementById('importStep2').style.display   = 'none';
    document.getElementById('importStep3').style.display   = 'none';
    document.getElementById('importFileInput').value       = '';
    document.getElementById('importDeptId').value          = '';
    document.getElementById('importLog').innerHTML         = '';
    document.getElementById('importProgressBar').style.width = '0%';
    document.getElementById('importProgressBar').textContent = '0%';
    document.getElementById('importNextBtn').textContent   = 'Parse & Preview';
    document.getElementById('importNextBtn').disabled      = false;
}

async function handleImportNext() {
    if (importStep === 1) await parseImportFile();
    else if (importStep === 2) await runImport();
}

async function parseImportFile() {
    const deptId = document.getElementById('importDeptId').value;
    const file   = document.getElementById('importFileInput').files[0];

    if (!deptId)  return showAlert('Please select a department.', 'warning');
    if (!file)    return showAlert('Please select a file.', 'warning');

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    try {
        let rawRows = [];

        if (ext === '.csv') {
            const text = await file.text();
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            rawRows = lines.slice(1).map(line => {
                const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
                return { code: cols[0]||'', name: cols[1]||'', units: cols[2]||'', desc: cols[3]||'' };
            });
        } else {
            const buf  = await file.arrayBuffer();
            const wb   = XLSX.read(buf, { type: 'array' });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            const raw  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            rawRows = raw.slice(1).map(r => ({
                code: String(r[0]||'').trim(),
                name: String(r[1]||'').trim(),
                units: String(r[2]||'').trim(),
                desc: String(r[3]||'').trim()
            }));
        }

        rawRows = rawRows.filter(r => r.code || r.name);

        if (!rawRows.length) return showAlert('No data rows found in file.', 'warning');

        // Check existing codes in this department to mark skips
        const codes = rawRows.map(r => r.code.toUpperCase()).filter(Boolean);
        const { data: existing } = await supabaseClient
            .from('subjects')
            .select('subject_code')
            .in('subject_code', codes)
            .eq('department_id', deptId);
        const existingCodes = new Set((existing||[]).map(x => x.subject_code.toUpperCase()));

        importParsedRows = rawRows.map((r, i) => {
            const errors   = [];
            const warnings = [];
            const code     = r.code.toUpperCase();

            if (!code)   errors.push('Subject Code required');
            if (!r.name) errors.push('Subject Name required');
            const u = parseFloat(r.units);
            if (!r.units || isNaN(u) || u <= 0 || u > 10) errors.push('Units must be 0–10');

            const skipped = existingCodes.has(code);

            return {
                rowIndex: i + 2,
                code,
                name:    r.name,
                units:   r.units,
                desc:    r.desc,
                errors,
                warnings,
                skipped,
                status: skipped ? 'skip' : errors.length ? 'error' : warnings.length ? 'warning' : 'ok'
            };
        });

        renderImportPreview();
        document.getElementById('importStep1').style.display = 'none';
        document.getElementById('importStep2').style.display = '';
        document.getElementById('importNextBtn').textContent = 'Import Now';
        importStep = 2;

    } catch (err) {
        showAlert('Failed to parse file: ' + err.message, 'danger');
    }
}

function renderImportPreview() {
    const valid   = importParsedRows.filter(r => r.status === 'ok' || r.status === 'warning').length;
    const warns   = importParsedRows.filter(r => r.status === 'warning').length;
    const errors  = importParsedRows.filter(r => r.status === 'error').length;
    const skipped = importParsedRows.filter(r => r.status === 'skip').length;

    document.getElementById('importValidCount').textContent = `${valid} Ready`;
    document.getElementById('importWarnCount').textContent  = `${warns} Warnings`;
    document.getElementById('importErrCount').textContent   = `${errors} Errors`;
    document.getElementById('importSkipCount').textContent  = `${skipped} Skipped (exist)`;

    if (errors > 0) {
        document.getElementById('importNextBtn').disabled = true;
        document.getElementById('importNextBtn').title    = 'Fix errors before importing';
    } else {
        document.getElementById('importNextBtn').disabled = false;
    }

    const statusBadge = (r) => {
        if (r.status === 'ok')      return '<span class="badge bg-success">Ready</span>';
        if (r.status === 'warning') return `<span class="badge bg-warning text-dark" title="${r.warnings.join('; ')}">Warning</span>`;
        if (r.status === 'error')   return `<span class="badge bg-danger" title="${r.errors.join('; ')}">Error</span>`;
        if (r.status === 'skip')    return '<span class="badge bg-secondary">Already exists</span>';
        return '';
    };

    document.getElementById('importPreviewBody').innerHTML = importParsedRows.map((r, i) => `
        <tr class="${r.status === 'error' ? 'table-danger' : r.status === 'skip' ? 'table-secondary' : r.status === 'warning' ? 'table-warning' : ''}">
            <td>${r.rowIndex}</td>
            <td><strong>${escapeHtml(r.code)}</strong></td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.units)}</td>
            <td style="font-size:12px">${escapeHtml(r.desc||'—')}</td>
            <td>${statusBadge(r)}</td>
        </tr>
    `).join('');
}

async function runImport() {
    const deptId    = document.getElementById('importDeptId').value;
    const toImport  = importParsedRows.filter(r => r.status === 'ok' || r.status === 'warning');

    if (!toImport.length) return showAlert('No valid rows to import.', 'warning');

    // Get active semester for this batch
    const { data: activeSem } = await supabaseClient
        .from('semesters').select('id').eq('is_active', true).limit(1).single();
    const semesterId = activeSem?.id || null;

    document.getElementById('importStep2').style.display = 'none';
    document.getElementById('importStep3').style.display = '';
    document.getElementById('importNextBtn').style.display = 'none';
    importStep = 3;

    const logEl  = document.getElementById('importLog');
    const bar    = document.getElementById('importProgressBar');
    const total  = toImport.length;
    let success  = 0;
    let failed   = 0;

    addImportLog(logEl, 'info', `Starting import of ${total} subject(s) into ${getDeptName(deptId)}…`);

    for (let i = 0; i < toImport.length; i++) {
        const r = toImport[i];
        try {
            const { error } = await supabaseClient.from('subjects').insert({
                subject_code:  r.code,
                subject_name:  r.name,
                units:         parseFloat(r.units),
                description:   r.desc || null,
                department_id: deptId,
                semester_id:   semesterId,
                status:        'active',
                created_at:    new Date().toISOString(),
                updated_at:    new Date().toISOString()
            });
            if (error) throw error;
            success++;
            addImportLog(logEl, 'ok', `[Row ${r.rowIndex}] Imported: ${r.code} — ${r.name}`);
        } catch (err) {
            failed++;
            addImportLog(logEl, 'error', `[Row ${r.rowIndex}] Failed: ${r.code} — ${err.message}`);
        }

        const pct = Math.round(((i + 1) / total) * 100);
        bar.style.width   = pct + '%';
        bar.textContent   = pct + '%';
        await new Promise(r => setTimeout(r, 40));
    }

    addImportLog(logEl, 'info', '─────────────────────────────────');
    addImportLog(logEl, success > 0 ? 'ok' : 'error',
        `Done. ${success} imported, ${failed} failed, ${importParsedRows.filter(r=>r.status==='skip').length} skipped.`);

    // Change Cancel → Close
    document.querySelector('#importModal .btn-secondary').textContent = 'Close';

    if (success > 0) await loadSubjects();
}

function getDeptName(id) {
    const d = allDepartments.find(x => x.id === id);
    return d ? `${d.department_name} (${d.department_code})` : id;
}

function addImportLog(el, type, msg) {
    const colors = { ok: '#166534', error: '#dc2626', info: '#374151', warning: '#92400e' };
    const icons  = { ok: '✓', error: '✗', info: '›', warning: '⚠' };
    const div = document.createElement('div');
    div.style.color = colors[type] || '#374151';
    div.style.marginBottom = '3px';
    div.textContent = `${icons[type]||'›'} ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

// ── Template Download ─────────────────────────────────────
function downloadSubjectTemplate() {
    const headers = ['Subject Code', 'Subject Name', 'Units', 'Description'];
    const sample  = [['CS101L', 'Introduction to Computing Lab', '3', 'Laboratory component of CS101']];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
        ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 8 }, { wch: 40 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Subjects');
        XLSX.writeFile(wb, 'subject-import-template.xlsx');
    } else {
        const csv  = [headers, ...sample].map(r => r.map(v=>`"${v}"`).join(',')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'subject-import-template.csv';
        a.click();
    }
}

// ── Helpers ───────────────────────────────────────────────
function showAlert(message, type = 'info') {
    const div = document.createElement('div');
    div.className = `alert alert-${type} alert-dismissible fade show mb-4 shadow-sm`;
    div.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    const header = document.querySelector('.page-header');
    header.parentNode.insertBefore(div, header.nextSibling);
    setTimeout(() => div?.remove(), 5000);
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}