import assert from 'node:assert/strict';
import { readFile, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { compile } from 'sass';
import { fileURLToPath } from 'node:url';

// Єдине джерело адреси кнопки; ні .env, ні код основного застосунку тут не читаються.
const source = new URL('./', import.meta.url);
const output = new URL('../dist/pages-entry/', import.meta.url);
const config = JSON.parse(await readFile(new URL('demo-url.json', source), 'utf8'));
let demo;
try {
  assert.deepEqual(Object.keys(config), ['demoUrl']);
  assert.equal(typeof config.demoUrl, 'string');
  demo = new URL(config.demoUrl);
  assert.ok(demo.protocol === 'https:' && !demo.username && !demo.password && demo.pathname === '/'
    && !demo.search && !demo.hash && !demo.hostname.includes('*') && demo.hostname !== 'localhost'
    && !demo.hostname.endsWith('.localhost') && !/^127\./u.test(demo.hostname) && demo.hostname !== '[::1]');
} catch { throw new Error('У landing/demo-url.json потрібен публічний HTTPS origin демо без credentials або інших параметрів.'); }

if (process.argv.includes('--verify-demo')) {
  const ready = await fetch(new URL('/api/ready', demo), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(ready.status, 200, 'Demo readiness failed; publication stopped.');
  assert.equal((await ready.json()).status, 'ready', 'Unexpected demo readiness response.');
  const response = await fetch(demo, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, 'Demo page is unavailable; publication stopped.');
  assert.match(await response.text(), /Courier Route/u, 'Unexpected demo page.');
}

const template = await readFile(new URL('index.html', source), 'utf8');
assert.equal(template.split('{{DEMO_URL}}').length, 2, 'Expected one link placeholder.');
const html = template.replace('{{DEMO_URL}}', demo.href);
assert.doesNotMatch(html, /<(?:form|input|script)\b/iu, 'Entry page must contain no auth form or application scripts.');
const css = compile(fileURLToPath(new URL('styles.scss', source)), { style: 'compressed', sourceMap: false }).css;
// Очищується тільки окремий каталог цієї сторінки, не dist/client або backend.
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await writeFile(new URL('index.html', output), html);
await writeFile(new URL('assets/styles.css', output), css);
assert.deepEqual((await readdir(output)).sort(), ['assets', 'index.html']);
assert.deepEqual(await readdir(new URL('assets/', output)), ['styles.css']);
console.log('Entry page built: only index.html and assets/styles.css in dist/pages-entry.');
