<?php
declare(strict_types=1);

if (isset($_SERVER['SCRIPT_FILENAME'])
    && realpath((string) $_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../config/supabase-server.php';

/** The Auth API validates the bearer before any JWT claim is considered. */
function verifiedAdminBearer(string $authorization, callable $request, bool $superOnly = true): array
{
    if (!preg_match('/^Bearer ([A-Za-z0-9._~-]+)$/i', trim($authorization), $match)) {
        return ['status' => 401, 'message' => 'Please sign in again.', 'actor' => null];
    }
    $token = $match[1];
    $identity = $request('GET', '/auth/v1/user', null, $token);
    $id = $identity['data']['id'] ?? null;
    if (($identity['status'] ?? 0) !== 200 || !is_string($id) ||
        !preg_match('/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i', $id)) {
        return ['status' => 401, 'message' => 'Your session has expired.', 'actor' => null];
    }
    $parts = explode('.', $token);
    $claims = count($parts) === 3
        ? json_decode((string) base64_decode(strtr($parts[1], '-_', '+_'), true), true)
        : null;
    // Do not trust JSON from the caller. The same bearer was just validated by
    // Supabase Auth, and its signed claims must match the returned identity.
    if (!is_array($claims) || ($claims['sub'] ?? null) !== $id ||
        ($claims['role'] ?? null) !== 'authenticated' || ($claims['aal'] ?? null) !== 'aal2') {
        return ['status' => 403, 'message' => 'Authenticator verification is required.', 'actor' => null];
    }
    $actor = $request('GET', '/rest/v1/admins?admin_id=eq.' . strtolower($id)
        . '&select=admin_id,admin_level,status&limit=1');
    if (($actor['status'] ?? 0) !== 200 || !is_array($actor['data'] ?? null)) {
        return ['status' => 502, 'message' => 'Could not verify admin permissions.', 'actor' => null];
    }
    $profile = $actor['data'][0] ?? null;
    if (!$profile || ($profile['status'] ?? '') !== 'active' ||
        !in_array(($profile['admin_level'] ?? ''), $superOnly ? ['super_admin'] : ['admin', 'super_admin'], true)) {
        return ['status' => 403, 'message' => 'This administrator action is not allowed.', 'actor' => null];
    }
    return ['status' => 200, 'message' => '', 'actor' => $profile];
}

function adminBearerHeader(): string
{
    $value = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($value !== '') return $value;
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $header) {
            if (strcasecmp($name, 'Authorization') === 0) return (string) $header;
        }
    }
    return '';
}

/** Shared gate for browser-triggered PHP operations. No caller-supplied role or AAL is trusted. */
function adminEndpointAuthorization(string $method, array $allowedMethods, bool $superOnly = false,
    ?callable $request = null, ?string $authorization = null): array
{
    if (!in_array($method, $allowedMethods, true)) {
        return ['status' => 405, 'message' => 'Method not allowed.', 'actor' => null];
    }
    $request ??= static function (string $verb, string $path, ?array $body = null, ?string $token = null): array {
        static $config = null;
        $config ??= loadServerSupabaseConfig();
        return serverSupabaseRequest($config, $verb, $path, $body, $token);
    };
    return verifiedAdminBearer($authorization ?? adminBearerHeader(), $request, $superOnly);
}

function enforceAdminAal2Http(array $allowedMethods, bool $superOnly = false): array
{
    $result = adminEndpointAuthorization($_SERVER['REQUEST_METHOD'] ?? '', $allowedMethods, $superOnly);
    if ($result['status'] !== 200) {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        http_response_code($result['status']);
        echo json_encode(['success' => false, 'message' => $result['message']]);
        exit;
    }
    return $result['actor'];
}

/** Service-role Auth Admin API lookup; returns null when verification failed. */
function hasVerifiedTotpFactor(string $adminId, callable $request): ?bool
{
    $result = $request('GET', '/auth/v1/admin/users/' . rawurlencode($adminId) . '/factors');
    if (($result['status'] ?? 0) !== 200 || !is_array($result['data'] ?? null)) return null;
    foreach ($result['data'] as $factor) {
        if (is_array($factor) && ($factor['factor_type'] ?? '') === 'totp'
            && ($factor['status'] ?? '') === 'verified') return true;
    }
    return false;
}
