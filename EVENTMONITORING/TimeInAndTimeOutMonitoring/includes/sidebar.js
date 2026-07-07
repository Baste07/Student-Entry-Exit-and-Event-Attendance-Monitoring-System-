/* ============================================================
   includes/sidebar.js
   Shared utility called by every admin page.

   Usage (bottom of each page's <body>):
     loadHeader();
     loadSidebar('dashboard');   ← pass the page key

   Page keys must match the data-page attribute in sidebar.html:
     dashboard | students | teachers | sections | guardians |
     daily-attendance | events | event-attendance |
     sms-notifications | attendance-reports
============================================================ */

/* ── Resolve the base path to /includes/ regardless of nesting ──
   All admin pages live in /admin/, so the includes folder is one
   level up.  Adjust INCLUDES_PATH if your folder structure changes. */
const INCLUDES_PATH = '../includes/';

/* ── loadHeader ──────────────────────────────────────────────── */
async function loadHeader() {
    const container = document.getElementById('header-container');
    if (!container) return;

    try {
        const res  = await fetch(`${INCLUDES_PATH}header.html`);
        const html = await res.text();
        container.innerHTML = html;

        // Start the Manila clock once the header DOM exists
        _startClock();
    } catch (err) {
        console.error('[sidebar.js] Could not load header.html:', err);
    }
      // Add this at the end, after the HTML is injected into the DOM:
    applyDepartmentLogoToHeader();
}

function applyDepartmentLogoToHeader() {
    try {
        const userStr = sessionStorage.getItem('user');
        if (!userStr) return;

        const user = JSON.parse(userStr);

        // Swap department logo
        const deptLogo = document.getElementById('dept-logo');
        if (deptLogo && user.departmentLogo) {
            deptLogo.src = user.departmentLogo;
            deptLogo.alt = user.departmentCode || 'Department Logo';
        }

        // Update panel label based on role
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

/* ── loadSidebar ─────────────────────────────────────────────── */
async function loadSidebar(activePage = '') {
    const container = document.getElementById('sidebar-container');
    if (!container) return;

    try {
        const res  = await fetch(`${INCLUDES_PATH}sidebar.html`);
        const html = await res.text();
        container.innerHTML = html;

        // Mark the active link
        if (activePage) {
            const active = container.querySelector(`[data-page="${activePage}"]`);
            if (active) active.classList.add('active');
        }

        // Sidebar expand ↔ main-content push
        _initSidebarPush();
    } catch (err) {
        console.error('[sidebar.js] Could not load sidebar.html:', err);
    }
}

/* ── Logout ──────────────────────────────────────────────────── */
function logout() {
    // Clear any local session data here if using Supabase auth
    // e.g. supabaseClient.auth.signOut();
    window.location.href = '../../auth/login.html';
}

/* ── Internal: live Manila clock ─────────────────────────────── */
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

/* ── Internal: sidebar hover → push main content ─────────────── */
function _initSidebarPush() {
    const sidebar     = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    if (!sidebar || !mainContent) return;

    sidebar.addEventListener('mouseenter', () => mainContent.classList.add('sidebar-open'));
    sidebar.addEventListener('mouseleave', () => mainContent.classList.remove('sidebar-open'));
}