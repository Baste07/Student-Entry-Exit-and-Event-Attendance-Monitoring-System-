const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../shared/admin-credential-check.js'), 'utf8');

async function check({ authError = null, userId = 'admin-1', aal = 'aal2', localGate = false, profile = { admin_id: 'admin-1', admin_level: 'admin', status: 'active', login_locked: false } } = {}) {
    const calls = [];
    const client = {
        auth: {
            async setSession(session) {
                calls.push(['setSession', session]);
                return { data: { user: { id: userId } }, error: null };
            }
        },
        from(table) {
            calls.push(['from', table]);
            return {
                select(columns) {
                    calls.push(['select', columns]);
                    return {
                        eq(column, value) {
                            calls.push(['eq', column, value]);
                            return { async maybeSingle() { return { data: profile, error: null }; } };
                        }
                    };
                }
            };
        }
    };
    const context = {
        SUPABASE_CONFIG: { projectUrl: 'https://example.supabase.co', anonKey: 'public-test-key' },
        supabaseClient: {
            auth: {
                getUser: async () => ({ data: { user: { id: 'operator-1' } }, error: null }),
                mfa: { getAuthenticatorAssuranceLevel: async () =>
                    ({ data: { currentLevel: aal }, error: null }) }
            },
            from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
                ({ data: { admin_id: 'operator-1', status: 'active', login_locked: false }, error: null }) }) }) })
        },
        supabase: { createClient(url, key, options) {
            calls.push(['createClient', url, key, options]);
            return client;
        } },
        async fetch(url, options) {
            calls.push(['fetch', url, JSON.parse(options.body)]);
            return { ok: !authError, async json() {
                return authError ? { success: false, message: 'Invalid email or password.' }
                    : { success: true, userId, access_token: 'test-access', refresh_token: 'test-refresh' };
            } };
        },
        URL,
        window: { AppDeployment: {
            root: new URL('http://localhost/CAPSTONEFINAL/EVENTMONITORING/'),
            apiRoute: url => localGate ? url : '/api/admin-login'
        } }
    };
    vm.runInNewContext(source, context);
    const result = await context.window.verifyAdminCredentials('admin@example.edu', 'entered-password');
    return { calls, result };
}

(async () => {
    const valid = await check();
    assert.equal(valid.result.admin_id, 'admin-1');
    const isolatedClient = valid.calls.find(call => call[0] === 'createClient');
    assert.equal(isolatedClient[3].auth.persistSession, false);
    assert.equal(isolatedClient[3].auth.autoRefreshToken, false);
    assert.deepEqual(valid.calls.find(call => call[0] === 'eq').slice(1), ['admin_id', 'admin-1']);
    assert.equal(valid.calls.find(call => call[0] === 'select')[1].includes('password'), false);
    assert.equal(valid.calls.find(call => call[0] === 'fetch')[1], '/api/admin-login');
    const local = await check({ localGate: true });
    assert.equal(local.calls.find(call => call[0] === 'fetch')[1],
        'http://localhost/CAPSTONEFINAL/EVENTMONITORING/auth/admin-login.php');

    const badPassword = await check({ authError: new Error('Invalid login credentials') });
    assert.equal(badPassword.result, null);
    assert.equal(badPassword.calls.some(call => call[0] === 'from'), false);
    assert.equal(badPassword.calls.some(call => call[0] === 'setSession'), false);

    const suspended = await check({ profile: { admin_id: 'admin-1', admin_level: 'admin', status: 'suspended' } });
    assert.equal(suspended.result, null);

    const locked = await check({ profile: { admin_id: 'admin-1', admin_level: 'admin', status: 'active', login_locked: true } });
    assert.equal(locked.result, null);

    const passwordOnly = await check({ aal: 'aal1' });
    assert.equal(passwordOnly.result, null);
    assert.equal(passwordOnly.calls.length, 0);

    console.log('PASS: manual admin credential checks use isolated Auth and reject invalid or suspended accounts');
})().catch(error => { console.error(error); process.exitCode = 1; });
