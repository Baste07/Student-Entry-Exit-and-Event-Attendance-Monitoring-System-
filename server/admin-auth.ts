import type { AdminGateway, AdminProfile } from './types.js';
import { json, uuidPattern } from './responses.js';

export type Authorization = { actor: AdminProfile; token: string } | { response: Response };

/** Auth verifies the token first; only then may its signed AAL claim be read. */
export async function requireActiveAdminAal2(
  request: Request, gateway: AdminGateway, superOnly = false
): Promise<Authorization> {
  const header = request.headers.get('authorization')?.trim() || '';
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header);
  if (!match) return { response: json(401, { success: false, message: 'Please sign in again.' }) };
  const token = match[1];
  const user = await gateway.getUserFromToken(token);
  if (!user || !uuidPattern.test(user.id)) {
    return { response: json(401, { success: false, message: 'Your session has expired.' }) };
  }
  let claims: Record<string, unknown>;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { response: json(403, { success: false, message: 'Authenticator verification is required.' }) };
  }
  if (claims.sub !== user.id || claims.role !== 'authenticated' || claims.aal !== 'aal2') {
    return { response: json(403, { success: false, message: 'Authenticator verification is required.' }) };
  }
  const actor = await gateway.getProfile(user.id.toLowerCase());
  if (!actor || actor.status !== 'active' ||
    (superOnly ? actor.admin_level !== 'super_admin' : !['admin', 'super_admin'].includes(actor.admin_level))) {
    return { response: json(403, { success: false, message: 'This administrator action is not allowed.' }) };
  }
  return { actor, token };
}

export function requireActiveSuperAdminAal2(request: Request, gateway: AdminGateway): Promise<Authorization> {
  return requireActiveAdminAal2(request, gateway, true);
}

export async function verifiedTotp(gateway: AdminGateway, id: string): Promise<boolean> {
  return (await gateway.listFactors(id)).some(factor => factor.factor_type === 'totp' && factor.status === 'verified');
}
