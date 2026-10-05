import { createClient } from '@supabase/supabase-js';
import type { AdminLoginGateway, PasswordVerification } from './admin-login.js';
import { serverClient } from './supabase-admin.js';
import { BackendError } from './types.js';

function resultObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackendError(502);
  return value as Record<string, unknown>;
}

export class SupabaseLoginGateway implements AdminLoginGateway {
  async verifyPassword(email: string, password: string): Promise<PasswordVerification> {
    const url = process.env.SUPABASE_URL?.trim() || '';
    const publicKey = process.env.WEB_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim() || '';
    if (!/^https:\/\/[^/]+\.supabase\.co\/?$/i.test(url) || !publicKey) throw new BackendError(503);
    // A fresh public-key client per request prevents one sign-in from sharing another request's session.
    const auth = createClient(url, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === 'invalid_credentials') return { kind: 'invalid' };
      throw new BackendError(503);
    }
    if (!data.user?.id || !data.session?.access_token || !data.session.refresh_token) throw new BackendError(503);
    return { kind: 'valid', userId: data.user.id,
      accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
  }

  async recordFailure(email: string) {
    const { data, error } = await serverClient().rpc('record_admin_password_failure', { p_email: email });
    if (error) throw new BackendError(503);
    const value = resultObject(data);
    if (typeof value.known !== 'boolean' || typeof value.locked !== 'boolean' ||
        typeof value.recovery_protected !== 'boolean' ||
        !Number.isInteger(value.attempts) || !Number.isInteger(value.remaining)) throw new BackendError(502);
    return { known: value.known, attempts: Number(value.attempts), remaining: Number(value.remaining),
      locked: value.locked, recoveryProtected: value.recovery_protected };
  }

  async recordSuccess(userId: string) {
    const { data, error } = await serverClient().rpc('record_admin_password_success', { p_admin_id: userId });
    if (error) throw new BackendError(503);
    const value = resultObject(data);
    if (typeof value.allowed !== 'boolean' || typeof value.locked !== 'boolean') throw new BackendError(502);
    return { allowed: value.allowed, locked: value.locked };
  }
}
