<?php
declare(strict_types=1);

require_once __DIR__ . '/../admin/admin-mfa-auth.php';
require_once __DIR__ . '/../admin/admin-password-policy.php';

/** User-scoped Auth update, after application policy and Admin authorization. */
function handleUpdateAdminPasswordRequest(string $method, string $authorization, string $rawBody,
    callable $request, callable $userRequest): array
{
    if ($method !== 'POST') return ['status' => 405, 'body' => ['success' => false, 'message' => 'Method not allowed. Use POST.']];
    $body = json_decode($rawBody, true);
    if (!is_array($body)) return ['status' => 400, 'body' => ['success' => false, 'message' => 'Invalid password request.']];
    $auth = verifiedAdminBearer($authorization, $request, false, true);
    if ($auth['status'] !== 200) return ['status' => $auth['status'], 'body' => ['success' => false, 'message' => $auth['message']]];
    $actor = $auth['actor'];
    if (empty($actor['email']) || empty($actor['admin_name'])) {
        return ['status' => 502, 'body' => ['success' => false, 'message' => 'Account details are unavailable.']];
    }
    if (!validAdminPassword($body['password'] ?? null, (string) ($actor['email'] ?? ''),
        (string) ($actor['admin_name'] ?? ''))) {
        return ['status' => 400, 'body' => ['success' => false, 'message' => ADMIN_PASSWORD_MESSAGE]];
    }
    preg_match('/^Bearer ([A-Za-z0-9._~-]+)$/i', trim($authorization), $match);
    try {
        $result = $userRequest('PUT', '/auth/v1/user', ['password' => $body['password']], $match[1]);
        if (($result['status'] ?? 0) < 200 || ($result['status'] ?? 0) >= 300) {
            $status = in_array($result['status'] ?? 0, [401, 403], true) ? 403 : 502;
            return ['status' => $status, 'body' => ['success' => false,
                'message' => $status === 403 ? 'Authenticator verification is required to change this password.' : 'Password update failed. Please try again.']];
        }
    } catch (Throwable $error) {
        return ['status' => 503, 'body' => ['success' => false, 'message' => 'Password update is temporarily unavailable.']];
    }
    return ['status' => 200, 'body' => ['success' => true, 'message' => 'Password updated.']];
}

if (PHP_SAPI !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Allow: POST');
    try {
        $development = loadLocalDevelopmentAdminLoginConfig();
        $server = $development['server'] ?? loadServerSupabaseConfig();
        $public = $development['public'] ?? loadPublicSupabaseConfig();
        $adminRequest = static fn (string $verb, string $path, ?array $body = null, ?string $token = null): array =>
            serverSupabaseRequest($server, $verb, $path, $body, $token);
        $userRequest = static fn (string $verb, string $path, ?array $body = null, ?string $token = null): array =>
            serverSupabaseRequest($public, $verb, $path, $body, $token);
        $result = handleUpdateAdminPasswordRequest($_SERVER['REQUEST_METHOD'] ?? '', adminBearerHeader(),
            (string) file_get_contents('php://input', false, null, 0, 8192), $adminRequest, $userRequest);
    } catch (Throwable $error) {
        $result = ['status' => 503, 'body' => ['success' => false, 'message' => 'Password update is temporarily unavailable.']];
    }
    http_response_code($result['status']);
    echo json_encode($result['body']);
}
