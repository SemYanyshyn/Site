import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

interface DatabaseTarget {
  hostname: string;
  port: number;
  database: string;
}

function parseTarget(value: string | undefined, label: string): DatabaseTarget {
  if (!value) throw new Error(`${label} обов’язковий для безпечного інтеграційного запуску.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} має містити коректний PostgreSQL URL.`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`${label} має явно задавати PostgreSQL host і database.`);
  }
  // pg accepts query parameters that can replace the visible URL destination.
  // Reject those instead of comparing a destination different from pg's target.
  const destinationOverrides = ['host', 'hostaddr', 'port', 'database', 'dbname', 'service'];
  if (destinationOverrides.some((key) => url.searchParams.has(key))) {
    throw new Error(`${label} не повинен перевизначати адресу БД через query parameters.`);
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${label} містить некоректне ім’я БД.`);
  }
  if (!database || database.includes('/') || database.includes('\0')) {
    throw new Error(`${label} має явно задавати одне ім’я БД.`);
  }
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} містить некоректний порт.`);
  }
  return { hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port, database };
}

function canonicalAddress(address: string): string {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  // localhost can resolve to IPv4 or IPv6 for the same local cluster.
  if (normalized === '::1' || /^127\./.test(normalized)) return 'loopback';
  return normalized;
}

async function addresses(hostname: string): Promise<Set<string>> {
  if (isIP(hostname)) return new Set([canonicalAddress(hostname)]);
  try {
    const found = await lookup(hostname, { all: true });
    if (!found.length) throw new Error('empty lookup');
    return new Set(found.map(({ address }) => canonicalAddress(address)));
  } catch {
    // An unresolved alias is not evidence that a destination is different.
    throw new Error('Не вдалося перевірити DNS-адресу БД; очищення заборонено.');
  }
}

export async function assertSafeTestDatabase(
  testDatabaseUrl: string | undefined,
  applicationDatabaseUrl: string | undefined,
): Promise<{ database: string }> {
  const target = parseTarget(testDatabaseUrl, 'TEST_DATABASE_URL');
  const application = parseTarget(applicationDatabaseUrl, 'DATABASE_URL');
  if (!/(?:^|_)test(?:_|$)/i.test(target.database)) {
    throw new Error('Ім’я тестової БД має містити окремий компонент test.');
  }
  const [testAddresses, applicationAddresses] = await Promise.all([
    addresses(target.hostname), addresses(application.hostname),
  ]);
  const sameHost = [...testAddresses].some((address) => applicationAddresses.has(address));
  if (sameHost && target.port === application.port && target.database === application.database) {
    throw new Error('TEST_DATABASE_URL указує на робочу БД; очищення заборонено.');
  }
  return { database: target.database };
}
