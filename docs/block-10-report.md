# Блок 10 — фінальне наскрізне приймання Courier Route

Дата нового приймання виконавцем: **24.10.2026**, час доказів нижче — UTC. Вихідний Git HEAD: `c52d25c06b240266c62b62ba4e8f051f93288238`, наявна гілка `main`, початковий status порожній. Виконано тільки фінальний блок 10, без нових продуктових функцій.

## 1. Результат, середовище й межі доказів

**Функціональне приймання завершено: усі погоджені вимоги1–8 PASS, відкритих функціональних FAIL/BLOCKED немає.** Нові suites, HPA, cleanup та остаточний read-only resource audit пройшли. Post-commit ZIP перевіряється за протоколом нижче; його фактичний результат буде в фінальному чаті. Матриця всіх погоджених пунктів викладача 1–8: [acceptance-matrix.md](acceptance-matrix.md); практичний сценарій для Семена: [demo-guide.md](demo-guide.md). Оригінал вимог — незмінний [assignment.txt](assignment.txt); конкретні TypeScript/stack, active=3/global=100, HPA 2–4 й бюджети — погоджені рішення проєкту, а не дослівні числа викладача.

Фактичний host: macOS 26.6.2 / Darwin 25.6, arm64 Apple M5, 10 logical CPU / 24 GiB; Node **24.18.0**, npm **11.16.0**, PostgreSQL.app **18.4**. Власний Colima `courier-route`: VZ/virtiofs, **6 CPU / 8 GiB / 40 GiB**; Docker CLI 29.7.2/server 29.5.2, kind 0.32.0, Kubernetes/kubectl 1.36.1/1.36.3. Metrics Server 0.9.0, Traefik і pinned runtime/dependencies не оновлювалися заради фіналу. Додаткові pod ділять один kind node/ноутбук, не є незалежними фізичними машинами.

Поточний перевірений image: `courier-route:block07-f95eaa88fa124881`; Docker config ID `sha256:1f173c2ba53d5f3936a7ce9cbf5bf2c3a13850c302725e6d619ab97f267fcc12`, **81 164 600 B**, linux/arm64, UID 1000, Node 24.18.0/npm 11.16.0. Старий префікс `block07-` — формат чинного fingerprint helper, не старий source. Containerd imageID у test pod — import digest `sha256:3a8a0ab065c0fd77c91e17cc97f6830c843247450ba202d0b6bec62b8c0fb71c`; це інший тип ідентифікатора, всі test pod використовували той самий artifact.

**Незалежне приймання керівником блоку 9 відокремлено.** Він прийняв ZIP 165 файлів/CRC/comment `c52d25c…`, переглянув код, повторив npm ci/typecheck/build, **167 non-DB**, TS/built CLI, production/dev HTTP, syntax 15 scripts + route/dev-worker, 12 deployment JSON, 35 protected bytes проти ZIP 8 та prompt 9. Через відсутні PG/runtime/Chrome він **не** повторював 60 PG/повні 227, container/static/admin/HPA/Chrome і не оглядав 32 PNG. Без `.git` у ZIP не порівнював усі 165 файлів із локальним HEAD виконавця. Його Node 24.19.0/npm 11.9.0 не є версіями нашого image. Усі нові runtime/PNG результати цього звіту належать **виконавцю блоку 10**, не майбутньому незалежному review.

## 2. Що змінено і що збережено

Доведених дефектів продуктового коду не знайдено; алгоритм, auth, jobs, executor, admin API/UI, SQL і manifests не змінювалися. Виправлено пояснення `.env.example`: `POD_UID/NAME/NAMESPACE` надходять через Downward `fieldRef`, а `ADMIN_CLUSTER_OWNER_ID` — із rendered `app-config` ConfigMap. Значення конфігурації незмінні. Оновлено поточні статуси PLAN/AGENTS/README, точні межі review 9, quick start, матрицю та інструкцію демонстрації; додано дослівний prompt 10 із `-text`.

Наявним bounded drivers бракувало двох **полів доказу**, а не поведінки системи: simultaneous A/B positive-progress→той самий completed valid result і фактичного часу queued→started від моменту ETA sample. `check-autoscale.mjs` та `check-deployment.mjs` доповнено читанням уже отриманих DTO/timeline й safe summary. Не додано навантажувальних POST/SQL-мутацій, не знижено квот/budgets й не послаблено старих assertions. Додано перевірку результату A/B; чинні C/D strict result/cancel/claim/cleanup перевірки збережено.

Побайтово проти вихідного HEAD перевірено **38 захищених файлів**: assignment, старі prompts/reports 1–9, SQL 001–004, lock, Dockerfile, server/shared route та examples; також незмінні **всі 58 src-файлів** і всі non-comment assignments `.env.example`. Prompt 10 збігається з дорученням. Дев'ять Git-правил AGENTS збережено дослівно. Робочу БД/PVC/users/sessions/jobs/results не очищено; тести змінювали тільки власні ізольовані schemas/resources/namespace з owner guards.

## 3. Підтвердження вимог 1–8

Повний mapping «вимога → поведінка → код → точний тест → фактичний доказ/межа» містить [матриця](acceptance-matrix.md). Межі host: 500 доставок / **50 млн** ітерацій / 30 000 мс, deployment: 500 / **200 млн** / 30 000 мс; absolute configuration ceilings: 2000 / 200 млн / 120 000 мс, координати ±1 000 000. Валідація та timeout до/під час справжнього worker перевірені чинними suites, production timeout не зменшувався. Довжина евклідова в умовних координатах; пошук наближений, глобальний оптимум не доведений.

Один HTTPS origin за Traefik, `sessionAffinity: None`, без retry POST; реальні handler UUID не підміняються клієнтом. Сесія/історія/прогрес/cancel спільні в PG; handler GET/POST і `job.executedBy` — різні поняття. Нижче **одночасні** worker A/B о 13:36:47.106Z у фінальному HPA run, а не два health JSON:

| Pod / pod UID | Process UUID → job | Спостережені ітерації → terminal/result |
| --- | --- | --- |
| A `app-558b785c4b-4dgs5` / `4c9c425b-a894-439f-96e5-249d3e3ec56b` | `6dc5fd9c-2826-42bf-8ae5-96e5d458a7bd` → `0bb3151e-51bb-4ab7-af8a-49cc08ddb094` | 75 475 968 → completed 200 000 000; маршрут перевірено, length 33780.44391455501 |
| B `app-558b785c4b-pzmk4` / `ee81b065-d00d-49a7-a501-e57859a019e9` | `e6781481-f804-4a61-a38c-8accfe39da9b` → `8a41d369-4a47-48cc-8715-7778a071ebf4` | 78 528 512 → completed 200 000 000; маршрут перевірено, length 33722.45626265648 |

Фактична ETA — час **до старту**, не тривалість власного пошуку й не countdown:

| Run / queued job | Прогноз → фактично до `startedAt` | Контекст |
| --- | --- | --- |
| Static, `bb3a425c-dd5e-4c34-bc41-b6002bf0e006` | 5691 → 772 мс; наступний sample 6024 → 665 мс | 2 executor / ahead 0 / measured; початкові worker навмисно cancelled, target стартував після фізичного звільнення слота |
| HPA baseline, `8b6b68d1-eff1-4f6c-9e5d-a8b1b0bf2241` | 4239 → 2840 мс | 2 executor / ahead 0 / measured, чинне реальне навантаження |
| HPA expanded, `7c16db9a-8c02-4031-a1cd-35f24b7be6e2` | 3319 → 2489 мс | 4 executor / ahead 0 / measured, HPA додав місткість; completion/cancel змінюють очікування |

Static cross-handler cancel: handler `12746dca-c012-446d-bc06-3e84644b5412` отримав справжній **202** для job `c8eaf36f-cbfe-49b2-9a5b-8dcfb88cd6b6`, worker `c019ef39-19fb-4e74-addc-1b1f8896b36d` фізично зупинено → persisted cancelled. У HPA також реальний 202 через C до worker A, без повторного невизначеного POST. Квоти personal 3/global 100 атомарні для queued+running, історію не стирають; окремий static global=4 контрольований тест не змінює production квот.

Auth/session/expiry/logout/owner404/role gates й additive migrations 001–004 перевірені справжнім PG. Admin: 6 allow + 6 deny RBAC; metrics CPU/RAM/sample/window **точно** звірено з raw Kubernetes API для обох pod. Narrow metrics403 → stale/partial200 зі старим timestamp → fresh після відновлення; auth/jobs/ready лишилися працездатними. Warm role demotion → 403; реальний admin200 був paused перед logout, запит фізично cancelled і private state очищено, наступний доступ401. Idle container restart зберіг pod UID, замінив process UUID, старий registry `previous-process`, нові metrics спочатку null, executorCount=2. Heavy job мав 11 998 208 observed iterations → completed.

Persistence/fault: busy SIGTERM → `failed/server_shutdown` за **4225 мс**; abrupt SIGKILL → `failed/worker_lost` за **51 274 мс**, після persisted deadline/grace, не після раннього lease expiry й без replay. PG stop/start на тому самому PVC за **18 395 мс** зберіг результат/сесію; local health200/ready503 і public503 під час недоступності очікувані. Наступні worker успішно виконували задачі. Ці навмисні fault failed-стани не включено в HPA нормальні completed/cancelled числа.

## 4. Нові запуски поточного кандидата

Усі наведені нижче — **нові** перевірки 24.10.2026. Успіх suite означає 0 failed/skipped/cancelled тестів; intentional job cancel/fault — перевірювана поведінка, не skipped test. Кількості різних одиниць не підсумовуються в одне вигадане число тестів.

| Команда / сценарій | Фактичний результат | Тривалість / source / локальний доказ |
| --- | --- | --- |
| `npm ci` | PASS, 133 packages | 1546 мс, host Node24.18/npm11.16; `.local/block10-local-summary.json` |
| `npm run typecheck`; `npm run build` | PASS / PASS | 652 / 1024 мс; baseline `c52d25c`, src незмінний до фіналу |
| `npm test` з явним окремим `TEST_DATABASE_URL` | **227/227 PASS = 167 non-DB + 60 PG** | 106379 мс; 38 safety +36 route +13 authPG +27 jobs (24PG) +61 client +26 queue (12PG) +26 admin (11PG); isolated actual host/port/DB guards, nonsuper app role |
| `npm run route:demo -- examples/route-small.json`; `npm run route:demo:built -- examples/route-small.json` | Обидва PASS: справжній worker, length4/seed0/order0→1→2→3→0/10000 ітерацій | 143 / 112 мс, no DB CLI |
| `npm run test:browser` | **16/16 local Chrome груп PASS**, 23 справжні jobs, console/static errors0 | 14121 мс wall /13922 driver; `.local/block10-local-browser/summary.json`, власні процеси/schema прибрані |
| `npm run image:build`; `npm run test:container -- courier-route:block07-f95eaa88fa124881` | Build PASS, **8/8 container PASS**, cleanup errors0 | exact image ID вище; timed scenario sum1840.7 мс, повний wall не виміряно; `.local/block10-container.log` |
| `npm run test:deployment` | **10 static/fault +9 HTTPS Chrome груп PASS**, cleanup true | 122219 мс; `.local/deployment-tests/b6e22174-c33c-462e-9bd7-12ba599db21a/summary.json` |
| `npm run test:admin:deployment` | **7 admin HTTPS/RBAC/Chrome груп PASS**, cleanup true | 130764 мс; `.local/admin-tests/e1845122-cc0e-4d6c-b8d7-26dec46ef28d/summary.json` |
| Driver summary additions: typecheck/build, syntax, `test:unit` | PASS, **38 safety** повторно, без skip | 1832.609 мс safety; commit `ed87fc4`, static run уже перевірив queueStart; це спрямований повтор, не додаткові тести до227 |
| `npm run test:autoscale` | **10/10 HPA груп +4 owner browser observations PASS**, cleanup true | 561899 мс total =546359 work +15540 cleanup; source `ed87fc485462165ab99106f8954079088ffbbbaa`, той самий image; `.local/autoscale-tests/77f24f61-68a8-4df9-ac75-88250cbb8c35/summary.json` |
| Fresh source: npm ci/typecheck/build/TS+built CLI, production/dev HTTP | PASS, cleanup true | source `ed87fc4`, 4262 мс до завершення checks; `.local/block10-fresh-source-summary.json` |
| Native syntax / JSON / integrity | PASS: 15 scripts +route/dev-worker, 12 deployment JSON, 38 protected/58src/Git rules | `.local/block10-source-integrity.json`; повторна final/ZIP перевірка за протоколом нижче |

Основний source/image незмінний; після `ed87fc4` змінюється тільки Markdown. Усі stdout/logs/summary зберігаються ignored, з обмеженими правами; URL з паролем/auth body/cookie/token/claim/private env у звіт не включено. HTTP smoke не називається візуальним прийманням.

## 5. Один реальний фінальний HPA прогін

Поточний owner `77f24f61-68a8-4df9-ac75-88250cbb8c35`, ізольований namespace `courier-route-test-hpa-f4ca47b694`. Незмінні межі: work **720000 мс**, feed **120000 мс**, accepted ≤200, active ≤9, три load owners із personal3/global100 та четвертий read-only admin без job POST. HPA min2/max4/CPU70% від request250m, app limit1000m/384MiB. Driver не виконує manual scale для доказу розширення.

Фази від початку роботи: baseline2; feed start **63886 мс**; fourReadyBusy **115667 мс**; feed stop **184632 мс**, actual feed **120746 мс**; load allTerminal **196041 мс**; physical 4→3→2 до **438545 мс**, потім negative own-HPA missing metric/recovery і stop/start. Coherent downscaled snapshot о **13:43:12.294Z /451627 мс** підтвердив HPA current=desired2, physical2/Ready2/EndpointSlice2/current registry2/idle, terminating0. Підсумок: **546359 мс work +15540 мс cleanup =561899 мс total (приблизно9хв22с)**, нижче720с work budget. **81 accepted =78 важких completed +1 intentional cancelled +2 completed квадрати**, тобто **80completed/1cancelled/0failed**. Claim audit79 важких: max1 committed claim/job; у218 timeline samples max4 nonterminating/max4physical, окремо max1terminating, restart/OOM/transport failure0. Repeat при4 зберіг ті самі UID/template/generation3.

| Доданий executor | Pod UID / process UUID → job | Positive progress → той самий completed |
| --- | --- | --- |
| C `app-558b785c4b-h9m8d` | `8730cbe6-94c1-419f-9106-83c416c24992` / `687c7f78-70ed-4be1-bf83-0439ff2e10d9` → `811fb9d0-77e9-4055-b021-70111f5e7cfe` | 106 571 776 → 200 000 000, правильний замкнений маршрут перевірений чинним strict driver |
| D `app-558b785c4b-kbt2f` | `096843d4-caa5-4a8c-a676-057e9c12332e` / `e9c83160-f222-46ab-815e-04524a641db8` → `2d5782d6-83df-4189-8920-a994b2390656` | 107 350 016 → 200 000 000, правильний замкнений маршрут перевірений чинним strict driver |

Admin baseline: 2pod/2Ready/2confirmed/0busy, coverage2/2, сумарно CPU0.035024009core/RAM49647616B. Expanded о **13:37:36.814Z**: **4pod/4Ready/4confirmed/4busy**, coverage4/4, CPU3.91338436core/RAM206086144B; 34jobs усіх трьох owners. C sample13:37:29Z/window9.615s: CPU0.977716588core/RAM44695552B; D13:37:30Z/window10.738s: CPU0.98535826core/RAM48054272B. CPU — середнє app-container за window, не весь CPU Mac; RAM — working set, не process heap. Той самий admin cookie без повторного login досяг усіх чотирьох process UUID. Returned admin: physical/Ready/confirmed2/idle, coverage2/2, CPU0.036728915core/RAM90484736B. **Часова межа кешу:** source13:43:07.870Z/cache4506мс мав HPA current3/desired2, тоді як окремий coherent snapshot13:43:12.294Z вже current=desired2. Це не одна атомарна мить. Залишилися A і C; B/D перестали додавати live capacity, не стверджується, що обидва додані C/D зникли. Той самий admin cookie досяг2→4→2, all-owner pagination20/20 без overlap, keyboard PASS. Missing metric дав ScalingActive=False/FailedGetContainerResourceMetric при replicas2; після відновлення realmetric прийнято. Explicit stop видалив тільки ownHPA перед0; restart на тому самому PVC UID `3903257e-ba07-4b29-9ab2-4a7b29d76acb` зберіг CA/credentials/session/result і виконав новий квадрат, replicas2. Cleanup завершено за15.540с, власний test namespace/PVC/Chrome/forwarding прибрано.

## 6. Браузер і фактичний огляд PNG

Local Chrome16 і HTTPS Chrome9/admin7 — реальні CDP-взаємодії, не HTTP-only. Фактично оглянуто 10 local PNG +7 static +8 admin: desktop1280/360, form/result/square/queue/quota/running, unknown/fallback/measured/stale/partial, empty/error/loading, keyboard-visible focus, читабельні українські тексти й повні перенесені UUID; перекриття/обрізання/горизонтального overflow не спостережено. Console errors, failed JS/CSS і mixed-content requests — 0. Окремо через view_image оглянуто **17 HPA PNG =7 owner+10 admin**, включно повними C/D картками з реальним busy/progress/sample CPU/RAM та returned/filters/квадратом. Разом **42 нові фактично оглянуті PNG**; screenshot saved сам по собі не зараховувався оглядом. HPA owner/admin console/resource/mixed-content errors0. Returned screenshot чесно зберігає часову різницю cached HPA3/desired2 проти physical2.

Звичайна довіра користувацького Chrome до локальної CA **не налаштована автоматично**. Driver спочатку нормально перевіряє CA/hostname/validity TLS-клієнтом, Chrome має тимчасовий leaf-SPKI exception тільки свого профілю. Скрипти не змінюють Keychain/trust store. Користувач імпортує лише CA certificate вручну за demo-guide. Зовнішній HTTPS завершує Traefik; Traefik→Express і Express→PG тут без TLS; local kubelet/aggregation винятки Metrics Server явно описані у README, app/API-server TLS не послаблено.

PNG/logs/private summaries лишаються ignored локальними доказами, у Git/ZIP їх немає; керівник нові PNG ще не оглядав.

## 7. Проміжні невдачі та обмеження

- Перший ignored orchestration wrapper змішав CLI progress stderr із JSON stdout: parser fail при фактичному TS CLI exit0. Виправлено тільки приватний parser, збережений result перевірено й виконано решту команд; це не дефект CLI й не переписаний failed product run.
- Перший fresh-source wrapper помилково чекав CSS від Vite запиту з wildcard Accept: Vite коректно повернув JavaScript CSS-module transform. Правильний `Accept: text/css` дав CSS. Cleanup wrapper також помилково трактував власний intentional npm SIGTERM exit143 як failure; перевірено фізичну зупинку, виправлено лише ignored runner. Фінальний fresh smoke PASS, попередній safe failed summary збережено.
- Перший readonly resource-audit wrapper помилково чекав `instanceId` у ready JSON; readiness має UUID у `X-Instance-Id`, а JSON UUID є в health. Normal CA TLS ready вже повернув200. Виправлено тільки приватне очікування, попередній audit не зараховувався як PASS.
- Static intentional pod/PG faults дали **два короткі convergence GET** 502 (10 мс) і503 (4 мс), плюс очікуваний public503 при навмисно відсутніх Ready endpoints. Це зафіксовані gateway відмови під час recovery, а не безперервна доступність. POST transport reset не спостережено, невизначений POST не повторювався.
- Історичний одиничний `ECONNRESET` блоку8 **не відтворено; причина невстановлена**. Успішні нові запуски не доводять, що його причину виправлено. Старі звіти незмінні.

## 8. Чисте відтворення та демонстрація

Із `git archive ed87fc485462165ab99106f8954079088ffbbbaa` створено власну тимчасову папку **без `.git/.env/.local/node_modules/dist`**; repo не ініціалізувався. Нові npm ci1116мс/typecheck721/build1723/TSCLI190/builtCLI109 пройшли; обидва CLI дали squarelength4/seed0/10000. Production HTML українською, JS/CSS MIME, actual handler UUID/spoof-rejection, ready503 без DB, anonymous admin401/no-store, syntactic-cookie при DBdown503/no-store, API404, Vite proxy/чотири TSmodules/CSS — PASS. Власні HTTP/Vite зупинено й папку видалено.

Це перевірка **tracked source/установлення/build/CLI/no-DB HTTP**, не повторне створення VM/повного кластера на чистому ПК. Container/static/admin/HPA drivers окремо перевірили ізольовану runtime БД, explicit migrations і HTTPS; нова VM та другий HPA stress не потрібні. Source ZIP містить code/migrations/manifests/docs/tests без готових dist/node_modules, VM/PVC/БД/credentials/CA. README розрізняє нове оточення й повторне використання чинного PVC з локальними credentials.

Практична підготовка/7–10хв показ/окремий HPA/дві actual jobs/troubleshooting/stop — [demo-guide.md](demo-guide.md). Перевірені команди: `npm run deploy:preflight`, `npm run deploy:local`, `npm run deploy:status`, `curl --cacert .local/deploy/tls/ca.crt https://localhost:8443/api/ready`, `open https://localhost:8443/`; stop/start перевіряв driver у власному namespace. Для admin користувач спочатку реєструє **власний** login, після чого явно виконує `npm run admin:role:deployment -- --username YOUR_LOGIN --role admin` із заміненим placeholder. Довільному наявному login роль не надано; manual CA trust/невідомий login не є функціональним blocker фіналу.

## 9. Git і ресурси

Працювали в наявному `/Users/a860/Documents/Site/.git`, `main`, із налаштованою справжньою ідентичністю; reinit/rewrite/remote/push не виконувалися. Перед комітами переглядалися status/diff/staged diff і доречні перевірки. До фінального docs-коміту створено:

- `a429d8c` — `docs: clarify accepted scope and configuration metadata`.
- `ed87fc4` — `test(acceptance): record initial workers and actual queue waits`.

Фінальний docs-коміт буде створено після остаточного огляду всіх доказів; його hash та post-commit/post-ZIP `git status --short` повідомляються в чаті без циклічного редагування цього звіту.

**Фінальний read-only audit PASS**, 13:50:03Z, додаткові перевірки13:51:02Z; safe summary `.local/block10-final-resources.json`0600. Основне demo `https://localhost:8443/` лишено працювати: original pod `app-86c8f5dc4d-4t9mv`/UID `787e00c0-ec97-4be0-84e4-cf91790d1f25` та `app-86c8f5dc4d-sglkp`/UID `038178db-93c8-4bfc-9ceb-4365d07414ea`, 2Ready/0terminating/0restarts, той самий image, 2точні Ready EndpointSlice UID, 2actualhandlerUUID/2freshidleregistry, HPAmin2max4/current2desired2. Normal CA/hostname TLS ready200. Робочі users/sessions/jobs/admin/active були й лишилися0, migrations001–004/nonsuperrole/UID1000 збережено.

Збережено власний ColimaRunning6CPU/8GiB/40GiB, kind, clusterPG/PVC/CA/credentials, shared MetricsServer1Ready/APIServiceAvailabletrue з перевіреним ownowner. Global Docker context лишився`default`. Окремий hostPostgreSQL **лишено запущеним** на127.0.0.1:55432, database`courier_route`, role`courier_route` без superuser/createdb/createrole. Actual окрема`courier_route_test` перевірена, тимчасових schemas0. Власних testnamespace/Chrome/testNode/kubectl/профілів/тимчасовихbrowserпрофілів/container/network лишилося0; HPAcleanuptrue. Чужий браузер/процеси й користувацькі дані не змінювалися. Demo не має фонового тестового load.

Безпечне керування з кореня проєкту:

```sh
npm run deploy:status
npm run deploy:stop
colima stop --profile courier-route
npm run db:status
npm run db:stop
# Наступний запуск, якщо зупиняли VM:
colima start --profile courier-route --cpu 6 --memory 8 --disk 40 --runtime docker --vm-type vz --mount-type virtiofs --activate=false
export COURIER_DOCKER_HOST="unix://$HOME/.colima/courier-route/docker.sock"
export DOCKER_HOST="$COURIER_DOCKER_HOST"
npm run deploy:local
# Host PostgreSQL керується окремо:
npm run db:start
```

`deploy:stop` прибирає тільки свій HPA перед app0/PG0 і лишає PVC/CA/credentials; Colima stop — окреме свідоме завершення VM. HostPG — власний loopback127.0.0.1:55432, не clusterPG; db helpers керують лише проєктним кластером.

## 10. Фінальний ZIP і зупинка

Після docs-коміту канонічний source archive створюється **з точного фінального HEAD**:

```sh
git archive --format=zip --output=../CourierRoute-block-10.zip HEAD
```

Post-commit перевірка: CRC кожного entry; commit comment дорівнює повному40-символьному HEAD; точний набір tracked файлів, byte equality кожного Git blob; безпечні відносні шляхи й коректні типи/режими (symlink/exec не маскуються); незмінні protected bytes; немає `.git/.env/node_modules/dist/.local`, DB/PVC/kubeconfig/Secret/credentials/private keys/browser profiles/private PNG/logs/summary чи сторонніх untracked. Directory entries не рахуються файлами. Остаточний HEAD/file count/CRC/всі blob equality/post-ZIP status будуть наведені **в чаті після фактичної перевірки**; цей звіт описує протокол, не удає ще нестворений архів перевіреним.

Архів: `/Users/a860/Documents/CourierRoute-block-10.zip`; Finder: `open -R /Users/a860/Documents/CourierRoute-block-10.zip`. Після звіту, змістовних комітів і перевіреного архіву робота зупиняється. Новий блок, публікація/GitHub push або надсилання матеріалів викладачу не виконуються.
