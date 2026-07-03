document.addEventListener('DOMContentLoaded', function () {
    const resetBtn    = document.getElementById('resetBtn');
    const statusAlert = document.getElementById('status-alert');
    const statusMsg   = document.getElementById('status-message');

    function showStatus(message, type = 'danger') {
        const icon = document.getElementById('status-icon');
        if (type === 'success') {
            statusAlert.style.background = '#f0fdf4';
            statusAlert.style.border     = '1px solid #bbf7d0';
            statusAlert.style.color      = '#16a34a';
            icon.innerHTML = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 13.01 9 10.01"/>`;
        } else {
            statusAlert.style.background = '#fef2f2';
            statusAlert.style.border     = '1px solid #fecaca';
            statusAlert.style.color      = '#dc2626';
            icon.innerHTML = `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`;
        }
        statusAlert.classList.remove('d-none');
        statusMsg.textContent = message;
    }

    resetBtn.addEventListener('click', async function () {
        const newPassword     = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        if (newPassword.length < 8) {
            showStatus('Password must be at least 8 characters.');
            return;
        }
        if (newPassword !== confirmPassword) {
            showStatus('Passwords do not match.');
            return;
        }

        resetBtn.disabled     = true;
        resetBtn.textContent  = 'Updating...';

        // Update password in Supabase Auth
        const { data, error } = await supabaseClient.auth.updateUser({
            password: newPassword
        });

        if (error) {
            showStatus('Reset failed: ' + error.message);
            resetBtn.disabled    = false;
            resetBtn.textContent = 'Update Password';
            return;
        }

        // Sync new password back to professors table
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (user?.email) {
            await supabaseClient
                .from('professors')
                .update({
                    password:   newPassword,
                    updated_at: new Date().toISOString()
                })
                .eq('email', user.email);
        }

        showStatus('✓ Password updated! Redirecting to login...', 'success');

        setTimeout(() => {
            window.location.href = '../auth/login.html';
        }, 2000);
    });
});

function toggleField(fieldId, iconId) {
    const field = document.getElementById(fieldId);
    const icon  = document.getElementById(iconId);
    if (field.type === 'password') {
        field.type = 'text';
        icon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>`;
    } else {
        field.type = 'password';
        icon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
    }
}