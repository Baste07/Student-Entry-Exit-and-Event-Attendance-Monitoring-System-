let allSections = [];
let activeSchoolYear = null;
let currentSection = null;
let sectionModal = null;
let deleteConfirmModal = null;
let bulkImportModal = null;

const GRADE_LEVELS = [
    'Kinder',
    'Grade 1',
    'Grade 2',
    'Grade 3',
    'Grade 4',
    'Grade 5',
    'Grade 6',
    'Grade 7',
    'Grade 8',
    'Grade 9',
    'Grade 10',
];

document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof checkSupabaseConnection === 'function') {
            checkSupabaseConnection();
        }

        const sectionModalElement = document.getElementById('departmentModal');
        const deleteModalElement = document.getElementById('deleteConfirmModal');
        const bulkModalElement = document.getElementById('bulkImportModal');

        if (sectionModalElement) sectionModal = new bootstrap.Modal(sectionModalElement);
        if (deleteModalElement) deleteConfirmModal = new bootstrap.Modal(deleteModalElement);
        if (bulkModalElement) bulkImportModal = new bootstrap.Modal(bulkModalElement);

        setupEventListeners();
        await loadActiveSchoolYear();
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

    const bulkBtn = document.getElementById('bulkImportBtn');
    const processBulkBtn = document.getElementById('processBulkImportBtn');
    const downloadTemplateBtn = document.getElementById('downloadSectionTemplateBtn');

    if (addBtn) addBtn.addEventListener('click', openAddSectionModal);
    if (saveBtn) saveBtn.addEventListener('click', saveSection);
    if (deleteBtn) deleteBtn.addEventListener('click', confirmDelete);
    if (searchInput) searchInput.addEventListener('keyup', filterSections);

    if (bulkBtn) {
        bulkBtn.addEventListener('click', () => {
            document.getElementById('bulkSectionFileInput').value = '';
            document.getElementById('bulkImportResult').innerHTML = '';
            bulkImportModal?.show();
        });
    }
    if (processBulkBtn) processBulkBtn.addEventListener('click', processBulkImport);
    if (downloadTemplateBtn) downloadTemplateBtn.addEventListener('click', downloadSectionTemplate);

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

async function loadActiveSchoolYear() {
    try {
        // Fetch using a standard query to prevent .maybeSingle() strictness crashes
        const { data, error } = await supabaseClient
            .from('school_years')
            .select('id, name')
            .eq('is_active', true);

        if (error) throw error;
        
        // Safely grab the first active school year if one exists
        activeSchoolYear = data && data.length > 0 ? data[0] : null;

        if (!activeSchoolYear) {
            showAlert('No active school year found. Set one first in System Settings.', 'warning');
        }
    } catch (error) {
        console.warn('Could not load active school year:', error);
    }
}

async function loadSections() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        // Intercept the process BEFORE it hits the database to prevent UUID errors
        if (!activeSchoolYear) {
            displaySections([]); // Hides the loading spinner and shows "No sections found"
            updateStatistics();
            return;
        }

        // Safely query the sections using the guaranteed UUID
        const { data, error } = await supabaseClient
            .from('sections')
            .select('section_id, grade_level, section_name, school_year_id, created_at')
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
                <td colspan="4" class="text-center" style="padding: 2rem; color: var(--text-secondary);">
                    <svg viewBox="0 0 24 24" style="width: 48px; height: 48px; margin: 0 auto 1rem; opacity: 0.5;">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                        <polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                    <div>No sections found</div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = sections.map((section) => `
        <tr>
            <td><strong>${escapeHtml(section.grade_level)}</strong></td>
            <td><code>${escapeHtml(section.section_name)}</code></td>
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
    if (totalEl) totalEl.textContent = allSections.length;

    const uniqueGrades = new Set(allSections.map((s) => s.grade_level));
    if (coveredEl) coveredEl.textContent = uniqueGrades.size;
}

function openAddSectionModal() {
    if (!activeSchoolYear) {
        showAlert('Set an active school year first in System Settings.', 'warning');
        return;
    }

    currentSection = null;
    document.getElementById('modalTitle').textContent = 'Add New Section';
    document.getElementById('departmentForm').reset();

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

    document.getElementById('modalTitle').textContent = 'Edit Section';
    document.getElementById('departmentName').value = currentSection.grade_level || '';
    document.getElementById('departmentCode').value = currentSection.section_name || '';

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
        showAlert('Error saving section: ' + error.message, 'danger');
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
        const msg = (error && error.message) ? error.message.toLowerCase() : '';

        if (error && (error.code === '23503' || msg.includes('violates foreign key'))) {
            userMessage = 'Cannot delete section because it is already used by student records. Reassign students first.';
        }

        showAlert(userMessage, 'danger');
    }
}

function filterSections() {
    const searchTerm = String(document.querySelector('.search-input')?.value || '').toLowerCase();

    const filtered = allSections.filter((section) => {
        return section.grade_level.toLowerCase().includes(searchTerm)
            || section.section_name.toLowerCase().includes(searchTerm);
    });

    displaySections(filtered);
}

async function processBulkImport() {
    if (!activeSchoolYear) {
        showAlert('Set an active school year first in System Settings.', 'warning');
        return;
    }

    const fileInput = document.getElementById('bulkSectionFileInput');
    const resultBox = document.getElementById('bulkImportResult');
    const file = fileInput?.files?.[0];

    if (!file) {
        showAlert('Select a file first for bulk import.', 'warning');
        return;
    }

    try {
        const rows = await parseBulkFile(file);
        if (rows.length === 0) {
            resultBox.innerHTML = '<span style="color:#b45309;">No rows found to import.</span>';
            return;
        }

        const existingKeys = new Set(
            allSections.map((s) => `${s.grade_level}|${String(s.section_name || '').toUpperCase()}`)
        );

        let inserted = 0;
        let skipped = 0;
        let failed = 0;

        for (const row of rows) {
            const gradeLevel = String(row.gradeLevel || '').trim();
            const sectionName = String(row.sectionName || '').trim().toUpperCase();

            if (!gradeLevel || !sectionName || !GRADE_LEVELS.includes(gradeLevel)) {
                failed++;
                continue;
            }

            const key = `${gradeLevel}|${sectionName}`;

            if (existingKeys.has(key)) {
                skipped++;
                continue;
            }

            const { error } = await supabaseClient
                .from('sections')
                .insert({
                    section_id: crypto.randomUUID(),
                    grade_level: gradeLevel,
                    section_name: sectionName,
                    school_year_id: activeSchoolYear.id,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });

            if (error) {
                failed++;
                continue;
            }

            inserted++;
            existingKeys.add(key);
        }

        resultBox.innerHTML = `
            <div style="padding:.6rem .8rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:.5rem;">
                <strong>Import finished:</strong> ${inserted} inserted, ${skipped} skipped (duplicates), ${failed} failed.
            </div>
        `;

        await loadSections();
    } catch (error) {
        console.error('Bulk import error:', error);
        resultBox.innerHTML = `<span style="color:#dc2626;">Import failed: ${escapeHtml(error.message || String(error))}</span>`;
    }
}

async function parseBulkFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv') {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 2) return [];

        return lines.slice(1).map((line) => {
            const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
            return {
                gradeLevel: cols[0] || '',
                sectionName: cols[1] || '',
            };
        });
    }

    if (ext === 'xlsx' || ext === 'xls') {
        if (!window.XLSX) throw new Error('SheetJS is not loaded.');

        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (raw.length < 2) return [];

        return raw.slice(1).map((r) => ({
            gradeLevel: String(r[0] || '').trim(),
            sectionName: String(r[1] || '').trim(),
        }));
    }

    throw new Error('Unsupported file format. Use CSV, XLSX, or XLS.');
}

function downloadSectionTemplate() {
    const headers = ['Grade Level', 'Section Name'];
    const sample = ['Grade 7', 'A'];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
        XLSX.utils.book_append_sheet(wb, ws, 'Sections');
        XLSX.writeFile(wb, 'section-import-template.xlsx');
        return;
    }

    const csv = [headers, sample]
        .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
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

function escapeHtml(text) {
    if (!text) return '';

    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, (m) => map[m]);
}
