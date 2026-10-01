const SUPABASE_CONFIG = {
    projectUrl: typeof ENV !== 'undefined' ? ENV.SUPABASE_PROJECT_URL : '',
    anonKey: typeof ENV !== 'undefined' ? ENV.SUPABASE_ANON_KEY : ''
};

// Set DEPLOYMENT_MODE in the ignored config/.env.js on each installation.
// This controls navigation only; Supabase RLS and PHP enforce authorization.
const DEPLOYMENT_MODE = typeof ENV !== 'undefined' && ENV.DEPLOYMENT_MODE === 'WEB'
    ? 'WEB' : 'LOCAL_GATE';
const APP_ROOT = typeof document !== 'undefined' && document.currentScript
    ? new URL('../', document.currentScript.src) : null;
if (typeof window !== 'undefined') window.AppDeployment = {
    mode: DEPLOYMENT_MODE,
    isWeb: DEPLOYMENT_MODE === 'WEB',
    isLocalGate: DEPLOYMENT_MODE === 'LOCAL_GATE',
    root: APP_ROOT,
    applyNavigation(scope = document) {
        if (DEPLOYMENT_MODE !== 'WEB') return;
        scope.querySelectorAll('[data-local-operation]').forEach(element => { element.hidden = true; });
    }
};
if (typeof document !== 'undefined') {
    if (document.documentElement.dataset) document.documentElement.dataset.deploymentMode = DEPLOYMENT_MODE;
    if (DEPLOYMENT_MODE === 'WEB' && document.head) {
        const style = document.createElement('style');
        style.textContent = '[data-local-operation] { display: none !important; }';
        document.head.appendChild(style);
    }
    document.addEventListener?.('DOMContentLoaded', () => window.AppDeployment.applyNavigation());
}

if (!SUPABASE_CONFIG.projectUrl || !SUPABASE_CONFIG.anonKey) {
    console.error('⚠️ Supabase configuration is missing!');
    console.error('Please create config/.env.js from .env.example.js and add your credentials.');
}

let supabaseClient = null;
if (typeof supabase !== 'undefined' && SUPABASE_CONFIG.projectUrl && SUPABASE_CONFIG.anonKey) {
    supabaseClient = supabase.createClient(SUPABASE_CONFIG.projectUrl, SUPABASE_CONFIG.anonKey, {
        auth: {
            persistSession: true,      
            autoRefreshToken: true,  
            detectSessionInUrl: false   
        }
    });
}

// Attach the current Supabase access token to protected same-origin PHP calls.
// PHP verifies identity, role, and AAL2 independently; this helper is not an
// authorization decision and never sends the service-role credential.
async function adminAal2Fetch(url, options = {}) {
    if (!supabaseClient) throw new Error('Sign in is required.');
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) throw new Error('Sign in is required.');
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${data.session.access_token}`);
    return fetch(url, { ...options, headers });
}

// A browser route check improves navigation, while database RLS and PHP enforce
// the same AAL2 rule against direct API calls. The login/MFA pages stay open so
// existing administrators can enroll after their password-only sign-in.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const appRoot = APP_ROOT;
    const relativePath = decodeURIComponent(window.location.pathname.slice(appRoot.pathname.length));
    const protectedPage = window.location.pathname.startsWith(appRoot.pathname) &&
        (relativePath.startsWith('admin/') || relativePath.startsWith('portal/') ||
         relativePath.startsWith('EntryExitMonitoring/') ||
         relativePath.startsWith('TimeInAndTimeOutMonitoring/')) &&
        relativePath.endsWith('.html') && !relativePath.includes('/includes/');
    if (protectedPage) {
        document.documentElement.style.visibility = 'hidden';
        window.adminMfaRouteReady = (async () => {
            try {
                if (!supabaseClient) throw new Error('Missing database client');
                const { data: identity, error: identityError } = await supabaseClient.auth.getUser();
                if (identityError || !identity?.user?.id) throw new Error('No session');
                const { data: profile, error: profileError } = await supabaseClient
                    .from('admins').select('admin_id,admin_name,email,admin_level,status,faculty')
                    .eq('admin_id', identity.user.id).maybeSingle();
                if (profileError || !profile || profile.status !== 'active' ||
                    !['admin', 'super_admin'].includes(profile.admin_level)) {
                    await supabaseClient.auth.signOut();
                    throw new Error('No active admin profile');
                }
                const { data: assurance, error: assuranceError } =
                    await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
                if (assuranceError) throw assuranceError;
                if (assurance.currentLevel !== 'aal2') {
                    sessionStorage.removeItem('user');
                    window.location.replace(new URL('auth/mfa.html', appRoot).href);
                    return false;
                }
                sessionStorage.setItem('user', JSON.stringify({
                    id: profile.admin_id, firstName: null, lastName: profile.admin_name,
                    email: profile.email, role: profile.admin_level, userType: 'admin',
                    adminLevel: profile.admin_level, department: profile.faculty || null
                }));
                window.adminMfaRouteComplete = true;
                document.documentElement.style.visibility = '';
                return true;
            } catch (_) {
                sessionStorage.removeItem('user');
                window.location.replace(new URL('auth/login.html', appRoot).href);
                return false;
            }
        })();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SUPABASE_CONFIG, supabaseClient };
}
