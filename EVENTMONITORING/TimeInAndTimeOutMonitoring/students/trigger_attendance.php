<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// If engine is already online, return immediately.
$sock = @fsockopen('127.0.0.1', 5000, $errno, $errstr, 0.2);
if ($sock) {
	fclose($sock);
	echo json_encode(["status" => "running", "message" => "Engine already running"]);
	exit;
}

// Point directly to your new BAT file
$bat_file = 'C:\xampp\htdocs\CAPSTONEFINAL\EVENTMONITORING\TimeInAndTimeOutMonitoring\students\START_ATTENDANCE.bat';

// Execute the BAT file in the background
pclose(popen('start /B "" "' . $bat_file . '"', "r"));

echo json_encode(["status" => "success", "message" => "Triggered BAT file"]);
?>