let parsedRows = [];
let selectedDepartmentId = null;
let selectedDepartmentName = '';
let departmentsCache = [];
let singleStudentModal = null;
let duplicateRowsModal = null;
let editStudentModal = null;
let duplicateRowsInFileCount = 0;
let duplicateRowsInDatabaseCount = 0;
let duplicateRowsInFile = [];
let duplicateRowsInDatabase = [];
let allStudents = [];
const QR_EMAIL_ENDPOINT = 'send-student-qr-email.php';
const EMAIL_LIKE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


document.addEventListener('DOMContentLoaded', async () => {
    checkSupabaseConnection();
    await loadDepartments();
    setupEventListeners();
    await loadAllStudentsTable();
    
    // Prevent browser default behavior for drag & drop on the entire document
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    
    document.addEventListener('drop', (e) => {
        e.preventDefault();
    });
});

async function loadDepartments() {
    try {
        if (!supabaseClient) return;

        const { data: sections, error } = await supabaseClient
            .from('sections')
            .select('section_id, grade_level, section_name')
            .order('grade_level', { ascending: true })
            .order('section_name', { ascending: true });

        if (error) throw error;

        departmentsCache = sections || [];

        const select = document.getElementById('departmentSelect');
        select.innerHTML = '<option value="">Select a section...</option>';

        departmentsCache.forEach(dept => {
            const opt = document.createElement('option');
            opt.value = dept.section_id;
            opt.textContent = `${dept.grade_level} - ${dept.section_name}`;
            opt.dataset.name = `${dept.grade_level} - ${dept.section_name}`;
            select.appendChild(opt);
        });

        populateSingleStudentDepartments();
    } catch (err) {
        console.error('Error loading departments:', err);
    }
}


function setupEventListeners() {

    
    const dropZone    = document.getElementById('fileDropZone');
    const fileInput   = document.getElementById('fileInput');
    const removeBtn   = document.getElementById('fileRemoveBtn');
    const parseBtn    = document.getElementById('parseFileBtn');
    const backUpload  = document.getElementById('backToUploadBtn');
    const proceedBtn  = document.getElementById('proceedImportBtn');
    const anotherBtn  = document.getElementById('importAnotherBtn');
    const deptSelect  = document.getElementById('departmentSelect');
    const downloadBtn = document.getElementById('downloadTemplateBtn');
    const addSingleBtn = document.getElementById('addSingleStudentBtn');
    const singleStudentForm = document.getElementById('singleStudentForm');
    const duplicateSummaryCard = document.getElementById('duplicateSummaryCard');
    const refreshStudentsBtn = document.getElementById('refreshStudentsBtn');
    const allStudentsTableBody = document.getElementById('allStudentsTableBody');
    const clearFiltersBtn = document.getElementById('clearStudentFiltersBtn');
    const searchInput = document.getElementById('studentSearchInput');
    const deptFilter = document.getElementById('studentDeptFilter');
    const courseFilter = document.getElementById('studentCourseFilter');
    const yearFilter = document.getElementById('studentYearFilter');
    const editStudentForm = document.getElementById('editStudentForm');

    if (window.bootstrap) {
        const modalElement = document.getElementById('singleStudentModal');
        if (modalElement) {
            singleStudentModal = new bootstrap.Modal(modalElement);
        }

        const duplicateModalElement = document.getElementById('duplicateRowsModal');
        if (duplicateModalElement) {
            duplicateRowsModal = new bootstrap.Modal(duplicateModalElement);
        }

        const editModalElement = document.getElementById('editStudentModal');
        if (editModalElement) {
            editStudentModal = new bootstrap.Modal(editModalElement);
        }
    }

    // Generate template on demand so download still works even without a static file.
    downloadBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        downloadStudentTemplate();
    });

    // Department select
    deptSelect.addEventListener('change', () => {
        const opt = deptSelect.options[deptSelect.selectedIndex];
        selectedDepartmentId   = deptSelect.value || null;
        selectedDepartmentName = opt?.dataset?.name || '';
        checkReadyToParse();
    });

    // Drop zone click — open file picker
    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        fileInput.click();
    });

    // Drag & drop with counter to handle nested elements
    let dragCounter = 0;
    
    dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'copy';
        dragCounter++;
        dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
            dropZone.classList.remove('drag-over');
        }
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        dropZone.classList.remove('drag-over');
        
        // Handle files from external sources (File Explorer, etc.)
        try {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                const file = files[0];
                // Add a small delay to ensure DOM is ready
                setTimeout(() => {
                    handleFileSelected(file);
                }, 10);
            }
        } catch (err) {
            console.error('Error handling dropped files:', err);
            showImportAlert('Error processing dropped file. Please try again.', 'danger');
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
    });

    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearFileSelection();
    });

    parseBtn.addEventListener('click', parseFile);
    backUpload.addEventListener('click', goBackToUpload);
    proceedBtn.addEventListener('click', startImport);
    anotherBtn?.addEventListener('click', resetAll);
    addSingleBtn?.addEventListener('click', openSingleStudentModal);
    singleStudentForm?.addEventListener('submit', submitSingleStudentForm);
    duplicateSummaryCard?.addEventListener('click', openDuplicateRowsModal);
    refreshStudentsBtn?.addEventListener('click', loadAllStudentsTable);
    clearFiltersBtn?.addEventListener('click', clearStudentsFilters);
    searchInput?.addEventListener('input', renderAllStudentsTable);
    deptFilter?.addEventListener('change', renderAllStudentsTable);
    courseFilter?.addEventListener('change', renderAllStudentsTable);
    yearFilter?.addEventListener('change', renderAllStudentsTable);
    allStudentsTableBody?.addEventListener('click', handleStudentsTableActions);
    editStudentForm?.addEventListener('submit', submitEditStudentForm);
    duplicateSummaryCard?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openDuplicateRowsModal();
        }
    });

    // LRN: allow digits only (up to 12).
const singleIdInput = document.getElementById('singleStudentId');
singleIdInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 12);
});

// Normalize gender values.
const singleGenderInput = document.getElementById('singleSection');
singleGenderInput?.addEventListener('change', (e) => {
    e.target.value = String(e.target.value || '').trim().toLowerCase();
});

// ── Suffix: auto-format with first letter uppercase (e.g. Sr, Jr, III) ──
const singleSuffixInput = document.getElementById('singleSuffix');
singleSuffixInput?.addEventListener('input', (e) => {
    let value = e.target.value.replace(/[^A-Za-z]/g, '');
    if (value.length > 0) {
        value = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
    e.target.value = value;
});

const editSuffixInput = document.getElementById('editSuffix');
editSuffixInput?.addEventListener('input', (e) => {
    let value = e.target.value.replace(/[^A-Za-z]/g, '');
    if (value.length > 0) {
        value = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }
    e.target.value = value;
});

const editGenderInput = document.getElementById('editSection');
editGenderInput?.addEventListener('change', (e) => {
    e.target.value = String(e.target.value || '').trim().toLowerCase();
});
}


let selectedFile = null;

function handleFileSelected(file) {
    if (!file) {
        console.warn('No file provided to handleFileSelected');
        return;
    }

    const allowedExts = ['.xlsx', '.xls', '.csv'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

    if (!allowedExts.includes(ext)) {
        showImportAlert('Invalid file type. Please upload .xlsx, .xls, or .csv files only.', 'danger');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        showImportAlert('File too large. Maximum allowed size is 10MB.', 'danger');
        return;
    }

    selectedFile = file;
    document.getElementById('fileSelectedName').textContent = file.name;
    document.getElementById('fileSelected').style.display = 'flex';
    document.getElementById('fileDropZone').querySelector('.drop-icon').style.display = 'none';
    document.getElementById('fileDropZone').querySelector('.drop-text').style.display = 'none';
    document.getElementById('fileDropZone').querySelector('.drop-hint').style.display = 'none';

    checkReadyToParse();
}

function clearFileSelection() {
    selectedFile = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('fileSelected').style.display = 'none';
    document.getElementById('fileDropZone').querySelector('.drop-icon').style.display = '';
    document.getElementById('fileDropZone').querySelector('.drop-text').style.display = '';
    document.getElementById('fileDropZone').querySelector('.drop-hint').style.display = '';
    checkReadyToParse();
}

function checkReadyToParse() {
    const parseBtn = document.getElementById('parseFileBtn');
    if (!parseBtn) {
        console.warn('Parse button element not found');
        return;
    }
    const isReady = !!(selectedFile && selectedDepartmentId);
    parseBtn.disabled = !isReady;
    console.log('Parse button status updated - Ready:', isReady, 'File:', !!selectedFile, 'Dept:', !!selectedDepartmentId);
}


async function parseFile() {
    if (!selectedFile) return;

    const ext = selectedFile.name.slice(selectedFile.name.lastIndexOf('.')).toLowerCase();
    duplicateRowsInFileCount = 0;
    duplicateRowsInDatabaseCount = 0;
    duplicateRowsInFile = [];
    duplicateRowsInDatabase = [];

    try {
        let rows = [];

        if (ext === '.csv') {
            const text = await selectedFile.text();
            rows = parseCSV(text);
        } else {
            const buffer = await selectedFile.arrayBuffer();
            const wb = XLSX.read(buffer, { type: 'array' });
            const sheetName = wb.SheetNames[0];
            const ws = wb.Sheets[sheetName];
            const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            if (raw.length < 2) {
                showImportAlert('The file appears to be empty or has no data rows.', 'warning');
                return;
            }
            rows = raw.slice(1).map(r => ({
                studentId:   String(r[0] || '').trim(),
                lastName:    String(r[1] || '').trim(),
                firstName:   String(r[2] || '').trim(),
                middleName:  String(r[3] || '').trim(),
                suffix:      String(r[4] || '').trim(),
                birthDate:   String(r[5] || '').trim(),
                gender:      String(r[6] || '').trim(),
                section:     String(r[7] || '').trim(),
                email:       String(r[8] || '').trim(),
            }));
        }

        rows = rows.filter(r => r.studentId || r.firstName || r.lastName);

        if (rows.length === 0) {
            showImportAlert('No data rows found. Make sure you have data below the header row.', 'warning');
            return;
        }

        // Validate rows
        parsedRows = rows.map((r, i) => validateRow(r, i));

        duplicateRowsInFileCount = removeDuplicateStudentIdsFromParsedRows();

        duplicateRowsInDatabaseCount = await removeExistingStudentIdsFromParsedRows();

        renderPreview();
        showStep('preview');

    } catch (err) {
        console.error('Parse error:', err);
        showImportAlert('Failed to parse file: ' + err.message, 'danger');
    }
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    return lines.slice(1).map(line => {
        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        return {
            studentId:  cols[0] || '',
            lastName:   cols[1] || '',
            firstName:  cols[2] || '',
            middleName: cols[3] || '',
            suffix:     cols[4] || '',
            birthDate:  cols[5] || '',
            gender:     cols[6] || '',
            section:    cols[7] || '',
            email:      cols[8] || '',
        };
    });
}


function validateRow(row, index) {
    const errors   = [];
    const warnings = [];
    const normalizedId = String(row.studentId || '').replace(/\D/g, '').trim();

    if (!normalizedId) {
        errors.push('LRN is required');
    } else if (!/^\d{12}$/.test(normalizedId)) {
        errors.push('LRN must be exactly 12 digits');
    }

    if (!row.firstName)  errors.push('First Name is required');
    if (!row.lastName)   errors.push('Last Name is required');

    if (row.birthDate && Number.isNaN(Date.parse(row.birthDate))) {
        errors.push('Birth Date must be valid (YYYY-MM-DD)');
    }

    const normalizedGender = String(row.gender || '').trim().toLowerCase();
    if (normalizedGender && !['male', 'female', 'other'].includes(normalizedGender)) {
        warnings.push('Gender value is uncommon (recommended: male, female, other)');
    }

    const email = String(row.email || '').trim();
    if (email && !EMAIL_LIKE_PATTERN.test(email)) {
        warnings.push('Email may not be deliverable; QR email can be skipped');
    }

    const status = errors.length > 0 ? 'error'
                 : warnings.length > 0 ? 'warning'
                 : 'ok';

    return {
        ...row,
        studentId: normalizedId,
        birthDate: String(row.birthDate || '').trim(),
        gender: normalizedGender,
        section: selectedDepartmentName || String(row.section || '').trim(),
        email,
        errors,
        warnings,
        status,
        rowIndex: index + 2,
    };
}

function renderPreview() {
    const tbody = document.getElementById('previewTableBody');
    const valid    = parsedRows.filter(r => r.status !== 'error').length;
    const warnings = parsedRows.filter(r => r.status === 'warning').length;
    const errors   = parsedRows.filter(r => r.status === 'error').length;
    const duplicated = duplicateRowsInFileCount + duplicateRowsInDatabaseCount;

    document.getElementById('validCount').textContent   = valid;
    const duplicatedCountEl = document.getElementById('duplicatedCount');
    if (duplicatedCountEl) {
        duplicatedCountEl.textContent = duplicated;
    }

    const duplicateSummaryCard = document.getElementById('duplicateSummaryCard');
    if (duplicateSummaryCard) {
        duplicateSummaryCard.setAttribute('role', 'button');
        duplicateSummaryCard.setAttribute('tabindex', duplicated > 0 ? '0' : '-1');
        duplicateSummaryCard.setAttribute('aria-disabled', duplicated > 0 ? 'false' : 'true');
        duplicateSummaryCard.title = `Skipped duplicates: ${duplicateRowsInFileCount} in file, ${duplicateRowsInDatabaseCount} already in database`;
    }

    document.getElementById('warningCount').textContent = warnings;
    document.getElementById('errorCount').textContent   = errors;
    document.getElementById('totalCount').textContent   = parsedRows.length;
    const proceedBtn = document.getElementById('proceedImportBtn');
    if (parsedRows.length === 0) {
        proceedBtn.disabled = true;
        proceedBtn.title = 'No new students available for import';
    } else if (errors > 0) {
        proceedBtn.disabled = true;
        proceedBtn.title = 'Fix all errors before proceeding';
    } else {
        proceedBtn.disabled = false;
        proceedBtn.title = '';
    }

    if (parsedRows.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align:center;padding:1.5rem;color:var(--text-muted);">
                    No new students available for import. Check the Duplicated card for skipped rows.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = parsedRows.map((row, i) => {
        const rowClass = row.status === 'error' ? 'row-error'
                       : row.status === 'warning' ? 'row-warning' : '';

        const statusBadge = row.status === 'ok'
            ? `<span class="row-status status-ok"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Ready</span>`
            : row.status === 'warning'
            ? `<span class="row-status status-warning" title="${row.warnings.join('; ')}">
                <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Warning
               </span>`
            : `<span class="row-status status-error" title="${row.errors.join('; ')}">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                Error
               </span>`;

        const errorNote = row.errors.length > 0
            ? `<div class="error-tooltip">${row.errors.join(', ')}</div>` : '';
        const warnNote  = row.warnings.length > 0
            ? `<div style="font-size:0.75rem;color:#92400e;margin-top:0.15rem;">${row.warnings.join(', ')}</div>` : '';

        const cell = (val) => val
            ? `<td>${escapeHtml(val)}</td>`
            : `<td class="cell-empty">—</td>`;

        return `
            <tr class="${rowClass}">
                <td style="color:var(--text-muted);font-size:0.8rem;">${row.rowIndex}</td>
                <td><strong>${escapeHtml(row.studentId)}</strong>${errorNote}</td>
                ${cell(row.lastName)}
                ${cell(row.firstName)}
                ${cell(row.middleName)}
                ${cell(row.suffix)}
                ${cell(row.birthDate)}
                ${cell(row.gender)}
                ${cell(row.section)}
                <td style="font-size:0.82rem;">${escapeHtml(row.email)}${warnNote}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    }).join('');
}


async function startImport() {
    const validRows = parsedRows.filter(r => r.status !== 'error');

    if (validRows.length === 0) {
        showImportAlert('No valid rows to import.', 'warning');
        return;
    }

    showStep('import');
    const log   = document.getElementById('importLog');
    const fill  = document.getElementById('progressBarFill');
    const text  = document.getElementById('progressText');
    const pct   = document.getElementById('progressPct');
    log.innerHTML = '';

    let success = 0;
    let failed  = 0;
    const total = validRows.length;

    addLog(log, 'info', `Starting import of ${total} student(s) into ${selectedDepartmentName}...`);
    const studentIds = validRows.map(r => r.studentId);
    const { data: existing } = await supabaseClient
        .from('students')
        .select('lrn')
        .in('lrn', studentIds);
    const existingIds = new Set((existing || []).map(e => e.lrn));

    for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];

        const isUpdate = existingIds.has(row.studentId);

        try {
            const studentData = {
                lrn:          row.studentId,
                first_name:   row.firstName,
                middle_name:  row.middleName || null,
                last_name:    row.lastName,
                suffix:       row.suffix || null,
                birth_date:   row.birthDate || null,
                gender:       row.gender || null,
                section_id:   selectedDepartmentId,
                status:       'active',
                updated_at:   new Date().toISOString(),
            };

            let error;

            if (isUpdate) {
                const res = await supabaseClient
                    .from('students')
                    .update(studentData)
                    .eq('lrn', row.studentId);
                error = res.error;
            } else {
                // Insert new record
                studentData.student_id = crypto.randomUUID();
                studentData.created_at = new Date().toISOString();
                const res = await supabaseClient
                    .from('students')
                    .insert(studentData);
                error = res.error;
            }

            if (error) throw error;

            success++;
            const label = isUpdate ? 'Updated' : 'Imported';
            addLog(log, 'ok', `[Row ${row.rowIndex}] ${label}: ${row.firstName} ${row.lastName} (${row.studentId})`);

            const emailResult = await sendStudentQrEmail({
                studentId: row.studentId,
                firstName: row.firstName,
                middleName: row.middleName,
                lastName: row.lastName,
                birthDate: row.birthDate,
                gender: row.gender,
                sectionLabel: selectedDepartmentName,
                email: row.email,
            });

            if (emailResult.sent) {
                addLog(log, 'info', `[Row ${row.rowIndex}] QR email sent to ${row.email}`);
            } else {
                addLog(log, 'warning', `[Row ${row.rowIndex}] QR email not sent (${emailResult.message})`);
            }

        } catch (err) {
            failed++;
            addLog(log, 'error', `[Row ${row.rowIndex}] Failed: ${row.firstName} ${row.lastName} — ${err.message}`);
        }
        const progress = Math.round(((i + 1) / total) * 100);
        fill.style.width = progress + '%';
        text.textContent = `${i + 1} of ${total} students processed`;
        pct.textContent  = progress + '%';
        await sleep(60);
    }

    addLog(log, 'info', '─────────────────────────────────');
    addLog(log, success > 0 ? 'ok' : 'error',
        `Import complete. ${success} succeeded, ${failed} failed.`);

    if (success > 0) {
        await loadAllStudentsTable();
    }

    document.getElementById('importFooter').style.display = 'flex';
}

async function loadAllStudentsTable() {
    const tbody = document.getElementById('allStudentsTableBody');
    const countEl = document.getElementById('allStudentsCount');
    if (!tbody || !countEl || !supabaseClient) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="8" style="text-align:center;padding:1rem;color:var(--text-muted);">Loading students...</td>
        </tr>
    `;

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select('student_id, lrn, first_name, middle_name, last_name, suffix, birth_date, gender, section_id, status, sections:section_id(grade_level, section_name)')
            .order('last_name', { ascending: true })
            .order('first_name', { ascending: true });

        if (error) throw error;

        allStudents = data || [];
        populateStudentsFilterOptions();
        renderAllStudentsTable();
    } catch (error) {
        console.error('Error loading students table:', error);
        tbody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;padding:1rem;color:#dc3545;">Failed to load students list.</td>
            </tr>
        `;
        countEl.textContent = '0';
    }
}

function renderAllStudentsTable() {
    const tbody = document.getElementById('allStudentsTableBody');
    const countEl = document.getElementById('allStudentsCount');
    if (!tbody || !countEl) return;

    const search = String(document.getElementById('studentSearchInput')?.value || '').trim().toLowerCase();
    const dept = String(document.getElementById('studentDeptFilter')?.value || '').trim();
    const course = String(document.getElementById('studentCourseFilter')?.value || '').trim();
    const year = String(document.getElementById('studentYearFilter')?.value || '').trim();

    const filteredStudents = allStudents.filter(student => {
        // Format: lastName, firstName middleName suffix
        const nameParts = [student.first_name, student.middle_name, student.suffix].filter(Boolean);
        const fullName = student.last_name ? (student.last_name + ', ' + nameParts.join(' ')).toLowerCase() : nameParts.join(' ').toLowerCase();
        const matchesSearch = !search
            || fullName.includes(search)
            || String(student.lrn || '').toLowerCase().includes(search);
        const gradeLevel = String(student.sections?.grade_level || '').trim();
        const sectionName = String(student.sections?.section_name || '').trim();
        const gender = String(student.gender || '').trim().toLowerCase();
        const matchesDept = !dept || gradeLevel === dept;
        const matchesCourse = !course || sectionName.toLowerCase() === course.toLowerCase();
        const matchesYear = !year || gender === year.toLowerCase();
        return matchesSearch && matchesDept && matchesCourse && matchesYear;
    });

    countEl.textContent = filteredStudents.length;

    if (filteredStudents.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;padding:1rem;color:var(--text-muted);">No students found with current filters.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filteredStudents.map((student) => {
        // Format: lastName, firstName middleName suffix
        const nameParts = [student.first_name, student.middle_name, student.suffix].filter(Boolean);
        const fullName = student.last_name ? (student.last_name + ', ' + nameParts.join(' ')) : nameParts.join(' ');
        const gradeLevel = student.sections?.grade_level || 'N/A';
        const sectionName = student.sections?.section_name || 'N/A';
        const status = student.status || 'inactive';
        return `
            <tr>
                <td><strong>${escapeHtml(student.lrn || 'N/A')}</strong></td>
                <td>${escapeHtml(fullName || 'N/A')}</td>
                <td>${escapeHtml(gradeLevel)}</td>
                <td>${escapeHtml(sectionName)}</td>
                <td>${escapeHtml(student.birth_date || '—')}</td>
                <td>${escapeHtml(student.gender || '—')}</td>
                <td>${escapeHtml(status)}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon" title="Edit" data-action="edit" data-id="${escapeHtml(student.lrn || '')}">
                            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn-icon danger" title="Delete" data-action="delete" data-id="${escapeHtml(student.lrn || '')}">
                            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function populateStudentsFilterOptions() {
    const deptFilter = document.getElementById('studentDeptFilter');
    const courseFilter = document.getElementById('studentCourseFilter');
    const yearFilter = document.getElementById('studentYearFilter');
    if (!deptFilter || !courseFilter || !yearFilter) return;

    const selectedDept = deptFilter.value;
    const selectedCourse = courseFilter.value;
    const selectedYear = yearFilter.value;

    const uniqueGrades = [...new Set(allStudents.map(s => String(s.sections?.grade_level || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    deptFilter.innerHTML = '<option value="">All Grade Levels</option>';
    uniqueGrades.forEach(grade => {
        const option = document.createElement('option');
        option.value = grade;
        option.textContent = grade;
        deptFilter.appendChild(option);
    });

    const uniqueCourses = [...new Set(allStudents.map(s => String(s.sections?.section_name || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    courseFilter.innerHTML = '<option value="">All Sections</option>';
    uniqueCourses.forEach(course => {
        const option = document.createElement('option');
        option.value = course;
        option.textContent = course;
        courseFilter.appendChild(option);
    });

    const uniqueYears = [...new Set(allStudents.map(s => String(s.gender || '').trim().toLowerCase()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
    yearFilter.innerHTML = '<option value="">All Genders</option>';
    uniqueYears.forEach(year => {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        yearFilter.appendChild(option);
    });

    deptFilter.value = selectedDept;
    courseFilter.value = selectedCourse;
    yearFilter.value = selectedYear;
}

function clearStudentsFilters() {
    const searchInput = document.getElementById('studentSearchInput');
    const deptFilter = document.getElementById('studentDeptFilter');
    const courseFilter = document.getElementById('studentCourseFilter');
    const yearFilter = document.getElementById('studentYearFilter');
    if (searchInput) searchInput.value = '';
    if (deptFilter) deptFilter.value = '';
    if (courseFilter) courseFilter.value = '';
    if (yearFilter) yearFilter.value = '';
    renderAllStudentsTable();
}

function handleStudentsTableActions(event) {
    const actionBtn = event.target.closest('[data-action]');
    if (!actionBtn) return;

    const action = actionBtn.dataset.action;
    const studentId = actionBtn.dataset.id;
    if (!studentId) return;

    if (action === 'edit') {
        openEditStudentModal(studentId);
        return;
    }
    if (action === 'delete') {
        deleteStudentRow(studentId);
    }
}

function openEditStudentModal(idNumber) {
    const student = allStudents.find(s => String(s.lrn) === String(idNumber));
    if (!student || !editStudentModal) return;

    const editDepartment = document.getElementById('editDepartment');
    if (editDepartment) {
        editDepartment.innerHTML = '';
        departmentsCache.forEach(dept => {
            const option = document.createElement('option');
            option.value = String(dept.section_id);
            option.textContent = `${dept.grade_level} - ${dept.section_name}`;
            editDepartment.appendChild(option);
        });
    }

    document.getElementById('editStudentUid').value = student.student_id || '';
    document.getElementById('editStudentId').value = student.lrn || '';
    document.getElementById('editDepartment').value = String(student.section_id || '');
    document.getElementById('editFirstName').value = student.first_name || '';
    document.getElementById('editMiddleName').value = student.middle_name || '';
    document.getElementById('editLastName').value = student.last_name || '';
    document.getElementById('editSuffix').value = student.suffix || '';
    document.getElementById('editYearLevel').value = student.birth_date || '';
    document.getElementById('editSection').value = (student.gender || '').toLowerCase();
    document.getElementById('editStatus').value = student.status || 'inactive';

    editStudentModal.show();
}

async function submitEditStudentForm(event) {
    event.preventDefault();

    const saveBtn = document.getElementById('saveStudentEditBtn');
    const studentUid = String(document.getElementById('editStudentUid')?.value || '').trim();
    const idNumber = String(document.getElementById('editStudentId')?.value || '').trim();
    const sectionId = String(document.getElementById('editDepartment')?.value || '').trim();
    const firstName = String(document.getElementById('editFirstName')?.value || '').trim();
    const middleName = String(document.getElementById('editMiddleName')?.value || '').trim();
    const lastName = String(document.getElementById('editLastName')?.value || '').trim();
    const suffix = String(document.getElementById('editSuffix')?.value || '').trim();
    const birthDate = String(document.getElementById('editYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('editSection')?.value || '').trim().toLowerCase();
    const status = String(document.getElementById('editStatus')?.value || 'inactive').trim();

    if (!sectionId || !firstName || !lastName) {
        showImportAlert('Section, First Name, and Last Name are required.', 'warning');
        return;
    }

    if (birthDate && Number.isNaN(Date.parse(birthDate))) {
        showImportAlert('Birth Date must be valid.', 'warning');
        return;
    }

    if (gender && !['male', 'female', 'other'].includes(gender)) {
        showImportAlert('Gender must be male, female, or other.', 'warning');
        return;
    }

    const updatePayload = {
        first_name: firstName,
        middle_name: middleName || null,
        last_name: lastName,
        suffix: suffix || null,
        birth_date: birthDate || null,
        gender: gender || null,
        section_id: sectionId,
        status,
        updated_at: new Date().toISOString(),
    };

    try {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }

        let query = supabaseClient.from('students').update(updatePayload);
        if (studentUid) {
            query = query.eq('student_id', studentUid);
        } else {
            query = query.eq('lrn', idNumber);
        }

        const { error } = await query;
        if (error) throw error;

        showImportAlert(`Student ${idNumber} updated successfully.`, 'success');
        editStudentModal?.hide();
        await loadAllStudentsTable();
    } catch (error) {
        console.error('Error updating student:', error);
        showImportAlert(`Failed to update student: ${error.message}`, 'danger');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
        }
    }
}

async function deleteStudentRow(idNumber) {
    const student = allStudents.find(s => String(s.lrn) === String(idNumber));
    // Format: lastName, firstName middleName suffix
    const displayName = student
        ? (student.last_name ? (student.last_name + ', ' + [student.first_name, student.middle_name, student.suffix].filter(Boolean).join(' ')) : [student.first_name, student.middle_name, student.suffix].filter(Boolean).join(' '))
        : idNumber;

    if (!confirm(`Delete student ${displayName} (${idNumber})? This action cannot be undone.`)) {
        return;
    }

    try {
        let query = supabaseClient.from('students').delete();
        if (student?.student_id) {
            query = query.eq('student_id', student.student_id);
        } else {
            query = query.eq('lrn', idNumber);
        }

        const { error } = await query;
        if (error) throw error;

        showImportAlert(`Student ${idNumber} deleted successfully.`, 'success');
        await loadAllStudentsTable();
    } catch (error) {
        console.error('Error deleting student:', error);
        showImportAlert(`Failed to delete student: ${error.message}`, 'danger');
    }
}


function showStep(step) {
    document.getElementById('stepUpload').style.display  = step === 'upload'  ? '' : 'none';
    document.getElementById('stepPreview').style.display = step === 'preview' ? '' : 'none';
    document.getElementById('stepImport').style.display  = step === 'import'  ? '' : 'none';
}

function goBackToUpload() {
    parsedRows = [];
    showStep('upload');
}

function resetAll() {
    parsedRows = [];
    duplicateRowsInFileCount = 0;
    duplicateRowsInDatabaseCount = 0;
    duplicateRowsInFile = [];
    duplicateRowsInDatabase = [];
    clearFileSelection();
    document.getElementById('departmentSelect').value = '';
    selectedDepartmentId = null;
    selectedDepartmentName = '';
    document.getElementById('importLog').innerHTML = '';
    document.getElementById('progressBarFill').style.width = '0%';
    document.getElementById('importFooter').style.display = 'none';
    showStep('upload');
    checkReadyToParse();
}

function populateSingleStudentDepartments() {
    const select = document.getElementById('singleDepartment');
    if (!select) return;

    select.innerHTML = '<option value="">Select section...</option>';
    departmentsCache.forEach(dept => {
        const option = document.createElement('option');
        option.value = dept.section_id;
        option.textContent = `${dept.grade_level} - ${dept.section_name}`;
        select.appendChild(option);
    });
}

function openSingleStudentModal() {
    if (!singleStudentModal) {
        showImportAlert('Single student form is not available right now.', 'danger');
        return;
    }

    const deptSelect = document.getElementById('singleDepartment');
    if (deptSelect && selectedDepartmentId) {
        deptSelect.value = selectedDepartmentId;
    }

    singleStudentModal.show();
}

async function submitSingleStudentForm(event) {
    event.preventDefault();

    const submitBtn = document.getElementById('singleStudentSubmitBtn');
    const sectionId = document.getElementById('singleDepartment')?.value || '';
    const studentId = String(document.getElementById('singleStudentId')?.value || '').replace(/\D/g, '').trim();
    const firstName = String(document.getElementById('singleFirstName')?.value || '').trim();
    const middleName = String(document.getElementById('singleMiddleName')?.value || '').trim();
    const lastName = String(document.getElementById('singleLastName')?.value || '').trim();
    const suffix = String(document.getElementById('singleSuffix')?.value || '').trim();
    const birthDate = String(document.getElementById('singleYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('singleSection')?.value || '').trim().toLowerCase();
    const emailRaw = String(document.getElementById('singleEmail')?.value || '').trim();

    if (!sectionId || !studentId || !firstName || !lastName) {
        showImportAlert('Please fill in Section, LRN, First Name, and Last Name.', 'warning');
        return;
    }

    if (!/^\d{12}$/.test(studentId)) {
        showImportAlert('LRN must be exactly 12 digits.', 'warning');
        return;
    }

    if (birthDate && Number.isNaN(Date.parse(birthDate))) {
        showImportAlert('Birth Date must be valid.', 'warning');
        return;
    }

    if (gender && !['male', 'female', 'other'].includes(gender)) {
        showImportAlert('Gender must be male, female, or other.', 'warning');
        return;
    }

    const email = emailRaw;

    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';

        if (!supabaseClient) throw new Error('Database connection not available. Please refresh the page and try again.');

        const { data: existingStudent, error: existingError } = await supabaseClient
            .from('students')
            .select('lrn')
            .eq('lrn', studentId)
            .maybeSingle();

        if (existingError) throw existingError;
        if (existingStudent) {
            showImportAlert(`LRN ${studentId} already exists. Use import to update existing records.`, 'warning');
            return;
        }

        const payload = {
            student_id: crypto.randomUUID(),
            lrn: studentId,
            first_name: firstName,
            middle_name: middleName || null,
            last_name: lastName,
            suffix: suffix || null,
            birth_date: birthDate || null,
            gender: gender || null,
            section_id: sectionId,
            status: 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        const { error: insertError } = await supabaseClient
            .from('students')
            .insert(payload);

        if (insertError) throw insertError;

        const emailResult = await sendStudentQrEmail({
            studentId,
            firstName,
            middleName,
            lastName,
            suffix,
            birthDate,
            gender,
            sectionLabel: departmentsCache.find(s => String(s.section_id) === String(sectionId))
                ? `${departmentsCache.find(s => String(s.section_id) === String(sectionId)).grade_level} - ${departmentsCache.find(s => String(s.section_id) === String(sectionId)).section_name}`
                : '',
            email,
        });

        if (emailResult.sent) {
            showImportAlert(`Student ${firstName} ${lastName} (${studentId}) added successfully. QR code was emailed to ${email}.`, 'success');
        } else {
            const level = email ? 'warning' : 'info';
            showImportAlert(`Student ${firstName} ${lastName} (${studentId}) added successfully. QR email status: ${emailResult.message}.`, level);
        }

        document.getElementById('singleStudentForm')?.reset();
        singleStudentModal?.hide();
        await loadAllStudentsTable();

    } catch (err) {
        console.error('Single student registration failed:', err?.message || err, {
            code: err?.code,
            details: err?.details,
            hint: err?.hint,
            full: err
        });
        showImportAlert(`Failed to save student: ${err?.message || 'Unknown error. Check console for details.'}`, 'danger');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Student';
    }
}

function openDuplicateRowsModal() {
    const totalDuplicated = duplicateRowsInFile.length + duplicateRowsInDatabase.length;
    if (!duplicateRowsModal || totalDuplicated === 0) {
        return;
    }

    renderDuplicateRowsTable();
    duplicateRowsModal.show();
}

function renderDuplicateRowsTable() {
    const tableBody = document.getElementById('duplicateRowsTableBody');
    const summaryText = document.getElementById('duplicateRowsSummaryText');
    if (!tableBody || !summaryText) return;

    const mergedRows = [
        ...duplicateRowsInFile.map(row => ({ ...row, reason: 'Duplicate in uploaded file' })),
        ...duplicateRowsInDatabase.map(row => ({ ...row, reason: 'LRN already exists in database' }))
    ].sort((a, b) => (a.rowIndex || 0) - (b.rowIndex || 0));

    summaryText.textContent = `${mergedRows.length} row(s) were skipped during import validation.`;

    if (mergedRows.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center;padding:1rem;color:var(--text-muted);">
                    No duplicated rows found.
                </td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML = mergedRows.map((row) => {
        const fullName = [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ');
        return `
            <tr>
                <td>${escapeHtml(row.rowIndex || '-')}</td>
                <td><strong>${escapeHtml(row.studentId || '-')}</strong></td>
                <td>${escapeHtml(fullName || '-')}</td>
                <td>${escapeHtml(row.email || '-')}</td>
                <td>${escapeHtml(row.reason)}</td>
            </tr>
        `;
    }).join('');
}

function addLog(container, type, message) {
    const icons = {
        ok:      '✓',
        error:   '✗',
        warning: '⚠',
        info:    '›',
    };
    const line = document.createElement('div');
    line.className = `log-line log-${type}`;
    line.innerHTML = `
        <span class="log-icon">${icons[type] || '›'}</span>
        <span class="log-text">${escapeHtml(message)}</span>
    `;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getStudentQrPayload(student) {
    const fullName = [student.firstName, student.middleName, student.lastName]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    const birthDate = String(student.birthDate || '').trim() || 'N/A';
    const gender = String(student.gender || '').trim() || 'N/A';
    const sectionLabel = String(student.sectionLabel || '').trim() || 'N/A';

    return [
        'PLP Laboratory Attendance QR',
        `Name: ${fullName || 'N/A'}`,
        `LRN: ${student.studentId}`,
        `Birth Date: ${birthDate}`,
        `Gender: ${gender}`,
        `Section: ${sectionLabel}`,
    ].join('\n');
}

async function sendStudentQrEmail(student) {
    const email = String(student.email || '').trim();
    if (!email) {
        return { sent: false, message: 'no email provided' };
    }
    if (!EMAIL_LIKE_PATTERN.test(email)) {
        return { sent: false, message: 'email format not deliverable' };
    }

    const payload = {
        email,
        studentId: String(student.studentId || '').trim(),
        firstName: String(student.firstName || '').trim(),
        middleName: String(student.middleName || '').trim(),
        lastName: String(student.lastName || '').trim(),
        course: String(student.sectionLabel || '').trim(),
        yearLevel: String(student.birthDate ?? '').trim(),
        section: String(student.gender || '').trim(),
        qrPayload: getStudentQrPayload(student),
    };

    if (!payload.studentId) {
        return { sent: false, message: 'missing student ID' };
    }

    try {
        const response = await fetch(QR_EMAIL_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        let result = null;
        try {
            result = await response.json();
        } catch (parseErr) {
            result = null;
        }

        if (!response.ok || !result?.success) {
            const detail = result?.diagnostic
                ? ` ${result.diagnostic}`
                : '';
            return { sent: false, message: `${result?.message || `HTTP ${response.status}`}${detail}`.trim() };
        }

        return { sent: true, message: result.message || 'sent' };
    } catch (err) {
        return { sent: false, message: err.message || 'network error' };
    }
}

function showImportAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    const main = document.querySelector('.main-content');
    main.insertBefore(alertDiv, main.firstChild);
    setTimeout(() => alertDiv.remove(), 6000);
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function downloadStudentTemplate() {
    const headers = [
        'LRN',
        'Last Name',
        'First Name',
        'Middle Name',
        'Suffix',
        'Birth Date',
        'Gender',
        'Section',
        'Email'
    ];

    const sampleRow = [
        '123456789012',
        'Dela Cruz',
        'Juan',
        'Santos',
        '',
        '2012-06-14',
        'male',
        'Grade 3 - A',
        'delacruz_juan@plpasig.edu.ph'
    ];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
        XLSX.utils.book_append_sheet(wb, ws, 'Students');
        XLSX.writeFile(wb, 'student-import-template.xlsx');
        return;
    }

    // Fallback if SheetJS fails to load.
    const csv = [headers, sampleRow]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student-import-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function removeDuplicateStudentIdsFromParsedRows() {
    const seen = new Set();
    const deduped = [];
    const removedRows = [];

    // Keep first occurrence to preserve visible row order in preview.
    for (const row of parsedRows) {
        const key = String(row.studentId || '').trim();
        if (!key) {
            deduped.push(row);
            continue;
        }
        if (seen.has(key)) {
            removedRows.push(row);
            continue;
        }
        seen.add(key);
        deduped.push(row);
    }

    const removed = parsedRows.length - deduped.length;
    duplicateRowsInFile = removedRows;
    parsedRows = deduped;
    return removed;
}

async function removeExistingStudentIdsFromParsedRows() {
    const queryableIds = [...new Set(
        parsedRows
            .map(row => String(row.studentId || '').trim())
            .filter(id => /^\d{12}$/.test(id))
    )];

    if (queryableIds.length === 0) {
        return 0;
    }

    const { data: existingStudents, error } = await supabaseClient
        .from('students')
        .select('lrn')
        .in('lrn', queryableIds);

    if (error) throw error;

    const existingIds = new Set((existingStudents || []).map(row => row.lrn));
    const originalLength = parsedRows.length;
    const removedRows = [];
    parsedRows = parsedRows.filter(row => {
        const isExisting = existingIds.has(String(row.studentId || '').trim());
        if (isExisting) {
            removedRows.push(row);
            return false;
        }
        return true;
    });
    duplicateRowsInDatabase = removedRows;

    return originalLength - parsedRows.length;
}