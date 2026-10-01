/* Supabase Auth is the sole authority for admin MFA and session assurance. */
const AdminMFA = Object.freeze({
    async loadActiveProfile(client = supabaseClient) {
        const { data: identity, error: identityError } = await client.auth.getUser();
        if (identityError || !identity?.user?.id) throw new Error('Please sign in again.');
        const { data: profile, error } = await client.from('admins')
            .select('admin_id,admin_name,email,admin_level,status,faculty')
            .eq('admin_id', identity.user.id).maybeSingle();
        if (error) throw error;
        if (!profile || profile.status !== 'active' ||
            !['admin', 'super_admin'].includes(profile.admin_level)) {
            await client.auth.signOut();
            sessionStorage.removeItem('user');
            throw new Error('This administrator account is not active.');
        }
        return profile;
    },

    async assurance(client = supabaseClient) {
        const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) throw error;
        return data;
    },

    async completeLogin(profile, client = supabaseClient, redirect = true) {
        const assurance = await this.assurance(client);
        if (assurance.currentLevel !== 'aal2') throw new Error('Authenticator verification is required.');
        const { data: identity, error } = await client.auth.getUser();
        if (error || identity?.user?.id !== profile.admin_id || profile.status !== 'active') {
            throw new Error('Your administrator session could not be verified.');
        }
        const user = {
            id: profile.admin_id,
            firstName: null,
            lastName: profile.admin_name,
            email: profile.email,
            role: profile.admin_level,
            userType: 'admin',
            adminLevel: profile.admin_level,
            department: profile.faculty || null,
            loginTime: new Date().toISOString()
        };
        sessionStorage.setItem('user', JSON.stringify(user));
        try {
            await client.from('system_audit_logs').insert([{
                user_id: profile.admin_id, action: 'LOGIN', module_name: 'auth',
                page_name: 'mfa.html', target_table: 'admins',
                target_id: profile.admin_id, details: { method: 'totp' }
            }]);
        } catch (_) { /* Audit transport failures must not undo verified Auth. */ }
        if (redirect) window.location.replace('../portal/portal.html');
        return user;
    }
});
