<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

// ── ADJUST THIS PATH if mail_config.php lives somewhere else relative to this file ──
require_once __DIR__ . '/mail_config.php';

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

// ── REQUIRED FIELDS ──
$studentId   = $clean($data['studentId'] ?? $data['student_id'] ?? '');
$eventId     = $clean($data['eventId'] ?? $data['event_id'] ?? '');
$type        = strtolower($clean($data['type'] ?? 'time_in')); // "time_in" or "time_out"
$timestamp   = $clean($data['timestamp'] ?? $data['timeIn'] ?? $data['time_in'] ?? $data['timeOut'] ?? $data['time_out'] ?? '');

// Optional overrides
$studentEmail = $clean($data['email'] ?? '');
$studentName  = $clean($data['studentName'] ?? $data['student_name'] ?? '');
$eventName    = $clean($data['eventName'] ?? $data['event_name'] ?? '');
$eventDate    = $clean($data['eventDate'] ?? $data['event_date'] ?? '');
$eventTimeStart = $clean($data['eventTimeStart'] ?? $data['time_start'] ?? '');
$eventTimeEnd   = $clean($data['eventTimeEnd'] ?? $data['time_end'] ?? '');
$eventLocation  = $clean($data['eventLocation'] ?? $data['location'] ?? '');
$eventDescription = $clean($data['eventDescription'] ?? $data['description'] ?? '');
$gradeLevel   = $clean($data['gradeLevel'] ?? $data['grade_level'] ?? '');
$sectionName  = $clean($data['sectionName'] ?? $data['section_name'] ?? '');
$studId       = $clean($data['studId'] ?? $data['stud_id'] ?? '');
$lateMinutes  = (int)($data['lateMinutes'] ?? $data['late_minutes'] ?? 0);

// Optional: time_out specific
$timeInRecorded = $clean($data['timeInRecorded'] ?? $data['time_in_recorded'] ?? '');
$durationMinutes = (int)($data['durationMinutes'] ?? $data['duration_minutes'] ?? 0);

// ── VALIDATION ──
if ($studentId === '') {
    jsonExit(422, ['success' => false, 'message' => 'student_id is required.']);
}
if ($eventId === '') {
    jsonExit(422, ['success' => false, 'message' => 'event_id is required.']);
}
if ($studentEmail === '') {
    jsonExit(422, ['success' => false, 'message' => 'student email is required.']);
}
if (!filter_var($studentEmail, FILTER_VALIDATE_EMAIL)) {
    jsonExit(422, ['success' => false, 'message' => 'A valid student email is required.']);
}

$isTimeOut = ($type === 'time_out');

// ── FORMAT TIMESTAMPS ──
$formattedTimestamp = $timestamp !== ''
    ? date('F j, Y \a\t g:i A', strtotime($timestamp))
    : date('F j, Y \a\t g:i A');

$formattedTimeIn = $timeInRecorded !== ''
    ? date('F j, Y \a\t g:i A', strtotime($timeInRecorded))
    : '';

// ── DISPLAY VALUES ──
$displayEventName = $eventName !== '' ? $eventName : 'School Event';
$displayEventDate = $eventDate !== ''
    ? date('F j, Y', strtotime($eventDate))
    : date('F j, Y');
$displayTimeRange = '';
if ($eventTimeStart !== '' && $eventTimeEnd !== '') {
    $displayTimeRange = date('g:i A', strtotime($eventTimeStart)) . ' – ' . date('g:i A', strtotime($eventTimeEnd));
} elseif ($eventTimeStart !== '') {
    $displayTimeRange = date('g:i A', strtotime($eventTimeStart));
}
$displayLocation = $eventLocation !== '' ? $eventLocation : 'School Grounds';
$displayDescription = $eventDescription !== '' ? $eventDescription : 'Thank you for attending this school event.';

$displayStudentName = $studentName !== '' ? $studentName : 'Student';
$displayStudId = $studId !== '' ? $studId : 'N/A';
$displayGrade = $gradeLevel !== '' ? $gradeLevel : 'N/A';
$displaySection = $sectionName !== '' ? $sectionName : 'N/A';

// ── STATUS BADGES ──
if ($isTimeOut) {
    $statusBadge = '<span style="background:#dbeafe;color:#1e40af;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;">Checked Out</span>';
    $statusText = 'Checked Out';
    $headerEmoji = '👋';
    $headerTitle = 'Attendance Complete';
    $headerSub = 'You have successfully checked out';
    $headerGradient = 'background:linear-gradient(135deg, #1e3a5f 0%, #0b4e78 100%);';
    $actionLabel = 'Time Out Recorded';
    $actionColor = '#1e40af';
    $actionBg = '#eff6ff';
    $actionBorder = '#bfdbfe';
} else {
    $isLate = $lateMinutes > 0;
    $statusBadge = $isLate
        ? '<span style="background:#fef3c7;color:#92400e;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;">Late by ' . $lateMinutes . ' min</span>'
        : '<span style="background:#dcfce7;color:#166534;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;">On Time</span>';
    $statusText = $isLate ? 'Late by ' . $lateMinutes . ' minute(s)' : 'On Time';
    $headerEmoji = '✅';
    $headerTitle = 'Attendance Confirmed';
    $headerSub = 'Your time-in has been recorded successfully';
    $headerGradient = 'background:linear-gradient(135deg, #0b4e78 0%, #14532d 100%);';
    $actionLabel = 'Time In Recorded';
    $actionColor = '#14532d';
    $actionBg = '#f0fdf4';
    $actionBorder = '#bbf7d0';
}

// ── DURATION DISPLAY (for time-out) ──
$durationHtml = '';
if ($isTimeOut && $durationMinutes > 0) {
    $hours = floor($durationMinutes / 60);
    $mins = $durationMinutes % 60;
    $durationStr = $hours > 0 ? "{$hours}h {$mins}m" : "{$mins}m";
    $durationHtml = '
    <tr>
        <td style="padding:6px 0;font-size:13px;color:#6b7280;">Duration:</td>
        <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1e40af;">' . $durationStr . '</td>
    </tr>';
}

// ── TIME-IN REFERENCE (for time-out) ──
$timeInRefHtml = '';
if ($isTimeOut && $formattedTimeIn !== '') {
    $timeInRefHtml = '
    <tr>
        <td style="padding:6px 0;font-size:13px;color:#6b7280;">Time In:</td>
        <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1f2937;">' . $formattedTimeIn . '</td>
    </tr>';
}

// ── EMAIL SUBJECT ──
$subject = $isTimeOut
    ? 'Attendance Complete — ' . $displayEventName
    : 'Attendance Confirmed — ' . $displayEventName;

// ── HTML EMAIL BODY ──
$esc = static function (string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
};

$emailBody = '
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>' . $esc($headerTitle) . '</title>
<style>
    @media only screen and (max-width: 600px) {
        .container { width: 100% !important; padding: 20px !important; }
        .header h1 { font-size: 20px !important; }
        .details-table td { display: block; width: 100% !important; }
    }
</style>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:\'Segoe UI\',Arial,sans-serif;color:#1f2937;line-height:1.6;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
<tr>
<td align="center" style="padding: 40px 20px;">
    <table role="presentation" class="container" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- Header -->
        <tr>
            <td class="header" style="' . $headerGradient . 'padding:32px 36px;text-align:center;">
                <div style="font-size:36px;margin-bottom:8px;">' . $headerEmoji . '</div>
                <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:0.5px;">' . $esc($headerTitle) . '</h1>
                <p style="color:#c8e6c9;margin:6px 0 0;font-size:14px;">' . $esc($headerSub) . '</p>
            </td>
        </tr>

        <!-- Body -->
        <tr>
            <td style="padding:32px 36px;">
                
                <!-- Greeting -->
                <p style="margin:0 0 20px;font-size:15px;">Hello <strong>' . $esc($displayStudentName) . '</strong>,</p>
                <p style="margin:0 0 24px;font-size:14px;color:#4b5563;">'
                    . ($isTimeOut
                        ? 'You have successfully checked out of the following event. Thank you for your participation.'
                        : 'You have been successfully checked in for the following event. Please keep this email for your records.')
                . '</p>

                <!-- Event Card -->
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:24px;">
                    <tr>
                        <td style="padding:24px;">
                            <h2 style="margin:0 0 12px;color:#0b4e78;font-size:18px;font-weight:700;">📅 ' . $esc($displayEventName) . '</h2>
                            <p style="margin:0 0 16px;font-size:13.5px;color:#64748b;line-height:1.5;">' . $esc($displayDescription) . '</p>
                            
                            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td style="padding:6px 0;font-size:13px;color:#6b7280;width:100px;">Date:</td>
                                    <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1f2937;">' . $esc($displayEventDate) . '</td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0;font-size:13px;color:#6b7280;">Time:</td>
                                    <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1f2937;">' . $esc($displayTimeRange) . '</td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0;font-size:13px;color:#6b7280;">Location:</td>
                                    <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1f2937;">' . $esc($displayLocation) . '</td>
                                </tr>
                                ' . $timeInRefHtml . '
                                ' . $durationHtml . '
                            </table>
                        </td>
                    </tr>
                </table>

                <!-- Time Action Badge -->
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:' . $actionBg . ';border-radius:12px;border:1.5px solid ' . $actionBorder . ';margin-bottom:24px;">
                    <tr>
                        <td style="padding:20px 24px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                                <div>
                                    <div style="font-size:12px;color:' . $actionColor . ';font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' . $actionLabel . '</div>
                                    <div style="font-size:20px;font-weight:800;color:' . $actionColor . ';">' . $esc($formattedTimestamp) . '</div>
                                </div>
                                <div style="flex-shrink:0;">
                                    ' . $statusBadge . '
                                </div>
                            </div>
                        </td>
                    </tr>
                </table>

                <!-- Student Details -->
                <h3 style="margin:0 0 12px;font-size:14px;color:#0b4e78;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Your Details</h3>
                <table role="presentation" class="details-table" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">
                    <tr>
                        <td style="padding:8px 0;font-size:13px;color:#6b7280;width:140px;border-bottom:1px solid #f1f5f9;">Student Name</td>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:#1f2937;border-bottom:1px solid #f1f5f9;">' . $esc($displayStudentName) . '</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0;font-size:13px;color:#6b7280;border-bottom:1px solid #f1f5f9;">Student ID</td>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:#1f2937;border-bottom:1px solid #f1f5f9;">' . $esc($displayStudId) . '</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0;font-size:13px;color:#6b7280;border-bottom:1px solid #f1f5f9;">Grade Level</td>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:#1f2937;border-bottom:1px solid #f1f5f9;">' . $esc($displayGrade) . '</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0;font-size:13px;color:#6b7280;">Section</td>
                        <td style="padding:8px 0;font-size:13px;font-weight:600;color:#1f2937;">' . $esc($displaySection) . '</td>
                    </tr>
                </table>

                <!-- Footer Note -->
                <div style="background:#fefce8;border:1px solid #fde047;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
                    <p style="margin:0;font-size:12.5px;color:#854d0e;line-height:1.5;">
                        <strong>💡 Reminder:</strong> Please present this confirmation if asked by event staff. Your attendance was verified via facial recognition.
                    </p>
                </div>

                <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                    Generated by Smart Academic Management System<br>
                    <span style="font-size:11px;">Event ID: ' . $esc($eventId) . ' • Recorded at ' . $esc($formattedTimestamp) . '</span>
                </p>
            </td>
        </tr>

        <!-- Footer Bar -->
        <tr>
            <td style="background:#f8fafc;padding:16px 36px;text-align:center;border-top:1px solid #e2e8f0;">
                <p style="margin:0;font-size:11px;color:#9ca3af;">This is an automated message. Please do not reply to this email.</p>
            </td>
        </tr>
    </table>
</td>
</tr>
</table>
</body>
</html>';

// ── PLAIN TEXT VERSION ──
$textBody = ($isTimeOut ? 'Attendance Complete' : 'Attendance Confirmed') . " — {$displayEventName}\r\n"
    . str_repeat("=", 50) . "\r\n\r\n"
    . "Hello {$displayStudentName},\r\n\r\n"
    . ($isTimeOut
        ? "You have successfully checked out of the event.\r\n\r\n"
        : "Your time-in has been recorded successfully.\r\n\r\n")
    . "EVENT DETAILS\r\n"
    . "  Event:    {$displayEventName}\r\n"
    . "  Date:     {$displayEventDate}\r\n"
    . "  Time:     {$displayTimeRange}\r\n"
    . "  Location: {$displayLocation}\r\n"
    . "  Description: {$displayDescription}\r\n";

if ($isTimeOut && $formattedTimeIn !== '') {
    $textBody .= "  Time In:  {$formattedTimeIn}\r\n";
}
if ($isTimeOut && $durationMinutes > 0) {
    $hours = floor($durationMinutes / 60);
    $mins = $durationMinutes % 60;
    $durationStr = $hours > 0 ? "{$hours}h {$mins}m" : "{$mins}m";
    $textBody .= "  Duration: {$durationStr}\r\n";
}

$textBody .= "\r\n"
    . ($isTimeOut ? "TIME OUT\r\n" : "TIME IN\r\n")
    . "  Recorded: {$formattedTimestamp}\r\n"
    . "  Status:   {$statusText}\r\n\r\n"
    . "YOUR DETAILS\r\n"
    . "  Name:        {$displayStudentName}\r\n"
    . "  Student ID:  {$displayStudId}\r\n"
    . "  Grade:       {$displayGrade}\r\n"
    . "  Section:     {$displaySection}\r\n\r\n"
    . "Reminder: Please present this confirmation if asked by event staff.\r\n"
    . "Your attendance was verified via facial recognition.\r\n\r\n"
    . "Event ID: {$eventId}\r\n"
    . "Generated by Smart Academic Management System\r\n";

// ── SEND EMAIL VIA AUTHENTICATED GMAIL SMTP (PHPMailer) ──
try {
    $mail = make_smtp_mailer();
    $mail->addAddress($studentEmail, $displayStudentName);
    $mail->Subject = $subject;
    $mail->Body    = $emailBody;
    $mail->AltBody = $textBody;

    $mail->send();
} catch (PHPMailerException $e) {
    jsonExit(500, [
        'success' => false,
        'message' => 'Failed to send attendance email.',
        'diagnostic' => $mail->ErrorInfo ?? $e->getMessage(),
    ]);
}

jsonExit(200, [
    'success' => true,
    'message' => 'Attendance ' . ($isTimeOut ? 'completion' : 'confirmation') . ' email sent to ' . $studentEmail,
    'details' => [
        'type' => $type,
        'event_name' => $displayEventName,
        'student_name' => $displayStudentName,
        'timestamp' => $formattedTimestamp,
        'status' => $statusText,
    ]
]);