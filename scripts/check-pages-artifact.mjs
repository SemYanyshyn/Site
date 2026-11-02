import assert from 'node:assert/strict';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';

// This directory is deliberately narrower than dist (which also contains server code).
const root = resolve('dist/client');
const base = `${(process.env.PAGES_BASE_PATH ?? '/Site/').replace(/\/$/u, '')}/`;
const files = [];
async function inspect(directory) {
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry); const stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), 'Pages artifact must not contain symbolic links.');
    if (stat.isDirectory()) { await inspect(path); continue; }
    const name = relative(root, path);
    assert.match(name, /\.(?:html|css|js|png|svg|ico|webp|avif|woff2?)$/u, 'Unexpected file in client artifact.');
    assert.doesNotMatch(name, /(?:^|\/)(?:server|migrations|node_modules|\.env)(?:\/|$)/u);
    files.push(name);
  }
}
try {
await inspect(root);
assert.ok(files.includes('index.html'));
for (const name of files.filter((file) => /\.(?:html|css|js)$/u.test(file))) {
  const text = await readFile(resolve(root, name), 'utf8');
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'Server secrets must not appear in Pages output.');
  const urls = name.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/gu)].map((match) => match[1])
    : name.endsWith('.css') ? [...text.matchAll(/url\(["']?([^"')]+)["']?\)/gu)].map((match) => match[1]) : [];
  for (const url of urls) {
    if (/^(?:data:|#)/u.test(url)) continue;
    assert.ok(!/^(?:https?:)?\/\//u.test(url), 'Unexpected external frontend asset.');
    const clean = url.split(/[?#]/u)[0];
    if (clean.startsWith('/')) assert.ok(clean.startsWith(base), 'Asset path does not match the Pages base.');
    const target = clean.startsWith('/') ? clean.slice(base.length) : relative(root, resolve(root, dirname(name), clean));
    assert.ok(files.includes(target), 'A referenced frontend asset is missing.');
  }
}
console.log(`Pages client artifact verified: ${files.length} files, base ${base}, directory dist/client.`);

} catch { console.error('Pages client artifact validation failed: check resource paths, file types and absence of secrets.'); process.exitCode = 1; }
