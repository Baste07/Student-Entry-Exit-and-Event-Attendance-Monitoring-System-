<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

// Isolated development-project smoke test. Never run against production.
require_once __DIR__ . '/../../admin/create-admin.php';
require_once __DIR__ . '/../../admin/delete-admin.php';

$expectedUrl = 'https://ehyqvyglirirktfmdezq.supabase.co';
if (getenv('DEV_PROJECT_REF') !== 'ehyqvyglirirktfmdezq') {
    throw new RuntimeException('Development project guard failed.');
}
$config = loadServerSupabaseConfig();
if ($config['url'] !== $expectedUrl) {
    throw new RuntimeException('Supabase URL does not match the development project.');
}
$normalToken = (string) getenv('DEV_NORMAL_TOKEN');
$superToken = (string) getenv('DEV_SUPER_TOKEN');
$superId = (string) getenv('DEV_SUPER_ID');
if ($normalToken === '' || $superToken === '' || $superId === '') {
    throw new RuntimeException('Development identity tokens are required.');
}

$request = static function (string $method, string $path, ?array $body = null, ?string $token = null) use ($config): array {
    return serverSupabaseRequest($config, $method, $path, $body, $token);
};
$email = 'codex-endpoint-' . bin2hex(random_bytes(6)) . '@example.com';
$body = json_encode([
    'name' => 'Endpoint Smoke Admin',
    'email' => $email,
    'faculty' => 'TEST',
    'level' => 'admin',
    'password' => bin2hex(random_bytes(16)),
], JSON_THROW_ON_ERROR);
$normalCreate = handleCreateAdminRequest('POST', 'Bearer ' . $normalToken, $body, $request);
if ($normalCreate['status'] !== 403) {
    throw new RuntimeException('Normal Admin create endpoint was not denied: ' . $normalCreate['status']);
}
$superCreate = handleCreateAdminRequest('POST', 'Bearer ' . $superToken, $body, $request);
if ($superCreate['status'] !== 201) {
    throw new RuntimeException('Super Admin create endpoint failed: ' . $superCreate['status']);
}
$profile = $request('GET', '/rest/v1/admins?email=eq.' . rawurlencode($email) . '&select=admin_id,email,admin_level&limit=1');
$createdId = $profile['data'][0]['admin_id'] ?? null;
if ($profile['status'] !== 200 || !is_string($createdId) || ($profile['data'][0]['admin_level'] ?? null) !== 'admin') {
    throw new RuntimeException('Created admin profile could not be verified.');
}
$authUser = $request('GET', '/auth/v1/admin/users/' . $createdId);
if ($authUser['status'] !== 200 || ($authUser['data']['id'] ?? null) !== $createdId) {
    throw new RuntimeException('Created Auth user could not be verified.');
}
$deleteBody = json_encode(['adminId' => $createdId], JSON_THROW_ON_ERROR);
$normalDelete = handleDeleteAdminRequest('POST', 'Bearer ' . $normalToken, $deleteBody, $request);
if ($normalDelete['status'] !== 403) {
    throw new RuntimeException('Normal Admin delete endpoint was not denied: ' . $normalDelete['status']);
}
$selfDelete = handleDeleteAdminRequest('POST', 'Bearer ' . $superToken,
    json_encode(['adminId' => $superId], JSON_THROW_ON_ERROR), $request);
if ($selfDelete['status'] !== 403) {
    throw new RuntimeException('Super Admin self-delete was not denied: ' . $selfDelete['status']);
}
$superDelete = handleDeleteAdminRequest('POST', 'Bearer ' . $superToken, $deleteBody, $request);
if ($superDelete['status'] !== 200) {
    throw new RuntimeException('Super Admin delete endpoint failed: ' . $superDelete['status']);
}
$remaining = $request('GET', '/rest/v1/admins?admin_id=eq.' . $createdId . '&select=admin_id');
if ($remaining['status'] !== 200 || count($remaining['data'] ?? []) !== 0) {
    throw new RuntimeException('Deleted admin profile remains.');
}
$deletedAuth = $request('GET', '/auth/v1/admin/users/' . $createdId);
if ($deletedAuth['status'] !== 404) {
    throw new RuntimeException('Deleted Auth user remains.');
}
echo "Development create/delete endpoints: normal denied, Super Admin create/delete passed, Auth and profile cleanup verified.\n";
