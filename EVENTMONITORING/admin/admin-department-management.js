let allDepartments = [];
let currentDepartment = null;
let departmentModal = null;
let deleteConfirmModal = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof checkSupabaseConnection === 'function') {
            checkSupabaseConnection();
        }
        
        const modalElement = document.getElementById('departmentModal');
        const deleteElement = document.getElementById('deleteConfirmModal');
        
        if (modalElement) {
            departmentModal = new bootstrap.Modal(modalElement);
        }
        if (deleteElement) {
            deleteConfirmModal = new bootstrap.Modal(deleteElement);
        }

        await loadDepartments();
        setupEventListeners();
    } catch (error) {
        console.error('Error during initialization:', error);
    }
});

function setupEventListeners() {
    const addBtn = document.querySelector('.btn-add-department');
    const saveBtn = document.getElementById('saveDepartmentBtn');
    const deleteBtn = document.getElementById('confirmDeleteBtn');
    const searchInput = document.querySelector('.search-input');
    const table = document.getElementById('departmentsTable');
    
    // Add button
    if (addBtn) {
        addBtn.addEventListener('click', openAddDepartmentModal);
    }
    
    // Save button
    if (saveBtn) {
        saveBtn.addEventListener('click', saveDepartment);
    }
    
    // Confirm delete button
    if (deleteBtn) {
        deleteBtn.addEventListener('click', confirmDelete);
    }
    
    // Search input
    if (searchInput) {
        searchInput.addEventListener('keyup', filterDepartments);
    }
    
    // Edit buttons (event delegation)
    if (table) {
        table.addEventListener('click', (e) => {
            const editBtn = e.target.closest('.edit-btn');
            const deleteActionBtn = e.target.closest('.delete-btn');
            
            if (editBtn) {
                const id = editBtn.getAttribute('data-id');
                openEditDepartmentModal(id);
            }
            
            if (deleteActionBtn) {
                const id = deleteActionBtn.getAttribute('data-id');
                openDeleteConfirmModal(id);
            }
        });
    }
}

async function loadDepartments() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data, error } = await supabaseClient
            .from('departments')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        allDepartments = data || [];
        displayDepartments(allDepartments);
        updateStatistics();
    } catch (error) {
        console.error('Error loading departments:', error);
        showAlert('Error loading departments', 'danger');
    }
}

function displayDepartments(departments) {
    const tbody = document.getElementById('departmentsTable');
    
    if (departments.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center" style="padding: 2rem; color: var(--text-secondary);">
                    <svg viewBox="0 0 24 24" style="width: 48px; height: 48px; margin: 0 auto 1rem; opacity: 0.5;">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                        <polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                    <div>No departments found</div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = departments.map(dept => `
        <tr>
            <td>
                <strong>${escapeHtml(dept.department_name)}</strong>
            </td>
            <td>
                <code>${escapeHtml(dept.department_code)}</code>
            </td>
            <td>
                <small>${dept.description ? escapeHtml(dept.description.substring(0, 50)) + (dept.description.length > 50 ? '...' : '') : 'N/A'}</small>
            </td>
            <td>
                <span class="badge ${dept.is_active ? 'bg-success' : 'bg-secondary'}">
                    ${dept.is_active ? 'Active' : 'Inactive'}
                </span>
            </td>
            <td>
                <small>${new Date(dept.created_at).toLocaleDateString()}</small>
            </td>
            <td>
                <div class="action-buttons">
                    <button class="btn-icon edit-btn" data-id="${dept.id}" title="Edit">
                        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-icon danger delete-btn" data-id="${dept.id}" title="Delete">
                        <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function updateStatistics() {
    document.getElementById('totalDepartmentsCount').textContent = allDepartments.length;
    document.getElementById('activeDepartmentsCount').textContent = allDepartments.filter(d => d.is_active).length;
}

function openAddDepartmentModal() {
    currentDepartment = null;
    document.getElementById('modalTitle').textContent = 'Add New Department';
    document.getElementById('departmentForm').reset();
    document.getElementById('departmentStatus').value = 'true';
    
    if (!departmentModal) {
        departmentModal = new bootstrap.Modal(document.getElementById('departmentModal'));
    }
    departmentModal.show();
}

function openEditDepartmentModal(departmentId) {
    currentDepartment = allDepartments.find(d => d.id === departmentId);
    
    if (!currentDepartment) {
        showAlert('Department not found', 'danger');
        return;
    }

    document.getElementById('modalTitle').textContent = 'Edit Department';
    document.getElementById('departmentName').value = currentDepartment.department_name;
    document.getElementById('departmentCode').value = currentDepartment.department_code;
    document.getElementById('departmentDescription').value = currentDepartment.description || '';
    document.getElementById('departmentStatus').value = currentDepartment.is_active ? 'true' : 'false';
    
    if (!departmentModal) {
        departmentModal = new bootstrap.Modal(document.getElementById('departmentModal'));
    }
    departmentModal.show();
}

async function saveDepartment() {
    const departmentName = document.getElementById('departmentName').value.trim();
    const departmentCode = document.getElementById('departmentCode').value.trim();
    const departmentDescription = document.getElementById('departmentDescription').value.trim();
    const departmentStatus = document.getElementById('departmentStatus').value === 'true';

    if (!departmentName || !departmentCode) {
        showAlert('Please fill in all required fields', 'warning');
        return;
    }

    try {
        if (currentDepartment) {
            // Update existing department
            const { error } = await supabaseClient
                .from('departments')
                .update({
                    department_name: departmentName,
                    department_code: departmentCode,
                    description: departmentDescription,
                    is_active: departmentStatus,
                    updated_at: new Date().toISOString()
                })
                .eq('id', currentDepartment.id);

            if (error) throw error;
            showAlert('Department updated successfully', 'success');
        } else {
            // Add new department
            const { error } = await supabaseClient
                .from('departments')
                .insert({
                    department_name: departmentName,
                    department_code: departmentCode,
                    description: departmentDescription,
                    is_active: departmentStatus,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });

            if (error) throw error;
            showAlert('Department created successfully', 'success');
        }

        departmentModal.hide();
        await loadDepartments();
    } catch (error) {
        console.error('Error saving department:', error);
        showAlert('Error saving department: ' + error.message, 'danger');
    }
}

function openDeleteConfirmModal(departmentId) {
    currentDepartment = allDepartments.find(d => d.id === departmentId);
    
    if (!currentDepartment) {
        showAlert('Department not found', 'danger');
        return;
    }

    document.getElementById('deleteDepartmentName').textContent = currentDepartment.department_name;
    
    if (!deleteConfirmModal) {
        deleteConfirmModal = new bootstrap.Modal(document.getElementById('deleteConfirmModal'));
    }
    deleteConfirmModal.show();
}

async function confirmDelete() {
    if (!currentDepartment) return;

    try {
        const { error } = await supabaseClient
            .from('departments')
            .delete()
            .eq('id', currentDepartment.id);

        if (error) throw error;
        
        deleteConfirmModal.hide();
        showAlert('Department deleted successfully', 'success');
        await loadDepartments();
    } catch (error) {
        console.error('Error deleting department:', error);
        let userMessage = 'Error deleting department: ' + (error.message || error);
        const msg = (error && error.message) ? error.message.toLowerCase() : '';

        if (error && (error.code === '23503' || msg.includes('violates foreign key'))) {
            userMessage = 'Cannot delete department because there are related records (for example: professors, audit logs, or other data). Remove or reassign those records first.';
            console.error('Foreign key violation on department delete. Full error details:', error);
        }

        showAlert(userMessage, 'danger');
    }
}

function filterDepartments() {
    const searchTerm = document.querySelector('.search-input').value.toLowerCase();
    
    const filtered = allDepartments.filter(dept => 
        dept.department_name.toLowerCase().includes(searchTerm) ||
        dept.department_code.toLowerCase().includes(searchTerm) ||
        (dept.description && dept.description.toLowerCase().includes(searchTerm))
    );

    displayDepartments(filtered);
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.setAttribute('role', 'alert');
    alertDiv.style.zIndex = 1050; // make sure it's above other elements
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    // Prefer inserting into the main content; fall back to header container or body
    const mainContent = document.querySelector('.main-content');
    const headerContainer = document.getElementById('header-container');
    if (mainContent) {
        mainContent.insertBefore(alertDiv, mainContent.firstChild);
    } else if (headerContainer) {
        headerContainer.parentNode.insertBefore(alertDiv, headerContainer.nextSibling);
    } else {
        document.body.insertBefore(alertDiv, document.body.firstChild);
    }

    // Auto-remove after a short delay
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
    return text.toString().replace(/[&<>"']/g, m => map[m]);
}
