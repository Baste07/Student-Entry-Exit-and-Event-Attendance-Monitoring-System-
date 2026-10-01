<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../admin/admin-mfa-auth.php';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

function testBearer(string $aal, string $identity = ACTOR_ID): string
{
    $claims = ['sub' => $identity, 'role' => 'authenticated', 'aal' => $aal];
    return 'Bearer header.' . rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=') . '.signature';
}

function checkAuthorization(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function profileRequest(string $level, string $status, int &$calls): callable
{
    return static function (string $method, string $path, ?array $body = null,
        ?string $token = null) use ($level, $status, &$calls): array {
        $calls++;
        if ($method !== 'GET') throw new RuntimeException('Unexpected mutation during auth test.');
        if ($path === '/auth/v1/user') {
            return ['status' => 200, 'data' => ['id' => ACTOR_ID]];
        }
        if (str_starts_with($path, '/rest/v1/admins?admin_id=eq.')) {
            return ['status' => 200, 'data' => [[
                'admin_id' => ACTOR_ID, 'admin_level' => $level, 'status' => $status,
            ]]];
        }
        throw new RuntimeException('Unexpected authorization lookup.');
    };
}

$calls = 0;
$request = profileRequest('admin', 'active', $calls);
checkAuthorization(adminEndpointAuthorization('GET', ['POST'], false, $request,
    testBearer('aal2'))['status'] === 405 && $calls === 0,
    'Method guard must stop before contacting Supabase.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], false, $request, '')['status'] === 401,
    'Missing bearer must be denied.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], false, $request,
    testBearer('aal1'))['status'] === 403, 'AAL1 Admin must be denied.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], false, $request,
    testBearer('aal2'))['status'] === 200, 'AAL2 Admin must reach Admin actions.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], true, $request,
    testBearer('aal2'))['status'] === 403, 'Normal Admin must not reach Super Admin actions.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], false, $request,
    testBearer('aal2', '22222222-2222-4222-8222-222222222222'))['status'] === 403,
    'JWT subject must match the Auth identity.');

$superRequest = profileRequest('super_admin', 'active', $calls);
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], true, $superRequest,
    testBearer('aal1'))['status'] === 403, 'AAL1 Super Admin must be denied.');
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], true, $superRequest,
    testBearer('aal2'))['status'] === 200, 'AAL2 Super Admin must reach Super Admin actions.');

$suspendedRequest = profileRequest('admin', 'suspended', $calls);
checkAuthorization(adminEndpointAuthorization('POST', ['POST'], false, $suspendedRequest,
    testBearer('aal2'))['status'] === 403, 'Suspended Admin must be denied.');

echo "Shared operational PHP authorization matrix passed.\n";
