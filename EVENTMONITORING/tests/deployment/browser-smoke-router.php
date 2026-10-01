<?php
if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}
// Restrict the short-lived localhost test server from serving server secrets.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (preg_match('~(?:^|/)(?:\.env|\.git|camera_owner\.json)(?:$|/)~i', $path)) {
    http_response_code(404);
    exit;
}
return false;
