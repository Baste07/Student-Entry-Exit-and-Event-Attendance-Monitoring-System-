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
    showAdminCardIfNeeded();
    setThesisLink();
    setFacultyRequirementLink();
    setViolationLink();
    setTimeInOutLink();

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

    const cards = document.querySelectorAll('.system-card');
    cards.forEach(function (card) {
        card.addEventListener('click', function (e) {
            card.style.opacity = '0.8';
            card.style.transform = 'scale(0.98)';
            setTimeout(function () {
                card.style.opacity = '';
                card.style.transform = '';
            }, 200);
        });
    });

});

function showAdminCardIfNeeded() {
    const user = getCurrentUser();
    if (!user) return;

    const cards = document.querySelectorAll('.system-card');

    const userType = (user.userType || '').toLowerCase();
    const role = (user.role || '').toLowerCase();
    const adminLevel = (user.adminLevel || '').toLowerCase();

    const isStudent = userType === 'student' || role === 'student';
    const isProfessor = userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean';
    const isAdmin = userType === 'admin' || role === 'admin' || role === 'super_admin' || adminLevel === 'super_admin';

    // Students can access Thesis/Capstone, Student Violation, and Time In/Out.
    if (isStudent) {
        cards.forEach(card => {
            const href = card.getAttribute('href') || '';
            const isThesis = href.includes('ThesisAndCapstoneArchiving');
            const isViolation = href.includes('StudentViolationManagementSystem');
            const isTimeInOut = href.includes('TimeInAndTimeOutMonitoring');
            const isTimeInOutCard = isTimeInOut;

                const canShow = (isThesis && moduleEnabledForHref(href)) ||
                                (isViolation && moduleEnabledForHref(href)) ||
                                isTimeInOutCard;
                card.style.display = canShow ? 'block' : 'none';
        });
        return;
    }

    // Professors/Faculty can access Thesis/Capstone, Faculty Requirement, and Time In/Out.
    if (isProfessor) {
        cards.forEach(card => {
            const href = card.getAttribute('href') || '';
            const isThesis = href.includes('ThesisAndCapstoneArchiving');
            const isFacultyRequirement = href.includes('FacultyRequirementSubmissionSystem');
            const isTimeInOut = href.includes('TimeInAndTimeOutMonitoring');
            const isTimeInOutCard = isTimeInOut;

                const canShow = ((isThesis && moduleEnabledForHref(href)) ||
                                 (isFacultyRequirement && moduleEnabledForHref(href)) ||
                                 isTimeInOutCard);
                card.style.display = canShow ? 'block' : 'none';
        });
        return;
    }

    // Admins keep full portal visibility.
    if (isAdmin) {
        cards.forEach(card => {
            card.style.display = 'block';
        });
        return;
    }

    // Unknown roles are restricted by default.
    cards.forEach(card => {
        card.style.display = 'none';
    });
}


function moduleEnabledForHref(href) {
    if (!systemFeatures) return true; // default to enabled when features not loaded
    try {
        if (href.includes('FacultyRequirementSubmissionSystem')) return systemFeatures.faculty_requirements !== false;
        if (href.includes('TimeInAndTimeOutMonitoring')) return systemFeatures.time_monitoring !== false;
        if (href.includes('ThesisAndCapstoneArchiving')) return systemFeatures.thesis_archiving !== false;
        if (href.includes('StudentViolationManagementSystem')) return systemFeatures.student_violations !== false;
    } catch (e) {
        console.error('Error checking moduleEnabledForHref:', e);
    }
    return true;
}

function checkUserSession() {
    const user = sessionStorage.getItem('user');
    if (!user) {
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
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const userNameEl = document.querySelector('.user-name');
            if (userNameEl) {
                const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
                userNameEl.textContent = fullName;
            }
            
            const userRoleEl = document.querySelector('.user-role');
            if (userRoleEl) {
                // Prefer userType over role, and filter out employment types
                let displayRole = user.userType || user.role;
                if (displayRole && (displayRole.toUpperCase() === 'FULL_TIME' || displayRole.toUpperCase() === 'PART_TIME')) {
                    displayRole = '';
                }
                if (displayRole) {
                    userRoleEl.textContent = capitalizeFirst(displayRole);
                } else {
                    userRoleEl.textContent = '';
                }
            }

            const userAvatarEl = document.querySelector('.user-avatar');
            if (userAvatarEl) {
                const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
                const initials = getInitials(fullName);
                userAvatarEl.textContent = initials;
            }
        } catch (e) {
            console.error('Error parsing user session:', e);
        }
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function getInitials(name) {
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
}

function setThesisLink() {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const thesisCard = document.querySelector('a[href*="ThesisAndCapstoneArchiving"]');
            const userType = (user.userType || '').toLowerCase();
            const role = (user.role || '').toLowerCase();

            if (thesisCard) {
                if (!moduleEnabledForHref(thesisCard.getAttribute('href') || '')) {
                    thesisCard.style.display = 'none';
                    return;
                }
                if (userType === 'student' || role === 'student') {
                    thesisCard.href = '../ThesisAndCapstoneArchiving/pages/student/dashboard.html';
                } else if (userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean') {
                    thesisCard.href = '../ThesisAndCapstoneArchiving/pages/professor/dashboard.html';
                } else {
                    thesisCard.href = '../ThesisAndCapstoneArchiving/pages/admin/dashboard.html';
                }
            }
        } catch (e) {
            console.error('Error setting thesis link:', e);
        }
    }
}

function setFacultyRequirementLink() {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const userType = (user.userType || '').toLowerCase();
            const role = (user.role || '').toLowerCase();
            console.log('User data:', user);
            console.log('User type:', userType);
            console.log('User role:', role);
            
            const facultyCard = document.querySelector('a[href*="FacultyRequirementSubmissionSystem"]');
            if (facultyCard && !moduleEnabledForHref(facultyCard.getAttribute('href') || '')) {
                facultyCard.style.display = 'none';
                return;
            }
            
            if (facultyCard) {
                if (userType === 'professor' && role === 'dean') {
                    console.log('Setting link for DEAN to faculty-upload.html');
                    facultyCard.href = '../FacultyRequirementSubmissionSystem/pages/faculty-upload.html';
                } else if (userType === 'professor') {
                    console.log('Setting link for PROFESSOR to faculty-upload.html');
                    facultyCard.href = '../FacultyRequirementSubmissionSystem/pages/faculty-upload.html';
                } else {
                    console.log('Setting link for ADMIN to dashboard.html');
                    facultyCard.href = '../FacultyRequirementSubmissionSystem/pages/dashboard.html';
                }
                console.log('Final card href:', facultyCard.href);
            }
        } catch (e) {
            console.error('Error setting faculty requirement link:', e);
        }
    }
}

function setViolationLink() {
    const userStr = sessionStorage.getItem('user');
    if (!userStr) return;

    try {
        const user = JSON.parse(userStr);
        const violationCard = document.querySelector('a[href*="StudentViolationManagementSystem"]');

        if (!violationCard) return;
        if (!moduleEnabledForHref(violationCard.getAttribute('href') || '')) {
            violationCard.style.display = 'none';
            return;
        }

        const role = (user.role || '').toLowerCase();

        console.log('Role:', role);

        if (role === 'student') {
            violationCard.href = '../StudentViolationManagementSystem/pages/student/dashboard.html';

        } else if (role === 'admin' || role === 'super_admin') {
            violationCard.href = '../StudentViolationManagementSystem/pages/admin/dashboard.html';

        } else {
            violationCard.style.display = 'none'; 
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
        const timeInOutCard = document.querySelector('a[href*="TimeInAndTimeOutMonitoring"]');

        if (!timeInOutCard) return;

        const userType = (user.userType || '').toLowerCase();
        const role = (user.role || '').toLowerCase();
        const adminLevel = (user.adminLevel || '').toLowerCase();

        const isStudent = userType === 'student' || role === 'student';
        const isProfessor = userType === 'professor' || role === 'professor' || role === 'faculty' || role === 'dean';
        const isAdmin = userType === 'admin' || role === 'admin' || role === 'super_admin' || adminLevel === 'super_admin';

        if (isAdmin) {
            timeInOutCard.style.display = 'block';
            timeInOutCard.href = '../TimeInAndTimeOutMonitoring/admin/dashboard.html';
            return;
        }

        if (!moduleEnabledForHref(timeInOutCard.getAttribute('href') || '')) {
            timeInOutCard.style.display = 'none';
            return;
        }

        if (isStudent || isProfessor) {
            timeInOutCard.href = '../TimeInAndTimeOutMonitoring/students/homepage.html';
        } else {
            timeInOutCard.style.display = 'none';
        }
    } catch (e) {
        console.error('Error setting Time In/Out link:', e);
    }
}