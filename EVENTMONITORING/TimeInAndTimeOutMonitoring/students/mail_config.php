<?php
declare(strict_types=1);

if (isset($_SERVER['SCRIPT_FILENAME']) && realpath((string) $_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    http_response_code(404);
    exit;
}

/**
 * Shared Gmail SMTP settings + a helper to get a ready-to-send PHPMailer instance.
 *
 * SETUP (one-time):
 * 1. Go to https://myaccount.google.com/apppasswords
 *    (requires 2-Step Verification to be turned on for the Gmail account)
 * 2. Create an App Password named e.g. "SAMS Server" -> Google gives you a 16-char code
 * 3. Set GMAIL_APP_PASSWORD in the server environment or the ignored local
 *    students/.env file. Never hardcode or commit the App Password.
 * 4. Set GMAIL_ADDRESS below to the sending account address.
 *
 * Place this file, and the /PHPMailer folder next to it, somewhere both
 * send_event_attendance_email.php and send_student_qr_email.php (or any
 * other mail-sending script) can reach via require_once.
 */

// The address is public configuration; the App Password is loaded at runtime.
const GMAIL_ADDRESS      = 'otpeventattendancesystem@gmail.com';
// The SMTP app password is loaded from the ignored local .env or server environment.

require_once __DIR__ . '/PHPMailer/Exception.php';
require_once __DIR__ . '/PHPMailer/PHPMailer.php';
require_once __DIR__ . '/PHPMailer/SMTP.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception as PHPMailerException;

function localMailSetting(string $name): string
{
    $value = trim((string) getenv($name));
    if ($value !== '') return $value;
    $file = __DIR__ . '/.env';
    if (!is_file($file)) return '';
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        if (preg_match('/^\s*' . preg_quote($name, '/') . '\s*=\s*(.*?)\s*$/', $line, $match)) {
            return trim($match[1], " \t\n\r\0\x0B\"'");
        }
    }
    return '';
}

/**
 * Returns a PHPMailer instance pre-configured for Gmail SMTP.
 * Caller still needs to set: addAddress(), Subject, Body/AltBody, then send().
 *
 * @throws PHPMailerException
 */
function make_smtp_mailer(): PHPMailer
{
    $mail = new PHPMailer(true);

    $mail->isSMTP();
    $mail->Host       = 'smtp.gmail.com';
    $mail->SMTPAuth   = true;
    $mail->Username   = GMAIL_ADDRESS;
    $mail->Password   = localMailSetting('GMAIL_APP_PASSWORD');
    if ($mail->Password === '') throw new PHPMailerException('SMTP credentials are not configured.');
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port       = 587;

    // Keep the handshake fast so callers with short timeouts (e.g. Python's
    // urllib.request 8s timeout) don't give up before PHPMailer finishes.
    $mail->Timeout       = 10;
    $mail->SMTPKeepAlive = false;

    $mail->setFrom(GMAIL_ADDRESS, 'ATTENDANCE MONITORING SYSTEM');
    $mail->isHTML(true);
    $mail->CharSet = 'UTF-8';

    return $mail;
}
