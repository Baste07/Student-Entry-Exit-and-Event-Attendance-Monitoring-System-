/* Verify a manually entered admin password through Supabase Auth without
   replacing the operator's existing browser session. */
(function (root) {
    'use strict';

    root.verifyAdminCredentials = async function (email, password) {
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
