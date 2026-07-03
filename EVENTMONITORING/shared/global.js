function checkSupabaseConnection() {
    const indicator = document.getElementById('supabaseIndicator');
    
    if (typeof supabaseClient !== 'undefined' && supabaseClient !== null) {
        console.log('✓ Supabase client is connected to:', SUPABASE_CONFIG.projectUrl);
        if (indicator) {
            indicator.classList.add('connected');
            indicator.classList.remove('disconnected');
            indicator.title = 'Supabase Connected';
        }
        return true;
    } else {
        console.error('✗ Supabase client is not initialized');
        if (indicator) {
            indicator.classList.add('disconnected');
            indicator.classList.remove('connected');
            indicator.title = 'Supabase Disconnected';
        }
        return false;
    }
}

function isSuperAdmin() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return false;
    
    try {
        const user = JSON.parse(userStr);
        return user.userType === 'admin' && user.adminLevel === 'super_admin';
    } catch (e) {
        console.error('Error parsing user session:', e);
        return false;
    }
}

function isAdmin() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return false;
    
    try {
        const user = JSON.parse(userStr);
        return user.userType === 'admin';
    } catch (e) {
        console.error('Error parsing user session:', e);
        return false;
    }
}

function isProfessor() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return false;
    
    try {
        const user = JSON.parse(userStr);
        return user.userType === 'professor';
    } catch (e) {
        console.error('Error parsing user session:', e);
        return false;
    }
}

function getCurrentUser() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return null;
    
    try {
        return JSON.parse(userStr);
    } catch (e) {
        console.error('Error parsing user session:', e);
        return null;
    }
}

function getDepartmentLogo() {
    const user = getCurrentUser();
    if (user && user.departmentLogo) {
        return user.departmentLogo;
    }
    // Fallback to default if no department logo
    return '../auth/assets/ccslogo.png';
}

document.addEventListener('DOMContentLoaded', function () {
    checkSupabaseConnection();
    document.addEventListener('click', function(e) {
        const logoutBtn = e.target.closest('.btn-logout');
        if (logoutBtn) {
            e.preventDefault();
            if (confirm('Are you sure you want to log out?')) {
                sessionStorage.removeItem('user');
                const path = window.location.pathname;
                let authPath = '../auth/login.html';
                if (path.includes('/pages/') || path.includes('/includes/')) {
                    authPath = '../../auth/login.html';
                }
                
                window.location.href = authPath;
            }
        }
    });

    const helpBtn = document.querySelector('.help-btn');
    if (helpBtn) {
        helpBtn.addEventListener('click', function () {
            const userStr = sessionStorage.getItem('user');
            let departmentName = 'CCS';
            if (userStr) {
                try {
                    const user = JSON.parse(userStr);
                    if (user.department) {
                        departmentName = user.department;
                    }
                } catch (e) {
                    console.error('Error parsing user:', e);
                }
            }
            alert(`For assistance, please contact the ${departmentName} System Administrator.`);
        });
    }
});
