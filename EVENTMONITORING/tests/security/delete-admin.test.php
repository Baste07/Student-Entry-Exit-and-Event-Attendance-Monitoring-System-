<?php
declare(strict_types=1);

require_once __DIR__ . '/../../admin/delete-admin.php';

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function fixture(array $options = []): array
{
    return array_merge([
        'role' => 'super_admin', 'status' => 'active', 'profile' => true,
        'auth' => true, 'authFailure' => false,
        'cleanupFailure' => false, 'timeout' => false, 'writes' => [], 'calls' => 0,
        'restoredStatus' => null,
    ], $options);
}

function transportFor(array &$state): callable
{
    return static function (string $method, string $path, ?array $body = null, ?string $token = null) use (&$state): array {
        $state['calls']++;
        if ($method === 'GET' && $path === '/auth/v1/user') {
            check($token !== null, 'Auth verification must receive the caller bearer token.');
            return $token === 'valid-token'
                ? ['status' => 200, 'data' => ['id' => CALLER_ID]]
                : ['status' => 401, 'data' => []];
        }
        if ($method === 'GET' && strpos($path, '/rest/v1/admins?admin_id=eq.' . CALLER_ID) === 0) {
            return ['status' => 200, 'data' => [[
                'admin_id' => CALLER_ID, 'admin_level' => $state['role'], 'status' => $state['status'],
            ]]];
        }
        if ($method === 'GET' && strpos($path, '/rest/v1/admins?admin_id=eq.' . TARGET_ID) === 0) {
            return ['status' => 200, 'data' => $state['profile'] ? [[
                'admin_id' => TARGET_ID, 'email' => 'target@example.com',
                'password' => 'AUTH_MANAGED', 'admin_level' => 'admin', 'status' => 'active',
            ]] : []];
        }
        if ($method === 'DELETE' && $path === '/auth/v1/admin/users/' . TARGET_ID) {
            $state['writes'][] = 'auth';
            check(($body['should_soft_delete'] ?? null) === false, 'Deletion must remove Auth permanently.');
            if ($state['timeout']) {
                throw new RuntimeException('Simulated network timeout.');
            }
            if ($state['authFailure']) {
                return ['status' => 500, 'data' => ['code' => 'unexpected_failure']];
            }
            if (!$state['auth']) {
                return ['status' => 404, 'data' => ['code' => 'user_not_found']];
            }
            $state['auth'] = false;
            return ['status' => 200, 'data' => ['id' => TARGET_ID]];
        }
        if ($method === 'DELETE' && $path === '/rest/v1/admins?admin_id=eq.' . TARGET_ID) {
            $state['writes'][] = 'profile';
            if ($state['cleanupFailure']) {
                return ['status' => 409, 'data' => ['code' => '23503']];
            }
            $state['profile'] = false;
            return ['status' => 204, 'data' => null];
        }
        if ($method === 'POST' && $path === '/rest/v1/admins') {
            $state['writes'][] = 'restore';
            $state['profile'] = true;
            $state['restoredStatus'] = $body['status'] ?? null;
            return ['status' => 201, 'data' => null];
        }
        throw new RuntimeException('Unexpected test request: ' . $method . ' ' . $path);
    };
}

function deleteWith(array &$state, string $authorization = 'Bearer valid-token', string $targetId = TARGET_ID): array
{
    return handleDeleteAdminRequest('POST', $authorization, json_encode(['adminId' => $targetId]), transportFor($state));
}

$tests = [
    'method, bearer, and ID validation do not contact Supabase' => static function (): void {
        $state = fixture();
        check(handleDeleteAdminRequest('GET', '', '', transportFor($state))['status'] === 405, 'GET must fail.');
        check(deleteWith($state, '')['status'] === 401, 'Missing bearer must fail.');
        check(deleteWith($state, 'Bearer valid-token', 'bad-id')['status'] === 400, 'Invalid ID must fail.');
        check($state['calls'] === 0, 'Validation must happen before upstream requests.');
    },
    'invalid sessions, regular admins, and suspended super admins cannot delete' => static function (): void {
        foreach ([['role' => 'admin'], ['status' => 'suspended'], ['status' => 'inactive']] as $options) {
            $state = fixture($options);
            check(deleteWith($state)['status'] === 403, 'Unauthorized caller must be forbidden.');
            check($state['writes'] === [], 'Unauthorized callers must not mutate records.');
        }
        $state = fixture();
        check(deleteWith($state, 'Bearer expired-token')['status'] === 401, 'Expired bearer must fail.');
        check($state['writes'] === [], 'Expired sessions must not mutate records.');
    },
    'self-deletion is blocked on the server' => static function (): void {
        $state = fixture();
        check(deleteWith($state, 'Bearer valid-token', CALLER_ID)['status'] === 403, 'Self-delete must fail.');
        check($state['writes'] === [], 'Self-delete must not mutate records.');
    },
    'missing admin profile cannot delete an unrelated Auth user' => static function (): void {
        $state = fixture(['profile' => false]);
        check(deleteWith($state)['status'] === 404, 'Missing profile must fail.');
        check($state['auth'] && $state['writes'] === [], 'Unrelated Auth user must remain.');
    },
    'successful deletion removes profile before Auth' => static function (): void {
        $state = fixture();
        check(deleteWith($state)['body']['success'] === true, 'Deletion should succeed.');
        check(!$state['auth'] && !$state['profile'], 'Both records must be gone.');
        check($state['writes'] === ['profile', 'auth'], 'The non-cascading FK requires profile-first deletion.');
    },
    'missing Auth user still allows profile cleanup' => static function (): void {
        $state = fixture(['auth' => false]);
        check(deleteWith($state)['body']['success'] === true, 'Missing Auth cleanup should succeed.');
        check(!$state['profile'], 'Profile must be removed.');
    },
    'blocked Auth deletion restores a suspended admin profile' => static function (): void {
        $state = fixture(['authFailure' => true]);
        check(deleteWith($state)['body']['success'] === false, 'Blocked deletion must fail.');
        check($state['auth'] && $state['profile'], 'Blocked Auth deletion must leave both records.');
        check($state['writes'] === ['profile', 'auth', 'restore'], 'Profile must be restored after Auth failure.');
        check($state['restoredStatus'] === 'suspended', 'Recovery must not restore active login.');
    },
    'blocked profile deletion never reaches Auth' => static function (): void {
        $state = fixture(['cleanupFailure' => true]);
        $result = deleteWith($state);
        check($result['body']['success'] === false, 'Blocked profile deletion must fail.');
        check($state['auth'] && $state['profile'], 'Blocked profile deletion must preserve both records.');
        check($state['writes'] === ['profile'], 'Auth deletion must not follow profile failure.');
        $state['cleanupFailure'] = false;
        check(deleteWith($state)['body']['success'] === true, 'Retry must complete deletion.');
    },
    'an uncertain Auth deletion restores a suspended profile' => static function (): void {
        $state = fixture(['timeout' => true]);
        $result = deleteWith($state);
        check($result['body']['success'] === false, 'Network uncertainty must fail.');
        check($state['profile'] && $state['writes'] === ['profile', 'auth', 'restore'], 'Restore profile after uncertain Auth result.');
        check($state['restoredStatus'] === 'suspended', 'Recovery must not restore active login.');
    },
];

foreach ($tests as $name => $test) {
    $test();
    echo "PASS: {$name}\n";
}
echo count($tests) . " offline endpoint tests passed.\n";
