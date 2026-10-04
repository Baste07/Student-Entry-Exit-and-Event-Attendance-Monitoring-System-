export type AdminLevel = 'admin' | 'super_admin';

export interface AdminProfile {
  admin_id: string;
  email?: string;
  admin_name?: string;
  faculty?: string;
  admin_level: AdminLevel;
  status: string;
  password?: string;
  updated_at?: string;
}

export interface AuthAccount {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  deleted_at?: string | null;
  banned_until?: string | null;
  email_change?: string | null;
  new_email?: string | null;
}

export interface Factor {
  id: string;
  factor_type: string;
  status: string;
}

export interface StudentRecord {
  student_id: string;
  stud_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  birth_date: string | null;
  gender: string | null;
  email: string | null;
  current_grade_level: string | null;
  sections: { section_name: string | null } | null;
}

export interface AuditRecord {
  user_id: string;
  action: string;
  module_name: string;
  page_name: string;
  target_table: string;
  target_id: string;
  details: Record<string, string | number | boolean>;
}

/** Injectable boundary: tests never need a service-role key or real database. */
export interface AdminGateway {
  getUserFromToken(token: string): Promise<AuthAccount | null>;
  getProfile(id: string): Promise<AdminProfile | null>;
  listProfiles(): Promise<AdminProfile[]>;
  findProfileEmail(email: string): Promise<AdminProfile | null>;
  getAuthUser(id: string): Promise<AuthAccount | null>;
  listAuthUsers(): Promise<AuthAccount[]>;
  listFactors(id: string): Promise<Factor[]>;
  deleteFactor(userId: string, factorId: string): Promise<void>;
  createAuthUser(email: string, password: string): Promise<AuthAccount>;
  deleteAuthUser(id: string): Promise<'deleted' | 'missing'>;
  updateAuthEmail(id: string, email: string): Promise<void>;
  insertProfile(profile: AdminProfile): Promise<void>;
  updateProfileEmail(id: string, email: string): Promise<boolean>;
  deleteProfile(id: string): Promise<void>;
  insertAudit(record: AuditRecord): Promise<void>;
  getStudent(id: string): Promise<StudentRecord | null>;
}

export class BackendError extends Error {
  constructor(public readonly status: number, message = 'Account service unavailable') {
    super(message);
  }
}
