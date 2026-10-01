<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/supabase-server.php';
require_once __DIR__ . '/admin-mfa-auth.php';

function handleAdminMfaFactors(string $method, string $authorization, string $rawBody, callable $request): array
{
    if ($method !== 'POST') return ['status' => 405, 'body' => ['message' => 'Use POST.']];
    $payload = json_decode($rawBody, true);
    $action = is_array($payload) ? ($payload['action'] ?? '') : '';
    $targetId = is_array($payload) ? ($payload['adminId'] ?? '') : '';
    if (!in_array($action, ['status', 'reset'], true) || !is_string($targetId) ||
        !preg_match('/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i', $targetId)) {
        return ['status' => 400, 'body' => ['message' => 'A valid action and administrator ID are required.']];
    }
    $targetId = strtolower($targetId);
    try {
        $auth = verifiedAdminBearer($authorization, $request);
        if ($auth['status'] !== 200) {
            return ['status' => $auth['status'], 'body' => ['message' => $auth['message']]];
        }
        $actorId = strtolower($auth['actor']['admin_id']);
        if ($action === 'reset' && $actorId === $targetId) {
            return ['status' => 403, 'body' => ['message' => 'You cannot reset your own authenticator. Contact another Super Admin.']];
        }
        $target = $request('GET', '/rest/v1/admins?admin_id=eq.' . $targetId . '&select=admin_id,admin_level,status&limit=1');
        if (($target['status'] ?? 0) !== 200 || !is_array($target['data'] ?? null)) {
            return ['status' => 502, 'body' => ['message' => 'Could not verify the target account.']];
        }
        if (count($target['data']) === 0) {
            return ['status' => 404, 'body' => ['message' => 'Administrator not found.']];
        }
        if ($action === 'reset' && ($target['data'][0]['admin_level'] ?? '') === 'super_admin'
            && ($target['data'][0]['status'] ?? '') === 'active') {
            // A stale AAL2 token alone is insufficient recovery assurance after
            // its own factor has been removed. The actor must still have one.
            $actorHasFactor = hasVerifiedTotpFactor($actorId, $request);
            if ($actorHasFactor !== true) {
                return ['status' => $actorHasFactor === null ? 502 : 409,
                    'body' => ['message' => 'Another active Super Admin with a verified authenticator is required.']];
            }
        }
        $factors = $request('GET', '/auth/v1/admin/users/' . $targetId . '/factors');
        if (($factors['status'] ?? 0) !== 200 || !is_array($factors['data'] ?? null)) {
            return ['status' => 502, 'body' => ['message' => 'Could not retrieve authenticator status.']];
        }
        $verified = array_values(array_filter($factors['data'], static function ($factor): bool {
            return is_array($factor) && ($factor['factor_type'] ?? '') === 'totp'
                && ($factor['status'] ?? '') === 'verified'
                && is_string($factor['id'] ?? null)
                && preg_match('/^[0-9a-f-]{36}$/i', $factor['id']) === 1;
        }));
        if ($action === 'status') {
            return ['status' => 200, 'body' => ['enabled' => count($verified) > 0]];
        }
        foreach ($verified as $factor) {
            $removed = $request('DELETE', '/auth/v1/admin/users/' . $targetId . '/factors/' . strtolower($factor['id']));
            if (($removed['status'] ?? 0) < 200 || ($removed['status'] ?? 0) >= 300) {
                return ['status' => 502, 'body' => ['message' => 'Authenticator reset could not be completed. Check the account before retrying.']];
            }
        }
        $audit = $request('POST', '/rest/v1/system_audit_logs', [
            'user_id' => $actorId,
            'action' => 'MFA_RESET',
            'module_name' => 'admin',
            'page_name' => 'usermanagement.html',
            'target_table' => 'admins',
            'target_id' => $targetId,
            'details' => ['method' => 'totp', 'removed_factor_count' => count($verified)]
        ]);
        if (($audit['status'] ?? 0) < 200 || ($audit['status'] ?? 0) >= 300) {
            return ['status' => 502, 'body' => ['message' => 'Authenticator reset finished, but its audit record failed. Contact the system administrator.']];
        }
        return ['status' => 200, 'body' => ['success' => true,
            'message' => count($verified) ? 'Authenticator reset. This administrator must set it up at next login.' : 'No verified authenticator was enrolled.']];
    } catch (Throwable $error) {
        return ['status' => 503, 'body' => ['message' => 'Authenticator service is unavailable.']];
    }
}

if (PHP_SAPI !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Allow: POST');
    $transport = static function (string $verb, string $path, ?array $body = null, ?string $token = null): array {
        static $config = null;
        $config = $config ?? loadServerSupabaseConfig();
        return serverSupabaseRequest($config, $verb, $path, $body, $token);
    };
    $result = handleAdminMfaFactors($_SERVER['REQUEST_METHOD'] ?? '', adminBearerHeader(),
        (string) file_get_contents('php://input', false, null, 0, 4096), $transport);
    http_response_code($result['status']);
    echo json_encode($result['body']);
}
