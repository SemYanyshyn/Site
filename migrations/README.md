# Як я розумію схему й службові команди бази даних

Тут зберігаю пояснення структури PostgreSQL та файлів, які готують її до роботи

Схема — це таблиці, колонки, зв’язки, обмеження й індекси, а міграція — версійований SQL-файл, який створює або змінює цю структуру

## Моя мапа файлів

| Файл | Для чого його використовую |
| --- | --- |
| [001_auth.sql](001_auth.sql) | Створюю користувачів і сесії |
| [002_jobs.sql](002_jobs.sql) | Зберігаю задачі, прогрес, результати та стан виконання |
| [003_executor_registry.sql](003_executor_registry.sql) | Реєструю живі процеси й додаю індекси для черги |
| [004_executor_metadata.sql](004_executor_metadata.sql) | Пов’язую процеси з pod Kubernetes |
| [local-postgres.mjs](../scripts/local-postgres.mjs) | Готую та керую окремим PostgreSQL на Mac |
| [copy-migrations.mjs](../scripts/copy-migrations.mjs) | Копіюю міграції до готової збірки без виконання SQL |
| [database.ts](../src/server/database.ts) | Створюю пул застосунку й перевіряю готовність бази |
| [migrate.ts](../src/server/db/migrate.ts) | Явно застосовую ще не виконані міграції |
| [check.ts](../src/server/db/check.ts) | Перевіряю підключення, версію й роль PostgreSQL |
| [migration-comment-updates.ts](../src/server/db/migration-comment-updates.ts) | Приймаю лише зафіксовані історичні зміни коментарів за точними парами хешів |

## Як пов’язані таблиці

Один користувач із `users` може мати кілька сесій у `sessions` та багато задач у `jobs`

`sessions.user_id` і `jobs.user_id` посилаються на `users.id` через FOREIGN KEY

`ON DELETE CASCADE` означає, що видалення користувача видалить пов’язані сесії й задачі, але службові команди start і stop такого видалення не виконують

`jobs.instance_id` називає процес, який виконував задачу, а `executor_registry.instance_id` описує його реєстрацію — між цими колонками немає оголошеного FOREIGN KEY

Окремо runner створює службову таблицю `schema_migrations` із версією, контрольною сумою та часом застосування міграції

## Що зберігаю в users і sessions

У `users.id` тримаю UUID, у `username` — логін, у `normalized_username` — його нижній регістр із UNIQUE, у `password_hash` — хеш замість пароля

Поле `role` дозволяє лише `user` або `admin`, а CHECK додатково перевіряє формат логіна

У `sessions.token_hash` зберігаю SHA-256 токена cookie, у `user_id` — власника, у `expires_at` — кінець строку дії

Сама наявність рядка сесії не означає чинний вхід — сервер також перевіряє строк дії

## Що зберігаю в jobs

У `input` записую JSONB зі складом, доставками, seed і бюджетом ітерацій, у `result` — результат лише успішного completed

`status` відрізняє очікування queued, виконання running і кінцеві completed, cancelled, failed

`progress_stage`, `completed_iterations`, `total_iterations` і `progress_percent` описують фактичний прогрес, обмеження таблиці дозволяють 100 лише для completed

`cancel_requested_at` означає запит на скасування, а не доказ фізичної зупинки worker

`instance_id` називає процес, `claim_token` захищає право саме цього виконання оновлювати задачу

`timeout_ms` задає межу роботи worker, а `lost_after` дозволяє пізніше визнати втрачений running помилкою worker_lost

`started_at` і `finished_at` показують фактичний початок і завершення, `failure_reason` та `failure_message` пояснюють failed

CHECK-обмеження захищають від суперечностей, наприклад completed без result чи активної задачі з finished_at

## Для чого executor_registry

Один запис описує конкретний серверний процес із UUID, а не весь MacBook або весь кластер

Heartbeat оновлює `last_seen_at` і `expires_at`, після завершення TTL запис перестає вважатися свіжим

`accepting_claims` показує готовність приймати задачі, `busy` і `current_job_id` — зайнятість одного слота

`pod_uid`, `pod_name` і `pod_namespace` допомагають зіставити процес із Kubernetes, поза кластером усі три можуть бути NULL

## Як читаю SQL

| Запис | Як його розумію |
| --- | --- |
| PRIMARY KEY | Унікально визначаю рядок і не допускаю NULL у ключі |
| NOT NULL | Вимагаю значення поля |
| UNIQUE | Забороняю дублікати значення |
| DEFAULT | Беру початкове значення, якщо INSERT його не передав |
| CHECK | Перевіряю правило на рівні самої бази |
| REFERENCES | Вимагаю наявність пов’язаного рядка |
| timestamptz | Зберігаю момент часу з урахуванням часового поясу |
| jsonb | Зберігаю структуровані дані JSON у форматі PostgreSQL |
| CREATE INDEX | Прискорюю відповідні читання ціною додаткового місця й роботи при записі |
| WHERE в індексі | Індексую лише потрібну частину рядків, наприклад queued |

## Службові команди

Ці команди запускаю з кореня Site, а не з папки migrations

| Команда | Що вона робить |
| --- | --- |
| `npm run db:setup` | Готую host-кластер за відсутності, запускаю його, створюю або налаштовую роль і потрібні бази |
| `npm run db:start` | Запускаю вже підготовлений host PostgreSQL |
| `npm run db:status` | Перевіряю стан host PostgreSQL, код 0 означає працює, 1 — зупинений |
| `npm run db:stop` | Зупиняю host PostgreSQL зі збереженням даних |
| `npm run db:check` | Перевіряю підключення з DATABASE_URL |
| `npm run db:migrate` | Застосовую міграції через TypeScript runner |
| `npm run db:migrate:built` | Запускаю вже зібраний runner після npm run build |

`db:setup` використовує `.local/postgres`, loopback `127.0.0.1:55432` та окремі бази `courier_route` і `courier_route_test`, пароль лишаю в ігнорованому `.env`

`db:check` і міграції працюють із адресою DATABASE_URL, тому не припускаю, що вони завжди спрямовані саме на host-кластер

PostgreSQL у Kubernetes має окреме керування через deployment і PVC — команда `db:stop` його не зупиняє

## Чому не переписую застосовані SQL-файли

Runner рахує SHA-256 усього файлу, включно з коментарями, й перевіряє його перед пропуском уже застосованої версії

Навіть косметична правка старої міграції може зламати цю перевірку, тому докладні додаткові нотатки тримаю тут, а нову структуру оформлюю новою міграцією

Точні історичні винятки в migration-comment-updates.ts не дозволяють будь-які подальші зміни SQL або коментарів
