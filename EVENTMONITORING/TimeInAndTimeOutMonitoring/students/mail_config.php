<?php
declare(strict_types=1);

/**
 * Shared Gmail SMTP settings + a helper to get a ready-to-send PHPMailer instance.
 *
 * SETUP (one-time):
 * 1. Go to https://myaccount.google.com/apppasswords
 *    (requires 2-Step Verification to be turned on for the Gmail account)
 * 2. Create an App Password named e.g. "SAMS Server" -> Google gives you a 16-char code
 * 3. Fill in GMAIL_ADDRESS and GMAIL_APP_PASSWORD below
 * 4. Do NOT commit this file with real credentials to a public repo.
 *    Add it to .gitignore, or better, load these two values from environment
 *    variables / a .env file instead of hardcoding them.
 *
 * Place this file, and the /PHPMailer folder next to it, somewhere both
 * send_event_attendance_email.php and send_student_qr_email.php (or any
 * other mail-sending script) can reach via require_once.
 */

// ── EDIT THESE TWO VALUES ──────────────────────────────────────────────
const GMAIL_ADDRESS      = 'otpeventattendancesystem@gmail.com';
const GMAIL_APP_PASSWORD = 'opox zxiw zwhb ftni'; // the 16-char App Password, spaces are fine
// ────────────────────────────────────────────────────────────────────

require_once __DIR__ . '/PHPMailer/Exception.php';
require_once __DIR__ . '/PHPMailer/PHPMailer.php';
require_once __DIR__ . '/PHPMailer/SMTP.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception as PHPMailerException;

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
    $mail->Password   = GMAIL_APP_PASSWORD;
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