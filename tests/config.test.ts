import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrigin, readConfig, readDatabaseUrl } from '../src/server/config.js';

const configurationKeys = [
  'HOST', 'PORT', 'DATABASE_URL', 'APP_ORIGINS', 'SESSION_TTL_SECONDS', 'COOKIE_SECURE',
] as const;
const syntheticSecret = 'synthetic-secret-never-log';
const validDatabaseUrl = `postgresql://courier:${syntheticSecret}@127.0.0.1:55432/courier_route`;

function withEnvironment(overrides: Partial<Record<typeof configurationKeys[number], string | undefined>>, check: () => void): void {
  const previous = new Map(configurationKeys.map((key) => [key, process.env[key]]));
  const values = {
    HOST: '127.0.0.1', PORT: '3000', DATABASE_URL: validDatabaseUrl,
    APP_ORIGINS: 'http://127.0.0.1:5173,http://127.0.0.1:3000',
    SESSION_TTL_SECONDS: '28800', COOKIE_SECURE: 'false', ...overrides,
  };
  try {
    for (const key of configurationKeys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check();
  } finally {
    for (const key of configurationKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function rejectsSafely(check: () => unknown, setting: string): void {
  let failure: unknown;
  try { check(); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, 'Invalid startup configuration must fail explicitly.');
  assert.ok(failure.message.includes(setting), 'Startup error must identify the affected setting.');
  assert.ok(!failure.message.includes(syntheticSecret) && !failure.message.includes('postgresql://'),
    'Startup errors must never print credentials or a connection URL.');
}

test('database configuration requires a complete valid PostgreSQL URL and never echoes credentials', () => {
  for (const value of [
    undefined, '', 'not-a-url', `https://user:${syntheticSecret}@localhost/courier`,
    'postgresql://127.0.0.1/courier', 'postgresql://user@127.0.0.1/',
    'postgresql://user@/courier', 'postgresql://user@localhost:70000/courier',
    `postgresql://user:${syntheticSecret}@localhost/courier#fragment`,
    `postgresql://user:${syntheticSecret}%ZZ@localhost/courier`,
  ]) {
    rejectsSafely(() => readDatabaseUrl(value), 'DATABASE_URL');
  }
  assert.ok(readDatabaseUrl(validDatabaseUrl) === validDatabaseUrl, 'Valid configuration must preserve the connection string.');
  withEnvironment({ DATABASE_URL: undefined }, () => rejectsSafely(readConfig, 'DATABASE_URL'));
});

test('allowed Origins must be explicit HTTP/HTTPS origins without wildcards, paths or credentials', () => {
  for (const origin of [
    undefined, '', ' ', '*', 'null', 'http://*.example.com', 'ftp://example.com',
    'http://example.com/path', 'http://example.com/?query=1', 'http://example.com/#fragment',
    `http://user:${syntheticSecret}@example.com`, 'http://example.com,',
  ]) {
    withEnvironment({ APP_ORIGINS: origin }, () => rejectsSafely(readConfig, 'APP_ORIGINS'));
  }
  withEnvironment({ APP_ORIGINS: ' HTTPS://EXAMPLE.COM:443/ , http://localhost:5173/ ' }, () => {
    const config = readConfig();
    assert.ok(config.appOrigins.has('https://example.com'));
    assert.ok(config.appOrigins.has('http://localhost:5173'));
    assert.equal(config.appOrigins.size, 2);
    assert.ok(!config.appOrigins.has('https://example.com.attacker.invalid'), 'Origin matching must be exact.');
    assert.ok(!config.appOrigins.has('https://example.com:444'), 'A different port is a different origin.');
  });
});

test('Origin normalization keeps the browser origin and rejects non-origin inputs', () => {
  assert.equal(normalizeOrigin('HTTPS://EXAMPLE.COM:443/'), 'https://example.com');
  assert.equal(normalizeOrigin('http://EXAMPLE.COM:80'), 'http://example.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  for (const origin of ['null', '*', 'https://example.com/path', 'https://user@example.com', 'https://example.com?query']) {
    assert.ok(normalizeOrigin(origin) === null, 'An invalid Origin must not be normalized into an allowed one.');
  }
});

test('startup bounds ports and session lifetime and accepts only explicit cookie booleans', () => {
  for (const port of ['', '0', '65536', '-1', '3000.5', 'invalid']) {
    withEnvironment({ PORT: port }, () => rejectsSafely(readConfig, 'PORT'));
  }
  for (const ttl of ['', '0', '-1', '604801', '1.5', 'Infinity']) {
    withEnvironment({ SESSION_TTL_SECONDS: ttl }, () => rejectsSafely(readConfig, 'SESSION_TTL_SECONDS'));
  }
  for (const value of ['', 'TRUE', 'FALSE', '1', 'yes']) {
    withEnvironment({ COOKIE_SECURE: value }, () => rejectsSafely(readConfig, 'COOKIE_SECURE'));
  }
  for (const lifetime of [1, 604800]) {
    withEnvironment({ SESSION_TTL_SECONDS: String(lifetime), COOKIE_SECURE: 'true', PORT: '65535' }, () => {
      const config = readConfig();
      assert.equal(config.sessionTtlSeconds, lifetime);
      assert.equal(config.cookieSecure, true);
      assert.equal(config.port, 65535);
    });
  }
  withEnvironment({ PORT: undefined, SESSION_TTL_SECONDS: undefined, COOKIE_SECURE: undefined }, () => {
    const config = readConfig();
    assert.equal(config.port, 3000);
    assert.equal(config.sessionTtlSeconds, 28800);
    assert.equal(config.cookieSecure, false);
  });
});

test('the listen host defaults to loopback and exposes all interfaces only by explicit configuration', () => {
  withEnvironment({ HOST: undefined }, () => assert.equal(readConfig().host, '127.0.0.1'));
  for (const host of ['127.0.0.1', '0.0.0.0'] as const) {
    withEnvironment({ HOST: host }, () => assert.equal(readConfig().host, host));
  }
});

test('listen configuration rejects arbitrary hostnames, addresses and malformed input without echoing them', () => {
  for (const host of ['', ' ', 'localhost', '::', '::1', '192.168.1.2', '0.0.0.0:3000', ' 0.0.0.0', syntheticSecret]) {
    withEnvironment({ HOST: host }, () => rejectsSafely(readConfig, 'HOST'));
  }
});
