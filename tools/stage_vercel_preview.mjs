/** Create a minimal, reviewable Vercel upload tree from the current local source. */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.artifacts', 'vercel-preview-source');
const source = join(root, 'EVENTMONITORING');
const allowlist = (await readFile(join(root, 'tools', 'web_allowlist.txt'), 'utf8'))
  .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const rootFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vercel.json',
  'tools/build_vercel.mjs', 'tools/web_allowlist.txt',
];
const codeDirectories = ['api', 'server'];

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const name of allowlist) {
  if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
    throw new Error(`Unsafe WEB allowlist path: ${name}`);
  }
  // The shared allowlist also feeds the Apache build; match build_vercel.mjs exclusions.
  if (new Set(['.php', '.py', '.bat', '.npz', '.pth', '.onnx', '.xml', '.env', '.htaccess']).has(extname(name).toLowerCase()) ||
      /(?:^|\/)(?:students\/(?:takeAttendance|accountRegistration|manualAttendance|homepage)\.html|gate\/(?:entryExitScanner|qrAttendance)\.html|admin\/engine_log\.html|auth\/register\.(?:html|css|js))$/i.test(name)) continue;
  const from = resolve(source, name);
  const target = resolve(stage, 'EVENTMONITORING', name);
  if (!from.startsWith(source + sep) || !target.startsWith(stage + sep) || !(await stat(from)).isFile()) {
    throw new Error(`Invalid WEB asset: ${name}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(from, target);
}
for (const name of rootFiles) {
  const target = join(stage, name);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, name), target);
}
for (const name of codeDirectories) await cp(join(root, name), join(stage, name), { recursive: true });

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}
const files = (await walk(stage)).map(path => relative(stage, path).replaceAll('\\', '/'));
const forbidden = files.filter(name => /(?:^|\/)(?:\.env(?:\.|$)|camera_owner\.json$|node_modules\/|\.artifacts\/)|\.(?:php|py|bat|npz|pth|onnx)$/i.test(name));
if (forbidden.length) throw new Error(`Forbidden Vercel upload paths: ${forbidden.join(', ')}`);
console.log(`Staged ${files.length} reviewed source files for Vercel Preview at ${stage}`);
