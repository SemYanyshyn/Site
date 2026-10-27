# Обережне очищення коду — 27.10.2026

## Початковий стан і межі

Репозиторій `/Users/a860/Documents/Site`, гілка `main`, HEAD `2d78e83c173331aaa8d7a1df09b6dc9135e7de56`. На старті вже були незакомічені зміни `scripts/deployment-command.mjs` та `src/server/route/algorithm.ts`; їхні початкові bytes збережені й не редагувалися цим завданням. Snapshot усіх 171 tracked-файлів, початковий diff і результати до/після зберігаються в ignored `.local/cleanup-verification/`.

Прочитано AGENTS, оригінал завдання викладача, матрицю приймання, README, PROJECT_PLAN і звіт 10. Погоджені рішення й історичні докази не видаються за нові перевірки. Ця робота не є новим повним прийманням усіх вимог 1–8. Коміти, push і оновлення основного демо не виконувалися.

## Фактичні зміни

| Файл | Що спрощено та доказ |
| --- | --- |
| `src/shared/admin.ts` | Видалено `adminFinite()`: у tracked code/tests/scripts/config єдиним входженням було її оголошення. Імпортів, реекспортів, динамічних викликів не знайдено. |
| `src/server/jobs/repository.ts` | Прибрано невикористаний `JobClaim.timeoutMs`, перетворення і `timeout_ms` з claim RETURNING. Споживачі dispatcher/tests читають тільки id/input/claimToken. Прибрано `failure_message` з внутрішнього SummaryRow і summary/detail SELECT/RETURNING, бо публічне повідомлення визначає тільки FAILURE_MESSAGES[failure_reason]. |
| `src/client/auth-ui.ts` | `send()` повертає перевірений AuthResponse або null для 204. Login/restore перевіряють тільки null замість повторного isAuthResponse; повна перевірка зовнішнього unknown JSON залишається у send без нового as. |
| `src/client/response.ts` | Прибрано чотири повторні shape/order guards у result; незмінна closedRouteLength повністю перевіряє масив, розмір, замкненість, усі індекси/доставки, унікальність і довжину обох маршрутів. |
| `src/server/route/executor.ts` | Одна локальна closedRouteLength перевіряє order/initialOrder і рахує евклідову суму в тому самому порядку. Окремі tolerance й initialTolerance збережено дослівно; серверна й браузерна перевірки не об'єднувалися. |
| `src/shared/auth.ts` | Один масив Unicode code points замість двох; довжина, непарні сурогати, пробіли, межі й пароль без нормалізації збережені. |

Власний diff коду: **6 файлів, +38/−55 рядків**, без масового форматування. Залежності не змінено.

## Що залишено і чому

`initial-route.ts` і `route-geometry.ts` залишено окремими: повідомлення й порядок помилок різні, додаткові перевірки відстаней та діапазону теж різні. Спільний параметризований helper ускладнив би ці невеликі функції.

Додатковий пошук не підтвердив інших невикористаних src-файлів або runtime-експортів. Перевірено static imports/реекспорти, dynamic import/new URL, worker entrypoints, npm scripts, Docker COPY/build, CLI, benchmark, тести й deployment. `main.ts` — HTML entrypoint; db/check.ts, route/cli.ts і route/bench.ts запускають npm-команди. Усі runtime/dev-залежності мають підтверджені застосування; `npm ls --depth=0` успішний. Локально використані export-константи/config/errors не видалялися.

## Збережені перевірки й контракти

Не змінено SQL 001–004, колонки й записи timeout_ms/failure_message, lost_after, readiness, модель черги, FAILURE_MESSAGES, runtime-контракти API, статуси/HTTP-коди/тексти, числові допуски й ліміти. Claim token/advisory lock/SKIP LOCKED, ownership/role/session guards, bounded SQL, worker termination/cancel/progress/finalization/heartbeat, тестові injection points і HPA/namespace/owner safety збережені.

Алгоритм пошуку не редагувався: поточні користувацькі bytes algorithm.ts збережені. Також незмінні initialOrder/legacy, геометрія/HTML/CSS/центрування, deploy:status/verbose, npm scripts, Dockerfile і lock. Усі tests/fixtures/check-скрипти збережено, skip/assertions не змінено. Незмінність захищених файлів перевіряється проти початкових SHA-256.

## Фактично виконані перевірки

Host Node.js 24.18.0/npm 11.16.0; окрема PostgreSQL 18.4: фактичні `127.0.0.1:55432/courier_route_test`, role без superuser/createdb/createrole. Перед тестами guard звірив host/port/database з робочою адресою. Немає очищення робочої БД: наявні suites використовують випадкові тестові schemas.

| Перевірка | До очищення | Після очищення |
| --- | --- | --- |
| npm run typecheck / npm run build | PASS / PASS | PASS / PASS |
| npm test | 253/253 PASS, 106766 мс | 253/253 PASS, 106825 мс |
| Розклад npm test | 50 unit/safety +45 route/HTTP +13 auth PG +27 jobs +66 client +26 queue +26 admin | Той самий; 193 non-DB +60 PG, 0 fail/cancel/skip |
| TS та built route:demo, examples/route-small.json | Обидва PASS | Обидва PASS |

Чотири CLI payload до/після однакові за винятком виміряного elapsedMs: best та initial order `[0,1,2,3,0]`, обидві довжини 4, seed 0, 10000/10000 ітерацій. Додатковий controlled DOM/fetch differential імпортує справжні baseline/current mountAuth і parseJobDetails: **49 auth-сценаріїв +137 parser-кейсів еквівалентні**, включно з 204/malformed/401/503/abort/timeout/stale відповідями. Це не браузер і не доказ спільності сесій; такі сценарії окремо перевіряються реальними PG/Chrome suites.

Новий source image `courier-route:block07-4d1e660f6e5246cc`, Docker config ID `sha256:d6d1a272fd4840bfd89fc64b8d23928096d4dd0c02768bfc7bda515ec718f69c`, зібрано через наявний image:build; він використовується тільки ізольованими drivers, основний app лишається на попередньому image.

| Додаткова регресія після очищення | Фактичний результат |
| --- | --- |
| npm run test:browser | 16/16 Chrome production/dev груп PASS; 23 справжні jobs, desktop 1280 і 360 px, console/static errors 0; 14231 мс wall, власні HTTP/Chrome/schema прибрані. |
| npm run test:container -- courier-route:block07-4d1e660f6e5246cc | 8/8 PASS, cleanupErrors 0; 3110 мс. |
| npm run test:deployment | 10 static/API/fault +9 HTTPS Chrome груп PASS, cleanupCompleted true; 122879 мс wall, convergenceGatewayFailures 0. Власний namespace courier-route-test-e182037dca прибрано. |
| npm run test:admin:deployment | 7 admin HTTPS/RBAC/Chrome груп PASS, cleanupCompleted true; 122141 мс wall. |
| npm run test:autoscale | 10/10 HPA груп +4 owner Chrome observations PASS; реальний цикл 2→4→3→2, C/D positive progress→completed valid route, repeat при4, missing-metric/recovery і stop/start. 546310 мс work +15597 мс cleanup =561907 мс driver (562052 мс wall), cleanupCompleted true. |
| npm run deploy:status та -- --verbose | Обидва exit 0, лише читання. Основне демо: app 2/2, Traefik 1/1, PostgreSQL 1/1, Metrics API Available, нормальний CA-verified HTTPS readiness 200. |

Фактично оглянуто local Chrome desktop-result.png і mobile-result.png: початковий/найкращий порядок і довжини, закритий блок кроків, SVG та перенесення читабельні. Решта PNG створені drivers; їхня наявність сама по собі не вважається ручним візуальним прийманням. Історичні screenshots/results не зараховувалися як нові.

Фінальний HPA підсумок: **74 accepted =73 completed +1 intentional cancelled, 0 failed**. Перед stop/start останній timeline містить 73 задачі (72 completed/1 cancelled); після restart прийнято й перевірено ще один completed square, тому acceptedJobs=74. Максимум 4 nonterminating/4 physical pod, рестартів app у вимірюваній фазі 0, transport failures 0; робота 500/200 млн виконувалася за незмінних production-лімітів. Browser/containers/static/admin/HPA виконано послідовно, на тому самому новому образі та тільки disposable ресурсах. Нові runtime summaries: `.local/deployment-tests/eb0310dc-dca1-4b6b-94cb-e24637686d1a/summary.json`, `.local/admin-tests/bc18fd92-40c9-4815-a785-76be3156bff5/summary.json`, `.local/autoscale-tests/67bbd3d0-8083-471e-85e6-4b241625c0aa/summary.json`.

З доручених команд і вибраних регресій **BLOCKED/невиконаних немає**. Окремий benchmark CLI не запускався: його код/команда, генератор і алгоритм не змінювалися, але справжнє навантаження 500/200 млн пройшло HPA. Нового повного приймання 1–8 чи незалежного приймання керівником цей звіт не заявляє.

## Ресурси й Git

Фінальний read-only аудит **PASS**: основне демо не оновлено; app image `courier-route:block07-709754235fbcf690`, Deployment UID/generation, PostgreSQL pod UID/restarts, PVC UID, CA/credentials checksums і digest усіх збережених job payload збігаються до/після. Робочі дані незмінні: 1 користувач, 1 сесія, 125 задач, 124 результати, 0 active. Фінальний статус: app 2/2, Traefik/PG 1/1, Metrics API Available, HPA2/min2/max4, CA-verified HTTPS readiness200. Три власні test namespaces/PVC прибрані; їхні Chrome-профілі/тимчасові HTTP/forwarding завершені drivers. Працюючі Colima/kind, shared Metrics Server та окремий host PostgreSQL залишено працювати; host PG керується `npm run db:status`, `npm run db:stop`, `npm run db:start`.

Зіставлено SHA-256 76 захищених файлів: попередні користувацькі algorithm/deployment helper, усі tests/fixtures/check-скрипти, міграції/manifests, lock/package/Dockerfile, README/AGENTS/оригінал/матриця/звіт10 та незмінні UI HTML/CSS/геометрія/кроки. Змін серед них немає. Фінальний git diff --check PASS; підготовлених до коміту змін немає.

На цьому завданні комітів/push немає; гілка main. Власні зміни залишаються незакоміченими за прямим дорученням користувача; попередні два файли збережено.

## Diff відносно HEAD

Наведений `git diff --stat` включає дві попередні користувацькі зміни deployment-command.mjs та algorithm.ts; вони не є результатом очищення. Новий untracked `docs/cleanup-report.md` показано окремо, Git index не змінювався.

```text
 PROJECT_PLAN.md                |  2 +
 scripts/deployment-command.mjs | 90 ++++++++++++++++++++++++++++++------------
 src/client/auth-ui.ts          |  6 +--
 src/client/response.ts         |  4 --
 src/server/jobs/repository.ts  | 10 ++---
 src/server/route/algorithm.ts  | 60 ++++++++++++++++++----------
 src/server/route/executor.ts   | 65 +++++++++++++-----------------
 src/shared/admin.ts            |  3 --
 src/shared/auth.ts             |  5 ++-
 9 files changed, 144 insertions(+), 101 deletions(-)
```

Додатково: `?? docs/cleanup-report.md`. Власний diff без попередніх користувацьких файлів: 6 code-файлів +38/−55 та два рядки PROJECT_PLAN і цей новий звіт.

Остаточний `git status --short`:

```text
 M PROJECT_PLAN.md
 M scripts/deployment-command.mjs
 M src/client/auth-ui.ts
 M src/client/response.ts
 M src/server/jobs/repository.ts
 M src/server/route/algorithm.ts
 M src/server/route/executor.ts
 M src/shared/admin.ts
 M src/shared/auth.ts
?? docs/cleanup-report.md
```
