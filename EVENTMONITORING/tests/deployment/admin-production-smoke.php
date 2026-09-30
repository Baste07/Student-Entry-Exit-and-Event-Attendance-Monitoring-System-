<?php
declare(strict_types=1);

// Explicitly guarded production smoke test. Creates only synthetic admin accounts
// and removes them in finally. Never print passwords, service keys, or JWTs.
require_once __DIR__ . '/../../admin/create-admin.php';
require_once __DIR__ . '/../../admin/delete-admin.php';

if (getenv('CONFIRM_ADMIN_PRODUCTION_SMOKE') !== 'approved-20260927') {
    throw new RuntimeException('Production smoke-test guard is not set.');
}
$config = loadServerSupabaseConfig();
if ($config['url'] !== 'https://hgdqarcdfycdesavwrvq.supabase.co') {
    throw new RuntimeException('Production project reference mismatch.');
}
$request = static fn(string $verb, string $path, ?array $body = null, ?string $token = null): array =>
    serverSupabaseRequest($config, $verb, $path, $body, $token);
$expect = static function (bool $condition, string $description): void {
    if (!$condition) throw new RuntimeException($description);
    echo "PASS: {$description}\n";
};
$profile = static function (string $id) use ($request): ?array {
    $response = $request('GET', '/rest/v1/admins?admin_id=eq.' . $id . '&select=admin_id,email,admin_name,admin_level,status&limit=1');
    if ($response['status'] !== 200) throw new RuntimeException('Could not check a test admin profile.');
    return $response['data'][0] ?? null;
};
$login = static function (string $email, string $password) use ($request): array {
    $response = $request('POST', '/auth/v1/token?grant_type=password',
        ['email' => $email, 'password' => $password]);
    if ($response['status'] !== 200 || !is_string($response['data']['access_token'] ?? null)) {
        throw new RuntimeException('Synthetic admin password login failed.');
    }
    return $response['data'];
};
$prefix = 'codex-prod-smoke-' . bin2hex(random_bytes(6));
$superEmail = $prefix . '-super@example.com';
$normalEmail = $prefix . '-normal@example.com';
$targetEmail = $prefix . '-target@example.com';
$superPassword = bin2hex(random_bytes(24));
$normalPassword = bin2hex(random_bytes(24));
$targetPassword = bin2hex(random_bytes(24));
$tracked = [];
$baseline = $request('GET', '/rest/v1/admins?select=admin_id');
if ($baseline['status'] !== 200 || !is_array($baseline['data'])) {
    throw new RuntimeException('Could not capture baseline admin count.');
}
$baselineCount = count($baseline['data']);
$settingValue = static function (string $table, string $key) use ($request): ?string {
    $result = $request('GET', '/rest/v1/' . $table . '?key=eq.' . $key . '&select=value&limit=1');
    if ($result['status'] !== 200) throw new RuntimeException('Could not read a settings row.');
    return $result['data'][0]['value'] ?? null;
};
$originalMasterSms = $settingValue('system_settings', 'sms_enabled');
$originalAntiSpoof = $settingValue('system_settings', 'anti_spoof_enabled');
$originalGateSms = $settingValue('gate_settings', 'sms_enabled');
$originalEventSms = $settingValue('event_settings', 'sms_enabled');
if ($originalMasterSms !== 'false' || $originalAntiSpoof !== 'true'
    || $originalGateSms !== 'true' || $originalEventSms !== 'true') {
    throw new RuntimeException('Unexpected settings baseline; refusing production smoke test.');
}

try {
    $auth = $request('POST', '/auth/v1/admin/users', [
        'email' => $superEmail, 'password' => $superPassword, 'email_confirm' => true,
    ]);
    $superId = $auth['data']['id'] ?? null;
    if ($auth['status'] < 200 || $auth['status'] >= 300 || !is_string($superId)) {
        throw new RuntimeException('Could not create the synthetic Super Admin Auth user.');
    }
    $tracked[$superId] = $superEmail;
    $insert = $request('POST', '/rest/v1/admins', [
        'admin_id' => $superId, 'email' => $superEmail, 'password' => 'AUTH_MANAGED',
        'admin_name' => 'Codex Production Smoke Super', 'faculty' => 'TEST',
        'admin_level' => 'super_admin', 'status' => 'active',
    ]);
    if ($insert['status'] < 200 || $insert['status'] >= 300) {
        throw new RuntimeException('Could not create the synthetic Super Admin profile.');
    }
    $superLogin = $login($superEmail, $superPassword);
    $superToken = $superLogin['access_token'];
    $expect($superLogin['user']['id'] === $superId && $profile($superId)['admin_level'] === 'super_admin',
        'Super Admin password login and profile lookup');

    $normalBody = json_encode(['name' => 'Codex Production Smoke Normal',
        'email' => $normalEmail, 'faculty' => 'TEST', 'level' => 'admin',
        'password' => $normalPassword], JSON_THROW_ON_ERROR);
    $created = handleCreateAdminRequest('POST', 'Bearer ' . $superToken, $normalBody, $request);
    if ($created['status'] !== 201) throw new RuntimeException('Super Admin create endpoint failed.');
    $lookup = $request('GET', '/rest/v1/admins?email=eq.' . rawurlencode($normalEmail) . '&select=admin_id&limit=1');
    $normalId = $lookup['data'][0]['admin_id'] ?? null;
    if ($lookup['status'] !== 200 || !is_string($normalId)) {
        throw new RuntimeException('Created normal Admin profile missing.');
    }
    $tracked[$normalId] = $normalEmail;
    $normalLogin = $login($normalEmail, $normalPassword);
    $normalToken = $normalLogin['access_token'];
    $expect($normalLogin['user']['id'] === $normalId && $profile($normalId)['admin_level'] === 'admin',
        'Super Admin create endpoint and normal Admin password login');

    $normalView = $request('GET', '/rest/v1/admins?select=admin_id,admin_level,status', null, $normalToken);
    $superView = $request('GET', '/rest/v1/admins?select=admin_id,admin_level,status', null, $superToken);
    $expect($normalView['status'] === 200 && count($normalView['data'] ?? []) === 1
        && ($normalView['data'][0]['admin_id'] ?? null) === $normalId,
        'Normal Admin sees only their own profile');
    $expect($superView['status'] === 200 && count($superView['data'] ?? []) === $baselineCount + 2,
        'Super Admin lists all administrator profiles');

    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['admin_level' => 'super_admin'], $normalToken);
    $expect($profile($normalId)['admin_level'] === 'admin', 'Normal Admin cannot self-promote');
    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $superId,
        ['status' => 'suspended'], $normalToken);
    $expect($profile($superId)['status'] === 'active', 'Normal Admin cannot change another administrator');
    $expect($request('GET', '/rest/v1/admins?select=password', null, $normalToken)['status'] === 403,
        'Normal Admin cannot read legacy password');
    $expect($request('POST', '/rest/v1/admins', ['admin_id' => $normalId,
        'email' => 'blocked@example.com', 'password' => 'blocked'], $normalToken)['status'] === 403,
        'Normal Admin cannot insert an admin profile directly');
    $expect($request('DELETE', '/rest/v1/admins?admin_id=eq.' . $normalId, null, $normalToken)['status'] === 403,
        'Normal Admin cannot delete an admin profile directly');
    $expect(handleCreateAdminRequest('POST', 'Bearer ' . $normalToken,
        json_encode(['name' => 'Blocked', 'email' => $targetEmail,
            'faculty' => 'TEST', 'level' => 'admin', 'password' => $targetPassword], JSON_THROW_ON_ERROR),
        $request)['status'] === 403, 'Create endpoint rejects normal Admin');

    $edit = $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['admin_name' => 'Codex Production Smoke Edited'], $superToken);
    $expect($edit['status'] >= 200 && $edit['status'] < 300
        && $profile($normalId)['admin_name'] === 'Codex Production Smoke Edited',
        'Super Admin edits an administrator');
    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['status' => 'suspended'], $superToken);
    $expect($profile($normalId)['status'] === 'suspended', 'Super Admin suspends an administrator');
    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['status' => 'active'], $superToken);
    $expect($profile($normalId)['status'] === 'active', 'Super Admin reactivates an administrator');

    $targetBody = json_encode(['name' => 'Codex Production Smoke Target',
        'email' => $targetEmail, 'faculty' => 'TEST', 'level' => 'admin',
        'password' => $targetPassword], JSON_THROW_ON_ERROR);
    $createdTarget = handleCreateAdminRequest('POST', 'Bearer ' . $superToken, $targetBody, $request);
    if ($createdTarget['status'] !== 201) throw new RuntimeException('Super Admin target creation failed.');
    $target = $request('GET', '/rest/v1/admins?email=eq.' . rawurlencode($targetEmail) . '&select=admin_id&limit=1');
    $targetId = $target['data'][0]['admin_id'] ?? null;
    if (!is_string($targetId)) throw new RuntimeException('Created deletion target missing.');
    $tracked[$targetId] = $targetEmail;
    $deleteBody = json_encode(['adminId' => $targetId], JSON_THROW_ON_ERROR);
    $expect(handleDeleteAdminRequest('POST', 'Bearer ' . $normalToken, $deleteBody, $request)['status'] === 403,
        'Delete endpoint rejects normal Admin');
    $deleted = handleDeleteAdminRequest('POST', 'Bearer ' . $superToken, $deleteBody, $request);
    $authCheck = $request('GET', '/auth/v1/admin/users/' . $targetId);
    $expect($deleted['status'] === 200 && $profile($targetId) === null && $authCheck['status'] === 404,
        'Super Admin delete endpoint removes target profile and Auth user');

    $expect($request('GET', '/rest/v1/system_settings?select=key,value', null, $normalToken)['status'] === 200
        && $request('GET', '/rest/v1/gate_settings?select=key,value', null, $normalToken)['status'] === 200
        && $request('GET', '/rest/v1/event_settings?select=key,value', null, $normalToken)['status'] === 200,
        'Normal Admin can read all settings scopes');
    $request('PATCH', '/rest/v1/system_settings?key=eq.sms_enabled', ['value' => 'true'], $normalToken);
    $request('PATCH', '/rest/v1/system_settings?key=eq.anti_spoof_enabled', ['value' => 'false'], $normalToken);
    $expect($settingValue('system_settings', 'sms_enabled') === 'false'
        && $settingValue('system_settings', 'anti_spoof_enabled') === 'true',
        'Normal Admin cannot change Master SMS or Anti-Spoof Protection');

    $superSystem = $request('PATCH', '/rest/v1/system_settings?key=eq.sms_enabled',
        ['value' => 'false'], $superToken);
    $expect($superSystem['status'] >= 200 && $superSystem['status'] < 300
        && $settingValue('system_settings', 'sms_enabled') === 'false',
        'Super Admin can write System Settings without changing Master SMS');

    $request('PATCH', '/rest/v1/gate_settings?key=eq.sms_enabled', ['value' => 'false'], $normalToken);
    $expect($settingValue('gate_settings', 'sms_enabled') === 'false',
        'Active normal Admin can change Entry and Exit preference');
    $request('PATCH', '/rest/v1/gate_settings?key=eq.sms_enabled', ['value' => 'true'], $normalToken);
    $request('PATCH', '/rest/v1/event_settings?key=eq.sms_enabled', ['value' => 'false'], $normalToken);
    $expect($settingValue('gate_settings', 'sms_enabled') === 'true'
        && $settingValue('event_settings', 'sms_enabled') === 'false',
        'Active normal Admin can change Event preference');
    $request('PATCH', '/rest/v1/event_settings?key=eq.sms_enabled', ['value' => 'true'], $normalToken);

    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['status' => 'suspended'], $superToken);
    if ($profile($normalId)['status'] !== 'suspended') {
        throw new RuntimeException('Could not suspend test Admin for settings check.');
    }
    $request('PATCH', '/rest/v1/gate_settings?key=eq.sms_enabled', ['value' => 'false'], $normalToken);
    $request('PATCH', '/rest/v1/event_settings?key=eq.sms_enabled', ['value' => 'false'], $normalToken);
    $expect($settingValue('gate_settings', 'sms_enabled') === 'true'
        && $settingValue('event_settings', 'sms_enabled') === 'true',
        'Suspended Admin cannot change module settings');
    $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $normalId,
        ['status' => 'active'], $superToken);

    $badGrace = $request('PATCH', '/rest/v1/event_settings?key=eq.late_grace_minutes',
        ['value' => '100'], $normalToken);
    $badSystem = $request('PATCH', '/rest/v1/system_settings?key=eq.sms_enabled',
        ['value' => 'invalid'], $superToken);
    $expect($badGrace['status'] >= 400 && $settingValue('event_settings', 'late_grace_minutes') === '15'
        && $badSystem['status'] >= 400 && $settingValue('system_settings', 'sms_enabled') === 'false',
        'Invalid setting values are rejected');
    $expect($settingValue('system_settings', 'sms_enabled') === 'false'
        && $settingValue('gate_settings', 'sms_enabled') === 'true'
        && $settingValue('event_settings', 'sms_enabled') === 'true',
        'Master SMS OFF leaves both stored module preferences ON and effective SMS OFF');
} finally {
    $cleanupFailures = [];
    foreach ([['gate_settings', $originalGateSms], ['event_settings', $originalEventSms]] as [$table, $value]) {
        try {
            $restored = $request('PATCH', '/rest/v1/' . $table . '?key=eq.sms_enabled', ['value' => $value]);
            if ($restored['status'] < 200 || $restored['status'] >= 300) {
                throw new RuntimeException('Settings cleanup failed.');
            }
        } catch (Throwable $error) {
            $cleanupFailures[] = $table;
        }
    }
    foreach ($tracked as $id => $expectedEmail) {
        try {
            $row = $profile($id);
            if ($row !== null) {
                if ($row['email'] !== $expectedEmail || !str_starts_with($row['email'], $prefix)) {
                    throw new RuntimeException('Cleanup identity guard failed.');
                }
                $removed = $request('DELETE', '/rest/v1/admins?admin_id=eq.' . $id);
                if ($removed['status'] < 200 || $removed['status'] >= 300) {
                    throw new RuntimeException('Profile cleanup failed.');
                }
            }
            $authRow = $request('GET', '/auth/v1/admin/users/' . $id);
            if ($authRow['status'] === 200) {
                if (($authRow['data']['email'] ?? null) !== $expectedEmail) {
                    throw new RuntimeException('Auth cleanup identity guard failed.');
                }
                $removedAuth = $request('DELETE', '/auth/v1/admin/users/' . $id,
                    ['should_soft_delete' => false]);
                if ($removedAuth['status'] < 200 || $removedAuth['status'] >= 300) {
                    throw new RuntimeException('Auth cleanup failed.');
                }
            } elseif ($authRow['status'] !== 404) {
                throw new RuntimeException('Auth cleanup state unknown.');
            }
        } catch (Throwable $error) {
            $cleanupFailures[] = $id;
        }
    }
    if ($cleanupFailures) {
        throw new RuntimeException('Synthetic account cleanup needs manual review; ' . count($cleanupFailures) . ' account(s) remain.');
    }
    $after = $request('GET', '/rest/v1/admins?select=admin_id');
    $expect($after['status'] === 200 && count($after['data'] ?? []) === $baselineCount,
        'Synthetic accounts cleaned; original admin count restored');
}
