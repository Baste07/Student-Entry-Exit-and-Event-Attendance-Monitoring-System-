<?php
require_once __DIR__ . '/../../admin/admin-mfa-auth.php';
enforceAdminAal2Http(['POST']);
header('Content-Type: application/json');

// If registration engine is already online, return immediately.
$sock = @fsockopen('127.0.0.1', 5001, $errno, $errstr, 0.2);
if ($sock) {
	fclose($sock);
	echo json_encode(["status" => "running", "message" => "Registration engine already running"]);
	exit;
}

// Point directly to your new BAT file
$bat_file = 'C:\xampp\htdocs\CAPSTONEFINAL\EVENTMONITORING\TimeInAndTimeOutMonitoring\students\START_REGISTRATION.bat';

// Execute the BAT file in the background
pclose(popen('start "" "' . $bat_file . '"', "r"));

echo json_encode(["status" => "success", "message" => "Triggered BAT file"]);
?>
