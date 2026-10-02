import { invoke } from '../server/http.js';
import { createAdmin } from '../server/create-admin.js';
export default { fetch: (request: Request) => invoke(request, createAdmin) };
