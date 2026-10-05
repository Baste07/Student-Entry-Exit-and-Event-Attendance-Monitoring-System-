<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../admin/update-admin-email.php';

const EMAIL_ACTOR = '11111111-1111-4111-8111-111111111111';
const EMAIL_TARGET = '22222222-2222-4222-8222-222222222222';
const EMAIL_OTHER = '33333333-3333-4333-8333-333333333333';

function emailAssert(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}

function emailJwt(string $aal = 'aal2'): string
{
    $claims = ['sub' => EMAIL_ACTOR, 'role' => 'authenticated', 'aal' => $aal];
    return 'header.' . rtrim(strtr(base64_encode(json_encode($claims)), '+/', '-_'), '=') . '.signature';
}

function emailState(array $overrides = []): array
{
    return array_merge([
        'actor_level' => 'super_admin', 'actor_status' => 'active',
        'actor_factor' => true,
        'auth_email' => 'old@example.invalid', 'profile_email' => 'old@example.invalid',
        'other_auth_email' => 'other@example.invalid', 'other_profile_email' => 'other@example.invalid',
        'auth_update_status' => 200, 'auth_applied_after_error' => false,
        'profile_update_status' => 204,
        'audit_status' => 201, 'audit' => [], 'calls' => [],
    ], $overrides);
}

function emailTransport(array &$state): callable
{
    return static function (string $verb, string $path, ?array $body = null, ?string $token = null) use (&$state): array {
        $state['calls'][] = [$verb, $path, $body, $token];
        if ($verb === 'GET' && $path === '/auth/v1/user') {
            return $token === emailJwt() || $token === emailJwt('aal1')
                ? ['status' => 200, 'data' => ['id' => EMAIL_ACTOR]]
                : ['status' => 401, 'data' => []];
        }
        emailAssert($token === null, 'Only the validated identity lookup may use the caller bearer.');
        if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?admin_id=eq.' . EMAIL_ACTOR)) {
            return ['status' => 200, 'data' => [[
                'admin_id' => EMAIL_ACTOR, 'admin_level' => $state['actor_level'],
                'status' => $state['actor_status'], 'login_locked' => false,
            ]]];
        }
        if ($verb === 'GET' && $path === '/auth/v1/admin/users/' . EMAIL_ACTOR . '/factors') {
            return ['status' => 200, 'data' => $state['actor_factor'] ? [[
                'factor_type' => 'totp', 'status' => 'verified',
            ]] : []];
        }
        if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?admin_id=eq.' . EMAIL_TARGET)) {
            return ['status' => 200, 'data' => [[
                'admin_id' => EMAIL_TARGET, 'email' => $state['profile_email'],
            ]]];
        }
        if ($verb === 'GET' && str_starts_with($path, '/rest/v1/admins?select=')) {
            return ['status' => 200, 'data' => [
                ['admin_id' => EMAIL_TARGET, 'email' => $state['profile_email']],
                ['admin_id' => EMAIL_OTHER, 'email' => $state['other_profile_email']],
            ]];
        }
        if ($verb === 'GET' && $path === '/auth/v1/admin/users/' . EMAIL_TARGET) {
            return ['status' => 200, 'data' => [
                'id' => EMAIL_TARGET, 'email' => $state['auth_email'],
                'email_confirmed_at' => '2026-01-01T00:00:00Z',
            ]];
        }
        if ($verb === 'GET' && str_starts_with($path, '/auth/v1/admin/users?page=')) {
            return ['status' => 200, 'data' => ['users' => [
                ['id' => EMAIL_TARGET, 'email' => $state['auth_email']],
                ['id' => EMAIL_OTHER, 'email' => $state['other_auth_email']],
            ]]];
        }
        if ($verb === 'PATCH' && str_starts_with($path, '/rest/v1/admins?admin_id=eq.' . EMAIL_TARGET)) {
            if ($state['profile_update_status'] < 200 || $state['profile_update_status'] >= 300) {
                return ['status' => $state['profile_update_status'], 'data' => []];
            }
            $state['profile_email'] = $body['email'];
            return ['status' => $state['profile_update_status'], 'data' => []];
        }
        if ($verb === 'PUT' && $path === '/auth/v1/admin/users/' . EMAIL_TARGET) {
            emailAssert(array_keys($body) === ['email', 'email_confirm'], 'Auth update must contain only email and confirmation.');
            emailAssert($body['email_confirm'] === true, 'Controlled change must confirm the email.');
            if (($state['auth_update_status'] >= 200 && $state['auth_update_status'] < 300)
                || $state['auth_applied_after_error']) {
                $state['auth_email'] = $body['email'];
            }
            return ['status' => $state['auth_update_status'], 'data' => []];
        }
        if ($verb === 'POST' && $path === '/rest/v1/system_audit_logs') {
            $state['audit'][] = $body;
            return ['status' => $state['audit_status'], 'data' => []];
        }
        throw new RuntimeException('Unexpected transport call: ' . $verb . ' ' . $path);
    };
}

function emailChange(array &$state, ?string $jwt = null, string $email = 'new@example.invalid'): array
{
    return handleUpdateAdminEmailRequest('POST', 'Bearer ' . ($jwt ?? emailJwt()), json_encode([
        'adminId' => EMAIL_TARGET, 'email' => $email, 'confirmEmail' => true,
    ]), emailTransport($state));
}

$tests = [
    'valid email domains accepted and malformed addresses rejected' => static function (): void {
        foreach (['admin@gmail.com', 'user@outlook.com', 'person@yahoo.com',
            'codex-super-20260926@example.com', 'admin@plpasig.edu.ph'] as $email) {
            $state = emailState();
            emailAssert(emailChange($state, null, $email)['status'] === 200,
                'Valid administrator email should be accepted.');
        }
        foreach (['abc', 'user@', '@example.com'] as $email) {
            $state = emailState();
            emailAssert(emailChange($state, null, $email)['status'] === 400,
                'Malformed administrator email should be rejected.');
            emailAssert($state['calls'] === [], 'Malformed email must not contact Supabase.');
        }
    },
    'requires POST, valid input and explicit confirmation' => static function (): void {
        $state = emailState();
        $transport = emailTransport($state);
        emailAssert(handleUpdateAdminEmailRequest('GET', '', '', $transport)['status'] === 405, 'GET rejected.');
        emailAssert(handleUpdateAdminEmailRequest('POST', '', '{}', $transport)['status'] === 400, 'Invalid body rejected.');
        emailAssert($state['calls'] === [], 'Invalid requests must not contact Supabase.');
    },
    'requires active Super Admin AAL2' => static function (): void {
        foreach ([['actor_level' => 'admin'], ['actor_status' => 'suspended']] as $overrides) {
            $state = emailState($overrides);
            emailAssert(emailChange($state)['status'] === 403, 'Non-active Super Admin must be denied.');
            emailAssert($state['profile_email'] === 'old@example.invalid', 'Denial must not mutate.');
        }
        $state = emailState();
        emailAssert(emailChange($state, emailJwt('aal1'))['status'] === 403, 'AAL1 Super Admin denied.');
        $state = emailState();
        emailAssert(emailChange($state, 'expired')['status'] === 401, 'Expired bearer denied.');
        $state = emailState(['actor_factor' => false]);
        emailAssert(emailChange($state)['status'] === 403, 'Removed factor with stale AAL2 token denied.');
    },
    'updates existing UID and audit without credentials' => static function (): void {
        $state = emailState();
        $result = emailChange($state);
        emailAssert($result['status'] === 200 && $result['body']['success'] === true, 'Change succeeds.');
        emailAssert($state['auth_email'] === 'new@example.invalid'
            && $state['profile_email'] === 'new@example.invalid', 'Both emails synchronized.');
        $authCalls = array_values(array_filter($state['calls'], static fn ($call) => str_starts_with($call[1], '/auth/v1/admin/users/')
            && $call[0] !== 'GET'));
        emailAssert(count($authCalls) === 1 && $authCalls[0][0] === 'PUT', 'Existing Auth UID updated, never recreated.');
        emailAssert(count($state['audit']) === 1 && $state['audit'][0]['target_id'] === EMAIL_TARGET,
            'Audit identifies the same UID.');
        $audit = json_encode($state['audit'][0]);
        emailAssert(!str_contains($audit, 'new@example.invalid') && !str_contains($audit, 'old@example.invalid')
            && !str_contains($audit, 'Bearer'), 'Audit must contain no raw email or credentials.');
    },
    'rejects Auth and profile duplicates before writes' => static function (): void {
        foreach ([['other_auth_email' => 'NEW@example.invalid'],
            ['other_profile_email' => 'NEW@example.invalid']] as $overrides) {
            $state = emailState($overrides);
            emailAssert(emailChange($state)['status'] === 409, 'Duplicate denied.');
            emailAssert($state['auth_email'] === 'old@example.invalid'
                && $state['profile_email'] === 'old@example.invalid', 'Duplicate must not mutate.');
        }
    },
    'Auth rejection restores profile email' => static function (): void {
        $state = emailState(['auth_update_status' => 422]);
        emailAssert(emailChange($state)['status'] === 409, 'Auth conflict reported.');
        emailAssert($state['auth_email'] === 'old@example.invalid'
            && $state['profile_email'] === 'old@example.invalid', 'Compensation restores profile.');
    },
    'committed Auth change is not rolled back after transport error' => static function (): void {
        $state = emailState(['auth_update_status' => 500, 'auth_applied_after_error' => true]);
        $result = emailChange($state);
        emailAssert($result['status'] === 200 && $state['auth_email'] === 'new@example.invalid'
            && $state['profile_email'] === 'new@example.invalid',
            'Verified committed Auth change must leave both emails synchronized.');
    },
    'audit failure reports completed change clearly' => static function (): void {
        $state = emailState(['audit_status' => 500]);
        $result = emailChange($state);
        emailAssert($result['status'] === 502 && $result['body']['changed'] === true,
            'Operator must be told that the change completed despite audit failure.');
    },
    'self-change requires another usable Super Admin' => static function (): void {
        $profiles = static fn (string $verb, string $path): array => [
            'status' => 200, 'data' => [['admin_id' => EMAIL_ACTOR]],
        ];
        emailAssert(adminEmailHasRecoverySuper(EMAIL_ACTOR, $profiles) === false,
            'A lone Super Admin cannot self-change.');
        $usable = static function (string $verb, string $path): array {
            if (str_starts_with($path, '/rest/v1/admins?')) {
                return ['status' => 200, 'data' => [
                    ['admin_id' => EMAIL_ACTOR, 'login_locked' => false],
                    ['admin_id' => EMAIL_OTHER, 'login_locked' => false],
                ]];
            }
            if (str_ends_with($path, '/factors')) {
                return ['status' => 200, 'data' => [[
                    'factor_type' => 'totp', 'status' => 'verified',
                ]]];
            }
            return ['status' => 200, 'data' => [
                'id' => EMAIL_OTHER, 'email_confirmed_at' => '2026-01-01T00:00:00Z',
            ]];
        };
        emailAssert(adminEmailHasRecoverySuper(EMAIL_ACTOR, $usable) === true,
            'Confirmed, active, verified recovery account permits self-change.');
    },
];

foreach ($tests as $label => $test) {
    $test();
    echo "PASS: {$label}\n";
}
