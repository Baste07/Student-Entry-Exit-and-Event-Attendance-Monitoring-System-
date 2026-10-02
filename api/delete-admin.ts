import { invoke } from '../server/http.js';
import { deleteAdmin } from '../server/delete-admin.js';
export default { fetch: (request: Request) => invoke(request, deleteAdmin) };
