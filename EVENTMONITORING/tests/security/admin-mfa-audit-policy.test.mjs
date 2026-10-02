import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../../database/migrations/20260930_admin_totp_mfa.sql', import.meta.url), 'utf8');
const auditBlock = migration.slice(migration.indexOf("if to_regclass('public.system_audit_logs')"));

test('the MFA migration removes legacy permissive audit policies before replacements', () => {
  for (const name of ['Allow inserts for authenticated users', 'Allow reads for authenticated users']) {
    const drop = auditBlock.indexOf(`drop policy if exists "${name}" on public.system_audit_logs;`);
    const create = auditBlock.indexOf('create policy "AAL2 admins read audit"');
    assert.ok(drop >= 0 && drop < create, `${name} must be dropped before new policies`);
  }
  assert.match(auditBlock, /revoke all on table public\.system_audit_logs from public, anon, authenticated;/);
  assert.match(auditBlock, /grant select, insert on table public\.system_audit_logs to authenticated;/);
  assert.match(auditBlock, /create policy "AAL2 admins append own audit"[\s\S]*?user_id = \(select auth\.uid\(\)\)/);
});
