import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export const REQUIRED_MIGRATIONS = ['001_auth', '002_jobs', '003_executor_registry'] as const;
const migrationDirectory = new URL(
  import.meta.url.endsWith('.ts') ? '../../../migrations/' : '../../migrations/',
  import.meta.url,
);

export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [18024, 2]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const version of REQUIRED_MIGRATIONS) {
      const sql = await readFile(new URL(`${version}.sql`, migrationDirectory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1', [version],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) {
          throw new Error('Застосовану міграцію змінено. Додайте нову версію.');
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', [18024, 2]);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readDatabaseUrl } = await import('../config.js');
  let pool: Pool | undefined;
  try {
    const databaseUrl = readDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
    });
    pool.on('error', () => console.error('З’єднання міграцій із БД перервано.'));
    const applied = await migrate(pool);
    console.info(applied.length ? `Застосовано міграції: ${applied.join(', ')}.` : 'Усі міграції вже застосовані.');
  } catch {
    console.error('Не вдалося виконати міграції. Перевірте конфігурацію, доступність БД та незмінність застосованих SQL-файлів.');
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
