<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../admin/create-admin.php';

const CREATE_CALLER_ID = '11111111-1111-4111-8111-111111111111';
const CREATE_NEW_ID = '22222222-2222-4222-8222-222222222222';

function createJwt(string $aal = 'aal2'): string
{
    $claims = ['sub' => CREATE_CALLER_ID, 'role' => 'authenticated', 'aal' => $aal];
    return 'header.' . rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=') . '.signature';
}

function requireCreate(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function createFixture(array $overrides = []): array
{
    return array_merge([
        'level' => 'super_admin', 'status' => 'active', 'duplicate' => false,
        'profile_failure' => false, 'rollback_failure' => false,
        'calls' => [], 'auth_created' => false, 'profile_created' => false,
    ], $overrides);
}

function createTransport(array &$state): callable
{
    return static function (string $verb, string $path, ?array $body = null, ?string $token = null) use (&$state): array {
        $state['calls'][] = [$verb, $path, $body, $token];
        if ($verb === 'GET' && $path === '/auth/v1/user') {
            return in_array($token, [createJwt(), createJwt('aal1')], true)
                ? ['status' => 200, 'data' => ['id' => CREATE_CALLER_ID]]
                : ['status' => 401, 'data' => []];
        }
        if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?admin_id=eq.')) {
            return ['status' => 200, 'data' => [[
                'admin_id' => CREATE_CALLER_ID,
                'admin_level' => $state['level'], 'status' => $state['status'],
            ]]];
        }
        if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?email=eq.')) {
            return ['status' => 200, 'data' => $state['duplicate'] ? [['admin_id' => CREATE_NEW_ID]] : []];
        }
        if ($verb === 'POST' && $path === '/auth/v1/admin/users') {
            requireCreate($token === null, 'Service-role Auth creation must not forward a user token.');
            requireCreate(($body['email_confirm'] ?? null) === true, 'The admin email should be confirmed.');
            $state['auth_created'] = true;
            return ['status' => 201, 'data' => ['id' => CREATE_NEW_ID]];
        }
        if ($verb === 'POST' && $path === '/rest/v1/admins') {
            requireCreate($token === null, 'Service-role profile creation must not forward a user token.');
            requireCreate(($body['password'] ?? null) === 'AUTH_MANAGED', 'Never copy the actual password into admins.');
            if ($state['profile_failure']) return ['status' => 409, 'data' => []];
            $state['profile_created'] = true;
            return ['status' => 201, 'data' => []];
        }
        if ($verb === 'DELETE' && $path === '/auth/v1/admin/users/' . CREATE_NEW_ID) {
            if ($state['rollback_failure']) return ['status' => 500, 'data' => []];
            $state['auth_created'] = false;
            return ['status' => 200, 'data' => []];
        }
        throw new RuntimeException('Unexpected request: ' . $verb . ' ' . $path);
    };
}

function createWith(array &$state, string $level = 'admin', ?string $token = null, string $email = 'test@example.edu'): array
{
    return handleCreateAdminRequest('POST', 'Bearer ' . ($token ?? createJwt()), json_encode([
        'name' => 'Test Admin', 'email' => $email, 'faculty' => 'Science',
        'level' => $level, 'password' => 'test-password-123',
    ]), createTransport($state));
}

$tests = [
    'invalid requests do not contact Supabase' => static function (): void {
        $state = createFixture();
        requireCreate(handleCreateAdminRequest('GET', '', '', createTransport($state))['status'] === 405, 'GET must fail.');
        requireCreate(handleCreateAdminRequest('POST', '', '{}', createTransport($state))['status'] === 401, 'Bearer required.');
        requireCreate(handleCreateAdminRequest('POST', 'Bearer ' . createJwt(), '{}', createTransport($state))['status'] === 400, 'Fields required.');
        requireCreate($state['calls'] === [], 'Validation should precede network calls.');
    },
    'normal and suspended admins cannot create accounts' => static function (): void {
        foreach ([['level' => 'admin'], ['status' => 'suspended']] as $options) {
            $state = createFixture($options);
            requireCreate(createWith($state)['status'] === 403, 'Unauthorized caller must fail.');
            requireCreate(!$state['auth_created'], 'Unauthorized caller must not create Auth users.');
        }
    },
    'password-only Super Admin cannot create an account' => static function (): void {
        $state = createFixture();
        requireCreate(createWith($state, 'admin', createJwt('aal1'))['status'] === 403,
            'AAL1 must fail before account creation.');
        requireCreate(!$state['auth_created'], 'AAL1 must not create Auth users.');
    },
    'super admin can create regular and super admin accounts' => static function (): void {
        foreach (['admin', 'super_admin'] as $level) {
            $state = createFixture();
            $result = createWith($state, $level);
            requireCreate($result['body']['success'] === true, 'Authorized creation must succeed: ' . $result['body']['message'] . ' Calls: ' . implode(', ', array_map(static fn ($call) => $call[0] . ' ' . $call[1], $state['calls'])));
            requireCreate($state['auth_created'] && $state['profile_created'], 'Both account records must exist.');
            $profileCall = array_values(array_filter($state['calls'], static fn ($call) => $call[1] === '/rest/v1/admins'))[0];
            requireCreate(($profileCall[2]['admin_level'] ?? null) === $level, 'Requested level must be saved.');
        }
    },
    'valid external and institutional email domains are accepted' => static function (): void {
        foreach (['admin@gmail.com', 'user@outlook.com', 'person@yahoo.com',
            'codex-super-20260926@example.com', 'admin@plpasig.edu.ph'] as $email) {
            $state = createFixture();
            requireCreate(createWith($state, 'admin', null, $email)['status'] === 201,
                'Valid email should be accepted.');
        }
        foreach (['abc', 'user@', '@example.com'] as $email) {
            $state = createFixture();
            requireCreate(createWith($state, 'admin', null, $email)['status'] === 400,
                'Malformed email should be rejected.');
            requireCreate($state['calls'] === [], 'Malformed email must not contact Supabase.');
        }
    },
    'expired bearer and duplicate email do not create accounts' => static function (): void {
        $state = createFixture();
        requireCreate(createWith($state, 'admin', 'expired')['status'] === 401, 'Expired session must fail.');
        requireCreate(!$state['auth_created'], 'Expired session must not write.');
        $state = createFixture(['duplicate' => true]);
        requireCreate(createWith($state)['status'] === 409, 'Duplicate must fail.');
        requireCreate(!$state['auth_created'], 'Duplicate must not write.');
    },
    'profile failure rolls back new Auth user' => static function (): void {
        $state = createFixture(['profile_failure' => true]);
        requireCreate(createWith($state)['status'] === 502, 'Profile failure must fail.');
        requireCreate(!$state['auth_created'] && !$state['profile_created'], 'Auth account must be rolled back.');
        $state = createFixture(['profile_failure' => true, 'rollback_failure' => true]);
        requireCreate(createWith($state)['status'] === 502, 'Failed rollback must be reported.');
        requireCreate($state['auth_created'], 'Fixture should retain orphan for manual cleanup.');
    },
];

foreach ($tests as $name => $test) {
    $test();
    echo "PASS: {$name}\n";
}
echo count($tests) . " offline admin-creation tests passed.\n";
