// A password-reset link must establish a Supabase PASSWORD_RECOVERY session.
// An ordinary signed-in session does not authorize this form.
let recoverySessionReady = Boolean(window.passwordRecoverySessionReady);
let recoveryUserId = window.passwordRecoveryUserId || null;
supabaseClient?.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session?.user?.id) {
        recoverySessionReady = true;
        recoveryUserId = session.user.id;
        window.dispatchEvent(new Event('password-recovery-ready'));
    } else if (event === 'SIGNED_OUT') {
        recoverySessionReady = false;
        recoveryUserId = null;
        window.dispatchEvent(new Event('password-recovery-ended'));
    }
});

document.addEventListener('DOMContentLoaded', function () {
    const resetBtn = document.getElementById('resetBtn');
    const newPassword = document.getElementById('newPassword');
    const confirmPassword = document.getElementById('confirmPassword');
    const mfaWrap = document.getElementById('recoveryMfaWrap');
    const mfaCode = document.getElementById('recoveryMfaCode');
    const statusAlert = document.getElementById('status-alert');
    const statusMsg = document.getElementById('status-message');
    let completed = false;
    let verifiedFactorId = null;
    let checkingRecovery = false;

    function showStatus(message, type = 'danger') {
        const icon = document.getElementById('status-icon');
        statusAlert.style.background = type === 'success' ? '#f0fdf4' : '#fef2f2';
        statusAlert.style.border = type === 'success' ? '1px solid #bbf7d0' : '1px solid #fecaca';
        statusAlert.style.color = type === 'success' ? '#16a34a' : '#dc2626';
        icon.innerHTML = type === 'success'
            ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 13.01 9 10.01"/>'
            : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
        statusAlert.classList.remove('d-none');
        statusMsg.textContent = message;
    }

    function disableRecovery() {
        newPassword.disabled = true;
        confirmPassword.disabled = true;
        mfaCode.disabled = true;
        resetBtn.disabled = true;
        verifiedFactorId = null;
        mfaWrap.hidden = true;
    }

    async function allowRecovery() {
        if (!recoverySessionReady || !recoveryUserId || completed || checkingRecovery) return;
        checkingRecovery = true;
        try {
            const { data: identity, error: identityError } = await supabaseClient.auth.getUser();
            if (identityError || identity?.user?.id !== recoveryUserId) throw new Error('Recovery identity is unavailable.');
            const { data: factors, error: factorError } = await supabaseClient.auth.mfa.listFactors();
            if (factorError) throw factorError;
            const { data: assurance, error: assuranceError } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
            if (assuranceError) throw assuranceError;
            verifiedFactorId = assurance.currentLevel === 'aal2' ? null :
                (factors.totp || []).find(factor => factor.status === 'verified')?.id || null;
            mfaWrap.hidden = !verifiedFactorId;
            mfaCode.disabled = !verifiedFactorId;
            if (!recoverySessionReady || completed) return;
            newPassword.disabled = false;
            confirmPassword.disabled = false;
            resetBtn.disabled = false;
            statusAlert.classList.add('d-none');
        } catch (_) {
            disableRecovery();
            showStatus('The recovery session could not be verified. Request a new link from the login page.');
        } finally {
            checkingRecovery = false;
        }
    }

    // Expired and malformed links never enable the form, even when an unrelated
    // Admin session already exists in browser storage.
    showStatus('Checking password recovery link...');
    window.addEventListener('password-recovery-ready', allowRecovery);
    window.addEventListener('password-recovery-ended', () => {
        disableRecovery();
        if (!completed) showStatus('This recovery session has ended. Request a new link from the login page.');
    });
    allowRecovery();
    setTimeout(() => {
        if (!recoverySessionReady) {
            showStatus('This password recovery link is invalid or expired. Request a new link from the login page.');
        }
    }, 8000);

    resetBtn.addEventListener('click', async function () {
        if (!recoverySessionReady || !recoveryUserId || completed) {
            showStatus('Request a new password recovery link from the login page.');
            return;
        }
        if (newPassword.value.length < 8) {
            showStatus('Password must be at least 8 characters.');
            return;
        }
        if (newPassword.value !== confirmPassword.value) {
            showStatus('Passwords do not match.');
            return;
        }
        const code = mfaCode.value.replace(/\s/g, '');
        if (verifiedFactorId && !/^\d{6}$/.test(code)) {
            showStatus('Enter the six-digit code from your authenticator app.');
            return;
        }

        resetBtn.disabled = true;
        resetBtn.textContent = 'Updating...';
        try {
            const { data: identity, error: identityError } = await supabaseClient.auth.getUser();
            if (identityError || identity?.user?.id !== recoveryUserId) {
                throw new Error('recovery_session_invalid');
            }
            if (verifiedFactorId) {
                const { data: challenge, error: challengeError } = await supabaseClient.auth.mfa.challenge({
                    factorId: verifiedFactorId
                });
                if (challengeError) throw challengeError;
                const { error: verifyError } = await supabaseClient.auth.mfa.verify({
                    factorId: verifiedFactorId, challengeId: challenge.id, code
                });
                if (verifyError) throw verifyError;
                const { data: assurance, error: assuranceError } =
                    await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
                if (assuranceError || assurance?.currentLevel !== 'aal2') {
                    throw new Error('insufficient_aal');
                }
            }
            const { error } = await supabaseClient.auth.updateUser({ password: newPassword.value });
            if (error) throw error;
            completed = true;
            recoverySessionReady = false;
            newPassword.value = '';
            confirmPassword.value = '';
            mfaCode.value = '';
            disableRecovery();
            // Do not leave an AAL1 recovery session open after changing credentials.
            await supabaseClient.auth.signOut();
            window.history.replaceState(null, '', window.location.pathname);
            showStatus('Password updated. Redirecting to login...', 'success');
            setTimeout(() => { window.location.href = '../auth/login.html'; }, 2000);
        } catch (error) {
            mfaCode.value = '';
            showStatus(error?.code === 'insufficient_aal' || error?.message === 'insufficient_aal'
                ? 'Authenticator verification is required to change this password.'
                : verifiedFactorId && error?.status === 422
                    ? 'The authenticator code could not be verified. Try a fresh code.'
                    : 'Password update failed. Request a new recovery link and try again.');
            resetBtn.disabled = false;
            resetBtn.textContent = 'Update Password';
        }
    });
});

function toggleField(fieldId, iconId) {
    const field = document.getElementById(fieldId);
    const icon = document.getElementById(iconId);
    if (field.type === 'password') {
        field.type = 'text';
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
    } else {
        field.type = 'password';
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
}
