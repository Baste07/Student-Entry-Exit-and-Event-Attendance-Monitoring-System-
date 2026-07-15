let allSections = [];
let allTeachers = [];
let activeSchoolYear = null;
let currentSection = null;
let sectionModal = null;
let deleteConfirmModal = null;

// Bulk import variables
let parsedRows = [];
let selectedFile = null;
let duplicateRowsInFileCount = 0;
let duplicateRowsInDatabaseCount = 0;
let duplicateRowsInFile = [];
let duplicateRowsInDatabase = [];

const GRADE_LEVELS = [
    'Kinder', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4',
    'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10',
];

document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof checkSupabaseConnection === 'function') {
            checkSupabaseConnection();
        }

        const sectionModalElement = document.getElementById('departmentModal');
        const deleteModalElement = document.getElementById('deleteConfirmModal');

        if (sectionModalElement) sectionModal = new bootstrap.Modal(sectionModalElement);
        if (deleteModalElement) deleteConfirmModal = new bootstrap.Modal(deleteModalElement);

        setupEventListeners();
        setupBulkImportEventListeners();
        await loadActiveSchoolYear();
        await loadTeachers();
        await loadSections();
    } catch (error) {
        console.error('Error during initialization:', error);
    }
});

function setupEventListeners() {
    const addBtn = document.getElementById('addSectionBtn');
    const saveBtn = document.getElementById('saveDepartmentBtn');
    const deleteBtn = document.getElementById('confirmDeleteBtn');
    const searchInput = document.querySelector('.search-input');
    const table = document.getElementById('departmentsTable');
    const refreshBtn = document.getElementById('refreshSectionsBtn');

    if (addBtn) addBtn.addEventListener('click', openAddSectionModal);
    if (saveBtn) saveBtn.addEventListener('click', saveSection);
    if (deleteBtn) deleteBtn.addEventListener('click', confirmDelete);
    if (searchInput) searchInput.addEventListener('keyup', filterSections);
    if (refreshBtn) refreshBtn.addEventListener('click', loadSections);

    if (table) {
        table.addEventListener('click', (e) => {
            const editBtn = e.target.closest('.edit-btn');
            const deleteActionBtn = e.target.closest('.delete-btn');

            if (editBtn) {
                const id = editBtn.getAttribute('data-id');
                openEditSectionModal(id);
            }

            if (deleteActionBtn) {
                const id = deleteActionBtn.getAttribute('data-id');
                openDeleteConfirmModal(id);
            }
        });
    }
}

// ==================== TEACHERS / ADVISERS ====================

async function loadTeachers() {
    try {
        if (!supabaseClient) return;
        const { data, error } = await supabaseClient
            .from('teachers')
            .select('teacher_id, first_name, last_name, employee_id')
            .eq('status', 'active')
            .order('last_name', { ascending: true })
            .order('first_name', { ascending: true });

        if (error) throw error;
        allTeachers = data || [];
        populateAdviserDropdown();
    } catch (error) {
        console.error('Error loading teachers:', error);
    }
}

function populateAdviserDropdown() {
    const select = document.getElementById('adviserSelect');
    if (!select) return;

    // Keep the first option
    select.innerHTML = '<option value="">No adviser assigned</option>';

    allTeachers.forEach(t => {
        const option = document.createElement('option');
        option.value = t.teacher_id;
        option.textContent = `${t.last_name}, ${t.first_name} (${t.employee_id})`;
        select.appendChild(option);
    });
}

function getAdviserName(adviserId) {
    if (!adviserId) return '—';
    const teacher = allTeachers.find(t => t.teacher_id === adviserId);
    if (!teacher) return '—';
    return `${teacher.last_name}, ${teacher.first_name}`;
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

    dropZone?.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        fileInput.click();
    });

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
    downloadBtn?.addEventListener('click', downloadSectionTemplate);
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
                gradeLevel: String(r[0] || '').trim(),
                sectionName: String(r[1] || '').trim().toUpperCase(),
            }));
        }

        rows = rows.filter(r => r.gradeLevel || r.sectionName);

        if (rows.length === 0) {
            showImportAlert('No data rows found. Make sure you have data below the header row.', 'warning');
            return;
        }

        parsedRows = rows.map((r, i) => validateRow(r, i));

        duplicateRowsInFileCount = removeDuplicateSectionsFromParsedRows();
        duplicateRowsInDatabaseCount = await removeExistingSectionsFromParsedRows();

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
            gradeLevel: cols[0] || '',
            sectionName: (cols[1] || '').toUpperCase(),
        };
    });
}

function validateRow(row, index) {
    const errors = [];
    const warnings = [];

    if (!row.gradeLevel) {
        errors.push('Grade Level is required');
    } else if (!GRADE_LEVELS.includes(row.gradeLevel)) {
        errors.push('Invalid grade level');
    }

    if (!row.sectionName) {
        errors.push('Section Name is required');
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

function removeDuplicateSectionsFromParsedRows() {
    const seen = new Set();
    const deduped = [];
    const removedRows = [];

    for (const row of parsedRows) {
        const key = `${String(row.gradeLevel || '').trim()}|${String(row.sectionName || '').trim()}`;
        if (!row.gradeLevel || !row.sectionName) {
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

async function removeExistingSectionsFromParsedRows() {
    if (!activeSchoolYear) return 0;

    const queryableKeys = [...new Set(
        parsedRows
            .filter(row => row.gradeLevel && row.sectionName)
            .map(row => `${row.gradeLevel}|${row.sectionName}`)
    )];

    if (queryableKeys.length === 0) return 0;

    const existingKeys = new Set(
        allSections.map(s => `${s.grade_level}|${String(s.section_name || '').toUpperCase()}`)
    );

    const originalLength = parsedRows.length;
    const removedRows = [];
    
    parsedRows = parsedRows.filter(row => {
        const key = `${row.gradeLevel}|${row.sectionName}`;
        const isExisting = existingKeys.has(key);
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
        proceedBtn.title = 'No new sections available for import';
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
                <td colspan="4" style="text-align:center;padding:1.5rem;color:var(--text-muted);">
                    No new sections available for import. Check the Duplicated card for skipped rows.
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

        return `
            <tr class="${rowClass}">
                <td style="color:var(--text-muted);font-size:0.8rem;">${row.rowIndex}</td>
                <td><strong>${escapeHtml(row.gradeLevel)}</strong>${errorNote}</td>
                <td>${escapeHtml(row.sectionName)}</td>
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

    if (!activeSchoolYear) {
        showImportAlert('No active school year found. Set one first in System Settings.', 'warning');
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

    addLog(log, 'info', `Starting import of ${total} section(s)...`);

    for (let i = 0; i < validRows.length; i++) {
        const row = validRows[i];

        try {
            const { error: insertError } = await supabaseClient.from('sections').insert({
                section_id: crypto.randomUUID(),
                grade_level: row.gradeLevel,
                section_name: row.sectionName,
                school_year_id: activeSchoolYear.id,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            if (insertError) throw insertError;

            success++;
            addLog(log, 'ok', `[Row ${row.rowIndex}] Imported: ${row.gradeLevel} - ${row.sectionName}`);

        } catch (err) {
            failed++;
            addLog(log, 'error', `[Row ${row.rowIndex}] Failed: ${row.gradeLevel} - ${row.sectionName} — ${err.message}`);
        }

        const progress = Math.round(((i + 1) / total) * 100);
        fill.style.width = progress + '%';
        text.textContent = `${i + 1} of ${total} sections processed`;
        pct.textContent = progress + '%';
        await sleep(60);
    }

    addLog(log, 'info', '─────────────────────────────────');
    addLog(log, success > 0 ? 'ok' : 'error',
        `Import complete. ${success} succeeded, ${failed} failed.`);

    if (success > 0) {
        await loadSections();
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

// ==================== TEMPLATE DOWNLOAD ====================

function downloadSectionTemplate() {
    const headers = ['Grade Level', 'Section Name'];
    const sampleRows = [
        ['Grade 7', 'A'],
        ['Grade 8', 'B'],
        ['Grade 9', 'C'],
    ];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
        XLSX.utils.book_append_sheet(wb, ws, 'Sections');
        XLSX.writeFile(wb, 'section-import-template.xlsx');
        return;
    }

    const csv = [headers, ...sampleRows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'section-import-template.csv';
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
    if (main) main.insertBefore(alertDiv, main.firstChild);
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

// ==================== LOAD & DISPLAY ====================

async function loadActiveSchoolYear() {
    try {
        const { data, error } = await supabaseClient
            .from('school_years')
            .select('id, name')
            .eq('is_active', true);

        if (error) throw error;
        
        activeSchoolYear = data && data.length > 0 ? data[0] : null;

        if (!activeSchoolYear) {
            showAlert('No active school year found. Set one first in System Settings.', 'warning');
        }
    } catch (error) {
        console.warn('Could not load active school year:', error);
    }
}

function renderSectionsSkeleton() {
    const tbody = document.getElementById('departmentsTable');
    if (!tbody) return;

    tbody.innerHTML = Array.from({ length: 5 }, () => `
        <tr class="skeleton-row">
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
            <td><span class="skeleton-block skeleton-line"></span></td>
        </tr>
    `).join('');
}

async function loadSections() {
    renderSectionsSkeleton();

    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        if (!activeSchoolYear) {
            displaySections([]);
            updateStatistics();
            return;
        }

        const { data, error } = await supabaseClient
            .from('sections')
            .select('section_id, grade_level, section_name, school_year_id, adviser_id, created_at')
            .eq('school_year_id', activeSchoolYear.id)
            .order('grade_level', { ascending: true })
            .order('section_name', { ascending: true });

        if (error) throw error;

        allSections = data || [];
        displaySections(allSections);
        updateStatistics();
    } catch (error) {
        console.error('Error loading sections:', error);
        showAlert('Error loading sections: ' + error.message, 'danger');
    }
}

function displaySections(sections) {
    const tbody = document.getElementById('departmentsTable');
    if (!tbody) return;

    if (sections.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">
                    No sections found
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = sections.map((section) => `
        <tr>
            <td style="font-weight:500;">${escapeHtml(section.grade_level)}</td>
            <td><code>${escapeHtml(section.section_name)}</code></td>
            <td>${escapeHtml(getAdviserName(section.adviser_id))}</td>
            <td><small>${section.created_at ? new Date(section.created_at).toLocaleDateString() : 'N/A'}</small></td>
            <td>
                <div class="action-buttons">
                    <button class="btn-icon edit-btn" data-id="${section.section_id}" title="Edit">
                        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger delete-btn" data-id="${section.section_id}" title="Delete">
                        <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function updateStatistics() {
    const totalEl = document.getElementById('totalDepartmentsCount');
    const coveredEl = document.getElementById('activeDepartmentsCount');
    const adviserEl = document.getElementById('adviserCount');
    
    if (totalEl) totalEl.textContent = allSections.length;

    const uniqueGrades = new Set(allSections.map((s) => s.grade_level));
    if (coveredEl) coveredEl.textContent = uniqueGrades.size;

    const withAdviser = allSections.filter(s => s.adviser_id).length;
    if (adviserEl) adviserEl.textContent = withAdviser;
}

// ==================== SECTION ACTIONS ====================

function openAddSectionModal() {
    if (!activeSchoolYear) {
        showAlert('Set an active school year first in System Settings.', 'warning');
        return;
    }

    currentSection = null;
    document.getElementById('departmentModalLabel').textContent = 'Add New Section';
    document.getElementById('departmentForm').reset();
    document.getElementById('adviserSelect').value = '';

    if (!sectionModal) {
        sectionModal = new bootstrap.Modal(document.getElementById('departmentModal'));
    }
    sectionModal.show();
}

function openEditSectionModal(sectionId) {
    if (!activeSchoolYear) {
        showAlert('Set an active school year first in System Settings.', 'warning');
        return;
    }

    currentSection = allSections.find((s) => s.section_id === sectionId);
    if (!currentSection) {
        showAlert('Section not found', 'danger');
        return;
    }

    document.getElementById('departmentModalLabel').textContent = 'Edit Section';
    document.getElementById('departmentName').value = currentSection.grade_level || '';
    document.getElementById('departmentCode').value = currentSection.section_name || '';
    document.getElementById('adviserSelect').value = currentSection.adviser_id || '';

    if (!sectionModal) {
        sectionModal = new bootstrap.Modal(document.getElementById('departmentModal'));
    }
    sectionModal.show();
}

async function saveSection() {
    if (!activeSchoolYear) {
        showAlert('Set an active school year first in System Settings.', 'warning');
        return;
    }

    const gradeLevel = document.getElementById('departmentName').value.trim();
    const sectionName = document.getElementById('departmentCode').value.trim().toUpperCase();
    const adviserId = document.getElementById('adviserSelect').value || null;
    const schoolYearId = activeSchoolYear.id;

    if (!gradeLevel || !sectionName) {
        showAlert('Please fill in Grade Level and Section Name', 'warning');
        return;
    }

    if (!GRADE_LEVELS.includes(gradeLevel)) {
        showAlert('Invalid grade level selected.', 'warning');
        return;
    }

    try {
        const duplicate = allSections.find((s) => {
            return s.grade_level === gradeLevel
                && String(s.section_name || '').toUpperCase() === sectionName
                && String(s.school_year_id || '') === String(schoolYearId || '');
        });

        if (duplicate && (!currentSection || duplicate.section_id !== currentSection.section_id)) {
            showAlert('Section already exists for the selected grade level and school year.', 'warning');
            return;
        }

        if (currentSection) {
            const { error } = await supabaseClient
                .from('sections')
                .update({
                    grade_level: gradeLevel,
                    section_name: sectionName,
                    school_year_id: schoolYearId,
                    adviser_id: adviserId,
                    updated_at: new Date().toISOString(),
                })
                .eq('section_id', currentSection.section_id);

            if (error) throw error;
            showAlert('Section updated successfully', 'success');
        } else {
            const { error } = await supabaseClient
                .from('sections')
                .insert({
                    section_id: crypto.randomUUID(),
                    grade_level: gradeLevel,
                    section_name: sectionName,
                    school_year_id: schoolYearId,
                    adviser_id: adviserId,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });

            if (error) throw error;
            showAlert('Section created successfully', 'success');
        }

        sectionModal?.hide();
        await loadSections();
    } catch (error) {
        console.error('Error saving section:', error);
        showAlert('Error saving section: ' + (error.message || error), 'danger');
    }
}

function openDeleteConfirmModal(sectionId) {
    currentSection = allSections.find((s) => s.section_id === sectionId);

    if (!currentSection) {
        showAlert('Section not found', 'danger');
        return;
    }

    document.getElementById('deleteDepartmentName').textContent = `${currentSection.grade_level} - ${currentSection.section_name}`;

    if (!deleteConfirmModal) {
        deleteConfirmModal = new bootstrap.Modal(document.getElementById('deleteConfirmModal'));
    }
    deleteConfirmModal.show();
}

async function confirmDelete() {
    if (!currentSection) return;

    try {
        const { error } = await supabaseClient
            .from('sections')
            .delete()
            .eq('section_id', currentSection.section_id);

        if (error) throw error;

        deleteConfirmModal?.hide();
        showAlert('Section deleted successfully', 'success');
        await loadSections();
    } catch (error) {
        console.error('Error deleting section:', error);
        let userMessage = 'Error deleting section: ' + (error.message || error);
        const msg = error && error.message ? error.message.toLowerCase() : '';

        if (error && (error.code === '23503' || msg.includes('violates foreign key'))) {
            userMessage = 'Cannot delete section because it is already used by student records. Reassign students first.';
        }

        showAlert(userMessage, 'danger');
    }
}

function filterSections() {
    const searchTerm = String(document.querySelector('.search-input')?.value || '').toLowerCase();

    const filtered = allSections.filter((section) => {
        const adviserName = getAdviserName(section.adviser_id).toLowerCase();
        return String(section.grade_level || '').toLowerCase().includes(searchTerm)
            || String(section.section_name || '').toLowerCase().includes(searchTerm)
            || adviserName.includes(searchTerm);
    });

    displaySections(filtered);
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.style.zIndex = 1050;
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    const mainContent = document.querySelector('.main-content');
    const headerContainer = document.getElementById('header-container');
    if (mainContent) {
        mainContent.insertBefore(alertDiv, mainContent.firstChild);
    } else if (headerContainer) {
        headerContainer.parentNode.insertBefore(alertDiv, headerContainer.nextSibling);
    } else {
        document.body.insertBefore(alertDiv, document.body.firstChild);
    }

    setTimeout(() => {
        try { alertDiv.remove(); } catch (e) { /* ignore */ }
    }, 7000);
}