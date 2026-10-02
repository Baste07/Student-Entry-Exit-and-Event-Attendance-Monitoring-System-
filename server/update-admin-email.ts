import { createHash } from 'node:crypto';
import type { AdminGateway, AuthAccount } from './types.js';
import { BackendError } from './types.js';
import { requireActiveSuperAdminAal2, verifiedTotp } from './admin-auth.js';
import { bodyObject, json, trimmed, uuidPattern } from './responses.js';
import { methodOnly } from './http.js';

function reply(status: number, text: string, success = false, changed = false): Response {
  return json(status, { success, changed, message: text });
}
function hash(value: string): string { return createHash('sha256').update(value.toLowerCase()).digest('hex'); }

function usable(user: AuthAccount): boolean {
  const until = user.banned_until ? Date.parse(user.banned_until) : NaN;
  return Boolean(user.email_confirmed_at && !user.deleted_at && (!Number.isFinite(until) || until <= Date.now()));
}

async function recoverySuperExists(gateway: AdminGateway, targetId: string): Promise<boolean> {
  const profiles = await gateway.listProfiles();
  for (const profile of profiles) {
    if (profile.admin_level !== 'super_admin' || profile.status !== 'active' || profile.admin_id === targetId) continue;
    if (!await verifiedTotp(gateway, profile.admin_id)) continue;
    const user = await gateway.getAuthUser(profile.admin_id);
    if (!user || user.id !== profile.admin_id) throw new BackendError(502);
    if (usable(user)) return true;
  }
  return false;
}

async function emailTaken(gateway: AdminGateway, email: string, targetId: string): Promise<boolean> {
  const profiles = await gateway.listProfiles();
  if (profiles.some(p => p.admin_id !== targetId && p.email?.toLowerCase() === email)) return true;
  const users = await gateway.listAuthUsers();
  return users.some(user => user.id !== targetId &&
    [user.email, user.email_change, user.new_email].some(value => value?.toLowerCase() === email));
}

/** Feature switch and project guard mirror update-admin-email.php. */
export function emailChangeEnabled(): boolean {
  const ref = process.env.ADMIN_EMAIL_CHANGE_PROJECT_REF?.trim().toLowerCase();
  const url = process.env.SUPABASE_URL?.trim();
  if (process.env.ADMIN_EMAIL_CHANGE_ENABLED !== '1' || !ref || !url) return false;
  try { return new URL(url).hostname.toLowerCase() === `${ref}.supabase.co`; }
  catch { return false; }
}

export async function updateAdminEmail(request: Request, gateway: AdminGateway): Promise<Response> {
  if (!emailChangeEnabled()) return json(503, { success: false, message: 'Administrator email change is not enabled for this project.' });
  const method = methodOnly(request);
  if (method) return method;
  const body = await bodyObject(request, 4096);
  const id = trimmed(body?.adminId).toLowerCase();
  const email = trimmed(body?.email).toLowerCase();
  if (!uuidPattern.test(id) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || body?.confirmEmail !== true) {
    return reply(400, 'Provide a valid administrator ID and email, and confirm that you verified the address.');
  }
  const authorization = await requireActiveSuperAdminAal2(request, gateway);
  if ('response' in authorization) return authorization.response;
  const actorId = authorization.actor.admin_id.toLowerCase();
  try {
    if (!await verifiedTotp(gateway, actorId)) return reply(403, 'A verified authenticator is required for this administrator action.');
  } catch { return reply(502, 'A verified authenticator is required for this administrator action.'); }

  let profile;
  try { profile = await gateway.getProfile(id); }
  catch { return reply(502, 'Could not verify the administrator profile.'); }
  if (!profile) return reply(404, 'Administrator profile not found.');
  const oldProfileEmail = profile.email || '';
  if (id === actorId && profile.admin_level === 'super_admin' && profile.status === 'active') {
    try {
      if (!await recoverySuperExists(gateway, id)) {
        return reply(409, 'Another active Super Admin with a verified authenticator is required before changing your own email.');
      }
    } catch { return reply(502, 'Another active Super Admin with a verified authenticator is required before changing your own email.'); }
  }
  let authUser;
  try { authUser = await gateway.getAuthUser(id); }
  catch { return reply(409, 'The matching Auth account could not be verified.'); }
  if (!authUser || authUser.id.toLowerCase() !== id) return reply(409, 'The matching Auth account could not be verified.');
  const oldAuthEmail = authUser.email || '';
  if (!oldAuthEmail || !oldProfileEmail) return reply(409, 'The current account email is missing. Resolve this account manually.');
  if (oldAuthEmail.toLowerCase() === email && oldProfileEmail.toLowerCase() === email) {
    return reply(200, 'This administrator already uses that email.', true);
  }
  try { if (await emailTaken(gateway, email, id)) return reply(409, 'That email is already used by another account.'); }
  catch { return reply(502, 'Could not complete the duplicate-email check. No changes were made.'); }

  let profileChanged = false;
  try { profileChanged = await gateway.updateProfileEmail(id, email); }
  catch { /* A failed read/write may have committed; report uncertain state. */ }
  if (!profileChanged) return reply(502, 'The admin profile update could not be verified. Check both records before retrying.', false, true);
  let authFailedStatus = 0;
  try { await gateway.updateAuthEmail(id, email); }
  catch (error) { authFailedStatus = error instanceof BackendError ? error.status : 502; }
  let verified: AuthAccount | null;
  try { verified = await gateway.getAuthUser(id); }
  catch { return reply(502, 'Auth result could not be verified. The email may have changed; inspect both records before retrying.', false, true); }
  const verifiedEmail = verified?.email?.toLowerCase();
  if (!verified || verified.id.toLowerCase() !== id ||
    (verifiedEmail !== email && verifiedEmail !== oldAuthEmail.toLowerCase())) {
    return reply(502, 'Auth result could not be verified. The email may have changed; inspect both records before retrying.', false, true);
  }
  if (verifiedEmail !== email) {
    try {
      if (!await gateway.updateProfileEmail(id, oldProfileEmail)) {
        return reply(502, 'Auth rejected the email, and profile recovery failed. Inspect both records before retrying.', false, true);
      }
    } catch { return reply(502, 'Auth rejected the email, and profile recovery failed. Inspect both records before retrying.', false, true); }
    return reply(authFailedStatus === 422 ? 409 : 502,
      'Auth did not accept the new email. The profile was restored; check whether the address is already registered.');
  }
  if (!verified.email_confirmed_at) return reply(502, 'Auth email changed but confirmation could not be verified. Inspect the account before retrying.', false, true);
  try {
    await gateway.insertAudit({ user_id: actorId, action: 'ADMIN_EMAIL_CHANGED', module_name: 'admin',
      page_name: 'usermanagement.html', target_table: 'admins', target_id: id,
      details: { old_auth_email_sha256: hash(oldAuthEmail), old_profile_email_sha256: hash(oldProfileEmail),
        new_email_sha256: hash(email), administratively_confirmed: true } });
  } catch { return reply(502, 'Both emails changed, but the audit record failed. Contact the system administrator.', false, true); }
  return reply(200, 'Administrator email updated. Ask the account owner to sign out and sign in with the new address.', true, true);
}
