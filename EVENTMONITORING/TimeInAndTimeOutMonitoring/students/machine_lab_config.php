<?php
header('Content-Type: application/json; charset=utf-8');

$configFile = __DIR__ . DIRECTORY_SEPARATOR . 'machine_lab_config.json';

function respond(array $payload, int $statusCode = 200): void {
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function readConfig(string $configFile): array {
    if (!file_exists($configFile)) {
        return [
            'configured' => false,
            'lab_id' => null,
            'lab_code' => null,
            'lab_name' => null,
            'building' => null,
            'saved_at' => null,
            'machine_name' => gethostname() ?: php_uname('n'),
        ];
    }

    $raw = @file_get_contents($configFile);
    $data = json_decode($raw ?: '', true);

    if (!is_array($data)) {
        return [
            'configured' => false,
            'error' => 'Invalid configuration file.',
            'machine_name' => gethostname() ?: php_uname('n'),
        ];
    }

    $data['configured'] = !empty($data['lab_id']) || !empty($data['lab_code']);
    $data['machine_name'] = $data['machine_name'] ?? (gethostname() ?: php_uname('n'));
    return $data;
}

function writeConfig(string $configFile, array $payload): array {
    $data = [
        'configured' => true,
        'lab_id' => isset($payload['lab_id']) ? trim((string)$payload['lab_id']) : null,
        'lab_code' => isset($payload['lab_code']) ? trim((string)$payload['lab_code']) : null,
        'lab_name' => isset($payload['lab_name']) ? trim((string)$payload['lab_name']) : null,
        'building' => isset($payload['building']) ? trim((string)$payload['building']) : null,
        'saved_at' => date('c'),
        'machine_name' => gethostname() ?: php_uname('n'),
    ];

    if ($data['lab_id'] === '' && $data['lab_code'] === '') {
        respond(['success' => false, 'message' => 'Missing laboratory assignment.'], 400);
    }

    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false || file_put_contents($configFile, $json . PHP_EOL, LOCK_EX) === false) {
        respond(['success' => false, 'message' => 'Unable to save laboratory assignment.'], 500);
    }

    return $data;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    respond(['success' => true, 'assignment' => readConfig($configFile)]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($input)) {
        $input = $_POST;
    }
    $assignment = writeConfig($configFile, $input);
    respond(['success' => true, 'message' => 'Laboratory assignment saved successfully.', 'assignment' => $assignment]);
}

respond(['success' => false, 'message' => 'Method not allowed.'], 405);