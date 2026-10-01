<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

// Preflight only. Never print the key or make a network request.
require_once __DIR__ . '/../../config/supabase-server.php';
$config = loadServerSupabaseConfig();
if ($config['url'] !== 'https://hgdqarcdfycdesavwrvq.supabase.co') {
    throw new RuntimeException('Server configuration does not target the approved production project.');
}
echo "Production server service-role configuration is present and project-scoped.\n";
