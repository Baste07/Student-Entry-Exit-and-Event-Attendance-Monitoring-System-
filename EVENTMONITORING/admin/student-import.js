let parsedRows = [];
let selectedDepartmentId = null;
let selectedDepartmentName = '';
let departmentsCache = [];
let singleStudentModal = null;
let duplicateRowsModal = null;
let editStudentModal = null;
let viewGuardiansModal = null;
let duplicateRowsInFileCount = 0;
let duplicateRowsInDatabaseCount = 0;
let duplicateRowsInFile = [];
let duplicateRowsInDatabase = [];
let allStudents = [];
let activeSchoolYear = null;
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

        // Fetch and assign directly to the global variable
        const { data: fetchedSY, error: schoolYearError } = await supabaseClient
            .from('school_years')
            .select('id, name')
            .eq('is_active', true)
            .maybeSingle();

        activeSchoolYear = fetchedSY; // Save it globally
        const syDisplay = document.getElementById('activeSchoolYearDisplay');

        if (schoolYearError || !activeSchoolYear) {
            console.warn('No active school year found:', schoolYearError);
            showAlert('No active school year set. Please set one in System Settings before importing.', 'warning');
            
            if (syDisplay) syDisplay.value = 'No Active School Year';
            document.getElementById('departmentSelect').innerHTML = '<option value="" disabled selected>No Active School Year</option>';
            return;
        }

        if (syDisplay) {
            syDisplay.value = activeSchoolYear.name;
        }

        const { data: depts, error } = await supabaseClient
            .from('sections')
            .select('section_id, grade_level, section_name')
            .eq('school_year_id', activeSchoolYear.id)
            .order('grade_level', { ascending: true })
            .order('section_name', { ascending: true });

        if (error) throw error;
        departmentsCache = depts || [];

        const select = document.getElementById('departmentSelect');
        select.innerHTML = '<option value="" disabled selected>Select grade level and section...</option>';
        
        departmentsCache.forEach(dept => {
            const opt = document.createElement('option');
            opt.value = dept.section_id;
            opt.textContent = `${dept.grade_level} - ${dept.section_name}`;
            select.appendChild(opt);
        });

        // RESTORED: This populates the dropdown inside the Single Student Modal!
        populateSingleStudentDepartments();
        checkReadyToParse();

    } catch (error) {
        console.error('Error loading sections:', error);
        showAlert('Error loading sections: ' + error.message, 'danger');
    }
}

function setupEventListeners() {


    // Inside setupEventListeners(), alongside the other modal inits:
const addGuardianModalElement = document.getElementById('addGuardianModal');
if (addGuardianModalElement && window.bootstrap) {
    addGuardianModal = new bootstrap.Modal(addGuardianModalElement);
}

document.getElementById('addGuardianForm')?.addEventListener('submit', submitAddGuardianForm);
document.getElementById('modalGuardianPhone')?.addEventListener('blur', handleModalGuardianPhoneLookup);
    // Add inside setupEventListeners(), alongside the other single-student listeners:
const guardianPhoneInput = document.getElementById('singleGuardianPhone');
guardianPhoneInput?.addEventListener('blur', handleGuardianPhoneLookup);
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

        const viewGuardiansModalElement = document.getElementById('viewGuardiansModal');
        if (viewGuardiansModalElement) {
            viewGuardiansModal = new bootstrap.Modal(viewGuardiansModalElement);
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

    // Add guardian button in single student modal
    const addGuardian2Btn = document.getElementById('addGuardian2Btn');
    addGuardian2Btn?.addEventListener('click', showGuardian2Form);

    // Form step navigation
    const nextToGuardianBtn = document.getElementById('nextToGuardianBtn');
    const backToStudentBtn = document.getElementById('backToStudentBtn');
    nextToGuardianBtn?.addEventListener('click', proceedToGuardianStep);
    backToStudentBtn?.addEventListener('click', goBackToStudentStep);

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

// Add near the other module-level lets:
let addGuardianModal = null;

async function handleGuardianPhoneLookup(e) {
    const phone = String(e.target.value || '').trim();
    const statusEl = document.getElementById('guardianLookupStatus');
    if (!phone || !supabaseClient) {
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Checking existing guardians...';
        statusEl.className = 'searching';
    }

    try {
        const { data: existing, error } = await supabaseClient
            .from('guardians')
            .select('guardian_id, first_name, middle_name, last_name, relationship')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) throw error;

        if (existing) {
            document.getElementById('singleGuardianFirstName').value = existing.first_name || '';
            document.getElementById('singleGuardianMiddleName').value = existing.middle_name || '';
            document.getElementById('singleGuardianLastName').value = existing.last_name || '';
            document.getElementById('singleGuardianRelationship').value = existing.relationship || '';

            if (statusEl) {
                statusEl.textContent = `Existing guardian found: ${existing.first_name} ${existing.last_name}. They'll be linked to this student.`;
                statusEl.className = 'found';
            }
        } else if (statusEl) {
            statusEl.textContent = 'No existing guardian found with this number — a new guardian record will be created.';
            statusEl.className = '';
        }
    } catch (err) {
        console.error('Guardian lookup failed:', err);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
    }
}

async function upsertAndLinkGuardian(studentId, guardianData, isPrimary = true) {
    const { data: existing, error: findError } = await supabaseClient
        .from('guardians')
        .select('guardian_id')
        .eq('phone_number', guardianData.phone_number)
        .maybeSingle();

    if (findError) throw findError;

    let guardianId = existing?.guardian_id;

    if (!guardianId) {
        const { data: inserted, error: insertError } = await supabaseClient
            .from('guardians')
            .insert({
                first_name: guardianData.first_name,
                middle_name: guardianData.middle_name || null,
                last_name: guardianData.last_name,
                relationship: guardianData.relationship,
                phone_number: guardianData.phone_number,
                alternate_phone_number: guardianData.alternate_phone_number || null,
                email: guardianData.email || null,
                address: guardianData.address || null,
            })
            .select('guardian_id')
            .single();

        if (insertError) throw insertError;
        guardianId = inserted.guardian_id;
    }

    const { error: linkError } = await supabaseClient
        .from('student_guardians')
        .insert({
            student_id: studentId,
            guardian_id: guardianId,
            is_primary_contact: isPrimary,
        });

    if (linkError) throw linkError;

    return guardianId;
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
    email:       String(r[7] || '').trim(),
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
            email:      cols[7] || '',
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

    // Safety check: Ensure active school year exists before bulk importing
    if (!activeSchoolYear || !activeSchoolYear.id) {
        showImportAlert('No active school year found. Please set one in System Settings first.', 'danger');
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
                school_year_id: activeSchoolYear.id, // <-- ADDED THIS LINE
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
            <td colspan="9" style="text-align:center;padding:1rem;color:var(--text-muted);">Loading students...</td>
        </tr>
    `;

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select(`
                student_id, lrn, first_name, middle_name, last_name, suffix, birth_date, gender, section_id, status,
                sections:section_id(grade_level, section_name),
                student_guardians(is_primary_contact, guardians:guardian_id(first_name, last_name, relationship, phone_number, email, address))
            `)
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
                <td colspan="9" style="text-align:center;padding:1rem;color:#dc3545;">Failed to load students list.</td>
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
                <td colspan="9" style="text-align:center;padding:1rem;color:var(--text-muted);">No students found with current filters.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filteredStudents.map((student) => {
        const nameParts = [student.first_name, student.middle_name, student.suffix].filter(Boolean);
        const fullName = student.last_name ? (student.last_name + ', ' + nameParts.join(' ')) : nameParts.join(' ');
        const gradeLevel = student.sections?.grade_level || 'N/A';
        const sectionName = student.sections?.section_name || 'N/A';
        const status = student.status || 'inactive';

        const guardianLinks = student.student_guardians || [];
        let guardianCell = '';
        if (guardianLinks.length === 0) {
            guardianCell = `<button type="button" class="status-badge warning" style="border:none;cursor:pointer;" data-action="addGuardian" data-id="${escapeHtml(student.lrn || '')}">
                 Not Added — Add
               </button>`;
        } else if (guardianLinks.length === 1) {
            const guardian = guardianLinks[0].guardians;
            guardianCell = `<button type="button" class="status-badge valid" style="border:none;cursor:pointer;" data-action="viewGuardians" data-student-id="${escapeHtml(student.student_id || '')}" data-student-name="${escapeHtml((student.first_name || '') + ' ' + (student.last_name || ''))}" data-student-lrn="${escapeHtml(student.lrn || '')}" title="${escapeHtml(guardian.relationship || '')}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;margin-right:0.3rem;vertical-align:middle;">
                    <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
                </svg>
                ${escapeHtml(guardian.first_name + ' ' + guardian.last_name)}
               </button>`;
        } else {
            guardianCell = `<button type="button" class="status-badge valid" style="border:none;cursor:pointer;" data-action="viewGuardians" data-student-id="${escapeHtml(student.student_id || '')}" data-student-name="${escapeHtml((student.first_name || '') + ' ' + (student.last_name || ''))}" data-student-lrn="${escapeHtml(student.lrn || '')}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;margin-right:0.3rem;vertical-align:middle;">
                    <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
                </svg>
                ${guardianLinks.length} Guardian${guardianLinks.length > 1 ? 's' : ''}
               </button>`;
        }

        return `
            <tr>
                <td><strong>${escapeHtml(student.lrn || 'N/A')}</strong></td>
                <td>${escapeHtml(fullName || 'N/A')}</td>
                <td>${escapeHtml(gradeLevel)}</td>
                <td>${escapeHtml(sectionName)}</td>
                <td>${escapeHtml(student.birth_date || '—')}</td>
                <td>${escapeHtml(student.gender || '—')}</td>
                <td>${guardianCell}</td>
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
    
    // Handle viewGuardians action (doesn't need studentId from data-id)
    if (action === 'viewGuardians') {
        const studentUuid = actionBtn.dataset.studentId;
        const studentName = actionBtn.dataset.studentName;
        const studentLrn = actionBtn.dataset.studentLrn;
        openViewGuardiansModal(studentUuid, studentName, studentLrn);
        return;
    }
    
    const studentId = actionBtn.dataset.id;
    if (!studentId) return;

    if (action === 'edit') {
        openEditStudentModal(studentId);
        return;
    }
    if (action === 'delete') {
        deleteStudentRow(studentId);
        return;
    }
    if (action === 'addGuardian') {
        const student = allStudents.find(s => String(s.lrn) === String(studentId));
        const displayName = student
            ? [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ')
            : studentId;
        openAddGuardianModal(student?.student_id, displayName, studentId);
    }
}

function openViewGuardiansModal(studentUuid, studentName, studentLrn) {
    if (!viewGuardiansModal) {
        showImportAlert('View Guardians modal is not available right now.', 'danger');
        return;
    }

    document.getElementById('viewGuardiansStudentName').textContent = studentName || '—';
    document.getElementById('viewGuardiansStudentLRN').textContent = studentLrn || '—';

    // Find student and populate guardians
    const student = allStudents.find(s => String(s.student_id) === String(studentUuid));
    if (!student || !student.student_guardians || student.student_guardians.length === 0) {
        document.getElementById('guardiansListContent').innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
                <p>No guardians added yet.</p>
            </div>
        `;
    } else {
        const guardiansHtml = student.student_guardians.map((link, index) => {
            const g = link.guardians;
            const isPrimary = link.is_primary_contact;
            return `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 1.25rem; background: rgba(99, 102, 241, 0.05); border: 1px solid rgba(99, 102, 241, 0.1); border-radius: 0.625rem; transition: all 0.2s ease;">
                    <div style="flex: 1;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                            <h6 style="margin: 0; color: var(--text-main); font-weight: 600;">Guardian ${index + 1}</h6>
                            ${isPrimary ? '<span style="display: inline-block; background: #10b981; color: white; padding: 0.25rem 0.75rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600;">Primary</span>' : ''}
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-top: 0.75rem;">
                            <div>
                                <p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">Name</p>
                                <p style="margin: 0; font-weight: 600; color: var(--text-main);">${escapeHtml(g.first_name)} ${escapeHtml(g.last_name)}</p>
                            </div>
                            <div>
                                <p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">Relationship</p>
                                <p style="margin: 0; font-weight: 600; color: var(--text-main);">${escapeHtml(g.relationship || '—')}</p>
                            </div>
                            <div>
                                <p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">Phone</p>
                                <p style="margin: 0; font-weight: 600; color: var(--text-main);">${escapeHtml(g.phone_number || '—')}</p>
                            </div>
                            ${g.email ? `<div>
                                <p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">Email</p>
                                <p style="margin: 0; font-weight: 600; color: var(--text-main);">${escapeHtml(g.email)}</p>
                            </div>` : '<div></div>'}
                            ${g.address ? `<div style="grid-column: 1 / -1;">
                                <p style="margin: 0; font-size: 0.875rem; color: var(--text-muted);">Address</p>
                                <p style="margin: 0; font-weight: 600; color: var(--text-main);">${escapeHtml(g.address)}</p>
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        document.getElementById('guardiansListContent').innerHTML = guardiansHtml;
    }

    // Update the "Add Guardian" button to trigger the add modal
    const addGuardianBtn = document.getElementById('addGuardianFromViewBtn');
    if (addGuardianBtn) {
        addGuardianBtn.onclick = () => {
            viewGuardiansModal.hide();
            openAddGuardianModal(studentUuid, studentName, studentLrn);
        };
    }

    viewGuardiansModal.show();
}

function openAddGuardianModal(studentUuid, displayName, lrn) {
    if (!addGuardianModal) {
        showImportAlert('Add Guardian form is not available right now.', 'danger');
        return;
    }
    document.getElementById('addGuardianForm')?.reset();
    const statusEl = document.getElementById('modalGuardianLookupStatus');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }

    document.getElementById('guardianModalStudentId').value = studentUuid || '';
    document.getElementById('guardianModalStudentId').dataset.lrn = lrn || '';
    document.getElementById('guardianModalStudentName').textContent = displayName || lrn;

    addGuardianModal.show();
}

async function handleModalGuardianPhoneLookup(e) {
    const phone = String(e.target.value || '').trim();
    const statusEl = document.getElementById('modalGuardianLookupStatus');
    if (!phone || !supabaseClient) {
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Checking existing guardians...';
        statusEl.className = 'searching';
    }

    try {
        const { data: existing, error } = await supabaseClient
            .from('guardians')
            .select('guardian_id, first_name, middle_name, last_name, relationship')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) throw error;

        if (existing) {
            document.getElementById('modalGuardianFirstName').value = existing.first_name || '';
            document.getElementById('modalGuardianMiddleName').value = existing.middle_name || '';
            document.getElementById('modalGuardianLastName').value = existing.last_name || '';
            document.getElementById('modalGuardianRelationship').value = existing.relationship || '';

            if (statusEl) {
                statusEl.textContent = `Existing guardian found: ${existing.first_name} ${existing.last_name}. They'll be linked to this student.`;
                statusEl.className = 'found';
            }
        } else if (statusEl) {
            statusEl.textContent = 'No existing guardian found with this number — a new guardian record will be created.';
            statusEl.className = '';
        }
    } catch (err) {
        console.error('Guardian lookup failed:', err);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
    }
}

async function submitAddGuardianForm(event) {
    event.preventDefault();

    const submitBtn = document.getElementById('addGuardianSubmitBtn');
    const overlay = document.getElementById('addGuardianLoadingOverlay');
    const studentUuid = document.getElementById('guardianModalStudentId')?.value || '';
    const lrn = document.getElementById('guardianModalStudentId')?.dataset.lrn || '';

    const firstName = String(document.getElementById('modalGuardianFirstName')?.value || '').trim();
    const middleName = String(document.getElementById('modalGuardianMiddleName')?.value || '').trim();
    const lastName = String(document.getElementById('modalGuardianLastName')?.value || '').trim();
    const relationship = String(document.getElementById('modalGuardianRelationship')?.value || '').trim();
    const phone = String(document.getElementById('modalGuardianPhone')?.value || '').trim();
    const altPhone = String(document.getElementById('modalGuardianAltPhone')?.value || '').trim();
    const email = String(document.getElementById('modalGuardianEmail')?.value || '').trim();
    const address = String(document.getElementById('modalGuardianAddress')?.value || '').trim();

    if (!firstName || !lastName || !relationship || !phone || !address) {
        showImportAlert('Please fill in First Name, Last Name, Relationship, Phone, and Address.', 'warning');
        return;
    }
    if (!['mother', 'father', 'legal_guardian', 'other'].includes(relationship)) {
        showImportAlert('Relationship must be Mother, Father, Legal Guardian, or Other.', 'warning');
        return;
    }
    if (!studentUuid) {
        showImportAlert('Could not identify the student record. Please refresh and try again.', 'danger');
        return;
    }

    try {
        if (overlay) overlay.classList.add('active');
        if (submitBtn) submitBtn.disabled = true;

        await upsertAndLinkGuardian(studentUuid, {
            first_name: firstName,
            middle_name: middleName,
            last_name: lastName,
            relationship,
            phone_number: phone,
            alternate_phone_number: altPhone,
            email,
            address,
        }, true);

        showImportAlert(`Guardian linked successfully for ${lrn}.`, 'success');
        addGuardianModal?.hide();
        await loadAllStudentsTable();
    } catch (error) {
        console.error('Failed to add guardian:', error);
        showImportAlert(`Failed to add guardian: ${error.message}`, 'danger');
    } finally {
        if (overlay) overlay.classList.remove('active');
        if (submitBtn) submitBtn.disabled = false;
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
    setSingleStudentLoading(false); // ensure a clean state
    const syDisplay = document.getElementById('singleActiveSchoolYear');
    if (syDisplay) {
        syDisplay.value = activeSchoolYear && activeSchoolYear.name ? activeSchoolYear.name : 'No Active School Year';
    }
    const deptSelect = document.getElementById('singleDepartment');
    if (deptSelect && selectedDepartmentId) {
        deptSelect.value = selectedDepartmentId;
    }
    
    // Reset student form fields
    document.getElementById('singleStudentId').value = '';
    document.getElementById('singleFirstName').value = '';
    document.getElementById('singleMiddleName').value = '';
    document.getElementById('singleLastName').value = '';
    document.getElementById('singleSuffix').value = '';
    document.getElementById('singleYearLevel').value = '';
    document.getElementById('singleSection').value = '';
    document.getElementById('singleEmail').value = '';
    document.getElementById('singleAddress').value = '';
    
    // Reset form steps to student step
    const studentStep = document.getElementById('studentFormStep');
    const guardianStep = document.getElementById('guardianFormStep');
    const studentFooter = document.getElementById('studentFormFooter');
    const guardianFooter = document.getElementById('guardianFormFooter');
    if (studentStep) studentStep.style.display = 'block';
    if (guardianStep) guardianStep.style.display = 'none';
    if (studentFooter) studentFooter.style.display = 'flex';
    if (guardianFooter) guardianFooter.style.display = 'none';
    
    // Reset guardian forms
    clearGuardian1Form();
    clearGuardian2Form();
    const guardian2Section = document.getElementById('guardian2Section');
    const addGuardian2Container = document.getElementById('addGuardian2ButtonContainer');
    if (guardian2Section) guardian2Section.style.display = 'none';
    if (addGuardian2Container) addGuardian2Container.style.display = 'block';
    
    singleStudentModal.show();
}

function setSingleStudentLoading(isLoading, text) {
    const overlay = document.getElementById('singleStudentLoadingOverlay');
    const loadingText = document.getElementById('singleStudentLoadingText');
    const form = document.getElementById('singleStudentForm');

    if (overlay) overlay.classList.toggle('active', isLoading);
    if (loadingText && text) loadingText.textContent = text;
    if (form) {
        form.querySelectorAll('input, select, button').forEach(el => { el.disabled = isLoading; });
    }
}

function showEmailStatusToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `email-status-toast ${type}`;
    const icon = type === 'success'
        ? '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    toast.innerHTML = `
        ${icon}
        <span class="email-status-toast-text">${escapeHtml(message)}</span>
        <button type="button" class="email-status-toast-close" aria-label="Dismiss">&times;</button>
    `;
    document.body.appendChild(toast);
    toast.querySelector('.email-status-toast-close')?.addEventListener('click', () => toast.remove());
    setTimeout(() => toast.remove(), 8000);
}

// ====== FORM STEP NAVIGATION ======
function proceedToGuardianStep(e) {
    e?.preventDefault?.();

    // Validate student form
    const sectionId = document.getElementById('singleDepartment')?.value || '';
    const studentId = String(document.getElementById('singleStudentId')?.value || '').replace(/\D/g, '').trim();
    const firstName = String(document.getElementById('singleFirstName')?.value || '').trim();
    const lastName = String(document.getElementById('singleLastName')?.value || '').trim();
    const birthDate = String(document.getElementById('singleYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('singleSection')?.value || '').trim().toLowerCase();
    const email = String(document.getElementById('singleEmail')?.value || '').trim();

    if (!sectionId || !studentId || !firstName || !lastName) {
        showImportAlert('Please fill in Section, LRN, First Name, and Last Name.', 'warning');
        return;
    }
    if (!/^\d{12}$/.test(studentId)) {
        showImportAlert('LRN must be exactly 12 digits.', 'warning');
        return;
    }
    if (!email) {
        showImportAlert('Email is required for QR code notification.', 'warning');
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

    // All validations passed, move to guardian step
    const studentStep = document.getElementById('studentFormStep');
    const guardianStep = document.getElementById('guardianFormStep');
    const studentFooter = document.getElementById('studentFormFooter');
    const guardianFooter = document.getElementById('guardianFormFooter');

    studentStep.style.display = 'none';
    guardianStep.style.display = 'block';
    studentFooter.style.display = 'none';
    guardianFooter.style.display = 'flex';

    // Set up "same as student" checkbox listeners
    setupSameAsStudentCheckboxes();
}

function goBackToStudentStep(e) {
    e?.preventDefault?.();

    const studentStep = document.getElementById('studentFormStep');
    const guardianStep = document.getElementById('guardianFormStep');
    const studentFooter = document.getElementById('studentFormFooter');
    const guardianFooter = document.getElementById('guardianFormFooter');

    studentStep.style.display = 'block';
    guardianStep.style.display = 'none';
    studentFooter.style.display = 'flex';
    guardianFooter.style.display = 'none';
}

// ====== SAME AS STUDENT CHECKBOX ======
function setupSameAsStudentCheckboxes() {
    const studentAddress = document.getElementById('singleAddress');
    const guardian1Checkbox = document.getElementById('guardian1SameAsStudent');
    const guardian1Address = document.getElementById('guardian1Address');
    const guardian2Checkbox = document.getElementById('guardian2SameAsStudent');
    const guardian2Address = document.getElementById('guardian2Address');

    if (!guardian1Checkbox || !guardian1Address) return;

    // Handle Guardian 1 checkbox
    guardian1Checkbox.addEventListener('change', () => {
        if (guardian1Checkbox.checked) {
            const address = studentAddress?.value || '';
            if (address) {
                guardian1Address.value = address;
            } else {
                guardian1Checkbox.checked = false;
                showImportAlert('Student address is empty. Please go back and fill in the student address.', 'warning');
            }
        } else {
            guardian1Address.value = '';
        }
    });

    // Handle Guardian 2 checkbox if visible
    if (guardian2Checkbox && guardian2Address) {
        guardian2Checkbox.addEventListener('change', () => {
            if (guardian2Checkbox.checked) {
                const address = studentAddress?.value || '';
                if (address) {
                    guardian2Address.value = address;
                } else {
                    guardian2Checkbox.checked = false;
                    showImportAlert('Student address is empty. Please go back and fill in the student address.', 'warning');
                }
            } else {
                guardian2Address.value = '';
            }
        });
    }

    // Update guardian addresses when student address changes (if checkbox is checked)
    if (studentAddress) {
        studentAddress.addEventListener('change', () => {
            if (guardian1Checkbox.checked) {
                guardian1Address.value = studentAddress.value;
            }
            if (guardian2Checkbox && guardian2Checkbox.checked) {
                guardian2Address.value = studentAddress.value;
            }
        });
    }
}

// ====== GUARDIAN MANAGEMENT FUNCTIONS ======
function showGuardian2Form(e) {
    e?.preventDefault?.();
    
    const guardian2Section = document.getElementById('guardian2Section');
    const addGuardian2Container = document.getElementById('addGuardian2ButtonContainer');
    
    if (guardian2Section) {
        guardian2Section.style.display = 'block';
        guardian2Section.style.animation = 'slideInUp 0.3s ease-out';
    }
    if (addGuardian2Container) {
        addGuardian2Container.style.display = 'none';
    }
}

function clearGuardian1Form() {
    document.getElementById('guardian1Phone').value = '';
    document.getElementById('guardian1Relationship').value = '';
    document.getElementById('guardian1FirstName').value = '';
    document.getElementById('guardian1LastName').value = '';
    document.getElementById('guardian1MiddleName').value = '';
    document.getElementById('guardian1AltPhone').value = '';
    document.getElementById('guardian1Email').value = '';
    document.getElementById('guardian1Address').value = '';
    const checkbox1 = document.getElementById('guardian1SameAsStudent');
    if (checkbox1) checkbox1.checked = false;
    const statusEl = document.getElementById('guardian1LookupStatus');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
}

function clearGuardian2Form() {
    document.getElementById('guardian2Phone').value = '';
    document.getElementById('guardian2Relationship').value = '';
    document.getElementById('guardian2FirstName').value = '';
    document.getElementById('guardian2LastName').value = '';
    document.getElementById('guardian2MiddleName').value = '';
    document.getElementById('guardian2AltPhone').value = '';
    document.getElementById('guardian2Email').value = '';
    document.getElementById('guardian2Address').value = '';
    const checkbox2 = document.getElementById('guardian2SameAsStudent');
    if (checkbox2) checkbox2.checked = false;
    const statusEl = document.getElementById('guardian2LookupStatus');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
    
    // Hide guardian 2 section
    const guardian2Section = document.getElementById('guardian2Section');
    const addGuardian2Container = document.getElementById('addGuardian2ButtonContainer');
    if (guardian2Section) guardian2Section.style.display = 'none';
    if (addGuardian2Container) addGuardian2Container.style.display = 'block';
}

function getGuardianDataFromForm(guardianNum) {
    const prefix = `guardian${guardianNum}`;
    return {
        phone_number: String(document.getElementById(`${prefix}Phone`)?.value || '').trim(),
        relationship: String(document.getElementById(`${prefix}Relationship`)?.value || '').trim(),
        first_name: String(document.getElementById(`${prefix}FirstName`)?.value || '').trim(),
        last_name: String(document.getElementById(`${prefix}LastName`)?.value || '').trim(),
        middle_name: String(document.getElementById(`${prefix}MiddleName`)?.value || '').trim() || null,
        alternate_phone_number: String(document.getElementById(`${prefix}AltPhone`)?.value || '').trim() || null,
        email: String(document.getElementById(`${prefix}Email`)?.value || '').trim() || null,
        address: String(document.getElementById(`${prefix}Address`)?.value || '').trim() || null,
    };
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
    const email = String(document.getElementById('singleEmail')?.value || '').trim();

    if (!activeSchoolYear || !activeSchoolYear.id) {
        showImportAlert('No active school year found. Please set one in System Settings first.', 'danger');
        return;
    }
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

    // Get guardian data from forms
    const guardian1Data = getGuardianDataFromForm(1);
    const guardian2Data = getGuardianDataFromForm(2);
    const guardian2Visible = document.getElementById('guardian2Section')?.style.display !== 'none';

    // Validate guardian 1
    if (!guardian1Data.phone_number || !guardian1Data.relationship || !guardian1Data.first_name || !guardian1Data.last_name || !guardian1Data.address) {
        showImportAlert('Please fill in all required Guardian 1 fields (Phone, Relationship, First Name, Last Name, Address).', 'warning');
        return;
    }

    // Guardian 2 is optional but if some fields are filled, validate all required fields
    if (guardian2Visible) {
        const guardian2HasData = guardian2Data.phone_number || guardian2Data.relationship || guardian2Data.first_name || guardian2Data.last_name || guardian2Data.address;
        if (guardian2HasData) {
            if (!guardian2Data.phone_number || !guardian2Data.relationship || !guardian2Data.first_name || !guardian2Data.last_name || !guardian2Data.address) {
                showImportAlert('Please fill in all required Guardian 2 fields or leave them all empty.', 'warning');
                return;
            }
            // Check duplicate phones
            if (guardian1Data.phone_number === guardian2Data.phone_number) {
                showImportAlert('Guardian 1 and Guardian 2 cannot have the same phone number.', 'warning');
                return;
            }
        }
    }

    try {
        setSingleStudentLoading(true, 'Saving student...');

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

        const studentUuid = crypto.randomUUID();
        const payload = {
            student_id: studentUuid,
            lrn: studentId,
            first_name: firstName,
            middle_name: middleName || null,
            last_name: lastName,
            suffix: suffix || null,
            birth_date: birthDate || null,
            gender: gender || null,
            section_id: sectionId,
            school_year_id: activeSchoolYear.id,
            status: 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        const { error: insertError } = await supabaseClient.from('students').insert(payload);
        if (insertError) throw insertError;

        // Link guardian 1 (primary)
        setSingleStudentLoading(true, 'Linking guardians...');
        let guardiansAdded = 0;
        try {
            await upsertAndLinkGuardian(studentUuid, guardian1Data, true);
            guardiansAdded = 1;
        } catch (guardianErr) {
            console.error('Guardian 1 link failed:', guardianErr);
            showImportAlert(`Student saved, but Guardian 1 could not be linked: ${guardianErr.message}.`, 'warning');
        }

        // Link guardian 2 (if filled)
        if (guardian2Visible && guardian2Data.phone_number && guardian2Data.relationship && guardian2Data.first_name && guardian2Data.last_name) {
            try {
                await upsertAndLinkGuardian(studentUuid, guardian2Data, false);
                guardiansAdded = 2;
            } catch (guardianErr) {
                console.error('Guardian 2 link failed:', guardianErr);
                showImportAlert(`Student and Guardian 1 saved, but Guardian 2 could not be linked: ${guardianErr.message}.`, 'warning');
            }
        }

        showImportAlert(`Student ${firstName} ${lastName} (${studentId}) added successfully with ${guardiansAdded} guardian(s).`, 'success');
        document.getElementById('singleStudentForm')?.reset();
        clearGuardian1Form();
        clearGuardian2Form();
        setSingleStudentLoading(false);
        singleStudentModal?.hide();
        await loadAllStudentsTable();

        if (email) {
            const sectionLabel = departmentsCache.find(s => String(s.section_id) === String(sectionId))
                ? `${departmentsCache.find(s => String(s.section_id) === String(sectionId)).grade_level} - ${departmentsCache.find(s => String(s.section_id) === String(sectionId)).section_name}`
                : '';

            sendStudentQrEmail({
                studentId, firstName, middleName, lastName, suffix, birthDate, gender, sectionLabel, email,
            }).then((emailResult) => {
                if (emailResult.sent) {
                    showEmailStatusToast(`QR code emailed to ${email} for ${firstName} ${lastName}.`, 'success');
                } else {
                    showEmailStatusToast(`Student saved, but QR email wasn't sent (${emailResult.message}).`, 'warning');
                }
            });
        }

    } catch (err) {
        console.error('Single student registration failed:', err?.message || err, {
            code: err?.code, details: err?.details, hint: err?.hint, full: err
        });
        showImportAlert(`Failed to save student: ${err?.message || 'Unknown error. Check console for details.'}`, 'danger');
    } finally {
        setSingleStudentLoading(false);
        if (submitBtn) submitBtn.disabled = false;
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
        lrn: String(student.studentId || '').trim(),
        firstName: String(student.firstName || '').trim(),
        middleName: String(student.middleName || '').trim(),
        lastName: String(student.lastName || '').trim(),
        sectionInfo: String(student.sectionLabel || '').trim(),
        birthDate: String(student.birthDate ?? '').trim(),
        gender: String(student.gender || '').trim(),
        qrPayload: getStudentQrPayload(student),
    };

    if (!payload.lrn) {
        return { sent: false, message: 'missing LRN' };
    }

  if (!payload.lrn) {
        return { sent: false, message: 'missing LRN' };
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
        'Email',
        'School Year'
    ];

    const schoolYearSample = (activeSchoolYear && activeSchoolYear.name)
        ? activeSchoolYear.name
        : '2024-2025';

    const sampleRow = [
        '123456789012',
        'Dela Cruz',
        'Juan',
        'Santos',
        '',
        '2012-06-14',
        'male',
        'delacruz_juan@plpasig.edu.ph',
        schoolYearSample
    ];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
        XLSX.utils.book_append_sheet(wb, ws, 'Students');
        XLSX.writeFile(wb, 'student-import-template.xlsx');
        return;
    }

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