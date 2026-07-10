document.addEventListener('DOMContentLoaded', function () {
    const AUTH_DISABLED = false;
    const DEFAULT_ADMIN_PASSWORD = 'Admin123!';
    const DEFAULT_SUPER_ADMIN_PASSWORD = 'SuperAdmin123!';
    const HARDCODED_USERS = [
        {
            usernames: ['superadmin', 'super admin', 'superadmin@plpasig.edu.ph'],
            password: DEFAULT_SUPER_ADMIN_PASSWORD,
            profile: {
                id: 'hc-super-admin',
                employeeId: 'SA-001',
                firstName: 'System',
                lastName: 'Super Admin',
                email: 'superadmin@plpasig.edu.ph',
                role: 'super_admin',
                userType: 'admin',
                adminLevel: 'super_admin',
                department: 'College of Computer Studies',
                departmentCode: 'CCS',
                departmentLogo: '../auth/assets/ccslogo.png'
            },
            redirect: '../portal/portal.html'
        },
        {
            usernames: ['admin', 'admin@plpasig.edu.ph'],
            password: DEFAULT_ADMIN_PASSWORD,
            profile: {
                id: 'hc-admin',
                employeeId: 'AD-001',
                firstName: 'System',
                lastName: 'Admin',
                email: 'admin@plpasig.edu.ph',
                role: 'admin',
                userType: 'admin',
                adminLevel: 'admin',
                department: 'College of Computer Studies',
                departmentCode: 'CCS',
                departmentLogo: '../auth/assets/ccslogo.png'
            },
            redirect: '../portal/portal.html'
        }
    ];

    const form          = document.querySelector('form');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const submitBtn     = document.querySelector('.btn-signin');
    const errorAlert    = document.getElementById('error-alert');

    // Force fresh authentication when opening the login page.
    sessionStorage.removeItem('user');

    usernameInput.addEventListener('input', function () {
        errorAlert.classList.add('d-none');
    });

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        if (!username || !password) {
            showError('Please enter both email/ID and password');
            return;
        }

        if (AUTH_DISABLED) {
            submitBtn.disabled    = true;
            submitBtn.textContent = 'Entering...';
            bypassLogin(username, password);
            return;
        }

        if (username.includes('@')) {
            if (!username.toLowerCase().endsWith('@plpasig.edu.ph')) {
                showError('Only emails with @plpasig.edu.ph domain are allowed to login.');
                return;
            }
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Signing in...';

        try {
            await loginUser(username, password);
        } catch (error) {
            console.error('Login error:', error);
            showError(error.message || 'Unknown error occurred');
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Sign In';
        }
    });

    function bypassLogin(username, password) {
        const normalizedUsername = String(username || '').trim().toLowerCase();
        const match = HARDCODED_USERS.find(user => {
            return user.usernames.includes(normalizedUsername) && user.password === password;
        });

        if (!match) {
            showError('Invalid credentials. Use admin or superadmin with the default password.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
            return;
        }

        const devUser = {
            id:             match.profile.id,
            studentId:      null,
            employeeId:     match.profile.employeeId,
            firstName:      match.profile.firstName,
            middleName:     null,
            lastName:       match.profile.lastName,
            email:          match.profile.email,
            course:         null,
            year_level:     null,
            section:        null,
            role:           match.profile.role,
            userType:       match.profile.userType,
            adminLevel:     match.profile.adminLevel,
            departmentId:   null,
            department:     match.profile.department,
            departmentCode: match.profile.departmentCode,
            departmentLogo: match.profile.departmentLogo,
            authDisabled:   true,
            loginTime:      new Date().toISOString(),
        };

        sessionStorage.setItem('user', JSON.stringify(devUser));
        window.location.href = match.redirect;
    }

    function showError(message) {
        const icon = document.getElementById('alert-icon');
        errorAlert.style.background = '#fef2f2';
        errorAlert.style.border     = '1px solid #fecaca';
        errorAlert.style.color      = '#dc2626';
        icon.innerHTML = `<circle cx="12" cy="12" r="10"/>
                          <line x1="12" y1="8" x2="12" y2="12"/>
                          <line x1="12" y1="16" x2="12.01" y2="16"/>`;
        errorAlert.classList.remove('d-none');
        document.getElementById('error-message').textContent = message;
    }

    function showSuccess(message) {
        const icon = document.getElementById('alert-icon');
        errorAlert.style.background = '#f0fdf4';
        errorAlert.style.border     = '1px solid #bbf7d0';
        errorAlert.style.color      = '#16a34a';
        icon.innerHTML = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                          <polyline points="22 4 12 13.01 9 10.01"/>`;
        errorAlert.classList.remove('d-none');
        document.getElementById('error-message').textContent = message;
    }

    const forgotModal      = document.getElementById('forgotModal');
    const forgotEmailInput = document.getElementById('forgotEmailInput');
    const sendResetBtn     = document.getElementById('sendResetBtn');
    const cancelForgotBtn  = document.getElementById('cancelForgotBtn');
    const modalError       = document.getElementById('modal-error');
    const modalErrorText   = document.getElementById('modal-error-text');
    const modalSuccess     = document.getElementById('modal-success');
    const modalSuccessText = document.getElementById('modal-success-text');

    function resetModal() {
        modalError.style.display      = 'none';
        modalSuccess.style.display    = 'none';
        sendResetBtn.disabled         = false;
        sendResetBtn.textContent      = 'Send Reset Link';
        sendResetBtn.style.background = '#1a3a5c';
        cancelForgotBtn.textContent   = 'Cancel';
    }

    // Open modal
    document.getElementById('forgotPasswordLink').addEventListener('click', function (e) {
        e.preventDefault();
        resetModal();
        const username = document.getElementById('username').value.trim();
        forgotEmailInput.value    = username.includes('@') ? username : '';
        forgotModal.style.display = 'flex';
        setTimeout(() => forgotEmailInput.focus(), 100);
    });

    // Close modal — Cancel button
    cancelForgotBtn.addEventListener('click', function () {
        forgotModal.style.display = 'none';
        resetModal();
    });

    // Close modal — backdrop click
    forgotModal.addEventListener('click', function (e) {
        if (e.target === forgotModal) {
            forgotModal.style.display = 'none';
            resetModal();
        }
    });

    // Close modal — Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && forgotModal.style.display === 'flex') {
            forgotModal.style.display = 'none';
            resetModal();
        }
    });

    // Enter key submits modal
    forgotEmailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') sendResetBtn.click();
    });

    // Send reset email
    sendResetBtn.addEventListener('click', async function () {
        const email = forgotEmailInput.value.trim().toLowerCase();

        modalError.style.display   = 'none';
        modalSuccess.style.display = 'none';

        if (!email) {
            modalErrorText.textContent = 'Please enter your email address.';
            modalError.style.display   = 'flex';
            forgotEmailInput.focus();
            return;
        }

        if (!email.endsWith('@plpasig.edu.ph')) {
            modalErrorText.textContent = 'Only @plpasig.edu.ph emails are allowed.';
            modalError.style.display   = 'flex';
            return;
        }

        // Updated to check the admins table instead of professors
        const { data: adminRecord } = await supabaseClient
            .from('admins')
            .select('email')
            .eq('email', email)
            .maybeSingle();

        if (!adminRecord) {
            modalErrorText.textContent = 'No account found with that email address.';
            modalError.style.display   = 'flex';
            return;
        }

        sendResetBtn.disabled    = true;
        sendResetBtn.textContent = 'Sending...';

        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/auth/reset-password.html'
        });

        if (error) {
            modalErrorText.textContent = 'Failed to send reset email: ' + error.message;
            modalError.style.display   = 'flex';
            sendResetBtn.disabled      = false;
            sendResetBtn.textContent   = 'Send Reset Link';
            return;
        }

        sendResetBtn.textContent      = '✓ Link Sent!';
        sendResetBtn.style.background = '#16a34a';
        modalSuccessText.innerHTML    = `Reset link sent to <strong>${email}</strong>. Check your inbox and spam folder.`;
        modalSuccess.style.display    = 'flex';
        cancelForgotBtn.textContent   = 'Close';

        setTimeout(() => {
            forgotModal.style.display = 'none';
            resetModal();
        }, 4000);
    });

}); 

function togglePassword() {
    const pwd  = document.getElementById('password');
    const icon = document.getElementById('toggle-icon');
    if (pwd.type === 'password') {
        pwd.type       = 'text';
        icon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>`;
    } else {
        pwd.type       = 'password';
        icon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>`;
    }
}

async function writeLoginAudit(userObj, tableName) {
    console.log('[AuditLog] writeLoginAudit called | tableName:', tableName, '| id:', userObj.id);

    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        console.error('[AuditLog] supabaseClient not available — skipping audit');
        return;
    }

    const userName = tableName === 'admins'
        ? (userObj.lastName || '').trim()
        : `${userObj.firstName || ''} ${userObj.lastName || ''}`.trim();

    let entry = {
        action:        'LOGIN',
        target_table:  tableName,
        target_id:     userObj.id           || null,
        target_name:   userName             || null,
        old_value:     null,
        new_value:     null,
        department_id: userObj.departmentId || null,
    };

    if (tableName === 'admins') {
        entry.admin_id = userObj.id || null;
    } 

    console.log('[AuditLog] Inserting entry:', entry);

    try {
        const { data, error } = await supabaseClient
            .from('requirement_submission_audit_logs')
            .insert([entry])
            .select();

        if (error) {
            console.error('[AuditLog] ✗ Insert failed:', {
                message: error.message,
                code:    error.code,
                details: error.details,
                hint:    error.hint,
            });
        } else {
            console.log('[AuditLog] ✓ LOGIN audit logged successfully for', tableName, ':', data);
        }
    } catch (err) {
        console.error('[AuditLog] ✗ Unexpected error during insert:', err);
    }
}

async function ensureSupabaseAuthSession(email, password) {
    const { error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (!signInError) {
        console.log('[Auth] ✓ Supabase Auth session established for:', email);
        return true;
    }

    console.warn('[Auth] Sign-in failed, attempting sign-up:', signInError.message);
    const { error: signUpError } = await supabaseClient.auth.signUp({ email, password });

    if (signUpError) {
        console.warn('[Auth] Sign-up also failed:', signUpError.message);
        return false;
    }

    const { error: retryError } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (retryError) {
        console.warn('[Auth] Sign-in after sign-up failed:', retryError.message);
        return false;
    }

    console.log('[Auth] ✓ Supabase Auth session created and established for:', email);
    return true;
}

async function loginUser(username, password) {
    console.log('[loginUser] FUNCTION CALLED - username:', username);

    if (!supabaseClient) {
        throw new Error('Database connection not available. Please check configuration.');
    }

    // 1. Authenticate with Supabase FIRST
    // This securely checks the email/password against Supabase Auth, bypassing the RLS read block.
    const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
        email: username,
        password: password
    });

    if (authError) {
        console.error('[Auth Error]', authError.message);
        throw new Error('Invalid credentials. Please check your email and password.');
    }

    // 2. Now that we are logged in, we have permission to read the admins table!
    const userId = authData.user.id;

    const { data: adminData, error: adminError } = await supabaseClient
        .from('admins')
        .select('*')
        .eq('admin_id', userId)
        .maybeSingle();

    if (adminError) throw adminError;

    if (!adminData) {
        throw new Error('Admin profile not found in database.');
    }
    
    if (adminData.status !== 'active') {
        throw new Error('Your account is not active. Please contact the administrator.');
    }

    // 3. Save session data
    const userObj = {
        id:             adminData.admin_id,
        employeeId:     adminData.employee_id  || null,
        firstName:      null,
        lastName:       adminData.admin_name,
        email:          adminData.email,
        role:           adminData.admin_level || 'admin',
        userType:       'admin',
        adminLevel:     adminData.admin_level || 'admin',
        departmentId:   adminData.department_id || null,
        department:     adminData.department    || null,
        loginTime:      new Date().toISOString(),
    };

    sessionStorage.setItem('user', JSON.stringify(userObj));
    console.log('[loginUser] ✓ User saved to sessionStorage:', userObj);

    // 4. Handle audit logging and redirection
    writeLoginAudit(userObj, 'admins').catch(err => {
        console.error('[AuditLog] Failed to write login audit:', err);
    });

    console.log('[loginUser] Redirecting... admin_level=', adminData.admin_level);
    window.location.href = '../portal/portal.html';
}

async function fetchDepartmentInfoAsync(departmentId) {
    try {
        const { data: deptData, error } = await supabaseClient
            .from('departments')
            .select('id, department_name, department_code, logo_url')
            .eq('id', departmentId)
            .single();

        if (error) {
            console.warn('[Dept] Error fetching department info:', error);
            return;
        }

        if (deptData) {
            const user      = JSON.parse(sessionStorage.getItem('user'));
            user.department     = deptData.department_name;
            user.departmentCode = deptData.department_code;
            user.departmentLogo = deptData.logo_url;
            sessionStorage.setItem('user', JSON.stringify(user));
            console.log('[Dept] ✓ Department info updated in session');
        }
    } catch (err) {
        console.warn('[Dept] Unexpected error fetching department:', err);
    }
}