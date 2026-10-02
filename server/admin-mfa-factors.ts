import type { AdminGateway } from './types.js';
import { requireActiveSuperAdminAal2, verifiedTotp } from './admin-auth.js';
import { bodyObject, json, uuidPattern } from './responses.js';

export async function adminMfaFactors(request: Request, gateway: AdminGateway): Promise<Response> {
  if (request.method !== 'POST') return json(405, { message: 'Use POST.' });
  const body = await bodyObject(request, 4096);
  const action = body?.action;
  const id = typeof body?.adminId === 'string' ? body.adminId.toLowerCase() : '';
  if ((action !== 'status' && action !== 'reset') || !uuidPattern.test(id)) {
    return json(400, { message: 'A valid action and administrator ID are required.' });
  }
  const authorization = await requireActiveSuperAdminAal2(request, gateway);
  if ('response' in authorization) {
    const body = await authorization.response.json() as { message?: string };
    return json(authorization.response.status, { message: body.message || 'Administrator authorization failed.' });
  }
  const actorId = authorization.actor.admin_id.toLowerCase();
  if (action === 'reset' && actorId === id) {
    return json(403, { message: 'You cannot reset your own authenticator. Contact another Super Admin.' });
  }
  let target;
  try { target = await gateway.getProfile(id); }
  catch { return json(502, { message: 'Could not verify the target account.' }); }
  if (!target) return json(404, { message: 'Administrator not found.' });
  if (action === 'reset' && target.admin_level === 'super_admin' && target.status === 'active') {
    try {
      if (!await verifiedTotp(gateway, actorId)) {
        return json(409, { message: 'Another active Super Admin with a verified authenticator is required.' });
      }
    } catch { return json(502, { message: 'Another active Super Admin with a verified authenticator is required.' }); }
  }
  let verified;
  try {
    verified = (await gateway.listFactors(id)).filter(f => f.factor_type === 'totp' && f.status === 'verified' && uuidPattern.test(f.id));
  } catch { return json(502, { message: 'Could not retrieve authenticator status.' }); }
  if (action === 'status') return json(200, { enabled: verified.length > 0 });
  for (const factor of verified) {
    try { await gateway.deleteFactor(id, factor.id); }
    catch { return json(502, { message: 'Authenticator reset could not be completed. Check the account before retrying.' }); }
  }
  try {
    await gateway.insertAudit({ user_id: actorId, action: 'MFA_RESET', module_name: 'admin',
      page_name: 'usermanagement.html', target_table: 'admins', target_id: id,
      details: { method: 'totp', removed_factor_count: verified.length } });
  } catch { return json(502, { message: 'Authenticator reset finished, but its audit record failed. Contact the system administrator.' }); }
  return json(200, { success: true, message: verified.length
    ? 'Authenticator reset. This administrator must set it up at next login.'
    : 'No verified authenticator was enrolled.' });
}
