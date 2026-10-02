/** Disposable development-only Auth/MFA/endpoint test. Never run against production. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { SupabaseAdminGateway } from '../../.artifacts/vercel-test/server/supabase-admin.js';
import { createAdmin } from '../../.artifacts/vercel-test/server/create-admin.js';
import { deleteAdmin } from '../../.artifacts/vercel-test/server/delete-admin.js';
import { adminMfaFactors } from '../../.artifacts/vercel-test/server/admin-mfa-factors.js';
import { updateAdminEmail } from '../../.artifacts/vercel-test/server/update-admin-email.js';
import { sendStudentQrEmail } from '../../.artifacts/vercel-test/server/send-student-qr-email.js';

const ref = 'ehyqvyglirirktfmdezq';
const localEnv = new URL('../../.env.development.local', import.meta.url);
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
const devUrl = `https://${ref}.supabase.co`;
if (process.env.SUPABASE_URL && process.env.SUPABASE_URL !== devUrl) {
  throw new Error('Refusing non-development Supabase URL');
}
process.env.SUPABASE_URL = devUrl;
console.log(`Verified development target: ${ref}`);
if (process.env.SUPABASE_URL !== devUrl ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Development-only target and keys are required');
}
if (process.env.SUPABASE_SERVICE_ROLE_KEY.length < 20 || process.env.SUPABASE_ANON_KEY.length < 20) {
  throw new Error('Development project keys are masked or unavailable');
}
process.env.ADMIN_EMAIL_CHANGE_ENABLED = '1';
process.env.ADMIN_EMAIL_CHANGE_PROJECT_REF = ref;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const gateway = new SupabaseAdminGateway(service);
const temp = [];
const tempStudents = [];
const nonce = randomBytes(8).toString('hex');
const password = randomBytes(24).toString('base64url');
let cleanupFailed = false;

function otp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const start = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(start) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
async function makeIdentity(kind, level, status = 'active', enroll = true, withProfile = true) {
  const email = `codex-vercel-${kind}-${nonce}@example.com`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`Development Auth user creation failed (status ${created.error?.status ?? 'unknown'}, code ${created.error?.code ?? 'unknown'})`);
  }
  const id = created.data.user.id;
  temp.push(id);
  if (withProfile) {
    const inserted = await service.from('admins').insert({ admin_id: id, email, admin_name: 'Temporary Vercel Test',
      faculty: 'System Administration', password: 'AUTH_MANAGED', admin_level: level, status });
    if (inserted.error) throw new Error(`Development Admin profile creation failed (code ${inserted.error.code ?? 'unknown'})`);
  }
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, options);
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw new Error('Development password sign-in failed');
  const aal1Token = signed.data.session.access_token;
  if (enroll) {
    const enrollment = await client.auth.mfa.enroll({ factorType: 'totp' });
    if (enrollment.error || !enrollment.data?.totp?.secret) throw new Error('Development MFA enrollment failed');
    const code = otp(enrollment.data.totp.secret);
    const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrollment.data.id, code });
    if (verified.error) throw new Error('Development MFA verification failed');
  }
  const session = await client.auth.getSession();
  if (!session.data.session?.access_token) throw new Error('Development session unavailable');
  return { id, email, token: session.data.session.access_token, aal1Token };
}
function req(token, body) {
  return new Request('https://development.invalid/api/test', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function check(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned ${response.status}, expected ${expected}`);
}

async function makeQrStudent() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const studId = `K-${(1000 + randomBytes(2).readUInt16BE() % 9000).toString()}`;
    const existing = await service.from('students').select('student_id').eq('stud_id', studId).maybeSingle();
    if (existing.error) throw new Error('Development student collision lookup failed');
    if (existing.data) continue;
    const student = { student_id: randomUUID(), stud_id: studId, current_grade_level: 'Kinder',
      first_name: 'Temporary', last_name: 'Vercel Test', birth_date: '2015-01-01', gender: 'Male',
      email: `codex-vercel-student-${nonce}@example.com`, status: 'active' };
    const inserted = await service.from('students').insert(student);
    if (inserted.error) throw new Error(`Development QR student creation failed (code ${inserted.error.code ?? 'unknown'})`);
    tempStudents.push(student.student_id);
    return student;
  }
  throw new Error('No unused disposable student ID found');
}

try {
  const superUser = await makeIdentity('super', 'super_admin');
  const superAal1 = await makeIdentity('super-aal1', 'super_admin', 'active', false);
  const normalAal1 = await makeIdentity('normal-aal1', 'admin', 'active', false);
  const normalAal2 = await makeIdentity('normal-aal2', 'admin');
  const suspendedAdmin = await makeIdentity('suspended-admin', 'admin', 'suspended');
  const suspendedSuper = await makeIdentity('suspended-super', 'super_admin', 'suspended');
  const missingProfile = await makeIdentity('orphan', 'admin', 'active', true, false);
  const payload = { action: 'status', adminId: normalAal2.id };
  const restricted = [
    ['missing bearer', '', 401], ['malformed bearer', 'invalid-token', 401],
    ['AAL1 Admin', normalAal1.token, 403], ['AAL2 Admin', normalAal2.token, 403],
    ['AAL1 Super Admin', superAal1.token, 403], ['suspended Admin', suspendedAdmin.token, 403],
    ['suspended Super Admin', suspendedSuper.token, 403], ['missing profile', missingProfile.token, 403]
  ];
  for (const [label, token, expected] of restricted) {
    check(await adminMfaFactors(req(token, payload), gateway), expected, `MFA status ${label}`);
  }
  const factorStatus = await adminMfaFactors(req(superUser.token, payload), gateway);
  check(factorStatus, 200, 'AAL2 Super Admin MFA status');
  if ((await factorStatus.json()).enabled !== true) throw new Error('Verified TOTP status mismatch');
  check(await adminMfaFactors(req(superUser.token, { action: 'reset', adminId: superUser.id }), gateway), 403, 'Self-reset denial');
  const createBody = { name: 'Temporary Test Admin', email: `codex-vercel-target-${nonce}@example.com`,
    faculty: 'System Administration', level: 'admin', password };
  const deleteBody = { adminId: normalAal1.id };
  const emailBody = { adminId: normalAal1.id, email: `codex-vercel-changed-${nonce}@example.com`, confirmEmail: true };
  for (const [label, token, expected] of restricted) {
    check(await createAdmin(req(token, createBody), gateway), expected, `Create ${label}`);
    check(await deleteAdmin(req(token, deleteBody), gateway), expected, `Delete ${label}`);
    check(await updateAdminEmail(req(token, emailBody), gateway), expected, `Email change ${label}`);
  }
  check(await deleteAdmin(req(superUser.token, { adminId: superUser.id }), gateway), 403, 'Self-delete denial');

  const targetEmail = createBody.email;
  const created = await createAdmin(req(superUser.token, createBody), gateway);
  check(created, 201, 'Create Admin');
  const target = (await gateway.listProfiles()).find(profile => profile.email === targetEmail);
  if (!target || !(await gateway.getAuthUser(target.admin_id))) throw new Error('Created Auth/profile UID mismatch');
  temp.push(target.admin_id);
  check(await createAdmin(req(superUser.token, createBody), gateway), 409, 'Duplicate Admin email');
  const targetClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, options);
  const targetLogin = await targetClient.auth.signInWithPassword({ email: targetEmail, password });
  if (targetLogin.error) throw new Error('New Admin password login failed');
  const targetEnrollment = await targetClient.auth.mfa.enroll({ factorType: 'totp' });
  if (targetEnrollment.error || !targetEnrollment.data?.totp?.secret) throw new Error('New Admin MFA enrollment failed');
  const targetSecret = targetEnrollment.data.totp.secret;
  const targetVerification = await targetClient.auth.mfa.challengeAndVerify({ factorId: targetEnrollment.data.id, code: otp(targetSecret) });
  if (targetVerification.error) throw new Error('New Admin MFA challenge failed');
  const originalFactorIds = (await gateway.listFactors(target.admin_id)).filter(f => f.status === 'verified').map(f => f.id);
  check(await updateAdminEmail(req(superUser.token, { adminId: target.admin_id,
    email: normalAal1.email, confirmEmail: true }), gateway), 409, 'Duplicate email change');
  const changedEmail = `codex-vercel-changed-${nonce}@example.com`;
  check(await updateAdminEmail(req(superUser.token, { adminId: target.admin_id,
    email: changedEmail, confirmEmail: true }), gateway), 200, 'Update Admin email');
  const changedProfile = await gateway.getProfile(target.admin_id);
  const changedAuth = await gateway.getAuthUser(target.admin_id);
  if (changedProfile?.email !== changedEmail || changedAuth?.email !== changedEmail || changedAuth?.id !== target.admin_id) {
    throw new Error('Auth/profile email or UID synchronization failed');
  }
  const currentFactorIds = (await gateway.listFactors(target.admin_id)).filter(f => f.status === 'verified').map(f => f.id);
  if (JSON.stringify(currentFactorIds) !== JSON.stringify(originalFactorIds)) throw new Error('Email change altered MFA factors');
  const changedLoginClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, options);
  const changedLogin = await changedLoginClient.auth.signInWithPassword({ email: changedEmail, password });
  if (changedLogin.error) throw new Error('Updated email password login failed');
  const changedMfa = await changedLoginClient.auth.mfa.challengeAndVerify({ factorId: originalFactorIds[0], code: otp(targetSecret) });
  if (changedMfa.error) throw new Error('Updated email MFA challenge failed');
  check(await deleteAdmin(req(superUser.token, { adminId: target.admin_id }), gateway), 200, 'Delete Admin');
  if (await gateway.getProfile(target.admin_id) || await gateway.getAuthUser(target.admin_id)) throw new Error('Deleted Admin still exists');
  temp.splice(temp.indexOf(target.admin_id), 1);

  const student = await makeQrStudent();
  const qrBody = { studentUuid: student.student_id, qrPayload: `student_uuid:${student.student_id}`, email: student.email };
  for (const [label, token, expected] of restricted) {
    const qrExpected = label === 'AAL2 Admin' ? 200 : expected;
    check(await sendStudentQrEmail(req(token, qrBody), gateway, async () => {}), qrExpected, `QR ${label}`);
  }
  const sent = [];
  check(await sendStudentQrEmail(req(normalAal2.token, qrBody), gateway, async mail => { sent.push(mail); }), 200, 'Development QR email build');
  if (sent.length !== 1 || sent[0].to !== student.email) throw new Error('QR recipient differs from student record');
  check(await sendStudentQrEmail(req(normalAal2.token, { ...qrBody, qrPayload: student.stud_id }), gateway, async () => {}), 422, 'Mutable ID QR rejection');
  check(await sendStudentQrEmail(req(normalAal2.token, { ...qrBody, email: 'other@example.com' }), gateway, async () => {}), 409, 'Arbitrary QR recipient rejection');
  check(await sendStudentQrEmail(req(normalAal2.token, { studentUuid: randomUUID() }), gateway, async () => {}), 404, 'Unknown QR student');

  check(await adminMfaFactors(req(superUser.token, { action: 'reset', adminId: normalAal2.id }), gateway), 200, 'MFA reset');
  if ((await gateway.listFactors(normalAal2.id)).some(f => f.status === 'verified')) throw new Error('MFA reset left verified factor');
  const audits = await service.from('system_audit_logs').select('action,target_id,details').eq('user_id', superUser.id);
  if (audits.error || !audits.data?.some(row => row.action === 'MFA_RESET' && row.target_id === normalAal2.id) ||
    !audits.data?.some(row => row.action === 'ADMIN_EMAIL_CHANGED' && row.target_id === target.admin_id)) {
    throw new Error('Development security audit entries missing');
  }
  const emailAudit = audits.data.find(row => row.action === 'ADMIN_EMAIL_CHANGED' && row.target_id === target.admin_id);
  if (JSON.stringify(emailAudit?.details).includes(changedEmail)) throw new Error('Audit leaked raw email');
  console.log('Development Auth/AAL2, Admin CRUD, MFA reset, email change, audit and UUID QR endpoint checks passed');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Development integration failed');
  process.exitCode = 1;
} finally {
  for (const id of tempStudents) {
    const removed = await service.from('students').delete().eq('student_id', id);
    const remaining = await service.from('students').select('student_id').eq('student_id', id).maybeSingle();
    if (removed.error || remaining.error || remaining.data) cleanupFailed = true;
  }
  for (const id of temp.reverse()) {
    const actorAudits = await service.from('system_audit_logs').delete().eq('user_id', id);
    const targetAudits = await service.from('system_audit_logs').delete().eq('target_id', id);
    const profile = await service.from('admins').delete().eq('admin_id', id);
    const auth = await service.auth.admin.deleteUser(id, false);
    if (actorAudits.error || targetAudits.error || profile.error || (auth.error && auth.error.status !== 404)) cleanupFailed = true;
  }
  for (const id of temp) {
    const profile = await gateway.getProfile(id).catch(() => 'unknown');
    const auth = await gateway.getAuthUser(id).catch(() => 'unknown');
    if (profile || auth) cleanupFailed = true;
  }
  console.log(`Current-run development account and student cleanup: ${cleanupFailed ? 'FAILED' : 'verified'}`);
  if (cleanupFailed) process.exitCode = 1;
}
