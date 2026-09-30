const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../shared/admin-credential-check.js'), 'utf8');

async function check({ authError = null, userId = 'admin-1', profile = { admin_id: 'admin-1', admin_level: 'admin', status: 'active' } } = {}) {
    const calls = [];
    const client = {
        auth: {
            async signInWithPassword(credentials) {
                calls.push(['signIn', credentials]);
                return { data: { user: authError ? null : { id: userId } }, error: authError };
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
        supabase: { createClient(url, key, options) {
            calls.push(['createClient', url, key, options]);
            return client;
        } },
        window: {}
    };
    vm.runInNewContext(source, context);
    const result = await context.window.verifyAdminCredentials('admin@example.edu', 'entered-password');
    return { calls, result };
}

(async () => {
    const valid = await check();
    assert.equal(valid.result.admin_id, 'admin-1');
    assert.equal(valid.calls[0][3].auth.persistSession, false);
    assert.equal(valid.calls[0][3].auth.autoRefreshToken, false);
    assert.deepEqual(valid.calls.find(call => call[0] === 'eq').slice(1), ['admin_id', 'admin-1']);
    assert.equal(valid.calls.find(call => call[0] === 'select')[1].includes('password'), false);

    const badPassword = await check({ authError: new Error('Invalid login credentials') });
    assert.equal(badPassword.result, null);
    assert.equal(badPassword.calls.some(call => call[0] === 'from'), false);

    const suspended = await check({ profile: { admin_id: 'admin-1', admin_level: 'admin', status: 'suspended' } });
    assert.equal(suspended.result, null);

    console.log('PASS: manual admin credential checks use isolated Auth and reject invalid or suspended accounts');
})().catch(error => { console.error(error); process.exitCode = 1; });
