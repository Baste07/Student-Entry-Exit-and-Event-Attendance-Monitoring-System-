<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// If registration engine is already online, return immediately.
$sock = @fsockopen('127.0.0.1', 5001, $errno, $errstr, 0.2);
if ($sock) {
	fclose($sock);
	echo json_encode(["status" => "running", "message" => "Registration engine already running"]);
	exit;
}

// Point directly to your new BAT file
$bat_file = 'C:\xampp\htdocs\INTEG SYSTEM\SmartAcademicManagementSystem\TimeInAndTimeOutMonitoring\students\START_REGISTRATION.bat';

// Execute the BAT file in the background
pclose(popen('start "" "' . $bat_file . '"', "r"));

echo json_encode(["status" => "success", "message" => "Triggered BAT file"]);
?>