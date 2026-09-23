<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/supabase-server.php';

function deleteAdminResponse(int $status, string $message, bool $success = false): array
{
    return ['status' => $status, 'body' => ['success' => $success, 'message' => $message]];
}

/** The injectable transport keeps authorization/deletion tests off the live database. */
function handleDeleteAdminRequest(string $method, string $authorization, string $rawBody, callable $request): array
{
    if ($method !== 'POST') {
        return deleteAdminResponse(405, 'Method not allowed. Use POST.');
    }
    if (!preg_match('/^Bearer ([A-Za-z0-9._~-]+)$/i', trim($authorization), $matches)) {
        return deleteAdminResponse(401, 'Please sign in again before deleting an admin.');
    }
    $token = $matches[1];
    $payload = json_decode($rawBody, true);
    $adminId = is_array($payload) ? ($payload['adminId'] ?? null) : null;
    if (!is_string($adminId) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $adminId)) {
        return deleteAdminResponse(400, 'A valid admin ID is required.');
    }
    $adminId = strtolower($adminId);
    $authDeleted = false;
    $deleteStarted = false;

    try {
        // Authenticate with Supabase itself; sessionStorage and posted roles are untrusted.
        $identity = $request('GET', '/auth/v1/user', null, $token);
        if ($identity['status'] !== 200 || !is_string($identity['data']['id'] ?? null)) {
            return deleteAdminResponse(401, 'Your session has expired. Please sign in again.');
        }
        $callerId = strtolower($identity['data']['id']);
        if (!preg_match('/^[0-9a-f-]{36}$/', $callerId)) {
            return deleteAdminResponse(401, 'Your session is invalid. Please sign in again.');
        }

        $caller = $request('GET', '/rest/v1/admins?admin_id=eq.' . $callerId . '&select=admin_id,admin_level,status&limit=1');
        if ($caller['status'] !== 200 || !is_array($caller['data'])) {
            return deleteAdminResponse(502, 'Could not verify your admin permissions. Please try again.');
        }
        $actor = $caller['data'][0] ?? null;
        if (!$actor || ($actor['admin_level'] ?? '') !== 'super_admin' || ($actor['status'] ?? '') !== 'active') {
            return deleteAdminResponse(403, 'Only active Super Admins can delete admin accounts.');
        }
        if ($callerId === $adminId) {
            return deleteAdminResponse(403, 'You cannot delete your own account.');
        }

        $profilePath = '/rest/v1/admins?admin_id=eq.' . $adminId;
        $target = $request('GET', $profilePath . '&select=admin_id&limit=1');
        if ($target['status'] !== 200 || !is_array($target['data'])) {
            return deleteAdminResponse(502, 'Could not load the admin account. Please try again.');
        }
        if (count($target['data']) === 0) {
            return deleteAdminResponse(404, 'This admin account no longer exists. Refresh the admin list.');
        }

        // Delete Auth first so a failed Auth deletion never leaves an active orphaned login.
        // ON DELETE CASCADE removes the profile in the same database transaction when configured.
        $deleteStarted = true;
        $deleted = $request('DELETE', '/auth/v1/admin/users/' . $adminId, ['should_soft_delete' => false]);
        $missingAuth = $deleted['status'] === 404
            && (($deleted['data']['code'] ?? $deleted['data']['error_code'] ?? '') === 'user_not_found');
        if (($deleted['status'] < 200 || $deleted['status'] >= 300) && !$missingAuth) {
            return deleteAdminResponse(409, 'The account could not be deleted. Linked records or owned files may need to be reassigned first. Please refresh the admin list before trying again.');
        }
        $authDeleted = true;

        // Also support installations without a cascading Auth/profile relationship.
        $remaining = $request('GET', $profilePath . '&select=admin_id&limit=1');
        if ($remaining['status'] !== 200 || !is_array($remaining['data'])) {
            return deleteAdminResponse(502, 'The sign-in account was removed, but profile cleanup could not be confirmed. Refresh and retry deleting this admin.');
        }
        if (count($remaining['data']) > 0) {
            $cleanup = $request('DELETE', $profilePath);
            if ($cleanup['status'] < 200 || $cleanup['status'] >= 300) {
                return deleteAdminResponse(409, 'The sign-in account was removed, but the admin profile still has linked records. Reassign those records, then retry deleting this admin.');
            }
            $remaining = $request('GET', $profilePath . '&select=admin_id&limit=1');
            if ($remaining['status'] !== 200 || !is_array($remaining['data']) || count($remaining['data']) !== 0) {
                return deleteAdminResponse(502, 'The sign-in account was removed, but profile cleanup could not be confirmed. Refresh and retry deleting this admin.');
            }
        }

        return deleteAdminResponse(200, 'Admin account deleted successfully.', true);
    } catch (Throwable $error) {
        if ($authDeleted) {
            return deleteAdminResponse(502, 'The sign-in account was removed, but profile cleanup could not be confirmed. Refresh and retry deleting this admin.');
        }
        if ($deleteStarted) {
            return deleteAdminResponse(502, 'Deletion could not be confirmed. Refresh the admin list before trying again.');
        }
        return deleteAdminResponse(503, 'The account service is unavailable. Please try again or check the server configuration.');
    }
}

// CLI imports are used only by the offline tests below; HTTP requests always run the handler.
if (PHP_SAPI !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Allow: POST');

    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($authorization === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $authorization = $value;
                break;
            }
        }
    }

    $transport = static function (string $method, string $path, ?array $body = null, ?string $token = null): array {
        static $config = null;
        $config = $config ?? loadServerSupabaseConfig();
        return serverSupabaseRequest($config, $method, $path, $body, $token);
    };
    $result = handleDeleteAdminRequest(
        $_SERVER['REQUEST_METHOD'] ?? '',
        $authorization,
        (string) file_get_contents('php://input', false, null, 0, 8192),
        $transport
    );
    http_response_code($result['status']);
    echo json_encode($result['body']);
}
