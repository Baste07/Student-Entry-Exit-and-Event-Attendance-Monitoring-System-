function checkAdminSession() {
    const user = sessionStorage.getItem('user');
    if (!user) {
        window.location.href = '../auth/login.html';
        return false;
    }
    return true;
}

function requireAdmin() {
    const userStr = sessionStorage.getItem('user');
    
    if (!userStr) {
        window.location.href = '../auth/login.html';
        return false;
    }
    
    if (!isAdmin()) {
        alert('Access denied. This page is restricted to Administrators only.');
        window.location.href = '../portal/portal.html';
        return false;
    }
    return true;
}

function requireSuperAdmin() {
    const userStr = sessionStorage.getItem('user');
    
    if (!userStr) {
        window.location.href = '../auth/login.html';
        return false;
    }
    
    if (!isSuperAdmin()) {
        alert('Access denied. This page is restricted to Super Administrators only.');
        window.location.href = '../portal/portal.html';
        return false;
    }
    return true;
}

function loadHeader() {
    const headerContainer = document.getElementById('header-container');
    if (!headerContainer) return;

    const userStr = sessionStorage.getItem('user');
    let subtitle = 'Administration';
    let userDisplay = 'Administrator';
    let departmentLogo = '../auth/assets/ccslogo.png';
    let siteName = 'SAMS Admin Panel';

    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            if (user.adminLevel === 'super_admin') {
                subtitle = 'Super Administrator — Full System Access';
                userDisplay = 'Super Admin';
            } else {
                subtitle = 'Administrator';
                userDisplay = 'Admin';
                
                // For department admins, show which department they manage
                if (user.department) {
                    subtitle = `${user.department} Administrator`;
                }
            }
            
            // Update site name and logo based on department
            if (user.department) {
                siteName = `${user.department} — Admin Panel`;
            }
            
            if (user.departmentLogo) {
                departmentLogo = user.departmentLogo;
            }
        } catch (e) {
            console.error('Error parsing user:', e);
        }
    }

    headerContainer.innerHTML = `
        <header class="topbar">
            <div class="topbar-left">
                <img src="../auth/assets/plplogo.png" alt="PLP Logo" class="topbar-logo"/>
                <img src="${departmentLogo}" alt="Department Logo" class="topbar-logo-ccs"/>
                <div class="topbar-info">
                    <div class="topbar-title">${siteName}</div>
                    <div class="topbar-subtitle" id="topbarSubtitle">${subtitle}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:1rem;">
                <div id="notificationBellContainer"></div>
                <div class="supabase-indicator" id="supabaseIndicator" title="Checking Connection...">
                    <div class="status-light"></div>
                </div>
                <button class="btn-logout">
                    <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    Log Out
                </button>
            </div>
        </header>
    `;
    // Update connection indicator now that the header (and element) exists
    if (typeof checkSupabaseConnection === 'function') {
        checkSupabaseConnection();
    }
}
function loadSidebar(activePage = '') {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer) return;

    const userStr = sessionStorage.getItem('user');
    let isSuperAdmin = false;
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            isSuperAdmin = user.adminLevel === 'super_admin';
        } catch (e) {
            console.error('Error parsing user:', e);
        }
    }

    const userManagementClass = activePage === 'usermanagement' ? 'active' : '';
    const departmentManagementClass = activePage === 'admin-section-management' ? 'active' : '';
    const systemSettingsClass = activePage === 'system-settings' ? 'active' : '';
    const studentImportClass = activePage === 'student-import' ? 'active' : '';
    const subjectsClass = activePage === 'admin-subjects' ? 'active' : ''; // <--- NEW

    const backToPortalLink = isSuperAdmin ? '' : `
            <a href="../portal/portal.html" class="nav-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                Back to Portal
            </a>`;

    const departmentManagementLink = isSuperAdmin ? `
            <a href="admin-section-management.html" class="nav-item ${departmentManagementClass}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                Section Import
            </a>` : '';

    // <--- NEW: SUBJECTS LINK FOR SUPER ADMINS --->
    const subjectsLink = isSuperAdmin ? `
            <a href="admin-subjects.html" class="nav-item ${subjectsClass}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                Subjects Management
            </a>` : '';

    const systemSettingsLink = isSuperAdmin ? `
            <a href="system-settings.html" class="nav-item ${systemSettingsClass}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24"/></svg>
                System Settings
            </a>` : '';

    sidebarContainer.innerHTML = `
        <nav class="sidebar">
            ${backToPortalLink}
            <a href="usermanagement.html" class="nav-item ${userManagementClass}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                User Management
            </a>
            <a href="student-import.html" class="nav-item ${studentImportClass}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Student Import
            </a>
            ${departmentManagementLink}
            ${subjectsLink}
            ${systemSettingsLink}
        </nav>
    `;
}

document.addEventListener('DOMContentLoaded', function () {
    checkAdminSession();
});