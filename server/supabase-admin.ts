import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AdminGateway, AdminProfile, AuditRecord, AuthAccount, Factor, StudentRecord } from './types.js';
import { BackendError } from './types.js';

export function serverClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim() || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  if (!/^https:\/\/[^/]+\.supabase\.co\/?$/i.test(url) || !key) throw new BackendError(503);
  if (!key.startsWith('sb_secret_')) {
    try {
      const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')) as { role?: string };
      if (claims.role !== 'service_role') throw new BackendError(503);
    } catch { throw new BackendError(503); }
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function failed(error: { status?: number; code?: string } | null): never {
  throw new BackendError(error?.status || 502);
}

export class SupabaseAdminGateway implements AdminGateway {
  private readonly client: SupabaseClient;
  constructor(client?: SupabaseClient) { this.client = client ?? serverClient(); }

  async getUserFromToken(token: string): Promise<AuthAccount | null> {
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user as AuthAccount;
  }
  async getProfile(id: string): Promise<AdminProfile | null> {
    const { data, error } = await this.client.from('admins').select('*').eq('admin_id', id).maybeSingle();
    if (error) failed(error);
    return data as AdminProfile | null;
  }
  async listProfiles(): Promise<AdminProfile[]> {
    const profiles: AdminProfile[] = [];
    for (let start = 0; start < 100000; start += 200) {
      const { data, error } = await this.client.from('admins').select('*').order('admin_id').range(start, start + 199);
      if (error || !data) failed(error);
      profiles.push(...data as AdminProfile[]);
      if (data.length < 200) return profiles;
    }
    throw new BackendError(502);
  }
  async findProfileEmail(email: string): Promise<AdminProfile | null> {
    const { data, error } = await this.client.from('admins').select('*').ilike('email', email).limit(1).maybeSingle();
    if (error) failed(error);
    return data as AdminProfile | null;
  }
  async getAuthUser(id: string): Promise<AuthAccount | null> {
    const { data, error } = await this.client.auth.admin.getUserById(id);
    if (error) {
      if (error.status === 404) return null;
      failed(error);
    }
    return data.user as AuthAccount;
  }
  async listAuthUsers(): Promise<AuthAccount[]> {
    const users: AuthAccount[] = [];
    for (let page = 1; page <= 500; page++) {
      const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: 50 });
      if (error || !data) failed(error);
      users.push(...data.users as AuthAccount[]);
      if (data.users.length < 50) return users;
    }
    throw new BackendError(502);
  }
  async listFactors(id: string): Promise<Factor[]> {
    const { data, error } = await this.client.auth.admin.mfa.listFactors({ userId: id });
    if (error || !data) failed(error);
    return data.factors as Factor[];
  }
  async deleteFactor(userId: string, factorId: string): Promise<void> {
    const { error } = await this.client.auth.admin.mfa.deleteFactor({ userId, id: factorId });
    if (error) failed(error);
  }
  async createAuthUser(email: string, password: string): Promise<AuthAccount> {
    const { data, error } = await this.client.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) failed(error);
    return data.user as AuthAccount;
  }
  async updateOwnPassword(token: string, password: string): Promise<void> {
    const url = process.env.SUPABASE_URL?.trim() || '';
    const key = process.env.WEB_SUPABASE_ANON_KEY?.trim() || '';
    if (!/^https:\/\/[^/]+\.supabase\.co\/?$/i.test(url) || !key) throw new BackendError(503);
    let publicKey = key.startsWith('sb_publishable_');
    if (!publicKey && key.split('.').length === 3) {
      try { publicKey = (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')) as { role?: string }).role === 'anon'; }
      catch { publicKey = false; }
    }
    if (!publicKey) throw new BackendError(503);
    // A public API key plus the caller's bearer preserves Supabase's own
    // recovery, reauthentication, and MFA checks. The secret key is not used.
    const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'apikey': key, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) throw new BackendError(response.status === 401 || response.status === 403 ? 403 : 502);
  }
  async deleteAuthUser(id: string): Promise<'deleted' | 'missing'> {
    const { error } = await this.client.auth.admin.deleteUser(id, false);
    if (error) {
      if (error.status === 404 && error.code === 'user_not_found') return 'missing';
      failed(error);
    }
    return 'deleted';
  }
  async updateAuthEmail(id: string, email: string): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(id, { email, email_confirm: true });
    if (error) failed(error);
  }
  async insertProfile(profile: AdminProfile): Promise<void> {
    const { error } = await this.client.from('admins').insert(profile);
    if (error) failed(error);
  }
  async updateProfileEmail(id: string, email: string): Promise<boolean> {
    const { error } = await this.client.from('admins').update({ email, updated_at: new Date().toISOString() }).eq('admin_id', id);
    if (error) return false;
    const profile = await this.getProfile(id);
    return profile?.email?.toLowerCase() === email.toLowerCase();
  }
  async deleteProfile(id: string): Promise<void> {
    const { error } = await this.client.from('admins').delete().eq('admin_id', id);
    if (error) failed(error);
  }
  async insertAudit(record: AuditRecord): Promise<void> {
    const { error } = await this.client.from('system_audit_logs').insert(record);
    if (error) failed(error);
  }
  async getStudent(id: string): Promise<StudentRecord | null> {
    const { data, error } = await this.client.from('students')
      .select('student_id,stud_id,first_name,middle_name,last_name,birth_date,gender,email,current_grade_level,sections:section_id(section_name)')
      .eq('student_id', id).maybeSingle();
    if (error) failed(error);
    if (!data) return null;
    const section = Array.isArray(data.sections) ? data.sections[0] : data.sections;
    return { ...data, sections: section ?? null } as StudentRecord;
  }
}
