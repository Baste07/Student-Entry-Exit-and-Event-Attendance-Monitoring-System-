/* ============================================================
   StudentEntryExit/includes/sidebar.js
   Shared utility for every admin page in this module.

   Usage (bottom of each page's <body>):
     loadHeader();
     loadSidebar('dashboard');

   Page keys → data-page values in sidebar.html:
     dashboard | students | entry-exit-logs | reports | settings
============================================================ */

const INCLUDES_PATH = '../includes/';

/* ── loadHeader ── */
async function loadHeader() {
    const container = document.getElementById('header-container');
    if (!container) return;
    try {
        const res  = await fetch(`${INCLUDES_PATH}header.html`);
        const html = await res.text();
        container.innerHTML = html;
        _startClock();
        applyDepartmentLogoToHeader();
        _forceSameTabNavigation(container);
    } catch (err) {
        console.error('[sidebar.js] Could not load header.html:', err);
    }
}

function applyDepartmentLogoToHeader() {
    try {
        const userStr = sessionStorage.getItem('user');
        if (!userStr) return;
        const user = JSON.parse(userStr);

        const deptLogo = document.getElementById('dept-logo');
        if (deptLogo && user.departmentLogo) {
            deptLogo.src = user.departmentLogo;
            deptLogo.alt = user.departmentCode || 'Department Logo';
        }

        const panelLabel = document.getElementById('header-panel-label');
        if (panelLabel) {
            const userType = (user.userType || '').toLowerCase();
            if (userType === 'student') {
                panelLabel.textContent = 'Student Panel';
            } else if (userType === 'teacher') {
                panelLabel.textContent = 'Teacher Panel';
            } else if (user.adminLevel === 'super_admin') {
                panelLabel.textContent = 'Super Admin Panel';
            } else {
                panelLabel.textContent = 'Admin Panel';
            }
        }
    } catch (e) {
        console.error('[Header] Failed to apply department logo:', e);
    }
}

/* ── loadSidebar ── */
async function loadSidebar(activePage = '') {
    const container = document.getElementById('sidebar-container');
    if (!container) return;
    try {
        const res  = await fetch(`${INCLUDES_PATH}sidebar.html`);
        const html = await res.text();
        container.innerHTML = html;

        if (activePage) {
            const active = container.querySelector(`[data-page="${activePage}"]`);
            if (active) active.classList.add('active');
        }

        _initSidebarPush();
        _forceSameTabNavigation(container);
    } catch (err) {
        console.error('[sidebar.js] Could not load sidebar.html:', err);
    }
}

/* ── Logout ── */
function logout() {
    window.location.href = '../../auth/login.html';
}

/* ── Manila clock ── */
function _startClock() {
    function tick() {
        const now    = new Date();
        const manila = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));

        let hours  = manila.getHours();
        const mm   = String(manila.getMinutes()).padStart(2, '0');
        const ss   = String(manila.getSeconds()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;

        const timeEl = document.getElementById('manilaTime');
        const dateEl = document.getElementById('manilaDate');
        if (timeEl) timeEl.textContent = `${hours}:${mm}:${ss} ${ampm}`;
        if (dateEl) dateEl.textContent = manila.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
    }
    tick();
    setInterval(tick, 1000);
}

/* ── Sidebar hover → push main content ── */
function _initSidebarPush() {
    const sidebar     = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    if (!sidebar || !mainContent) return;
    sidebar.addEventListener('mouseenter', () => mainContent.classList.add('sidebar-open'));
    sidebar.addEventListener('mouseleave', () => mainContent.classList.remove('sidebar-open'));
}

/* ── Force all nav links to stay in same tab ── */
function _forceSameTabNavigation(scope = document) {
    scope.querySelectorAll('header a, .header-right a, .top-left a, .sidebar-nav a, .sidebar a').forEach(link => {
        if (link.getAttribute('target') === '_blank') {
            link.setAttribute('target', '_self');
        }
        link.addEventListener('click', function (e) {
            if (e.ctrlKey || e.metaKey || e.button === 1) {
                e.preventDefault();
                window.location.href = this.href;
            }
        });
    });
}