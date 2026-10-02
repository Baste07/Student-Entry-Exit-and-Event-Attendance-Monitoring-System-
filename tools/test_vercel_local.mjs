/** Offline HTTP smoke: no PHP, Python, Flask, webcam, or real Supabase project. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'web');
const built = spawnSync(process.execPath, [join(root, 'tools', 'build_vercel.mjs'), '--test-config'], { stdio: 'inherit' });
if (built.status !== 0) throw new Error('WEB build failed');
const oldUrl = process.env.SUPABASE_URL;
const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (incoming, outgoing) => {
  try {
    const path = new URL(incoming.url || '/', 'http://localhost').pathname;
    if (/^\/api\/[a-z-]+$/.test(path)) {
      const handler = await import(pathToFileURL(join(root, '.artifacts', 'vercel-test', 'api', path.slice(5) + '.js')).href);
      const body = await new Promise(resolveBody => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolveBody(Buffer.concat(chunks)));
      });
      const request = new Request(`http://localhost${path}`, { method: incoming.method,
        headers: incoming.headers, body: incoming.method === 'GET' ? undefined : body });
      const response = await handler.default.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = resolve(output, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(output + sep) || !(await stat(file)).isFile()) throw new Error('Not found');
    outgoing.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    outgoing.end(await readFile(file));
  } catch { outgoing.writeHead(404); outgoing.end('Not found'); }
});
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ['/auth/login.html', '/auth/mfa.html', '/auth/reset-password.html', '/portal/portal.html',
    '/admin/usermanagement.html', '/EntryExitMonitoring/admin/settings.html',
    '/TimeInAndTimeOutMonitoring/admin/events.html']) {
    const result = await fetch(base + path);
    if (result.status !== 200) throw new Error(`WEB page unavailable: ${path}`);
  }
  for (const path of ['/admin/create-admin.php', '/TimeInAndTimeOutMonitoring/students/takeAttendance.html',
    '/EntryExitMonitoring/gate/entryExitScanner.html', '/config/supabase-server.php']) {
    const result = await fetch(base + path);
    if (result.status !== 404) throw new Error(`Local/PHP file exposed: ${path}`);
  }
  const result = await fetch(base + '/api/create-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (result.status !== 503) throw new Error(`Function did not fail closed without server credentials: ${result.status}`);
  console.log('Node-only WEB HTTP smoke passed: pages, API route, and PHP/local exclusions');
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  if (oldUrl !== undefined) process.env.SUPABASE_URL = oldUrl;
  if (oldKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
}
