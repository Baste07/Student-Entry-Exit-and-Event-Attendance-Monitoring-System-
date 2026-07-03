const SUPABASE_CONFIG = {
    projectUrl: typeof ENV !== 'undefined' ? ENV.SUPABASE_PROJECT_URL : '',
    anonKey: typeof ENV !== 'undefined' ? ENV.SUPABASE_ANON_KEY : ''
};

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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SUPABASE_CONFIG, supabaseClient };
}