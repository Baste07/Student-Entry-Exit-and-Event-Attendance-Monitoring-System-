/** Disposable lockout/Auth/RLS test for Development Supabase only. */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { adminLogin } from '../../../.artifacts/vercel-test/server/admin-login.js';
import { SupabaseLoginGateway } from '../../../.artifacts/vercel-test/server/supabase-login.js';

const projectRef = 'ehyqvyglirirktfmdezq';
const url = `https://${projectRef}.supabase.co`;
const envFile = new URL('../../../.env.development.local', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
assert.equal(process.env.SUPABASE_URL, url, 'Development project URL required');
assert.equal(process.env.WEB_SUPABASE_URL || url, url, 'Development browser project URL required');
assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY &&
  (process.env.WEB_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY),
  'Development public and server credentials are required');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const publicKey = process.env.WEB_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const random = () => randomBytes(24).toString('base64url');
const prefix = `codex-admin-lockout-${randomBytes(6).toString('hex')}`;
const created = [];
let originalLimit;

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const letter of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(letter);
    assert.ok(value >= 0);
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

async function createAdmin(suffix, level) {
  const email = `${prefix}-${suffix}@example.com`;
  const password = random();
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  assert.ok(data.user?.id);
  const id = data.user.id;
  created.push(id);
  const inserted = await service.from('admins').insert({ admin_id: id, email,
    admin_name: 'Disposable Lockout Test', faculty: 'System Administration',
    password: 'AUTH_MANAGED', admin_level: level, status: 'active' });
  assert.ifError(inserted.error);
  return { id, email, password };
}

async function signedIn(account, enroll = false) {
  const client = createClient(url, publicKey, options);
  const signed = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  assert.ifError(signed.error);
  const ownProfile = await client.from('admins').select('admin_id,login_locked')
    .eq('admin_id', account.id).single();
  assert.ifError(ownProfile.error);
  assert.equal(ownProfile.data.admin_id, account.id);
  if (enroll) {
    const enrolled = await client.auth.mfa.enroll({ factorType: 'totp' });
    assert.ifError(enrolled.error);
    assert.ok(enrolled.data?.totp?.secret);
    account.totpSecret = enrolled.data.totp.secret;
    account.factorId = enrolled.data.id;
    const verified = await client.auth.mfa.challengeAndVerify({
      factorId: enrolled.data.id, code: totp(enrolled.data.totp.secret) });
    assert.ifError(verified.error);
  }
  return client;
}

async function login(email, password, gateway = new SupabaseLoginGateway()) {
  return adminLogin(new Request('https://development.invalid/api/admin-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }), gateway);
}

async function state(id) {
  const read = await service.from('admins')
    .select('failed_login_attempts,login_locked,login_locked_at')
    .eq('admin_id', id).single();
  assert.ifError(read.error);
  return read.data;
}

try {
  console.log(`Verified Development project: ${projectRef}`);
  const setting = await service.from('system_settings').select('value')
    .eq('key', 'admin_login_max_attempts').single();
  assert.ifError(setting.error);
  originalLimit = setting.data.value;
  assert.equal(originalLimit, '3');

  const normal = await createAdmin('normal', 'admin');
  const parallel = await createAdmin('parallel', 'admin');
  const superAdmin = await createAdmin('super', 'super_admin');
  const normalClient = await signedIn(normal, true);
  const superClient = await signedIn(superAdmin, true);
  const normalAal = await normalClient.auth.mfa.getAuthenticatorAssuranceLevel();
  const superAal = await superClient.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(normalAal.data.currentLevel, 'aal2');
  assert.equal(superAal.data.currentLevel, 'aal2');
  const aal1Super = createClient(url, publicKey, options);
  const aal1Signed = await aal1Super.auth.signInWithPassword({
    email: superAdmin.email, password: superAdmin.password });
  assert.ifError(aal1Signed.error);
  assert.equal((await aal1Super.auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal1');
  const prematureUnlock = await aal1Super.rpc('unlock_admin_login', { p_admin_id: parallel.id });
  assert.ok(prematureUnlock.error, 'AAL1 Super Admin cannot unlock');

  const invalidSetting2 = await service.from('system_settings').update({ value: '2' })
    .eq('key', 'admin_login_max_attempts');
  assert.ok(invalidSetting2.error, 'DB must reject limit 2');
  const invalidSetting7 = await service.from('system_settings').update({ value: '7' })
    .eq('key', 'admin_login_max_attempts');
  assert.ok(invalidSetting7.error, 'DB must reject limit 7');
  const validSetting6 = await superClient.from('system_settings').update({ value: '6' })
    .eq('key', 'admin_login_max_attempts');
  assert.ifError(validSetting6.error);
  const normalSettingWrite = await normalClient.from('system_settings').update({ value: '3' })
    .eq('key', 'admin_login_max_attempts').select('key');
  assert.ok(normalSettingWrite.error || normalSettingWrite.data?.length === 0,
    'Normal Admin must not change the setting');
  const restoreLimit = await superClient.from('system_settings').update({ value: '3' })
    .eq('key', 'admin_login_max_attempts');
  assert.ifError(restoreLimit.error);

  const normalUnlock = await normalClient.rpc('unlock_admin_login', { p_admin_id: parallel.id });
  assert.ok(normalUnlock.error, 'Normal Admin must not call Super Admin unlock');
  const directWrite = await normalClient.from('admins')
    .update({ login_locked: false }).eq('admin_id', normal.id);
  assert.ok(directWrite.error, 'Authenticated browser must not write lock state');

  let response = await login(normal.email, 'wrong-one');
  assert.equal(response.status, 401);
  assert.equal((await state(normal.id)).failed_login_attempts, 1);
  response = await login(normal.email, 'wrong-two', new SupabaseLoginGateway());
  assert.equal(response.status, 401);
  assert.equal((await state(normal.id)).failed_login_attempts, 2);
  response = await login(normal.email, 'wrong-three');
  assert.equal(response.status, 423);
  assert.equal((await state(normal.id)).login_locked, true);

  response = await login(normal.email, normal.password);
  assert.equal(response.status, 423, 'Correct password must remain blocked');
  const direct = await createClient(url, publicKey, options).auth.signInWithPassword({
    email: normal.email, password: normal.password });
  assert.ifError(direct.error);
  const protectedRead = await normalClient.from('system_settings').select('key')
    .eq('key', 'admin_login_max_attempts');
  assert.ok(protectedRead.error || protectedRead.data?.length === 0,
    'Direct/stale AAL2 Auth session must not bypass database lock');
  const changedPassword = random();
  const authChanged = await service.auth.admin.updateUserById(normal.id, { password: changedPassword });
  assert.ifError(authChanged.error);
  normal.password = changedPassword;
  assert.equal((await login(normal.email, normal.password)).status, 423,
    'Password change/recovery must not clear Admin lock');

  const unlocked = await superClient.rpc('unlock_admin_login', { p_admin_id: normal.id });
  assert.ifError(unlocked.error);
  assert.equal(unlocked.data.success, true);
  assert.equal((await state(normal.id)).failed_login_attempts, 0);
  assert.equal((await state(normal.id)).login_locked, false);
  assert.equal((await login(normal.email, 'wrong-after-unlock')).status, 401);
  assert.equal((await state(normal.id)).failed_login_attempts, 1);
  assert.equal((await login(normal.email, normal.password)).status, 200);
  assert.equal((await state(normal.id)).failed_login_attempts, 0);

  const parallelResults = await Promise.all(Array.from({ length: 8 }, () =>
    service.rpc('record_admin_password_failure', { p_email: parallel.email })));
  assert.ok(parallelResults.every(result => !result.error));
  assert.equal((await state(parallel.id)).failed_login_attempts, 8);
  assert.equal((await state(parallel.id)).login_locked, true);

  const audits = await service.from('system_audit_logs')
    .select('user_id,target_id,action').eq('target_id', normal.id);
  assert.ifError(audits.error);
  assert.ok(audits.data.some(row => row.action === 'ADMIN_LOGIN_LOCKED' && row.user_id === null));
  assert.ok(audits.data.some(row => row.action === 'ADMIN_PASSWORD_LOGIN_FAILED' && row.user_id === null));
  assert.ok(audits.data.some(row => row.action === 'ADMIN_LOGIN_UNLOCKED' && row.user_id === superAdmin.id));

  const badTotp = await superClient.auth.mfa.challengeAndVerify({
    factorId: superAdmin.factorId,
    code: totp(superAdmin.totpSecret) === '000000' ? '000001' : '000000' });
  assert.ok(badTotp.error, 'An intentionally wrong TOTP should fail');
  assert.equal((await state(superAdmin.id)).failed_login_attempts, 0,
    'TOTP errors do not count as password failures');

  console.log('Development password, setting, RLS, unlock, concurrency, and MFA checks passed');
} finally {
  if (originalLimit !== undefined) {
    const restored = await service.from('system_settings').update({ value: originalLimit })
      .eq('key', 'admin_login_max_attempts');
    if (restored.error) { process.exitCode = 1; console.error('Development setting restore failed'); }
  }
  if (created.length) {
    const audits = await service.from('system_audit_logs').delete().in('target_id', created);
    const profiles = await service.from('admins').delete().in('admin_id', created);
    let authFailed = false;
    for (const id of created) {
      const deleted = await service.auth.admin.deleteUser(id);
      if (deleted.error) authFailed = true;
    }
    const remainingProfiles = await service.from('admins').select('admin_id').in('admin_id', created);
    const remainingAudits = await service.from('system_audit_logs').select('id').in('target_id', created);
    if (audits.error || profiles.error || authFailed || remainingProfiles.error ||
        remainingAudits.error || remainingProfiles.data?.length || remainingAudits.data?.length) {
      process.exitCode = 1;
      console.error('Disposable development cleanup needs review');
    } else {
      console.log('Disposable Development Auth, Admin profiles, factors, and audits cleaned up');
    }
  }
}
