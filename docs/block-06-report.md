# Звіт блоку 6 — спільна черга, виконавці й час очікування

Дата: **24.10.2026**, Europe/Kiev. Проєкт `/Users/a860/Documents/Site`, початковий HEAD `12d2a1f`, гілка main, початковий status порожній. Виконано тільки доручений блок 6. Файл доручення був відсутній у корені: збережено дослівну копію вкладення `CourierRoute_Block_06_Codex.txt`. Оригінальні вимоги викладача, технічні рішення та організаційні Git-правила не змішуються.

## 1. Статус і незалежна перевірка

Реалізовано реєстр фактично запущених виконавців, bounded heartbeat/TTL, coherent queue snapshot, приблизний час **до початку** queued job та його відображення в наявному UI. Кожен HTTP-процес має один важкий слот; HTTP працює під час обчислення. Немає нових брокерів, scheduler-сервісу чи автоматичного повтору роботи.

Код і перевірки завершені: typecheck/build, повна регресія **156 pass / 0 fail / 0 skipped**. Фактичне браузерне приймання наведено нижче; блокувань немає. Усі потрібні можливості середовища доступні: PostgreSQL, два production-процеси, справжні worker й локальний Chrome. Незалежне приймання блоку 6 керівником ще не виконано.

Блок 5 прийнято керівником після повторення npm ci, typecheck/build, **87 non-DB**, TS/built CLI та production/dev HTTP. **37 PG, 14 Chrome та огляд PNG** підтверджено виконавцем; керівник їх не повторював через відсутність PostgreSQL/Chrome й локальні PNG не оглядав. Йому не приписується повтор усіх 124 чи browser pass. Звіти 1–5 не переписано.

## 2. Файли та залежності

Нові: `migrations/003_executor_registry.sql`, `src/server/jobs/executor-config.ts`, `executor-registry.ts`, `queue-estimator.ts`, `queue-snapshot.ts`, `src/client/queue-display.ts`, `tests/queue-config.test.ts`, `queue-estimator.test.ts`, `queue-read.test.ts`, `queue.integration.test.ts`, `client-queue.test.ts`, цей звіт та доручення.

Змінені: dispatcher/index, repository/router, required migrations/readiness, shared jobs, client parser/API/view/HTML/CSS, browser driver, npm-команди, `.env.example`, README/PLAN/AGENTS/`.gitattributes`. У старих auth/jobs integration збережено всі змістовні assertions, оновлено очікування третьої міграції/таблиці. Client API fixture оновлено під обов'язкову queued GET metadata.

**Нових залежностей немає**, lock-файл незмінний. Алгоритм, RouteExecutor, route CLI, `src/shared/route.ts`, дослівні вимоги, попередні доручення/звіти та застосовані SQL 001/002 побайтово збережено.

## 3. Міграція та готовність

003 створює `executor_registry`: UUID instance_id, started_at/last_seen_at/expires_at, accepting_claims, busy, current_job_id. Constraints перевіряють часовий порядок і правило current job ⇒ busy. Індекси підтримують свіжість придатних процесів, running за instance_id та останні completed/budget_exhausted з додатними виконаними ітераціями. Нових heartbeat-history/CPU/RAM таблиць немає.

Required migrations і readiness тепер вимагають усі три версії й форму реєстру. Busy не робить HTTP неготовим. SQL включено в build. **Явний `npm run db:migrate` застосував тільки 003**, повторний built runner пропустив застосовані версії; db:check підтвердив роль без superuser. Робочі таблиці не очищувалися. Після застосування 003 зафіксовано без подальшого редагування.

Окремий PG-тест перевірив 001→002→003 зі збереженими account/session/job/result, readiness 503 до повної схеми й 200 після, repeated/concurrent built migrations, відповідність SQL у dist. Попередній міграційний runner з checksum/advisory lock збережено.

## 4. Реєстр і lifecycle

Defaults: heartbeat **1000 мс**, TTL **15000 мс**. Interval — ціле 100–5000; TTL — ціле до 60000 і **≥ 3×interval + 6000**. Це проєктні налаштування, а не числа викладача. Резерв враховує pool acquisition 2 с та bounded SQL до 3 с із запасом. Тестовий TTL 6300 при interval 100 перевіряється справжнім плином DB-часу.

Дати записує PostgreSQL, freshness порівнюється з одним DB timestamp snapshot. Реєструється реальний health instanceId, після restart — новий UUID. Один heartbeat SQL у польоті, одна replaceable state; максимум два послідовні записи для узгодження переходу, без накопичення promise-черги. За помилки реєстрація втрачає підтвердження, повтор обмежений інтервалом; новий claim не починається без підтвердження. Власний dispatcher-worker фізично зупиняється при втраті DB-контролю.

Busy включає claim-резервацію, CPU й невирішену finalization. До claim підтверджується busy; після commit running сам є доказом зайнятості, current job heartbeat видається асинхронно. Це не додає ще одну послідовну bounded DB-операцію після збереження lost_after. Наявний grace **max(configured, 2×poll+21000), default 21500 мс** незмінний. Registry/direct-run спостереження не додає залежності від БД до RouteExecutor або CLI.

Paused/stopping/expired не додають потужності; busy придатний як майбутній слот. Snapshot зіставляє registry і running, тому старий idle heartbeat не створює вигаданого вільного ресурсу. Невідомий busy/current-job дає обережний null.

Shutdown зупиняє нові claim/heartbeat, чекає видані операції, позначає stopping за доступної БД, реально зупиняє worker і завершує доступний terminal до Pool.end. Останні registry/terminal SQL мають менші client/server budgets, спеціальні з'єднання не повертаються до pool. Пізній heartbeat не оживляє stopping. Збережена загальна межа процесу 5 с. За SIGKILL/неможливого stopping процес виключається TTL; **running відновлюється окремо за lost_after**, без повторного start.

## 5. Snapshot, формула й межі

Власна detail та queue читаються одним client у read-only REPEATABLE READ. Ownership перевіряється до глобальних metadata; береться один DB timestamp. Крім detail — **4 scalar SELECT**: придатні виконавці, running, усі queued-попередники created_at/id, останні 200 completed/budget_exhausted кандидатів з додатними ітераціями, які модель додатково фільтрує. Немає N+1, admission lock, копіювання чужих координат/result або запису ETA на polling. Обсяг hard-bounded: до 10000 виконавців/running/попередників, samples ≤200; надмірний snapshot не обрізається мовчки.

Увесь detail GET має спільний **8-секундний monotonic budget від middleware перед авторизацією**, включно з acquisition/setup/read/commit. Кожен snapshot SQL ≤1 с або залишку бюджету; PostgreSQL statement_timeout=1 с, lock_timeout=500 мс, transaction_timeout=5 с. Після помилки read-only connection закривається, без нової rollback-операції за вичерпаним бюджетом. Відповідь вкладається в клієнтський timeout 10 с. SQL-відмова → 503, health → 200.

Точна модель описана також у README:

- Idle: передача 250 мс. Busy searching: `min(timeoutRemaining, elapsed × (total−completed)/completed) + 500 мс`, якщо прогрес/elapsed додатні. Preparing/нуль прогресу: залишок фактичного timeout +500; finishing: 500. CancelRequested не звільняє слот; навіть усі виконані ітерації не роблять незавершену finalization вільною.
- Для queued-попередника `C = iterations + pointCount²`. У групі `floor(log2(pointCount))` береться медіана `slotDuration/C`; **slotDuration = finished_at−started_at**, не result.elapsedMs. Оцінка — clamp(median×C, 1, timeout)+750 мс. Failed/cancelled/trivial/zero, некоректні/нульові та понад 180 с samples не навчають звичайний пошук.
- Без придатної групи — реальний configured timeout+750 мс. Одна/дві доставки також використовують цей консервативний fallback; їхній швидкий результат не навчає звичайний пошук. Запаси 250/500 — явні налаштування, не виміряна універсальна швидкість.
- Слоти — min-heap. Кожен queued-попередник додається до найранішого слота, мінімум після них є ETA. **Тривалість самої цільової не додається**. Складність O((jobs+slots)log slots), не повторний sort на кожну job.
- `measured`: використано прогрес/samples/спостережену доступність без fallback; `mixed`: виміри + fallback; `timeout`: лише fallback; `unavailable`: null через відсутність слотів/суперечливі дані. Усі числові оцінки скінченні, невід'ємні, цілі, до технічної стелі 1400140000 мс.

Модель приблизна: CPU/контенція/startup/частота збереження прогресу й нові задачі змінюють прогноз. SKIP LOCKED не гарантує точного порядку при гонках. Cold fallback не є гарантованою верхньою межею. Модель не примушує ETA спадати та не знає майбутнього добровільного cancel. Швидкість з іншої машини/benchmark не підставлялася.

Технічні підстави: [DB-час](https://www.postgresql.org/docs/18/functions-datetime.html), [MVCC/isolation](https://www.postgresql.org/docs/18/transaction-iso.html), [JSON scalars](https://www.postgresql.org/docs/18/functions-json.html), [SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html), [один pg client у транзакції](https://node-postgres.com/features/transactions).

## 6. API та UI

Тільки queued GET detail має `queue: { estimatedWaitMs, calculatedAt, queuedAhead, executorCount, basis }`. Початковий create може не мати queue; 202 не чекає ETA/CPU. Running/terminal не містять стару metadata. Count — свіжі придатні **процеси**, не лише idle чи майбутні HPA replicas. QueuedAhead — queued-попередники всіх власників, не вся active-історія.

Сесія/no-store/Origin/body guards та квоти збережені. Чужий і невідомий GET/cancel однаково 404; невалідний UUID — 400. Немає нового публічного queue/servers endpoint чи витоку foreign id/координат/логінів/result/claim token/секретів.

Browser-safe parser перевіряє nullable integer, лічильники, дату/basis/статус та відкидає неправильну metadata. Queued GET без queue — помилка читання, create без queue допустимий. UI показує pending, unknown/відсутність виконавця, менше секунди, очікування призначення чи секунди/хвилини. Fallback явно позначений як попередній за серверною межею часу; пояснено, що оцінка може змінюватися.

Немає власного countdown або timer/detail-запиту кожній картці. Після 503 старі дані/ETA збережені з явним stale-попередженням, після running/terminal/logout ETA очищена. Збережені покоління сеансу/вибору/abort, захист повторного POST, focus/курсор, saved result/SVG та правило 100% тільки completed. Дизайн/авторизація не переписувалися.

## 7. Два процеси й реальна черга

Сценарій `test:queue` запускає два незалежні production HTTP-процеси зі спільною ізольованою PostgreSQL-схемою. У реєстрі два різні instanceId; обидва мають по одному busy/current-job, `executedBy` двох heavy jobs відповідає цим двом процесам.

У фінальному повному запуску сценарій 04 підтвердив:

- A `5de110c4-0d73-456d-8d05-a27fbf979cd7`, B `60dada87-a78d-4003-83f3-a3540dd7cf5e`.
- Running jobs `1ac0f809-e83b-4d0e-aac5-fc6af98c71b1`, `07e40a24-3975-49a5-8468-84a0c4b05672`.
- Третя `bd476e17-acff-473a-97b7-0e73ba9207fc` прийнята 202, лишалася queued, читалася через A/B із числовою measured ETA, executorCount=2; третього worker у зайнятих процесах не створено.
- Cross-process cancel фізично зупинив попередній worker; лише після exit/terminal queued стартувала рівно один раз, metadata queue зникла. HTTP залишався доступним. Старі claim/progress/terminal не переписують новий стан — попередня PG-регресія повторена.

Це доказ пункту 6 на прикладному рівні, **не** завершення балансувальника/HTTPS/HPA.

## 8. Прогноз проти факту

Нижче реальні DB calculatedAt і залишок до фактичного started_at двох різних queued jobs із фінального повного запуску. Вони не вигадані й не підганялися під модель. UTC у таблиці — точний формат API; дата звіту локальна 24.10.2026.

| Сценарій | calculatedAt (UTC) | Прогноз, мс | Фактичний залишок, мс | basis |
| --- | --- | ---: | ---: | --- |
| Два busy, далі явний cancel | 2026-10-23T21:33:13.272Z | 6355 | 61 | measured |
| Та сама queued, наступний snapshot | 2026-10-23T21:33:13.276Z | 6483 | 57 | measured |
| Та сама queued, наступний snapshot | 2026-10-23T21:33:13.282Z | 6675 | 51 | measured |
| Два busy, природне завершення | 2026-10-23T21:33:14.476Z | 6633 | 4622 | measured |
| Та сама queued, наступний snapshot | 2026-10-23T21:33:14.581Z | 5604 | 4517 | measured |
| Та сама queued, наступний snapshot | 2026-10-23T21:33:14.687Z | 6580 | 4411 | measured |

Загальний queued wait першої job — 66 мс через навмисний cancel, який estimator заздалегідь не знає; друга чекала 4624 мс до природного звільнення. Розбіжність прогнозу зумовлена ранніми sparse progress snapshots, консервативним фіналізаційним запасом і швидкістю двох паралельних потоків. Фіксованої допустимої похибки не обіцяємо. Окремо справжній нетривіальний completed із net slot duration 145,58 мс навчив same-size модель: наступна queued з одним попередником дала measured 7427 мс при одному придатному виконавці.

Ці ключові сценарії пройшли у фінальному повному запуску. Попередня спроба мала один fail інструментування тесту 11, описаний нижче; його виправлено зі збереженням assertions. Значення прогнозів закономірно відрізняються між запусками.

## 9. Фактичні перевірки

| Набір / сценарій | Pass | Fail | Skipped | Межі доказу |
| --- | ---: | ---: | ---: | --- |
| Typecheck/build | 2 | 0 | 0 | Strict server/client/tools/tests, backend/worker/SQL/Vite |
| `test:unit` | 11 | 0 | 0 | Credentials/scrypt/config/DB safety |
| `test:route` | 36 | 0 | 0 | Справжні TS/built worker, HTTP, cancel/timeout/crash/signals |
| `test:integration` | 13 | 0 | 0 | Справжні PostgreSQL auth/два процеси/Origin/Vite/resources |
| `test:jobs` | 27 | 0 | 0 | 3 config + 24 справжні PG/HTTP lifecycle/квоти/claim |
| `test:client` | 43 | 0 | 0 | 37 попередніх + 6 queue parser/format/state, контрольовані API/час |
| `test:queue`, остаточний | **26** | **0** | **0** | 3 config + 10 estimator + 1 read-budget unit + 12 PG/HTTP |
| `npm test`, остаточний | **156** | **0** | **0** | Попередні 124 + 32 нових, повний повтор |
| Реальний Chrome | **16 груп** | **0** | **0** | 14 попередніх + 2 групи ETA, production/dev |

Перший full npm test: попередні 124 й 6 нових client пройшли; queue мав 24 pass/1 fail, бо спостерігач тесту читав лише рядковий SQL, а новий timeout-helper передає QueryConfig.text. Виправлено спостерігач без послаблення LIMIT/scalar/constant-count assertions; повний повтор завершено успішно з новим deadline-тестом. Під час перегляду також усунуто неврахований auth-час перед snapshot: 8-секундний deadline починається перед авторизацією, прострочений/невалідний deadline не виконує pool.connect. Окремий unit не видається за реальну БД.

Додаткові змістовні докази: lease expiry при SIGKILL окремо від lost_after; реальний blocked heartbeat має max один SQL у польоті, late callback не оживляє stopping; registry SQL-відмова → 503/фізична зупинка/recovery; snapshot враховує 51 попередника через 4 bounded scalar SQL навіть при утриманому admission lock. Чистий максимальний snapshot — 9999 попередників +200 samples приблизно 1,57 мс у фінальному full запуску. Стара семантика атомарних особистої/загальної квот повторно перевірена.

## 10. Браузер та візуальний огляд

Використано вже працюючий локальний Google Chrome 155 через native CDP, свіжий профіль і випадкову схему окремої тестової БД. Додаткових browser залежностей не встановлювали, реальний сеанс користувача не відкривали. Фінальний запуск на актуальному rebuilt backend: **16 груп pass / 0 fail / 0 skipped**, 23 реальні jobs, 1280×900/360×900, console errors=0, JS/CSS resource failures=0, приблизно **14,80 с**. Health під час actual search відповів 200 за 0,6 мс у browser; це один локальний вимір, не гарантія затримки.

Повторено попередні 14 груп auth/parser/square/seed/result/reload/progress/cancel/quota/history/503/offline/401/keyboard/Vite. Додано unknown за paused executorCount=0, cold timeout-fallback, оновлення за actual progress, stale ETA після справжнього SQL-збою й прибирання при running/terminal. Невеликий row lock лише тестової job утримує перший збережений нульовий counter для детермінованого cold snapshot; справжній worker продовжує CPU-роботу, штучної затримки в алгоритмі немає. Мережеве offline — явно CDP fault injection; HTTP/worker не мокаються. PostgreSQL не зупинявся: відмова моделюється тимчасовим перейменуванням таблиці лише своєї схеми.

PNG unknown/fallback/measured/stale на 360 px фактично оглянуто: текст читається, ETA й причини розрізняються, немає горизонтального overflow; стара ETA явно позначена неоновленою. Скріншоти/summary тільки в ігнорованій `.local/browser-block06`, поза Git/ZIP. Після фінального rebuild browser повторено успішно; оглянуто свіжі PNG ETA unknown/fallback/measured/stale, desktop результат і mobile квадрат. Інші браузери, телефони та screen reader вручну не перевірено; це не незалежне приймання керівника.

## 11. Команди й наступна межа

Середовище: Node.js 24.18.0/npm 11.16.0, PostgreSQL 18.4 Postgres.app, роль courier_route без superuser. `npm ls --depth=0` без missing/invalid. Нових пакетів немає; повторне встановлення для реалізації не потрібне. Для чистого checkout README документує npm ci, db:start, явну міграцію, check, dev/build/start.

Перевірені команди:

```sh
npm run db:status
npm run db:migrate
npm run db:migrate:built
npm run db:check
npm run typecheck
npm run build
npm test
npm run test:queue
npm run test:client
npm run test:browser
npm run route:demo -- examples/route-small.json
npm run route:demo:built -- examples/route-small.json
```

Production startServer перевірений через справжній built harness; Vite/dev proxy — у Chrome та HTTP auth-наборі. TS і built CLI виконані: обидва completed, квадрат length=4, seed=0, order=0→1→2→3→0, 10000 ітерацій. CLI не потребує PostgreSQL; великий benchmark не повторювався, бо алгоритм незмінний. Блоки 7–10 не розпочато: балансувальник/HTTPS/Docker/Kubernetes, HPA/Metrics Server, адмінпанель і повне наскрізне приймання залишаються їм.

## 12. Git

Використано наявний main і справжню налаштовану Git-ідентичність; remote/push/global config не змінювалися, історія не переписувалася. Початкових сторонніх змін не було. Завершені логічні частини комітяться окремо після status/diff/staged diff, доречних перевірок та перевірки локальних секретів. Дев'ять постійних Git-правил збережені.

Створені змістовні коміти:

- `0ad3829 feat(queue): track executors and estimate shared waiting time`.
- `53e08dc feat(client): show server queue estimates and stale state`.
- `5dc4cb7 test(queue): cover wait estimates in real browser flows`.
- `docs: record block 6 verification results` — фінальний документаційний коміт; його хеш наведено в чаті після створення, без циклічного запису власного хешу.

Власні завершені зміни включаються до фінального HEAD, після коміту перевіряється порожній `git status --short`; фактичні гілка main/status наведені в чаті. Сторонніх початкових змін немає. Дослівне доручення містить оригінальні CRLF/пробіли: його звірено побайтово з вкладенням, форматувальні перевірки не змінюють цей текст.

## 13. Cleanup і PostgreSQL

Кожний набір закриває власні HTTP/Vite/Chrome/worker/pools, видаляє тільки свою випадкову схему та свіжий browser profile. Credentials/cookies тестів не друкуються й зберігаються в пам'яті/тимчасовому профілі, який видаляється. Робоча БД не очищувалася; `.env` і локальні DB-дані не відстежуються. Фінальний SQL підтвердив **0** схем courier_test_. Власні процеси/pools і браузерні профілі успішно прибрано; слухачів на 3000/5173 немає. Сторонні процеси не зупинялися. Окремо підтверджено checksum уже застосованої 003, побайтовий оригінал доручення та Git-правил, права `.env` **0600** й відсутність локальних DB-секретів у tracked/new файлах.

**PostgreSQL залишено працювати** на `127.0.0.1:55432`, окремий кластер проєкту. Робоча БД courier_route, тестова courier_route_test; guard не послаблено. Керування з кореня:

```sh
npm run db:status
npm run db:stop
npm run db:start
```

## 14. ZIP та зупинка

Після фінального коміту створюється `/Users/a860/Documents/CourierRoute-block-06.zip` точного HEAD. Перевіряються CRC, commit у ZIP-коментарі, повний набір і побайтовий вміст tracked файлів. `.git/.env/node_modules/dist/.local`, профілі/секрети/скриншоти/логи та сторонні untracked не включаються; push/upload не виконується.

```sh
git archive --format=zip --output=../CourierRoute-block-06.zip HEAD
open -R /Users/a860/Documents/CourierRoute-block-06.zip
```

Блокувань і необхідних ручних дій для поточного блоку немає. Блок 6 завершено; роботу зупинено **перед блоком 7**, до нового доручення.
