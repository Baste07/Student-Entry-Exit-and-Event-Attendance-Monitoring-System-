let allUsers = [];
let currentUser = null;
let isUserSuperAdmin = false;
let parsedRows = [];
let departmentsCache = [];
let singleUserModal = null;
let editUserModal = null;
let selectedFile = null;

function initializeUserSession() {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
        try {
            currentUser = JSON.parse(userStr);
            isUserSuperAdmin = currentUser.userType === 'admin' && currentUser.adminLevel === 'super_admin';
            console.log('Current user role:', isUserSuperAdmin ? 'Super Admin' : 'Admin');
        } catch (e) {
            console.error('Error parsing user session:', e);
        }
    }
}

async function loadUsers() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data: professors, error: profError } = await supabaseClient
            .from('professors')
            .select(`
                *,
                departments (
                    department_name,
                    department_code
                )
            `)
            .order('created_at', { ascending: false }); 

        if (profError) throw profError;

        const { data: admins, error: adminError } = await supabaseClient
            .from('admins')
            .select(`
                *,
                departments:department_id (
                    department_name,
                    department_code
                )
            `)
            .order('created_at', { ascending: false });

        if (adminError) throw adminError;

        allUsers = [];

        if (professors) {
        professors.forEach(prof => {
            // Format: lastName, firstName middleName suffix
            let fullName = prof.last_name || 'Unknown';
            if (prof.first_name) fullName += `, ${prof.first_name}`;
            if (prof.middle_name) fullName += ` ${prof.middle_name}`;
            if (prof.suffix) fullName += ` ${prof.suffix}`;
            
            allUsers.push({
                id: prof.professor_id,
                type: 'professor',
                name: fullName.trim(),
                email: prof.email,
                role: prof.role || 'faculty',
                department: prof.departments?.department_name || 'N/A',
                status: normalizeUserStatus(prof.status, 'inactive'),
                created_at: prof.created_at,
                rawData: prof
            });
        });
    }

        if (admins) {
            admins.forEach(admin => {
                const adminRole = admin.admin_level === 'super_admin' ? 'super admin' : 'admin';
                
                if (!isUserSuperAdmin && admin.admin_level) {
                    return; 
                }
                
                // Get admin's department or default to Administration
                const adminDepartment = admin.departments?.department_name || 
                                       (admin.admin_level === 'super_admin' ? 'All Departments' : 'N/A');
                
                allUsers.push({
                    id: admin.admin_id,
                    type: 'admin',
                    name: admin.admin_name || 'N/A',
                    email: admin.email,
                    role: adminRole,
                    department: adminDepartment,
                    departmentId: admin.department_id,
                    status: normalizeUserStatus(admin.status, 'active'),
                    created_at: admin.created_at,
                    rawData: admin
                });
            });
        }

        displayUsers(allUsers);
        updateStatistics();
        applyRoleBasedRestrictions();

    } catch (error) {
        console.error('Error loading users:', error);
        alert('Failed to load users. Please try again.');
    }
}

function applyRoleBasedRestrictions() {
    if (!isUserSuperAdmin) {
        const roleFilter = document.querySelector('.role-filter');
        if (roleFilter) {
            const superAdminOption = Array.from(roleFilter.options).find(opt => 
                opt.textContent.toLowerCase() === 'super admin'
            );
            if (superAdminOption) {
                superAdminOption.style.display = 'none';
            }
        }
        
        const addUserBtn = document.querySelector('.btn-add-user');
        if (addUserBtn) {
            const btnText = addUserBtn.textContent.trim();
            if (btnText === 'Add New User') {
                addUserBtn.innerHTML = `
                    <svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                    Add Faculty
                `;
            }
        }
    }
}

function displayUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (users.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">
                    No users found
                </td>
            </tr>
        `;
        return;
    }

    users.forEach(user => {
        const row = document.createElement('tr');
        row.classList.add('searchable-row');
        row.dataset.role = user.role;
        row.dataset.userId = user.id;
        row.dataset.userType = user.type;
        let roleBadgeClass = 'badge-faculty';
        if (user.role === 'admin' || user.role === 'super admin') roleBadgeClass = 'badge-admin';

        let statusBadgeClass = 'badge-inactive';
        let statusText = 'Inactive';
        if (user.status === 'active') { statusBadgeClass = 'badge-active'; statusText = 'Active'; }
        else if (user.status === 'suspended') { statusBadgeClass = 'badge-suspended'; statusText = 'Suspended'; }
        let actionButtons = '';
        const canModify = checkModifyPermission(user);

        let actionButtonsHtml = '';
        
        if (!canModify) {
            actionButtonsHtml = `
                <span style="color:var(--text-muted);font-size:.8rem;font-style:italic;">No permissions</span>
            `;
        } else {
            let buttons = [];
            
            // Edit button (always available for modifiable users, unless super admin)
            if (user.role !== 'super admin') {
                buttons.push(`
                    <button class="btn-icon" title="Edit User" onclick="openEditUserModal('${user.id}', '${user.type}')">
                        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                `);
            }
            
            // Status-dependent buttons
            if (user.status === 'inactive' && user.type === 'professor') {
                // Inactive faculty: approve or reject (suspend)
                buttons.push(`
                    <button class="btn-icon" title="Approve User" onclick="approveUser('${user.id}', '${user.type}')">
                        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </button>
                    <button class="btn-icon danger" title="Reject / Suspend" onclick="suspendUser('${user.id}', '${user.type}', '${user.name}')">
                        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                    </button>
                `);
            } else if (user.status === 'suspended' && user.role !== 'super admin') {
                // Suspended: can only reactivate
                buttons.push(`
                    <button class="btn-icon" title="Reactivate User" onclick="reactivateUser('${user.id}', '${user.type}', '${user.name}')">
                        <svg viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64M3.51 15A9 9 0 0 0 18.36 18.36"/></svg>
                    </button>
                `);
            } else if (user.role !== 'super admin') {
                // Active: can suspend
                buttons.push(`
                    <button class="btn-icon danger" title="Suspend User" onclick="suspendUser('${user.id}', '${user.type}', '${user.name}')">
                        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                    </button>
                `);
            }
            
            actionButtonsHtml = buttons.length > 0 
                ? `<div class="action-buttons">${buttons.join('')}</div>` 
                : '';
        }

        row.innerHTML = `
            <td style="font-weight:500;">${user.name}</td>
            <td>${user.email}</td>
            <td><span class="badge ${roleBadgeClass}">${capitalizeWords(user.role)}</span></td>
            <td>${user.department}</td>
            <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
            <td>${actionButtonsHtml}</td>
        `;

        tbody.appendChild(row);
    });
}

function checkModifyPermission(targetUser) {
    if (isUserSuperAdmin) {
        return true;
    }
    
    if (targetUser.type === 'admin') {
        return false;
    }
    
    return true;
}

function normalizeUserStatus(status, fallbackStatus = 'inactive') {
    const normalized = String(status || '').trim().toLowerCase();

    if (normalized === 'pending') {
        return 'inactive';
    }

    if (normalized === 'active' || normalized === 'inactive' || normalized === 'suspended') {
        return normalized;
    }

    return fallbackStatus;
}

async function approveUser(userId, userType) {
    if (!confirm('Are you sure you want to approve this user?')) {
        return;
    }

    try {
        if (!supabaseClient) {
            throw new Error('Supabase client not initialized');
        }

        const tableName = userType === 'professor' ? 'professors' : 'admins';
        const idColumn = userType === 'professor' ? 'professor_id' : 'admin_id';

        const { error } = await supabaseClient
            .from(tableName)
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq(idColumn, userId);

        if (error) throw error;

        alert('User approved successfully!');
        await loadUsers(); 

    } catch (error) {
        console.error('Error approving user:', error);
        alert('Failed to approve user. Please try again.');
    }
}

async function suspendUser(userId, userType, userName) {
    if (userType === 'admin' && !isUserSuperAdmin) {
        alert('Only Super Admins can suspend admin users.');
        return;
    }

    if (!confirm(`Are you sure you want to suspend "${userName}"?\n\nTheir account will be disabled but all data will be retained. You can reactivate them at any time.`)) {
        return;
    }

    try {
        if (!supabaseClient) {
            throw new Error('Supabase client not initialized');
        }

        const tableName = userType === 'professor' ? 'professors' : 'admins';
        const idColumn = userType === 'professor' ? 'professor_id' : 'admin_id';

        const { error } = await supabaseClient
            .from(tableName)
            .update({ status: 'suspended', updated_at: new Date().toISOString() })
            .eq(idColumn, userId);

        if (error) throw error;

        alert(`"${userName}" has been suspended. Their data remains intact.`);
        await loadUsers();

    } catch (error) {
        console.error('Error suspending user:', error);
        alert('Failed to suspend user. Please try again.');
    }
}

async function reactivateUser(userId, userType, userName) {
    if (userType === 'admin' && !isUserSuperAdmin) {
        alert('Only Super Admins can reactivate admin users.');
        return;
    }

    if (!confirm(`Reactivate "${userName}"? Their account will be restored to active status.`)) {
        return;
    }

    try {
        if (!supabaseClient) {
            throw new Error('Supabase client not initialized');
        }

        const tableName = userType === 'professor' ? 'professors' : 'admins';
        const idColumn = userType === 'professor' ? 'professor_id' : 'admin_id';

        const { error } = await supabaseClient
            .from(tableName)
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq(idColumn, userId);

        if (error) throw error;

        alert(`"${userName}" has been reactivated successfully.`);
        await loadUsers();

    } catch (error) {
        console.error('Error reactivating user:', error);
        alert('Failed to reactivate user. Please try again.');
    }
}

function updateStatistics() {
    const totalUsers = allUsers.length;
    const facultyCount = allUsers.filter(u => u.type === 'professor').length;
    const adminsCount = allUsers.filter(u => u.type === 'admin').length;

    document.getElementById('totalUsersCount').textContent = totalUsers;
    document.getElementById('facultyCount').textContent = facultyCount;
    document.getElementById('adminsCount').textContent = adminsCount;
}

function capitalizeWords(str) {
    return str.replace(/\b\w/g, char => char.toUpperCase());
}

function setupSearch() {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
    }
}

function setupRoleFilter() {
    const roleFilter = document.querySelector('.role-filter');
    if (roleFilter) {
        roleFilter.addEventListener('change', applyFilters);
    }
}

function setupStatusFilter() {
    const statusFilter = document.querySelector('.status-filter');
    if (statusFilter) {
        statusFilter.addEventListener('change', applyFilters);
    }
}

function applyFilters() {
    const roleFilter = document.querySelector('.role-filter');
    const statusFilter = document.querySelector('.status-filter');
    const searchInput = document.querySelector('.search-input');

    const selectedRole = roleFilter ? roleFilter.value.toLowerCase() : 'all roles';
    const selectedStatus = statusFilter ? statusFilter.value.toLowerCase() : 'all statuses';
    const query = searchInput ? searchInput.value.toLowerCase() : '';

    const filtered = allUsers.filter(user => {
        const roleMatch = selectedRole === 'all roles' || user.role.toLowerCase() === selectedRole;
        const statusMatch = selectedStatus === 'all statuses' || user.status.toLowerCase() === selectedStatus;
        const searchMatch = !query ||
            user.name.toLowerCase().includes(query) ||
            user.email.toLowerCase().includes(query) ||
            user.department.toLowerCase().includes(query);
        return roleMatch && statusMatch && searchMatch;
    });

    displayUsers(filtered);
}

function setupAddUserButton() {
    const addUserBtn = document.querySelector('.btn-add-user');
    if (addUserBtn) {
        addUserBtn.addEventListener('click', openSingleUserModal);
    }

    // Role change: swap between faculty fields and admin fields
    document.addEventListener('change', (e) => {
        if (!e.target || e.target.id !== 'singleRole') return;

        const isAdmin = e.target.value === 'admin';
        const isFaculty = e.target.value === 'full_time' || e.target.value === 'part_time';

        const facultyFields   = document.getElementById('facultyFields');
        const adminFields     = document.getElementById('adminFields');
        const passwordNoteBox = document.getElementById('passwordNoteBox');
        const passwordNoteText = document.getElementById('passwordNoteText');

        if (facultyFields) facultyFields.style.display = isFaculty ? '' : 'none';
        if (adminFields)   adminFields.style.display   = isAdmin   ? '' : 'none';

        if (passwordNoteBox) {
            // Only show the note for faculty (admin has explicit password fields)
            passwordNoteBox.style.display = isFaculty ? '' : 'none';
        }
        if (passwordNoteText && isFaculty) {
            passwordNoteText.innerHTML = '<strong>Password Note:</strong> The default password will be set to the Employee ID. Users can reset it after first login.';
        }

        // Clear admin password fields when switching away from admin
        if (!isAdmin) {
            const adminPw = document.getElementById('adminPassword');
            const adminPwC = document.getElementById('adminPasswordConfirm');
            if (adminPw) adminPw.value = '';
            if (adminPwC) adminPwC.value = '';
        }

        // Clear hidden section's inputs to avoid stale values
        if (isAdmin) {
            ['singleEmployeeId','singleFirstName','singleMiddleName','singleLastName','singleSuffix','singleEmail'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        } else {
            ['adminName','adminEmail','adminDepartment'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = id === 'adminDepartment' ? '' : '';
            });
        }
    });
}

// ==================== BULK IMPORT FUNCTIONS ====================

async function loadDepartmentsForImport() {
    try {
        if (!supabaseClient) return;

        const { data: departments, error } = await supabaseClient
            .from('departments')
            .select('id, department_name, department_code')
            .eq('is_active', true)
            .order('department_name', { ascending: true });

        if (error) throw error;

        departmentsCache = departments || [];

        // Populate single user modal department select (faculty)
        const singleDeptSelect = document.getElementById('singleDepartment');
        if (singleDeptSelect) {
            singleDeptSelect.innerHTML = '<option value="">Select a department...</option>';
            departmentsCache.forEach(dept => {
                const opt = document.createElement('option');
                opt.value = dept.id;
                opt.textContent = `${dept.department_name} (${dept.department_code})`;
                singleDeptSelect.appendChild(opt);
            });
        }

        // Populate admin department select
        const adminDeptSelect = document.getElementById('adminDepartment');
        if (adminDeptSelect) {
            adminDeptSelect.innerHTML = '<option value="">Select a department...</option>';
            departmentsCache.forEach(dept => {
                const opt = document.createElement('option');
                opt.value = dept.id;
                opt.textContent = `${dept.department_name} (${dept.department_code})`;
                adminDeptSelect.appendChild(opt);
            });
        }

        const editDeptSelects = [
            document.getElementById('editProfessorDepartment'),
            document.getElementById('editAdminDepartment')
        ];

        editDeptSelects.forEach(select => {
            if (!select) return;

            const currentValue = select.value;
            select.innerHTML = '<option value="">Select a department...</option>';
            departmentsCache.forEach(dept => {
                const opt = document.createElement('option');
                opt.value = dept.id;
                opt.textContent = `${dept.department_name} (${dept.department_code})`;
                select.appendChild(opt);
            });
            select.value = currentValue;
        });
    } catch (err) {
        console.error('Error loading departments:', err);
    }
}

function setupBulkImportEventListeners() {
    const dropZone = document.getElementById('fileDropZone');
    const fileInput = document.getElementById('fileInput');
    const removeBtn = document.getElementById('fileRemoveBtn');
    const parseBtn = document.getElementById('parseFileBtn');
    const backUpload = document.getElementById('backToUploadBtn');
    const proceedBtn = document.getElementById('proceedImportBtn');
    const anotherBtn = document.getElementById('importAnotherBtn');
    const closeBulkBtn = document.getElementById('closeBulkImportBtn');
    const downloadTemplateBtn = document.getElementById('downloadUserTemplateBtn');
    const singleUserForm = document.getElementById('singleUserForm');

    if (window.bootstrap) {
        const modalElement = document.getElementById('singleUserModal');
        if (modalElement) {
            singleUserModal = new bootstrap.Modal(modalElement);
        }
        const editModalElement = document.getElementById('editUserModal');
        if (editModalElement) {
            editUserModal = new bootstrap.Modal(editModalElement);
        }
    }

    // Drop zone click
    dropZone?.addEventListener('click', (e) => {
        if (e.target.closest('.file-remove')) return;
        fileInput.click();
    });

    // Drag & drop
    dropZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFileSelected(file);
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
    anotherBtn?.addEventListener('click', resetBulkImport);
    closeBulkBtn?.addEventListener('click', closeBulkImportSection);
    downloadTemplateBtn?.addEventListener('click', downloadUserTemplate);
    singleUserForm?.addEventListener('submit', submitSingleUserForm);
    document.getElementById('editUserForm')?.addEventListener('submit', submitEditUserForm);
}

function closeBulkImportSection() {
    showStep('upload');
    resetBulkImport();
}

function handleFileSelected(file) {
    const allowedExts = ['.xlsx', '.xls', '.csv'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

    if (!allowedExts.includes(ext)) {
        alert('Invalid file type. Please upload .xlsx, .xls, or .csv files only.');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        alert('File too large. Maximum allowed size is 10MB.');
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
                alert('The file appears to be empty or has no data rows.');
                return;
            }

            rows = raw.slice(1).map(r => ({
                employeeId: String(r[0] || '').trim(),
                lastName:   String(r[1] || '').trim(),
                firstName:  String(r[2] || '').trim(),
                middleName: String(r[3] || '').trim(),
                suffix:     String(r[4] || '').trim(),
                email:      String(r[5] || '').trim(),
                role:       String(r[6] || '').trim(),
                department: String(r[7] || '').trim(),
            }));
        }

    rows = rows.filter(r => r.employeeId || r.firstName || r.lastName);

        if (rows.length === 0) {
            alert('No data rows found. Make sure you have data below the header row.');
            return;
        }

        parsedRows = rows.map((r, i) => validateUserRow(r, i));

        renderPreview();
        showStep('preview');

    } catch (err) {
        console.error('Parse error:', err);
        alert('Failed to parse file: ' + err.message);
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
            role:       cols[6] || '',
            department: cols[7] || '',
        };
    });
}

function validateUserRow(row, index) {
    const errors = [];
    const warnings = [];

    if (!row.employeeId) {
        errors.push('Employee ID is required');
    }

    if (!row.firstName) {
        errors.push('First Name is required');
    }

    if (!row.lastName) {
        errors.push('Last Name is required');
    }

    if (!row.email) {
        errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        warnings.push('Email format looks invalid');
    }

    if (!row.role) {
        errors.push('Role is required');
    } else {
        const validRoles = ['full_time', 'part_time', 'admin'];
        if (!validRoles.includes(row.role.toLowerCase())) {
            errors.push(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
        }
    }

    if (!row.department) {
        errors.push('Department is required');
    } else {
        const dept = departmentsCache.find(d => 
            d.department_name.toLowerCase() === row.department.toLowerCase() ||
            d.department_code.toLowerCase() === row.department.toLowerCase()
        );
        if (!dept) {
            errors.push(`Department not found: ${row.department}`);
        }
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
        password: row.employeeId
    };
}

function renderPreview() {
    const tbody = document.getElementById('previewTableBody');
    const valid = parsedRows.filter(r => r.status !== 'error').length;
    const errors = parsedRows.filter(r => r.status === 'error').length;

    document.getElementById('validCount').textContent = valid;
    document.getElementById('errorCount').textContent = errors;

    const proceedBtn = document.getElementById('proceedImportBtn');
    if (parsedRows.length === 0) {
        proceedBtn.disabled = true;
        proceedBtn.title = 'No new users available for import';
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
                <td colspan="8" style="text-align:center;padding:1.5rem;color:var(--text-muted);">
                    No users available for import.
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

        return `
            <tr class="${rowClass}">
                <td style="color:var(--text-muted);font-size:0.8rem;">${row.rowIndex}</td>
                <td><strong>${escapeHtml(row.employeeId)}</strong>${errorNote}</td>
                <td>${escapeHtml(row.lastName)}</td>
                <td>${escapeHtml(row.firstName)}</td>
                <td>${escapeHtml(row.middleName || '—')}</td>
                <td>${escapeHtml(row.suffix || '—')}</td>
                <td style="font-size:0.82rem;">${escapeHtml(row.email)}</td>
                <td>${capitalizeWords(row.role)}</td>
                <td>${escapeHtml(row.department)}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    }).join('');
}

async function startImport() {
    const validRows = parsedRows.filter(r => r.status !== 'error');

    if (validRows.length === 0) {
        alert('No valid rows to import.');
        return;
    }

    const proceedBtn = document.getElementById('proceedImportBtn');
    proceedBtn.disabled = true;
    proceedBtn.textContent = 'Importing...';

    let success = 0;
    let failed = 0;

    try {
        const employeeIds = validRows.map(r => r.employeeId);
        const { data: existingProfs } = await supabaseClient
            .from('professors')
            .select('employee_id')
            .in('employee_id', employeeIds);
        const existingProfIds = new Set((existingProfs || []).map(p => p.employee_id));

        const { data: existingAdmins } = await supabaseClient
            .from('admins')
            .select('employee_id')
            .in('employee_id', employeeIds);
        const existingAdminIds = new Set((existingAdmins || []).map(a => a.employee_id));

        for (let i = 0; i < validRows.length; i++) {
            const row = validRows[i];

            try {
                const dept = departmentsCache.find(d => 
                    d.department_name.toLowerCase() === row.department.toLowerCase() ||
                    d.department_code.toLowerCase() === row.department.toLowerCase()
                );
                
                if (!dept) {
                    throw new Error(`Department not found: ${row.department}`);
                }

                if (existingProfIds.has(row.employeeId) || existingAdminIds.has(row.employeeId)) {
                    throw new Error('Employee ID already exists');
                }

                const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                    email: row.email,
                    password: row.password
                });

                if (authError) throw authError;
                if (!authData.user) throw new Error('Failed to create auth user');

                const authUserId = authData.user.id;

                let userType = 'professor';
                if (row.role.toLowerCase() === 'admin') {
                    userType = 'admin';
                }

                const userData = {
                    employee_id: row.employeeId,
                    first_name: row.firstName,
                    middle_name: row.middleName || null,
                    last_name: row.lastName,
                    suffix: row.suffix || null,
                    email: row.email,
                    password: row.password,
                    department_id: dept.id,
                    status: 'inactive',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };

                let res;
                if (userType === 'admin') {
                    userData.admin_id = authUserId;
                    userData.admin_level = 'admin';
                    userData.admin_name = `${row.firstName} ${row.lastName}`;
                    res = await supabaseClient
                        .from('admins')
                        .insert([userData]);
                } else {
                    userData.professor_id = authUserId;
                    userData.role = row.role.toLowerCase();
                    res = await supabaseClient
                        .from('professors')
                        .insert([userData]);
                }

                if (res.error) throw res.error;
                success++;

            } catch (err) {
                failed++;
                console.error(`Error importing row ${row.rowIndex}:`, err);
            }
        }

        showStep('success');
        document.getElementById('successMessage').textContent = 
            `Successfully imported ${success} user${success !== 1 ? 's' : ''}${failed > 0 ? `. ${failed} failed.` : '.'}`;

        if (success > 0) {
            await loadUsers();
        }

    } catch (error) {
        console.error('Import error:', error);
        alert(`Import failed: ${error.message}`);
    } finally {
        proceedBtn.disabled = false;
        proceedBtn.textContent = 'Import Users';
    }
}

function openSingleUserModal() {
    if (singleUserModal) {
        singleUserModal.show();
    }
}

function openEditUserModal(userId, userType) {
    const user = allUsers.find(item => String(item.id) === String(userId) && item.type === userType);
    if (!user || !editUserModal) return;

    document.getElementById('editUserForm')?.reset();
    document.getElementById('editUserId').value = user.id;
    document.getElementById('editUserType').value = user.type;
    document.getElementById('editUserStatus').value = user.status || 'inactive';

    const title = document.getElementById('editUserModalLabel');
    const submitBtn = document.getElementById('editUserSubmitBtn');
    if (title) title.textContent = user.type === 'admin' ? 'Edit Admin' : 'Edit Faculty';
    if (submitBtn) submitBtn.textContent = 'Save Changes';

    const editProfessorFields = document.getElementById('editProfessorFields');
    const editAdminFields = document.getElementById('editAdminFields');

    if (user.type === 'admin') {
        if (editProfessorFields) editProfessorFields.style.display = 'none';
        if (editAdminFields) editAdminFields.style.display = '';

        document.getElementById('editAdminName').value = user.rawData.admin_name || user.name || '';
        document.getElementById('editAdminEmail').value = user.email || '';
        document.getElementById('editAdminDepartment').value = String(user.rawData.department_id || '');
    } else {
        if (editProfessorFields) editProfessorFields.style.display = '';
        if (editAdminFields) editAdminFields.style.display = 'none';

        document.getElementById('editEmployeeId').value = user.rawData.employee_id || '';
        document.getElementById('editFirstName').value = user.rawData.first_name || '';
        document.getElementById('editMiddleName').value = user.rawData.middle_name || '';
        document.getElementById('editLastName').value = user.rawData.last_name || '';
        document.getElementById('editSuffix').value = user.rawData.suffix || '';
        document.getElementById('editProfessorEmail').value = user.email || '';
        document.getElementById('editProfessorDepartment').value = String(user.rawData.department_id || '');
    }

    editUserModal.show();
}

async function submitSingleUserForm(e) {
    e.preventDefault();

    const role = document.getElementById('singleRole').value;
    const isAdmin = role === 'admin';

    try {
        if (!supabaseClient) throw new Error('Database connection not available');

        if (isAdmin) {
            // ── ADMIN PATH (admins table) ──
            const adminName    = document.getElementById('adminName').value.trim();
            const adminEmail   = document.getElementById('adminEmail').value.trim();
            const departmentId = document.getElementById('adminDepartment').value;

            if (!adminName)    { alert('Admin Name is required.'); return; }
            if (!adminEmail)   { alert('Email is required.'); return; }
            if (!departmentId) { alert('Department is required.'); return; }

            const adminPassword = document.getElementById('adminPassword')?.value || '';
            const adminPasswordConfirm = document.getElementById('adminPasswordConfirm')?.value || '';

            if (!adminPassword) { alert('Password is required.'); return; }
            if (adminPassword.length < 8) { alert('Password must be at least 8 characters.'); return; }
            if (adminPassword !== adminPasswordConfirm) { alert('Passwords do not match.'); return; }

            const { data: existing } = await supabaseClient
                .from('admins').select('email').eq('email', adminEmail).maybeSingle();
            if (existing) { alert('An admin with this email already exists.'); return; }

            const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                email: adminEmail,
                password: adminPassword
            });
            if (authError) throw authError;
            if (!authData.user) throw new Error('Failed to create auth user');

            const { error: insertError } = await supabaseClient.from('admins').insert([{
                admin_id:      authData.user.id,
                admin_name:    adminName,
                email:         adminEmail,
                password:      adminPassword,
                admin_level:   'admin',
                department_id: departmentId,
                status:        'active',
                created_at:    new Date().toISOString(),
                updated_at:    new Date().toISOString()
            }]);
            if (insertError) throw insertError;

        } else {
            // ── FACULTY PATH (professors table) ──
            const employeeId = document.getElementById('singleEmployeeId').value.trim();
            const firstName  = document.getElementById('singleFirstName').value.trim();
            const middleName = document.getElementById('singleMiddleName').value.trim();
            const lastName   = document.getElementById('singleLastName').value.trim();
            const suffix     = document.getElementById('singleSuffix')?.value.trim() || '';
            const email      = document.getElementById('singleEmail').value.trim();
            const departmentId = document.getElementById('singleDepartment').value;

            if (!employeeId)   { alert('Employee ID is required.'); return; }
            if (!firstName)    { alert('First Name is required.'); return; }
            if (!lastName)     { alert('Last Name is required.'); return; }
            if (!email)        { alert('Email is required.'); return; }
            if (!departmentId) { alert('Department is required.'); return; }

            const { data: existingProf } = await supabaseClient
                .from('professors').select('email').eq('email', email).maybeSingle();
            const { data: existingAdmin } = await supabaseClient
                .from('admins').select('email').eq('email', email).maybeSingle();
            if (existingProf || existingAdmin) { alert('An account with this email already exists.'); return; }

            const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                email, password: employeeId
            });
            if (authError) throw authError;
            if (!authData.user) throw new Error('Failed to create auth user');

            const { error: insertError } = await supabaseClient.from('professors').insert([{
                professor_id:  authData.user.id,
                employee_id:   employeeId,
                first_name:    firstName,
                middle_name:   middleName || null,
                last_name:     lastName,
                suffix:        suffix || null,
                email,
                password:      employeeId,
                role,
                department_id: departmentId,
                status:        'inactive',
                created_at:    new Date().toISOString(),
                updated_at:    new Date().toISOString()
            }]);
            if (insertError) throw insertError;
        }

        alert('User created successfully!' + (isAdmin ? '' : ' They will need to be approved by an admin before accessing the system.'));

        if (singleUserModal) singleUserModal.hide();
        document.getElementById('singleUserForm').reset();

        // Reset form UI back to default state
        const facultyFields = document.getElementById('facultyFields');
        const adminFields   = document.getElementById('adminFields');
        const noteBox       = document.getElementById('passwordNoteBox');
        const adminPw       = document.getElementById('adminPassword');
        const adminPwC      = document.getElementById('adminPasswordConfirm');
        if (facultyFields) facultyFields.style.display = 'none';
        if (adminFields)   adminFields.style.display   = 'none';
        if (noteBox)       noteBox.style.display       = 'none';
        if (adminPw)       adminPw.value               = '';
        if (adminPwC)      adminPwC.value              = '';

        await loadUsers();

    } catch (error) {
        console.error('Error creating user:', error);
        alert(`Failed to create user: ${error.message}`);
    }
}

async function submitEditUserForm(e) {
    e.preventDefault();

    const userId = String(document.getElementById('editUserId')?.value || '').trim();
    const userType = String(document.getElementById('editUserType')?.value || '').trim();
    const status = String(document.getElementById('editUserStatus')?.value || 'inactive').trim();

    if (!userId || !userType) {
        alert('Unable to edit this user. Missing user information.');
        return;
    }

    try {
        if (!supabaseClient) throw new Error('Database connection not available');

        const tableName = userType === 'professor' ? 'professors' : 'admins';
        const idColumn = userType === 'professor' ? 'professor_id' : 'admin_id';

        let updatePayload = {
            status,
            updated_at: new Date().toISOString()
        };

        if (userType === 'admin') {
            const adminName = String(document.getElementById('editAdminName')?.value || '').trim();
            const departmentId = String(document.getElementById('editAdminDepartment')?.value || '').trim();

            if (!adminName) {
                alert('Admin Name is required.');
                return;
            }
            if (!departmentId) {
                alert('Department is required.');
                return;
            }

            updatePayload = {
                ...updatePayload,
                admin_name: adminName,
                department_id: departmentId
            };
        } else {
            const firstName = String(document.getElementById('editFirstName')?.value || '').trim();
            const middleName = String(document.getElementById('editMiddleName')?.value || '').trim();
            const lastName = String(document.getElementById('editLastName')?.value || '').trim();
            const suffix = String(document.getElementById('editSuffix')?.value || '').trim();
            const departmentId = String(document.getElementById('editProfessorDepartment')?.value || '').trim();

            if (!firstName) {
                alert('First Name is required.');
                return;
            }
            if (!lastName) {
                alert('Last Name is required.');
                return;
            }
            if (!departmentId) {
                alert('Department is required.');
                return;
            }

            updatePayload = {
                ...updatePayload,
                first_name: firstName,
                middle_name: middleName || null,
                last_name: lastName,
                suffix: suffix || null,
                department_id: departmentId
            };
        }

        const { error } = await supabaseClient
            .from(tableName)
            .update(updatePayload)
            .eq(idColumn, userId);

        if (error) throw error;

        alert('User updated successfully!');
        editUserModal?.hide();
        await loadUsers();
    } catch (error) {
        console.error('Error updating user:', error);
        alert(`Failed to update user: ${error.message}`);
    }
}

function showStep(step) {
    document.getElementById('stepUpload').style.display = step === 'upload' ? 'block' : 'none';
    document.getElementById('stepPreview').style.display = step === 'preview' ? 'block' : 'none';
    document.getElementById('stepSuccess').style.display = step === 'success' ? 'block' : 'none';
}

function goBackToUpload() {
    showStep('upload');
}

function resetBulkImport() {
    clearFileSelection();
    parsedRows = [];
    selectedFile = null;
    document.getElementById('fileInput').value = '';
    showStep('upload');
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Helper function for the upcoming Add User modal - loads departments for dropdown
async function loadDepartmentsForUserForm() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return [];
        }

        const { data: departments, error } = await supabaseClient
            .from('departments')
            .select('id, department_name, department_code')
            .eq('is_active', true)
            .order('department_name', { ascending: true });

        if (error) throw error;

        return departments || [];
    } catch (error) {
        console.error('Error loading departments:', error);
        return [];
    }
}

// Helper function to validate if a department admin can manage a specific user
function canManageUser(targetUser, currentAdminUser) {
    // Super admins can manage anyone
    if (currentAdminUser.adminLevel === 'super_admin') {
        return true;
    }

    // Department admins can only manage users in their department
    if (currentAdminUser.adminLevel === 'admin' && currentAdminUser.departmentId) {
        // For admins: check if they share the same department
        if (targetUser.type === 'admin') {
            return targetUser.departmentId === currentAdminUser.departmentId;
        }
        // For faculty: check if faculty's department matches admin's department
        if (targetUser.type === 'professor') {
            return targetUser.rawData?.department_id === currentAdminUser.departmentId;
        }
    }

    return false;
}

function downloadUserTemplate() {
    const headers = [
        'Employee ID',
        'Last Name',
        'First Name',
        'Middle Name',
        'Suffix',
        'Email',
        'Role',
        'Department'
    ];

    const sampleRows = [
        ['12345', 'Dela Cruz', 'Juan', 'Santos', '', 'juan.delacruz@plpasig.edu.ph', 'full_time', 'College of Computer Studies'],
        ['12346', 'Cruz', 'Maria', 'Reyes', 'Jr.', 'maria.cruz@plpasig.edu.ph', 'part_time', 'College of Business and Accountancy'],
        ['12347', 'Reyes', 'Jose', '', '', 'jose.reyes@plpasig.edu.ph', 'admin', 'College of Arts and Sciences']
    ];

    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
        XLSX.utils.book_append_sheet(wb, ws, 'Users');
        XLSX.writeFile(wb, 'user-import-template.xlsx');
        return;
    }

    // Fallback to CSV if XLSX is not available
    const csv = [headers, ...sampleRows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'user-import-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', function () {
    checkSupabaseConnection();
    initializeUserSession();
    loadUsers();
    setupSearch();
    setupRoleFilter();
    setupStatusFilter();
    setupAddUserButton();
    loadDepartmentsForImport();
    setupBulkImportEventListeners();
});