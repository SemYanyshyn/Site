import { Pool } from 'pg';
import { readDatabaseUrl } from '../config.js';

let pool: Pool | undefined;
try {
  pool = new Pool({
    connectionString: readDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  pool.on('error', () => console.error('З’єднання перевірки БД перервано.'));
  const result = await pool.query<{ version: string; database: string; superuser: boolean }>(`
    SELECT version(), current_database() AS database, rolsuper AS superuser
    FROM pg_roles WHERE rolname = current_user
  `);
  const row = result.rows[0];
  if (!row || row.superuser) throw new Error('Застосунок не повинен працювати як superuser.');
  console.info(`БД доступна: ${row.database}; superuser=false; ${row.version.split(' on ')[0]}.`);
} catch {
  console.error('Перевірка БД не пройшла. Потрібне доступне підключення DATABASE_URL з роллю без superuser.');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
