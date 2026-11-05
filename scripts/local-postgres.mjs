// Тут керую окремим PostgreSQL для запуску проєкту без Kubernetes
// Це host PostgreSQL на Mac, а не контейнер PostgreSQL із deploy/k8s/postgres.json
// Дані тримаю в .local/postgres, команда stop зупиняє сервер без видалення цих файлів

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Pool } from "pg";

// Будую шляхи від розташування скрипта, тому вони не залежать від поточної папки термінала
const project = fileURLToPath(new URL("../", import.meta.url));
const directory = join(project, ".local", "postgres");
const data = join(directory, "data");
const socket = join(directory, "socket");
const log = join(directory, "server.log");
const envPath = join(project, ".env");
// Для цього локального кластера використовую порт 55432, щоб відокремити його від звичайного порту 5432
// Адміністративну роль використовую тільки для підготовки, а застосунок працює через обмежену роль courier_route
const port = 55432;
const admin = "courier_local_admin";
const role = "courier_route";
// Створюю окремі робочу й тестову бази, щоб інтеграційні тести не очищали робочі таблиці
const databases = ["courier_route", "courier_route_test"];
// Читаю дію setup, start, stop або status з аргументу, який передає відповідна npm-команда
const command = process.argv[2];

// Шукаю вже встановлені утиліти PostgreSQL 18 спочатку через PG_BIN_DIR, потім у типових папках Mac
// Цей код не встановлює сам PostgreSQL, а знаходить pg_ctl та initdb
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

// Запускаю утиліту PostgreSQL окремим процесом і передаю аргументи масивом без shell
// spawnSync чекає завершення, що підходить для цієї короткої службової команди, а не для HTTP-обробника
function execute(binary, args, options = {}) {
  return spawnSync(join(findBinaries(), binary), args, {
    cwd: project,
    encoding: "utf8",
    ...options,
  });
}

// Перевіряю наявність підготовленої папки даних і статус саме цього кластера через pg_ctl
function isRunning() {
  return (
    existsSync(join(data, "PG_VERSION")) &&
    execute("pg_ctl", ["-D", data, "status"]).status === 0
  );
}

// Запускаю вже підготовлену базу або залишаю чинний процес працювати
// На старт даю до 15 секунд і пишу журнал у .local/postgres/server.log
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

// Готую окрему папку даних, налаштування доступу, роль застосунку та дві бази
// Не видаляю наявний кластер, але ця команда може створити або оновити роль застосунку
async function setup() {
  // Обмежую доступ до папки Unix-сокета правами власника, бо локальний admin підключається через неї
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(join(data, "PG_VERSION"))) {
    // Ініціалізую кластер лише якщо ще немає PG_VERSION
    // Для локального сокета задаю trust, для TCP вимагаю SCRAM-пароль, тому сокет залишаю у приватній папці
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
    // Записую конфігурацію лише для щойно створеного кластера
    // Слухаю тільки loopback 127.0.0.1, зберігаю приватні права файлу й не журналюю SQL та його параметри
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

  // Якщо .env ще немає, генерую випадковий пароль і створюю файл із правами 0600
  // Прапорець wx не дозволяє випадково перезаписати вже створений файл
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
  // Читаю локальний .env для службової підготовки, його вміст і паролі не виводжу
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const appUrl = new URL(env.DATABASE_URL ?? "");
  const testUrl = new URL(env.TEST_DATABASE_URL ?? "");
  // Перед адміністративними SQL-запитами перевіряю точний host, порт, назви баз і роль
  // Якщо .env указує інше підключення, зупиняю підготовку без його перезаписування
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
  // Для підготовки відкриваю одне адміністративне з’єднання через приватний Unix-сокет
  // Це окремий пул, він не використовується звичайними HTTP-запитами
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
    // Перевіряю наявність ролі, щоб обрати CREATE або ALTER без видалення користувача PostgreSQL
    const existing = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [role],
    );
    const verb = existing.rowCount ? "ALTER" : "CREATE";
    // Доручаю PostgreSQL безпечно екранувати ім’я ролі через %I і пароль через %L
    // Вимикаю superuser, створення баз і ролей та реплікацію для облікового запису застосунку
    const formatted = await pool.query(
      `SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text) AS statement`,
      [role, decodeURIComponent(appUrl.password)],
    );
    await pool.query(formatted.rows[0].statement);
    // Створюю відсутні робочу й тестову бази з потрібним власником
    // Якщо наявна база належить іншій ролі, не забираю її собі й завершую з помилкою
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
  // Закриваю адміністративний пул навіть тоді, коли підготовка завершилася помилкою
  } finally {
    await pool.end();
  }
  console.info(
    "Окрему роль без superuser і дві БД підготовлено. Параметри збережено лише в ігнорованому .env. Дані зберігаються між перезапусками.",
  );
}

try {
  // Виконую лише запитану дію, звичайний start не повторює адміністративну підготовку
  if (command === "setup") await setup();
  else if (command === "start") start();
  // Зупиняю тільки цей кластер у режимі fast, який завершує з’єднання й відкочує активні транзакції
  // Це коректна зупинка PostgreSQL, вона не видаляє таблиці та збережені дані
  else if (command === "stop") {
    if (
      isRunning() &&
      execute("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"])
        .status !== 0
    )
      throw new Error("Не вдалося зупинити PostgreSQL проєкту.");
    console.info("PostgreSQL проєкту зупинено; дані збережено.");
  // Для status повертаю код 0, якщо сервер працює, і 1, якщо зупинений
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
// При помилці встановлюю ненульовий exit code, щоб термінал і наступна команда побачили невдачу
} catch (error) {
  // Не показую деталі сторонніх помилок, бо вони можуть містити адресу підключення або секрети
  console.error(
    error instanceof Error &&
      !("code" in error) &&
      !/^Invalid URL/.test(error.message)
      ? error.message
      : "Не вдалося підготувати PostgreSQL. Перевірте доступ і конфігурацію без публікації секретів.",
  );
  process.exitCode = 1;
}
