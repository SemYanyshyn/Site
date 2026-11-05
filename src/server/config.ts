// Тут збираю налаштування HTTP-сервера зі змінних середовища й одразу перевіряю їх
// Не задаю пароль бази в коді, а читаю DATABASE_URL з локального середовища
// Origin для мене означає точне поєднання протоколу, хоста й порту сайту

export interface AppConfig {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  databaseUrl: string;
  appOrigins: ReadonlySet<string>;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  sessionCookieSameSite?: 'lax' | 'none';
}

// Перевіряю адресу PostgreSQL до підключення, включно з назвою бази й коректністю порту
// У помилку не вставляю сам URL, бо він може містити пароль
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

// Приймаю лише адресу origin без шляху, логіна, query чи wildcard
// Так дозволений сайт не можна непомітно підмінити схожою адресою
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

// Збираю єдиний перевірений об’єкт налаштувань для запуску сервера
// Окремо узгоджую Secure і SameSite cookie, бо від них залежить передавання сесії браузером
export function readConfig(): AppConfig {
  const host = process.env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('HOST має бути 127.0.0.1 для локального запуску або 0.0.0.0 для контейнера.');
  }
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
  const sessionCookieSameSite = process.env.SESSION_COOKIE_SAME_SITE ?? 'lax';
  if ((sessionCookieSameSite !== 'lax' && sessionCookieSameSite !== 'none') || (sessionCookieSameSite === 'none' && secureInput !== 'true')) {
    throw new Error('SESSION_COOKIE_SAME_SITE має бути lax або none; none потребує COOKIE_SECURE=true.');
  }
  return {
    sessionCookieSameSite,
    host, port: Number(portInput), databaseUrl, appOrigins,
    sessionTtlSeconds: Number(ttlInput), cookieSecure: secureInput === 'true',
  };
}
