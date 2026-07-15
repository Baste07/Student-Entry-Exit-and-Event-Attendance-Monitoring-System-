let allAdmins = [];
let currentUser = null;
let isUserSuperAdmin = false;
let adminModal = null;

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
        </tr>
    `).join('');
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
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        allAdmins = (admins || []).map(admin => ({
            id: admin.admin_id,
            name: admin.admin_name || 'N/A',
            email: admin.email,
            faculty: admin.faculty || 'N/A',
            level: admin.admin_level || 'admin',
            status: normalizeStatus(admin.status, 'active'),
            created_at: admin.created_at,
            rawData: admin
        }));

        displayAdmins(allAdmins);
        updateStatistics();
        applyRoleBasedRestrictions();

    } catch (error) {
        console.error('Error loading admins:', error);
        alert('Failed to load admins. Please try again.');
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
                <td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted);">
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
            
            actionButtonsHtml = `<div class="action-buttons">${buttons.join('')}</div>`;
        }

        row.innerHTML = `
            <td style="font-weight:500;">${escapeHtml(admin.name)}</td>
            <td>${escapeHtml(admin.email)}</td>
            <td>${escapeHtml(admin.faculty)}</td>
            <td><span class="badge ${levelBadgeClass}">${levelText}</span></td>
            <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
            <td>${actionButtonsHtml}</td>
        `;

        tbody.appendChild(row);
    });
}

function normalizeStatus(status, fallback = 'active') {
    const normalized = String(status || '').trim().toLowerCase();
    if (['active', 'inactive', 'suspended'].includes(normalized)) return normalized;
    return fallback;
}

async function suspendAdmin(adminId, adminName) {
    if (adminId === currentUser?.id) {
        alert('You cannot suspend your own account.');
        return;
    }
    
    if (!isUserSuperAdmin) {
        alert('Only Super Admins can suspend admin accounts.');
        return;
    }

    if (!confirm(`Are you sure you want to suspend "${adminName}"?\n\nTheir account will be disabled but all data will be retained.`)) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('admins')
            .update({ status: 'suspended', updated_at: new Date().toISOString() })
            .eq('admin_id', adminId);

        if (error) throw error;
        alert(`"${adminName}" has been suspended.`);
        await loadAdmins();
    } catch (error) {
        console.error('Error suspending admin:', error);
        alert('Failed to suspend admin. Please try again.');
    }
}

async function reactivateAdmin(adminId, adminName) {
    if (!isUserSuperAdmin) {
        alert('Only Super Admins can reactivate admin accounts.');
        return;
    }

    if (!confirm(`Reactivate "${adminName}"? Their account will be restored to active status.`)) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('admins')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('admin_id', adminId);

        if (error) throw error;
        alert(`"${adminName}" has been reactivated.`);
        await loadAdmins();
    } catch (error) {
        console.error('Error reactivating admin:', error);
        alert('Failed to reactivate admin. Please try again.');
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
    document.getElementById('adminId').value = '';
    editMode.value = 'false';
    
    if (adminId) {
        const admin = allAdmins.find(a => a.id === adminId);
        if (!admin) return;
        
        if (admin.level === 'super_admin' && !isUserSuperAdmin) {
            alert('Only Super Admins can edit other Super Admins.');
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
    
    const isEdit = document.getElementById('adminEditMode').value === 'true';
    const adminId = document.getElementById('adminId').value;
    
    const name = document.getElementById('adminName').value.trim();
    const email = document.getElementById('adminEmail').value.trim();
    const faculty = document.getElementById('adminFaculty').value.trim();
    const level = document.getElementById('adminLevel').value;
    
    if (!name) { alert('Admin Name is required.'); return; }
    if (!email) { alert('Email is required.'); return; }
    if (!faculty) { alert('Faculty is required.'); return; }
    if (!level) { alert('Admin Level is required.'); return; }
    
    if (level === 'super_admin' && !isUserSuperAdmin) {
        alert('Only Super Admins can create or promote to Super Admin.');
        return;
    }
    
    try {
        if (!supabaseClient) throw new Error('Database connection not available');
        
        if (isEdit) {
            const targetAdmin = allAdmins.find(a => a.id === adminId);
            if (targetAdmin?.level === 'super_admin' && !isUserSuperAdmin) {
                alert('Only Super Admins can modify Super Admin accounts.');
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
            alert('Admin updated successfully!');
        } else {
            const password = document.getElementById('adminPassword').value;
            const passwordConfirm = document.getElementById('adminPasswordConfirm').value;
            
            if (!password) { alert('Password is required.'); return; }
            if (password.length < 8) { alert('Password must be at least 8 characters.'); return; }
            if (password !== passwordConfirm) { alert('Passwords do not match.'); return; }
            
            const { data: existing } = await supabaseClient
                .from('admins')
                .select('email')
                .eq('email', email)
                .maybeSingle();
                
            if (existing) { alert('An admin with this email already exists.'); return; }
            
            const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                email: email,
                password: password
            });
            
            if (authError) throw authError;
            if (!authData.user) throw new Error('Failed to create auth user');
            
            const { error: insertError } = await supabaseClient.from('admins').insert([{
                admin_id: authData.user.id,
                admin_name: name,
                email: email,
                password: password,
                admin_level: level,
                faculty: faculty,
                status: 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
            
            if (insertError) throw insertError;
            alert('Admin created successfully!');
        }
        
        if (adminModal) adminModal.hide();
        document.getElementById('adminForm').reset();
        await loadAdmins();
        
    } catch (error) {
        console.error('Error saving admin:', error);
        alert(`Failed to save admin: ${error.message}`);
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

document.addEventListener('DOMContentLoaded', function () {
    checkSupabaseConnection();
    initializeUserSession();
    
    if (window.bootstrap) {
        const modalEl = document.getElementById('adminModal');
        if (modalEl) adminModal = new bootstrap.Modal(modalEl);
    }
    
    loadAdmins();
    setupSearch();
    setupFilters();
    setupAddUserButton();
    
    document.getElementById('adminForm')?.addEventListener('submit', submitAdminForm);
});