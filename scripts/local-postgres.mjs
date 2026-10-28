import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Pool } from "pg";

const project = fileURLToPath(new URL("../", import.meta.url));
const directory = join(project, ".local", "postgres");
const data = join(directory, "data");
const socket = join(directory, "socket");
const log = join(directory, "server.log");
const envPath = join(project, ".env");
const port = 55432;
const admin = "courier_local_admin";
const role = "courier_route";
const databases = ["courier_route", "courier_route_test"];
const command = process.argv[2];

function findBinaries() {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/Applications/Postgres.app/Contents/Versions/18/bin",
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ].filter(Boolean);
  const found = candidates.find(
    (candidate) =>
      existsSync(join(candidate, "pg_ctl")) &&
      existsSync(join(candidate, "initdb")),
  );
  if (!found)
    throw new Error(
      "Не знайдено PostgreSQL 18. Вкажіть PG_BIN_DIR з initdb і pg_ctl.",
    );
  return found;
}

function execute(binary, args, options = {}) {
  return spawnSync(join(findBinaries(), binary), args, {
    cwd: project,
    encoding: "utf8",
    ...options,
  });
}

function isRunning() {
  return (
    existsSync(join(data, "PG_VERSION")) &&
    execute("pg_ctl", ["-D", data, "status"]).status === 0
  );
}

function start() {
  if (!existsSync(join(data, "PG_VERSION")))
    throw new Error("Спочатку виконайте npm run db:setup.");
  if (!isRunning()) {
    const result = execute("pg_ctl", [
      "-D",
      data,
      "-l",
      log,
      "-w",
      "-t",
      "15",
      "start",
    ]);
    if (result.status !== 0)
      throw new Error(
        "Не вдалося запустити окремий PostgreSQL. Перевірте вільний порт 55432 та локальний журнал .local/postgres/server.log.",
      );
  }
  console.info(`PostgreSQL проєкту працює на 127.0.0.1:${port}.`);
}

async function setup() {
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(join(data, "PG_VERSION"))) {
    const result = execute("initdb", [
      "-D",
      data,
      "-U",
      admin,
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    if (result.status !== 0)
      throw new Error(
        "Не вдалося ініціалізувати окремий кластер PostgreSQL. Наявні дані не змінювалися.",
      );
    writeFileSync(
      join(data, "postgresql.auto.conf"),
      [
        "listen_addresses = '127.0.0.1'",
        `port = ${port}`,
        `unix_socket_directories = '${socket.replaceAll("'", "''")}'`,
        "unix_socket_permissions = 0700",
        "password_encryption = 'scram-sha-256'",
        "log_statement = 'none'",
        "log_min_error_statement = 'panic'",
        "log_parameter_max_length_on_error = 0",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  start();

  if (!existsSync(envPath)) {
    const password = randomBytes(32).toString("hex");
    const lines = [
      "PORT=3000",
      `DATABASE_URL=postgresql://${role}:${password}@127.0.0.1:${port}/${databases[0]}`,
      `TEST_DATABASE_URL=postgresql://${role}:${password}@127.0.0.1:${port}/${databases[1]}`,
      "APP_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:3000",
      "SESSION_TTL_SECONDS=28800",
      "COOKIE_SECURE=false",
      "",
    ];
    writeFileSync(envPath, lines.join("\n"), { mode: 0o600, flag: "wx" });
  }
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const appUrl = new URL(env.DATABASE_URL ?? "");
  const testUrl = new URL(env.TEST_DATABASE_URL ?? "");
  for (const [index, url] of [appUrl, testUrl].entries()) {
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== String(port) ||
      url.pathname !== `/${databases[index]}` ||
      url.username !== role ||
      !url.password ||
      url.password !== appUrl.password
    ) {
      throw new Error(
        "Наявний .env не належить окремому локальному кластеру проєкту; його не перезаписано. Використайте власне підключення або збережіть .env окремо перед початковим db:setup.",
      );
    }
  }
  const pool = new Pool({
    host: socket,
    port,
    user: admin,
    database: "postgres",
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
  });
  pool.on("error", () =>
    console.error("Адміністративне з’єднання локального кластера перервано."),
  );
  try {
    const existing = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [role],
    );
    const verb = existing.rowCount ? "ALTER" : "CREATE";
    const formatted = await pool.query(
      `SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text) AS statement`,
      [role, decodeURIComponent(appUrl.password)],
    );
    await pool.query(formatted.rows[0].statement);
    for (const name of databases) {
      const previous = await pool.query(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
        [name],
      );
      if (previous.rowCount && previous.rows[0].owner !== role)
        throw new Error(
          "База з потрібним ім’ям уже належить іншій ролі; її не змінено.",
        );
      if (!previous.rowCount)
        await pool.query(`CREATE DATABASE ${name} OWNER ${role}`);
    }
  } finally {
    await pool.end();
  }
  console.info(
    "Окрему роль без superuser і дві БД підготовлено. Параметри збережено лише в ігнорованому .env. Дані зберігаються між перезапусками.",
  );
}

try {
  if (command === "setup") await setup();
  else if (command === "start") start();
  else if (command === "stop") {
    if (
      isRunning() &&
      execute("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"])
        .status !== 0
    )
      throw new Error("Не вдалося зупинити PostgreSQL проєкту.");
    console.info("PostgreSQL проєкту зупинено; дані збережено.");
  } else if (command === "status") {
    const running = isRunning();
    console.info(
      running
        ? `PostgreSQL проєкту працює на 127.0.0.1:${port}.`
        : "PostgreSQL проєкту зупинено.",
    );
    process.exitCode = running ? 0 : 1;
  } else
    throw new Error("Використайте db:setup, db:start, db:stop або db:status.");
} catch (error) {
  // Деталі сторонніх помилок можуть містити підключення або секрети.
  console.error(
    error instanceof Error &&
      !("code" in error) &&
      !/^Invalid URL/.test(error.message)
      ? error.message
      : "Не вдалося підготувати PostgreSQL. Перевірте доступ і конфігурацію без публікації секретів.",
  );
  process.exitCode = 1;
}
