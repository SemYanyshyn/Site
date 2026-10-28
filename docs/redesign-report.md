# Courier Route — візуальний редизайн і SCSS

Дата: **28.10.2026**, Europe/Kiev. Початковий HEAD `49c519b`, гілка `main`. Виконано окреме доручення з оформлення, без нових продуктових можливостей, комітів або push.

## Початковий стан і збереження інформації

Прочитано AGENTS, оригінал викладача, матрицю, README, PROJECT_PLAN, звіт10 і останній звіт очищення. Історичне приймання не зараховується як поточна перевірка.

На старті вже були зміни `scripts/check-autoscale.mjs`, `scripts/deployment-status.mjs`, `scripts/local-postgres.mjs`. Їхні bytes/diff/SHA-256 збережені в ignored `.local/redesign-verification/`; ці файли не редагувалися виконавцем. Додаткове форматування HTML/main.ts/SCSS збережено. У робочому стані також є 14 видалених рядків коментарів algorithm.ts, які вже існували перед продовженням роботи: їх не чіпали, normalized ES2023 executable code побайтово еквівалентний початковому. Три попередні scripts побайтово незмінні; усі 116 захищених файлів, крім зазначених коментарів, збігаються з початковим snapshot.

Після створення власного ignored SCSS-draft автоматично з'явилися `css/styles.css(.map)`: source map вказував тільки на цей тимчасовий draft. Копія не імпортувалася застосунком; власні тимчасові drafts/генеровані копії прибрано після перенесення у src. Джерела стилів застосунку тепер тільки SCSS; згенерований production CSS лишається у dist.

До змін зафіксовано 104 DOM ID, 47 control signatures, 112 текстових вузлів і 3 наявні details. Порівняння після редизайну: **PASS**, жодних втрачених ID/атрибутів/controls/текстів і нових дублів ID, розгортань лишилося3. Повні попередні labels і тексти admin/jobs/auth збережені. Додано видимий підпис групи параметрів; нових прихованих вкладок/акордеонів немає.

Контрольований baseline/current admin renderer у12 станах підтвердив ті самі **13 label/value пар** кожної картки, pod/process IDs, badge text та решту моніторингового виводу. Це перевірка DOM, не заміна реального Chrome.

## Реалізація

- Світлий нейтральний фон, білі картки, темно-зелений акцент, контрастніші підписи, спільні рамки/кнопки/поля/повідомлення й помірні радіуси; мінімальні тіні.
- Центрована auth-картка й вступ зі спільною віссю; тексти/поля форми зліва. Усередині застосунку — чіткі заголовки, читабельні метадані та повні monospace UUID/pod names.
- Форма маршруту згрупована на склад, доставки й параметри. Initial/best route мають окремі видимі блоки; порядок, довжини, steps/return, схема, saved input і legacy-повідомлення збережені.
- Адмінпанель: зведення → джерела/HPA → сервери/інші executor records → усі jobs. Зведення перебудовується4/2/1 на1280/900/360. Серверна картка має чотири видимі групи: ідентифікація, стан/слот, CPU/RAM/request/limit, часові дані.
- Збережено hidden/disabled/aria/data/event hooks, списки, фільтри, пагінацію, refresh, errors/loading/empty/stale та клавіатурний focus. Немає ellipsis/line-clamp або нових обмежень висоти адмінкарток. Існуючі scroll areas маршрутів/таблиці/координат лишилися доступними.

Виконувана логіка сервера, shared-контракти, алгоритм/seed/бюджети/допуски, авторизація/ролі, queue/ETA, worker, SQL-схема, HPA й балансування не змінені. SVG geometry і client controllers/API незмінні; TypeScript змінено тільки для DOM-групування та імпорту стилів. Звичайний ручний login створив одну сесію, а дозволена перевірка через UI — одну нову задачу; це штатні дії, а не зміна логіки чи старих записів.

## SCSS, залежності й шрифти

`src/client/styles.scss` підключає сім partials у `styles/`: `_tokens`, `_base`, `_layout`, `_components`, `_auth`, `_jobs`, `_admin`. Використано `@use`, спільні кольорові tokens, font stacks та breakpoint variables, без framework/mixin-системи і deprecated `@import`. Старий авторський `src/client/styles.css` видалено, main імпортує SCSS.

Додано лише pinned **sass1.106.1 devDependency** і його transitive/optional lock entries. **0 попередніх версій залежностей змінено**, npm scripts незмінні. Вбудовану [підтримку SCSS у Vite](https://vite.dev/guide/features#css-pre-processors) перевірено з [Dart Sass](https://sass-lang.com/install/); Dockerfile уже копіює src і встановлює devDependencies під час build, тому його не змінено. Runtime отримує тільки готові assets.

Локальних файлів Inter у проєкті/локальних Fonts не знайдено: фактичний шрифт — якісний системний sans-serif; UUID/pod — системний monospace. Файлів стороннього шрифту не копіювали, окрема ліцензія Inter не додається. Font CDN requests =0.

Два незмінні наявні checks вимагають dev `/styles.css`. Невеликий Vite-only шар перенаправляє canonical SCSS request на сумісний CSS URL і віддає його через нормальний Sass/HMR pipeline. Немає дубльованого authored CSS або старого import; query/HMR, API proxy `^/api(?:/|$)` та production paths збережені. Реальний Chrome/Vite fixture підтвердив CSS/JS MIME, `/api.ts`, `/styles.css`200, `@use` partial HMR без reload/втрати введення та cleanup.

## Поточні перевірки та проміжні результати

Використано справжню окрему PostgreSQL `127.0.0.1:55432/courier_route_test` з guard порівняння проти робочої БД, роль без superuser/createdb/createrole. Наявні fixtures/assertions/tests/check scripts не редагувалися.

Baseline: build і 16 local Chrome груп PASS. Baseline admin driver пройшов 5 груп, але під час intentional container restart GET отримав 502, і незмінний assertion, що очікує `Cache-Control: no-store`, зупинив прогін. Прямий такий самий HTTP502 підтверджено у збереженій діагностиці останнього післязмінного прогону. Саме значення заголовка старої gateway-відповіді не збережено, тому його відсутність не стверджується. Два проміжні logs містять phase/assertion location, але не мають збережених failure.json; їхній точний HTTP-код не вигадується. Дві додаткові спроби зупинилися до тестів через відсутній image після змін source fingerprint; образ перебудовано, жоден assertion не послаблено.

Перший візуальний кандидат мав дві знайдені проблеми: на360 четверта колонка steps вимагала горизонтального scroll, а загальна admin error notice лишалася зеленою. Виправлено SCSS: чотири колонки поміщаються, перші два стовпці не розривають заголовки/номери; error має окремі текст/колір. Попередні35 PNG/summary збережені в attempt-каталогах, не видаються за остаточні.

| Фактично виконано в цьому дорученні | Результат |
| --- | --- |
| npm run typecheck / npm run build / npm run test:client | PASS / PASS /66 з66 PASS; повторено після остаточних CSS-виправлень. |
| npm test з окремою реальною PG | 253/253 PASS =193 non-DB+60 PG,0 fail/cancel/skip,107627 мс фінальний прогін; unit50/route45/auth13/jobs27/client66/queue26/admin26. |
| TS та built route:demo examples/route-small.json | Обидва PASS: order/initialOrder0→1→2→3→0, length/initialLength4, seed0/10000 ітерацій. |
| npm run test:browser | Фінальні16/16 Chrome production/dev груп PASS, console/static errors0, schema/Chrome/Vite cleanup. |
| npm run test:container — актуальний image | 8/8 PASS, cleanupErrors0; HTML/JS/CSS, auth, compiled worker, physical shutdown. |
| npm run test:deployment — перший c60-кандидат | 10 deployment/fault +9 HTTPS Chrome груп PASS, cleanuptrue,122676 мс driver. Пізніші зміни лише presentation CSS та збережені коментарі; це не повторений static fault-прогін на фінальному image. |
| Supplemental native Chrome — фінальне оформлення | 7/7 груп,35/35 PNG,35 layout assertions PASS; усі35 PNG фактично оглянуто. NormalTLS, consoleExceptions0, failedAssets0, externalFonts0, cleanuptrue. |
| Vite/Sass compatibility і HMR | PASS у реальному Vite+Chrome fixture, normal Sass pipeline, partial HMR, збереження введення/query, cleanuptrue. |
| Повний test:admin:deployment | **FAIL**: чотири фактичні прогони (один baseline і три після змін) зупинилися після 5 успішних груп у phase intentional container restart, assertion Cache-Control у script:191. Для baseline і останнього after є прямі HTTP502 traces; для двох проміжних — лише log/phase/assertion, без збереженого failure.json. Ще 2 спроби завершилися до тестів через missing image; це не PASS/skip. Останній failed run `.local/admin-tests/18099930-fc2b-4346-82c5-95264a88e6e9/failure.json`. Фінальні 2 групи цього driver не завершені й не зараховуються як успіх. |

Повний HPA load/stress cycle2→4→2 не повторювався: HPA/черга/алгоритм/ліміти не змінювалися виконавцем; реальний HPA min/max/current/conditions та джерела перевірено у власному idle autoscaling namespace. Це візуальна регресія, не нове повне приймання1–8. Наявні tests/fixtures/assertions/check scripts не послаблювалися.

Фінальні UI-знімки належать image `courier-route:block07-4e03813ab69e19a1`. Після стороннього видалення коментарів зібрано актуальний `courier-route:block07-dd5a65b2b28354ae`; усі3 compiled client assets(HTML/JS/CSS) побайтово однакові з візуально перевіреним image, normalized algorithm executable теж однаковий. Актуальний image пройшов container8. Доказ: `.local/redesign-verification/image-equivalence.json`.

Візуально оглянуто1280 і360: login/register, form/lists/progress/result, steps/saved inputs/500/legacy, admin summary/HPA/sources/full cards/loading/empty/error/stale. На900 додатково сітка2 колонки, на1280/360 —4/1. На360 всі4 колонки steps без horizontal scroll;1004 клітинки перших двох колонок500-point таблиці мають nowrap без обрізання. Focus видимий, випадкового page overflow/ellipsis/line-clamp немає. Помилки503 керовано відтворювалися через CDP; stale metrics — справжнім тимчасовим403 namespaced RBAC з відновленням. Успішні показники/маршрути не підроблялися.

Before/after та невдалі проміжні candidates збережено в `.local/redesign-verification/`; фінальні screenshots — `supplemental/`, докази — `supplemental-summary.json`, `visual-review-final.json`, `semantic-comparison.json`. Конкретні PNG для перегляду: `supplemental/login-1280.png`, `register-360.png`, `routes-example-steps-saved-1280.png`, `routes-example-steps-saved-360.png`, `admin-overview-1280.png`, `admin-full-server-360.png`.

## Перевірка характеру 502 перед завершальним deployment

За новим дорученням використано збережені журнали, без повтору повного driver. Audit: `.local/redesign-verification/fault-evidence-audit.{json,md}`. Порівняння умов: той самий `kind-courier-route`, власні static namespaces, `autoscaling:false`, 2 app replicas, personal3/global4; 22 helpers/config/build-файли побайтово однакові. Actual resources у retained before/after та recovery однакові: request250m/128MiB, limit1CPU/384MiB. Усі 42 compiled server/shared JS-модулі baseline image4d1 та актуального dd5 мають однаковий normalized executable code; доказ — `completion/backend-equivalence.json`. Це еквівалентна конфігурація й backend, не твердження про ідентичні wall-clock load, metrics age, випадкові UUID чи scheduling. Повних live manifests старих невдалих runs не збережено.

Обидва прямі HTTP502 спостерігаються після навмисного SIGKILL у фазі container restart. До цього успішно працювали звичайні auth/jobs/admin/RBAC/Chrome сценарії. `status0/ERR_ASSERTION` після HTTP502 — catch-запис того самого assertion, а не друга мережева відмова. Старі traces після502 закінчуються: останній overview був отриманий до помилки, registry доводив новий процес, але не Ready/HTTP recovery. Цю прогалину не підмінено припущенням.

Додано лише одну вузьку перевірку відновлення у власному `courier-route-test-recovery-96db92d1`, без змін існуючих scripts/tests. Один guarded idle SIGKILL зберіг pod UID, збільшив restart0→1 і змінив process UUID. Через **3506 мс** підтверджено 2 Ready/2 EndpointSlice endpoints/2 свіжі idle executors. Після convergence усі шість endpoint (ready, auth/me, admin overview/jobs, history, старий result) реально обслужили **обидва поточні UUID**, HTTP200/no-store; сесія, роль і старий результат збережені, один новий POST202 завершився correct completed. У цьому окремому fault-вікні всі 8 записаних GET були200: **502 цього разу не відтворився і не вважається виправленим**. Це окремий recovery PASS після того самого restart, не продовження старого failing run і не PASS повного driver. 29 HTTP traces/9 Kubernetes snapshots/raw fault responses збережено в `fault-recovery-observation.json`; work20300мс/cleanup15116мс, namespace/PVC/forwarding прибрані.

Сукупність before/after, executable/config equivalence та recovery свідчить про попередню проблему fault-сценарію, а не виявлену регресію редизайну. За явним дозволом користувача після цього виконано штатний deployment; повний driver залишено **FAIL**. Root cause gateway502 та повний fault/admin набір цим дорученням не виправлялися й не переприймалися.

## Локальне демо, ресурси й Git

Перед deployment зафіксовано1 користувача(admin),1 сесію,127 задач,126 результатів,0 active; digests identity/role/session lifetimes/job payload, PostgreSQL pod/PVC UID/restarts, CA/credentials checksums і app Deployment UID/generation. Перевірки/fixtures працюють тільки у випадкових власних schemas/namespaces, без змін робочих даних або ролей.

**Редизайн доступний у https://localhost:8443/.** `npm run deploy:local` завершився exit0 за4436мс, source image `courier-route:block07-dd5a65b2b28354ae`. На початку цього продовження main уже використовував цей image; штатний повтор узгодив стан без зайвого rollout: Deployment generation15→15/UID збережені. До/відразу після workflow — 1 користувач(admin),1 чинна сесія,127 задач,126 результатів,0 active, усі попередні payloads однакові. PostgreSQL pod UID/restarts, PVC UID, CA/leaf/keys та credentials checksum незмінні. Докази: `completion/predeploy.json`, `deployed.json`, `deploy-local.log`.

Фактично перевірено після deployment у main, а не тестовому namespace:

| Перевірка | Фактичний результат |
| --- | --- |
| HTTPS/readiness/стан | Normal CA/hostname TLS, HTTPS readiness200; app2/2, Traefik1/1, PostgreSQL1/1, Metrics API Available, HPA current2/min2/max4. |
| Існуючий користувач | Користувач вручну ввів credentials у власному тимчасовому headful Chrome; зафіксовано справжній login200, auth/me200, той самий user UUID та початкова роль admin. Пароль/cookie/storage не читалися й не логувалися; пароль/роль не змінювалися. |
| Попередні дані | Усі 127 owner history IDs/statuses доступні через API; усі 126 original result canonical SHA-256 збігаються. Старий 500-point/200млн результат відкрито в UI на1280/360. |
| Адміністрування | Відкрито реальний main admin, actual fresh CPU/RAM/HPA, обидва процеси, усі13 полів кожної картки/повні UID/UUID; огляд на1280/360. |
| Один новий маршрут | Рівно1 POST, справжній202 → completed; job `2ad94436-8615-405a-91b3-28127f478735`, 5 доставок/25000/seed0. InitialOrder0→1→2→5→4→3→0, initial29.41492209332022, best28.941677986860125; усі6 переходів/повернення/збережений input/SVG. Reload не створив нового POST. |
| Зібрані assets | HTML/JS/CSS HTTP200, MIME коректний, JS69503B/CSS22704B побайтово відповідають dist. `/assets/index-44z78C-7.js`, `/assets/index-COh2ER0j.css`; доказ `completion/https-assets.json`. Console exceptions/errors, failed assets, mixed content, external fonts —0. |
| Вигляд/доступність інформації | 14 нових full-card PNG основного демо на1280/360 фактично оглянуто; немає page overflow/ellipsis/line-clamp, усі поля й дії доступні. Focus області steps видимий; джерела зведення мають справжні timestamps. |
| Збереження після ручної перевірки | 1 початковий user/role і чинна сесія збережені; login штатно додав1 сесію, UI —1 completed route. Фінально **128 задач/127 результатів/2 сесії/0 active**. Усі127 попередніх payloads/126 results та PostgreSQL/PVC/TLS/credentials незмінні. Expired sessions не видалялися. |

Докази: `post-deployment-summary.json`, `post-demo-route-guard.json`, `completion/verified.json`, `completion/final-status.log`, `completion/visual-review-final.json`, `completion/visual-review-agent.json`. Моніторингові PNG зняті до створення останньої контрольної задачі, тому містять126 completed; фінальні дані після неї —127 completed/1 cancelled. Це різні моменти, не одна атомарна мить. Знімки `post-deployment/new-route-completed-1280.png` і `new-route-completed-360.png` показують останній результат.

Повторно всі 253 тести/повні browser/container/static suites на цьому продовженні не запускалися: використано вже наявні результати і перевірено лише відсутнє recovery та явно доручені main-сценарії після workflow. Повний admin/fault driver **залишається FAIL**, assertions/skip/безумовні retry не додавалися.

Комітів/push немає, гілка main. Тимчасові HTTP/Vite/Chrome/fixtures/namespaces прибрані drivers; власний fresh Chrome/profile після ручного входу закрито без logout, інших вікон не торкалися. Host PostgreSQL, власний Colima/kind і shared Metrics Server залишено працювати. Host PostgreSQL керується окремо командами `npm run db:status`, `npm run db:stop`, `npm run db:start`.

## Підсумковий diff і статус після завершення deployment

Попередні три user-файли: **+2178/−604** рядки — check-autoscale(+1647/−407), deployment-status(+367/−127), local-postgres(+164/−70). Пізня стороння зміна algorithm.ts: **+0/−14**, лише коментарі. Решта tracked diff редизайну/документації, включно зі збереженим форматуванням HTML/main: **9 файлів,+1145/−432**; додатково8 нових SCSS файлів(+1282 рядки) і цей untracked звіт.

```text
 PROJECT_PLAN.md               |    2 +
 README.md                     |    4 +
 package-lock.json             |  398 ++++++++
 package.json                  |    1 +
 scripts/check-autoscale.mjs   | 2054 +++++++++++++++++++++++++++++++++--------
 scripts/deployment-status.mjs |  494 +++++++---
 scripts/local-postgres.mjs    |  234 +++--
 src/client/admin-view.ts      |   92 +-
 src/client/index.html         |  657 +++++++++++--
 src/client/main.ts            |  151 ++-
 src/client/styles.css         |  249 -----
 src/server/route/algorithm.ts |   14 -
 vite.config.ts                |   23 +
 13 files changed, 3323 insertions(+), 1050 deletions(-)
```

Нові SCSS/звіт ще не відстежуються, тому звичайний git diff --stat їх не рахує. Git index не підготовлювався, git diff --check PASS, HEAD49c519b/main незмінний. Остаточний git status --short:

```text
 M PROJECT_PLAN.md
 M README.md
 M package-lock.json
 M package.json
 M scripts/check-autoscale.mjs
 M scripts/deployment-status.mjs
 M scripts/local-postgres.mjs
 M src/client/admin-view.ts
 M src/client/index.html
 M src/client/main.ts
 D src/client/styles.css
 M src/server/route/algorithm.ts
 M vite.config.ts
?? docs/redesign-report.md
?? src/client/styles.scss
?? src/client/styles/
```

## Подальше доручення: Git-фіксація

28.10.2026 користувач окремо доручив створити коміти поточного стану та push на GitHub. Попередні згадки «без комітів/push» і наведений status описують стан на завершення редизайну до цього доручення. Перед фіксацією повторено typecheck/build і 66 клієнтських тестів — PASS; git diff --check — PASS. Три раніше змінені scripts та algorithm.ts мають той самий normalized executable code, що й початковий HEAD. Їх зафіксовано окремо від редизайну. Збережені результати повного admin/fault driver лишаються **FAIL**; новий повний прогін не виконувався. Секрети, локальні дані та знімки з ignored .local не включаються до комітів.
