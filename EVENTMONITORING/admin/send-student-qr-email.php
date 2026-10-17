<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/admin-mfa-auth.php';
enforceAdminAal2Http(['POST']);

// Shared include-only SMTP helper; keep it on the server and outside direct HTTP access.
require_once __DIR__ . '/../TimeInAndTimeOutMonitoring/students/mail_config.php';

use PHPMailer\PHPMailer\Exception as PHPMailerException;

function jsonExit(int $statusCode, array $payload): void {
    http_response_code($statusCode);
    echo json_encode($payload);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonExit(405, [
        'success' => false,
        'message' => 'Method not allowed. Use POST.'
    ]);
}

$rawBody = file_get_contents('php://input');
$data = json_decode($rawBody, true);

if (!is_array($data)) {
    jsonExit(400, [
        'success' => false,
        'message' => 'Invalid JSON body.'
    ]);
}

$clean = static function ($value): string {
    return trim((string)($value ?? ''));
};

// ── READ FIELDS ──
$email = $clean($data['email'] ?? '');
$studentId = $clean($data['studentId'] ?? $data['studId'] ?? $data['stud_id'] ?? '');
$firstName = $clean($data['firstName'] ?? '');
$middleName = $clean($data['middleName'] ?? '');
$lastName = $clean($data['lastName'] ?? '');

$sectionLabel = $clean($data['sectionLabel'] ?? $data['section'] ?? '');
$birthDate = $clean($data['birthDate'] ?? '');
$gender = $clean($data['gender'] ?? '');

$qrPayload = $clean($data['qrPayload'] ?? '');
$employeeUuid = strtolower($clean($data['employeeUuid'] ?? ''));
$uuidPattern = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';

if ($employeeUuid !== '') {
    if (!preg_match($uuidPattern, $employeeUuid)) {
        jsonExit(422, ['success' => false, 'message' => 'A valid employee UUID is required.']);
    }
    try {
        $config = loadServerSupabaseConfig();
        $employeeResponse = serverSupabaseRequest($config, 'GET',
            '/rest/v1/employees?employee_id=eq.' . rawurlencode($employeeUuid)
            . '&select=employee_id,emp_no,first_name,middle_name,last_name,email,faculty&limit=1',
            null, adminBearerHeader());
    } catch (Throwable $error) {
        jsonExit(502, ['success' => false, 'message' => 'Could not verify the employee record.']);
    }
    $employee = is_array($employeeResponse['data'] ?? null) ? ($employeeResponse['data'][0] ?? null) : null;
    if (!is_array($employee)) jsonExit(404, ['success' => false, 'message' => 'Employee not found.']);
    $email = $clean($employee['email'] ?? '');
    $firstName = $clean($employee['first_name'] ?? '');
    $middleName = $clean($employee['middle_name'] ?? '');
    $lastName = $clean($employee['last_name'] ?? '');
    $studentId = $clean($employee['emp_no'] ?? '');
    $sectionLabel = $clean($employee['faculty'] ?? '');
    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        jsonExit(422, ['success' => false, 'message' => 'A valid employee email is required.']);
    }
    $qrPayload = 'employee_uuid:' . strtolower($employeeUuid);
}

if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonExit(422, [
        'success' => false,
        'message' => 'A valid student email is required.'
    ]);
}

if ($studentId === '') {
    jsonExit(422, [
        'success' => false,
        'message' => 'Student ID is required.'
    ]);
}

$fullName = trim(preg_replace('/\s+/', ' ', implode(' ', array_filter([$firstName, $middleName, $lastName]))));

// Build display values
$displaySection = $sectionLabel !== '' ? $sectionLabel : 'N/A';
$displayBirthDate = $birthDate !== '' ? $birthDate : 'N/A';
$displayGender = $gender !== '' ? $gender : 'N/A';

$qrImageSize = '512x512';
$qrHtmlSize = '320px';

if ($qrPayload === '') {
    $qrPayload = "Attendance Monitoring System - Manual Attendance QR\n"
        . "Name: " . ($fullName !== '' ? $fullName : 'N/A') . "\n"
        . "Student ID: {$studentId}\n"
        . "Birth Date: {$displayBirthDate}\n"
        . "Gender: {$displayGender}\n"
        . "Section: {$displaySection}";
}

$qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=' . rawurlencode($qrImageSize) . '&margin=0&format=png&data=' . rawurlencode($qrPayload);
$qrImageData = @file_get_contents($qrImageUrl);
$hasQrAttachment = is_string($qrImageData) && strlen($qrImageData) > 0;
$qrImageBase64 = $hasQrAttachment ? base64_encode($qrImageData) : '';
$safeStudentId = preg_replace('/[^a-zA-Z0-9\-_]/', '-', $studentId);
$qrFileName = 'qr-' . $safeStudentId . '.png';

$esc = static function (string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
};

$isEmployee = $employeeUuid !== '';
$subject = $isEmployee ? 'Your Employee Entry/Exit QR Code' : 'Your Manual Attendance QR Code';
$emailBody = '
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5;">
    <h2 style="margin:0 0 12px;">' . ($isEmployee ? 'Employee Entry/Exit QR Code' : 'Manual Attendance QR Code') . '</h2>
    <p style="margin:0 0 14px;">Hello ' . $esc($fullName !== '' ? $fullName : ($isEmployee ? 'Employee' : 'Student')) . ',</p>
    <p style="margin:0 0 14px;">Your QR code has been generated. Please keep this QR code and present it at the gate.</p>

    <p style="margin:0 0 14px;">Your QR code is attached as <strong>' . $esc($qrFileName) . '</strong>. On mobile, tap the attachment to preview or download it.</p>

    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;">
        <tr><td><strong>Name</strong></td><td>' . $esc($fullName !== '' ? $fullName : 'N/A') . '</td></tr>
        <tr><td><strong>' . ($isEmployee ? 'Employee Number' : 'Student ID') . '</strong></td><td>' . $esc($studentId) . '</td></tr>
        <tr><td><strong>' . ($isEmployee ? 'Faculty' : 'Section') . '</strong></td><td>' . $esc($displaySection) . '</td></tr>
        ' . ($isEmployee ? '' : '<tr><td><strong>Birth Date</strong></td><td>' . $esc($displayBirthDate) . '</td></tr><tr><td><strong>Gender</strong></td><td>' . $esc($displayGender) . '</td></tr>') . '
    </table>

    <p style="margin:0;">Generated by the Attendance Monitoring System.</p>
</body>
</html>';

// ── PLAIN TEXT VERSION ──
$textBody = ($isEmployee ? "Employee Entry/Exit QR Code" : "Manual Attendance QR Code") . "\r\n\r\n"
    . "Hello " . ($fullName !== '' ? $fullName : ($isEmployee ? 'Employee' : 'Student')) . ",\r\n\r\n"
    . "Your QR code has been generated.\r\n"
    . ($isEmployee ? "Employee Number: {$studentId}\r\nFaculty: {$displaySection}\r\n" : "Student ID: {$studentId}\r\nSection: {$displaySection}\r\nBirth Date: {$displayBirthDate}\r\nGender: {$displayGender}\r\n")
    . "\r\n"
    . "Attachment: qr-{$safeStudentId}.html\r\n"
    . "Generated by the Attendance Monitoring System.\r\n";

// ── HTML ATTACHMENT (same "scan-friendly" QR wrapper as before) ──
$htmlAttachmentContent = '';
$htmlFileName = 'qr-' . $safeStudentId . '.html';
if ($hasQrAttachment) {
    $htmlAttachmentContent = '<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QR Code - ' . $esc($studentId) . '</title>
<style>
    body { margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #fff; font-family: Arial, sans-serif; }
    img  { width: ' . $qrHtmlSize . '; height: ' . $qrHtmlSize . '; display: block; image-rendering: pixelated; }
    p    { margin: 10px 0 4px; font-size: 13px; color: #374151; text-align: center; }
    .id  { font-size: 15px; font-weight: bold; color: #111; }
</style>
</head>
<body>
    <img src="data:image/png;base64,' . $qrImageBase64 . '" alt="QR Code">
    <p class="id">' . $esc($studentId) . '</p>
    <p>' . $esc($fullName) . '</p>
    <p>' . $esc($displaySection) . '</p>
</body>
</html>';
}

// ── SEND EMAIL VIA AUTHENTICATED GMAIL SMTP (PHPMailer) ──
try {
    $mail = make_smtp_mailer();
    $mail->addAddress($email, $fullName !== '' ? $fullName : 'Student');
    $mail->Subject = $subject;
    $mail->Body    = $emailBody;
    $mail->AltBody = $textBody;

    if ($hasQrAttachment) {
        // Attach the same scan-friendly HTML wrapper as a downloadable file
        $mail->addStringAttachment($htmlAttachmentContent, $htmlFileName, 'base64', 'text/html');
        // Also attach the raw QR PNG directly, since PHPMailer makes this trivial
        $mail->addStringAttachment(base64_decode($qrImageBase64), $qrFileName, 'base64', 'image/png');
    }

    $mail->send();
} catch (PHPMailerException $e) {
    error_log('Student QR email delivery failed.');
    jsonExit(500, [
        'success' => false,
        'message' => 'Failed to send email. Check SMTP configuration.',
    ]);
}

echo json_encode([
    'success' => true,
    'message' => $hasQrAttachment
    ? ($isEmployee ? 'Employee QR email sent successfully with PNG attachment.' : 'Student QR email sent successfully with PNG attachment.')
    : ($isEmployee ? 'Employee QR email sent successfully, but the PNG attachment could not be generated.' : 'Student QR email sent successfully, but the PNG attachment could not be generated.')
]);
