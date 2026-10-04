/** Read-only credential preflight. Never prints key values or upstream response bodies. */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ref = 'ehyqvyglirirktfmdezq';
const productionRef = 'hgdqarcdfycdesavwrvq';
const devUrl = `https://${ref}.supabase.co`;
const file = new URL('../../.env.development.local', import.meta.url);
const contents = readFileSync(file, 'utf8');
if (contents.includes(productionRef)) throw new Error('Production project reference found in development configuration');
process.loadEnvFile(file);
if (process.env.SUPABASE_URL !== devUrl) throw new Error('Development Supabase URL does not match the approved project');

function keyRole(key, expected) {
  if (!key || key.length < 20 || /replace|placeholder|masked|\*{4}/i.test(key)) {
    throw new Error(`${expected} key is missing or masked`);
  }
  if (key.startsWith(expected === 'anon' ? 'sb_publishable_' : 'sb_secret_')) return;
  const parts = key.split('.');
  if (parts.length !== 3) throw new Error(`${expected} key has an unrecognized format`);
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new Error(`${expected} key is not a valid JWT`); }
  if (claims.role !== expected || (claims.ref && claims.ref !== ref)) {
    throw new Error(`${expected} key has the wrong role or project`);
  }
}
const anon = process.env.SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
keyRole(anon, 'anon');
keyRole(service, 'service_role');
if (anon === service) throw new Error('Public and server keys must differ');

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const trackedAndNew = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
function scanFile(path) {
  const source = readFileSync(path);
  if (source.includes(Buffer.from(service))) {
    throw new Error(`Server secret found in deployable source or browser output: ${relative(root, path)}`);
  }
}
for (const name of trackedAndNew) {
  if (/\.(?:js|mjs|cjs|ts|json|html|css|php|md|txt|example)$/.test(name)) scanFile(join(root, name));
}
function scanTree(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) scanTree(child);
    else scanFile(child);
  }
}
scanTree(join(root, 'dist', 'web'));

const settings = await fetch(`${devUrl}/auth/v1/settings`, { headers: { apikey: anon } });
if (!settings.ok) throw new Error(`Development public key rejected (HTTP ${settings.status})`);
const client = createClient(devUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
const users = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
if (users.error) throw new Error(`Development server key rejected (HTTP ${users.error.status ?? 'unknown'})`);
const schoolYear = await client.from('school_years').select('id').eq('is_active', true).limit(1);
const section = await client.from('sections').select('section_id').limit(1);
if (schoolYear.error || section.error) throw new Error('Development student-fixture reference lookup failed');
console.log(`Development credential preflight passed for ${ref}; key values were not printed`);
console.log(`Synthetic QR student prerequisites: active school year ${Boolean(schoolYear.data?.length)}, section ${Boolean(section.data?.length)}`);
const schemaResponse = await fetch(`${devUrl}/rest/v1/`, { headers: {
  apikey: service, Authorization: `Bearer ${service}`, Accept: 'application/openapi+json'
} });
if (schemaResponse.ok) {
  const schema = await schemaResponse.json();
  const required = schema.definitions?.students?.required || [];
  console.log(`Development students schema required columns: ${required.join(', ') || 'not listed'}`);
} else {
  console.log(`Development OpenAPI schema unavailable (HTTP ${schemaResponse.status})`);
}
