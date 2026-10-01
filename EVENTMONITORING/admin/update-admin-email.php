<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/supabase-server.php';
require_once __DIR__ . '/admin-mfa-auth.php';

function adminEmailResponse(int $status, string $message, bool $success = false, bool $changed = false): array
{
    return ['status' => $status, 'body' => [
        'success' => $success, 'changed' => $changed, 'message' => $message,
    ]];
}

function adminEmailSuccessful(array $result): bool
{
    return ($result['status'] ?? 0) >= 200 && ($result['status'] ?? 0) < 300;
}

/** Fail closed if either directory cannot be searched completely. */
function adminEmailTakenByAnother(string $email, string $targetId, callable $request): ?bool
{
    for ($offset = 0; $offset < 100000; $offset += 200) {
        $result = $request('GET', '/rest/v1/admins?select=admin_id,email&order=admin_id.asc&limit=200&offset=' . $offset);
        if (($result['status'] ?? 0) !== 200 || !is_array($result['data'] ?? null)) return null;
        foreach ($result['data'] as $profile) {
            if (is_array($profile) && strtolower((string) ($profile['email'] ?? '')) === $email
                && strtolower((string) ($profile['admin_id'] ?? '')) !== $targetId) return true;
        }
        if (count($result['data']) < 200) break;
        if ($offset === 99800) return null;
    }

    for ($page = 1; $page <= 500; $page++) {
        $result = $request('GET', '/auth/v1/admin/users?page=' . $page . '&per_page=50');
        $users = $result['data']['users'] ?? null;
        if (($result['status'] ?? 0) !== 200 || !is_array($users)) return null;
        foreach ($users as $user) {
            if (!is_array($user) || strtolower((string) ($user['id'] ?? '')) === $targetId) continue;
            foreach (['email', 'email_change', 'new_email'] as $field) {
                if (strtolower((string) ($user[$field] ?? '')) === $email) return true;
            }
        }
        if (count($users) < 50) return false;
    }
    return null;
}

/** A self-change must leave another usable recovery Super Admin. */
function adminEmailHasRecoverySuper(string $targetId, callable $request): ?bool
{
    $profiles = $request('GET', '/rest/v1/admins?select=admin_id&admin_level=eq.super_admin&status=eq.active');
    if (($profiles['status'] ?? 0) !== 200 || !is_array($profiles['data'] ?? null)) return null;
    foreach ($profiles['data'] as $profile) {
        $id = strtolower((string) ($profile['admin_id'] ?? ''));
        if ($id === '' || $id === $targetId) continue;
        $factor = hasVerifiedTotpFactor($id, $request);
        if ($factor === null) return null;
        if (!$factor) continue;
        $user = $request('GET', '/auth/v1/admin/users/' . $id);
        if (($user['status'] ?? 0) !== 200) return null;
        $auth = $user['data'] ?? null;
        if (!is_array($auth) || strtolower((string) ($auth['id'] ?? '')) !== $id) return null;
        $bannedUntil = (string) ($auth['banned_until'] ?? '');
        $bannedAt = $bannedUntil === '' ? null : strtotime($bannedUntil);
        if (!empty($auth['email_confirmed_at']) && empty($auth['deleted_at'])
            && ($bannedAt === null || ($bannedAt !== false && $bannedAt <= time()))) return true;
    }
    return false;
}

/** Admin API updateUserById operation, via its HTTP endpoint used by the PHP server. */
function adminEmailAuthUpdate(string $id, string $email, callable $request): array
{
    return $request('PUT', '/auth/v1/admin/users/' . $id, [
        'email' => $email,
        // Controlled Super Admin migration: do not leave a pending Auth email
        // while public.admins already contains the new address.
        'email_confirm' => true,
    ]);
}

function adminEmailProfileUpdate(string $id, string $email, callable $request): bool
{
    $updated = $request('PATCH', '/rest/v1/admins?admin_id=eq.' . $id,
        ['email' => $email, 'updated_at' => gmdate('c')]);
    if (!adminEmailSuccessful($updated)) return false;
    $read = $request('GET', '/rest/v1/admins?admin_id=eq.' . $id . '&select=admin_id,email&limit=1');
    return ($read['status'] ?? 0) === 200 && is_array($read['data'] ?? null)
        && count($read['data']) === 1
        && strtolower((string) ($read['data'][0]['email'] ?? '')) === $email;
}

/** Injectable transport supports both offline tests and development-project HTTP tests. */
function handleUpdateAdminEmailRequest(string $method, string $authorization, string $rawBody, callable $request): array
{
    if ($method !== 'POST') return adminEmailResponse(405, 'Method not allowed. Use POST.');
    $payload = json_decode($rawBody, true);
    $id = is_array($payload) ? ($payload['adminId'] ?? null) : null;
    $email = is_array($payload) ? ($payload['email'] ?? null) : null;
    if (!is_string($id) || !preg_match('/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i', $id)
        || !is_string($email) || !filter_var(trim($email), FILTER_VALIDATE_EMAIL)
        || strlen(trim($email)) > 254 || ($payload['confirmEmail'] ?? null) !== true) {
        return adminEmailResponse(400, 'Provide a valid administrator ID and email, and confirm that you verified the address.');
    }
    $id = strtolower($id);
    $email = strtolower(trim($email));
    $mutationStarted = false;

    try {
        $auth = verifiedAdminBearer($authorization, $request);
        if ($auth['status'] !== 200) return adminEmailResponse($auth['status'], $auth['message']);
        $actorId = strtolower((string) $auth['actor']['admin_id']);
        $actorHasFactor = hasVerifiedTotpFactor($actorId, $request);
        if ($actorHasFactor !== true) {
            return adminEmailResponse($actorHasFactor === null ? 502 : 403,
                'A verified authenticator is required for this administrator action.');
        }

        $profile = $request('GET', '/rest/v1/admins?admin_id=eq.' . $id . '&select=admin_id,email,admin_level,status&limit=1');
        if (($profile['status'] ?? 0) !== 200 || !is_array($profile['data'] ?? null)) {
            return adminEmailResponse(502, 'Could not verify the administrator profile.');
        }
        if (count($profile['data']) !== 1) return adminEmailResponse(404, 'Administrator profile not found.');
        $oldProfileEmail = (string) ($profile['data'][0]['email'] ?? '');
        if ($id === $actorId && ($profile['data'][0]['admin_level'] ?? '') === 'super_admin'
            && ($profile['data'][0]['status'] ?? '') === 'active') {
            $recovery = adminEmailHasRecoverySuper($id, $request);
            if ($recovery !== true) {
                return adminEmailResponse($recovery === null ? 502 : 409,
                    'Another active Super Admin with a verified authenticator is required before changing your own email.');
            }
        }

        $authUser = $request('GET', '/auth/v1/admin/users/' . $id);
        if (($authUser['status'] ?? 0) !== 200 || strtolower((string) ($authUser['data']['id'] ?? '')) !== $id) {
            return adminEmailResponse(409, 'The matching Auth account could not be verified.');
        }
        $oldAuthEmail = (string) ($authUser['data']['email'] ?? '');
        if ($oldAuthEmail === '' || $oldProfileEmail === '') {
            return adminEmailResponse(409, 'The current account email is missing. Resolve this account manually.');
        }
        if (strtolower($oldAuthEmail) === $email && strtolower($oldProfileEmail) === $email) {
            return adminEmailResponse(200, 'This administrator already uses that email.', true);
        }

        $taken = adminEmailTakenByAnother($email, $id, $request);
        if ($taken === null) return adminEmailResponse(502, 'Could not complete the duplicate-email check. No changes were made.');
        if ($taken) return adminEmailResponse(409, 'That email is already used by another account.');

        // PostgREST and Auth Admin are separate services: update the profile,
        // then compensate it if Auth rejects the change (including a race on
        // email uniqueness). Neither user passwords nor factors are touched.
        $mutationStarted = true;
        if (!adminEmailProfileUpdate($id, $email, $request)) {
            return adminEmailResponse(502, 'The admin profile update could not be verified. Check both records before retrying.', false, true);
        }
        try {
            $authUpdated = adminEmailAuthUpdate($id, $email, $request);
        } catch (Throwable $error) {
            $authUpdated = ['status' => 0];
        }
        try {
            $verified = $request('GET', '/auth/v1/admin/users/' . $id);
        } catch (Throwable $error) {
            $verified = ['status' => 0];
        }
        $verifiedEmail = strtolower((string) ($verified['data']['email'] ?? ''));
        $sameUid = ($verified['status'] ?? 0) === 200
            && strtolower((string) ($verified['data']['id'] ?? '')) === $id;
        if (!$sameUid || ($verifiedEmail !== $email && $verifiedEmail !== strtolower($oldAuthEmail))) {
            return adminEmailResponse(502, 'Auth result could not be verified. The email may have changed; inspect both records before retrying.', false, true);
        }
        // A transport error may occur after Auth committed the change. Trust
        // the subsequent UID/email read, not the original HTTP status alone.
        if ($verifiedEmail !== $email) {
            try {
                $restored = adminEmailProfileUpdate($id, $oldProfileEmail, $request);
            } catch (Throwable $error) {
                $restored = false;
            }
            if (!$restored) {
                return adminEmailResponse(502, 'Auth rejected the email, and profile recovery failed. Inspect both records before retrying.', false, true);
            }
            return adminEmailResponse(($authUpdated['status'] ?? 0) === 422 ? 409 : 502,
                'Auth did not accept the new email. The profile was restored; check whether the address is already registered.');
        }
        if (empty($verified['data']['email_confirmed_at'])) {
            return adminEmailResponse(502, 'Auth email changed but confirmation could not be verified. Inspect the account before retrying.', false, true);
        }

        $audit = $request('POST', '/rest/v1/system_audit_logs', [
            'user_id' => $actorId,
            'action' => 'ADMIN_EMAIL_CHANGED',
            'module_name' => 'admin',
            'page_name' => 'usermanagement.html',
            'target_table' => 'admins',
            'target_id' => $id,
            // Hashes permit later reconciliation without placing addresses,
            // tokens, passwords, or factor material in the audit details.
            'details' => [
                'old_auth_email_sha256' => hash('sha256', strtolower($oldAuthEmail)),
                'old_profile_email_sha256' => hash('sha256', strtolower($oldProfileEmail)),
                'new_email_sha256' => hash('sha256', $email),
                'administratively_confirmed' => true,
            ],
        ]);
        if (!adminEmailSuccessful($audit)) {
            return adminEmailResponse(502, 'Both emails changed, but the audit record failed. Contact the system administrator.', false, true);
        }
        return adminEmailResponse(200, 'Administrator email updated. Ask the account owner to sign out and sign in with the new address.', true, true);
    } catch (Throwable $error) {
        return adminEmailResponse(503, 'The account service is unavailable. Inspect both records before retrying.', false,
            $mutationStarted);
    }
}

if (PHP_SAPI !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Allow: POST');
    try {
        $config = loadServerSupabaseConfig();
        $expectedRef = trim((string) getenv('ADMIN_EMAIL_CHANGE_PROJECT_REF'));
        $host = strtolower((string) parse_url($config['url'], PHP_URL_HOST));
        // Explicit deployment switch. Development tests set the dev ref;
        // production remains disabled until separately approved/configured.
        if (getenv('ADMIN_EMAIL_CHANGE_ENABLED') !== '1'
            || $expectedRef === '' || $host !== strtolower($expectedRef) . '.supabase.co') {
            http_response_code(503);
            echo json_encode(['success' => false, 'message' => 'Administrator email change is not enabled for this project.']);
            exit;
        }
        $transport = static function (string $verb, string $path, ?array $body = null, ?string $token = null) use ($config): array {
            return serverSupabaseRequest($config, $verb, $path, $body, $token);
        };
        $result = handleUpdateAdminEmailRequest($_SERVER['REQUEST_METHOD'] ?? '', adminBearerHeader(),
            (string) file_get_contents('php://input', false, null, 0, 4096), $transport);
        http_response_code($result['status']);
        echo json_encode($result['body']);
    } catch (Throwable $error) {
        http_response_code(503);
        echo json_encode(['success' => false, 'message' => 'Administrator email change is unavailable.']);
    }
}
