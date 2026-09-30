<?php
// Local test server only: point browser code at the development Supabase project.
// The publishable/anon key is supplied to this process, never stored in the repo.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
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
