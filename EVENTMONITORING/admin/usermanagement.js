let allAdmins = [];
let currentUser = null;
let isUserSuperAdmin = false;
let adminModal = null;
let adminEmailModal = null;
const pendingAdminDeletions = new Set();
const pendingAdminStatusChanges = new Set();
let savingAdmin = false;
let savingAdminEmail = false;
let mfaLoadVersion = 0;

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

function renderAdminsSkeleton() {
    const tbody = document.getElementById('adminsTableBody');
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
        </tr>
    `).join('');
}

async function mfaAdminRequest(action, adminId) {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Please sign in again.');
    const response = await fetch(window.AppDeployment.apiRoute('admin-mfa-factors.php'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
            'Authorization': `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ action, adminId })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.message || 'Authenticator service unavailable.');
    return result;
}

async function loadAdminMfaStatuses() {
    if (!isUserSuperAdmin) return;
    const version = ++mfaLoadVersion;
    await Promise.all(allAdmins.map(async admin => {
        try {
            const status = await mfaAdminRequest('status', admin.id);
            if (version === mfaLoadVersion) admin.mfaEnabled = status.enabled === true;
        } catch (_) {
            if (version === mfaLoadVersion) admin.mfaEnabled = 'unavailable';
        }
    }));
    if (version === mfaLoadVersion) applyFilters();
}

async function resetAdminMfa(adminId) {
    const admin = allAdmins.find(item => item.id === adminId);
    if (!admin || !isUserSuperAdmin || adminId === currentUser?.id || admin.mfaEnabled !== true) return;
    if (!await UIFeedback.confirm({
        title: 'Reset Administrator Authenticator',
        message: `Remove ${admin.name}'s authenticator? Their current sessions will be downgraded and they must enroll a new authenticator at next login.`,
        confirmText: 'Reset MFA', type: 'danger'
    })) return;
    try {
        const result = await mfaAdminRequest('reset', adminId);
        UIFeedback.success(result.message, 'Authenticator reset');
        await loadAdminMfaStatuses();
    } catch (error) {
        UIFeedback.error(error.message, 'Reset failed');
    }
}

async function loadAdmins() {
    renderAdminsSkeleton();

    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data: admins, error } = await supabaseClient
            .from('admins')
            .select('admin_id,admin_name,email,faculty,admin_level,status,created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        allAdmins = (admins || []).map(admin => ({
            id: admin.admin_id,
            name: admin.admin_name || 'N/A',
            email: admin.email,
            faculty: admin.faculty || 'N/A',
            level: admin.admin_level || 'admin',
            status: normalizeStatus(admin.status, 'active'),
            mfaEnabled: null,
            created_at: admin.created_at,
            rawData: admin
        }));

        applyFilters();
        updateStatistics();
        applyRoleBasedRestrictions();
        await loadAdminMfaStatuses();

    } catch (error) {
        console.error('Error loading admins:', error);
        UIFeedback.error('Administrators could not be loaded. Please try again.', 'Load failed');
    }
}

function applyRoleBasedRestrictions() {
    if (!isUserSuperAdmin) {
        const levelFilter = document.querySelector('.level-filter');
        if (levelFilter) {
            const superAdminOption = Array.from(levelFilter.options).find(opt => 
                opt.value === 'super_admin'
            );
            if (superAdminOption) superAdminOption.style.display = 'none';
        }
        
        const levelSelect = document.getElementById('adminLevel');
        if (levelSelect) {
            const superOption = levelSelect.querySelector('option[value="super_admin"]');
            if (superOption) superOption.style.display = 'none';
        }
    }
}

function displayAdmins(admins) {
    const tbody = document.getElementById('adminsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (admins.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;padding:2rem;color:var(--text-muted);">
                    No admins found
                </td>
            </tr>
        `;
        return;
    }

    admins.forEach(admin => {
        const row = document.createElement('tr');
        row.classList.add('searchable-row');
        row.dataset.level = admin.level;
        row.dataset.adminId = admin.id;

        const levelBadgeClass = admin.level === 'super_admin' ? 'badge-admin' : 'badge-faculty';
        const levelText = admin.level === 'super_admin' ? 'Super Admin' : 'Admin';

        let statusBadgeClass = 'badge-inactive';
        let statusText = 'Inactive';
        if (admin.status === 'active') { statusBadgeClass = 'badge-active'; statusText = 'Active'; }
        else if (admin.status === 'suspended') { statusBadgeClass = 'badge-suspended'; statusText = 'Suspended'; }

        const canModify = isUserSuperAdmin || admin.level !== 'super_admin';
        
        let actionButtonsHtml = '';
        if (!canModify) {
            actionButtonsHtml = `<span style="color:var(--text-muted);font-size:.8rem;font-style:italic;">No permissions</span>`;
        } else {
            let buttons = [];
            
            buttons.push(`
                <button class="btn-icon" title="Edit Admin" onclick="openAdminModal('${admin.id}')">
                    <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
            `);

            if (isUserSuperAdmin) {
                buttons.push(`
                    <button type="button" class="btn-icon btn-change-admin-email" title="Change Email" aria-label="Change email for ${escapeHtml(admin.name)}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 6 10 7 10-7"/></svg>
                    </button>
                `);
            }
            
            if (admin.status === 'suspended') {
                buttons.push(`
                    <button class="btn-icon" title="Reactivate Admin" onclick="reactivateAdmin('${admin.id}', '${escapeHtml(admin.name)}')">
                        <svg viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64M3.51 15A9 9 0 0 0 18.36 18.36"/></svg>
                    </button>
                `);
            } else if (admin.status !== 'suspended' && admin.id !== currentUser?.id) {
                buttons.push(`
                    <button class="btn-icon danger" title="Suspend Admin" onclick="suspendAdmin('${admin.id}', '${escapeHtml(admin.name)}')">
                        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                    </button>
                `);
            }
            
            if (isUserSuperAdmin && currentUser?.id && admin.id !== currentUser.id) {
                if (admin.mfaEnabled === true) {
                    buttons.push(`<button type="button" class="btn-icon btn-reset-mfa" title="Reset MFA" aria-label="Reset MFA for ${escapeHtml(admin.name)}">🔐</button>`);
                }
                buttons.push(`
                    <button type="button" class="btn-icon danger btn-delete-admin" title="Delete Admin" aria-label="Delete Admin"
                        ${pendingAdminDeletions.has(admin.id) ? 'disabled' : ''}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7"/></svg>
                    </button>
                `);
            }

            actionButtonsHtml = `<div class="action-buttons">${buttons.join('')}</div>`;
        }

        row.innerHTML = `
            <td style="font-weight:500;">${escapeHtml(admin.name)}</td>
            <td>${escapeHtml(admin.email)}</td>
            <td>${escapeHtml(admin.faculty)}</td>
            <td><span class="badge ${levelBadgeClass}">${levelText}</span></td>
            <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
            <td>${admin.mfaEnabled === true ? 'Enabled' : admin.mfaEnabled === false ? 'Setup Required' : admin.mfaEnabled === 'unavailable' ? 'Unavailable' : 'Checking…'}</td>
            <td>${actionButtonsHtml}</td>
        `;

        row.querySelector('.btn-delete-admin')?.addEventListener('click', () => deleteAdmin(admin.id));
        row.querySelector('.btn-reset-mfa')?.addEventListener('click', () => resetAdminMfa(admin.id));
        row.querySelector('.btn-change-admin-email')?.addEventListener('click', () => openAdminEmailModal(admin.id));
        tbody.appendChild(row);
    });
}

function openAdminEmailModal(adminId) {
    if (!isUserSuperAdmin || !adminEmailModal) return;
    const admin = allAdmins.find(item => item.id === adminId);
    if (!admin) return;
    const form = document.getElementById('adminEmailForm');
    form.reset();
    UIFeedback.clearFormErrors(form);
    document.getElementById('emailAdminId').value = admin.id;
    document.getElementById('oldAdminEmail').value = admin.email;
    adminEmailModal.show();
}

async function submitAdminEmailForm(event) {
    event.preventDefault();
    if (savingAdminEmail || !isUserSuperAdmin) return;
    const form = event.currentTarget;
    UIFeedback.clearFormErrors(form);
    const adminId = document.getElementById('emailAdminId').value;
    const emailField = document.getElementById('newAdminEmail');
    const email = emailField.value.trim().toLowerCase();
    const admin = allAdmins.find(item => item.id === adminId);
    if (!admin || !emailField.checkValidity()) {
        UIFeedback.fieldError(emailField, 'Enter a valid email address.');
        return;
    }
    if (email === admin.email.toLowerCase()) {
        UIFeedback.fieldError(emailField, 'Enter a different email address.');
        return;
    }
    if (!document.getElementById('confirmAdminEmail').checked) {
        UIFeedback.fieldError(document.getElementById('confirmAdminEmail'), 'Verify the address before confirming it.');
        return;
    }
    if (!await UIFeedback.confirm({
        title: 'Confirm Email Change',
        message: `Change ${admin.name}'s sign-in email from ${admin.email} to ${email}? The new address will be confirmed immediately. Their password, authenticator, and account ID will stay the same.`,
        confirmText: 'Change Email', type: 'warning'
    })) return;

    savingAdminEmail = true;
    const button = document.getElementById('changeAdminEmailBtn');
    button.disabled = true;
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error || !data?.session?.access_token) throw new Error('Please sign in again.');
        const response = await fetch(window.AppDeployment.apiRoute('update-admin-email.php'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json',
                'Authorization': `Bearer ${data.session.access_token}` },
            body: JSON.stringify({ adminId, email, confirmEmail: true })
        });
        const result = await response.json();
        if (!response.ok || result?.success !== true) {
            if (result?.changed) await loadAdmins();
            throw new Error(result?.message || 'The email could not be changed.');
        }
        adminEmailModal.hide();
        await loadAdmins();
        UIFeedback.success(result.message, 'Email changed');
    } catch (error) {
        UIFeedback.error(error.message, 'Email change failed');
    } finally {
        savingAdminEmail = false;
        button.disabled = false;
    }
}

function normalizeStatus(status, fallback = 'active') {
    const normalized = String(status || '').trim().toLowerCase();
    if (['active', 'inactive', 'suspended'].includes(normalized)) return normalized;
    return fallback;
}

async function deleteAdmin(adminId) {
    if (!isUserSuperAdmin || !currentUser?.id) {
        UIFeedback.warning('Only Super Admins can delete administrator accounts.', 'Access denied');
        return;
    }

    if (adminId === currentUser.id) {
        UIFeedback.warning('You cannot delete your own account.', 'Action unavailable');
        return;
    }

    if (pendingAdminDeletions.has(adminId)) return;

    const admin = allAdmins.find(item => item.id === adminId);
    if (!admin) {
        UIFeedback.warning('This administrator is no longer in the list. Refresh and try again.', 'Account unavailable');
        return;
    }

    if (!await UIFeedback.confirm({
        title: 'Delete Administrator',
        message: `Permanently delete "${admin.name}" (${admin.email})?\n\nThis removes their admin profile and sign-in account. This action cannot be undone.`,
        confirmText: 'Delete',
        type: 'danger'
    })) {
        return;
    }

    pendingAdminDeletions.add(adminId);
    applyFilters();

    try {
        if (!supabaseClient) throw new Error('Database connection not available.');

        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        const session = data?.session;
        if (!session?.access_token || session.user?.id !== currentUser.id) {
            throw new Error('Please sign in again before deleting an admin.');
        }

        const response = await fetch(window.AppDeployment.apiRoute('delete-admin.php'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ adminId })
        });
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error('The account deletion service could not be reached. Please try again.');
        }

        if (!response.ok || result?.success !== true) {
            throw new Error(result?.message || 'Failed to delete admin. Please try again.');
        }

        allAdmins = allAdmins.filter(item => item.id !== adminId);
        updateStatistics();
        applyFilters();
        UIFeedback.success(`"${admin.name}" has been deleted.`, 'Administrator deleted');
    } catch (error) {
        console.error('Error deleting admin:', error);
        UIFeedback.error('The administrator could not be deleted. Please check your session and try again.', 'Delete failed');
    } finally {
        pendingAdminDeletions.delete(adminId);
        applyFilters();
    }
}

async function suspendAdmin(adminId, adminName) {
    if (pendingAdminStatusChanges.has(adminId)) return;
    if (adminId === currentUser?.id) {
        UIFeedback.warning('You cannot suspend your own account.', 'Action unavailable');
        return;
    }
    
    if (!isUserSuperAdmin) {
        UIFeedback.warning('Only Super Admins can suspend administrator accounts.', 'Access denied');
        return;
    }

    pendingAdminStatusChanges.add(adminId);
    if (!await UIFeedback.confirm({
        title: 'Suspend Administrator',
        message: `Suspend "${adminName}"? Their account will be disabled but all data will be retained.`,
        confirmText: 'Suspend',
        type: 'warning'
    })) {
        pendingAdminStatusChanges.delete(adminId);
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('admins')
            .update({ status: 'suspended', updated_at: new Date().toISOString() })
            .eq('admin_id', adminId);

        if (error) throw error;
        UIFeedback.success(`"${adminName}" has been suspended.`, 'Account suspended');
        await loadAdmins();
    } catch (error) {
        console.error('Error suspending admin:', error);
        UIFeedback.error('The administrator could not be suspended. Please try again.', 'Suspend failed');
    } finally {
        pendingAdminStatusChanges.delete(adminId);
    }
}

async function reactivateAdmin(adminId, adminName) {
    if (pendingAdminStatusChanges.has(adminId)) return;
    if (!isUserSuperAdmin) {
        UIFeedback.warning('Only Super Admins can reactivate administrator accounts.', 'Access denied');
        return;
    }

    pendingAdminStatusChanges.add(adminId);
    if (!await UIFeedback.confirm({
        title: 'Reactivate Administrator',
        message: `Reactivate "${adminName}"? Their account will be restored to active status.`,
        confirmText: 'Reactivate',
        type: 'info'
    })) {
        pendingAdminStatusChanges.delete(adminId);
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('admins')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('admin_id', adminId);

        if (error) throw error;
        UIFeedback.success(`"${adminName}" has been reactivated.`, 'Account reactivated');
        await loadAdmins();
    } catch (error) {
        console.error('Error reactivating admin:', error);
        UIFeedback.error('The administrator could not be reactivated. Please try again.', 'Reactivation failed');
    } finally {
        pendingAdminStatusChanges.delete(adminId);
    }
}

function updateStatistics() {
    const total = allAdmins.length;
    const superCount = allAdmins.filter(a => a.level === 'super_admin').length;
    const regularCount = allAdmins.filter(a => a.level === 'admin').length;

    document.getElementById('totalAdminsCount').textContent = total;
    document.getElementById('superAdminCount').textContent = superCount;
    document.getElementById('regularAdminCount').textContent = regularCount;
}

function setupSearch() {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) searchInput.addEventListener('input', applyFilters);
}

function setupFilters() {
    const levelFilter = document.querySelector('.level-filter');
    const statusFilter = document.querySelector('.status-filter');
    if (levelFilter) levelFilter.addEventListener('change', applyFilters);
    if (statusFilter) statusFilter.addEventListener('change', applyFilters);
}

function applyFilters() {
    const levelFilter = document.querySelector('.level-filter');
    const statusFilter = document.querySelector('.status-filter');
    const searchInput = document.querySelector('.search-input');

    const selectedLevel = levelFilter ? levelFilter.value.toLowerCase() : 'all levels';
    const selectedStatus = statusFilter ? statusFilter.value.toLowerCase() : 'all statuses';
    const query = searchInput ? searchInput.value.toLowerCase() : '';

    const filtered = allAdmins.filter(admin => {
        const levelMatch = selectedLevel === 'all levels' || admin.level.toLowerCase() === selectedLevel;
        const statusMatch = selectedStatus === 'all statuses' || admin.status.toLowerCase() === selectedStatus;
        const searchMatch = !query ||
            admin.name.toLowerCase().includes(query) ||
            admin.email.toLowerCase().includes(query) ||
            admin.faculty.toLowerCase().includes(query);
        return levelMatch && statusMatch && searchMatch;
    });

    displayAdmins(filtered);
}

function setupAddUserButton() {
    const addBtn = document.querySelector('.btn-add-user');
    if (addBtn) addBtn.addEventListener('click', () => openAdminModal());
}

function openAdminModal(adminId = null) {
    const form = document.getElementById('adminForm');
    const modalLabel = document.getElementById('adminModalLabel');
    const submitBtn = document.getElementById('adminSubmitBtn');
    const editMode = document.getElementById('adminEditMode');
    const statusField = document.getElementById('statusField');
    const passwordField = document.getElementById('passwordField');
    const confirmPasswordField = document.getElementById('confirmPasswordField');
    
    form.reset();
    UIFeedback.clearFormErrors(form);
    document.getElementById('adminId').value = '';
    editMode.value = 'false';
    
    if (adminId) {
        const admin = allAdmins.find(a => a.id === adminId);
        if (!admin) return;
        
        if (admin.level === 'super_admin' && !isUserSuperAdmin) {
            UIFeedback.warning('Only Super Admins can edit other Super Admins.', 'Access denied');
            return;
        }
        
        modalLabel.textContent = 'Edit Admin';
        submitBtn.textContent = 'Save Changes';
        editMode.value = 'true';
        
        document.getElementById('adminId').value = admin.id;
        document.getElementById('adminName').value = admin.name;
        document.getElementById('adminEmail').value = admin.email;
        document.getElementById('adminFaculty').value = admin.faculty === 'N/A' ? '' : admin.faculty;
        document.getElementById('adminLevel').value = admin.level;
        document.getElementById('adminStatus').value = admin.status;
        
        statusField.style.display = 'block';
        passwordField.style.display = 'none';
        confirmPasswordField.style.display = 'none';
        document.getElementById('adminEmail').readOnly = true;
    } else {
        modalLabel.textContent = 'Add New Admin';
        submitBtn.textContent = 'Create Admin';
        statusField.style.display = 'none';
        passwordField.style.display = 'block';
        confirmPasswordField.style.display = 'block';
        document.getElementById('adminEmail').readOnly = false;
    }
    
    if (adminModal) adminModal.show();
}

async function submitAdminForm(e) {
    e.preventDefault();
    if (savingAdmin) return;
    UIFeedback.clearFormErrors(e.currentTarget);
    
    const isEdit = document.getElementById('adminEditMode').value === 'true';
    const adminId = document.getElementById('adminId').value;
    
    const name = document.getElementById('adminName').value.trim();
    const email = document.getElementById('adminEmail').value.trim();
    const faculty = document.getElementById('adminFaculty').value.trim();
    const level = document.getElementById('adminLevel').value;
    
    if (!name) { UIFeedback.fieldError(document.getElementById('adminName'), 'Admin name is required.'); return; }
    if (!email) { UIFeedback.fieldError(document.getElementById('adminEmail'), 'Email is required.'); return; }
    if (!faculty) { UIFeedback.fieldError(document.getElementById('adminFaculty'), 'Faculty is required.'); return; }
    if (!level) { UIFeedback.fieldError(document.getElementById('adminLevel'), 'Admin level is required.'); return; }
    
    if (level === 'super_admin' && !isUserSuperAdmin) {
        UIFeedback.toast({ type: 'warning', title: 'Access denied', message: 'Only Super Admins can create or promote to Super Admin.' });
        return;
    }
    
    let savedMessage = '';
    savingAdmin = true;
    const submitButton = document.getElementById('adminSubmitBtn');
    if (submitButton) submitButton.disabled = true;
    try {
        if (!supabaseClient) throw new Error('Database connection not available');
        
        if (isEdit) {
            const targetAdmin = allAdmins.find(a => a.id === adminId);
            if (targetAdmin?.level === 'super_admin' && !isUserSuperAdmin) {
                UIFeedback.toast({ type: 'warning', title: 'Access denied', message: 'Only Super Admins can modify Super Admin accounts.' });
                return;
            }
            
            const status = document.getElementById('adminStatus').value;
            
            const { error } = await supabaseClient
                .from('admins')
                .update({
                    admin_name: name,
                    faculty: faculty,
                    admin_level: level,
                    status: status,
                    updated_at: new Date().toISOString()
                })
                .eq('admin_id', adminId);
                
            if (error) throw error;
            savedMessage = 'Administrator updated successfully.';
        } else {
            const password = document.getElementById('adminPassword').value;
            const passwordConfirm = document.getElementById('adminPasswordConfirm').value;
            
            if (!password) { UIFeedback.fieldError(document.getElementById('adminPassword'), 'Password is required.'); return; }
            if (password.length < 8) { UIFeedback.fieldError(document.getElementById('adminPassword'), 'Password must be at least 8 characters.'); return; }
            if (password !== passwordConfirm) { UIFeedback.fieldError(document.getElementById('adminPasswordConfirm'), 'Passwords do not match.'); return; }
            
            const { data: authSession, error: sessionError } = await supabaseClient.auth.getSession();
            if (sessionError || !authSession?.session?.access_token) {
                throw new Error('Please sign in again before creating an administrator.');
            }
            const response = await fetch(window.AppDeployment.apiRoute('create-admin.php'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authSession.session.access_token}`
                },
                body: JSON.stringify({ name, email, faculty, level, password })
            });
            const result = await response.json();
            if (!response.ok || result?.success !== true) {
                throw new Error(result?.message || 'The administrator could not be created.');
            }
            savedMessage = 'Administrator created. Google Authenticator setup will be required at first login.';
        }
        
        if (adminModal) adminModal.hide();
        document.getElementById('adminForm').reset();
        UIFeedback.success(savedMessage, isEdit ? 'Administrator updated' : 'Administrator created');
        await loadAdmins();
        
    } catch (error) {
        console.error('Error saving admin:', error);
        UIFeedback.toast({ type: 'error', title: 'Save failed', message: 'The administrator could not be saved. Please try again.' });
    } finally {
        savingAdmin = false;
        if (submitButton) submitButton.disabled = false;
    }
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

document.addEventListener('DOMContentLoaded', async function () {
    if (window.adminMfaRouteReady && !await window.adminMfaRouteReady) return;
    checkSupabaseConnection();
    initializeUserSession();
    
    if (window.bootstrap) {
        const modalEl = document.getElementById('adminModal');
        if (modalEl) adminModal = new bootstrap.Modal(modalEl);
        const emailModalEl = document.getElementById('adminEmailModal');
        if (emailModalEl) adminEmailModal = new bootstrap.Modal(emailModalEl);
    }
    
    loadAdmins();
    setupSearch();
    setupFilters();
    setupAddUserButton();
    
    document.getElementById('adminForm')?.addEventListener('submit', submitAdminForm);
    document.getElementById('adminEmailForm')?.addEventListener('submit', submitAdminEmailForm);
});
