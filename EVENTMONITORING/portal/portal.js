console.log('=== PORTAL.JS LOADED ===');

let systemFeatures = null;

async function loadSystemFeatures() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('system_settings')
            .select('features')
            .single();
        if (error) throw error;
        if (data && data.features) {
            systemFeatures = typeof data.features === 'string' ? JSON.parse(data.features) : data.features;
        } else {
            systemFeatures = {};
        }
    } catch (e) {
        console.error('Error loading system features:', e);
        systemFeatures = {};
    }
}

document.addEventListener('DOMContentLoaded', async function () {
    console.log('=== DOMContentLoaded fired ===');
    checkUserSession();
    await loadSystemFeatures();
    loadDepartmentLogoAndInfo();
    displayUserInfo();

    // 1. Set hrefs only — never touch visibility here
    setThesisLink();
    setFacultyRequirementLink();
    setViolationLink();
    setTimeInOutLink();

    // 2. ONE function decides who sees what
    filterCardsByRole();

    // Help button
    const helpBtn = document.querySelector('.help-btn');
    if (helpBtn) {
        helpBtn.addEventListener('click', function () {
            const userStr = sessionStorage.getItem('user');
            let departmentName = 'CCS';
            if (userStr) {
                try {
                    const user = JSON.parse(userStr);
                    if (user.department) departmentName = user.department;
                } catch (e) { /* ignore */ }
            }
            alert(`For assistance, please contact the ${departmentName} System Administrator.`);
        });
    }

    // Card click animation
    document.querySelectorAll('.system-card').forEach(function (card) {
        card.addEventListener('click', function (e) {
            if (card.getAttribute('href') === '#') {
                e.preventDefault();
                return;
            }
            card.style.opacity = '0.8';
            card.style.transform = 'scale(0.98)';
            setTimeout(function () {
                card.style.opacity = '';
                card.style.transform = '';
            }, 200);
        });
    });
});

/* ── SINGLE SOURCE OF TRUTH for card visibility ── */
function filterCardsByRole() {
    const user = getCurrentUser();
    if (!user) {
        document.querySelectorAll('.system-card').forEach(c => c.style.display = 'none');
        return;
    }

    const userType = (user.userType || '').toLowerCase();
    const role     = (user.role     || '').toLowerCase();
    const adminLevel = (user.adminLevel || '').toLowerCase();

    const isStudent    = userType === 'student' || role === 'student';
    const isProfessor  = userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean';
    const isAdmin      = role === 'admin';
    const isSuperAdmin = role === 'super_admin' || adminLevel === 'super_admin';

    console.log('[Portal] Role — student:', isStudent, 'prof:', isProfessor, 'admin:', isAdmin, 'super:', isSuperAdmin);

    document.querySelectorAll('.system-card').forEach(card => {
        const href = card.getAttribute('href') || '';
        const isEvent      = card.classList.contains('event-attendance-card');
        const isEntry      = card.classList.contains('entry-exit-card');
        const isSuperPanel = card.classList.contains('superadmin-panel-card');
        const isThesis     = href.includes('ThesisAndCapstoneArchiving');
        const isFaculty    = href.includes('FacultyRequirementSubmissionSystem');
        const isViolation  = href.includes('StudentViolationManagementSystem');
        const isTimeInOut  = href.includes('TimeInAndTimeOutMonitoring');

        let show = false;

        if (isSuperAdmin) {
            // Superadmin: Event + Entry Exit + Superadmin panel
            show = isEvent || isEntry || isSuperPanel;
        } else if (isAdmin) {
            // Admin: Event + Entry Exit only
            show = isEvent || isEntry;
        } else if (isStudent) {
            show = (isThesis     && moduleEnabledForHref(href)) ||
                   (isViolation  && moduleEnabledForHref(href)) ||
                   (isTimeInOut  && moduleEnabledForHref(href));
        } else if (isProfessor) {
            show = (isThesis     && moduleEnabledForHref(href)) ||
                   (isFaculty    && moduleEnabledForHref(href)) ||
                   (isTimeInOut  && moduleEnabledForHref(href));
        }

        card.style.display = show ? 'block' : 'none';
        console.log('[Portal] Card', href || '(no href)', '→', show ? 'SHOW' : 'HIDE');
    });
}

function moduleEnabledForHref(href) {
    if (!systemFeatures) return true;
    try {
        if (href.includes('FacultyRequirementSubmissionSystem')) return systemFeatures.faculty_requirements !== false;
        if (href.includes('TimeInAndTimeOutMonitoring'))         return systemFeatures.time_monitoring       !== false;
        if (href.includes('ThesisAndCapstoneArchiving'))         return systemFeatures.thesis_archiving     !== false;
        if (href.includes('StudentViolationManagementSystem'))   return systemFeatures.student_violations   !== false;
    } catch (e) {
        console.error('Error checking moduleEnabledForHref:', e);
    }
    return true;
}

function checkUserSession() {
    if (!sessionStorage.getItem('user')) {
        window.location.href = '../auth/login.html';
    }
}

function getCurrentUser() {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
        try {
            return JSON.parse(userStr);
        } catch (e) {
            console.error('Error parsing user:', e);
            return null;
        }
    }
    return null;
}

function loadDepartmentLogoAndInfo() {
    const user = getCurrentUser();
    if (user && user.departmentLogo) {
        const deptLogo = document.getElementById('deptLogoPortal');
        if (deptLogo) {
            deptLogo.src = user.departmentLogo;
            deptLogo.alt = user.department || 'Department Logo';
        }
        const deptName = document.getElementById('deptNamePortal');
        if (deptName && user.department) {
            deptName.textContent = `Pamantasan ng Lungsod ng Pasig — ${user.department}`;
        }
    }
}

function displayUserInfo() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;
    try {
        const user = JSON.parse(userStr);
        const userNameEl = document.querySelector('.user-name');
        if (userNameEl) {
            userNameEl.textContent = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
        }
        const userRoleEl = document.querySelector('.user-role');
        if (userRoleEl) {
            let displayRole = user.userType || user.role;
            if (displayRole && (displayRole.toUpperCase() === 'FULL_TIME' || displayRole.toUpperCase() === 'PART_TIME')) {
                displayRole = '';
            }
            userRoleEl.textContent = displayRole ? capitalizeFirst(displayRole) : '';
        }
        const userAvatarEl = document.querySelector('.user-avatar');
        if (userAvatarEl) {
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
            userAvatarEl.textContent = getInitials(fullName);
        }
    } catch (e) {
        console.error('Error parsing user session:', e);
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function getInitials(name) {
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
}

/* ── Link setters: ONLY change href, never style.display ── */
function setThesisLink() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;
    try {
        const user = JSON.parse(userStr);
        const card = document.querySelector('a[href*="ThesisAndCapstoneArchiving"]');
        if (!card) return;
        const userType = (user.userType || '').toLowerCase();
        const role = (user.role || '').toLowerCase();
        if (userType === 'student' || role === 'student') {
            card.href = '../ThesisAndCapstoneArchiving/pages/student/dashboard.html';
        } else if (userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean') {
            card.href = '../ThesisAndCapstoneArchiving/pages/professor/dashboard.html';
        } else {
            card.href = '../ThesisAndCapstoneArchiving/pages/admin/dashboard.html';
        }
    } catch (e) {
        console.error('Error setting thesis link:', e);
    }
}

function setFacultyRequirementLink() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;
    try {
        const user = JSON.parse(userStr);
        const userType = (user.userType || '').toLowerCase();
        const role = (user.role || '').toLowerCase();
        const card = document.querySelector('a[href*="FacultyRequirementSubmissionSystem"]');
        if (!card) return;
        if (userType === 'professor' || role === 'professor' || role === 'dean') {
            card.href = '../FacultyRequirementSubmissionSystem/pages/faculty-upload.html';
        } else {
            card.href = '../FacultyRequirementSubmissionSystem/pages/dashboard.html';
        }
    } catch (e) {
        console.error('Error setting faculty requirement link:', e);
    }
}

function setViolationLink() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;
    try {
        const user = JSON.parse(userStr);
        const card = document.querySelector('a[href*="StudentViolationManagementSystem"]');
        if (!card) return;
        const role = (user.role || '').toLowerCase();
        if (role === 'student') {
            card.href = '../StudentViolationManagementSystem/pages/student/dashboard.html';
        } else if (role === 'admin' || role === 'super_admin') {
            card.href = '../StudentViolationManagementSystem/pages/admin/dashboard.html';
        }
    } catch (e) {
        console.error('Error setting violation link:', e);
    }
}

function setTimeInOutLink() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;
    try {
        const user = JSON.parse(userStr);
        const card = document.querySelector('a[href*="TimeInAndTimeOutMonitoring"]');
        if (!card) return;
        const userType = (user.userType || '').toLowerCase();
        const role = (user.role || '').toLowerCase();
        const isStudent   = userType === 'student' || role === 'student';
        const isProfessor = userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean';
        if (isStudent || isProfessor) {
            card.href = '../TimeInAndTimeOutMonitoring/students/homepage.html';
        }
        // Admin / Superadmin: card is hidden by filterCardsByRole, no href needed
    } catch (e) {
        console.error('Error setting Time In/Out link:', e);
    }
}