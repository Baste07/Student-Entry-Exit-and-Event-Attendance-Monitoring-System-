let allTeachers = [];
let currentUser = null;
let isUserSuperAdmin = false;
let teacherModal = null;
let duplicateRowsModal = null;

// Bulk import variables
let parsedRows = [];
let selectedFile = null;
let duplicateRowsInFileCount = 0;
let duplicateRowsInDatabaseCount = 0;
let duplicateRowsInFile = [];
let duplicateRowsInDatabase = [];

const EMAIL_LIKE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initializeUserSession() {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
        try {
            currentUser = JSON.parse(userStr);
            isUserSuperAdmin = currentUser.userType === 'admin' && currentUser.adminLevel === 'super_admin';
        } catch (e) {
            console.error('Error parsing user session:', e);
        }
    }
}

// ==================== LOAD & DISPLAY ====================

async function loadTeachers() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data: teachers, error } = await supabaseClient
            .from('teachers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        allTeachers = (teachers || []).map(teacher => {
            let fullName = teacher.last_name || 'Unknown';
            if (teacher.first_name) fullName += `, ${teacher.first_name}`;
            if (teacher.middle_name) fullName += ` ${teacher.middle_name}`;
            if (teacher.suffix) fullName += ` ${teacher.suffix}`;

            return {
                id: teacher.teacher_id,
                employeeId: teacher.employee_id,
                name: fullName.trim(),
                firstName: teacher.first_name,
                middleName: teacher.middle_name,
                lastName: teacher.last_name,
                suffix: teacher.suffix,
                email: teacher.email,
                phone: teacher.phone_number,
                faculty: teacher.faculty || 'N/A',
                status: normalizeStatus(teacher.status, 'active'),
                created_at: teacher.created_at,
                rawData: teacher
            };
        });

        displayTeachers(allTeachers);
        updateStatistics();

    } catch (error) {
        console.error('Error loading teachers:', error);
        alert('Failed to load teachers. Please try again.');
    }
}

function normalizeStatus(status, fallback = 'active') {
    const normalized = String(status || '').trim().toLowerCase();
    if (['active', 'inactive', 'suspended'].includes(normalized)) return normalized;
    return fallback;
}

function displayTeachers(teachers) {
    const tbody = document.getElementById('teachersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (teachers.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">
                    No teachers found
                </td>
            </tr>
        `;
        return;
    }

    teachers.forEach(teacher => {
        const row = document.createElement('tr');
        row.classList.add('searchable-row');
        row.dataset.status = teacher.status;
        row.dataset.teacherId = teacher.id;

        let statusBadgeClass = 'badge-inactive';
        let statusText = 'Inactive';
        if (teacher.status === 'active') { statusBadgeClass = 'badge-active'; statusText = 'Active'; }
        else if (teacher.status === 'suspended') { statusBadgeClass = 'badge-suspended'; statusText = 'Suspended'; }

        let buttons = [];
        
        buttons.push(`
            <button class="btn-icon" title="Edit Teacher" onclick="openTeacherModal('${teacher.id}')">
                <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
        `);
        
        if (teacher.status === 'suspended') {
            buttons.push(`
                <button class="btn-icon" title="Reactivate Teacher" onclick="reactivateTeacher('${teacher.id}', '${escapeHtml(teacher.name)}')">
                    <svg viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64M3.51 15A9 9 0 0 0 18.36 18.36"/></svg>
                </button>
            `);
        } else {
            buttons.push(`
                <button class="btn-icon danger" title="Suspend Teacher" onclick="suspendTeacher('${teacher.id}', '${escapeHtml(teacher.name)}')">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                </button>
            `);
        }

        row.innerHTML = `
            <td style="font-weight:500;">${escapeHtml(teacher.name)}</td>
            <td>${escapeHtml(teacher.employeeId)}</td>
            <td>${escapeHtml(teacher.email)}</td>
            <td>${escapeHtml(teacher.faculty)}</td>
            <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
            <td><div class="action-buttons">${buttons.join('')}</div></td>
        `;

        tbody.appendChild(row);
    });
}

function updateStatistics() {
    const total = allTeachers.length;
    const active = allTeachers.filter(t => t.status === 'active').length;
    const inactive = allTeachers.filter(t => t.status !== 'active').length;

    const totalEl = document.getElementById('totalTeachersCount');
    const activeEl = document.getElementById('activeTeachersCount');
    const inactiveEl = document.getElementById('inactiveTeachersCount');

    if (totalEl) totalEl.textContent = total;
    if (activeEl) activeEl.textContent = active;
    if (inactiveEl) inactiveEl.textContent = inactive;
}

// ==================== ACTIONS ====================

async function suspendTeacher(teacherId, teacherName) {
    if (!confirm(`Are you sure you want to suspend "${teacherName}"?\n\nTheir account will be disabled but all data will be retained.`)) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('teachers')
            .update({ status: 'suspended', updated_at: new Date().toISOString() })
            .eq('teacher_id', teacherId);

        if (error) throw error;
        alert(`"${teacherName}" has been suspended.`);
        await loadTeachers();
    } catch (error) {
        console.error('Error suspending teacher:', error);
        alert('Failed to suspend teacher. Please try again.');
    }
}

async function reactivateTeacher(teacherId, teacherName) {
    if (!confirm(`Reactivate "${teacherName}"? Their account will be restored to active status.`)) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('teachers')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('teacher_id', teacherId);

        if (error) throw error;
        alert(`"${teacherName}" has been reactivated.`);
        await loadTeachers();
    } catch (error) {
        console.error('Error reactivating teacher:', error);
        alert('Failed to reactivate teacher. Please try again.');
    }
}

// ==================== SEARCH & FILTER ====================

function setupSearch() {
    const searchInput = document.getElementById('teacherSearchInput');
    if (searchInput) searchInput.addEventListener('input', applyFilters);
}

function setupFilters() {
    const statusFilter = document.getElementById('teacherStatusFilter');
    if (statusFilter) statusFilter.addEventListener('change', applyFilters);
}

function applyFilters() {
    const statusFilter = document.getElementById('teacherStatusFilter');
    const searchInput = document.getElementById('teacherSearchInput');

    const selectedStatus = statusFilter ? statusFilter.value.toLowerCase() : 'all statuses';
    const query = searchInput ? searchInput.value.toLowerCase() : '';

    const filtered = allTeachers.filter(teacher => {
        const statusMatch = selectedStatus === 'all statuses' || teacher.status.toLowerCase() === selectedStatus;
        const searchMatch = !query ||
            teacher.name.toLowerCase().includes(query) ||
            teacher.email.toLowerCase().includes(query) ||
            teacher.employeeId.toLowerCase().includes(query) ||
            teacher.faculty.toLowerCase().includes(query);
        return statusMatch && searchMatch;
    });

    displayTeachers(filtered);
}

// ==================== SINGLE TEACHER MODAL ====================

function setupAddUserButton() {
    const addBtn = document.getElementById('addSingleTeacherBtn');
    if (addBtn) addBtn.addEventListener('click', () => openTeacherModal());
}

function openTeacherModal(teacherId = null) {
    const form = document.getElementById('teacherForm');
    const modalLabel = document.getElementById('teacherModalLabel');
    const submitBtn = document.getElementById('teacherSubmitBtn');
    const editMode = document.getElementById('teacherEditMode');
    const statusField = document.getElementById('teacherStatusField');
    const employeeIdInput = document.getElementById('teacherEmployeeId');
    const emailInput = document.getElementById('teacherEmail');
    
    form.reset();
    document.getElementById('teacherId').value = '';
    editMode.value = 'false';
    
    if (teacherId) {
        const teacher = allTeachers.find(t => t.id === teacherId);
        if (!teacher) return;
        
        modalLabel.textContent = 'Edit Teacher';
        submitBtn.textContent = 'Save Changes';
        editMode.value = 'true';
        
        document.getElementById('teacherId').value = teacher.id;
        document.getElementById('teacherEmployeeId').value = teacher.employeeId;
        document.getElementById('teacherLastName').value = teacher.lastName || '';
        document.getElementById('teacherFirstName').value = teacher.firstName || '';
        document.getElementById('teacherMiddleName').value = teacher.middleName || '';
        document.getElementById('teacherSuffix').value = teacher.suffix || '';
        document.getElementById('teacherEmail').value = teacher.email;
        document.getElementById('teacherPhone').value = teacher.phone || '';
        document.getElementById('teacherFaculty').value = teacher.faculty === 'N/A' ? '' : teacher.faculty;
        document.getElementById('teacherStatus').value = teacher.status;
        
        statusField.style.display = 'block';
        employeeIdInput.readOnly = true;
        emailInput.readOnly = true;
    } else {
        modalLabel.textContent = 'Add New Teacher';
        submitBtn.textContent = 'Create Teacher';
        statusField.style.display = 'none';
        employeeIdInput.readOnly = false;
        emailInput.readOnly = false;
    }
    
    if (teacherModal) teacherModal.show();
}

async function submitTeacherForm(e) {
    e.preventDefault();
    
    const isEdit = document.getElementById('teacherEditMode').value === 'true';
    const teacherId = document.getElementById('teacherId').value;
    
    const employeeId = document.getElementById('teacherEmployeeId').value.trim();
    const lastName = document.getElementById('teacherLastName').value.trim();
    const firstName = document.getElementById('teacherFirstName').value.trim();
    const middleName = document.getElementById('teacherMiddleName').value.trim();
    const suffix = document.getElementById('teacherSuffix').value.trim();
    const email = document.getElementById('teacherEmail').value.trim();
    const phone = document.getElementById('teacherPhone').value.trim();
    const faculty = document.getElementById('teacherFaculty').value.trim();
    
    if (!employeeId) { alert('Employee ID is required.'); return; }
    if (!lastName) { alert('Last Name is required.'); return; }
    if (!firstName) { alert('First Name is required.'); return; }
    if (!email) { alert('Email is required.'); return; }
    if (!faculty) { alert('Faculty is required.'); return; }
    
    try {
        if (!supabaseClient) throw new Error('Database connection not available');
        
        if (isEdit) {
            const status = document.getElementById('teacherStatus').value;
            
            const { error } = await supabaseClient
                .from('teachers')
                .update({
                    first_name: firstName,
                    middle_name: middleName || null,
                    last_name: lastName,
                    suffix: suffix || null,
                    phone_number: phone || null,
                    faculty: faculty,
                    status: status,
                    updated_at: new Date().toISOString()
                })
                .eq('teacher_id', teacherId);
                
            if (error) throw error;
            alert('Teacher updated successfully!');
        } else {
            const { data: existing } = await supabaseClient
                .from('teachers')
                .select('email, employee_id')
                .or(`email.eq.${email},employee_id.eq.${employeeId}`)
                .maybeSingle();
                
            if (existing) {
                if (existing.email === email) alert('A teacher with this email already exists.');
                else alert('A teacher with this Employee ID already exists.');
                return;
            }
            
            const { error: insertError } = await supabaseClient.from('teachers').insert([{
                teacher_id: crypto.randomUUID(),
                employee_id: employeeId,
                first_name: firstName,
                middle_name: middleName || null,
                last_name: lastName,
                suffix: suffix || null,
                email: email,
                phone_number: phone || null,
                faculty: faculty,
                status: 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
            
            if (insertError) throw insertError;
            alert('Teacher created successfully!');
        }
        
        if (teacherModal) teacherModal.hide();
        document.getElementById('teacherForm').reset();
        await loadTeachers();
        
    } catch (error) {
        console.error('Error saving teacher:', error);
        alert(`Failed to save teacher: ${error.message}`);
    }
}

// ==================== BULK IMPORT ====================

function setupBulkImportEventListeners() {
    const dropZone = document.getElementById('fileDropZone');
    const fileInput = document.getElementById('fileInput');
    const removeBtn = document.getElementById('fileRemoveBtn');
    const parseBtn = document.getElementById('parseFileBtn');
    const backUpload = document.getElementById('backToUploadBtn');
    const proceedBtn = document.getElementById('proceedImportBtn');
    const anotherBtn = document.getElementById('importAnotherBtn');
    const downloadBtn = document.getElementById('downloadTemplateBtn');

    if (window.bootstrap) {
        const modalElement = document.getElementById('teacherModal');
        if (modalElement) teacherModal = new bootstrap.Modal(modalElement);
        
        const dupModalElement = document.getElementById('duplicateRowsModal');
        if (dupModalElement) duplicateRowsModal = new bootstrap.Modal(dupModalElement);
    }

    // Drop zone click
    dropZone?.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        fileInput.click();
    });

    // Drag & drop
    let dragCounter = 0;
    dropZone?.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) dropZone.classList.remove('drag-over');
    });
    dropZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
    });

    fileInput?.addEventListener('change', () => {
        if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
    });

    removeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearFileSelection();
    });

    parseBtn?.addEventListener('click', parseFile);
    backUpload?.addEventListener('click', goBackToUpload);
    proceedBtn?.addEventListener('click', startImport);
    anotherBtn?.addEventListener('click', resetAll);
    downloadBtn?.addEventListener('click', downloadTeacherTemplate);
    
    // Duplicate summary card click
    const duplicateSummaryCard = document.getElementById('duplicateSummaryCard');
    duplicateSummaryCard?.addEventListener('click', openDuplicateRowsModal);
}

function handleFileSelected(file) {
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
    parseBtn.disabled = !selectedFile;
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
                employeeId: String(r[0] || '').trim(),
                lastName:   String(r[1] || '').trim(),
                firstName:  String(r[2] || '').trim(),
                middleName: String(r[3] || '').trim(),
                suffix:     String(r[4] || '').trim(),
                email:      String(r[5] || '').trim(),
                phone:      String(r[6] || '').trim(),
                faculty:    String(r[7] || '').trim(),
            }));
        }

        rows = rows.filter(r => r.employeeId || r.firstName || r.lastName);

        if (rows.length === 0) {
            showImportAlert('No data rows found. Make sure you have data below the header row.', 'warning');
            return;
        }

        parsedRows = rows.map((r, i) => validateRow(r, i));

        duplicateRowsInFileCount = removeDuplicateEmployeeIdsFromParsedRows();
        duplicateRowsInDatabaseCount = await removeExistingEmployeeIdsFromParsedRows();

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
            employeeId: cols[0] || '',
            lastName:   cols[1] || '',
            firstName:  cols[2] || '',
            middleName: cols[3] || '',
            suffix:     cols[4] || '',
            email:      cols[5] || '',
            phone:      cols[6] || '',
            faculty:    cols[7] || '',
        };
    });
}

function validateRow(row, index) {
    const errors = [];
    const warnings = [];

    if (!row.employeeId) {
        errors.push('Employee ID is required');
    }

    if (!row.firstName) errors.push('First Name is required');
    if (!row.lastName) errors.push('Last Name is required');

    if (!row.email) {
        errors.push('Email is required');
    } else if (!EMAIL_LIKE_PATTERN.test(row.email)) {
        warnings.push('Email format looks invalid');
    }

    if (!row.faculty) {
        errors.push('Faculty is required');
    }

    const status = errors.length > 0 ? 'error'
                 : warnings.length > 0 ? 'warning'
                 : 'ok';

    return {
        ...row,
        errors,
        warnings,
        status,
        rowIndex: index + 2,
    };
}

function removeDuplicateEmployeeIdsFromParsedRows() {
    const seen = new Set();
    const deduped = [];
    const removedRows = [];

    for (const row of parsedRows) {
        const key = String(row.employeeId || '').trim();
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

async function removeExistingEmployeeIdsFromParsedRows() {
    const queryableIds = [...new Set(
        parsedRows
            .map(row => String(row.employeeId || '').trim())
            .filter(id => id)
    )];

    if (queryableIds.length === 0) return 0;

    const { data: existingTeachers, error } = await supabaseClient
        .from('teachers')
        .select('employee_id')
        .in('employee_id', queryableIds);

    if (error) throw error;

    const existingIds = new Set((existingTeachers || []).map(row => row.employee_id));
    const originalLength = parsedRows.length;
    const removedRows = [];
    
    parsedRows = parsedRows.filter(row => {
        const isExisting = existingIds.has(String(row.employeeId || '').trim());
        if (isExisting) {
            removedRows.push(row);
            return false;
        }
        return true;
    });
    
    duplicateRowsInDatabase = removedRows;
    return originalLength - parsedRows.length;
}

function renderPreview() {
    const tbody = document.getElementById('previewTableBody');
    const valid = parsedRows.filter(r => r.status !== 'error').length;
    const warnings = parsedRows.filter(r => r.status === 'warning').length;
    const errors = parsedRows.filter(r => r.status === 'error').length;
    const duplicated = duplicateRowsInFileCount + duplicateRowsInDatabaseCount;

    document.getElementById('validCount').textContent = valid;
    document.getElementById('duplicatedCount').textContent = duplicated;
    document.getElementById('warningCount').textContent = warnings;
    document.getElementById('errorCount').textContent = errors;
    document.getElementById('totalCount').textContent = parsedRows.length;

    const duplicateSummaryCard = document.getElementById('duplicateSummaryCard');
    if (duplicateSummaryCard) {
        duplicateSummaryCard.setAttribute('role', 'button');
        duplicateSummaryCard.setAttribute('tabindex', duplicated > 0 ? '0' : '-1');
        duplicateSummaryCard.setAttribute('aria-disabled', duplicated > 0 ? 'false' : 'true');
        duplicateSummaryCard.title = `Skipped duplicates: ${duplicateRowsInFileCount} in file, ${duplicateRowsInDatabaseCount} already in database`;
    }

    const proceedBtn = document.getElementById('proceedImportBtn');
    if (parsedRows.length === 0) {
        proceedBtn.disabled = true;
        proceedBtn.title = 'No new teachers available for import';
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
                    No new teachers available for import. Check the Duplicated card for skipped rows.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = parsedRows.map((row) => {
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

        return `
            <tr class="${rowClass}">
                <td style="color:var(--text-muted);font-size:0.8rem;">${row.rowIndex}</td>
                <td><strong>${escapeHtml(row.employeeId)}</strong>${errorNote}</td>
                ${cell(row.lastName)}
                ${cell(row.firstName)}
                ${cell(row.middleName)}
                ${cell(row.suffix)}
                <td style="font-size:0.82rem;">${escapeHtml(row.email)}${warnNote}</td>
                ${cell(row.phone)}
                ${cell(row.faculty)}
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
    const log = document.getElementById('importLog');
    const fill = document.getElementById('progressBarFill');
    const text = document.getElementById('progressText');
    const pct = document.getElementById('progressPct');
    log.innerHTML = '';

    let success = 0;
    let failed = 0;
    const total = validRows.length;

    addLog(log, 'info', `Starting import of ${total} teacher(s)...`);

    for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];

        try {
            const { error: insertError } = await supabaseClient.from('teachers').insert([{
                teacher_id: crypto.randomUUID(),
                employee_id: row.employeeId,
                first_name: row.firstName,
                middle_name: row.middleName || null,
                last_name: row.lastName,
                suffix: row.suffix || null,
                email: row.email,
                phone_number: row.phone || null,
                faculty: row.faculty,
                status: 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

            if (insertError) throw insertError;

            success++;
            addLog(log, 'ok', `[Row ${row.rowIndex}] Imported: ${row.firstName} ${row.lastName} (${row.employeeId})`);

        } catch (err) {
            failed++;
            addLog(log, 'error', `[Row ${row.rowIndex}] Failed: ${row.firstName} ${row.lastName} — ${err.message}`);
        }

        const progress = Math.round(((i + 1) / total) * 100);
        fill.style.width = progress + '%';
        text.textContent = `${i + 1} of ${total} teachers processed`;
        pct.textContent = progress + '%';
        await sleep(60);
    }

    addLog(log, 'info', '─────────────────────────────────');
    addLog(log, success > 0 ? 'ok' : 'error',
        `Import complete. ${success} succeeded, ${failed} failed.`);

    if (success > 0) {
        await loadTeachers();
    }

    document.getElementById('importFooter').style.display = 'flex';
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
    document.getElementById('importLog').innerHTML = '';
    document.getElementById('progressBarFill').style.width = '0%';
    document.getElementById('importFooter').style.display = 'none';
    showStep('upload');
    checkReadyToParse();
}

// ==================== DUPLICATE MODAL ====================

function openDuplicateRowsModal() {
    const totalDuplicated = duplicateRowsInFile.length + duplicateRowsInDatabase.length;
    if (!duplicateRowsModal || totalDuplicated === 0) return;

    renderDuplicateRowsTable();
    duplicateRowsModal.show();
}

function renderDuplicateRowsTable() {
    const tableBody = document.getElementById('duplicateRowsTableBody');
    const summaryText = document.getElementById('duplicateRowsSummaryText');
    if (!tableBody || !summaryText) return;

    const mergedRows = [
        ...duplicateRowsInFile.map(row => ({ ...row, reason: 'Duplicate in uploaded file' })),
        ...duplicateRowsInDatabase.map(row => ({ ...row, reason: 'Employee ID already exists in database' }))
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
                <td><strong>${escapeHtml(row.employeeId || '-')}</strong></td>
                <td>${escapeHtml(fullName || '-')}</td>
                <td>${escapeHtml(row.email || '-')}</td>
                <td>${escapeHtml(row.reason)}</td>
            </tr>
        `;
    }).join('');
}

// ==================== TEMPLATE DOWNLOAD ====================

function downloadTeacherTemplate() {
    const headers = [
        'Employee ID',
        'Last Name',
        'First Name',
        'Middle Name',
        'Suffix',
        'Email',
        'Phone',
        'Faculty'
    ];

    const sampleRows = [
        ['12345', 'Dela Cruz', 'Juan', 'Santos', '', 'juan.delacruz@plpasig.edu.ph', '09171234567', 'College of Computer Studies'],
        ['12346', 'Cruz', 'Maria', 'Reyes', 'Jr.', 'maria.cruz@plpasig.edu.ph', '09179876543', 'College of Business and Accountancy'],
        ['12347', 'Reyes', 'Jose', '', '', 'jose.reyes@plpasig.edu.ph', '', 'College of Arts and Sciences']
    ];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
        XLSX.utils.book_append_sheet(wb, ws, 'Teachers');
        XLSX.writeFile(wb, 'teacher-import-template.xlsx');
        return;
    }

    const csv = [headers, ...sampleRows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teacher-import-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ==================== UTILITIES ====================

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
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', function () {
    checkSupabaseConnection();
    initializeUserSession();
    
    if (window.bootstrap) {
        const modalEl = document.getElementById('teacherModal');
        if (modalEl) teacherModal = new bootstrap.Modal(modalEl);
        
        const dupModalEl = document.getElementById('duplicateRowsModal');
        if (dupModalEl) duplicateRowsModal = new bootstrap.Modal(dupModalEl);
    }
    
    loadTeachers();
    setupSearch();
    setupFilters();
    setupAddUserButton();
    setupBulkImportEventListeners();
    
    document.getElementById('teacherForm')?.addEventListener('submit', submitTeacherForm);
    document.getElementById('refreshTeachersBtn')?.addEventListener('click', loadTeachers);
});