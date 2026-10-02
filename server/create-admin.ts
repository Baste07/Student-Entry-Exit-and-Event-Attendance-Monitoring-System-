import type { AdminGateway } from './types.js';
import { BackendError } from './types.js';
import { requireActiveSuperAdminAal2 } from './admin-auth.js';
import { bodyObject, json, trimmed, uuidPattern } from './responses.js';
import { methodOnly } from './http.js';

export async function createAdmin(request: Request, gateway: AdminGateway): Promise<Response> {
  const method = methodOnly(request);
  if (method) return method;
  const body = await bodyObject(request);
  if (!body) return json(400, { success: false, message: 'Invalid account details.' });
  const name = trimmed(body.name);
  const email = trimmed(body.email).toLowerCase();
  const faculty = trimmed(body.faculty);
  const password = body.password;
  const level = body.level;
  if (!name || name.length > 200 || !faculty || faculty.length > 200 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    typeof password !== 'string' || password.length < 8 || password.length > 256 ||
    (level !== 'admin' && level !== 'super_admin')) {
    return json(400, { success: false, message: 'Check the name, email, faculty, password, and admin level.' });
  }
  const authorization = await requireActiveSuperAdminAal2(request, gateway);
  if ('response' in authorization) return authorization.response;

  try {
    if (await gateway.findProfileEmail(email)) {
      return json(409, { success: false, message: 'An administrator with that email already exists.' });
    }
  } catch { return json(502, { success: false, message: 'Could not check for an existing account.' }); }
  let id: string;
  try {
    const user = await gateway.createAuthUser(email, password);
    if (!uuidPattern.test(user.id)) throw new BackendError(502);
    id = user.id.toLowerCase();
  } catch {
    return json(409, { success: false, message: 'The sign-in account could not be created. Check whether the email is already registered.' });
  }
  try {
    await gateway.insertProfile({
      admin_id: id, email, admin_name: name, faculty, password: 'AUTH_MANAGED',
      admin_level: level, status: 'active'
    });
  } catch {
    try { await gateway.deleteAuthUser(id); }
    catch { return json(502, { success: false, message: 'Account setup failed and cleanup could not be confirmed. Contact the system administrator.' }); }
    return json(502, { success: false, message: 'The admin profile could not be created. Please try again.' });
  }
  return json(201, { success: true, message: 'Administrator created. Google Authenticator setup will be required at first login.' });
}
