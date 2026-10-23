import pg from 'pg';
import type { Pool } from 'pg';
import { REQUIRED_MIGRATIONS } from './db/migrate.js';

export function createDatabasePool(databaseUrl: string): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2_500,
    query_timeout: 3_000,
    application_name: 'courier-route',
  });
  pool.on('error', () => {
    console.error('Неочікувана помилка вільного з’єднання PostgreSQL; пул звільнив з’єднання.');
  });
  return pool;
}

export async function isDatabaseReady(pool: Pool): Promise<boolean> {
  try {
    // Referencing all table shapes catches absent tables even when a migration
    // record has been copied into an otherwise unprepared schema.
    const result = await pool.query<{ version: string }>(`
      WITH user_shape AS (
        SELECT id, username, normalized_username, password_hash, role, created_at
        FROM users LIMIT 0
      ), session_shape AS (
        SELECT token_hash, user_id, created_at, expires_at FROM sessions LIMIT 0
      ), job_shape AS (
        SELECT id, user_id, input, status, progress_stage, completed_iterations, total_iterations, progress_percent,
          created_at, updated_at, started_at, finished_at, cancel_requested_at, instance_id, claim_token,
          timeout_ms, lost_after, result, failure_reason, failure_message
        FROM jobs LIMIT 0
      ), executor_shape AS (
        SELECT instance_id, started_at, last_seen_at, expires_at, accepting_claims, busy, current_job_id
        FROM executor_registry LIMIT 0
      )
      SELECT version FROM schema_migrations
      WHERE version = ANY($1::text[])
        AND (SELECT COUNT(*) FROM user_shape) = 0
        AND (SELECT COUNT(*) FROM session_shape) = 0
        AND (SELECT COUNT(*) FROM job_shape) = 0
        AND (SELECT COUNT(*) FROM executor_shape) = 0
    `, [REQUIRED_MIGRATIONS]);
    const applied = new Set(result.rows.map((row) => row.version));
    return REQUIRED_MIGRATIONS.every((version) => applied.has(version));
  } catch {
    return false;
  }
}
