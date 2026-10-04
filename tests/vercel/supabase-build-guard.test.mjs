import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { validateSupabaseBuildConfig } from '../../tools/supabase-build-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const production = 'https://hgdqarcdfycdesavwrvq.supabase.co';
const development = 'https://ehyqvyglirirktfmdezq.supabase.co';
const valid = {
  VERCEL_ENV: 'production',
  WEB_SUPABASE_URL: production,
  SUPABASE_URL: production,
  WEB_SUPABASE_ANON_KEY: 'sb_publishable_test_only',
  SUPABASE_SERVICE_ROLE_KEY: 'server-test-value-not-real'
};

test('matching Production browser and server projects pass', () => {
  assert.doesNotThrow(() => validateSupabaseBuildConfig(valid));
});

for (const [name, changes] of [
  ['browser development and server production', { WEB_SUPABASE_URL: development }],
  ['browser production and server development', { SUPABASE_URL: development }],
  ['development project in Production', { WEB_SUPABASE_URL: development, SUPABASE_URL: development }],
  ['other mismatched project refs', { WEB_SUPABASE_URL: 'https://anotherproject.supabase.co' }],
  ['missing browser URL', { WEB_SUPABASE_URL: '' }],
  ['missing server URL', { SUPABASE_URL: '' }],
  ['missing browser key', { WEB_SUPABASE_ANON_KEY: '' }],
  ['missing server key', { SUPABASE_SERVICE_ROLE_KEY: '' }],
  ['non-Supabase browser origin', { WEB_SUPABASE_URL: 'https://example.com' }],
  ['insecure server URL', { SUPABASE_URL: 'http://hgdqarcdfycdesavwrvq.supabase.co' }]
]) {
  test(`${name} fails without printing configuration values`, () => {
    assert.throws(() => validateSupabaseBuildConfig({ ...valid, ...changes }), error => {
      assert.doesNotMatch(error.message, /https:|sb_publishable_|server-test-value|ehyqvyglirirktfmdezq/);
      return true;
    });
  });
}

test('Preview development project continues to pass', () => {
  assert.doesNotThrow(() => validateSupabaseBuildConfig({ ...valid,
    VERCEL_ENV: 'preview', WEB_SUPABASE_URL: development, SUPABASE_URL: development }));
});

test('offline test configuration remains available outside Production', () => {
  assert.doesNotThrow(() => validateSupabaseBuildConfig({ VERCEL_ENV: 'preview' }, { testConfig: true }));
  assert.throws(() => validateSupabaseBuildConfig({ VERCEL_ENV: 'production' }, { testConfig: true }));
});

test('actual Production build rejects a development browser project without exposing keys', () => {
  const result = spawnSync(process.execPath, ['tools/build_vercel.mjs'], {
    cwd: root, env: { ...process.env, ...valid, WEB_SUPABASE_URL: development }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr,
    /sb_publishable_test_only|server-test-value-not-real|ehyqvyglirirktfmdezq/);
});

test('successful Production build writes only the production project to browser config', () => {
  const result = spawnSync(process.execPath, ['tools/build_vercel.mjs'], {
    cwd: root, env: { ...process.env, ...valid }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, 'Production fixture build failed');
  const browserConfig = readFileSync(resolve(root, 'dist/web/config/.env.js'), 'utf8');
  assert.match(browserConfig, /hgdqarcdfycdesavwrvq/);
  assert.doesNotMatch(browserConfig, /ehyqvyglirirktfmdezq|SUPABASE_SERVICE_ROLE_KEY|server-test-value-not-real/);
});
