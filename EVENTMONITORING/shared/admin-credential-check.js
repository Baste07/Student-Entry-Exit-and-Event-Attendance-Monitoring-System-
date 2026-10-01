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
            .select('admin_id,status').eq('admin_id', operator.user.id).maybeSingle();
        if (activeOperator?.status !== 'active') return null;
        const client = supabase.createClient(SUPABASE_CONFIG.projectUrl, SUPABASE_CONFIG.anonKey, {
            auth: {
                storageKey: 'manual-admin-verification',
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            }
        });
        const { data: identity, error: authError } = await client.auth.signInWithPassword({ email, password });
        if (authError || !identity?.user?.id) return null;

        const { data: profile, error: profileError } = await client
            .from('admins')
            .select('admin_id,admin_level,status')
            .eq('admin_id', identity.user.id)
            .maybeSingle();
        if (profileError) throw profileError;
        return profile?.status === 'active' ? profile : null;
    };
})(typeof window !== 'undefined' ? window : globalThis);
