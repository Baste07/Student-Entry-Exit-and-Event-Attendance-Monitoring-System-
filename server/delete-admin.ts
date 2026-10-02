import type { AdminGateway } from './types.js';
import { requireActiveSuperAdminAal2, verifiedTotp } from './admin-auth.js';
import { bodyObject, json, uuidPattern } from './responses.js';
import { methodOnly } from './http.js';

export async function deleteAdmin(request: Request, gateway: AdminGateway): Promise<Response> {
  const method = methodOnly(request);
  if (method) return method;
  const body = await bodyObject(request);
  const id = typeof body?.adminId === 'string' ? body.adminId.toLowerCase() : '';
  if (!uuidPattern.test(id)) return json(400, { success: false, message: 'A valid admin ID is required.' });
  const authorization = await requireActiveSuperAdminAal2(request, gateway);
  if ('response' in authorization) return authorization.response;
  const actorId = authorization.actor.admin_id.toLowerCase();
  if (id === actorId) return json(403, { success: false, message: 'You cannot delete your own account.' });

  let target;
  try { target = await gateway.getProfile(id); }
  catch { return json(502, { success: false, message: 'Could not load the admin account. Please try again.' }); }
  if (!target) return json(404, { success: false, message: 'This admin account no longer exists. Refresh the admin list.' });
  if (target.admin_level === 'super_admin' && target.status === 'active') {
    try {
      if (!await verifiedTotp(gateway, actorId)) {
        return json(409, { success: false, message: 'Another active Super Admin with a verified authenticator is required.' });
      }
    } catch { return json(502, { success: false, message: 'Another active Super Admin with a verified authenticator is required.' }); }
  }
  try { await gateway.deleteProfile(id); }
  catch { return json(409, { success: false, message: 'The admin profile has linked records. Reassign them, then retry deleting this admin.' }); }
  try { await gateway.deleteAuthUser(id); }
  catch {
    try { await gateway.insertProfile({ ...target, status: 'suspended' }); }
    catch { return json(502, { success: false, message: 'The profile was removed but Auth deletion or recovery could not be confirmed. Contact the system administrator.' }); }
    return json(409, { success: false, message: 'Auth deletion failed. The admin profile was restored as suspended; retry after resolving linked records.' });
  }
  try {
    if (await gateway.getProfile(id)) {
      return json(502, { success: false, message: 'Auth deletion succeeded, but the admin profile remains. Refresh before retrying.' });
    }
  } catch { return json(502, { success: false, message: 'Auth deletion succeeded, but profile cleanup could not be confirmed. Refresh before retrying.' }); }
  return json(200, { success: true, message: 'Admin account deleted successfully.' });
}
