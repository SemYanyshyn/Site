import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/server/auth/password.js';
import { validateCredentials } from '../src/shared/auth.js';

test('credentials share exact username and Unicode code point boundaries', () => {
  const password = '😀'.repeat(15);
  const valid = validateCredentials({ username: '  COURIER_1  ', password });
  assert.ok(valid.ok, 'Valid Unicode credentials must be accepted.');
  assert.ok(valid.value.username === 'courier_1', 'Username must be trimmed and normalized.');
  assert.ok(valid.value.password === password, 'Password must remain byte-for-byte unchanged.');
  for (const length of [15, 128]) {
    assert.ok(validateCredentials({ username: 'usr', password: '😀'.repeat(length) }).ok);
  }
  for (const length of [0, 14, 129]) {
    assert.ok(!validateCredentials({ username: 'usr', password: '😀'.repeat(length) }).ok);
  }
  for (const password of [`${'x'.repeat(15)}\ud800`, `${'x'.repeat(15)}\udc00`]) {
    assert.ok(!validateCredentials({ username: 'usr', password }).ok, 'Unpaired surrogates must not collapse to replacement characters.');
  }
  for (const username of ['ab', 'a'.repeat(33), 'кур’єр', 'user.name', 'a b', 'Kelvin']) {
    assert.ok(!validateCredentials({ username, password }).ok);
  }
  assert.ok(validateCredentials({ username: 'a'.repeat(32), password }).ok);
  assert.ok(validateCredentials({ username: 'usr', password: ' '.repeat(15) }).ok);
});

test('credentials reject unknown fields, admin role, wrong types and non-object bodies', () => {
  const password = 'перевірений тестовий пароль';
  for (const value of [
    null, [], 'text', {}, { username: 123, password },
    { username: 'usr', password: false }, { username: 'usr', password, role: 'admin' },
    { username: 'usr', password, extra: true },
  ]) {
    assert.ok(!validateCredentials(value).ok);
  }
});

test('scrypt uses versioned fixed parameters, independent random salts and 64-byte keys', async () => {
  const password = '  Навчальний пароль 😀  ';
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  const format = /^scrypt\$v1\$32768\$8\$3\$67108864\$[0-9a-f]{32}\$[0-9a-f]{128}$/;
  assert.ok(format.test(first), 'Stored scrypt format and costs must match the agreed version.');
  assert.ok(format.test(second), 'Every password hash must include its parameters.');
  assert.ok(first !== second, 'Independent salts must produce distinct stored hashes.');
  assert.ok(!first.includes(password), 'Stored representation must not contain plaintext.');
  assert.ok(await verifyPassword(password, first), 'The original password must verify.');
  assert.ok(!(await verifyPassword(password.trim(), first)), 'Password spaces must not be trimmed.');
  assert.ok(!(await verifyPassword(`${password}x`, first)), 'Passwords must not be truncated.');
  assert.ok(!(await verifyPassword(password.toUpperCase(), first)), 'Case must be preserved.');
});

test('scrypt treats distinct Unicode sequences as distinct and rejects corrupt encodings', async () => {
  const password = 'Перевірка café і довгого пароля';
  const encoded = await hashPassword(password);
  assert.ok(await verifyPassword(password, encoded));
  assert.ok(!(await verifyPassword(password.normalize('NFD'), encoded)), 'Unicode must not be normalized.');
  for (const malformed of [
    '', 'plaintext', encoded.replace('$v1$', '$v2$'), encoded.replace('$32768$', '$1$'),
    encoded.slice(0, -1), `${encoded}$extra`,
  ]) {
    assert.ok(!(await verifyPassword(password, malformed)), 'Corrupt hash must safely fail verification.');
  }
});
