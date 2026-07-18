<?php
declare(strict_types=1);

/**
 * ONE-TIME DIAGNOSTIC SCRIPT.
 * Drop this anywhere inside your XAMPP htdocs folder and open it in a browser,
 * e.g. http://localhost/find_mail_files.php
 *
 * It searches for mail_config.php, send_event_attendance_email.php, and
 * send_student_qr_email.php and prints their full paths so you know exactly
 * what relative path to put in require_once.
 *
 * Delete this file once you're done — it's just for locating things.
 */

header('Content-Type: text/plain; charset=utf-8');

// Adjust this if your htdocs root isn't the default XAMPP location.
$searchRoot = $_SERVER['DOCUMENT_ROOT'] ?: 'C:/xampp/htdocs';

$targets = [
    'mail_config.php',
    'send_event_attendance_email.php',
    'send-student-qr-email.php',
];

echo "Searching under: {$searchRoot}\n";
echo str_repeat('=', 60) . "\n\n";

function findFiles(string $root, array $targets): array
{
    $found = array_fill_keys($targets, []);

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($iterator as $fileInfo) {
        if (!$fileInfo->isFile()) {
            continue;
        }
        $name = $fileInfo->getFilename();
        if (in_array($name, $targets, true)) {
            $found[$name][] = $fileInfo->getPathname();
        }
    }

    return $found;
}

try {
    $results = findFiles($searchRoot, $targets);

    foreach ($results as $filename => $paths) {
        echo "{$filename}:\n";
        if (empty($paths)) {
            echo "  NOT FOUND\n\n";
            continue;
        }
        foreach ($paths as $path) {
            echo "  {$path}\n";
        }
        echo "\n";
    }

    echo str_repeat('=', 60) . "\n";
    echo "Tip: to require mail_config.php from inside send_student_qr_email.php,\n";
    echo "figure out the relative path between the two folders shown above,\n";
    echo "then use: require_once __DIR__ . '/relative/path/mail_config.php';\n";

} catch (Throwable $e) {
    echo "Error while scanning: " . $e->getMessage() . "\n";
    echo "If this is a permissions issue, try adjusting \$searchRoot manually\n";
    echo "to a narrower folder like your project's root directory.\n";
}