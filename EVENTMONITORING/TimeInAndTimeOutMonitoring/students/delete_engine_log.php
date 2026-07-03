<?php
header('Content-Type: application/json');

$xmlPath = __DIR__ . '/engine_log.xml';
if (!file_exists($xmlPath)) {
    echo json_encode(['ok' => false, 'error' => 'engine_log.xml not found']);
    exit(0);
}

$timestamp = isset($_POST['timestamp']) ? trim($_POST['timestamp']) : null;
$clearAll = isset($_POST['all']) && $_POST['all'] === '1';

libxml_use_internal_errors(true);
$dom = new DOMDocument();
$dom->preserveWhiteSpace = false;
$dom->formatOutput = true;
if (!$dom->load($xmlPath)) {
    echo json_encode(['ok' => false, 'error' => 'Failed to parse XML']);
    exit(0);
}

$xpath = new DOMXPath($dom);
$changed = false;

if ($clearAll) {
    $root = $dom->documentElement;
    // Remove all child Event nodes
    $events = $xpath->query('/*/*');
    foreach ($events as $e) {
        $root->removeChild($e);
        $changed = true;
    }
} else if ($timestamp) {
    // Try matching Event[@ts='...']
    $escaped = htmlspecialchars($timestamp, ENT_QUOTES | ENT_XML1);
    $query = "//Event[@ts=\"$escaped\"]";
    $entries = $xpath->query($query);

    if ($entries->length === 0) {
        // Try matching Field[@name='timestamp'] text node
        $q2 = "//Event[Field[@name='timestamp' and normalize-space(text())=\"$escaped\"]]";
        $entries = $xpath->query($q2);
    }

    foreach ($entries as $e) {
        $e->parentNode->removeChild($e);
        $changed = true;
    }
}

if (!$changed) {
    echo json_encode(['ok' => false, 'error' => 'No matching entries to remove']);
    exit(0);
}

// Atomic save
$tmp = $xmlPath . '.tmp';
if ($dom->save($tmp) === false) {
    echo json_encode(['ok' => false, 'error' => 'Failed to write temp file']);
    exit(0);
}

if (!rename($tmp, $xmlPath)) {
    // attempt copy then unlink
    if (!copy($tmp, $xmlPath)) {
        echo json_encode(['ok' => false, 'error' => 'Failed to replace original file']);
        exit(0);
    }
    @unlink($tmp);
}

echo json_encode(['ok' => true]);
