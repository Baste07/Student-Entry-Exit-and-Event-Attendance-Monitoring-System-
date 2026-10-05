import test from 'node:test';
import assert from 'node:assert/strict';
import { adminLogin, type AdminLoginGateway, type PasswordVerification } from '../../server/admin-login.js';
import { serverClient } from '../../server/supabase-admin.js';

const ID = '11111111-1111-4111-8111-111111111111';

test('server client accepts new secret keys and legacy service-role JWTs during rotation', () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const payload = (role: string) => Buffer.from(JSON.stringify({ role })).toString('base64url');
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    assert.ok(serverClient());
    process.env.SUPABASE_SERVICE_ROLE_KEY = `synthetic-header.${payload('service_role')}.synthetic-signature`;
    assert.ok(serverClient());
    process.env.SUPABASE_SERVICE_ROLE_KEY = `synthetic-header.${payload('anon')}.synthetic-signature`;
    assert.throws(() => serverClient());
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

class LoginFixture implements AdminLoginGateway {
  password: PasswordVerification = { kind: 'invalid' };
  failure = { known: true, attempts: 1, remaining: 2, locked: false, recoveryProtected: false };
  success = { allowed: true, locked: false };
  failureCalls = 0;
  successCalls = 0;
  throwVerification = false;
  async verifyPassword(_email: string, _password: string): Promise<PasswordVerification> {
    if (this.throwVerification) throw new Error('network failure');
    return this.password;
  }
  async recordFailure(_email: string) { this.failureCalls++; return this.failure; }
  async recordSuccess(_id: string) { this.successCalls++; return this.success; }
}

function request(email = 'admin@example.com', password = 'incorrect', method = 'POST') {
  return new Request('https://example.invalid/api/admin-login', { method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ email, password }) : undefined });
}

test('failed password returns remaining attempts; unknown email stays generic', async () => {
  const gateway = new LoginFixture();
  let response = await adminLogin(request(), gateway);
  assert.equal(response.status, 401);
  assert.match((await response.json()).message, /2 attempts remaining/);
  gateway.failure = { ...gateway.failure, known: false };
  response = await adminLogin(request('unknown@example.com'), gateway);
  assert.equal((await response.json()).message, 'Invalid email or password.');
  assert.equal(gateway.failureCalls, 2);
});

test('threshold locks and successful password cannot release a locked account', async () => {
  const gateway = new LoginFixture();
  gateway.failure = { known: true, attempts: 3, remaining: 0, locked: true, recoveryProtected: false };
  const failed = await adminLogin(request(), gateway);
  assert.equal(failed.status, 423);
  assert.match((await failed.json()).message, /locked/);
  gateway.password = { kind: 'valid', userId: ID, accessToken: 'session-access', refreshToken: 'session-refresh' };
  gateway.success = { allowed: false, locked: true };
  const valid = await adminLogin(request('admin@example.com', 'correct-password'), gateway);
  assert.equal(valid.status, 423);
  assert.equal(JSON.stringify(await valid.json()).includes('session-access'), false);
});

test('the final recovery Super Admin remains unlocked at the threshold', async () => {
  const gateway = new LoginFixture();
  gateway.failure = { known: true, attempts: 3, remaining: 0, locked: false, recoveryProtected: true };
  const response = await adminLogin(request(), gateway);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).message.includes('locked'), false);
});

test('a verified password releases tokens only after the atomic success gate', async () => {
  const gateway = new LoginFixture();
  gateway.password = { kind: 'valid', userId: ID, accessToken: 'session-access', refreshToken: 'session-refresh' };
  const response = await adminLogin(request('admin@example.com', 'correct-password'), gateway);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).userId, ID);
  assert.equal(gateway.successCalls, 1);
  assert.equal(gateway.failureCalls, 0);
});

test('network/auth failures never increment the password failure counter', async () => {
  const gateway = new LoginFixture();
  gateway.throwVerification = true;
  const response = await adminLogin(request(), gateway);
  assert.equal(response.status, 503);
  assert.equal(gateway.failureCalls, 0);
});

test('unknown or invalid requests never expose a session', async () => {
  const gateway = new LoginFixture();
  assert.equal((await adminLogin(request('user@'), gateway)).status, 400);
  assert.equal((await adminLogin(request('admin@example.com', '', 'GET'), gateway)).status, 405);
  assert.equal(gateway.failureCalls, 0);
});
