<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../auth/admin-login.php';

const LOGIN_USER = '11111111-1111-4111-8111-111111111111';

function loginCheck(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function loginFixture(bool $correct = false): array
{
    return [
        'correct' => $correct,
        'authCalls' => 0, 'failureCalls' => 0, 'successCalls' => 0,
        'state' => ['known' => true, 'attempts' => 1, 'remaining' => 2,
            'locked' => false, 'recovery_protected' => false],
        'success' => ['allowed' => true, 'locked' => false],
        'authError' => false,
        'transportError' => false,
    ];
}

function loginWith(array &$fixture): array
{
    $auth = static function (string $verb, string $path, ?array $body) use (&$fixture): array {
        $fixture['authCalls']++;
        loginCheck($verb === 'POST' && $path === '/auth/v1/token?grant_type=password',
            'Passwords must be verified through Supabase Auth.');
        loginCheck(($body['password'] ?? null) === 'test-password', 'Password must reach only Auth.');
        if ($fixture['transportError']) throw new RuntimeException('Synthetic transport failure');
        if ($fixture['authError']) return ['status' => 503, 'data' => ['code' => 'network_error']];
        return $fixture['correct']
            ? ['status' => 200, 'data' => ['user' => ['id' => LOGIN_USER],
                'access_token' => 'test-access', 'refresh_token' => 'test-refresh']]
            : ['status' => 400, 'data' => ['code' => 400, 'error_code' => 'invalid_credentials']];
    };
    $service = static function (string $verb, string $path, ?array $body) use (&$fixture): array {
        loginCheck($verb === 'POST', 'Lockout writes must use an RPC.');
        loginCheck(!array_key_exists('password', $body ?? []), 'Password must not reach service role.');
        if ($path === '/rest/v1/rpc/record_admin_password_failure') {
            $fixture['failureCalls']++;
            return ['status' => 200, 'data' => $fixture['state']];
        }
        if ($path === '/rest/v1/rpc/record_admin_password_success') {
            $fixture['successCalls']++;
            return ['status' => 200, 'data' => $fixture['success']];
        }
        throw new RuntimeException('Unexpected RPC.');
    };
    return handleAdminLoginRequest('POST', json_encode([
        'email' => 'admin@example.com', 'password' => 'test-password'
    ], JSON_THROW_ON_ERROR), $auth, $service);
}

$fixture = loginFixture();
$failed = loginWith($fixture);
loginCheck($failed['status'] === 401 && str_contains($failed['body']['message'], '2 attempts remaining'),
    'Known failed passwords should show remaining attempts.');
loginCheck($fixture['failureCalls'] === 1 && $fixture['successCalls'] === 0,
    'Only a failed password should increment.');

$fixture = loginFixture();
$fixture['state'] = ['known' => false, 'attempts' => 0, 'remaining' => 0,
    'locked' => false, 'recovery_protected' => false];
loginCheck(loginWith($fixture)['body']['message'] === 'Invalid email or password.',
    'Unknown email feedback must be generic.');

$fixture = loginFixture();
$fixture['authError'] = true;
loginCheck(loginWith($fixture)['status'] === 503 && $fixture['failureCalls'] === 0,
    'Network or Auth server errors must not count.');

$fixture = loginFixture();
$fixture['transportError'] = true;
loginCheck(loginWith($fixture)['status'] === 503 && $fixture['failureCalls'] === 0,
    'A PHP transport failure must not increment the password counter.');

$fixture = loginFixture();
$fixture['state'] = ['known' => true, 'attempts' => 3, 'remaining' => 0,
    'locked' => true, 'recovery_protected' => false];
loginCheck(loginWith($fixture)['status'] === 423,
    'Threshold failure must return the persistent lock response.');
$fixture['state']['locked'] = false;
$fixture['state']['recovery_protected'] = true;
loginCheck(loginWith($fixture)['status'] === 401,
    'The last recovery Super Admin must not be treated as locked.');

$fixture = loginFixture(true);
loginCheck(loginWith($fixture)['status'] === 200 && $fixture['successCalls'] === 1,
    'A correct password must pass through the success gate.');
$fixture['success'] = ['allowed' => false, 'locked' => true];
$blocked = loginWith($fixture);
loginCheck($blocked['status'] === 423 && !isset($blocked['body']['access_token']),
    'A locked account must not receive Auth tokens.');

echo "Admin login PHP fallback checks passed.\n";
