import { invoke } from '../server/http.js';
import { updateAdminPassword } from '../server/update-admin-password.js';
export default { fetch: (request: Request) => invoke(request, updateAdminPassword) };
