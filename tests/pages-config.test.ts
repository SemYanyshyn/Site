import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
test('Vite keeps local production at root and publishes only the client under the repository/custom-domain path', async () => {
  const previous = process.env.PAGES_BASE_PATH;
  try {
    for (const [mode, path, expected] of [['production', '/Site/', '/'], ['pages', undefined, '/Site/'],
      ['pages', '/Site', '/Site/'], ['pages', '', '/'], ['pages', '/', '/']] as const) {
      if (path === undefined) delete process.env.PAGES_BASE_PATH; else process.env.PAGES_BASE_PATH = path;
      const config = await resolveConfig({ mode, logLevel: 'silent' }, 'build');
      assert.equal(config.base, expected); assert.equal(config.build.outDir, `${project}dist/client`);
      assert.equal(config.root, `${project}src/client`); assert.notEqual(config.build.outDir, `${project}dist`);
    }
    process.env.PAGES_BASE_PATH = 'https://attacker.invalid/';
    await assert.rejects(resolveConfig({ mode: 'pages', logLevel: 'silent' }, 'build'));
  } finally { if (previous === undefined) delete process.env.PAGES_BASE_PATH; else process.env.PAGES_BASE_PATH = previous; }
});

test('publication preflight refuses an unset, local or credential-bearing API before any network call', () => {
  for (const base of ['', 'https://localhost:8443', 'https://user:private-sentinel@example.test']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-pages-config.mjs'], {
      cwd: project, env: { ...process.env, VITE_API_BASE_URL: base, PAGES_DEPLOYMENT_READY: 'true', PAGES_URL: 'https://semyanyshyn.github.io/Site/' }, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-sentinel/u);
  }
  const blocked = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-pages-config.mjs'], {
    cwd: project, env: { ...process.env, VITE_API_BASE_URL: 'https://unavailable.example.invalid', PAGES_DEPLOYMENT_READY: 'false' }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /public backend/u);
});
