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

function isProtectedAdminRoute(pathname) {
    return pathname.includes('/admin/') || pathname.includes('/EntryExitMonitoring/gate/');
}

function registerProtectedNavigation() {
    document.addEventListener('click', function (event) {
        const link = event.target.closest('a[href]');
        if (!link) return;

        const target = new URL(link.href, window.location.href);
        if (target.origin === window.location.origin && isProtectedAdminRoute(target.pathname)) {
            sessionStorage.setItem('allowed_admin_route', target.pathname);
        }
    }, true);
}

function getDepartmentLogo() {
    const user = getCurrentUser();
    if (user && user.departmentLogo) {
        return user.departmentLogo;
    }
    // Fallback to default if no department logo
    return '../auth/assets/ccslogo.png';
}

async function logSystemAudit({ action = 'ACCESS', moduleName = 'system', pageName = '', targetTable = null, targetId = null, details = {} } = {}) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        return;
    }

    const user = getCurrentUser();
    if (!user) {
        return;
    }

    const payload = {
        user_id: user.id || null,
        full_name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || (user.email || null),
        email: user.email || null,
        role: user.role || user.userType || user.adminLevel || null,
        action: String(action).toUpperCase(),
        module_name: moduleName,
        page_name: pageName || window.location.pathname.split('/').pop() || 'unknown',
        target_table: targetTable || null,
        target_id: targetId || null,
        details: (details && typeof details === 'object') ? details : { value: details },
        created_at: new Date().toISOString()
    };

    try {
        const { error } = await supabaseClient
            .from('system_audit_logs')
            .insert([payload]);

        if (error) {
            console.error('[Audit] Insert failed:', error.message);
        }
    } catch (err) {
        console.error('[Audit] Unexpected error:', err);
    }
}

function registerAuditActionTracking() {
    document.addEventListener('click', async function (e) {
        const trigger = e.target.closest('[data-audit-action]');
        if (trigger) {
            const action = (trigger.dataset.auditAction || 'ACTION').toUpperCase();
            const moduleName = trigger.dataset.auditModule || 'system';
            const targetTable = trigger.dataset.auditTable || null;
            const targetId = trigger.dataset.auditId || null;
            const details = {
                label: trigger.textContent?.trim() || trigger.dataset.auditLabel || '',
                element: trigger.tagName,
                dataset: trigger.dataset || {}
            };
            await logSystemAudit({ action, moduleName, pageName: window.location.pathname.split('/').pop() || 'unknown', targetTable, targetId, details });
        }

        const deleteCandidate = e.target.closest('.btn-delete, .delete-btn, [data-action="delete"], [data-audit-action="delete"]');
        if (deleteCandidate && !deleteCandidate.dataset.auditAction) {
            await logSystemAudit({ action: 'DELETE', moduleName: 'system', pageName: window.location.pathname.split('/').pop() || 'unknown', details: { label: deleteCandidate.textContent?.trim() || 'delete action' } });
        }

        const addCandidate = e.target.closest('.btn-add, .add-btn, [data-action="add"], [data-audit-action="add"]');
        if (addCandidate && !addCandidate.dataset.auditAction) {
            await logSystemAudit({ action: 'ADD', moduleName: 'system', pageName: window.location.pathname.split('/').pop() || 'unknown', details: { label: addCandidate.textContent?.trim() || 'add action' } });
        }
    });

    document.addEventListener('submit', async function (e) {
        const form = e.target;
        if (!form || form.tagName !== 'FORM') return;

        const action = (form.dataset.auditAction || 'FORM_SUBMIT').toUpperCase();
        await logSystemAudit({
            action,
            moduleName: form.dataset.auditModule || 'system',
            pageName: window.location.pathname.split('/').pop() || 'unknown',
            targetTable: form.dataset.auditTable || null,
            targetId: form.dataset.auditId || null,
            details: {
                formId: form.id || null,
                formName: form.name || null
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', function () {
    checkSupabaseConnection();
    registerProtectedNavigation();

    const currentUser = getCurrentUser();
    if (currentUser) {
        logSystemAudit({
            action: 'PAGE_ACCESS',
            moduleName: document.body.dataset.module || 'portal',
            pageName: window.location.pathname.split('/').pop() || 'unknown',
            details: {
                url: window.location.href,
                access_type: 'page_view'
            }
        });
    }

    registerAuditActionTracking();

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'logout-modal-backdrop';
    modalBackdrop.innerHTML = `
        <div class="logout-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="logoutModalTitle">
            <div class="logout-modal-content">
                <h3 id="logoutModalTitle">Log out?</h3>
                <p>Are you sure you want to log out?</p>
                <div class="logout-modal-actions">
                    <button type="button" class="btn-logout-cancel">Cancel</button>
                    <button type="button" class="btn-logout-confirm">Log Out</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modalBackdrop);

    let pendingLogout = false;

    const openLogoutModal = () => {
        pendingLogout = true;
        modalBackdrop.classList.add('active');
    };

    const closeLogoutModal = () => {
        pendingLogout = false;
        modalBackdrop.classList.remove('active');
    };

    document.addEventListener('click', function(e) {
        const logoutBtn = e.target.closest('.btn-logout');
        if (logoutBtn) {
            e.preventDefault();
            openLogoutModal();
        }

        if (e.target.closest('.btn-logout-cancel')) {
            closeLogoutModal();
        }

        if (e.target.closest('.btn-logout-confirm')) {
            const user = getCurrentUser();
            if (user) {
                logSystemAudit({
                    action: 'LOGOUT',
                    moduleName: 'system',
                    pageName: window.location.pathname.split('/').pop() || 'unknown',
                    details: {
                        logout_reason: 'manual_logout',
                        user_role: user.role || user.userType || user.adminLevel || null
                    }
                });
            }
            sessionStorage.removeItem('user');
            const path = window.location.pathname;
            let authPath = '../auth/login.html';
            if (path.includes('/pages/') || path.includes('/includes/')) {
                authPath = '../../auth/login.html';
            }
            window.location.href = authPath;
        }
    });

    modalBackdrop.addEventListener('click', function (e) {
        if (e.target === modalBackdrop) {
            closeLogoutModal();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && pendingLogout) {
            closeLogoutModal();
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
