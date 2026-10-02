import type { AdminGateway } from './types.js';
import type { QrMail } from './mail.js';
import { buildQrMail, sendQrMail } from './mail.js';
import { requireActiveAdminAal2 } from './admin-auth.js';
import { bodyObject, json, trimmed, uuidPattern } from './responses.js';
import { methodOnly } from './http.js';

export async function sendStudentQrEmail(
  request: Request, gateway: AdminGateway, sender: (mail: QrMail) => Promise<void> = sendQrMail
): Promise<Response> {
  const method = methodOnly(request);
  if (method) return method;
  const authorization = await requireActiveAdminAal2(request, gateway);
  if ('response' in authorization) return authorization.response;
  const body = await bodyObject(request);
  if (!body) return json(400, { success: false, message: 'Invalid JSON body.' });
  const payload = trimmed(body.qrPayload).toLowerCase();
  const id = trimmed(body.studentUuid).toLowerCase() || (payload.startsWith('student_uuid:') ? payload.slice(13) : '');
  if (!uuidPattern.test(id) || (payload && payload !== `student_uuid:${id}`)) {
    return json(422, { success: false, message: 'A valid student UUID QR payload is required.' });
  }
  let student;
  try { student = await gateway.getStudent(id); }
  catch { return json(502, { success: false, message: 'Could not verify the student record.' }); }
  if (!student || student.student_id.toLowerCase() !== id) return json(404, { success: false, message: 'Student not found.' });
  if (!student.stud_id) return json(422, { success: false, message: 'Student ID is required.' });
  if (!student.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) {
    return json(422, { success: false, message: 'A valid student email is required.' });
  }
  // The browser cannot turn this endpoint into an arbitrary SMTP relay.
  if (body.email && trimmed(body.email).toLowerCase() !== student.email.toLowerCase()) {
    return json(409, { success: false, message: 'Student email changed. Refresh the student record before sending.' });
  }
  try {
    const mail = await buildQrMail(student);
    await sender(mail);
  } catch {
    return json(500, { success: false, message: 'Failed to send email. Check SMTP configuration.' });
  }
  return json(200, { success: true, message: 'Student QR email sent successfully with PNG attachment.' });
}
