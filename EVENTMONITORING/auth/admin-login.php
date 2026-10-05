<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/supabase-server.php';

/** Injectable transports keep password and lockout tests off the live service. */
function handleAdminLoginRequest(string $method, string $rawBody, callable $authRequest, callable $serviceRequest): array
{
    if ($method !== 'POST') return ['status' => 405, 'body' => ['success' => false, 'message' => 'Use POST.']];
    $body = json_decode($rawBody, true);
    $email = is_array($body) && is_string($body['email'] ?? null) ? strtolower(trim($body['email'])) : '';
    $password = is_array($body) ? ($body['password'] ?? null) : null;
    if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)
        || !is_string($password) || $password === '' || strlen($password) > 1024) {
        return ['status' => 400, 'body' => ['success' => false, 'message' => 'Enter a valid email and password.']];
    }
    try {
        $verified = $authRequest('POST', '/auth/v1/token?grant_type=password',
            ['email' => $email, 'password' => $password]);
        // GoTrue can send numeric code=400 alongside error_code=invalid_credentials.
        $invalid = ($verified['data']['error_code'] ?? $verified['data']['code'] ?? '') === 'invalid_credentials';
        if (($verified['status'] ?? 0) !== 200 && !$invalid) throw new RuntimeException('Auth unavailable');
        if ($invalid) {
            $recorded = $serviceRequest('POST', '/rest/v1/rpc/record_admin_password_failure', ['p_email' => $email]);
            if (($recorded['status'] ?? 0) !== 200 || !is_array($recorded['data'] ?? null)) {
                throw new RuntimeException('Attempt state unavailable');
            }
            $state = $recorded['data'];
            if (($state['known'] ?? false) !== true) $message = 'Invalid email or password.';
            elseif (($state['locked'] ?? false) === true) $message = 'This account has been locked after failed login attempts. Contact a Super Admin.';
            elseif (($state['recovery_protected'] ?? false) === true) $message = 'Invalid email or password. Contact another authorized administrator if you need help.';
            else {
                $remaining = (int) ($state['remaining'] ?? 0);
                $message = 'Invalid email or password. ' . $remaining . ' ' . ($remaining === 1 ? 'attempt' : 'attempts') . ' remaining.';
            }
            return ['status' => ($state['locked'] ?? false) ? 423 : 401,
                'body' => ['success' => false, 'message' => $message]];
        }
        $userId = $verified['data']['user']['id'] ?? null;
        $access = $verified['data']['access_token'] ?? null;
        $refresh = $verified['data']['refresh_token'] ?? null;
        if (!is_string($userId) || !preg_match('/^[0-9a-f-]{36}$/i', $userId)
            || !is_string($access) || !is_string($refresh) || $access === '' || $refresh === '') {
            throw new RuntimeException('Auth response incomplete');
        }
        $recorded = $serviceRequest('POST', '/rest/v1/rpc/record_admin_password_success', ['p_admin_id' => $userId]);
        if (($recorded['status'] ?? 0) !== 200 || !is_array($recorded['data'] ?? null)) {
            throw new RuntimeException('Attempt state unavailable');
        }
        $state = $recorded['data'];
        if (($state['allowed'] ?? false) !== true) {
            $locked = ($state['locked'] ?? false) === true;
            return ['status' => $locked ? 423 : 403, 'body' => ['success' => false,
                'message' => $locked ? 'This account is locked. Contact a Super Admin to unlock it.'
                    : 'This administrator account is not active.']];
        }
        return ['status' => 200, 'body' => ['success' => true, 'userId' => $userId,
            'access_token' => $access, 'refresh_token' => $refresh]];
    } catch (Throwable $error) {
        return ['status' => 503, 'body' => ['success' => false,
            'message' => 'Sign-in service is temporarily unavailable. Please try again.']];
    }
}

if (PHP_SAPI !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    try {
        $development = loadLocalDevelopmentAdminLoginConfig();
        $public = $development['public'] ?? loadPublicSupabaseConfig();
        $server = $development['server'] ?? loadServerSupabaseConfig();
        $result = handleAdminLoginRequest($_SERVER['REQUEST_METHOD'] ?? '', (string) file_get_contents('php://input'),
            static fn(string $verb, string $path, ?array $body = null): array => serverSupabaseRequest($public, $verb, $path, $body),
            static fn(string $verb, string $path, ?array $body = null): array => serverSupabaseRequest($server, $verb, $path, $body));
    } catch (Throwable $error) {
        $result = ['status' => 503, 'body' => ['success' => false,
            'message' => 'Sign-in service is temporarily unavailable. Please try again.']];
    }
    http_response_code($result['status']);
    echo json_encode($result['body']);
}
