<?php
if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}
// Local test server only: point browser code at the development Supabase project.
// The publishable/anon key is supplied to this process, never stored in the repo.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
// Never let a development browser test invoke privileged PHP with this
// workstation's fallback (potentially production) server configuration.
if (preg_match('~/EVENTMONITORING/(?:admin/(?:create-admin|delete-admin|admin-mfa-factors|send-student-qr-email)|TimeInAndTimeOutMonitoring/students/(?:trigger_attendance|trigger_registration|send_event_attendance_email|machine_lab_config|delete_engine_log))\.php$~', $path)
    && (getenv('SUPABASE_URL') !== 'https://ehyqvyglirirktfmdezq.supabase.co'
        || !getenv('SUPABASE_SERVICE_ROLE_KEY'))) {
    http_response_code(503);
    exit;
}
if (preg_match('~(?:^|/)(?:\.env|\.git|camera_owner\.json)(?:$|/)~i', $path)) {
    http_response_code(404);
    exit;
}
if (str_ends_with($path, '/EVENTMONITORING/config/.env.js')) {
    header('Content-Type: application/javascript; charset=utf-8');
    echo 'const ENV = ', json_encode([
        'SUPABASE_PROJECT_URL' => 'https://ehyqvyglirirktfmdezq.supabase.co',
        'SUPABASE_ANON_KEY' => getenv('DEV_SUPABASE_ANON_KEY') ?: '',
    ], JSON_UNESCAPED_SLASHES), ';';
    exit;
}
return false;
