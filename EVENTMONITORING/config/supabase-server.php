<?php
declare(strict_types=1);

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

function serverSupabaseRequest(array $config, string $method, string $path, ?array $body = null, ?string $userToken = null): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('Server HTTP client is unavailable.');
    }

    $handle = curl_init($config['url'] . $path);
    $headers = [
        'apikey: ' . $config['key'],
        'Authorization: Bearer ' . ($userToken ?? $config['key']),
        'Accept: application/json',
        'Content-Type: application/json',
    ];
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
