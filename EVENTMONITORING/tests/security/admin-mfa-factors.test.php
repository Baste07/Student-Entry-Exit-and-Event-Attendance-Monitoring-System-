<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../admin/admin-mfa-factors.php';

const MFA_ACTOR = '11111111-1111-4111-8111-111111111111';
const MFA_TARGET = '22222222-2222-4222-8222-222222222222';
const MFA_FACTOR = '33333333-3333-4333-8333-333333333333';

function mfaCheck(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function mfaBearer(string $aal = 'aal2'): string
{
    $claims = ['sub' => MFA_ACTOR, 'role' => 'authenticated', 'aal' => $aal];
    return 'Bearer header.' . rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=') . '.signature';
}

function mfaTransport(array &$state): callable
{
    return static function (string $verb, string $path, ?array $body = null,
        ?string $token = null) use (&$state): array {
        if ($verb === 'GET' && $path === '/auth/v1/user') {
            return in_array($token, [substr(mfaBearer(), 7), substr(mfaBearer('aal1'), 7)], true)
                ? ['status' => 200, 'data' => ['id' => MFA_ACTOR]]
                : ['status' => 401, 'data' => []];
        }
        if ($verb === 'GET' && str_contains($path, 'admin_id=eq.' . MFA_ACTOR)) {
            return ['status' => 200, 'data' => [[
                'admin_id' => MFA_ACTOR, 'admin_level' => $state['actor_level'],
                'status' => $state['actor_status'],
            ]]];
        }
        if ($verb === 'GET' && str_contains($path, 'admin_id=eq.' . MFA_TARGET)) {
            return ['status' => 200, 'data' => [[
                'admin_id' => MFA_TARGET, 'admin_level' => $state['target_level'],
                'status' => 'active',
            ]]];
        }
        if ($verb === 'GET' && $path === '/auth/v1/admin/users/' . MFA_ACTOR . '/factors') {
            return ['status' => 200, 'data' => $state['actor_factor'] ? [[
                'factor_type' => 'totp', 'status' => 'verified',
            ]] : []];
        }
        if ($verb === 'GET' && $path === '/auth/v1/admin/users/' . MFA_TARGET . '/factors') {
            return ['status' => 200, 'data' => [[
                'id' => MFA_FACTOR, 'factor_type' => 'totp', 'status' => 'verified',
            ]]];
        }
        if ($verb === 'DELETE' && $path === '/auth/v1/admin/users/' . MFA_TARGET . '/factors/' . MFA_FACTOR) {
            $state['deletions']++;
            return ['status' => 200, 'data' => []];
        }
        if ($verb === 'POST' && $path === '/rest/v1/system_audit_logs') {
            $state['audits']++;
            mfaCheck(!str_contains(json_encode($body), 'Bearer'), 'Audit must not store bearer tokens.');
            return ['status' => 201, 'data' => []];
        }
        throw new RuntimeException('Unexpected MFA transport call.');
    };
}

function mfaFixture(array $overrides = []): array
{
    return array_merge([
        'actor_level' => 'super_admin', 'actor_status' => 'active',
        'actor_factor' => true, 'target_level' => 'super_admin',
        'deletions' => 0, 'audits' => 0,
    ], $overrides);
}

function mfaRequest(array &$state, string $action = 'reset', ?string $bearer = null,
    string $target = MFA_TARGET): array
{
    return handleAdminMfaFactors('POST', $bearer ?? mfaBearer(),
        json_encode(['action' => $action, 'adminId' => $target]), mfaTransport($state));
}

foreach ([
    ['actor_level' => 'admin'],
    ['actor_status' => 'suspended'],
] as $overrides) {
    $state = mfaFixture($overrides);
    $result = mfaRequest($state);
    mfaCheck($result['status'] === 403 && $state['deletions'] === 0,
        'Non-Super or suspended account must not reset factors (status ' . $result['status'] . ').');
}
$state = mfaFixture();
mfaCheck(mfaRequest($state, 'reset', mfaBearer('aal1'))['status'] === 403
    && $state['deletions'] === 0, 'AAL1 Super Admin must not reset factors.');
$state = mfaFixture();
mfaCheck(mfaRequest($state, 'reset', '')['status'] === 401
    && $state['deletions'] === 0, 'Unauthenticated reset must fail.');
$state = mfaFixture();
mfaCheck(mfaRequest($state, 'reset', null, MFA_ACTOR)['status'] === 403
    && $state['deletions'] === 0, 'Self-reset must fail.');
$state = mfaFixture(['actor_factor' => false]);
mfaCheck(mfaRequest($state)['status'] === 409 && $state['deletions'] === 0,
    'Another Super Admin cannot be reset without actor recovery MFA.');
$state = mfaFixture();
mfaCheck(mfaRequest($state, 'status')['status'] === 200 && $state['deletions'] === 0,
    'Status lookup must be read-only.');
$state = mfaFixture();
mfaCheck(mfaRequest($state)['status'] === 200 && $state['deletions'] === 1
    && $state['audits'] === 1, 'AAL2 Super Admin reset must remove one factor and audit.');

echo "MFA factor authorization, recovery, status, reset, and audit tests passed.\n";
