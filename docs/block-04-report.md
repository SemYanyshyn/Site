# Звіт блоку 4 — Courier Route

Дата: 23 жовтня 2026 року, Europe/Kiev.

## 1. Статус і неперевірене

**Готово в межах блоку 4, очікує перевірки керівником.** PostgreSQL зберігає задачі, базову спільну чергу, прогрес, історію, результати й cancel. Захищений HTTP API та один dispatcher/executor на процес працюють через два незалежні сервери. Typecheck/build успішні; фінальна регресія й нові перевірки: **87 pass, 0 fail, 0 skipped**.

Браузерна перевірка авторизації залишається **заблокованою середовищем**: вибір браузера повернув «No browser is available», після перевірки підключень список `[]`. Візуальне відображення, взаємодія форм, відновлення після оновлення та вузький екран не прийняті в браузері. HTTP не зараховується як browser pass.

Виконано тільки блок 4. UI задач/точок/маршруту, ETA, балансувальник, HTTPS, контейнери, HPA й адмінпанель не додавалися. Нових блокувань БД або Git немає. Блок 5 не розпочато.

## 2. Структура та залежності

Додано `migrations/002_jobs.sql`, `src/shared/jobs.ts`, `src/server/jobs/{config,repository,router,dispatcher}.ts`, спільний `src/server/http/json.ts`, `tests/jobs-config.test.ts`, `tests/jobs.integration.test.ts` і приватний IPC harness `tests/fixtures/jobs-http-harness.ts`.

Оновлено app, startServer/shutdown, readiness, перелік міграцій, npm-команди, `.env.example`, README/PROJECT_PLAN/AGENTS і цей звіт. Доручення блоку 4 збережено побайтово в корені, з `-text` у `.gitattributes`. Окремо виправлено auth integration-тест: Vite використовує вільний порт, а не зайнятий 5173.

**Нових залежностей немає.** Використано наявні Express/pg/tsx та вбудовані Node APIs. `npm ls --depth=0` успішний. Залежності, lock-файл і погоджений strict TypeScript/Node 24/npm 11 стек збережено; `npm ci` цього разу не повторювався. Алгоритм, RouteInput/RouteResult і клієнтські файли не змінювалися. Великий benchmark не повторювався; важкі задачі використовувалися для перевірок реальної поведінки.

## 3. Міграція й цілісність даних

Нова `002_jobs.sql` додає одну jobs з UUID, user FK, нормалізованим input jsonb/seed, status, stage/counters/percent, часовими полями, cancel_requested_at, instance_id, приватним claim_token, timeout_ms/lost_after, result та безпечною failure reason/message.

Constraints перевіряють перелік станів/етапів, додатний total і допустимий completed, percent 0–100, queued=0, running/failed/cancelled<100, completed=100/finishing, наявність result лише за completed, finished_at лише в кінцевому стані, узгоджені claim-поля й failure-поля. Вхід мусить містити нормалізовані ключі, uint32 seed та погоджений total. Runtime-валідація координат/полів залишається обов'язковою перед INSERT і worker. Індекси: queued за created_at/id; історія та active власника; прострочені running за lost_after.

Runner тепер вимагає `001_auth`, `002_jobs`; build копіює обидва SQL. Readiness перевіряє версії й усі потрібні форми таблиць. Міграції запускаються явно, транзакційно, під наявним advisory lock, не з HTTP startup.

На робочій локальній БД явно виконано `npm run db:migrate`: застосовано тільки `002_jobs`. `npm run db:migrate:built` одразу підтвердив, що всі міграції вже застосовані. Після застосування SQL не редагувався. На окремій тестовій схемі перевірені чиста установка, два конкурентні built runner і повторні запуски; користувач та чинна сесія з 001 залишилися доступними після 002. Ready був 503 до повної jobs-схеми й 200 після; health залишався 200.

Оригінал `docs/assignment.txt`, звіти 1–3, попередні доручення та `001_auth.sql` збережені без змін. Робочу БД не очищували, локальні паролі не змінювали, db:setup не запускали.

## 4. API й власник

Усі `/api/jobs` потребують PostgreSQL-сесії через наявний requireAuth і мають `Cache-Control: no-store`. User id береться із сесії. Приватний claim token не входить у відповідь. Читання/скасування завжди працюють із БД, незалежно від виконавця.

| Маршрут | Фактичний контракт |
| --- | --- |
| `POST /api/jobs` | RouteInput; `202 JobDetails` і Location після commit queued, без очікування результату |
| `GET /api/jobs` | `{ jobs, limit, offset }`, лише власні компактні summary, без масивів input/result |
| `GET /api/jobs?status=active` | Queued/running; також підтримано один конкретний status; default limit=20, max=50, offset=0–1000000 |
| `GET /api/jobs/limits` | `{ route: { maxPoints, maxIterations, timeoutMs, maxCoordinate }, maxActivePerUser }` |
| `GET /api/jobs/:id` | Власний нормалізований input, status, progress, cancelRequested, часові поля, executedBy; result тільки completed, error тільки failed |
| `POST /api/jobs/:id/cancel` | Тіло `{}`; queued → cancelled/200, running → прапорець/202, кінцева задача → незмінний 200 |

Сортування історії — `created_at DESC, id DESC`; однакові timestamps мають стабільний UUID tie-break. Пагінація обмежує відповідь, а не всі збережені записи. Автоматичного видалення історії немає.

Без сесії — 401; чужий і невідомий UUID — однакові 404/JOB_NOT_FOUND; невалідний UUID — 400/INVALID_JOB_ID; query — 400/INVALID_QUERY; route input — 400/INVALID_ROUTE_INPUT; cancel body — 400/INVALID_CANCEL_INPUT. Поля userId/status/claim/timeout/result не дозволяють підмінити власника чи обмеження. Непридатна БД — 503/DATABASE_UNAVAILABLE, не порожня історія з 200.

Мутації використовують той самий точний Origin та application/json, що й auth. Для jobs межа **256 KiB**, auth зберігає **16 KiB**. Поганий JSON — 400, body понад межу — 413 з правильною назвою ліміту, Content-Type — 415, Origin — 403. CORS wildcard або Bearer-обхід не додані.

## 5. Ліміти та admission

| Конфігурація | Default | Дозволено |
| --- | ---: | ---: |
| JOBS_MAX_ACTIVE_PER_USER | 3 | 1–100 |
| JOBS_MAX_OUTSTANDING | 100 | 1–10000 |
| JOBS_POLL_INTERVAL_MS | 250 мс | 25–5000 мс |
| JOBS_WORKER_LOST_GRACE_MS, мінімальний запас | 5000 мс | 100–30000 мс |

Це проєктні значення. Route-ліміти незмінні: default 500 доставок, 50 млн реальних спроб, timeout 30 с, модуль координат ≤1000000; жорсткі конфігураційні стелі 2000/200 млн/120 с. Усі сервери системи повинні мати однакові route/jobs-налаштування.

Active/outstanding = queued+running. Running із cancel_requested ще витрачає квоту до фізичної зупинки та кінцевого запису. Завершена історія не витрачає active-ліміт.

Runtime-валідація й нормалізація передують INSERT. Відсутній seed генерується один раз, у БД зберігається фактичний seed. На одному client коротка транзакція `READ COMMITTED` бере спільний `pg_advisory_xact_lock`, рахує обидві квоти й робить INSERT. Commit передує 202; lock не утримується під час worker. За особистого ліміту — **429/USER_ACTIVE_LIMIT**, за загального — **503/SYSTEM_OUTSTANDING_LIMIT**, без зайвого запису.

Конкурентні A/B POST із зупиненими лише claims дали рівно 3 прийняття одного власника, решті 429. Окремий сценарій різних власників із тестовим загальним лімітом 4 дав рівно 4 прийняття, решті 503. Усі ці записи залишалися queued під час вимірювання; завершення роботи не спотворювало квоти. Після terminal нові задачі приймаються.

## 6. Claim, slot і прогрес

Один dispatcher отримує той самий RouteExecutor, pg.Pool та instanceId, який повертає health. Синхронний poll guard і явна claim-резервація не дозволяють накладати цикли/запуски. `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` і UPDATE у короткій транзакції вибирають найстарішу queued, фіксують running, instanceId, новий приватний token, started_at, timeout і lost_after. Worker створюється тільки після commit. Client звільняється в finally.

Слот claim залишається зайнятим після фізичного завершення worker, доки terminal не узгоджено з БД. Пам'ять процесу містить лише цей claim/run та останній незаписаний прогрес. Нові queued беруться з PostgreSQL; локальної черги немає.

Реальний onProgress з етапами/лічильниками записується приблизно раз на 150 мс. Є максимум один progress UPDATE у польоті та один замінюваний snapshot; перед terminal останній стан обробляється. Running=100 не записується. Completed, result, лічильник, percent=100 і finished_at зберігаються одним terminal UPDATE після перевірки результату й виходу worker.

Усі progress/terminal UPDATE обмежені id, running і claim token; лічильники/етап/відсоток не зменшуються. Пізній progress не змінює terminal і не стирає cancel. Це перевірено неправильним token, terminal/repeated writes та прийнятим cancel. Окремий тест тримав справжній PG row lock і чотири рази спостерігав **рівно один** заблокований progress UPDATE через pg_stat_activity, тоді як новий реальний прогрес надходив і HTTP працював.

## 7. Скасування через інший сервер

HTTP B атомарно записує cancel_requested_at для running; не шукає worker у власній пам'яті й відповідає 202/running/cancelRequested=true. Coordinator A перевіряє прапорець незалежно від нових progress-подій, викликає executor.cancel(runId) і чекає справжнього exit. Тільки потім пише cancelled.

Фінальний тест: job `bbcfa2ef-4038-4151-b102-3011aeb3eb3c`, POST cancel через B зупинив worker A з `threadId=-1`; спостережені worker_exit/worker_stopped передували terminal commit. Наступна queued `2ad5cada-0e04-4f4d-a536-1bc8c3dcab5a` виконана. Повторний cancel дав незмінний 200. Queued cancel завершився без worker/start.

Finish/cancel серіалізуються атомарним UPDATE актуального рядка: якщо прапорець уже прийнято, він має пріоритет над completed, timeout чи іншою звичайною причиною failed; result не зберігається. Якщо terminal уже зафіксовано, пізній cancel його не переписує. Це і є правило гонки timeout/cancel. Recovery worker_lost є окремим випадком: після втраченого виконавця фіксується failed/worker_lost, без заяви про підтверджене добровільне скасування.

## 8. Помилки й коректне завершення

| Причина | Поведінка |
| --- | --- |
| timeout | Parent реально terminate worker; failed/timeout без часткового result; наступна queued працює |
| worker_error | Справжній аварійний worker fixture; failed/worker_error, HTTP і слот відновлюються |
| invalid_input | Збережений вхід не відповідає поточній конфігурації; failed без повторного queued |
| database_unavailable | SQL-контроль/запис недоступні: нові claim припиняються, власний worker фізично зупиняється, terminal обмежено повторюється за poll |
| server_shutdown | Нові claim припинені, worker зупинений, доступний terminal записано до Pool.end; раніше прийнятий cancel має пріоритет |
| worker_lost | Прострочене running після втрати процесу/неможливості зберегти terminal; автоматичного повтору немає |

Відмову SQL перевірено на справжній БД тимчасовим перейменуванням jobs **тільки випадкової тестової схеми**, не зупиняючи чужий кластер чи робочу БД. Job API/ready давали 503, health=200, worker припинився, claim-резервація лишалася зайнятою до відновлення запису. Після повернення таблиці зафіксовано failed/database_unavailable, queued далі виконалася. Окремий справді недоступний PG endpoint також дав очікувані 503.

Shutdown зупиняє dispatcher timer, нові claim/progress, власний worker і прямий executor run старого harness. Очікує вже видані SQL, робить фінальний запис тільки за достатнього бюджету, потім закриває Pool. Немає незавершеної Promise.race-продовжуваної роботи, що починала б новий SQL після Pool.end. Є локальний бюджет 3800 мс та загальна жорстка межа процесу 5 с; нескінченних повторів немає. За невдалого запису залишається persisted deadline для recovery.

Фінальні активні SIGINT/SIGTERM: **8,59 / 7,66 мс**, обидва clean exit, worker/HTTP/dispatcher/Pool зупинено; відповідно збережені failed/server_shutdown та раніше запитаний cancelled. За відмови terminal SQL SIGTERM завершив процес за **6,88 мс**; після відновлення таблиці job завершився worker_lost без повторного start, лише після timeout=2000 мс + effective grace≈21080 мс.

## 9. Deadline і відновлення

Початковий аудит виявив ризик: малий grace при великому poll дозволяв recovery випередити запис уже відомого timeout. Виправлено до завершення блоку: власний готовий outcome фіналізується перед global recovery; результат worker запускає одну негайну серіалізовану спробу, а відмова SQL повторюється тільки з нормальним інтервалом.

Persisted deadline: `started_at + timeout_ms + effectiveGrace`. Фактичний grace — `max(configuredGrace, 2×pollIntervalMs + 21000)` мс. Резерв 21 с враховує відповідь UPDATE claim і commit (до 6 с), поточний і останній progress, terminal (кожен до 2 с отримання client + 3 с SQL). Default — **21500 мс**, максимум за дозволеної конфігурації — **31000 мс**. Це запас для виявлення втрати, не додатковий час обчислення. Worker timeout залишається 30 с за замовчуванням. Зміна DB-таймаутів потребує узгодження резерву.

У фінальному SIGKILL-тесті A=`fdce8828-7126-4db4-8151-68ac1860b975` реально почав job `5372812f-d4c5-4167-a021-04ec19f87063`, після чого процес примусово завершено. У БД timeout=2500 мс, effective grace≈21080 мс. Живий B=`ed26ff8a-d7b1-4a24-890a-0d455690bc60` після записаного deadline перевів її у failed/worker_lost. Повторного claim/start цієї задачі в B не було. Його інша допустима жива job залишалася running. Новий сервер не оголошує всі чужі running втраченими при старті.

## 10. Фактичні перевірки

Середовище: macOS arm64, Node.js 24.18.0, npm 11.16.0; PostgreSQL 18.4 Postgres.app. SQL та listeners перевірялися з доступом поза мережевими обмеженнями sandbox. Перед тестовими змінами guard звіряє окреме test-ім'я, URL/DNS/loopback/overrides і фактичні database/port/loopback address; role superuser=false. Тести працюють у власній випадковій схемі `courier_route_test`.

| Набір/сценарій | Фактичний результат | Pass | Fail | Skipped |
| --- | --- | ---: | ---: | ---: |
| Typecheck / build | Обидва exit 0; backend/worker, SQL/JSON і Vite client | — | — | — |
| `test:unit` | Попередня регресія, 885,04 мс | 11 | 0 | 0 |
| `test:route` | Попередня регресія, 3466,31 мс; TS/built worker та HTTP | 36 | 0 | 0 |
| `test:integration` | Справжня PG auth-регресія, 3407,34 мс | 13 | 0 | 0 |
| `test:jobs` | 3 config unit + 24 справжні PostgreSQL/HTTP integration, 58116,52 мс | 27 | 0 | 0 |
| Разом | Фінальні запуски без пропусків | **87** | **0** | **0** |
| TS / built route demo | Exit 0, order=[0,1,2,3,0], length=4, seed=0, 10000 реальних спроб | — | — | — |
| Браузер | Недоступний, не зарахований як pass або skipped test | — | — | — |

| Jobs-сценарії | Фактичний результат |
| --- | --- |
| 001→002, clean/repeat/concurrent built runner, readiness | Users/чинна сесія збережені; 503→200; SQL у build |
| Auth/Origin/JSON/16–256 KiB/limits | Передбачувані відмови, без INSERT/worker для невалідного входу |
| Ownership, query, ties, history/active | Чужі рядки відсутні; стабільні компактні сторінки; зайві query 400 |
| Конкурентні квоти A/B | Рівно 3 особисті / 4 тестові загальні прийняття, без перевищення |
| Claim/start, completed/trivial, generated seed | Один claim/start; справжній worker; квадрат 4; тривіальна 0 ітерацій |
| Дві heavy jobs, API progress/health | Одночасні різні виконавці; max worker=1; монотонні збережені counters |
| Queued/running cancel, stale token, late writes, races | Фізичний exit до cancelled, terminal не переписується, наступна job виконується |
| Timeout/crash/SQL failure/unavailable endpoint | Чесні failed/503, worker зупинено, ресурс відновлюється |
| SIGKILL/restart/session/history | Worker_lost тільки після deadline, без подвійного start; історія й сесія збережені |
| SIGINT/SIGTERM і SQL-відмова shutdown | Обмежений вихід; server_shutdown/раніший cancelled або recovery worker_lost |
| Від'єднання клієнта після 202 | Прийнята реальна heavy job завершилася, 100 млн спроб, без cancel |
| Заблокований progress UPDATE | Рівно один SQL у польоті, HTTP та читання стану доступні |

Перший auth-регресійний запуск мав 12/13 через зайнятий стороннім Vite порт 5173. Тест виправлено на ізольований вільний порт; фінально 13/13. WIP-помилки strict-типів у нових тестах виправлено до фінальної перевірки. Наявний Vite користувача не зупинявся.

## 11. Два незалежні процеси й відсутність дублювання

Приватний harness імпортує **зібраний production startServer/dispatcher/executor**. Це два дочірні HTTP-процеси, не два app-об'єкти. Для нормальних сценаріїв workerFactory лише спостерігає справжні Worker, не змінює URL/алгоритм. Error fixture використовується тільки для аварії. IPC pause/resume не є HTTP endpoint або env-обходом.

Фінальні одночасні процеси: A=`8a38f2b5-2a09-4c53-9cd2-ae66dd630471`, B=`bf7b7c7c-a41e-4526-8d1f-4ea721cec867`; різні jobs `31d34a38-f14f-47da-834a-fea3c25fde35` та `647a6695-39c8-4aef-8187-a83a1663854d`. На обох спостерігався один справжній активний worker. Окрема queued job `29722e9c-25dc-492c-b7e0-dcf42f003d67` при конкурентних claim дала **claims=1, starts=1**, а не просто один фінальний рядок; actual exit threadId=-1.

Під час pending пошуку GET через інший сервер повернув збережені лічильники **6032384, 12361728, 12361728, 18851840, 18851840**, running<100. П'ять health-відповідей — **1,55; 1,46; 1,48; 1,44; 1,51 мс**. POST віддавав committed queued до heavy completion, а читання стану й cancel працювали незалежно від HTTP-виконавця. Це підтверджує готовність прикладного рівня; load balancer у цьому блоці відсутній.

## 12. Перезапуск, історія та регресія

Completed job з input/seed, result, progress і часовими полями прочитана через обидва сервери; після повного перезапуску A/B з новими instanceId відповідь залишилася ідентичною. Чинна сесія продовжила працювати. Активний фільтр і вся власна історія читаються з PostgreSQL.

Попередні 11+36+13 тестів повторно пройшов виконавець цього блоку. Справжні PG-тести підтверджують спільні сесії, auth/logout, міграції, production HTML/JS/CSS, API-404, readiness і відмови. Dev HTML/TS/CSS та фактичний Vite proxy перевірені на виділеному вільному порту. TS/built route demo незалежні від DB; elapsed у виконаних demo — 1,721333 та 1,949708 мс. Повторний великий benchmark не був потрібен: алгоритм не змінено.

Блок 3 прийнято керівником після незалежних 47 non-DB тестів/CLI/benchmark. Його benchmark 21,48 с і наш попередній 4,33 с мають однакову best length. **13 PG-тестів керівник не повторював** через обмеження свого середовища; попередні звіти не переписані. Browser pass усе ще відсутній.

## 13. Команди відтворення

Фактично виконано з кореня:

```sh
npm ls --depth=0
npm run db:status
npm run db:check
npm run db:migrate
npm run db:migrate:built
npm run typecheck
npm run build
npm run test:unit
npm run test:route
npm run test:integration
npm run test:jobs
npm run route:demo -- examples/route-small.json
npm run route:demo:built
```

`npm test` визначає ту саму послідовність unit → route → auth integration → jobs; build виконується перед тестами. PG-тести читають явний TEST_DATABASE_URL з ігнорованого `.env`, без URL/пароля в shell. Міграція робочої БД явна; тестові runner працюють лише у перевіреній окремій схемі.

README містить перевірений API-контракт і безпечний сценарій: login із request-файлу/cookie jar у `.local` → POST @examples/route-small.json → polling GET → result/history → новий POST; окремо POST `{}` cancel. Паролі не вставляються в команди; cookie/тимчасові auth-тіла видаляються після ручної перевірки. Реальні інтеграційні запити підтверджують ці переходи; самі приклади curl на робочій БД не запускалися для створення зайвих записів.

Два процеси для відтворення після явної міграції й build, у різних терміналах:

```sh
PORT=3000 APP_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:5173 npm start
PORT=3001 APP_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:5173 npm start
```

Обидва читають спільну DB-конфігурацію `.env` та однакові route/jobs-ліміти. Для нового середовища спочатку `npm ci` й підготовка власної БД за README; для цього наявного кластера db:setup повторно не потрібен.

Технічна довідка: [PostgreSQL SELECT/SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html), [advisory/row locks](https://www.postgresql.org/docs/18/explicit-locking.html), [pg: один client для транзакції](https://node-postgres.com/features/transactions), [параметризовані запити](https://node-postgres.com/features/queries). Усі користувацькі SQL-значення передаються параметрами.

## 14. Покриття вимог і наступні блоки

Пункт 1 покритий сервісом і HTTP API: runtime-ліміти, відмови, реальний timeout і збережена причина. Для пунктів 2/3 реалізовано серверний прогрес, історію, стан, створення й cancel; їхній UI — блок 5. Для пункту 4 працюють спільні сесії й ownership задач; HTTPS — блок 7, браузерне приймання форм відкрите.

Базові queued/claim та атомарна загальна місткість готові. Це не завершення всього пункту 6: ETA й облік доступної потужності — блок 6. Два локальні процеси з обчисленнями не закривають пункт 5 без балансувальника/розгортання. Блок 5 — UI/координати/схема маршруту; 7 — Docker/Kubernetes/Traefik/HTTPS, 8 — Metrics Server/HPA, 9 — адмінпанель, 10 — наскрізне приймання/демонстрація. PROJECT_PLAN не позначає їх виконаними наперед.

## 15. Git і ZIP

Працювали в наявному `/Users/a860/Documents/Site`, **main**, початковий status чистий, база `c2e4216`. Справжня Git-ідентичність уже була налаштована й не змінювалася. Remote/push не налаштовувалися, історія не переписувалася. Повні дев'ять Git-правил збережено в AGENTS; source input та застосовані SQL не форматувалися.

Створені змістовні коміти:

- `99baa86 fix(test): isolate Vite proxy checks on a free port`.
- `fabae82 feat(jobs): persist route jobs and enforce admission limits`.
- `ccd18fe feat(jobs): dispatch queued work across server processes`.
- `docs: record block 4 verification results` — фінальна документація; хеш наводиться в чаті після коміту без циклічного внесення у сам звіт.

Власні завершені зміни закомічені; фінальний `git status --short` порожній, гілка main. Сторонніх незакомічених змін немає. Перед комітами перевірені status, diff/staged diff, секрети та результати; generated/local DB/auth файли не включені.

ZIP створюється **після фінального коміту з точного HEAD**, поруч із проєктом:

```sh
git archive --format=zip --output=../CourierRoute-block-04.zip HEAD
open -R ../CourierRoute-block-04.zip
```

Абсолютний шлях: `/Users/a860/Documents/CourierRoute-block-04.zip`. Після створення перевіряються ZIP, коментар із commit id та побайтовий вміст проти HEAD. Архів містить лише відстежувані файли, включно зі звітом, тестами, SQL і lock-файлом; `.env`, `.git`, dist, node_modules, PostgreSQL-дані, cookie/логи відсутні. Нічого нікуди не завантажується. Хеш HEAD та посилання на перевірений ZIP наведені в чаті після створення.

## 16. Процеси й PostgreSQL

Усі власні тимчасові HTTP/Vite/harness/worker процеси та pools перевірок зупинені, випадкові тестові схеми прибрані; фінальний запит до окремої тестової БД підтвердив **0** схем із префіксом courier_test_. Жодних retained auth/cookie-файлів для ручних запитів не створювали; тестові credentials/cookie залишалися в пам'яті ізольованих перевірок. Тимчасове перейменування таблиці й row lock завжди прибираються у finally.

У користувача вже був Vite на 5173 (PID 42156 у момент виявлення); його та пов'язані наявні процеси збережено. Не слід плутати їх із створеними тестами тимчасовими процесами.

**PostgreSQL залишено працювати** на `127.0.0.1:55432`, окремий локальний кластер проєкту; role courier_route без superuser. Робоча БД courier_route, тестова courier_route_test. Керування з кореня:

```sh
npm run db:status
npm run db:stop
npm run db:start
```

## 17. Ручні дії й зупинка

Для зняття єдиного відкритого блокування потрібне доступне браузерне підключення та перевірка наявної авторизації/оновлення/виходу/адаптивності. PostgreSQL, Git і ZIP не потребують ручного розблокування. Після перевірки архіву керівником наступний блок потребує нового доручення.

Роботу зупинено перед блоком 5.
