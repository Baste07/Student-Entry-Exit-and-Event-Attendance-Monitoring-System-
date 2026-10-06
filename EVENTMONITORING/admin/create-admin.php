<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/supabase-server.php';
require_once __DIR__ . '/admin-mfa-auth.php';
require_once __DIR__ . '/admin-password-policy.php';

function createAdminResponse(int $status, string $message, bool $success = false): array
{
    return ['status' => $status, 'body' => ['success' => $success, 'message' => $message]];
}

/** The injectable transport lets tests cover authorization without live writes. */
function handleCreateAdminRequest(string $method, string $authorization, string $rawBody, callable $request): array
{
    if ($method !== 'POST') {
        return createAdminResponse(405, 'Method not allowed. Use POST.');
    }
    if (!preg_match('/^Bearer ([A-Za-z0-9._~-]+)$/i', trim($authorization), $matches)) {
        return createAdminResponse(401, 'Please sign in again before creating an admin.');
    }
    $token = $matches[1];
    $payload = json_decode($rawBody, true);
    if (!is_array($payload)) {
        return createAdminResponse(400, 'Invalid account details.');
    }
    $name = trim((string) ($payload['name'] ?? ''));
    $email = strtolower(trim((string) ($payload['email'] ?? '')));
    $faculty = trim((string) ($payload['faculty'] ?? ''));
    $password = $payload['password'] ?? null;
    $level = $payload['level'] ?? null;
    if ($name === '' || strlen($name) > 200 || $faculty === '' || strlen($faculty) > 200
        || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254
        || !in_array($level, ['admin', 'super_admin'], true)) {
        return createAdminResponse(400, 'Check the name, email, faculty, password, and admin level.');
    }
    if (!validAdminPassword($password, $email, $name)) {
        return createAdminResponse(400, ADMIN_PASSWORD_MESSAGE);
    }

    try {
        $authorizationResult = verifiedAdminBearer($authorization, $request);
        if ($authorizationResult['status'] !== 200) {
            return createAdminResponse($authorizationResult['status'], $authorizationResult['message']);
        }

        $existing = $request('GET', '/rest/v1/admins?email=eq.' . rawurlencode($email)
            . '&select=admin_id&limit=1');
        if ($existing['status'] !== 200 || !is_array($existing['data'])) {
            return createAdminResponse(502, 'Could not check for an existing account.');
        }
        if (count($existing['data']) > 0) {
            return createAdminResponse(409, 'An administrator with that email already exists.');
        }

        // Admin Auth creation must use the server key, never the browser session.
        $created = $request('POST', '/auth/v1/admin/users', [
            'email' => $email, 'password' => $password, 'email_confirm' => true,
        ]);
        $newId = $created['data']['id'] ?? null;
        if ($created['status'] < 200 || $created['status'] >= 300
            || !is_string($newId)
            || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $newId)) {
            return createAdminResponse(409, 'The sign-in account could not be created. Check whether the email is already registered.');
        }

        try {
            $inserted = $request('POST', '/rest/v1/admins', [
                'admin_id' => strtolower($newId), 'email' => $email,
                'admin_name' => $name, 'faculty' => $faculty,
                'password' => 'AUTH_MANAGED', // Legacy NOT NULL column; never store the actual password.
                'admin_level' => $level, 'status' => 'active',
            ]);
        } catch (Throwable $error) {
            $inserted = ['status' => 0];
        }
        if ($inserted['status'] < 200 || $inserted['status'] >= 300) {
            try {
                $rollback = $request('DELETE', '/auth/v1/admin/users/' . strtolower($newId),
                    ['should_soft_delete' => false]);
            } catch (Throwable $error) {
                $rollback = ['status' => 0];
            }
            if ($rollback['status'] < 200 || $rollback['status'] >= 300) {
                return createAdminResponse(502, 'Account setup failed and cleanup could not be confirmed. Contact the system administrator.');
            }
            return createAdminResponse(502, 'The admin profile could not be created. Please try again.');
        }
        return createAdminResponse(201, 'Administrator created. Google Authenticator setup will be required at first login.', true);
    } catch (Throwable $error) {
        return createAdminResponse(503, 'The account service is unavailable. Please try again.');
    }
}

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
    $transport = static function (string $verb, string $path, ?array $body = null, ?string $token = null): array {
        static $config = null;
        $config = $config ?? loadServerSupabaseConfig();
        return serverSupabaseRequest($config, $verb, $path, $body, $token);
    };
    $result = handleCreateAdminRequest(
        $_SERVER['REQUEST_METHOD'] ?? '', $authorization,
        (string) file_get_contents('php://input', false, null, 0, 8192), $transport
    );
    http_response_code($result['status']);
    echo json_encode($result['body']);
}
