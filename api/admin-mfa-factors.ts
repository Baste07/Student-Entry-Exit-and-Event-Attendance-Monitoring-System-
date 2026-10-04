import { invoke } from '../server/http.js';
import { adminMfaFactors } from '../server/admin-mfa-factors.js';
export default { fetch: (request: Request) => invoke(request, adminMfaFactors) };
