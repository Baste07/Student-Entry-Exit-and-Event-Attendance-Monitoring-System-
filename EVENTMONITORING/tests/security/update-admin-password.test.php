<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../auth/update-admin-password.php';

const PASSWORD_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
function passwordTestToken(string $aal = 'aal2', bool $recovery = false): string
{
    $claims = ['sub' => PASSWORD_ADMIN_ID, 'role' => 'authenticated', 'aal' => $aal,
        'amr' => [['method' => $recovery ? 'recovery' : 'password']]];
    return 'header.' . rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=') . '.signature';
}
function passwordTest(bool $ok, string $description): void
{
    if (!$ok) throw new RuntimeException($description);
}

$state = ['status' => 'active', 'level' => 'admin', 'locked' => false, 'factor' => true, 'writes' => 0];
$adminRequest = static function (string $verb, string $path, ?array $body = null, ?string $token = null) use (&$state): array {
    if ($verb === 'GET' && $path === '/auth/v1/user') return ['status' => 200, 'data' => ['id' => PASSWORD_ADMIN_ID]];
    if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?')) return ['status' => 200, 'data' => [[
        'admin_id' => PASSWORD_ADMIN_ID, 'email' => 'person@example.com', 'admin_name' => 'Patricia Cruz',
        'admin_level' => $state['level'], 'status' => $state['status'], 'login_locked' => $state['locked']]]];
    if ($verb === 'GET' && str_contains($path, '/factors')) return ['status' => 200, 'data' => $state['factor']
        ? [['factor_type' => 'totp', 'status' => 'verified']] : []];
    throw new RuntimeException('Unexpected Admin request');
};
$userRequest = static function (string $verb, string $path, ?array $body = null, ?string $token = null) use (&$state): array {
    passwordTest($verb === 'PUT' && $path === '/auth/v1/user', 'Only user-scoped Auth update is allowed.');
    passwordTest($token === passwordTestToken() || $token === passwordTestToken('aal1', true), 'Caller bearer must be used.');
    passwordTest(($body['password'] ?? null) === 'SecureRandomPhrase123!', 'Valid password must reach Auth only.');
    $state['writes']++;
    return ['status' => 200, 'data' => []];
};
$invoke = static function ($password, string $token = '', string $method = 'POST') use ($adminRequest, $userRequest): array {
    return handleUpdateAdminPasswordRequest($method, $token ? 'Bearer ' . $token : '',
        json_encode(['password' => $password]), $adminRequest, $userRequest);
};

passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken(), 'GET')['status'] === 405, 'GET denied');
passwordTest($invoke('SecureRandomPhrase123!')['status'] === 401, 'Missing bearer denied');
foreach (['short', 'alllowercaselong123!', 'ALLUPPERCASELONG123!', 'NoDigitInThisPhrase!',
    'NoSpecialCharacter123', 'PatriciaSecure123!', 'person@example.comA1!'] as $weak) {
    $result = $invoke($weak, passwordTestToken());
    passwordTest($result['status'] === 400, 'Weak or identity password denied');
    passwordTest(!str_contains(json_encode($result['body']), $weak), 'Password must never be echoed');
}
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken('aal1'))['status'] === 403, 'Ordinary AAL1 denied');
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken('aal1', true))['status'] === 403, 'Enrolled factor requires AAL2');
$state['factor'] = false;
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken('aal1', true))['status'] === 200, 'Recovery without factor allowed');
$state['status'] = 'suspended';
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken())['status'] === 403, 'Suspended Admin denied');
$state['status'] = 'active'; $state['locked'] = true;
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken())['status'] === 403, 'Locked Admin denied');
$state['locked'] = false;
passwordTest($invoke('SecureRandomPhrase123!', passwordTestToken())['status'] === 200, 'Active AAL2 Admin accepted');
passwordTest($state['writes'] === 2, 'Only authorized valid updates reached Auth');
echo "Admin password-update PHP boundary: all checks passed.\n";
