/** Assemble only reviewed WEB static assets. Vercel discovers root api/*.ts separately. */
import { readFile, writeFile, mkdir, cp, rm, stat, readdir } from 'node:fs/promises';
import { resolve, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSupabaseBuildConfig } from './supabase-build-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'EVENTMONITORING');
const out = join(root, 'dist', 'web');
const testConfig = process.argv.includes('--test-config');
validateSupabaseBuildConfig(process.env, { testConfig });
const url = testConfig ? 'https://example.invalid' : process.env.WEB_SUPABASE_URL || '';
const key = testConfig ? 'TEST_PUBLIC_ANON_KEY' : process.env.WEB_SUPABASE_ANON_KEY || '';
if (!/^https:\/\//.test(url) || !key) throw new Error('WEB_SUPABASE_URL and WEB_SUPABASE_ANON_KEY are required');
if (!testConfig) {
  let publicKey = key.startsWith('sb_publishable_');
  if (key.split('.').length === 3) {
    try { publicKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; }
    catch { publicKey = false; }
  }
  if (!publicKey) throw new Error('WEB_SUPABASE_ANON_KEY must be public');
}

const list = (await readFile(join(root, 'tools', 'web_allowlist.txt'), 'utf8'))
  .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const forbiddenExtensions = new Set(['.php', '.py', '.bat', '.npz', '.pth', '.onnx', '.xml', '.env', '.htaccess']);
const forbiddenPaths = /(?:^|\/)(?:students\/(?:takeAttendance|accountRegistration|manualAttendance|homepage)\.html|gate\/(?:entryExitScanner|qrAttendance)\.html|admin\/engine_log\.html|auth\/register\.(?:html|css|js))$/i;
await rm(out, { recursive: true, force: true });
const copied = new Set();
for (const name of list) {
  if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') ||
    forbiddenExtensions.has(extname(name).toLowerCase()) || name.endsWith('/.htaccess') || forbiddenPaths.test(name)) continue;
  if (copied.has(name)) throw new Error(`Duplicate allowlist entry: ${name}`);
  const from = resolve(source, name);
  const target = resolve(out, name);
  if (!from.startsWith(source + sep) || !target.startsWith(out + sep)) throw new Error(`Unsafe allowlist entry: ${name}`);
  if (!(await stat(from)).isFile()) throw new Error(`Missing allowlist entry: ${name}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(from, target);
  copied.add(name);
}
await mkdir(join(out, 'config'), { recursive: true });
await writeFile(join(out, 'config', '.env.js'),
  `const ENV = { SUPABASE_PROJECT_URL: ${JSON.stringify(url)}, SUPABASE_ANON_KEY: ${JSON.stringify(key)}, DEPLOYMENT_MODE: 'WEB' };\n`);

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    files.push(...(item.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}
const packaged = await walk(out);
const asset = /(?:src|href)=["']([^"']+)["']/gi;
for (const file of packaged) {
  const name = relative(out, file).replaceAll('\\', '/');
  if (forbiddenExtensions.has(extname(file).toLowerCase()) || name.endsWith('/.htaccess')) throw new Error(`Forbidden runtime file: ${name}`);
  if (!/\.(?:html|js|css)$/.test(file)) continue;
  const contents = await readFile(file, 'utf8');
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(contents) || /otpauth:\/\//i.test(contents)) throw new Error(`Server secret in ${name}`);
  for (const match of contents.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try { if (JSON.parse(Buffer.from(match[1], 'base64url').toString()).role === 'service_role') throw new Error(`Service key in ${name}`); }
    catch (error) { if (String(error).includes('Service key')) throw error; }
  }
  if (!file.endsWith('.html') || name.includes('/includes/')) continue;
  for (const [, ref] of contents.replace(/<!--.*?-->/gs, '').matchAll(asset)) {
    if (/^(?:https?:|data:|#|mailto:|javascript:|\/)/i.test(ref)) continue;
    const path = ref.split(/[?#]/, 1)[0];
    if (!path || path.endsWith('students/homepage.html')) continue; // Hidden LOCAL_GATE card.
    const target = resolve(dirname(file), path);
    if (!target.startsWith(out + sep)) throw new Error(`Unsafe asset reference: ${name}`);
    try { await stat(target); }
    catch { throw new Error(`Missing WEB asset: ${name} -> ${path}`); }
  }
  if (/https?:\/\/(?:127\.0\.0\.1|localhost):500[01]/.test(contents)) throw new Error(`Local engine URL in ${name}`);
}
for (const expected of ['index.html', 'auth/login.html', 'admin/usermanagement.html', 'portal/portal.html']) {
  if (!copied.has(expected)) throw new Error(`Missing required WEB page: ${expected}`);
}
console.log(`Built Vercel WEB static package: ${copied.size} allowlisted assets, no PHP or local engines`);
