import type { AdminGateway } from './types.js';
import { SupabaseAdminGateway } from './supabase-admin.js';
import { json } from './responses.js';

/** No diagnostic, token, or upstream response is returned to the browser. */
export async function invoke(request: Request, handler: (request: Request, gateway: AdminGateway) => Promise<Response>): Promise<Response> {
  try { return await handler(request, new SupabaseAdminGateway()); }
  catch { return json(503, { success: false, message: 'The account service is unavailable. Please try again.' }); }
}

export function methodOnly(request: Request): Response | null {
  return request.method === 'POST' ? null : json(405, { success: false, message: 'Method not allowed. Use POST.' });
}
