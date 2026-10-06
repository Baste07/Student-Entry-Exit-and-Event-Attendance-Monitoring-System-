<?php
declare(strict_types=1);

const ADMIN_PASSWORD_MESSAGE = 'Password must contain at least 12 characters, including uppercase and lowercase letters, a number, and a special character.';

function validAdminPassword($password, string $email, string $name): bool
{
    $length = is_string($password) ? preg_match_all('/./us', $password) : false;
    if ($length === false || $length < 12 || $length > 256
        || !preg_match('/[A-Z]/', $password) || !preg_match('/[a-z]/', $password)
        || !preg_match('/[0-9]/', $password) || !preg_match('/[^A-Za-z0-9\s]/', $password)) return false;
    $lower = strtolower($password);
    $address = strtolower(trim($email));
    if ($address !== '' && str_contains($lower, $address)) return false;
    $localPart = explode('@', $address)[0];
    if (strlen($localPart) >= 3 && str_contains($lower, $localPart)) return false;
    preg_match_all('/[a-z]{3,}/', strtolower($name), $words);
    foreach ($words[0] as $word) {
        if (str_contains($lower, $word)) return false;
    }
    return true;
}
