import { invoke } from '../server/http.js';
import { sendStudentQrEmail } from '../server/send-student-qr-email.js';
export default { fetch: (request: Request) => invoke(request, sendStudentQrEmail) };
