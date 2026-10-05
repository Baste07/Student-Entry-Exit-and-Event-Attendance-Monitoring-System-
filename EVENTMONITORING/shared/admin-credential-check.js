/* Verify a manually entered admin password through Supabase Auth without
   replacing the operator's existing browser session. */
(function (root) {
    'use strict';

    root.verifyAdminCredentials = async function (email, password) {
        // This secondary password prompt never establishes the operator's
        // authorization. The current browser session must already be AAL2.
        const { data: operator, error: operatorError } = await supabaseClient.auth.getUser();
        const { data: assurance, error: assuranceError } =
            await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
        if (operatorError || assuranceError || !operator?.user?.id ||
            assurance.currentLevel !== 'aal2') return null;
        const { data: activeOperator } = await supabaseClient.from('admins')
            .select('admin_id,status,login_locked').eq('admin_id', operator.user.id).maybeSingle();
        if (activeOperator?.status !== 'active' || activeOperator.login_locked !== false) return null;
        // Scanner confirmation also verifies an Admin password. Route it
        // through the same server-backed counter without replacing the
        // operator's own AAL2 session.
        const localLoginUrl = new URL('auth/admin-login.php', root.AppDeployment.root).href;
        const response = await fetch(root.AppDeployment.apiRoute(localLoginUrl), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const verified = await response.json().catch(() => null);
        if (!response.ok || verified?.success !== true || !verified.access_token ||
            !verified.refresh_token || !verified.userId) return null;
        const client = supabase.createClient(SUPABASE_CONFIG.projectUrl, SUPABASE_CONFIG.anonKey, {
            auth: {
                storageKey: 'manual-admin-verification',
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            }
        });
        const { data: identity, error: authError } = await client.auth.setSession({
            access_token: verified.access_token, refresh_token: verified.refresh_token
        });
        if (authError || identity?.user?.id !== verified.userId) return null;

        const { data: profile, error: profileError } = await client
            .from('admins')
            .select('admin_id,admin_level,status,login_locked')
            .eq('admin_id', identity.user.id)
            .maybeSingle();
        if (profileError) throw profileError;
        return profile?.status === 'active' && profile.login_locked === false ? profile : null;
    };
})(typeof window !== 'undefined' ? window : globalThis);
