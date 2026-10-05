<?php
declare(strict_types=1);

require_once __DIR__ . '/../../admin/admin-mfa-auth.php';
enforceAdminAal2Http(['POST']);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$socket = @fsockopen('127.0.0.1', 5000, $errno, $error, 0.2);
if ($socket !== false) {
    fclose($socket);
    echo json_encode(['status' => 'running', 'message' => 'Attendance engine already running.']);
    exit;
}

// This launcher is deliberately machine-local and excluded from Git.
$launcher = __DIR__ . '/START_ATTENDANCE.bat';
if (!is_file($launcher)) {
    http_response_code(503);
    echo json_encode(['status' => 'unavailable', 'message' => 'Local attendance launcher is missing.']);
    exit;
}

// The batch file launches Python in a hidden, detached process and returns.
// Do not use cmd's "start" here: it creates a persistent visible CMD window.
// No request data is included in the command.
$command = '"' . str_replace('/', '\\', $launcher) . '"';
$process = @popen($command, 'r');
if ($process === false) {
    http_response_code(503);
    echo json_encode(['status' => 'unavailable', 'message' => 'Could not start the local attendance launcher.']);
    exit;
}
$exitCode = pclose($process);
if ($exitCode !== 0) {
    http_response_code(503);
    echo json_encode(['status' => 'unavailable', 'message' => 'Local attendance launcher failed. Check its local log.']);
    exit;
}

echo json_encode(['status' => 'success', 'message' => 'Attendance engine start requested.']);
