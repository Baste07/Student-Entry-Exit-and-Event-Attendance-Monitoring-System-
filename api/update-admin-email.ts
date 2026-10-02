import { invoke } from '../server/http.js';
import { updateAdminEmail } from '../server/update-admin-email.js';
export default { fetch: (request: Request) => invoke(request, updateAdminEmail) };
