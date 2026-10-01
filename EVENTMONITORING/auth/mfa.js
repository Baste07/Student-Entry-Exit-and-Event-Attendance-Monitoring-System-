(() => {
    const setup = document.getElementById('mfaSetup');
    const challengePanel = document.getElementById('mfaChallenge');
    const form = document.getElementById('mfaForm');
    const loading = document.getElementById('mfaLoading');
    const errorBox = document.getElementById('mfaError');
    const submit = document.getElementById('mfaSubmit');
    const codeInput = document.getElementById('mfaCode');
    let profile, factorId, setupSecret = '', submitting = false;

    function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    async function start() {
        try {
            profile = await AdminMFA.loadActiveProfile();
            const assurance = await AdminMFA.assurance();
            if (assurance.currentLevel === 'aal2') {
                await AdminMFA.completeLogin(profile);
                return;
            }
            const { data, error } = await supabaseClient.auth.mfa.listFactors();
            if (error) throw error;
            const verified = (data.totp || []).find(f => f.status === 'verified');
            if (verified) {
                factorId = verified.id;
                challengePanel.hidden = false;
                submit.textContent = 'Verify';
            } else {
                // An unverified factor cannot be shown again because its setup key
                // is intentionally not stored. Discard it and issue a fresh one.
                for (const factor of (data.all || []).filter(f => f.factor_type === 'totp' && f.status !== 'verified')) {
                    const { error: removeError } = await supabaseClient.auth.mfa.unenroll({ factorId: factor.id });
                    if (removeError) throw removeError;
                }
                const enrolled = await supabaseClient.auth.mfa.enroll({
                    factorType: 'totp', friendlyName: 'El Tres Eres Cencia Escuela',
                    issuer: 'El Tres Eres Cencia Escuela'
                });
                if (enrolled.error) throw enrolled.error;
                factorId = enrolled.data.id;
                setupSecret = enrolled.data.totp.secret;
                const qr = enrolled.data.totp.qr_code;
                if (!qr.startsWith('data:image/')) throw new Error('Authenticator QR could not be displayed.');
                document.getElementById('mfaQr').src = qr;
                setup.hidden = false;
            }
            loading.hidden = true;
            form.hidden = false;
            codeInput.focus();
        } catch (error) {
            loading.textContent = error.message || 'Authenticator setup is unavailable. Please sign in again.';
        }
    }

    document.getElementById('showSetupKey').addEventListener('click', event => {
        const box = document.getElementById('setupKeyWrap');
        box.hidden = !box.hidden;
        event.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
        document.getElementById('setupKey').textContent = box.hidden ? '' : setupSecret;
    });

    document.getElementById('mfaBack').addEventListener('click', async event => {
        event.preventDefault();
        sessionStorage.removeItem('user');
        await supabaseClient.auth.signOut();
        window.location.replace('login.html');
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submitting) return;
        const code = codeInput.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) {
            showError('Enter the six digits shown in your authenticator app.');
            return;
        }
        submitting = true;
        submit.disabled = true;
        errorBox.hidden = true;
        try {
            const challenged = await supabaseClient.auth.mfa.challenge({ factorId });
            if (challenged.error) throw challenged.error;
            const verified = await supabaseClient.auth.mfa.verify({
                factorId, challengeId: challenged.data.id, code
            });
            if (verified.error) throw verified.error;
            const assurance = await AdminMFA.assurance();
            if (assurance.currentLevel !== 'aal2') throw new Error('Authenticator verification did not complete.');
            document.getElementById('mfaQr').removeAttribute('src');
            setupSecret = '';
            document.getElementById('setupKey').textContent = '';
            if (!setup.hidden) {
                // Audit only the event, never the factor ID, key, QR, or code.
                await supabaseClient.from('system_audit_logs').insert([{
                    user_id: profile.admin_id, full_name: profile.admin_name,
                    email: profile.email, role: profile.admin_level,
                    action: 'MFA_ENROLLED', module_name: 'auth', page_name: 'mfa.html',
                    target_table: 'admins', target_id: profile.admin_id,
                    details: { method: 'totp' }
                }]);
            }
            await AdminMFA.completeLogin(profile);
        } catch (_) {
            codeInput.value = '';
            showError('The code could not be verified. Check your authenticator and try again.');
        } finally {
            submitting = false;
            submit.disabled = false;
        }
    });

    start();
})();
