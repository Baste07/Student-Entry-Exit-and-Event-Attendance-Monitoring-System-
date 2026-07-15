let parsedRows = [];
let selectedDepartmentId = null;
let selectedDepartmentName = '';
let departmentsCache = [];
let singleStudentModal = null;
let duplicateRowsModal = null;
let editStudentModal = null;
let viewGuardiansModal = null;
let addGuardianModal = null;
let duplicateRowsInFileCount = 0;
let duplicateRowsInDatabaseCount = 0;
let duplicateRowsInFile = [];
let duplicateRowsInDatabase = [];
let allStudents = [];
let activeSchoolYear = null;
const QR_EMAIL_ENDPOINT = 'send-student-qr-email.php';
const EMAIL_LIKE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// STUDENT ID format: K-#### or 1-#### through 10-####
const STUD_ID_PATTERN = /^([Kk]|[1-9]|10)-\d{1,4}$/;

document.addEventListener('DOMContentLoaded', async () => {
    checkSupabaseConnection();
    await loadDepartments();
    setupEventListeners();
    await loadAllStudentsTable();

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

        const { data: fetchedSY, error: schoolYearError } = await supabaseClient
            .from('school_years')
            .select('id, name')
            .eq('is_active', true)
            .maybeSingle();

        activeSchoolYear = fetchedSY;
        const syDisplay = document.getElementById('activeSchoolYearDisplay');

        if (schoolYearError || !activeSchoolYear) {
            console.warn('No active school year found:', schoolYearError);
            showAlert('No active school year set. Please set one in System Settings before importing.', 'warning');

            if (syDisplay) syDisplay.value = 'No Active School Year';
            document.getElementById('departmentSelect').innerHTML = '<option value="" disabled selected>No Active School Year</option>';
            const gradeSelect = document.getElementById('gradeLevelSelect');
            if (gradeSelect) gradeSelect.innerHTML = '<option value="" disabled selected>No Active School Year</option>';
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

        populateGradeLevelSelects();

        const deptSelect = document.getElementById('departmentSelect');
        if (deptSelect) {
            deptSelect.innerHTML = '<option value="" disabled selected>Select grade level first...</option>';
            deptSelect.disabled = true;
        }

        const singleDeptSelect = document.getElementById('singleDepartment');
        if (singleDeptSelect) {
            singleDeptSelect.innerHTML = '<option value="" disabled selected>Select grade level first...</option>';
            singleDeptSelect.disabled = true;
        }

        checkReadyToParse();

    } catch (error) {
        console.error('Error loading sections:', error);
        showAlert('Error loading sections: ' + error.message, 'danger');
    }
}

async function generateNextStudId(gradeLevel) {
    const prefix = gradeLevel === 'Kinder' ? 'K' : gradeLevel.replace('Grade ', '');

    const { data, error } = await supabaseClient
        .from('students')
        .select('stud_id')
        .ilike('stud_id', `${prefix}-%`)
        .order('stud_id', { ascending: false })
        .limit(1);

    if (error) throw error;

    let nextNum = 1;
    if (data && data.length > 0) {
        const lastId = data[0].stud_id;
        const lastNum = parseInt(lastId.split('-')[1], 10);
        if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }

    return `${prefix}-${String(nextNum).padStart(4, '0')}`;
}
function setupEventListeners() {
    const addGuardianModalElement = document.getElementById('addGuardianModal');
    if (addGuardianModalElement && window.bootstrap) {
        addGuardianModal = new bootstrap.Modal(addGuardianModalElement);
    }

    document.getElementById('addGuardianForm')?.addEventListener('submit', submitAddGuardianForm);
    document.getElementById('modalGuardianPhone')?.addEventListener('blur', handleModalGuardianPhoneLookup);

    const guardianPhoneInput = document.getElementById('singleGuardianPhone');
    guardianPhoneInput?.addEventListener('blur', handleGuardianPhoneLookup);

    const dropZone = document.getElementById('fileDropZone');
    const fileInput = document.getElementById('fileInput');
    const removeBtn = document.getElementById('fileRemoveBtn');
    const parseBtn = document.getElementById('parseFileBtn');
    const backUpload = document.getElementById('backToUploadBtn');
    const proceedBtn = document.getElementById('proceedImportBtn');
    const anotherBtn = document.getElementById('importAnotherBtn');
    const deptSelect = document.getElementById('departmentSelect');
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
        if (modalElement) singleStudentModal = new bootstrap.Modal(modalElement);

        const duplicateModalElement = document.getElementById('duplicateRowsModal');
        if (duplicateModalElement) duplicateRowsModal = new bootstrap.Modal(duplicateModalElement);

        const editModalElement = document.getElementById('editStudentModal');
        if (editModalElement) editStudentModal = new bootstrap.Modal(editModalElement);

        const viewGuardiansModalElement = document.getElementById('viewGuardiansModal');
        if (viewGuardiansModalElement) viewGuardiansModal = new bootstrap.Modal(viewGuardiansModalElement);
    }

    downloadBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        downloadStudentTemplate();
    });

    const gradeLevelSelect = document.getElementById('gradeLevelSelect');
    gradeLevelSelect?.addEventListener('change', () => {
        const gradeLevel = gradeLevelSelect.value;
        filterSectionsByGradeLevel(gradeLevel, 'departmentSelect');
        selectedDepartmentId = null;
        selectedDepartmentName = '';
        checkReadyToParse();
    });

    // ── FIX: Listen for section selection to enable Parse & Preview ──
    deptSelect?.addEventListener('change', () => {
        selectedDepartmentId = deptSelect.value;
        const selectedOption = deptSelect.options[deptSelect.selectedIndex];
        selectedDepartmentName = selectedOption ? selectedOption.text : '';
        checkReadyToParse();
    });

    const singleGradeLevel = document.getElementById('singleGradeLevel');
    singleGradeLevel?.addEventListener('change', () => {
        const gradeLevel = singleGradeLevel.value;
        filterSectionsByGradeLevel(gradeLevel, 'singleDepartment');
        updateSingleStudentId();
    });

    dropZone.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        fileInput.click();
    });

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

        try {
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                setTimeout(() => {
                    handleFileSelected(files[0]);
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

    const addGuardian2Btn = document.getElementById('addGuardian2Btn');
    addGuardian2Btn?.addEventListener('click', showGuardian2Form);

    const nextToGuardianBtn = document.getElementById('nextToGuardianBtn');
    const backToStudentBtn = document.getElementById('backToStudentBtn');
    nextToGuardianBtn?.addEventListener('click', proceedToGuardianStep);
    backToStudentBtn?.addEventListener('click', goBackToStudentStep);

    const singleIdInput = document.getElementById('singleStudentId');

    const singleGenderInput = document.getElementById('singleSection');
    singleGenderInput?.addEventListener('change', (e) => {
        e.target.value = String(e.target.value || '').trim().toLowerCase();
    });

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
                studId: String(r[0] || '').trim().toUpperCase(),
                lastName: String(r[1] || '').trim(),
                firstName: String(r[2] || '').trim(),
                middleName: String(r[3] || '').trim(),
                suffix: String(r[4] || '').trim(),
                birthDate: String(r[5] || '').trim(),
                gender: String(r[6] || '').trim(),
                email: String(r[7] || '').trim(),
                // Guardian 1
                g1Phone: String(r[9] || '').trim(),
                g1Relationship: String(r[10] || '').trim().toLowerCase(),
                g1FirstName: String(r[11] || '').trim(),
                g1LastName: String(r[12] || '').trim(),
                g1MiddleName: String(r[13] || '').trim(),
                g1AltPhone: String(r[14] || '').trim(),
                g1Email: String(r[15] || '').trim(),
                g1Address: String(r[16] || '').trim(),
                // Guardian 2
                g2Phone: String(r[17] || '').trim(),
                g2Relationship: String(r[18] || '').trim().toLowerCase(),
                g2FirstName: String(r[19] || '').trim(),
                g2LastName: String(r[20] || '').trim(),
                g2MiddleName: String(r[21] || '').trim(),
                g2AltPhone: String(r[22] || '').trim(),
                g2Email: String(r[23] || '').trim(),
                g2Address: String(r[24] || '').trim(),
            }));
        }

        rows = rows.filter(r => r.studId || r.firstName || r.lastName);

        if (rows.length === 0) {
            showImportAlert('No data rows found. Make sure you have data below the header row.', 'warning');
            return;
        }

        parsedRows = rows.map((r, i) => validateRow(r, i));

        duplicateRowsInFileCount = removeDuplicateStudIdsFromParsedRows();
        duplicateRowsInDatabaseCount = await removeExistingStudIdsFromParsedRows();

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
            studId: (cols[0] || '').toUpperCase(),
            lastName: cols[1] || '',
            firstName: cols[2] || '',
            middleName: cols[3] || '',
            suffix: cols[4] || '',
            birthDate: cols[5] || '',
            gender: cols[6] || '',
            email: cols[7] || '',
            g1Phone: cols[9] || '',
            g1Relationship: (cols[10] || '').toLowerCase(),
            g1FirstName: cols[11] || '',
            g1LastName: cols[12] || '',
            g1MiddleName: cols[13] || '',
            g1AltPhone: cols[14] || '',
            g1Email: cols[15] || '',
            g1Address: cols[16] || '',
            g2Phone: cols[17] || '',
            g2Relationship: (cols[18] || '').toLowerCase(),
            g2FirstName: cols[19] || '',
            g2LastName: cols[20] || '',
            g2MiddleName: cols[21] || '',
            g2AltPhone: cols[22] || '',
            g2Email: cols[23] || '',
            g2Address: cols[24] || '',
        };
    });
}

function validateRow(row, index) {
    const errors = [];
    const warnings = [];
    const rawId = String(row.studId || '').trim().toUpperCase();

    if (!rawId) {
        errors.push('Student ID is required');
    } else if (!STUD_ID_PATTERN.test(rawId)) {
        errors.push('Student ID format: K-####, 1-####, ..., 10-####');
    }

    if (!row.firstName) errors.push('First Name is required');
    if (!row.lastName) errors.push('Last Name is required');

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

    // ── Guardian 1 validation (REQUIRED) ──
    const hasG1 = row.g1Phone || row.g1FirstName || row.g1LastName || row.g1Relationship;
    if (!hasG1) {
        errors.push('At least 1 guardian is required (Guardian 1 fields)');
    } else {
        if (!row.g1Phone) errors.push('Guardian 1 Phone is required');
        if (!row.g1FirstName) errors.push('Guardian 1 First Name is required');
        if (!row.g1LastName) errors.push('Guardian 1 Last Name is required');
        if (!row.g1Relationship) errors.push('Guardian 1 Relationship is required');
        if (row.g1Relationship && !['mother', 'father', 'legal_guardian', 'other'].includes(row.g1Relationship)) {
            errors.push('Guardian 1 Relationship must be mother, father, legal_guardian, or other');
        }
        if (!row.g1Address) warnings.push('Guardian 1 Address is recommended');
    }

    // ── Guardian 2 validation (optional) ──
    const hasG2 = row.g2Phone || row.g2FirstName || row.g2LastName || row.g2Relationship;
    if (hasG2) {
        if (!row.g2Phone) errors.push('Guardian 2 Phone is required');
        if (!row.g2FirstName) errors.push('Guardian 2 First Name is required');
        if (!row.g2LastName) errors.push('Guardian 2 Last Name is required');
        if (!row.g2Relationship) errors.push('Guardian 2 Relationship is required');
        if (row.g2Relationship && !['mother', 'father', 'legal_guardian', 'other'].includes(row.g2Relationship)) {
            errors.push('Guardian 2 Relationship must be mother, father, legal_guardian, or other');
        }
    }

    const status = errors.length > 0 ? 'error'
        : warnings.length > 0 ? 'warning'
            : 'ok';

    return {
        ...row,
        studId: rawId,
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
    const valid = parsedRows.filter(r => r.status !== 'error').length;
    const warnings = parsedRows.filter(r => r.status === 'warning').length;
    const errors = parsedRows.filter(r => r.status === 'error').length;
    const duplicated = duplicateRowsInFileCount + duplicateRowsInDatabaseCount;

    document.getElementById('validCount').textContent = valid;
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
    document.getElementById('errorCount').textContent = errors;
    document.getElementById('totalCount').textContent = parsedRows.length;
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
                <td colspan="12" style="text-align:center;padding:1.5rem;color:var(--text-muted);">
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
        const warnNote = row.warnings.length > 0
            ? `<div style="font-size:0.75rem;color:#92400e;margin-top:0.15rem;">${row.warnings.join(', ')}</div>` : '';

        const cell = (val) => val
            ? `<td>${escapeHtml(val)}</td>`
            : `<td class="cell-empty">—</td>`;

        const guardianCount = (row.g1Phone ? 1 : 0) + (row.g2Phone ? 1 : 0);
        const guardianCell = guardianCount > 0
            ? `<span style="font-size:0.75rem;color:#059669;font-weight:500;">${guardianCount} Guardian${guardianCount > 1 ? 's' : ''}</span>`
            : `<span style="font-size:0.75rem;color:var(--text-muted);">—</span>`;

        return `
            <tr class="${rowClass}">
                <td style="color:var(--text-muted);font-size:0.8rem;">${row.rowIndex}</td>
                <td><strong>${escapeHtml(row.studId)}</strong>${errorNote}</td>
                ${cell(row.lastName)}
                ${cell(row.firstName)}
                ${cell(row.middleName)}
                ${cell(row.suffix)}
                ${cell(row.birthDate)}
                ${cell(row.gender)}
                ${cell(row.section)}
                <td style="font-size:0.82rem;">${escapeHtml(row.email)}${warnNote}</td>
                <td style="text-align:center;">${guardianCell}</td>
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

    if (!activeSchoolYear || !activeSchoolYear.id) {
        showImportAlert('No active school year found. Please set one in System Settings first.', 'danger');
        return;
    }

    showStep('import');
    const log = document.getElementById('importLog');
    const fill = document.getElementById('progressBarFill');
    const text = document.getElementById('progressText');
    const pct = document.getElementById('progressPct');
    log.innerHTML = '';

    let success = 0;
    let failed = 0;
    const total = validRows.length;

    addLog(log, 'info', `Starting import of ${total} student(s) into ${selectedDepartmentName}...`);

    const studIds = validRows.map(r => r.studId);
    const { data: existing } = await supabaseClient
        .from('students')
        .select('stud_id, student_id')
        .in('stud_id', studIds);

    const existingIds = new Set((existing || []).map(e => e.stud_id));
    const existingStudentMap = new Map((existing || []).map(e => [e.stud_id, e.student_id]));

    for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];
        const isUpdate = existingIds.has(row.studId);
        let studentUuid;

        try {
            const studentData = {
                stud_id: row.studId,
                first_name: row.firstName,
                middle_name: row.middleName || null,
                last_name: row.lastName,
                suffix: row.suffix || null,
                birth_date: row.birthDate || null,
                gender: row.gender || null,
                section_id: selectedDepartmentId,
                school_year_id: activeSchoolYear.id,
                email: row.email || null,
                status: 'active',
                updated_at: new Date().toISOString(),
            };

            let error;

            if (isUpdate) {
                const res = await supabaseClient
                    .from('students')
                    .update(studentData)
                    .eq('stud_id', row.studId);
                error = res.error;
                studentUuid = existingStudentMap.get(row.studId);
            } else {
                studentUuid = crypto.randomUUID();
                studentData.student_id = studentUuid;
                studentData.created_at = new Date().toISOString();
                const res = await supabaseClient
                    .from('students')
                    .insert(studentData);
                error = res.error;
            }

            if (error) throw error;

            success++;
            const label = isUpdate ? 'Updated' : 'Imported';
            addLog(log, 'ok', `[Row ${row.rowIndex}] ${label}: ${row.firstName} ${row.lastName} (${row.studId})`);

            // ── Link Guardian 1 (Primary) ──
            if (studentUuid && row.g1Phone && row.g1FirstName && row.g1LastName && row.g1Relationship) {
                try {
                    await upsertAndLinkGuardian(studentUuid, {
                        first_name: row.g1FirstName,
                        middle_name: row.g1MiddleName || null,
                        last_name: row.g1LastName,
                        relationship: row.g1Relationship,
                        phone_number: row.g1Phone,
                        alternate_phone_number: row.g1AltPhone || null,
                        email: row.g1Email || null,
                        address: row.g1Address || null,
                    }, true);
                    addLog(log, 'ok', `[Row ${row.rowIndex}] Linked Guardian 1: ${row.g1FirstName} ${row.g1LastName}`);
                } catch (gErr) {
                    addLog(log, 'warning', `[Row ${row.rowIndex}] Failed to link Guardian 1: ${gErr.message}`);
                }
            }

            // ── Link Guardian 2 ──
            if (studentUuid && row.g2Phone && row.g2FirstName && row.g2LastName && row.g2Relationship) {
                try {
                    await upsertAndLinkGuardian(studentUuid, {
                        first_name: row.g2FirstName,
                        middle_name: row.g2MiddleName || null,
                        last_name: row.g2LastName,
                        relationship: row.g2Relationship,
                        phone_number: row.g2Phone,
                        alternate_phone_number: row.g2AltPhone || null,
                        email: row.g2Email || null,
                        address: row.g2Address || null,
                    }, false);
                    addLog(log, 'ok', `[Row ${row.rowIndex}] Linked Guardian 2: ${row.g2FirstName} ${row.g2LastName}`);
                } catch (gErr) {
                    addLog(log, 'warning', `[Row ${row.rowIndex}] Failed to link Guardian 2: ${gErr.message}`);
                }
            }

            const emailResult = await sendStudentQrEmail({
                studId: row.studId,
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
        pct.textContent = progress + '%';
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

function renderStudentsSkeleton() {
    const tbody = document.getElementById('allStudentsTableBody');
    if (!tbody) return;

    tbody.innerHTML = Array.from({ length: 5 }, () => `
        <tr class="skeleton-row">
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
        </tr>
    `).join('');
}

async function loadAllStudentsTable() {
    renderStudentsSkeleton();

    const tbody = document.getElementById('allStudentsTableBody');
    const countEl = document.getElementById('allStudentsCount');
    if (!tbody || !countEl || !supabaseClient) return;

    try {
        const { data, error } = await supabaseClient
            .from('students')
            .select(`
                student_id, stud_id, first_name, middle_name, last_name, suffix, birth_date, gender, section_id, status,
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
            || String(student.stud_id || '').toLowerCase().includes(search);
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
        const rawStatus = student.status || 'inactive';
        const normalizedStatus = String(rawStatus).trim().toLowerCase();
        const statusLabel = normalizedStatus === 'active' ? 'Active' : normalizedStatus === 'suspended' ? 'Suspended' : 'Inactive';
        const statusClass = normalizedStatus === 'active' ? 'badge-active' : normalizedStatus === 'suspended' ? 'badge-suspended' : 'badge-inactive';

        const guardianLinks = student.student_guardians || [];
        let guardianCell = '';
        if (guardianLinks.length === 0) {
            guardianCell = `<button type="button" class="status-badge warning" style="border:none;cursor:pointer;" data-action="addGuardian" data-id="${escapeHtml(student.stud_id || '')}">
                 Not Added — Add
               </button>`;
        } else if (guardianLinks.length === 1) {
            const guardian = guardianLinks[0].guardians;
            guardianCell = `<button type="button" class="status-badge valid" style="border:none;cursor:pointer;" data-action="viewGuardians" data-student-id="${escapeHtml(student.student_id || '')}" data-student-name="${escapeHtml((student.first_name || '') + ' ' + (student.last_name || ''))}" data-student-stud-id="${escapeHtml(student.stud_id || '')}" title="${escapeHtml(guardian.relationship || '')}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;margin-right:0.3rem;vertical-align:middle;">
                    <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
                </svg>
                ${escapeHtml(guardian.first_name + ' ' + guardian.last_name)}
               </button>`;
        } else {
            guardianCell = `<button type="button" class="status-badge valid" style="border:none;cursor:pointer;" data-action="viewGuardians" data-student-id="${escapeHtml(student.student_id || '')}" data-student-name="${escapeHtml((student.first_name || '') + ' ' + (student.last_name || ''))}" data-student-stud-id="${escapeHtml(student.stud_id || '')}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;margin-right:0.3rem;vertical-align:middle;">
                    <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
                </svg>
                ${guardianLinks.length} Guardian${guardianLinks.length > 1 ? 's' : ''}
               </button>`;
        }

        return `
            <tr>
                <td><strong>${escapeHtml(student.stud_id || 'N/A')}</strong></td>
                <td>${escapeHtml(fullName || 'N/A')}</td>
                <td>${escapeHtml(gradeLevel)}</td>
                <td>${escapeHtml(sectionName)}</td>
                <td>${escapeHtml(student.birth_date || '—')}</td>
                <td>${escapeHtml(student.gender || '—')}</td>
                <td>${guardianCell}</td>
                <td><span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon" title="Edit" data-action="edit" data-id="${escapeHtml(student.stud_id || '')}">
                            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn-icon danger" title="Delete" data-action="delete" data-id="${escapeHtml(student.stud_id || '')}">
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

    if (action === 'viewGuardians') {
        const studentUuid = actionBtn.dataset.studentId;
        const studentName = actionBtn.dataset.studentName;
        const studentStudId = actionBtn.dataset.studentStudId;
        openViewGuardiansModal(studentUuid, studentName, studentStudId);
        return;
    }

    const studId = actionBtn.dataset.id;
    if (!studId) return;

    if (action === 'edit') {
        openEditStudentModal(studId);
        return;
    }
    if (action === 'delete') {
        deleteStudentRow(studId);
        return;
    }
    if (action === 'addGuardian') {
        const student = allStudents.find(s => String(s.stud_id) === String(studId));
        const displayName = student
            ? [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ')
            : studId;
        openAddGuardianModal(student?.student_id, displayName, studId);
    }
}

function openViewGuardiansModal(studentUuid, studentName, studentStudId) {
    if (!viewGuardiansModal) {
        showImportAlert('View Guardians modal is not available right now.', 'danger');
        return;
    }

    document.getElementById('viewGuardiansStudentName').textContent = studentName || '—';
    document.getElementById('viewGuardiansStudentId').textContent = studentStudId || '—';

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
                            ${isPrimary ? '<span style="display: inline-block; background: #176aa4; color: white; padding: 0.25rem 0.75rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600;">Primary</span>' : ''}
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

    const addGuardianBtn = document.getElementById('addGuardianFromViewBtn');
    if (addGuardianBtn) {
        addGuardianBtn.onclick = () => {
            viewGuardiansModal.hide();
            openAddGuardianModal(studentUuid, studentName, studentStudId);
        };
    }

    viewGuardiansModal.show();
}

function openAddGuardianModal(studentUuid, displayName, studId) {
    if (!addGuardianModal) {
        showImportAlert('Add Guardian form is not available right now.', 'danger');
        return;
    }
    document.getElementById('addGuardianForm')?.reset();
    const statusEl = document.getElementById('modalGuardianLookupStatus');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }

    document.getElementById('guardianModalStudentId').value = studentUuid || '';
    document.getElementById('guardianModalStudentId').dataset.studId = studId || '';
    document.getElementById('guardianModalStudentName').textContent = displayName || studId;

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
    const studId = document.getElementById('guardianModalStudentId')?.dataset.studId || '';

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

        showImportAlert(`Guardian linked successfully for ${studId}.`, 'success');
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

function openEditStudentModal(studId) {
    const student = allStudents.find(s => String(s.stud_id) === String(studId));
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
    document.getElementById('editStudentId').value = student.stud_id || '';
    document.getElementById('editDepartment').value = String(student.section_id || '');
    document.getElementById('editFirstName').value = student.first_name || '';
    document.getElementById('editMiddleName').value = student.middle_name || '';
    document.getElementById('editLastName').value = student.last_name || '';
    document.getElementById('editSuffix').value = student.suffix || '';
    document.getElementById('editYearLevel').value = student.birth_date || '';
    document.getElementById('editSection').value = (student.gender || '').toLowerCase();
    document.getElementById('editEmail').value = student.email || '';
    document.getElementById('editStatus').value = student.status || 'inactive';

    editStudentModal.show();
}

async function submitEditStudentForm(event) {
    event.preventDefault();

    const saveBtn = document.getElementById('saveStudentEditBtn');
    const studentUid = String(document.getElementById('editStudentUid')?.value || '').trim();
    const studId = String(document.getElementById('editStudentId')?.value || '').trim();
    const sectionId = String(document.getElementById('editDepartment')?.value || '').trim();
    const firstName = String(document.getElementById('editFirstName')?.value || '').trim();
    const middleName = String(document.getElementById('editMiddleName')?.value || '').trim();
    const lastName = String(document.getElementById('editLastName')?.value || '').trim();
    const suffix = String(document.getElementById('editSuffix')?.value || '').trim();
    const birthDate = String(document.getElementById('editYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('editSection')?.value || '').trim().toLowerCase();
    const email = String(document.getElementById('editEmail')?.value || '').trim();
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
        email: email || null,
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
            query = query.eq('stud_id', studId);
        }

        const { error } = await query;
        if (error) throw error;

        showImportAlert(`Student ${studId} updated successfully.`, 'success');
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

async function deleteStudentRow(studId) {
    const student = allStudents.find(s => String(s.stud_id) === String(studId));
    const displayName = student
        ? (student.last_name ? (student.last_name + ', ' + [student.first_name, student.middle_name, student.suffix].filter(Boolean).join(' ')) : [student.first_name, student.middle_name, student.suffix].filter(Boolean).join(' '))
        : studId;

    if (!confirm(`Delete student ${displayName} (${studId})? This action cannot be undone.`)) {
        return;
    }

    try {
        let query = supabaseClient.from('students').delete();
        if (student?.student_id) {
            query = query.eq('student_id', student.student_id);
        } else {
            query = query.eq('stud_id', studId);
        }

        const { error } = await query;
        if (error) throw error;

        showImportAlert(`Student ${studId} deleted successfully.`, 'success');
        await loadAllStudentsTable();
    } catch (error) {
        console.error('Error deleting student:', error);
        showImportAlert(`Failed to delete student: ${error.message}`, 'danger');
    }
}

function showStep(step) {
    document.getElementById('stepUpload').style.display = step === 'upload' ? '' : 'none';
    document.getElementById('stepPreview').style.display = step === 'preview' ? '' : 'none';
    document.getElementById('stepImport').style.display = step === 'import' ? '' : 'none';
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

function populateGradeLevelSelects() {
    const gradeSelect = document.getElementById('gradeLevelSelect');
    const singleGradeSelect = document.getElementById('singleGradeLevel');

    if (!gradeSelect || !singleGradeSelect) return;

    const uniqueGrades = [...new Set(departmentsCache.map(d => d.grade_level).filter(Boolean))];

    const gradeOrder = ['Kinder', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'];
    const sortedGrades = uniqueGrades.sort((a, b) => gradeOrder.indexOf(a) - gradeOrder.indexOf(b));

    const optionsHtml = sortedGrades.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

    gradeSelect.innerHTML = '<option value="" disabled selected>Select grade level...</option>' + optionsHtml;
    singleGradeSelect.innerHTML = '<option value="" disabled selected>Select grade level...</option>' + optionsHtml;
}

function filterSectionsByGradeLevel(gradeLevel, sectionSelectId) {
    const sectionSelect = document.getElementById(sectionSelectId);
    if (!sectionSelect) return;

    if (!gradeLevel) {
        sectionSelect.innerHTML = '<option value="" disabled selected>Select grade level first...</option>';
        sectionSelect.disabled = true;
        return;
    }

    const filteredSections = departmentsCache.filter(d => d.grade_level === gradeLevel);
    const optionsHtml = filteredSections.map(d =>
        `<option value="${escapeHtml(d.section_id)}">${escapeHtml(d.grade_level)} - ${escapeHtml(d.section_name)}</option>`
    ).join('');

    sectionSelect.innerHTML = '<option value="" disabled selected>Select section...</option>' + optionsHtml;
    sectionSelect.disabled = false;
}

async function openSingleStudentModal() {
    if (!singleStudentModal) {
        showImportAlert('Single student form is not available right now.', 'danger');
        return;
    }
    setSingleStudentLoading(false);

    const syDisplay = document.getElementById('singleActiveSchoolYear');
    if (syDisplay) {
        syDisplay.value = activeSchoolYear && activeSchoolYear.name ? activeSchoolYear.name : 'No Active School Year';
    }

    const singleGradeLevel = document.getElementById('singleGradeLevel');
    const deptSelect = document.getElementById('singleDepartment');

    if (singleGradeLevel) singleGradeLevel.value = '';
    if (deptSelect) {
        deptSelect.innerHTML = '<option value="" disabled selected>Select grade level first...</option>';
        deptSelect.disabled = true;
    }

    if (selectedDepartmentId && singleGradeLevel && deptSelect) {
        const section = departmentsCache.find(
            d => String(d.section_id) === String(selectedDepartmentId)
        );
        if (section) {
            singleGradeLevel.value = section.grade_level;
            filterSectionsByGradeLevel(section.grade_level, 'singleDepartment');
            deptSelect.value = selectedDepartmentId;
        }
    }

    await updateSingleStudentId();

    document.getElementById('singleFirstName').value = '';
    document.getElementById('singleMiddleName').value = '';
    document.getElementById('singleLastName').value = '';
    document.getElementById('singleSuffix').value = '';
    document.getElementById('singleYearLevel').value = '';
    document.getElementById('singleSection').value = '';
    document.getElementById('singleEmail').value = '';
    document.getElementById('singleAddress').value = '';

    const studentStep = document.getElementById('studentFormStep');
    const guardianStep = document.getElementById('guardianFormStep');
    const studentFooter = document.getElementById('studentFormFooter');
    const guardianFooter = document.getElementById('guardianFormFooter');
    if (studentStep) studentStep.style.display = 'block';
    if (guardianStep) guardianStep.style.display = 'none';
    if (studentFooter) studentFooter.style.display = 'flex';
    if (guardianFooter) guardianFooter.style.display = 'none';

    clearGuardian1Form();
    clearGuardian2Form();
    const guardian2Section = document.getElementById('guardian2Section');
    const addGuardian2Container = document.getElementById('addGuardian2ButtonContainer');
    if (guardian2Section) guardian2Section.style.display = 'none';
    if (addGuardian2Container) addGuardian2Container.style.display = 'block';

    deptSelect?.removeEventListener('change', updateSingleStudentId);
    deptSelect?.addEventListener('change', updateSingleStudentId);

    singleStudentModal.show();
}

async function updateSingleStudentId() {
    const gradeSelect = document.getElementById('singleGradeLevel');
    const studIdInput = document.getElementById('singleStudentId');
    if (!gradeSelect || !studIdInput) return;

    const gradeLevel = gradeSelect.value;
    if (!gradeLevel) {
        studIdInput.value = '';
        return;
    }

    try {
        const nextId = await generateNextStudId(gradeLevel);
        studIdInput.value = nextId;
    } catch (err) {
        console.error('Failed to generate Student ID:', err);
        studIdInput.value = '';
    }
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

function proceedToGuardianStep(e) {
    e?.preventDefault?.();

    const sectionId = document.getElementById('singleDepartment')?.value || '';
    const studId = String(document.getElementById('singleStudentId')?.value || '').trim();
    const firstName = String(document.getElementById('singleFirstName')?.value || '').trim();
    const lastName = String(document.getElementById('singleLastName')?.value || '').trim();
    const birthDate = String(document.getElementById('singleYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('singleSection')?.value || '').trim().toLowerCase();
    const email = String(document.getElementById('singleEmail')?.value || '').trim();

    if (!sectionId || !studId || !firstName || !lastName) {
        showImportAlert('Please fill in Section, Student ID, First Name, and Last Name.', 'warning');
        return;
    }
    if (!STUD_ID_PATTERN.test(studId)) {
        showImportAlert('Student ID format: K-####, 1-####, ..., 10-####', 'warning');
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

    const studentStep = document.getElementById('studentFormStep');
    const guardianStep = document.getElementById('guardianFormStep');
    const studentFooter = document.getElementById('studentFormFooter');
    const guardianFooter = document.getElementById('guardianFormFooter');

    studentStep.style.display = 'none';
    guardianStep.style.display = 'block';
    studentFooter.style.display = 'none';
    guardianFooter.style.display = 'flex';

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

function setupSameAsStudentCheckboxes() {
    const studentAddress = document.getElementById('singleAddress');
    const guardian1Checkbox = document.getElementById('guardian1SameAsStudent');
    const guardian1Address = document.getElementById('guardian1Address');
    const guardian2Checkbox = document.getElementById('guardian2SameAsStudent');
    const guardian2Address = document.getElementById('guardian2Address');

    if (!guardian1Checkbox || !guardian1Address) return;

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
    if (statusEl) {
        statusEl.textContent = '';
        statusEl.className = '';
    }
}

async function submitSingleStudentForm(event) {
    event.preventDefault();

    const submitBtn = document.getElementById('singleStudentSubmitBtn');
    const sectionId = document.getElementById('singleDepartment')?.value || '';
    const studId = String(document.getElementById('singleStudentId')?.value || '').trim().toUpperCase();
    const firstName = String(document.getElementById('singleFirstName')?.value || '').trim();
    const middleName = String(document.getElementById('singleMiddleName')?.value || '').trim();
    const lastName = String(document.getElementById('singleLastName')?.value || '').trim();
    const suffix = String(document.getElementById('singleSuffix')?.value || '').trim();
    const birthDate = String(document.getElementById('singleYearLevel')?.value || '').trim();
    const gender = String(document.getElementById('singleSection')?.value || '').trim().toLowerCase();
    const email = String(document.getElementById('singleEmail')?.value || '').trim();
    const address = String(document.getElementById('singleAddress')?.value || '').trim();

    if (!activeSchoolYear || !activeSchoolYear.id) {
        showImportAlert('No active school year found. Please set one in System Settings first.', 'danger');
        return;
    }
    if (!sectionId || !studId || !firstName || !lastName) {
        showImportAlert('Please fill in Section, Student ID, First Name, and Last Name.', 'warning');
        return;
    }
    if (!STUD_ID_PATTERN.test(studId)) {
        showImportAlert('Student ID format: K-####, 1-####, ..., 10-####', 'warning');
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

    const g1Phone = String(document.getElementById('guardian1Phone')?.value || '').trim();
    const g1Relationship = String(document.getElementById('guardian1Relationship')?.value || '').trim();
    const g1FirstName = String(document.getElementById('guardian1FirstName')?.value || '').trim();
    const g1LastName = String(document.getElementById('guardian1LastName')?.value || '').trim();
    const g1MiddleName = String(document.getElementById('guardian1MiddleName')?.value || '').trim();
    const g1AltPhone = String(document.getElementById('guardian1AltPhone')?.value || '').trim();
    const g1Email = String(document.getElementById('guardian1Email')?.value || '').trim();
    const g1Address = String(document.getElementById('guardian1Address')?.value || '').trim();

    const hasGuardian1 = g1FirstName && g1LastName && g1Phone && g1Relationship && g1Address;
    const partialGuardian1 = g1FirstName || g1LastName || g1Phone || g1Relationship || g1Address;

    if (partialGuardian1 && !hasGuardian1) {
        showImportAlert('Guardian 1 requires First Name, Last Name, Phone, Relationship, and Address.', 'warning');
        return;
    }

    const g2Phone = String(document.getElementById('guardian2Phone')?.value || '').trim();
    const g2Relationship = String(document.getElementById('guardian2Relationship')?.value || '').trim();
    const g2FirstName = String(document.getElementById('guardian2FirstName')?.value || '').trim();
    const g2LastName = String(document.getElementById('guardian2LastName')?.value || '').trim();
    const g2MiddleName = String(document.getElementById('guardian2MiddleName')?.value || '').trim();
    const g2AltPhone = String(document.getElementById('guardian2AltPhone')?.value || '').trim();
    const g2Email = String(document.getElementById('guardian2Email')?.value || '').trim();
    const g2Address = String(document.getElementById('guardian2Address')?.value || '').trim();

    const hasGuardian2 = g2FirstName && g2LastName && g2Phone && g2Relationship && g2Address;
    const partialGuardian2 = g2FirstName || g2LastName || g2Phone || g2Relationship || g2Address;

    if (partialGuardian2 && !hasGuardian2) {
        showImportAlert('Guardian 2 requires First Name, Last Name, Phone, Relationship, and Address.', 'warning');
        return;
    }

    const validRelationships = ['mother', 'father', 'legal_guardian', 'other'];
    if (hasGuardian1 && !validRelationships.includes(g1Relationship)) {
        showImportAlert('Guardian 1 relationship must be Mother, Father, Legal Guardian, or Other.', 'warning');
        return;
    }
    if (hasGuardian2 && !validRelationships.includes(g2Relationship)) {
        showImportAlert('Guardian 2 relationship must be Mother, Father, Legal Guardian, or Other.', 'warning');
        return;
    }

    try {
        setSingleStudentLoading(true, 'Saving student and guardians...');

        if (!supabaseClient) throw new Error('Database connection not available. Please refresh the page and try again.');

        const { data: existingStudent, error: existingError } = await supabaseClient
            .from('students')
            .select('stud_id')
            .eq('stud_id', studId)
            .maybeSingle();

        if (existingError) throw existingError;
        if (existingStudent) {
            showImportAlert(`Student ID ${studId} already exists. Use import to update existing records.`, 'warning');
            return;
        }

        const studentUuid = crypto.randomUUID();

        const payload = {
            student_id: studentUuid,
            stud_id: studId,
            first_name: firstName,
            middle_name: middleName || null,
            last_name: lastName,
            suffix: suffix || null,
            birth_date: birthDate || null,
            gender: gender || null,
            section_id: sectionId,
            school_year_id: activeSchoolYear.id,
            email: email || null,
            status: 'active',
            address: address || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        const { error: insertError } = await supabaseClient.from('students').insert(payload);
        if (insertError) throw insertError;

        if (hasGuardian1) {
            try {
                await upsertAndLinkGuardian(studentUuid, {
                    first_name: g1FirstName,
                    middle_name: g1MiddleName || null,
                    last_name: g1LastName,
                    relationship: g1Relationship,
                    phone_number: g1Phone,
                    alternate_phone_number: g1AltPhone || null,
                    email: g1Email || null,
                    address: g1Address,
                }, true);
            } catch (g1Err) {
                console.error('Failed to link Guardian 1:', g1Err);
                showImportAlert(`Student saved, but failed to link Guardian 1: ${g1Err.message}`, 'warning');
            }
        }

        if (hasGuardian2) {
            try {
                await upsertAndLinkGuardian(studentUuid, {
                    first_name: g2FirstName,
                    middle_name: g2MiddleName || null,
                    last_name: g2LastName,
                    relationship: g2Relationship,
                    phone_number: g2Phone,
                    alternate_phone_number: g2AltPhone || null,
                    email: g2Email || null,
                    address: g2Address,
                }, false);
            } catch (g2Err) {
                console.error('Failed to link Guardian 2:', g2Err);
                showImportAlert(`Student saved, but failed to link Guardian 2: ${g2Err.message}`, 'warning');
            }
        }

        showImportAlert(`Student ${firstName} ${lastName} (${studId}) added successfully.`, 'success');
        document.getElementById('singleStudentForm')?.reset();
        setSingleStudentLoading(false);
        singleStudentModal?.hide();
        await loadAllStudentsTable();

        if (email) {
            const selectedSection = departmentsCache.find(s => String(s.section_id) === String(sectionId));
            const sectionLabel = selectedSection ? `${selectedSection.grade_level} - ${selectedSection.section_name}` : '';

            sendStudentQrEmail({
                studId,
                firstName,
                middleName,
                lastName,
                suffix,
                birthDate,
                gender,
                sectionLabel,
                email,
            }).then((emailResult) => {
                if (emailResult.sent) {
                    showEmailStatusToast(`QR code emailed to ${email} for ${firstName} ${lastName}.`, 'success');
                } else {
                    showEmailStatusToast(`Student saved, but QR email was not sent (${emailResult.message}).`, 'warning');
                }
            });
        }
    } catch (err) {
        console.error('Single student registration failed:', err?.message || err, {
            code: err?.code,
            details: err?.details,
            hint: err?.hint,
            full: err,
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
        ...duplicateRowsInDatabase.map(row => ({ ...row, reason: 'Student ID already exists in database' }))
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
        ok: '✓',
        error: '✗',
        warning: '⚠',
        info: '›',
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
        `Student ID: ${student.studId || student.studentId || 'N/A'}`,
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
        studentId: String(student.studId || student.studentId || '').trim(),
        studId: String(student.studId || student.studentId || '').trim(),
        stud_id: String(student.studId || student.studentId || '').trim(),
        fullName: [student.firstName, student.middleName, student.lastName].filter(Boolean).join(' '),
        birthDate: student.birthDate || null,
        gender: student.gender || null,
        sectionLabel: student.sectionLabel || '',
        qrPayload: getStudentQrPayload(student),
    };

    try {
        const response = await fetch(QR_EMAIL_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            return { sent: false, message: `server returned ${response.status}` };
        }

        const result = await response.json().catch(() => ({}));
        return {
            sent: result.sent !== false,
            message: result.message || 'sent',
        };
    } catch (error) {
        return { sent: false, message: error.message || 'request failed' };
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
    if (main) {
        main.insertBefore(alertDiv, main.firstChild);
    } else {
        document.body.insertBefore(alertDiv, document.body.firstChild);
    }
    setTimeout(() => alertDiv.remove(), 6000);
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function downloadStudentTemplate() {
    const headers = [
        'Student ID',
        'Last Name',
        'First Name',
        'Middle Name',
        'Suffix',
        'Birth Date',
        'Gender',
        'Email',
        'School Year',
        'Guardian1_Phone',
        'Guardian1_Relationship',
        'Guardian1_FirstName',
        'Guardian1_LastName',
        'Guardian1_MiddleName',
        'Guardian1_AltPhone',
        'Guardian1_Email',
        'Guardian1_Address',
        'Guardian2_Phone',
        'Guardian2_Relationship',
        'Guardian2_FirstName',
        'Guardian2_LastName',
        'Guardian2_MiddleName',
        'Guardian2_AltPhone',
        'Guardian2_Email',
        'Guardian2_Address'
    ];

    const schoolYearSample = (activeSchoolYear && activeSchoolYear.name)
        ? activeSchoolYear.name
        : '2024-2025';

    const sampleRow = [
        'K-0001',
        'Dela Cruz',
        'Juan',
        'Santos',
        '',
        '2012-06-14',
        'male',
        'delacruz_juan@plpasig.edu.ph',
        schoolYearSample,
        '09171234567',
        'mother',
        'Maria',
        'Dela Cruz',
        'Santos',
        '',
        'maria.dc@email.com',
        '123 Main St, Pasig City',
        '09179876543',
        'father',
        'Jose',
        'Dela Cruz',
        '',
        '',
        'jose.dc@email.com',
        '123 Main St, Pasig City'
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
            .filter(id => STUD_ID_PATTERN.test(id))
    )];

    if (queryableIds.length === 0) {
        return 0;
    }

    const { data: existingStudents, error } = await supabaseClient
        .from('students')
        .select('stud_id')
        .in('stud_id', queryableIds);

    if (error) throw error;

    const existingIds = new Set((existingStudents || []).map(row => row.stud_id));
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

function removeDuplicateStudIdsFromParsedRows() {
    return removeDuplicateStudentIdsFromParsedRows();
}

async function removeExistingStudIdsFromParsedRows() {
    return removeExistingStudentIdsFromParsedRows();
}