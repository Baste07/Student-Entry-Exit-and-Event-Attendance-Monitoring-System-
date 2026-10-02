/** Disposable development-only Auth/RLS test. Never run against Production. */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const projectRef = 'ehyqvyglirirktfmdezq';
const url = `https://${projectRef}.supabase.co`;
const envFile = new URL('../../../.env.development.local', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.SUPABASE_URL !== url ||
    !process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Refusing MFA audit test without the approved development project and keys');
}

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const client = createClient(url, process.env.SUPABASE_ANON_KEY, options);
const anonymous = createClient(url, process.env.SUPABASE_ANON_KEY, options);
const nonce = randomBytes(8).toString('hex');
const email = `codex-mfa-audit-${nonce}@example.com`;
const password = randomBytes(24).toString('base64url');
const action = `MFA_AUDIT_TEST_${nonce}`;
let userId;

function codeFor(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const letter of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(letter);
    if (value < 0) throw new Error('Invalid TOTP setup data');
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

function denied(result, label) {
  if (!result.error && (!Array.isArray(result.data) || result.data.length > 0)) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
}

try {
  console.log(`Verified development target: ${projectRef}`);
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error('Disposable development Auth creation failed');
  userId = created.data.user.id;
  const profile = await service.from('admins').insert({ admin_id: userId, email,
    admin_name: 'Temporary MFA Audit Test', faculty: 'System Administration',
    password: 'AUTH_MANAGED', admin_level: 'admin', status: 'active' });
  if (profile.error) throw new Error('Disposable development Admin profile creation failed');

  const other = await service.from('admins').select('admin_id').neq('admin_id', userId).limit(1).single();
  if (other.error || !other.data?.admin_id) throw new Error('A second development Admin is required');
  const seed = await service.from('system_audit_logs').insert({ user_id: userId, action,
    module_name: 'security-test', target_table: 'admins', target_id: userId }).select('id').single();
  if (seed.error || !seed.data?.id) throw new Error('Disposable development audit seed failed');

  denied(await anonymous.from('system_audit_logs').select('id').eq('id', seed.data.id), 'anonymous SELECT');
  const anonInsert = await anonymous.from('system_audit_logs').insert({ user_id: userId, action });
  if (!anonInsert.error) throw new Error('anonymous INSERT unexpectedly succeeded');

  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw new Error('Disposable Admin password login failed');
  const profileRead = await client.from('admins').select('admin_id,status').eq('admin_id', userId).single();
  if (profileRead.error || profileRead.data?.status !== 'active') {
    throw new Error('AAL1 Admin cannot reach the MFA enrollment profile read');
  }
  const before = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (before.error || before.data.currentLevel !== 'aal1') throw new Error('Expected AAL1 after password login');
  denied(await client.from('system_audit_logs').select('id').eq('id', seed.data.id), 'AAL1 SELECT');
  const aal1Insert = await client.from('system_audit_logs').insert({ user_id: userId, action });
  if (!aal1Insert.error) throw new Error('AAL1 INSERT unexpectedly succeeded');

  const enrolled = await client.auth.mfa.enroll({ factorType: 'totp' });
  if (enrolled.error || !enrolled.data?.totp?.secret) throw new Error('AAL1 Admin MFA enrollment failed');
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: enrolled.data.id, code: codeFor(enrolled.data.totp.secret) });
  if (verified.error) throw new Error('AAL1 Admin MFA challenge failed');
  const after = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (after.error || after.data.currentLevel !== 'aal2') throw new Error('MFA did not reach AAL2');

  const aal2Read = await client.from('system_audit_logs').select('id').eq('id', seed.data.id).single();
  if (aal2Read.error || aal2Read.data?.id !== seed.data.id) throw new Error('AAL2 audit SELECT failed');
  const ownInsert = await client.from('system_audit_logs').insert({ user_id: userId,
    action, module_name: 'security-test', target_table: 'admins', target_id: userId }).select('id').single();
  if (ownInsert.error || !ownInsert.data?.id) throw new Error('AAL2 own-user audit INSERT failed');
  const spoofInsert = await client.from('system_audit_logs').insert({
    user_id: other.data.admin_id, action, module_name: 'security-test' });
  if (!spoofInsert.error) throw new Error('AAL2 cross-user audit INSERT unexpectedly succeeded');
  const update = await client.from('system_audit_logs').update({ action: `${action}_CHANGED` }).eq('id', seed.data.id);
  if (!update.error) throw new Error('authenticated audit UPDATE unexpectedly succeeded');
  const deletion = await client.from('system_audit_logs').delete().eq('id', seed.data.id);
  if (!deletion.error) throw new Error('authenticated audit DELETE unexpectedly succeeded');

  console.log('Development audit RLS, AAL1-to-AAL2 enrollment, and audit attribution checks passed');
} finally {
  if (userId) {
    const auditCleanup = await service.from('system_audit_logs').delete().in('action', [action, `${action}_CHANGED`]);
    const profileCleanup = await service.from('admins').delete().eq('admin_id', userId);
    const authCleanup = await service.auth.admin.deleteUser(userId);
    if (auditCleanup.error || profileCleanup.error || authCleanup.error) {
      process.exitCode = 1;
      console.error('Disposable development cleanup failed; investigate before running another test');
    } else {
      const audits = await service.from('system_audit_logs').select('id').in('action', [action, `${action}_CHANGED`]);
      const profiles = await service.from('admins').select('admin_id').eq('admin_id', userId);
      const auth = await service.auth.admin.getUserById(userId);
      if (audits.error || profiles.error || audits.data?.length || profiles.data?.length ||
          !auth.error || auth.data?.user) {
        process.exitCode = 1;
        console.error('Disposable development cleanup could not be verified');
      } else {
        console.log('Disposable development Auth, profile, factors, and audit rows cleaned up');
      }
    }
  }
}
