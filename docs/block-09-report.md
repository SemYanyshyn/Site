# Блок 9 — панель адміністратора

Дата: 2026-10-24. **Статус: готово. Поточних блокерів немає.** Виконано тільки блок 9; блок 10 не розпочато.

## 1. Вихідний стан і межі доказів

Роботу продовжено в наявному Git-корені `/Users/a860/Documents/Site`, гілка `main`, початковий чистий HEAD `6720e55b9b19e010002112f9add389685840adc3`. Використано налаштовану справжню Git-ідентичність; remote/push, переініціалізації й переписування історії немає. Доручення 9 скопійовано дослівно, вимоги викладача з `docs/assignment.txt` відокремлено від погодженого стеку й організаційних Git-правил.

**Блок 8 прийнято керівником:** незалежно перевірено ZIP 139 файлів на HEAD `6720e55…`, `npm ci`, typecheck/build, **134 non-DB** (38 unit/safety + 36 route/HTTP + 3 jobs config + 43 client + 14 queue), TS/built CLI й production/dev HTTP (HTML/JS/CSS, health/actual UUID, ready=503 без БД, API 404, Vite/proxy та /api.ts як JavaScript). Незалежно перевірено синтаксис native .mjs/JSON manifests/CRC, 31 захищений файл і всі 45 src файлів блоку 8 проти попереднього ZIP; тимчасові HTTP/Vite-процеси зупинено. 49 PostgreSQL, 8 container, 10 deployment/fault + 9 HTTPS Chrome, 9 HPA груп + 4 browser observations і PNG підтверджувалися звітом виконавця; керівник їх не повторював і PNG не оглядав. Історичний звіт 8 не переписано. Причина попереднього cancel POST `ECONNRESET` у блоці 8 лишається невстановленою; успішний новий прогін не виправляє її заднім числом.

Поточні результати нижче — фактичні перевірки виконавця в цьому середовищі, без заяви незалежного приймання керівником блоку 9.

## 2. Зміни, середовище й міграція

Стек збережено: strict TypeScript, Node 24.18.0/npm 11.16.0, Express/Vite/pg/worker_threads, один npm-проєкт. Нових залежностей немає, lock-файл незмінний. Host: macOS 26.6.2/Darwin 25.6 arm 64, Apple M 5, 10 logical CPU, 24 GiB RAM. Власний Colima `courier-route`: 6 CPU/8 GiB/40 GiB; Docker CLI 29.7.2/server 29.5.2; kind 0.32.0/Kubernetes 1.36.1, kubectl 1.36.3. Власні kubeconfig `.local/deploy/kubeconfig`, context `kind-courier-route`; глобальний Docker context `default` збережено.

Додані shared admin DTO, `src/server/admin/*`, CLI `src/server/admin-role.ts`, чотири `src/client/admin-*`, українська навігація/панель, нові unit/client/PG тести й два admin runtime/browser driver-и. HTTP runtime підключає один AdminService, закриває його до Pool.end. Оновлені registry metadata, queue dedup, readiness/migration registry, власні SA/RBAC/Downward API, deployment helper, schema expectations чинних container/static/PG перевірок. Старі assertions не послаблено. README/PLAN/AGENTS актуалізовані.

Нова **004_executor_metadata** лише додає nullable `pod_uid/pod_name/pod_namespace`, all-or-none CHECK та індекси; SQL 001–003 не змінено. Host PostgreSQL 18.4 явно мігровано після перевірки фактичного `127.0.0.1:55432/courier_route` й nonsuper/nocreatedb/nocreaterole. На робочій БД counts users/sessions/jobs/registry були 0 і лишилися 0; повтор застосував 0 нових SQL. Реальні seeded account/session/completed job/result/registry з 003 перевірені окремо на test-БД, включно з concurrent compiled migration, checksum, повтором, старим writer-ом і readiness record/shape. У контейнері присутні всі чотири compiled SQL й role CLI; міграційний Job виконується явно перед rollout.

Фінальний image: `courier-route:block07-f95eaa88fa124881`, Docker config ID `sha256:1f173c2ba53d5f3936a7ce9cbf5bf2c3a13850c302725e6d619ab97f267fcc12`, linux/arm 64, **81164600 байтів**, UID 1000. `block07-*` — збережений формат fingerprint-тега helper-а, а не номер виконаного блоку. Образ без source/tsx/TypeScript/Vite, env-файлів і операторських credentials; registry push немає.

Побайтово звірено **34 захищені файли** з початковим HEAD: assignment, попередні prompts/reports 1–8, SQL 001–003, lock, route algorithm/executor/CLI/config/worker/bench/приклади/shared route. Git-розділ AGENTS з дев'ятьма правилами збережено дослівно; prompt 9 збігається з вкладенням. Інвентар хешів зберігається лише в ігнорованій `.local/block09-protected-files.json`.

## 3. Роль, CLI та захист даних

`GET /api/admin/overview`, `GET /api/admin/jobs` — лише читання. Усі `/api/admin/*` використовують чинний requireAuth із bounded session lookup, потім requireAdmin. Поточна сесія/expiry/роль читаються з PostgreSQL **перед** global reads/cache/Kubernetes; додаткового дубльованого auth SQL і кешу ролі немає. Без сесії 401, user=403, DB-down 503, admin 200; `Cache-Control: no-store` на всіх результатах. Реєстрація з додатковим role відхиляється 400, звичайна створює user; header/query/клієнтський стан не дають привілеїв.

Операторський CLI працює лише з уже наявним валідованим login і admin/user, параметризує SQL, перевіряє nonsuper DB role, не приймає пароль/URL. Unknown/invalid — nonzero без створення користувача, повтор ідемпотентний. TS/built й Kubernetes варіант перевіряються; deployment helper має точні cluster/namespace/owner/Deployment/image/Ready pod/ReplicaSet→Deployment guards. Створювалися тільки власні випадкові test-акаунти в disposable schema/namespace; чужі ролі й постійний superadmin не створювалися.

Два незалежні HTTP-процеси підтверджують поточну роль зі старою cookie; після admin→user прогрітий кеш на A/B не обходить 403. Logout/expiry 401 очищують приватний client state; role 403 закриває admin, лишаючи особисті маршрути. Unit перевіряє, що відхилений доступ не викликає навіть прогрітий provider. Shared session не підмінено моком.

Проекції whitelist: немає password/session hashes, cookie/token, claim token, input/result/координат, DB URL, Pod env, raw Kubernetes body/помилок. Чужі owner detail/cancel і для admin лишаються 404. Provider 403 означає недоступне джерело й HTTP 200 partial/stale, а не людський logout/403.

## 4. Kubernetes, RBAC і TLS

Прямі Node HTTPS GET із app pod до фіксованого `kubernetes.default.svc:443`, нормальна перевірка cluster CA/hostname. Чотири фіксовані API paths; namespace/owner selector задає сервер. Projected bound token TTL 3600 с і CA перечитуються кожен refresh, credentials не кешуються назавжди; немає kubectl/docker/операторського kubeconfig/socket у HTTP handler/image.

Окремі namespaced SA/Role/RoleBinding `courier-route-monitor`: get/list pods і metrics.k 8 s.io pods, лише named get Deployment/app і HPA/app. Немає Secrets/logs/exec/scale/delete/nodes/чужого namespace. Namespace обмежує RBAC; labels/owner додатково перевіряє сервер, RBAC не фільтрує list за довільними labels. Projected volume read-only 0440/fsGroup 1000 тільки app; фактичний успішний provider під UID 1000 підтверджує читання CA/token. Migration Job automount=false. Worker env/execArgv порожні, отримує лише input/runId; спільна з app файлова система thread не є файловою sandbox-межею.

Host dev з `ADMIN_KUBERNETES_ENABLED=false` показує DB й unknown/null для pod/HPA/CPU/RAM, без вгадування `~/.kube/config`. Shared Metrics Server 0.9.0 не вимикався при negative fault. Збережено явні локальні винятки **Metrics Server→kubelet `--kubelet-insecure-tls`** і aggregation APIService `insecureSkipTLSVerify:true`; це не повна TLS-перевірка цих каналів. App→Kubernetes API та зовнішній app HTTPS CA/hostname не послаблені. Chrome використовує лише ізольований leaf-SPKI exception після нормальної CA/hostname перевірки; користувацький trust store не змінюється.

Офіційні джерела: [in-pod API](https://v1-36.docs.kubernetes.io/docs/tasks/run-application/access-api-from-pod/), [RBAC](https://v1-36.docs.kubernetes.io/docs/reference/access-authn-authz/rbac/), [projected token](https://v1-36.docs.kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/), [Downward API](https://v1-36.docs.kubernetes.io/docs/concepts/workloads/pods/downward-api/).

## 5. Pod, процес, worker і job

Pod UID/name/namespace надходять із Downward API, health instanceId залишається UUID фактичного процесу. Mapping потребує збігу всіх metadata та поточного container/process lifetime. Pending/NotReady/Ready/terminating pod видно без фіктивного executor. При container restart UID лишається, UUID змінюється; попередній fresh lease винесений окремо й не додає другого live слота. Для host metadata відсутня допустимо; для невідповідного pod — немає зіставлення.

Busy бере committed running/current claim/finalization з БД, а не CPU. CancelRequested не звільняє слот; expired running залишається чесно недоступним до lost_after, моніторинг не фіналізує/перепризначає jobs. Чинна черга/ETA й admin DB capacity однаково dedup найновіший процес за pod identity; heartbeat metadata лишається одним SQL у польоті без додаткових DB round trip після claim, без зміни TTL/recovery/21000 мс резерву.

Обов'язкові current-pod/fresh/running записи ≤10000; окремий unavailable tail за 60 с до 100 з truncation flag. Перевищення mandatory bound — помилка, не мовчазне обрізання. Клієнт приймає узгоджену верхню межу 10100. Фізичні pod, Ready, terminating, DB available slots і HPA desired відображені окремо.

## 6. Метрики й час

CPU — ядра за первісне `timestamp/window`, 1000 мCPU=1 ядро; RAM — app container working set, MiB=1048576 байтів. Це app разом із worker threads, не весь Mac і не окремий worker. Requests 250 m/128 Mi, limits 1 CPU/384 Mi; CPU/request може перевищувати 100%. Джерело узгоджено з [Kubernetes resource metrics](https://v1-36.docs.kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) та [PodMetrics schema](https://github.com/kubernetes/metrics/blob/master/pkg/apis/metrics/v1beta1/types.go).

Зіставлення namespace+pod name+app container і UID, якщо Metrics API його реально містить. Увесь sample window повинен починатися після container/process start; після restart чесний короткий unknown до нового повного sample. Старіший 45 с sample або failed source позначається stale; timestamp/window не переписуються новим GET. DB snapshot, source observedAt, cache age відділені; суми включають лише придатні samples із coverage, unknown не стає 0. Фінальний static namespace `courier-route-test-admin-d7435fc1` підтвердив однакові samples API/raw для обох pod; UI лише округлює:

| Pod / процес | Первісний UTC timestamp / window | API = raw CPU | API = raw RAM | UI |
| --- | --- | --- | --- | --- |
| app-65 f 85 c 78 f 7-ttpvx / f432bdb3… |12:38:43Z /22.919 с |0.012718268 core |30289920 B |12.7 мCPU /28.89 MiB |
| app-65 f 85 c 78 f 7-wtw 4 x /111199ae… |12:38:39Z /18.7 с |0.011548449 core |29147136 B |11.55 мCPU /27.8 MiB |
| Справжній пошук на wtw 4 x |12:38:50Z /10.708 с |0.130677437 core |45658112 B |130.68 мCPU /43.54 MiB |

`kubectl top --containers` підтвердив ті самі pod/app; його округлений новий live sample не вимагається рівним незалежному виміру. Для heavy job `013ffe6b…` збережено positive progress 11639808/200000000 і правильний executedBy, UI показав 5.82%, потім completed. Навіть коли останній CPU window ще охоплює пошук, слот уже може бути idle — це різні джерела/час.

При знятті лише metrics rule API лишився 200; Metrics source observedAt **12:38:59.568Z** збережено, cacheAge 5338.663 мс; Kubernetes новий snapshot **12:39:04.606Z**, metrics stale, coverage 0/2. Auth/tasks/readiness працювали. Після відновлення права й рестарту Metrics source **12:39:43.440Z**, samples12:39:34Z/18.699 с та12:39:30Z/13.517 с повернулися як придатні. Старий timestamp не перетворено на свіжий GET.

## 7. Jobs, бюджети й polling

Default 20/max 50, offset≤1000000, валідовані status/active/executedBy UUID; unknown/arrays/надмірні query 400. `created_at DESC,id DESC`, count+page одного read-only REPEATABLE READ snapshot. Власники/стан/реальні ітерації/відсоток/times/executedBy/cancelRequested/failureReason, без входів і результатів. Перевірено 25 tied-created rows/двох owners в PG і окремо 28 записів runtime (26 bounded terminal fixtures +2 справжні completed маршрути), без важкого навантаження заради сторінок.

Загальний pre-auth monotonic budget 8 с, pool acquire 2 с, кожний admin SQL≤1 с, transaction 5 с/lock 500 мс/idle 1500 мс. Provider чотири паралельні фіксовані GET, кожне включно з credential read≤2 с/2 MiB, pods/metrics≤100. Per-process single-flight/cache 5 с; auth не кешується. Abort фізично відкидає active pg client/HTTP socket, late pool acquisition звільняється без SQL; shutdown припиняє refresh/credential reads/issued HTTP до Pool.end. `agent:false` не лишає completed keepalive sockets. Немає необмеженого retry чи незупиненого Promise.race.

UI polling 5 с лише open+visible, один цикл на тип читання, abort і session/panel/query generations. Filter/page не допускають stale відповіді; статичні controls зберігають focus. 503 зберігає останній snapshot з попередженням, human 401/403 чистять private state. Прямі owner API/worker/route CLI й admission lock не підмінені моніторингом.

## 8. Реальні HTTPS/Chrome/RBAC/HPA сценарії

Фінальний static deployment: **10 fault/API +9 HTTPS Chrome PASS** за 117780 мс, без convergence gateway failures. SIGTERM 4182 мс→server_shutdown, SIGKILL 50977 мс→worker_lost тільки після persisted deadline/grace; PostgreSQL stop/start на тому самому PVC за 16370 мс зберіг session/history/result. Усі 7 PNG desktop/result/360 queue/quota/running/square/form оглянуто, console/resources/mixed-content 0. Summary: `.local/deployment-tests/8d0126a0-05da-40cf-b708-338a5b1d50f2/summary.json`.

Фінальний admin static: **7 комплексних груп PASS** за 115985 мс, summary `.local/admin-tests/1cbbf5b5-1ea1-4ed0-bfe0-f2ce2791ddd4/summary.json`. Реальні SA probes:6 allow (get/list own pods і podmetrics, namedget app Deployment/HPA) та 6 deny (Secrets, exec, logs, scale, delete, foreignnamespace); додаткові actual own API reads. Ніяких небезпечних мутацій заради негативного тесту. Чужий namespace перевірено тільки authorization probe.

Idle SIGKILL одного app зберіг pod UID `d8270ccd-1b9b-41a6-a1c6-3d9599ac4685`, UUID `f432bdb3-678d-492b-ab57-1fe8af8a853e` змінився на `3aa9fc93-f7f5-4fec-a371-8c11a70ec303`, restarts 1, old registry reason previous-process, початкова метрика null, live capacity 2; історія й сесія збережені. Це idle restart, він не вигадується причиною завершення running job; busy shutdown/lost окремо перевірено незмінним static driver.

Admin→user через операторський CLI дав 403 через обидва прогріті handler-и та очистив приватний UI. Після явного regrant/reload Chrome затримав **справжню успішну 200 overview відповідь** на response-stage, потім виконав logout: actual fetch фізично скасовано, відновлення затриманої відповіді неможливе, private state порожній, наступні admin API 401. Вісім admin PNG реально оглянуто: servers/jobs/filter desktop 360/realprogress/partial/restarted; full UUID переносяться, focus/labels/keyboard/viewport справні, console/resources/mixed — 0. Root окремо оглянув server desktop, jobs 360 та partial 360.

**Один фактичний HPA/admin цикл PASS:** `.local/autoscale-tests/af00ab09-d644-426a-80c7-2b542e0f88bb/summary.json`, namespace `courier-route-test-hpa-e4d48c95dc`. Робота 498147 мс + cleanup 15417 мс = **513564 мс**, work budget 720000 мс. 3 звичайні load owners, ≤9 active, cap 200 accepted; подавання 120 с, зупинку спостережено через 121904 мс. **73 accepted =70 важких completed +1 intentional cancelled +2 completed квадрати; 0 failed/OOM/restart/transport failure**, невизначених мутацій 0. Адмін — четвертий окремий account, job POST — 0.

| Доказ | Фактичне спостереження |
| --- | --- |
| A/B на початку |Process 09b1b0f3… і 0a83226e…, 2 Ready/2 endpoints/2 registry |
| Чотири Ready і busy |94701 мс; HPA сам створив C/D, 4 distinct running/positive progress, cap 4 |
| C |Pod 34bdc6aa-97c6-4267-9a15-27b5d42b7a71 /process d9591165-4219-4a21-a06e-70441d093891; job 6580022e-23d8-4592-9231-4d230dfa8c5b спостережено 135097344 iterations→completed 200 млн |
| D |Pod 6ee55a66-73b2-4db8-a767-d96ee8f9ec16 /process 1a5dae4c-5485-46a8-88c3-19243bf312cb; job f9d26e0b-799e-402c-b0f9-8113cf34f7dc спостережено 144504832 iterations→completed 200 млн |
| Claim audit |71 load claims, maximum 1; кожен відповідає acknowledged job/власному executedBy, один slot/process |
| ETA |2 виконавці:3642 мс/queuedAhead 0; 4 виконавці:8654 мс/queuedAhead 4, measured |
| Cancel |job 7c3c07b3… виконував D, handler C повернув **202**, фактичний terminal cancelled; POST не повторювався |
| Repeat at 4 |Generation 3/revision 1/template digest і всі pod UID збережено, replicas 4, annotation keys не змінені |
| Всі load terminal |181225 мс:70 completed/1 cancelled/0 failed |
| Повернення 2 |418734 мс, фізично 2 pod/2 Ready/2 endpoints/2 fresh registry, без terminating; C/D не додають live capacity |
| Stop/start |496025 мс:той самий PVC `ecb3516b-93e9-4430-85d9-210dc4c35f56`, CA/credentials/session/results збережені; новий HTTPS-квадрат completed, replicas 2 |

Admin у тому самому Chrome з **одним login** пройшов обидва A/B, усі 4 handlers з C/D і назад 2. При expanded показав 4 фізичні/4 Ready/4 confirmed, coverage 4/4, суму CPU 3.796980874 core/RAM 201867264 B, 31 job від усіх 3 owners. C sample 12:42:44Z/window 16.595 с CPU 0.987954685/RAM 48812032 B; D 12:42:53Z/window 14.32 с CPU 0.838577863/RAM 48693248 B. Peak raw samples C 0.990784383 і D 0.982218154 core за 5 різними samples кожного; це фактичні window averages, не worker-профайлер. Admin snapshot зайнятості пізніший за строгий four busy proof й чесно має busy=1 при останніх високих CPU samples; завершені slots не видаються busy через CPU.

Returned admin:2 pod/Ready/confirmed, busy=0, coverage 2/2, CPU 0.033027347 core/RAM 88092672 B, 71 job від 3 owners, pagination 20/20 без overlap і keyboard focus. У цьому **cached** знімку HPA.status ще current=3/desired=2, хоча фізичні pod уже 2: контролер/джерела/кеш мають різний час. Окремий coherent driver snapshot підтвердив current=desired=2; UI не підмінив controller status числом фізичних pod.

HPA missing-container metric negative змінював тільки власний тестовий HPA: ScalingActive=False, replicas лишились 2; після restore нормальні метрики відновились. Строгі попередні 9 груп збережено й додано 1 admin-групу, normal browser 4 observations. **Оглянуто 17 HPA PNG**: 7 owner +8 admin +2 окремі C/D. Додаткові C/D картки знято read-only CDP з того самого ще відкритого Chrome під час cooldown, коли вони вже idle; ці PNG не видаються за CPU під навантаженням. Вони не індексовані поточним in-memory summary, лежать поруч як `expanded-executor-C.png`/`D.png`; driver тепер відтворює такі per-card captures. Другий stress для скриншотів не запускався. Root окремо оглянув expanded/jobs 360, повні C/D та returned 2 desktop. Разом 7 static+8 admin+17 HPA = **32 фінальні runtime PNG** фактично оглянуто, без overflow/перекриття; усі Chrome console/resource/mixed 0.

## 9. Таблиця перевірок і проміжні помилки

| Перевірка | Фактичний результат |
| --- | --- |
| npm ci | PASS, 133 packages, audit 0 vulnerabilities; lock незмінний |
| Фінальні typecheck/build | PASS, без HTML warnings |
| Повний npm test | **227 PASS, 0 fail, 0 skip =167 non-DB +60 PG** |
| Розподіл npm test |38 unit/safety; 36 route; 13 auth PG; 27 jobs(3+24 PG); 61 client; 26 queue(14+12 PG); 26 admin(15 unit+11 PG) |
| Нові тести понад 183 |44:4 deployment unit+11 backend unit+18 client+5 data PG+6 API PG |
| TS/built route CLI | PASS, реальний worker, квадрат length 4, 10000 iterations, однаковий order |
| Старі local Chrome | **16/16 PASS**, production/dev, 23 справжні saved jobs, console/resources 0 |
| Фінальний container image | **8/8 PASS**, cleanup 0, UID 1000, compiled 004/roleCLI, worker 4347904 iterations, SIGTERM 132.26 мс→failed/server_shutdown |
| Фінальний static deployment/fault +HTTPS Chrome | **10+9 PASS**, 117780 мс, cleanup=true, console/resources/mixed — 0 |
| Фінальний admin HTTPS/RBAC/Chrome | **7 груп PASS**, 115985 мс, cleanup=true, console/resources/mixed — 0 |
| Один спільний HPA/admin цикл | **10 груп PASS**, 4 owner Chrome-спостереження +3 admin-фази, 73 accepted/72 completed/1 cancelled/0 failed, cleanup=true |
| PNG desktop/360/server/jobs/partial/C-D | **32 фінальні runtime PNG оглянуто**: 7 static+8 admin+17 HPA; приватні й ignored |

Проміжні результати збережено чесно:

- Початкове npm test у sandbox не могло bind локальні HTTP-сокети (EPERM); дозволений повтор і фінальний повний запуск пройшли. Це обмеження середовища, не пропущений успіх.
- Перше Vite build виявило malformed option tag; виправлено, фінальний build без warnings. На проміжному unit-файлі була type-помилка; виправлена до коміту й фінальних перевірок.
- Початкові нові fixtures помилково очікували register role-extra 201 замість 400, logout 200 замість 204 і порушували expiry CHECK; виправлено тести без послаблення продукту. Додано generic safe SQL error wrapper, щоб fixture-помилки не друкували PostgreSQL row details. Приватні значення сюди не перенесені.
- Початковий container command без image використовував відсутній старий candidate:0 checks/fail. Явний актуальний image пройшов 8. Проміжні Kubernetes fixtures чекали ErrImageNeverPull, бо Docker image ще не був у kind; точний artifact завантажено, static відновився до deadline і пройшов 10+9. Test provision тепер сам bounded/owner-guarded завантажує перевірений image **до** namespace/міграції; фінальний повтор підтверджує це.
- Два проміжні admin Chrome runs пропустили короткий running між 5 с polls: діагностика показала visible/open panel, відсутність UI errors, completed job і вже оновлений CPU 234.64 мCPU; не стверджується, що ці прогони пройшли. Driver тепер завершує reset фільтра й натискає фактичне «Оновити» відразу після реального positive progress, без fake delay чи зміни worker limits.
- Перший фінальний admin run пройшов реальні progress/CPU/Chrome, але tester неправильно трактував `pods/log` у can-i як subresource. Виправлено probe на `--subresource=log/exec/scale`; RBAC grant не розширювався. Остаточний результат має підтвердити справжні allow/deny.
- Відомий reset блоку 8 лишається невстановленим; unknown POST не повторюється, відсутній 202 не зараховується до cancel proof. Діагностика transport failure збирається перед cleanup.

## 10. Команди, Git і залишені ресурси

Перевірені базові команди: npm ci; npm run typecheck; npm run build; npm test; npm run test:browser; npm run route:demo -- examples/route-small.json; npm run route:demo:built -- examples/route-small.json; npm run image:build; npm run deploy:local. Container запускався з явним fingerprint image. Для тестів лише явний TEST_DATABASE_URL на окремій test-БД, після перевірки фактичних host/port/database проти робочого підключення; власні random schemas/processes прибираються.

Створені змістовні коміти:

- `ce02c79` — `feat(deploy): add executor pod identity and role operator`.
- `41c8a4f` — `feat(admin): add role-protected live monitoring panel`.

- `8bcfd3f` — `fix(deploy): load verified images before test provisioning`.
- `b732be7` — `test(admin): verify real RBAC metrics and autoscaling`.

Окремий фінальний docs-коміт містить цей звіт, README/PLAN/AGENTS, дослівне доручення 9 та його gitattributes; його хеш повідомляється в чаті без самопосилального переписування звіту. Гілка main. Перед фінальним docs-комітом залишалися лише ці 6 власних документаційних файлів, сторонніх змін не було; остаточний `git status --short` перевіряється після commit/ZIP й публікується в чаті.

Demo: `https://localhost:8443`, HTTP 8080 redirect, namespace `courier-route`. Для своєї панелі: зареєструйте login → `npm run admin:role:deployment -- --username YOUR_LOGIN --role admin` → увійдіть заново → «Адміністрування». Зняти роль: та сама команда з `--role user`. Host TS/built: `npm run admin:role -- --username YOUR_LOGIN --role admin` / `npm run admin:role:built -- --username YOUR_LOGIN --role user`. Паролі не передаються в CLI; не створено постійного тестового адміністратора в demo.

Безпечне керування власними ресурсами:

```sh
npm run deploy:status
npm run deploy:stop
npm run deploy:local
npm run db:status
npm run db:stop
npm run db:start
# Після зупинки demo, за потреби всієї власної VM:
colima stop --profile courier-route
colima start --profile courier-route --cpu 6 --memory 8 --disk 40
```

Host PostgreSQL керується окремо й залишається на loopback 127.0.0.1:55432; чужі кластери не змінювалися. Demo stop зберігає PVC/CA/credentials і shared Metrics Server; test cleanup прибирає лише власні namespace/PVC/Chrome/forwardings. Фінальний read-only аудит підтвердив: **demo 2 Ready/0 terminating, HPA min=2/max=4/current=2/desired=2, 0 active jobs / 0 admin accounts**, нормальний CA/hostname HTTPS `/api/ready`200; Metrics Server 1 Ready/APIServiceAvailable; ColimaRunning 6 CPU/8 GiB; host PostgreSQL доступний, application role nonsuper/nocreatedb/nocreaterole. **0 test namespaces, 0 kubectl / тимчасових forwardings, 0 власних Chrome/профілів**; чужий Chrome збережено. Demo/Colima/PostgreSQL/shared Metrics залишені працювати. Безпечний аудит: `.local/block09-final-resources.json`, 0600/ignored. .env 0600, auth-тіла/cookie лише memory, тимчасові credentials/profiles/schema/PVC/namespace прибрано. Native syntax усіх 15 .mjs та 34 protected bytes повторно перевірено. Великий benchmark незмінного алгоритму не повторювався за дорученням, це не блокер.

## 11. Архів і наступна межа

Після фінального docs-коміту створюється `/Users/a860/Documents/CourierRoute-block-09.zip` через `git archive --format=zip --output=../CourierRoute-block-09.zip HEAD`. Обов’язкова post-commit перевірка: CRC, commit comment, точний tracked набір та побайтовий вміст кожного файла HEAD; `.git/.env/node_modules/dist/.local/DB/PVC/kubeconfig/Secret/token/keys/browserprofiles/внутрішніPNG/logs/summary` не включаються. Архів нікуди не публікується. Хеш фінального HEAD, фактичний результат archive verification, кількість файлів і остаточний status повідомляються в чаті після створення; звіт після цього не переписується, щоб не змінити HEAD архіву.

Блок 10 — повне приймання/демонстрація всіх вимог. У цьому дорученні його не розпочато; після перевіреного ZIP робота зупиняється.
