import type { AdminGateway } from './types.js';
import type { QrMail } from './mail.js';
import { buildEmployeeQrMail, buildQrMail, sendQrMail } from './mail.js';
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
  const employeeId = trimmed(body.employeeUuid).toLowerCase();
  const payload = trimmed(body.qrPayload).toLowerCase();
  const studentId = trimmed(body.studentUuid).toLowerCase() ||
    (payload.startsWith('student_uuid:') ? payload.slice('student_uuid:'.length) : '');
  if (employeeId && studentId) return json(422, { success: false, message: 'Provide only one QR recipient.' });
  if (!uuidPattern.test(employeeId || studentId)) {
    return json(422, { success: false, message: employeeId ? 'A valid employee UUID is required.' : 'A valid student UUID QR payload is required.' });
  }
  let student;
  let employee;
  try {
    if (employeeId) employee = await gateway.getEmployee(employeeId);
    else student = await gateway.getStudent(studentId);
  } catch { return json(502, { success: false, message: 'Could not verify the recipient record.' }); }
  if (employeeId) {
    if (!employee || employee.employee_id.toLowerCase() !== employeeId) return json(404, { success: false, message: 'Employee not found.' });
    if (!employee.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) return json(422, { success: false, message: 'A valid employee email is required.' });
  } else {
    if (payload && payload !== `student_uuid:${studentId}`) return json(422, { success: false, message: 'A valid student UUID QR payload is required.' });
    if (!student || student.student_id.toLowerCase() !== studentId) return json(404, { success: false, message: 'Student not found.' });
    if (!student.stud_id) return json(422, { success: false, message: 'Student ID is required.' });
    if (!student.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) return json(422, { success: false, message: 'A valid student email is required.' });
  }
  const storedEmail = employee?.email || student?.email || '';
  if (body.email && trimmed(body.email).toLowerCase() !== storedEmail.toLowerCase()) {
    return json(409, { success: false, message: `${employeeId ? 'Employee' : 'Student'} email changed. Refresh the record before sending.` });
  }
  try {
    const mail = employee ? await buildEmployeeQrMail(employee) : await buildQrMail(student!);
    await sender(mail);
  } catch {
    return json(500, { success: false, message: 'Failed to send email. Check SMTP configuration.' });
  }
  return json(200, { success: true, message: `${employeeId ? 'Employee' : 'Student'} QR email sent successfully with PNG attachment.` });
}
