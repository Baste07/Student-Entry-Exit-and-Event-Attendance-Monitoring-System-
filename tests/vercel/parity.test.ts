import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdminGateway, AdminProfile, AuditRecord, AuthAccount, Factor, StudentRecord } from '../../server/types.js';
import { createAdmin } from '../../server/create-admin.js';
import { updateAdminPassword } from '../../server/update-admin-password.js';
import { validAdminPassword } from '../../server/admin-password-policy.js';
import { deleteAdmin } from '../../server/delete-admin.js';
import { adminMfaFactors } from '../../server/admin-mfa-factors.js';
import { updateAdminEmail } from '../../server/update-admin-email.js';
import { sendStudentQrEmail } from '../../server/send-student-qr-email.js';
import type { QrMail } from '../../server/mail.js';

const IDS = {
  normal: '11111111-1111-4111-8111-111111111111',
  super: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333',
  suspended: '44444444-4444-4444-8444-444444444444',
  newUser: '55555555-5555-4555-8555-555555555555',
  student: '66666666-6666-4666-8666-666666666666'
} as const;
const FACTOR = '77777777-7777-4777-8777-777777777777';
const profiles: AdminProfile[] = [
  { admin_id: IDS.normal, email: 'normal@example.invalid', admin_name: 'Normal Operator', admin_level: 'admin', status: 'active', login_locked: false },
  { admin_id: IDS.super, email: 'super@example.invalid', admin_name: 'Super Operator', admin_level: 'super_admin', status: 'active', login_locked: false },
  { admin_id: IDS.target, email: 'target@example.invalid', admin_name: 'Target Operator', admin_level: 'admin', status: 'active', login_locked: false },
  { admin_id: IDS.suspended, email: 'suspended@example.invalid', admin_name: 'Suspended Operator', admin_level: 'super_admin', status: 'suspended', login_locked: false }
];

class Fixture implements AdminGateway {
  profiles = new Map(profiles.map(row => [row.admin_id, structuredClone(row)]));
  users = new Map(profiles.map(row => [row.admin_id, { id: row.admin_id, email: row.email, email_confirmed_at: '2026-01-01' } as AuthAccount]));
  factors = new Map<string, Factor[]>([[IDS.super, [{ id: FACTOR, factor_type: 'totp', status: 'verified' }]]]);
  audits: AuditRecord[] = [];
  failProfileInsert = false;
  failAuthUpdate = false;
  passwordUpdates = 0;
  student: StudentRecord = { student_id: IDS.student, stud_id: '2-0001', first_name: 'Test', middle_name: null,
    last_name: 'Student', birth_date: '2015-01-01', gender: 'Female', email: 'student@example.invalid',
    current_grade_level: 'Grade 2', sections: { section_name: 'Section A' } };
  async getUserFromToken(token: string) {
    if (!issuedTokens.has(token)) return null;
    return this.users.get(issuedTokens.get(token)!) || null;
  }
  async getProfile(id: string) { return this.profiles.get(id) || null; }
  async listProfiles() { return [...this.profiles.values()]; }
  async findProfileEmail(email: string) { return [...this.profiles.values()].find(p => p.email === email) || null; }
  async getAuthUser(id: string) { return this.users.get(id) || null; }
  async listAuthUsers() { return [...this.users.values()]; }
  async listFactors(id: string) { return this.factors.get(id) || []; }
  async deleteFactor(id: string, factorId: string) { this.factors.set(id, (this.factors.get(id) || []).filter(f => f.id !== factorId)); }
  async createAuthUser(email: string) { const user = { id: IDS.newUser, email, email_confirmed_at: '2026-01-01' }; this.users.set(user.id, user); return user; }
  async updateOwnPassword(tokenValue: string, password: string) {
    assert.ok(issuedTokens.has(tokenValue));
    assert.ok(password.length >= 12);
    this.passwordUpdates++;
  }
  async deleteAuthUser(id: string): Promise<'deleted' | 'missing'> { const present = this.users.delete(id); return present ? 'deleted' : 'missing'; }
  async updateAuthEmail(id: string, email: string) { if (this.failAuthUpdate) throw new Error('rejected'); this.users.set(id, { ...this.users.get(id)!, email, email_confirmed_at: '2026-01-01' }); }
  async insertProfile(profile: AdminProfile) { if (this.failProfileInsert) throw new Error('failed'); this.profiles.set(profile.admin_id, profile); }
  async updateProfileEmail(id: string, email: string) { const profile = this.profiles.get(id); if (!profile) return false; profile.email = email; return true; }
  async deleteProfile(id: string) { this.profiles.delete(id); }
  async insertAudit(row: AuditRecord) { this.audits.push(row); }
  async getStudent(id: string) { return id === IDS.student ? this.student : null; }
}

const issuedTokens = new Map<string, string>();
function token(id: string, aal: 'aal1' | 'aal2' = 'aal2', recovery = false): string {
  const value = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', aal,
    amr: recovery ? [{ method: 'recovery' }] : [{ method: 'password' }] })).toString('base64url'), 'signature'].join('.');
  issuedTokens.set(value, id);
  return value;
}
function request(payload: unknown, bearer?: string, method = 'POST'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request('https://example.invalid/api/action', { method, headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined });
}
type Handler = (request: Request, gateway: AdminGateway) => Promise<Response>;
async function status(handler: Handler, payload: unknown, bearer?: string, fixture = new Fixture()) {
  return (await handler(request(payload, bearer), fixture)).status;
}
const createBody = { name: 'New Admin', email: 'new@example.invalid', faculty: 'Science', level: 'admin', password: 'TemporaryStrongPassword123!' };
const deleteBody = { adminId: IDS.target };
const mfaBody = { action: 'status', adminId: IDS.target };
const emailBody = { adminId: IDS.target, email: 'changed@example.invalid', confirmEmail: true };
const qrBody = { studentUuid: IDS.student, email: 'student@example.invalid', qrPayload: `student_uuid:${IDS.student}` };

process.env.ADMIN_EMAIL_CHANGE_ENABLED = '1';
process.env.ADMIN_EMAIL_CHANGE_PROJECT_REF = 'ehyqvyglirirktfmdezq';
process.env.SUPABASE_URL = 'https://ehyqvyglirirktfmdezq.supabase.co';

test('Super Admin endpoint authorization matrix matches PHP AAL2 boundary', async () => {
  for (const [handler, payload] of [[createAdmin, createBody], [deleteAdmin, deleteBody],
    [adminMfaFactors, mfaBody], [updateAdminEmail, emailBody]] as [Handler, unknown][]) {
    assert.equal(await status(handler, payload), 401);
    assert.equal(await status(handler, payload, token(IDS.normal, 'aal1')), 403);
    assert.equal(await status(handler, payload, token(IDS.normal)), 403);
    assert.equal(await status(handler, payload, token(IDS.super, 'aal1')), 403);
    assert.equal(await status(handler, payload, token(IDS.suspended)), 403);
    assert.equal(await status(handler, payload, token(IDS.super)) < 400, true);
  }
});

test('QR endpoint allows active AAL2 Admin but denies all AAL1 and suspended callers', async () => {
  const handler: Handler = (req, gateway) => sendStudentQrEmail(req, gateway, async () => {});
  assert.equal(await status(handler, qrBody), 401);
  assert.equal(await status(handler, qrBody, token(IDS.normal, 'aal1')), 403);
  assert.equal(await status(handler, qrBody, token(IDS.suspended)), 403);
  assert.equal(await status(handler, qrBody, token(IDS.normal)), 200);
  assert.equal(await status(handler, qrBody, token(IDS.super)), 200);
});

test('a locked AAL2 Admin cannot use privileged APIs even with a valid Auth token', async () => {
  const fixture = new Fixture();
  fixture.profiles.set(IDS.super, { ...profiles[1], login_locked: true });
  assert.equal(await status(createAdmin, createBody, token(IDS.super), fixture), 403);
  fixture.profiles.set(IDS.normal, { ...profiles[0], login_locked: true });
  const handler: Handler = (req, gateway) => sendStudentQrEmail(req, gateway, async () => {});
  assert.equal(await status(handler, qrBody, token(IDS.normal), fixture), 403);
});

test('create uses one UID, never stores the supplied password, and rolls back failed profile creation', async () => {
  const fixture = new Fixture();
  assert.equal(await status(createAdmin, createBody, token(IDS.super), fixture), 201);
  assert.equal(fixture.profiles.get(IDS.newUser)?.password, 'AUTH_MANAGED');
  assert.equal(fixture.users.get(IDS.newUser)?.id, fixture.profiles.get(IDS.newUser)?.admin_id);
  assert.equal(await status(createAdmin, createBody, token(IDS.super), fixture), 409);
  const failed = new Fixture(); failed.failProfileInsert = true;
  assert.equal(await status(createAdmin, createBody, token(IDS.super), failed), 502);
  assert.equal(failed.users.has(IDS.newUser), false);
});

test('Admin password policy rejects weak passwords and identity substrings at the API', async () => {
  const good = 'SecureRandomPhrase123!';
  assert.equal(validAdminPassword(good, 'new@example.invalid', 'New Admin'), true);
  assert.equal(validAdminPassword('😀Abcdefgh1!', 'new@example.invalid', 'New Admin'), false);
  for (const password of ['Short1!', 'nouppercasephrase123!', 'NOLOWERCASEPHRASE123!',
    'NoNumberInThisPhrase!', 'NoSpecialCharacter123', 'NewAdminSecure123!',
    'new@example.invalidA1!', 'newSomethingSecure123!']) {
    assert.equal(validAdminPassword(password, 'new@example.invalid', 'New Admin'), false);
    const fixture = new Fixture();
    const response = await createAdmin(request({ ...createBody, password }, token(IDS.super)), fixture);
    assert.equal(response.status, 400);
    assert.equal(fixture.users.has(IDS.newUser), false);
    assert.equal(JSON.stringify(await response.json()).includes(password), false);
  }
  assert.equal(await status(createAdmin, { ...createBody, password: good }, token(IDS.super)), 201);
});

test('Admin password update requires an active caller and AAL2, except recovery without TOTP', async () => {
  const body = { password: 'AnotherSecurePhrase123!' };
  const fixture = new Fixture();
  assert.equal(await status(updateAdminPassword, body, undefined, fixture), 401);
  assert.equal(await status(updateAdminPassword, body, token(IDS.normal, 'aal1'), fixture), 403);
  assert.equal(await status(updateAdminPassword, body, token(IDS.super, 'aal1', true), fixture), 403);
  assert.equal(await status(updateAdminPassword, body, token(IDS.suspended), fixture), 403);
  assert.equal(await status(updateAdminPassword, body, token(IDS.normal, 'aal1', true), fixture), 200);
  assert.equal(await status(updateAdminPassword, body, token(IDS.super), fixture), 200);
  assert.equal(fixture.passwordUpdates, 2);
  assert.equal(await status(updateAdminPassword, { password: 'short' }, token(IDS.super), fixture), 400);
  assert.equal(fixture.passwordUpdates, 2);
  fixture.profiles.set(IDS.super, { ...fixture.profiles.get(IDS.super)!, admin_name: '' });
  assert.equal(await status(updateAdminPassword, body, token(IDS.super), fixture), 502);
  assert.equal(fixture.passwordUpdates, 2);
});

test('Admin creation and email change accept valid domains and reject malformed addresses', async () => {
  for (const email of ['admin@gmail.com', 'person@yahoo.com', 'user@outlook.com',
    'admin@plpasig.edu.ph', 'codex-super-20260926@example.com']) {
    assert.equal(await status(createAdmin, { ...createBody, email }, token(IDS.super), new Fixture()), 201);
    assert.equal(await status(updateAdminEmail, { ...emailBody, email }, token(IDS.super), new Fixture()), 200);
  }
  for (const email of ['abc', 'user@', '@example.com']) {
    assert.equal(await status(createAdmin, { ...createBody, email }, token(IDS.super), new Fixture()), 400);
    assert.equal(await status(updateAdminEmail, { ...emailBody, email }, token(IDS.super), new Fixture()), 400);
  }
});

test('delete blocks self-delete and preserves an active recovery Super Admin', async () => {
  const fixture = new Fixture();
  assert.equal(await status(deleteAdmin, { adminId: IDS.super }, token(IDS.super), fixture), 403);
  assert.equal(await status(deleteAdmin, { adminId: IDS.target }, token(IDS.super), fixture), 200);
  assert.equal(fixture.users.has(IDS.target), false);
  assert.equal(fixture.profiles.has(IDS.target), false);
  fixture.profiles.set(IDS.target, { ...profiles[2], admin_level: 'super_admin' });
  fixture.factors.set(IDS.super, []);
  assert.equal(await status(deleteAdmin, { adminId: IDS.target }, token(IDS.super), fixture), 409);
});

test('MFA reset blocks self-reset, removes only verified TOTP, and records audit', async () => {
  const fixture = new Fixture();
  fixture.factors.set(IDS.target, [{ id: FACTOR, factor_type: 'totp', status: 'verified' }]);
  assert.equal(await status(adminMfaFactors, { action: 'reset', adminId: IDS.super }, token(IDS.super), fixture), 403);
  assert.equal(await status(adminMfaFactors, { action: 'reset', adminId: IDS.target }, token(IDS.super), fixture), 200);
  assert.equal(fixture.factors.get(IDS.target)?.length, 0);
  assert.equal(fixture.audits[0].action, 'MFA_RESET');
});

test('email change keeps UID and factor; conflicting or rejected Auth email compensates profile', async () => {
  const fixture = new Fixture();
  assert.equal(await status(updateAdminEmail, { ...emailBody, email: 'normal@example.invalid' }, token(IDS.super), fixture), 409);
  assert.equal(await status(updateAdminEmail, emailBody, token(IDS.super), fixture), 200);
  assert.equal(fixture.users.get(IDS.target)?.id, IDS.target);
  assert.equal(fixture.profiles.get(IDS.target)?.email, 'changed@example.invalid');
  assert.equal(fixture.audits[0].details.new_email_sha256?.toString().includes('@'), false);
  const failed = new Fixture(); failed.failAuthUpdate = true;
  assert.equal(await status(updateAdminEmail, emailBody, token(IDS.super), failed), 502);
  assert.equal(failed.profiles.get(IDS.target)?.email, 'target@example.invalid');
  assert.equal(await status(updateAdminEmail, { ...emailBody, adminId: IDS.super }, token(IDS.super), new Fixture()), 409);
});

test('QR email uses the immutable UUID and database recipient; no remote rendering', async () => {
  const fixture = new Fixture();
  const sentMail: QrMail[] = [];
  const handler: Handler = (req, gateway) => sendStudentQrEmail(req, gateway, async sent => { sentMail.push(sent); });
  assert.equal(await status(handler, { ...qrBody, email: 'other@example.invalid' }, token(IDS.normal), fixture), 409);
  assert.equal(await status(handler, { ...qrBody, studentUuid: IDS.newUser, qrPayload: `student_uuid:${IDS.newUser}` }, token(IDS.normal), fixture), 404);
  assert.equal(await status(handler, qrBody, token(IDS.normal), fixture), 200);
  assert.equal(sentMail[0]?.to, fixture.student.email);
  assert.match(sentMail[0]?.html || '', /2-0001/);
  assert.match(sentMail[0]?.attachments[1].filename || '', /\.png$/);
  assert.equal((sentMail[0]?.attachments[1].content as Buffer).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(await status((req, gateway) => sendStudentQrEmail(req, gateway, async () => { throw new Error('smtp'); }), qrBody, token(IDS.normal)), 500);
});

test('verified tokens still require a matching active profile', async () => {
  const unknown = '88888888-8888-4888-8888-888888888888';
  const fixture = new Fixture();
  fixture.users.set(unknown, { id: unknown, email: 'orphan@example.invalid' });
  assert.equal(await status(createAdmin, createBody, token(unknown), fixture), 403);
  assert.equal(await status(createAdmin, createBody, 'bad.jwt.token', fixture), 401);
  assert.equal(await status(createAdmin, createBody, token(IDS.super, 'aal1'), fixture), 403);
  fixture.profiles.set(IDS.super, { ...fixture.profiles.get(IDS.super)!, status: 'suspended' });
  assert.equal(await status(createAdmin, createBody, token(IDS.super), fixture), 403);
});

test('invalid methods and input do not create or delete any account', async () => {
  const fixture = new Fixture();
  assert.equal((await createAdmin(request(createBody, token(IDS.super), 'GET'), fixture)).status, 405);
  assert.equal(await status(createAdmin, { ...createBody, level: 'super_admin', password: '' }, token(IDS.super), fixture), 400);
  assert.equal(await status(deleteAdmin, { adminId: 'not-a-uuid' }, token(IDS.super), fixture), 400);
  assert.equal(fixture.users.has(IDS.newUser), false);
  assert.equal(fixture.profiles.has(IDS.target), true);
});

test('MFA status requires a matching profile and reset preserves verified recovery', async () => {
  const fixture = new Fixture();
  assert.equal(await status(adminMfaFactors, { action: 'status', adminId: IDS.newUser }, token(IDS.super), fixture), 404);
  fixture.profiles.set(IDS.target, { ...fixture.profiles.get(IDS.target)!, admin_level: 'super_admin' });
  fixture.factors.set(IDS.super, []);
  assert.equal(await status(adminMfaFactors, { action: 'reset', adminId: IDS.target }, token(IDS.super), fixture), 409);
  assert.equal(fixture.audits.length, 0);
});

test('QR endpoint rejects non-UUID payloads and missing student email', async () => {
  const fixture = new Fixture();
  const handler: Handler = (req, gateway) => sendStudentQrEmail(req, gateway, async () => {});
  assert.equal(await status(handler, { ...qrBody, qrPayload: '2-0001' }, token(IDS.normal), fixture), 422);
  fixture.student.email = null;
  assert.equal(await status(handler, qrBody, token(IDS.normal), fixture), 422);
});

test('MFA response schemas and disabled email endpoint match PHP', async () => {
  const fixture = new Fixture();
  const denied = await adminMfaFactors(request(mfaBody, token(IDS.normal)), fixture);
  assert.deepEqual(Object.keys(await denied.json()), ['message']);
  const statusResponse = await adminMfaFactors(request(mfaBody, token(IDS.super)), fixture);
  assert.deepEqual(Object.keys(await statusResponse.json()), ['enabled']);
  const method = await adminMfaFactors(request(mfaBody, token(IDS.super), 'GET'), fixture);
  assert.deepEqual(Object.keys(await method.json()), ['message']);
  const enabled = process.env.ADMIN_EMAIL_CHANGE_ENABLED;
  process.env.ADMIN_EMAIL_CHANGE_ENABLED = '0';
  try {
    const disabled = await updateAdminEmail(request(emailBody, token(IDS.super)), fixture);
    assert.deepEqual(Object.keys(await disabled.json()), ['success', 'message']);
  } finally {
    process.env.ADMIN_EMAIL_CHANGE_ENABLED = enabled;
  }
});
