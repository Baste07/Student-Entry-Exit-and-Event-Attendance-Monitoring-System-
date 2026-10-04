const PRODUCTION_REF = 'hgdqarcdfycdesavwrvq';

function projectRef(value, variable) {
  if (!value || typeof value !== 'string') throw new Error(`${variable} is required.`);
  try {
    const url = new URL(value);
    const match = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
    if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid URL');
    return match[1];
  } catch {
    throw new Error(`${variable} must be a Supabase project HTTPS origin.`);
  }
}

/** Validate only project identity and presence; never include credentials in errors. */
export function validateSupabaseBuildConfig(env, { testConfig = false } = {}) {
  const production = env.VERCEL_ENV === 'production';
  if (testConfig) {
    if (production) throw new Error('Test browser configuration is forbidden in Production.');
    return;
  }

  const browserRef = projectRef(env.WEB_SUPABASE_URL?.trim(), 'WEB_SUPABASE_URL');
  if (!env.WEB_SUPABASE_ANON_KEY?.trim()) throw new Error('WEB_SUPABASE_ANON_KEY is required.');

  const serverUrl = env.SUPABASE_URL?.trim();
  const serverRef = serverUrl ? projectRef(serverUrl, 'SUPABASE_URL') : null;
  if (production && !serverRef) throw new Error('SUPABASE_URL is required in Production.');
  if (serverRef && browserRef !== serverRef) throw new Error('Browser and server Supabase projects must match.');
  if (production && (browserRef !== PRODUCTION_REF || serverRef !== PRODUCTION_REF)) {
    throw new Error('Production requires the approved Supabase project.');
  }
  if (production && !env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in Production.');
  }
}
