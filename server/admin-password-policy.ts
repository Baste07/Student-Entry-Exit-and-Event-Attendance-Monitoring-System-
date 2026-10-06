export const ADMIN_PASSWORD_MESSAGE = 'Password must contain at least 12 characters, including uppercase and lowercase letters, a number, and a special character.';

/** Admin-only policy; do not apply to professor/student Auth accounts. */
export function validAdminPassword(password: unknown, email: string, name: string): boolean {
  if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 256 ||
    !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9\s]/.test(password)) return false;

  const lower = password.toLowerCase();
  const address = email.trim().toLowerCase();
  if (address && lower.includes(address)) return false;
  const localPart = address.split('@')[0] || '';
  if (localPart.length >= 3 && lower.includes(localPart)) return false;
  const nameWords = name.toLowerCase().match(/[a-z]{3,}/g) || [];
  return !nameWords.some(word => lower.includes(word));
}
