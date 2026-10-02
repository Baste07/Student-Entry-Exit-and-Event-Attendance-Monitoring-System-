function isValidLoginEmail(email) {
    return email.length <= 254 && /^[^\s@.][^\s@]*@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email);
}

document.addEventListener('DOMContentLoaded', function () {

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
            showError('Please enter both email and password.');
            return;
        }

        if (!isValidLoginEmail(username)) {
            showError('Enter a valid email address.');
            return;
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

        if (!isValidLoginEmail(email)) {
            modalErrorText.textContent = 'Enter a valid email address.';
            modalError.style.display   = 'flex';
            return;
        }

        sendResetBtn.disabled    = true;
        sendResetBtn.textContent = 'Sending...';

        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: new URL('reset-password.html', window.location.href).href
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
        modalSuccessText.textContent  = 'If this email has an account, a reset link has been sent. Check your inbox and spam folder.';
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

    const fullName = `${userObj.firstName || ''} ${userObj.lastName || ''}`.trim() || (userObj.email || 'Unknown User');

    const entry = {
        user_id: userObj.id || null,
        full_name: fullName,
        email: userObj.email || null,
        role: userObj.role || userObj.userType || userObj.adminLevel || null,
        action: 'LOGIN',
        module_name: 'auth',
        page_name: 'login.html',
        target_table: tableName || 'admins',
        target_id: userObj.id || null,
        details: {
            login_time: userObj.loginTime || new Date().toISOString(),
            department: userObj.department || null,
            department_id: userObj.departmentId || null
        }
    };

    try {
        const { error } = await supabaseClient
            .from('system_audit_logs')
            .insert([entry]);

        if (error) {
            console.error('[AuditLog] ✗ Insert failed:', error.message);
        } else {
            console.log('[AuditLog] ✓ LOGIN audit logged successfully for', tableName);
        }
    } catch (err) {
        console.error('[AuditLog] ✗ Unexpected error during insert:', err);
    }
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
        .select('admin_id,admin_name,email,admin_level,status,faculty')
        .eq('admin_id', userId)
        .maybeSingle();

    if (adminError) throw adminError;

    if (!adminData) {
        await supabaseClient.auth.signOut();
        throw new Error('Admin profile not found in database.');
    }
    
    if (adminData.status !== 'active') {
        await supabaseClient.auth.signOut();
        throw new Error('Your account is not active. Please contact the administrator.');
    }
    const { data: assurance, error: assuranceError } =
        await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError) throw assuranceError;
    if (assurance.currentLevel === 'aal2') {
        await AdminMFA.completeLogin(adminData);
    } else {
        // Password authentication alone does not create an application session.
        window.location.replace('mfa.html');
    }
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
