import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { readDatabaseUrl } from './config.js';

export interface AdminRoleArguments { username: string; role: 'user' | 'admin' }
export interface AdminRoleResult extends AdminRoleArguments { changed: boolean }

export function parseAdminRoleArguments(args: readonly string[]): AdminRoleArguments {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if ((key !== '--username' && key !== '--role') || !value || options.has(key)) {
      throw new Error('Вкажіть лише --username LOGIN --role admin|user, кожний параметр один раз.');
    }
    options.set(key, value);
  }
  const username = options.get('--username');
  const role = options.get('--role');
  if (!username || !/^[A-Za-z0-9_-]{3,32}$/.test(username) || (role !== 'admin' && role !== 'user')) {
    throw new Error('Логін має містити 3–32 літери ASCII, цифри, _ або -, роль — admin або user.');
  }
  return { username, role };
}

/** Operator-only entry point; it cannot create users or accept a database URL in argv. */
export async function changeUserRole(pool: Pool, input: AdminRoleArguments): Promise<AdminRoleResult | null> {
  // Validate callers as strictly as the CLI, before any SQL.
  const { username, role } = parseAdminRoleArguments(['--username', input.username, '--role', input.role]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    const actual = identity.rows[0];
    if (!actual || actual.rolsuper || actual.rolcreatedb || actual.rolcreaterole) {
      throw new Error('Для CLI потрібна окрема роль застосунку без адміністративних прав PostgreSQL.');
    }
    const existing = await client.query<{ username: string; role: 'user' | 'admin' }>(
      'SELECT username,role FROM users WHERE normalized_username=$1 FOR UPDATE', [username.toLowerCase()]);
    const user = existing.rows[0];
    if (!user) { await client.query('COMMIT'); return null; }
    if (user.role !== role) await client.query('UPDATE users SET role=$1 WHERE normalized_username=$2', [role, username.toLowerCase()]);
    await client.query('COMMIT');
    return { username: user.username, role, changed: user.role !== role };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the safe caller-level error. */ }
    throw error;
  } finally { client.release(); }
}

export async function runAdminRoleCli(args: readonly string[]): Promise<void> {
  let pool: Pool | undefined;
  try {
    const input = parseAdminRoleArguments(args);
    pool = new pg.Pool({ connectionString: readDatabaseUrl(process.env.DATABASE_URL), max: 1,
      connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 2500, application_name: 'courier-route-role-operator' });
    pool.on('error', () => {});
    const result = await changeUserRole(pool, input);
    if (!result) {
      console.error('Користувача з таким логіном не знайдено; роль не змінено.');
      process.exitCode = 1;
      return;
    }
    console.info(`Користувач ${result.username}: роль ${result.role}${result.changed ? ' призначено' : ' вже призначена'}.`);
  } catch {
    console.error('Не вдалося змінити роль. Вкажіть --username LOGIN --role admin|user; перевірте БД і права ролі застосунку.');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAdminRoleCli(process.argv.slice(2));
