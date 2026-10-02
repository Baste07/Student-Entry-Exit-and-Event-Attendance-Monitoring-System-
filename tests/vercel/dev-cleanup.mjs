/** Clean only disposable codex-vercel-* identities in the approved development project. */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const ref = 'ehyqvyglirirktfmdezq';
const devUrl = `https://${ref}.supabase.co`;
const envFile = new URL('../../.env.development.local', import.meta.url);
if (readFileSync(envFile, 'utf8').includes('hgdqarcdfycdesavwrvq')) throw new Error('Production reference in development file');
process.loadEnvFile(envFile);
if (process.env.SUPABASE_URL !== devUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY.length < 20) throw new Error('Development project guard failed');
const service = createClient(devUrl, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const pattern = /^codex-vercel-(?:super|super-aal1|normal-aal1|normal-aal2|suspended|suspended-admin|suspended-super|orphan|target|changed)-[0-9a-f]{16}@example\.com$/;
const users = [];
for (let page = 1; page <= 100; page++) {
  const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
  if (error || !data) throw new Error(`Development Auth listing failed (HTTP ${error?.status ?? 'unknown'})`);
  users.push(...data.users.filter(user => pattern.test(user.email || '')));
  if (data.users.length < 100) break;
}
const { data: profiles, error: profileError } = await service.from('admins')
  .select('admin_id,email').ilike('email', 'codex-vercel-%@example.com');
if (profileError) throw new Error(`Development profile listing failed (HTTP ${profileError.status ?? 'unknown'})`);
const ids = new Set([...users.map(user => user.id), ...(profiles || []).filter(row => pattern.test(row.email || '')).map(row => row.admin_id)]);
console.log(`Verified development target: ${ref}; disposable users ${users.length}, profiles ${(profiles || []).length}`);
const { data: studentRows, error: studentError } = await service.from('students')
  .select('student_id,email').ilike('email', 'codex-vercel-student-%@example.com');
if (studentError) throw new Error('Could not inspect synthetic QR students');
const testStudents = (studentRows || []).filter(row => /^codex-vercel-student-[0-9a-f]{16}@example\.com$/.test(row.email || ''));
for (const student of testStudents) {
  const removed = await service.from('students').delete().eq('student_id', student.student_id);
  if (removed.error) throw new Error(`Synthetic QR student cleanup failed (code ${removed.error.code ?? 'unknown'})`);
}
console.log(`Synthetic QR students removed: ${testStudents.length}`);
const { data: activeSupers, error: superError } = await service.from('admins')
  .select('admin_id').eq('admin_level', 'super_admin').eq('status', 'active');
if (superError) throw new Error('Could not inspect active development Super Admin count');
console.log(`Active development Super Admin profiles: ${(activeSupers || []).length}; disposable among them: ${(activeSupers || []).filter(row => ids.has(row.admin_id)).length}`);
let otherVerifiedRecovery = 0;
let otherAuthAccounts = 0;
let otherConfirmedAccounts = 0;
for (const row of activeSupers || []) {
  if (ids.has(row.admin_id)) continue;
  const auth = await service.auth.admin.getUserById(row.admin_id);
  const factors = await service.auth.admin.mfa.listFactors({ userId: row.admin_id });
  if (!auth.error && auth.data?.user) otherAuthAccounts++;
  if (!auth.error && auth.data?.user?.email_confirmed_at) otherConfirmedAccounts++;
  if (!auth.error && auth.data?.user?.email_confirmed_at && !factors.error &&
    factors.data?.factors?.some(factor => factor.factor_type === 'totp' && factor.status === 'verified')) otherVerifiedRecovery++;
}
console.log(`Other active, confirmed Super Admins with verified TOTP: ${otherVerifiedRecovery}`);
console.log(`Other active Super Admin Auth accounts: ${otherAuthAccounts}; confirmed: ${otherConfirmedAccounts}`);

function check(result, stage) {
  if (result.error) throw new Error(`${stage} failed (HTTP ${result.error.status ?? 'unknown'}, code ${result.error.code ?? 'unknown'})`);
}
const protectedTestIds = new Set(otherVerifiedRecovery === 0
  ? (activeSupers || []).filter(row => ids.has(row.admin_id)).map(row => row.admin_id) : []);
for (const id of ids) {
  check(await service.from('system_audit_logs').delete().eq('user_id', id), 'Test audit cleanup');
  check(await service.from('system_audit_logs').delete().eq('target_id', id), 'Test target audit cleanup');
  if (protectedTestIds.has(id)) continue;
  check(await service.from('admins').delete().eq('admin_id', id), 'Test profile cleanup');
  const result = await service.auth.admin.deleteUser(id, false);
  if (result.error && result.error.status !== 404) {
    throw new Error(`Test Auth cleanup failed (HTTP ${result.error.status ?? 'unknown'}, code ${result.error.code ?? 'unknown'})`);
  }
}
for (const id of ids) {
  if (protectedTestIds.has(id)) continue;
  const auth = await service.auth.admin.getUserById(id);
  const profile = await service.from('admins').select('admin_id').eq('admin_id', id).maybeSingle();
  if ((!auth.error && auth.data?.user) || profile.error || profile.data) {
    throw new Error('Disposable development account still exists after cleanup');
  }
}
if (protectedTestIds.size) {
  console.error(`Cleanup incomplete: ${protectedTestIds.size} disposable Super Admin is protected by the last-usable-Super-Admin rule`);
  process.exitCode = 2;
} else {
  console.log(`Disposable development cleanup verified: ${ids.size} Auth/profile identities absent; associated factors removed with Auth`);
}
