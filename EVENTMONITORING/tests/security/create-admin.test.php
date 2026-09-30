<?php
declare(strict_types=1);

require_once __DIR__ . '/../../admin/create-admin.php';

const CREATE_CALLER_ID = '11111111-1111-4111-8111-111111111111';
const CREATE_NEW_ID = '22222222-2222-4222-8222-222222222222';

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
            return $token === 'valid-token'
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

function createWith(array &$state, string $level = 'admin', string $token = 'valid-token'): array
{
    return handleCreateAdminRequest('POST', 'Bearer ' . $token, json_encode([
        'name' => 'Test Admin', 'email' => 'test@example.edu', 'faculty' => 'Science',
        'level' => $level, 'password' => 'test-password-123',
    ]), createTransport($state));
}

$tests = [
    'invalid requests do not contact Supabase' => static function (): void {
        $state = createFixture();
        requireCreate(handleCreateAdminRequest('GET', '', '', createTransport($state))['status'] === 405, 'GET must fail.');
        requireCreate(handleCreateAdminRequest('POST', '', '{}', createTransport($state))['status'] === 401, 'Bearer required.');
        requireCreate(handleCreateAdminRequest('POST', 'Bearer valid-token', '{}', createTransport($state))['status'] === 400, 'Fields required.');
        requireCreate($state['calls'] === [], 'Validation should precede network calls.');
    },
    'normal and suspended admins cannot create accounts' => static function (): void {
        foreach ([['level' => 'admin'], ['status' => 'suspended']] as $options) {
            $state = createFixture($options);
            requireCreate(createWith($state)['status'] === 403, 'Unauthorized caller must fail.');
            requireCreate(!$state['auth_created'], 'Unauthorized caller must not create Auth users.');
        }
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
