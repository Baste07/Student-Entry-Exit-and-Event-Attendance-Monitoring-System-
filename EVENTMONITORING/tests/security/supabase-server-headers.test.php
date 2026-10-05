<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../config/supabase-server.php';

function assertHeaderState(array $headers, bool $bearerExpected): void
{
    $bearer = array_values(array_filter($headers,
        static fn(string $header): bool => str_starts_with($header, 'Authorization: Bearer ')));
    if (count($bearer) !== (int) $bearerExpected) {
        throw new RuntimeException('Unexpected Authorization header for Supabase API key type.');
    }
}

$secret = ['key' => 'sb_secret_synthetic-test-only'];
$public = ['key' => 'sb_publishable_synthetic-test-only'];
$legacy = ['key' => 'synthetic-legacy-jwt'];
assertHeaderState(serverSupabaseHeaders($secret), false);
assertHeaderState(serverSupabaseHeaders($public), false);
assertHeaderState(serverSupabaseHeaders($legacy), true);
assertHeaderState(serverSupabaseHeaders($secret, 'synthetic-user-jwt'), true);
if (!in_array('Authorization: Bearer synthetic-user-jwt',
    serverSupabaseHeaders($secret, 'synthetic-user-jwt'), true)) {
    throw new RuntimeException('User-scoped requests must carry the user JWT.');
}

echo "Supabase server header checks passed.\n";
