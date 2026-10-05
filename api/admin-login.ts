import { adminLogin } from '../server/admin-login.js';
import { SupabaseLoginGateway } from '../server/supabase-login.js';
import { json } from '../server/responses.js';

export default { fetch: async (request: Request) => {
  try { return await adminLogin(request, new SupabaseLoginGateway()); }
  catch { return json(503, { success: false, message: 'Sign-in service is temporarily unavailable. Please try again.' }); }
} };
