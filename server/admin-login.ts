import { bodyObject, json } from './responses.js';
import { methodOnly } from './http.js';

export type PasswordVerification =
  | { kind: 'valid'; userId: string; accessToken: string; refreshToken: string }
  | { kind: 'invalid' };

export interface AdminLoginGateway {
  verifyPassword(email: string, password: string): Promise<PasswordVerification>;
  recordFailure(email: string): Promise<{ known: boolean; attempts: number; remaining: number; locked: boolean; recoveryProtected: boolean }>;
  recordSuccess(userId: string): Promise<{ allowed: boolean; locked: boolean }>;
}

/** Passwords are checked only by Supabase Auth. The database records results atomically. */
export async function adminLogin(request: Request, gateway: AdminLoginGateway): Promise<Response> {
  const method = methodOnly(request);
  if (method) return method;
  const body = await bodyObject(request, 4096);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body?.password;
  if (email.length > 254 || !/^[^\s@.][^\s@]*@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) ||
      typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    return json(400, { success: false, message: 'Enter a valid email and password.' });
  }

  let verified: PasswordVerification;
  try { verified = await gateway.verifyPassword(email, password); }
  catch { return json(503, { success: false, message: 'Sign-in service is temporarily unavailable. Please try again.' }); }

  if (verified.kind === 'invalid') {
    let state: Awaited<ReturnType<AdminLoginGateway['recordFailure']>>;
    try { state = await gateway.recordFailure(email); }
    catch { return json(503, { success: false, message: 'Sign-in service is temporarily unavailable. Please try again.' }); }
    if (!state.known) return json(401, { success: false, message: 'Invalid email or password.' });
    if (state.locked) return json(423, { success: false,
      message: 'This account has been locked after failed login attempts. Contact a Super Admin.' });
    if (state.recoveryProtected) return json(401, { success: false,
      message: 'Invalid email or password. Contact another authorized administrator if you need help.' });
    return json(401, { success: false,
      message: `Invalid email or password. ${state.remaining} ${state.remaining === 1 ? 'attempt' : 'attempts'} remaining.` });
  }

  let state: Awaited<ReturnType<AdminLoginGateway['recordSuccess']>>;
  try { state = await gateway.recordSuccess(verified.userId); }
  catch { return json(503, { success: false, message: 'Sign-in service is temporarily unavailable. Please try again.' }); }
  if (!state.allowed) return json(state.locked ? 423 : 403, { success: false,
    message: state.locked ? 'This account is locked. Contact a Super Admin to unlock it.'
      : 'This administrator account is not active.' });

  return json(200, { success: true, userId: verified.userId,
    access_token: verified.accessToken, refresh_token: verified.refreshToken });
}
