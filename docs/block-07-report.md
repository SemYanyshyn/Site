# Звіт блоку 7 — Docker, Kubernetes, Traefik і HTTPS

Дата: 24.10.2026, Europe/Kyiv. Поточний блок: **7**; наступний блок 8 не виконувався.

**Статус: готово, перевірено виконавцем. Заблокованих сценаріїв блоку 7 немає.** Незалежне приймання керівника для цього нового блоку ще не виконувалося. Межі локального середовища й browser trust описано нижче.

## Обсяг і джерела

Виконано нове явне доручення `CourierRoute_Block_07_Codex.txt`; його копія в корені побайтово збігається з наданим файлом. Оригінальні вимоги викладача в `docs/assignment.txt` відділені від проєктних рішень та організаційних Git-правил. Історичні звіти 1–6 не переписано.

Блок 6 прийнято керівником: він перевірив ZIP зі 111 файлами на `f6c528f5b4b1602a201027bf015f83fd9e53a238`, код та 25 захищених файлів; незалежно повторив npm ci/typecheck/build, **107 non-DB** (11 unit + 36 route/HTTP + 3 jobs config + 43 client + 14 queue config/estimator/read-budget), TS/built CLI, production/dev HTTP. **49 PG**, **16 Chrome** й огляд PNG підтверджені виконавцем; керівник їх не повторював і PNG не оглядав. Це приймання записано в актуальних AGENTS/PLAN, без зміни історичного звіту 6.

## Середовище й образи

| Компонент | Фактично перевірено |
| --- | --- |
| Host | macOS 26.6.2, Darwin 25.6.0, arm64, Apple M5; 10 logical CPU, 24 GiB RAM |
| Node/npm host і app image | 24.18.0 / 11.16.0 |
| Runtime | Colima 0.10.3, Lima 2.2.0, власний profile `courier-route`, VZ/virtiofs, 6 CPU/8 GiB/40 GiB data disk |
| Docker | CLI 29.7.2, справжній daemon 29.5.2; global context лишився `default` |
| Kubernetes | kind 0.32.0, server 1.36.1 linux/arm64, kubectl 1.36.3 darwin/arm64 |
| TLS/browser | OpenSSL 3.6.3; Google Chrome 155.0.8059.85, native CDP/headless |
| PostgreSQL/Traefik | 18.4 / 3.7.15; локальні JSON manifests, без Helm/CRD |

Docker/Colima/kind/kubectl спочатку були відсутні. Встановлено Homebrew-пакети `colima docker kind kubernetes-cli`; запущено тільки власний Colima profile з `--activate=false`. Чужі кластери/служби не змінювалися. Docker перевірено запитом до daemon, а не лише наявністю CLI. Нових npm-залежностей немає, `package-lock.json` незмінний. Homebrew Docker build використав наявний legacy builder із попередженням про buildx; реальний build завершився успішно. npm allow-scripts попередження не завадили фактичним typecheck/build/test.

Точні multiarch pins і офіційні джерела — [deploy/versions.json](../deploy/versions.json):

- Node: `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
- Kind node: `kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5`.
- PostgreSQL: `postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`.
- Traefik: `traefik:v3.7.15@sha256:0f6150202bc1fed72a7bd2107460eaa510e5b8a905f3fdb5b84f2c8619c33368`.

Фінальний app tag: `courier-route:block07-1b9f0947d1e6d4e8`, фактичний image ID `sha256:8767055350c38056a93d993ab1cc9cea26c0f45154e0024737a6b7a56ef77442`, linux/arm64, Docker Size **81 143 148 байтів**. Це локальний content-tag; registry push не виконувався.

Технічні рішення звірено з офіційними [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [kind port mappings](https://kind.sigs.k8s.io/docs/user/configuration/), [PostgreSQL image/PGDATA](https://hub.docker.com/_/postgres), [Traefik Kubernetes Ingress](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress/) та [Kubernetes probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/).

## Реалізація

Нові файли: Dockerfile/allowlist `.dockerignore`, `deploy/versions.json`, kind config, 7 JSON-маніфестів у `deploy/k8s`, deployment/container/HTTPS-browser drivers, deployment safety tests, доручення 7 і цей звіт. Змінено server config/index/app, HOST/config/HTTP fixtures і тести, `.env.example`, package scripts, `.gitattributes`, README/PLAN/AGENTS. Клієнт, алгоритм, executor, CLI й застосовані SQL не переписувалися. Перевірено **28 захищених файлів** проти початкового HEAD: assignment, старі доручення/звіти, SQL 001–003, lock, route code/shared route — без змін. Усі дев'ять Git-правил AGENTS збережені дослівно. Whitespace-check власних файлів пройшов; наданий prompt 7 має оригінальні CRLF/кінцеві пробіли в цитаті завдання, тому його виключено з форматувальної перевірки й звірено побайтово без редагування.

Multi-stage build використовує `npm ci`, компілює server/worker/Vite client, копіює SQL/examples; production dependencies встановлюються окремо. Runtime UID **1000**, exec-form Node PID 1, немає app source, TS/tsx/Vite/dev dependencies, bind mounts або секретів образу. Built CLI працює з `/tmp` і порожнім env, length=4/seed=0. Локальний HOST default **127.0.0.1**, контейнер **0.0.0.0**; інші значення відхиляються. API header `X-Instance-Id` завжди містить UUID реального handler, включно з помилками; підставлені клієнтом/forwarded значення не копіюються.

```text
browser / API client
   │ HTTPS localhost:8443 (HTTP :8080 → HTTPS)
   ▼
Traefik → app pod A / app pod B (HTTP :3000, 1 executor/worker на процес)
                    │ PostgreSQL TCP, Service DNS postgres:5432
                    ▼
          окремий PostgreSQL 18 + PVC 2 GiB
```

Власні cluster/context **courier-route / kind-courier-route**, kubeconfig `.local/deploy/kubeconfig`, demo namespace **courier-route**. Усі kubectl-команди мають явні kubeconfig/context/namespace. Kind API і host ports — loopback; NodePort **30080/30443** відповідає mappings **8080/8443**. Порти конфігуровані до першого створення й перевіряються без зупинки чужих процесів. Test deployment використовує окремий випадковий namespace, PostgreSQL/PVC/test DB та Traefik, доступний через власний loopback port-forward із вільними портами.

App Service ClusterIP без affinity; Traefik `nativeLB=false` обирає реальні ready pod endpoints, provider/RBAC namespace-scoped із явною annotation class. Немає dashboard, retry POST, sticky sessions, публічного routing-to-instance endpoint. `allowEmptyServices=true` дозволяє справжній 503 за відсутності Ready endpoints.

| Ресурс | requests CPU/RAM | limits CPU/RAM |
| --- | --- | --- |
| Кожен app, 2 replicas | 250m / 128Mi | 1 CPU / 384Mi |
| PostgreSQL | 100m / 128Mi | 1 CPU / 512Mi |
| Traefik | 50m / 64Mi | 500m / 192Mi |
| Migration Job | 100m / 64Mi | 500m / 192Mi |

App startup/liveness читають health; readiness — ready із timeout **6 с**, більшим за штатний DB-бюджет. Busy не робить pod NotReady. App termination grace **10 с** включає внутрішню межу shutdown **5 с**; stop чекає app/Traefik перед PostgreSQL. Немає жорсткої anti-affinity для single-node kind. Production route limits **500 / 200 млн / 30 с**, active/user=3, global outstanding=100; тільки disposable test namespace має global=4 для bounded quota proof. Таймаут алгоритму не збільшено.

PG UID/fsGroup **999**, PVC у `/var/lib/postgresql`, PGDATA `/var/lib/postgresql/18/docker`, без host port/Ingress. HTTP і migration отримують тільки DATABASE_URL ролі **courier_route**: фактично `rolsuper=false`, `rolcreatedb=false`, `rolcreaterole=false`. Bootstrap admin Secret доступний лише PG. Provision SQL передається stdin із quoting, без паролів у argv/logs; session error-statement logging вимкнено для bootstrap. Є окрема test DB. Явний compiled migration Job із того самого image завершується **до app rollout**; 001–003, checksum/advisory locking незмінні. Повторний deploy не змінює spec завершеного Job.

## TLS, сесії та межі довіри

Створено власну CA на 365 днів і leaf на 30 днів, SAN **localhost / 127.0.0.1**, повторне використання валідних файлів. CA private key не передається Kubernetes; тільки leaf/key у TLS Secret. Credentials, ключі, kubeconfig — тільки ігнорована `.local`, приватні файли 0600. Secret застосовується server-side через stdin без plaintext last-applied annotation. Перевірка tracked/candidate файлів проти справжніх локальних credentials/їх base64 та private-key markers не знайшла витоків; значення не друкувалися.

API використовує normal Node TLS validation з CA та hostname, без `-k`, `NODE_TLS_REJECT_UNAUTHORIZED=0` або глобального bypass. Неправильний trust store/hostname відхиляються. HTTP redirect зберігає правильний зовнішній HTTPS-порт. `APP_ORIGINS` точно дорівнює HTTPS origin, `COOKIE_SECURE=true`; Secure/HttpOnly/SameSite=Lax/Path=/, host-only cookie і її видалення перевіряються без друку токена. Підставлені X-Forwarded-* не обходять Origin; Express trust proxy не ввімкнений.

Chrome має власний тимчасовий профіль і **SPKI allowlist тільки конкретного leaf після normal CA/hostname перевірки**. Keychain і звичайний Chrome користувача не змінювалися. Це не означає, що нова CA вже довірена звичайним браузером; README містить ручне налаштування довіри публічному CA-файлу. TLS завершується на Traefik, усередині локального кластера HTTP/PostgreSQL TCP. Публічного hosting або внутрішнього TLS цей блок не додає.

## Перевірки

| Перевірка | Фактичний результат |
| --- | --- |
| npm ci | PASS, lock незмінний |
| npm run typecheck / build | PASS / PASS |
| npm test | **168 PASS, 0 fail/skipped**: 23 unit/config/HTTP/safety + 36 route + 13 auth PG + 27 jobs (3 config + 24 PG) + 43 client + 26 queue (14 non-DB + 12 PG) |
| Справжні PG-сценарії | **49 PASS** на окремій host test DB, guard не послаблено |
| TS / built CLI | PASS, квадрат length=4/seed=0 |
| Наявний Chrome production/dev | **16 груп PASS**, console errors=0, failed static resources=0; власні сервери/profile/schema прибрано |
| Фінальний image/container | **8 груп PASS**, 0 fail/skipped, cleanup errors=0 |
| Реальний deploy / repeat / stop-restart | PASS, 2 Ready replicas; ті самі PVC/credentials/Secret/CA/completed Jobs |

Контейнерний proof фінального image: справжній 500/200 млн worker спостерігався на **5 393 408** виконаних ітераціях; main process RSS **88 312 KiB**, health/ready=200. `docker stop` під час pending пошуку завершився за **162,55 мс**, exit 0, збережено **failed/server_shutdown**, accepting_claims=false. Власні PG/app/probe контейнери, мережа та env-файли прибрані; host PG і demo не зачеплені.

## Реальний HTTPS/LB-сценарій

Фінальний `npm run test:deployment`: **exit 0**, **116 589 мс**, **10 груп API/container/Kubernetes/TLS/fault + 9 груп HTTPS Chrome PASS**, cleanupCompleted=true. Використано власний namespace `courier-route-test-c0f90f87ec`, контекст `kind-courier-route`, HTTPS `localhost:60853`, redirect HTTP `localhost:60852`, той самий app image, що й demo. Ці тестові порти після cleanup більше не обслуговуються; demo залишається на 8443/8080.

Реальні UUID процесів у trace:

- **A** = `9c7778d1-9ba5-40ae-8728-6080732dddc7`.
- **B** = `2a2d51fa-ce8c-488c-81d5-94ea33ab9538`.
- **C**, заміна B після graceful pod delete = `e30ddb2e-12bc-43ab-8814-002d0a9d6a97`.
- **D**, новий процес після SIGKILL C = `5fae78a2-4aa5-4e3a-9620-4ffd502c571c`.

Позначення задач: **H1** `9e1b155c-2257-4394-baef-bd32f2a8eab5`, **H2** `cafcadf0-dbb7-4ec6-b79e-f16dfbf77301`, **Q** `b1097173-1e53-4c2d-a9a8-4ebfbba38c68`. A/B/C/D у таблиці — саме наведені вище UUID, не штучні ідентифікатори.

| Реальна дія через один HTTPS origin | handler instanceId | job executedBy | HTTP / стан |
| --- | --- | --- | --- |
| Login | B | — | 200, 120 мс |
| `/me`, та сама cookie | A | — | 200, 5 мс |
| `/me`, та сама cookie | B | — | 200, 7 мс |
| Створення H1 / H2 / Q | B / B / B | ще немає | 202 queued, по 8 мс |
| H1 detail під час справжнього пошуку | A | B | 200 running |
| H2 detail під час одночасного пошуку | A | A | 200 running |
| Q detail, обидва слоти зайняті | A, потім B | ще немає | 200 queued, 6 / 8 мс |
| Cancel H2 | **B** | **A** | **202**, потім persisted **cancelled** |
| Q після звільнення слота | A | B | 200 running, рівно один committed claim |
| Logout після відмов/відновлення | A | — | 204, 7 мс; login був через B |
| Старий сеанс `/me` та `/jobs` | A і D | — | 401 через обидва поточні backend |

Обидва pod мають різні UID і реальні instanceId, однаковий фактичний image digest; EndpointSlices посилаються на ті самі два Ready pod. Два одночасні running виконувалися B/A; busy registry містив рівно ці два job id, readiness лишалася успішною. Health header збігається з body UUID і не залежить від клієнтського spoof header.

Для Q через A/B отримано measured ETA **7559 мс** о **2026-10-23T22:29:48.432Z**, потім **6542 мс** о **22:29:48.542Z**, executorCount=2, queuedAhead=0. Це DB snapshot UTC, приблизний прогноз до старту, без гарантії точності/спадання; подальший cancel змінив доступність. Q отримала один committed queued→running перехід за test-only audit trigger, queue metadata зникла після старту. Приватний claim token не читався у trace.

Збережений completed квадрат `3c3e7c29-a5d9-4529-ba03-554de2f6854f` має length=4/seed=0, читається через обидва handler; чужий detail/cancel — 404. Паралельні чотири POST через обидва handler дали рівно **3×202 + 1×429** й тільки три записи. В окремому bounded сценарії global outstanding=4 дав **503 SYSTEM_OUTSTANDING_LIMIT**, персональний active=3 — **429 USER_ACTIVE_LIMIT**. Невірний Origin зі spoof forwarded headers — 403. Mutation POST не повторювався після транспортної невизначеності.

Безпечний повний trace/summary залишено тільки в ігнорованому `.local/deployment-tests/90b5e5ca-a9e9-4516-8a6d-9650ac10f4ed/summary.json`; він містить whitelist action/UUID/job/status/timing, без credentials, cookie або повних auth body.

## Відмови, PVC і точний час

| Власний fault | Реальний результат / convergence |
| --- | --- |
| Graceful busy pod B | Job `c0cb3068-217a-420b-9c49-25bcc4b1e478` → failed/server_shutdown; registry не приймає claim; новий pod C, інший UID/UUID; сценарій **4154 мс** |
| Прямий SIGKILL процесу C | Job `f15b1885-aa3c-4228-b999-566886636dd3` → failed/worker_lost за **51 141 мс**; container restartCount збільшився в тому самому pod, новий процес D |
| Зупинка/старт окремого тестового PG | **15 575 мс**, той самий PVC UID; users/sessions/completed result збережені; нова square job completed |

Для SIGKILL перевірено namespace owner, pod UID/labels/image, kind node label та containerd namespace/pod UID/container name перед сигналом конкретному task. Збережені lease expiry **2026-10-23T22:30:10.669Z** і lost_after **2026-10-23T22:30:47.165Z** різні. Після справжнього TTL job усе ще running; `finishedAt >= persisted lost_after` перевірено точно. Початкові startedAt/executedBy не змінилися, committed claim у test-only audit залишився **1**: повторного виконання не було. Це не добровільний cancel і не HPA.

За відсутності PG обидва живі app pod локально відповідали **health=200 / ready=503**; після їх виключення з EndpointSlices публічний Traefik повернув **503 без X-Instance-Id**. Після restart PVC/session/result і дві Ready replicas відновилися. У фінальному запуску непланових gateway convergence 502/503/504 було **0**; навмисний публічний 503 перевірено окремо. У проміжному прогоні під час pod replacement спостерігалася gateway-відмова; observer тепер bounded-повторює тільки безпечний GET, а не POST.

Окремий реальний **demo stop/restart** підтвердив нуль app/Traefik/PG pod у зупиненому стані й незмінність PVC, credentials, DB Secret, CA та завершених migration Job після старту. Дані не скидалися, паролі не перевипускалися.

## Chrome та виправлення перевірок

Фінальний HTTPS Chrome: **9 груп PASS**, **8480 мс**, **5 справжніх UI jobs**, TLS **1.3**, viewports **1280×900 / 360×900**. Виконано auth, два actual worker, третю queued з числовою ETA, реальну 429 зі збереженням input, зростання DB-прогресу, cancel/terminal, наступний запуск, збережений SVG/history, reload без POST, keyboard Tab/focus, logout і 401. Console errors **0**, failed JS/CSS resources **0**, HTTP mixed content **0**, горизонтального overflow немає.

**Фактично оглянуто всі 7 фінальних PNG**: desktop-top/result, mobile-queue/quota/running/square/form. ETA, measured basis, 2 executors, час оновлення, текст 429, прогрес, SVG/нумерація/порядок/length=4/seed=0 та keyboard focus читабельні, перекриттів/горизонтального обрізання немає. Це вибрані viewport-секції, а не full-page capture; overflow/focus додатково перевірені DOM/keyboard assertions. PNG тільки в `.local/.../browser`, не Git/ZIP. Наявна npm dev/production Chrome-регресія окремо повторила всі **16** старих груп.

Знайдені й виправлені помилки обв'язування до фінального pass:

- Official PG init може тимчасово відповідати pg_isready до фінального PID 1; bootstrap тепер чекає справжній postgres і SQL.
- Fingerprint включає базовий tsconfig, ConfigMap checksum запускає rollout; reuse перевіряє pinned kind image; stop чекає app до PG й не чекає видалення completed migration pod.
- Failure cleanup доступний навіть за частково виконаного provision; Secret diagnostics редагують raw/JSON/base64, malformed credentials JSON не виводиться.
- Zero-grace pod delete не гарантує відсутності SIGTERM; для аварійного доказу застосовано перевірений прямий task SIGKILL.
- ETA перевіряється після справжніх двох running із прогресом; невизначений snapshot під час claim не видається за помилку продукту чи fake ETA.
- Cross-process cancel proof вимагає реальні 202/running/cancelRequested, різні валідні UUID та terminal cancelled; gateway/natural completion не зараховуються. `finishedAt` звіряється з exact lost_after.
- Перерваний HTTP body обробляється без unhandled response error; це повторено справжнім loopback unit. CDP opening має deadline; Chrome/profile/port-forward прибираються.

Проміжні невдалі прогони не зараховано до pass. Після цих виправлень повторено повний `npm test` (**168/168**) та весь `test:deployment` (**19 груп**, exit 0).

## Відтворення, Git, cleanup і межа

Точні prerequisites, чистий checkout, порти/CA/секрети, build/load, provision/migrations, status/troubleshooting та відновлення — у [README](../README.md). Основні команди (для `npm test`/старого `test:browser` потрібен окремий host PostgreSQL та явний TEST_DATABASE_URL за наявним README; Kubernetes driver використовує власну test DB):

```sh
colima start --profile courier-route --cpu 6 --memory 8 --disk 40 --runtime docker --vm-type vz --mount-type virtiofs --activate=false
npm ci
npm run typecheck
npm run build
npm run deploy:preflight
npm run deploy:local
npm run deploy:status
npm test
npm run test:browser
npm run test:container -- courier-route:block07-1b9f0947d1e6d4e8
npm run test:deployment
```

Усі тимчасові Docker containers/networks/env, test namespaces/PVC/credentials, Chrome/profile, port-forward та npm dev/HTTP-процеси прибрані. Внутрішні безпечні logs/summary/PNG лишаються ігнорованими доказами. **Залишено запущеними** власний Colima `courier-route`, kind `courier-route`, demo namespace `courier-route`: 2 app + 1 Traefik + 1 PostgreSQL, PVC `data-postgres-0` 2Gi та завершені migration Job. Безпечна зупинка без втрати даних:

```sh
npm run deploy:stop
colima stop --profile courier-route
```

Окремий host PostgreSQL 18.4 **залишено запущеним на 127.0.0.1:55432**, як до блоку 7; він не переналаштовувався і не очищувався. Точні команди керування: `npm run db:status`, `npm run db:stop`, `npm run db:start`. Наявний `.env` не друкувався. Чужі ресурси збережені.

Створені кодові коміти:

- `478bdc0` — `feat(server): support container bind and backend identity headers`.
- `bb06402` — `feat(deploy): run two replicas behind Traefik TLS`.
- `b1dbda8` — `fix(deploy): verify pinned node image before cluster reuse`.
- `48e74a6` — `test(deploy): verify shared jobs and failures through HTTPS`.

Цей звіт, README/PLAN/AGENTS і доручення фіксуються окремим останнім docs-комітом; його хеш повідомляється в чаті після commit. Гілка **main**, остаточний `git status --short` — порожній; сторонніх змін немає. Історія не переписувалася, remote/push/публікація не виконувалися.

ZIP: `../CourierRoute-block-07.zip`, створюється **після фінального коміту** через `git archive --format=zip --output=../CourierRoute-block-07.zip HEAD`. Перед передачею перевіряються CRC, commit-коментар, точний набір і кожен байт tracked файлів HEAD. У ньому немає .git/.env/node_modules/dist/.local/БД/kubeconfig/Secret/ключів/profile/PNG/logs. Фінальний SHA й результат перевірки архіву наводяться в чаті без циклічного запису SHA звіту в сам звіт.

**Межі:** локальні два pod на одному kind node/ноутбуці; шифрування до Traefik, внутрішнього TLS немає; звичайний browser CA trust не змінено; amd64 execution не запускався (multiarch pins перевірено за офіційними manifest). Незалежне приймання нового блоку 7 ще попереду. Це не blocked сценарії поставленого локального блоку. Пункти 4 HTTPS/5 балансування перевірено в цьому обсязі; HPA/Metrics Server, автоматичне розширення й адмінпанель залишаються наступним блокам. **Роботу зупинено перед блоком 8.**
