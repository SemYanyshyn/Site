export interface AppConfig {
  port: number;
  databaseUrl: string;
  appOrigins: ReadonlySet<string>;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
}

export function readDatabaseUrl(value: string | undefined, label = 'DATABASE_URL'): string {
  if (!value) throw new Error(`${label} необхідно налаштувати.`);
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || !url.username || !url.pathname || url.pathname === '/' ||
      url.hash || (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))
    ) throw new Error('invalid');
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    return value;
  } catch {
    throw new Error(`${label} має бути коректним PostgreSQL URL з користувачем, адресою та назвою БД.`);
  }
}

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*') ||
      url.pathname !== '/' || url.search || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readConfig(): AppConfig {
  const portInput = process.env.PORT ?? '3000';
  if (!/^\d+$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) {
    throw new Error('PORT має бути цілим числом від 1 до 65535.');
  }
  const databaseUrl = readDatabaseUrl(process.env.DATABASE_URL);
  const originsInput = process.env.APP_ORIGINS;
  if (!originsInput) throw new Error('APP_ORIGINS має містити явний список дозволених HTTP/HTTPS-походжень через кому.');
  const appOrigins = new Set<string>();
  for (const entry of originsInput.split(',')) {
    const origin = normalizeOrigin(entry.trim());
    if (!origin) throw new Error('APP_ORIGINS містить некоректне походження; шлях, облікові дані та "*" не дозволені.');
    appOrigins.add(origin);
  }
  const ttlInput = process.env.SESSION_TTL_SECONDS ?? '28800';
  if (!/^\d+$/.test(ttlInput) || Number(ttlInput) < 1 || Number(ttlInput) > 604800) {
    throw new Error('SESSION_TTL_SECONDS має бути цілим числом від 1 до 604800.');
  }
  const secureInput = process.env.COOKIE_SECURE ?? 'false';
  if (secureInput !== 'true' && secureInput !== 'false') {
    throw new Error('COOKIE_SECURE має бути true або false.');
  }
  return {
    port: Number(portInput), databaseUrl, appOrigins,
    sessionTtlSeconds: Number(ttlInput), cookieSecure: secureInput === 'true',
  };
}
