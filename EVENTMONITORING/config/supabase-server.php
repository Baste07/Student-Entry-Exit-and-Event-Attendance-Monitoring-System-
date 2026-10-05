<?php
declare(strict_types=1);

if (isset($_SERVER['SCRIPT_FILENAME'])
    && realpath((string) $_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    http_response_code(404);
    exit;
}

// Server-side only. Never return these settings to the browser.
function loadServerSupabaseConfig(): array
{
    $url = trim((string) getenv('SUPABASE_URL'));
    $key = trim((string) (getenv('SUPABASE_SERVICE_ROLE_KEY') ?: getenv('SUPABASE_KEY')));

    // Reuse the local credentials already used by the attendance services.
    if ($url === '' || $key === '') {
        $path = __DIR__ . '/../TimeInAndTimeOutMonitoring/students/.env';
        $settings = [];
        foreach (is_readable($path) ? file($path, FILE_IGNORE_NEW_LINES) : [] as $line) {
            if (preg_match('/^\s*(SUPABASE_URL|SUPABASE_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*(.*?)\s*$/', $line, $matches)) {
                $settings[$matches[1]] = trim($matches[2], " \t\n\r\0\x0B\"'");
            }
        }
        $url = $url !== '' ? $url : ($settings['SUPABASE_URL'] ?? '');
        $key = $key !== '' ? $key : ($settings['SUPABASE_SERVICE_ROLE_KEY'] ?? $settings['SUPABASE_KEY'] ?? '');
    }

    if (filter_var($url, FILTER_VALIDATE_URL) === false || strtolower((string) parse_url($url, PHP_URL_SCHEME)) !== 'https') {
        throw new RuntimeException('Server Supabase URL is not configured.');
    }

    $isSecret = strpos($key, 'sb_secret_') === 0;
    $parts = explode('.', $key);
    if (!$isSecret && count($parts) === 3) {
        $claims = json_decode((string) base64_decode(strtr($parts[1], '-_', '+/'), true), true);
        $isSecret = is_array($claims) && ($claims['role'] ?? '') === 'service_role';
    }
    if (!$isSecret) {
        throw new RuntimeException('Server Supabase service key is not configured.');
    }

    return ['url' => rtrim($url, '/'), 'key' => $key];
}

/** Public-key Auth client for password verification; never use the service-role key here. */
function loadPublicSupabaseConfig(): array
{
    $server = loadServerSupabaseConfig();
    $key = trim((string) (getenv('SUPABASE_ANON_KEY') ?: getenv('WEB_SUPABASE_ANON_KEY')));
    if ($key === '') {
        $path = __DIR__ . '/.env.js';
        $source = is_readable($path) ? (string) file_get_contents($path) : '';
        if (preg_match('/SUPABASE_PROJECT_URL\s*:\s*[\'\"]([^\'\"]+)[\'\"]/', $source, $urlMatch)
            && rtrim($urlMatch[1], '/') === $server['url']
            && preg_match('/SUPABASE_ANON_KEY\s*:\s*[\'\"]([^\'\"]+)[\'\"]/', $source, $keyMatch)) {
            $key = $keyMatch[1];
        }
    }
    $isPublic = str_starts_with($key, 'sb_publishable_');
    $parts = explode('.', $key);
    if (!$isPublic && count($parts) === 3) {
        $claims = json_decode((string) base64_decode(strtr($parts[1], '-_', '+/'), true), true);
        $isPublic = is_array($claims) && ($claims['role'] ?? '') === 'anon';
    }
    if (!$isPublic) throw new RuntimeException('Server Supabase public key is not configured.');
    return ['url' => $server['url'], 'key' => $key];
}

/** Use the ignored development credentials only when the local browser is also on Development. */
function loadLocalDevelopmentAdminLoginConfig(): ?array
{
    $browserPath = __DIR__ . '/.env.js';
    $browser = is_readable($browserPath) ? (string) file_get_contents($browserPath) : '';
    $developmentUrl = 'https://ehyqvyglirirktfmdezq.supabase.co';
    if (!preg_match('/[\'\"]?SUPABASE_PROJECT_URL[\'\"]?\s*:\s*[\'\"]([^\'\"]+)[\'\"]/', $browser, $match)
        || rtrim($match[1], '/') !== $developmentUrl) {
        return null;
    }
    if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
        throw new RuntimeException('Development Admin login is restricted to localhost.');
    }
    $path = dirname(__DIR__, 2) . '/.env.development.local';
    if (!is_readable($path)) throw new RuntimeException('Local Development environment is unavailable.');
    $values = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        if (preg_match('/^\s*(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|WEB_SUPABASE_ANON_KEY)\s*=\s*(.*?)\s*$/', $line, $entry)) {
            $values[$entry[1]] = trim($entry[2], " \t\n\r\0\x0B\"'");
        }
    }
    $url = rtrim($values['SUPABASE_URL'] ?? '', '/');
    $serverKey = $values['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    $publicKey = $values['WEB_SUPABASE_ANON_KEY'] ?? $values['SUPABASE_ANON_KEY'] ?? '';
    if ($url !== $developmentUrl || $serverKey === '' || $publicKey === '') {
        throw new RuntimeException('Local Development Supabase configuration is incomplete.');
    }
    if (!preg_match('/[\'\"]?SUPABASE_ANON_KEY[\'\"]?\s*:\s*[\'\"]([^\'\"]+)[\'\"]/', $browser, $browserKey)
        || $browserKey[1] !== $publicKey) {
        throw new RuntimeException('Local browser and server public keys differ.');
    }
    $serverClaims = explode('.', $serverKey);
    $publicClaims = explode('.', $publicKey);
    $serverPayload = count($serverClaims) === 3
        ? json_decode((string) base64_decode(strtr($serverClaims[1], '-_', '+/'), true), true) : null;
    $publicPayload = count($publicClaims) === 3
        ? json_decode((string) base64_decode(strtr($publicClaims[1], '-_', '+/'), true), true) : null;
    $serverRole = is_array($serverPayload) ? ($serverPayload['role'] ?? null) : null;
    $publicRole = is_array($publicPayload) ? ($publicPayload['role'] ?? null) : null;
    if (!(str_starts_with($serverKey, 'sb_secret_') || $serverRole === 'service_role')
        || !(str_starts_with($publicKey, 'sb_publishable_') || $publicRole === 'anon')) {
        throw new RuntimeException('Local Development Supabase key types are invalid.');
    }
    return ['server' => ['url' => $url, 'key' => $serverKey],
        'public' => ['url' => $url, 'key' => $publicKey]];
}

function serverSupabaseHeaders(array $config, ?string $userToken = null): array
{
    $headers = [
        'apikey: ' . $config['key'],
        'Accept: application/json',
        'Content-Type: application/json',
    ];
    // Publishable and secret keys are API keys, not JWTs. A signed-in user's
    // access token is still sent as the bearer when this request is user-scoped.
    if ($userToken !== null) {
        $headers[] = 'Authorization: Bearer ' . $userToken;
    } elseif (!str_starts_with($config['key'], 'sb_secret_')
        && !str_starts_with($config['key'], 'sb_publishable_')) {
        $headers[] = 'Authorization: Bearer ' . $config['key'];
    }
    return $headers;
}

function serverSupabaseRequest(array $config, string $method, string $path, ?array $body = null, ?string $userToken = null): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('Server HTTP client is unavailable.');
    }

    $handle = curl_init($config['url'] . $path);
    $headers = serverSupabaseHeaders($config, $userToken);
    curl_setopt_array($handle, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    if ($body !== null) {
        curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
    }

    $response = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);
    if ($response === false || $status === 0) {
        // Do not expose upstream diagnostics or credentials in the response.
        throw new RuntimeException('Could not contact the account service.');
    }

    return ['status' => $status, 'data' => json_decode($response, true)];
}
