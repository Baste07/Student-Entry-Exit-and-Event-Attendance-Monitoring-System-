import type { AdminGateway } from './types.js';
import { BackendError } from './types.js';
import { requireActiveAdminPasswordUpdate } from './admin-auth.js';
import { ADMIN_PASSWORD_MESSAGE, validAdminPassword } from './admin-password-policy.js';
import { bodyObject, json } from './responses.js';
import { methodOnly } from './http.js';

/** Only the signed-in Admin can update their own password. Never audit or echo it. */
export async function updateAdminPassword(request: Request, gateway: AdminGateway): Promise<Response> {
  const method = methodOnly(request);
  if (method) return method;
  const body = await bodyObject(request);
  if (!body) return json(400, { success: false, message: 'Invalid password request.' });
  const authorization = await requireActiveAdminPasswordUpdate(request, gateway);
  if ('response' in authorization) return authorization.response;
  const { actor, token } = authorization;
  if (!actor.email || !actor.admin_name) {
    return json(502, { success: false, message: 'Account details are unavailable.' });
  }
  if (!validAdminPassword(body.password, actor.email, actor.admin_name)) {
    return json(400, { success: false, message: ADMIN_PASSWORD_MESSAGE });
  }
  try {
    await gateway.updateOwnPassword(token, body.password as string);
  } catch (error) {
    if (error instanceof BackendError && error.status === 403) {
      return json(403, { success: false, message: 'Authenticator verification is required to change this password.' });
    }
    return json(502, { success: false, message: 'Password update failed. Please try again.' });
  }
  return json(200, { success: true, message: 'Password updated.' });
}
