/** Scan deployable WEB source/output for credential literals. Prints file paths only. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = [
  'api', 'server', 'tests/vercel', 'tools/build_vercel.mjs', 'tools/test_vercel_local.mjs',
  'tools/check_web_secrets.mjs', 'package.json', 'package-lock.json', 'vercel.json',
  '.env.example', 'EVENTMONITORING/config/config.js',
  'EVENTMONITORING/admin/usermanagement.js',
  'EVENTMONITORING/TimeInAndTimeOutMonitoring/resc/js/sendQrCodes.js', 'dist/web'
];
async function files(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    output.push(...await files(join(path, entry.name)));
  }
  return output;
}
const problems = [];
let checked = 0;
for (const input of inputs) {
  let paths;
  try { paths = await files(join(root, input)); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const path of paths) {
    if (!/\.(?:js|mjs|ts|html|css|json|example)$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    checked++;
    const secretPrefix = ['sb', 'secret_'].join('_');
    const otpScheme = ['otpauth', '://'].join('');
    let found = source.includes(otpScheme) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source) ||
      new RegExp(`${secretPrefix}[A-Za-z0-9_-]{8,}`).test(source);
    for (const match of source.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      try {
        const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
        if (payload.role === 'service_role' || payload.aal === 'aal2') found = true;
      } catch { /* Not a parseable JWT. */ }
    }
    if (found) problems.push(relative(root, path));
  }
}
if (problems.length) {
  console.error(`Possible active credential literals in ${problems.length} files (paths only):`);
  for (const path of problems) console.error(path);
  process.exitCode = 1;
} else {
  console.log(`WEB source/output credential-literal scan passed (${checked} files; no values printed)`);
}
