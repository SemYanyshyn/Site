# Courier Route — звіт блоку 8

Дата: **24.10.2026, Europe/Kyiv**; сирі часові позначки нижче — UTC. Виконано тільки доручений блок 8; блоки 9–10 не розпочато.

## Статус і джерела доказів

**Готово.** Реальний HPA-цикл **2→4→3→2** пройдено: нові C/D виконали власні задачі з додатним прогресом і completed результатами, підтверджено 4 busy слоти/сесію/чергу, repeat deploy, missing-metric/recovery та stop/start зі збереженням даних. Фінальний прогін — **9 груп + 4 Chrome-спостереження, exit 0**, робота 497159 мс і cleanup 15483 мс. Обов'язкових заблокованих перевірок немає. Причина одного транспортного reset попереднього невдалого прогону не встановлена; його не приховано й не оголошено усуненим без доказів. Manifest, бажані replicas або сам `kubectl top` не видаються за runtime proof.

Вхідний стан: чиста `main`, HEAD **261856ec7f70839fa4dbf722cb151f226f11c804**. Репозиторій не переініціалізовано; справжню налаштовану Git-ідентичність збережено, remote/push не налаштовано. Блок 7 прийнято керівником: він перевірив ZIP із 130 файлами, код і 28 захищених файлів, незалежно повторив npm ci/typecheck/build, **119 non-DB** (23 unit/config/bind/deployment-safety + 36 route/HTTP + 3 jobs config + 43 client + 14 queue), TS/built CLI та production/dev HTTP. **49 PG, 8 container, 10 deployment/fault + 9 HTTPS Chrome, 16 попередніх Chrome й огляд 7 PNG** у блоці 7 підтверджені виконавцем; керівник їх не повторював через відсутні runtime/PG/Chrome та PNG не оглядав. Історичний звіт 7 не змінено. Нижче — нові фактичні перевірки виконавця блоку 8, без приписування їх незалежному прийманню керівника.

Оригінальні вимоги викладача з `docs/assignment.txt` відрізняються від погоджених рішень: числа 2/4, CPU 70%, ресурси, бюджети й таймаути — параметри цього проєкту. Наближений маршрут не має доказу глобальної оптимальності.

## Реалізація й середовище

Додано `deploy/k8s/metrics-server.json`, `deploy/k8s/hpa.json`, `scripts/deployment-autoscale.mjs`, `scripts/deployment-command.mjs`, `scripts/check-autoscale.mjs`, `scripts/check-autoscale-browser.mjs`, `tests/autoscale-safety.test.ts`, оригінальне доручення 8 і цей звіт. Оновлено deployment helper, app rollout strategy, pins, package scripts, README/PLAN/AGENTS та `.gitattributes`. Статичний driver явно передає `autoscaling:false`; його HTTP-helper отримав абсолютний timeout, а старий HTTPS-browser driver експортує чотири наявні helper-и й приймає optional AbortSignal у TLS-запиті. Попередні assertions збережено. Нових npm-залежностей немає.

App/server/client, алгоритм, executor, CLI, SQL 001–003, lock-файл і попередні звіти/доручення збережено. **30 захищених файлів** побайтово звірено з початковим HEAD; дев'ять Git-правил AGENTS збережено дослівно. Вхідний prompt 8 побайтово збігається з наданим файлом; його CRLF/кінцеві пробіли не форматувалися. Один npm-проєкт TypeScript strict, Express/Vite/pg/worker_threads; один worker-слот на HTTP-процес.

| Складова | Фактичний стан |
| --- | --- |
| Host | macOS 26.6.2, Darwin 25.6 arm64; Apple M5, 10 logical CPU, 24 GiB RAM |
| Node / npm | 24.18.0 / 11.16.0 |
| VM | Власний Colima 0.10.3/Lima 2.2, profile `courier-route`, VZ/virtiofs, **6 CPU / 8 GiB / 40 GiB disk** |
| Docker | CLI 29.7.2 / daemon 29.5.2; явний socket профілю, глобальний context `default` збережено |
| Kubernetes | kind 0.32.0, Kubernetes 1.36.1, kubectl 1.36.3; один node `courier-route-control-plane` |
| Allocatable node | **6 CPU / 8111968 Ki RAM / 110 pods**; достатньо для чотирьох app із заданими requests |
| Context / kubeconfig | `kind-courier-route` / `.local/deploy/kubeconfig` |
| Namespace | Demo `courier-route`; add-on `courier-route-metrics`; випадкові окремі test namespace |
| HTTPS | `https://localhost:8443/`, HTTP `:8080` → HTTPS; host ports лише loopback |
| App artifact | `courier-route:block07-e4a6d78772c5ab5f`; Docker image **config ID (.Id)** `sha256:f8efa30f253028b6c017dd5c2eae7fe05ae8cba641b54490570670200cdb4904`, linux/arm64, **81143425 байтів** |

Тег `block07-*` лишається форматом наявного helper-а: це fingerprint фактичних build inputs, не номер завершеного блоку. Образ має label із цим fingerprint, nonroot user `node` та закріплений Node; повторний build із незмінними inputs повторно використовує **той самий artifact ID**. Registry push не виконувався.

### Metrics Server і TLS/RBAC

Обрано стабільний **Metrics Server 0.9.0**, сумісний із Kubernetes **1.34+**, включно з нашим 1.36.1: [офіційна матриця](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.0/README.md#compatibility-matrix), [release](https://github.com/kubernetes-sigs/metrics-server/releases/tag/v0.9.0).

- Image: `registry.k8s.io/metrics-server/metrics-server:v0.9.0@sha256:d9862115e7c7881280d3d75ca26bda8ffc0fc213315979575bf23ce9826205c0`.
- Arm64 manifest: `sha256:d0341e07a1cf2b751e684cba68e2a0c62d3c5d2d23501fd67dc384d517ec65de`.
- Джерело `components.yaml`: [закріплений release asset](https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.0/components.yaml); SHA256 **1cec29a5267809306a2c6ec74a3e449abbb705b4a8beed0c8a1963910f72c79b**. Застосовується tracked адаптований JSON, не `latest` або прихований download.

Перед будь-якою зміною перевіряються власний cluster/node/image/version та **всі 10 цільових об'єктів** add-on за kind/name/namespace/manager/owner UUID. Сторонній Metrics Server/APIService/RBAC не привласнюється. Namespace/Deployment/Service/SA — власні; ClusterRole/ClusterRoleBinding мають наші імена/owner labels. У `kube-system` створено лише власний RoleBinding до стандартного `extension-apiserver-authentication-reader`; authn/authz Kubernetes не вимикалися. App service account token не монтується, прав Kubernetes API застосунку не додано. Test cleanup спільний add-on не видаляє.

Локальний kubelet `172.18.0.2:10250` фактично має serving certificate з DNS SAN `courier-route-control-plane`, виданий node-local CA; перевірка проти cluster CA не проходить. Тому **лише Metrics Server→kubelet** використовує `--kubelet-insecure-tls`. Також upstream APIService має **`insecureSkipTLSVerify:true`**: aggregation API→Metrics Server шифрується без перевірки його serving certificate. Це два явні локальні TLS-винятки, не повна перевірка сертифікатів цих каналів. Kubectl перевіряє API-server TLS; app HTTPS, перевірка hostname/проєктної CA, cookie та Origin не послаблені. Для зовнішнього кластера потрібні належні CA/serving certificates.

`APIService v1beta1.metrics.k8s.io` фактично **Available=True**; raw node/pod metrics і `kubectl top` повертають виміряні CPU/RAM. Наприклад, node sample **2026-10-23T23:07:58Z**, window **9.91s**, CPU **211726034n** (211.726m), RAM **925012Ki**; app sample **23:07:51Z**, window **10.873s**, CPU **6323185n** (6.323m), RAM **35228Ki**. Це різні sampling clocks, не синхронні з моментом HTTP/SQL-спостереження. CPU — швидкість за window, RAM — working set; знімки не є історичною базою або точним профайлером.

### HPA, replicas і життєвий цикл

| Параметр | Demo і HPA-тест |
| --- | --- |
| Target | `autoscaling/v2`, тільки `Deployment/app`, CPU Resource metric |
| Replicas | **min 2 / max 4** |
| CPU target | **70%** від request **250m**, приблизно **175m на pod** |
| Scale-up | stabilization **0 с**, **+2 pod / 30 с**, Max |
| Scale-down | stabilization **180 с**, **−1 pod / 30 с**, Max |
| App request / limit | **250m / 1000m CPU**, **128 / 384 MiB RAM** |
| PG request / limit | **100m / 1000m CPU**, **128 / 512 MiB RAM**, PVC 2 GiB |
| Metrics request / limit | **100m / 500m CPU**, **200 / 300 MiB RAM**, scrape resolution 15 с |
| Traefik request / limit | **50m / 500m CPU**, **64 / 192 MiB RAM** |
| App rollout | **maxSurge=0 / maxUnavailable=1** |
| Незмінні job limits | **500 точок / 200 млн ітерацій / 30000 мс**, active/user=3, outstanding=100 |

70% обрано для реакції на справжній CPU-пошук без вимоги вичерпати весь CPU limit. Utilization може перевищувати 100%, бо denominator — request, не limit чи весь Mac. Поведінку звірено з [документацією Kubernetes 1.36 HPA](https://v1-36.docs.kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/). Нові app pod на цій самій VM ділять фізичні CPU; лінійне прискорення не гарантується.

Tracked app manifest не задає `spec.replicas`. Для нового або явно зупиненого Deployment helper один раз задає **2**, після чого прибирає тільки replicas зі старої last-applied annotation до подальшого apply. Звичайний повторний deploy не записує поточне число і не повертає його до 2/1. Інші старі поля annotation зберігаються для коректного видалення змінених полів; optimistic JSON-patch test захищає від зміни annotation між читанням і записом. Це відповідає [офіційній передачі керування replicas](https://v1-36.docs.kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/#changing-the-owner-from-a-configuration-file-to-a-direct-imperative-writer).

Stop перевіряє власників і видаляє **лише власний HPA перед scale-to-zero**, чекає фізичного виходу app/Traefik, потім зупиняє PG. PVC/credentials/CA/успішний migration Job і shared Metrics Server лишаються. Start відновлює 2 та HPA без нової БД або автоматичного повторного виконання jobs. Статична регресія окремо використовує `autoscaling:false`, рівно 2 app і тестовий global outstanding=4.

Rolling update з `maxSurge=0` не додає планового surge, але terminating процеси можуть ще жити; `maxReplicas=4` не доводить жорсткої межі всіх живих процесів під час довільного rollout. У вимірюваному нормальному HPA-циклі додаткові app виконують той самий image; terminating, Ready, endpoints та свіжий DB-реєстр враховуються окремо. [Deployment semantics](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

## Команди й виконані перевірки

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run route:demo
npm run route:demo:built
npm run image:build
DOCKER_HOST="unix://$HOME/.colima/courier-route/docker.sock" npm run test:container -- "$(node --input-type=module -e 'import { imageName } from "./scripts/deploy-local.mjs"; console.log(await imageName())')"
npm run deploy:local
npm run test:deployment
npm run test:autoscale
```

TEST_DATABASE_URL явно задано в ігнорованому `.env`; guard перевірив окрему test-БД проти робочого endpoint. URL/паролі/cookie/claim tokens/Secret/private keys у звіт чи shell history не виводилися. PG-тести використовували справжню PostgreSQL та окремі випадкові схеми, не моки.

| Перевірка | Фактичний результат блоку 8 |
| --- | --- |
| npm ci | Exit 0, 133 пакети; lock незмінний; попередження allowScripts для esbuild/fsevents не завадили build |
| Typecheck / build | PASS, у тому числі фінальний повтор після виправлення handoff |
| npm test | **183 PASS / 0 FAIL / 0 SKIP**: 38 unit/config/safety + 36 route/HTTP + 13 auth PG + 27 jobs (3 config + 24 PG) + 43 client + 26 queue (14 non-DB + 12 PG); усього **49 PG / 134 non-DB** |
| Фінальна unit-регресія | **38/38 PASS**, включно з **15** новими autoscale guards/proof/budget/quantity/deadline/uncertain-cancel tests і точним LF handoff; реальний HTTP trickle зупиняється абсолютним timeout |
| TS / built CLI | Обидва exit 0, квадрат length=4, seed=0 |
| Container, фінальний image | **8/8 PASS**, cleanupErrors=0 |
| Статичний Kubernetes/HTTPS | **10/10 deployment/fault + 9/9 Chrome PASS**, остаточний повтор після виправлень: cleanupCompleted=true, **120865 мс**, непланових gateway-відмов **0** |
| Повний HPA/HTTPS/browser цикл | **9/9 груп + 4/4 Chrome-спостереження PASS**, 84 accepted, 0 failed/restart/OOM/transport у фінальному run 4, cleanup=true, **512642 мс** разом |
| Старі 16 local production/dev Chrome | Не повторювалися в блоці 8: client/auth/dev flow не змінювалися; їхній історичний результат лишається у звітах 6/7 |

Container proof: UID 1000, Node/npm pins, runtime без source/dev tools і bind mounts, CLI з `/tmp`, HTML/JS/CSS доступні, ready=503 за відсутньої БД, compiled migrations 001–003 та nonsuper роль, auth=201/200/me200. Реальний worker спостерігався на **5747712 ітераціях**, RSS **89256 KiB**, health/ready=200. SIGTERM під час пошуку завершився за **109.62 мс**, exit 0, job → **failed/server_shutdown**. Власні контейнери/мережа/тимчасові env прибрано.

Статичний proof: дві реальні Ready replicas, нормальна TLS/CA/hostname перевірка та відмова неправильним CA/hostname, Secure HttpOnly спільна сесія, Origin/proxy guard, реальні worker/queued ETA, фізичний cancel через інший handler, ownership404, атомарні квоти, SIGTERM **server_shutdown** із заміною pod, SIGKILL **worker_lost лише після persisted lost_after**, PG restart на тому самому PVC зі збереженою сесією/результатом, public503 за відсутньої БД та localhealth200, logout через інший процес. У фінальному статичному повторі непланових gateway convergence failures **0**; у попередньому успішному повторі була **1** минуща відмова під час replacement, повторювалися лише безпечні GET. Фінальні graceful scenario **4238 мс**, SIGKILL recovery **51166 мс**, PG restart **18115 мс**. Це окремі fault-сценарії, не нормальний HPA load.

Для статичного Chrome пройдено 9 груп: HTTPS auth, обидва handler, справжній квадрат/SVG/reload без POST, invalid input без POST, два worker/queued/429, реальний прогрес/cancel, нова задача/history/focus/360px, logout, відсутність console/resource/mixed-content помилок. **Усі 7 PNG фактично оглянуто**: desktop top/result і mobile queue/quota/running/square/form. Текст ETA/429, прогрес, SVG та фокус читабельні без перекриття чи горизонтального обрізання; це вибрані viewport-секції, не full-page capture. Внутрішні PNG лишаються ігнорованими.

Chrome запускається з новим приватним профілем через native CDP. Перед запуском звичайний HTTPS-клієнт перевіряє проєктну CA/localhost; Chrome отримує виняток **лише SPKI конкретного перевіреного leaf**, без глобального `ignore-certificate-errors`, зміни user trust store або використання особистого browser profile. Це не твердження про довіру сертифікату звичайним профілем користувача. Після перевірки Chrome/профіль із cookie прибираються.

## Проміжні помилки й виправлення

1. Перший apply Metrics Server передавав змішаний List із namespace `courier-route-metrics`, що не дозволило створити потрібний власний RoleBinding у `kube-system`. Add-on мав 403 читання extension auth ConfigMap і 5 історичних рестартів. Виправлено застосування кожного об'єкта з його точним namespace після спільної перевірки всіх власників; RBAC і API Available фактично відновлено. Попередній ProgressDeadlineExceeded після цих рестартів не зараховувався за readiness; остаточний deploy завершився exit 0.
2. Проміжний HPA run 1 досяг 4 Ready, чотирьох busy worker, числової ETA **5153 мс при executorCount=4** і Chrome baseline/expanded, але **FAIL** на суворій перевірці незмінного generation після repeat deploy, приблизно 110 с. Replicas лишилися 4; повний цикл тоді не був пройденим. Окремий fresh-namespace diagnostic довів: handoff прибирав кінцевий LF із last-applied, а kubectl повертав його при repeat; Kubernetes збільшує generation і за зміни annotations. Виправлено канонічний LF, додано exact-string unit. Два наступні repeat на новому namespace зберегли replicas=2, generation=2, exact annotation, template hash і обидва pod UID. Сувору перевірку generation при 4 не послаблено; повний HPA-тест запущено заново. Усі ці власні namespace/PVC/credentials/forwardings прибрано.
3. Build повторював Docker-збирання того самого source tag і міг створювати інший artifact ID через metadata. Helper тепер перевіряє fingerprint label/runtime/nonroot та повторно використовує той самий image; фактичний repeat зберіг ID.
4. Проміжний unit-запуск усередині sandbox отримав `listen EPERM` у 4 HTTP-bind тестах. Повтор із дозволеним локальним bind завершився **33 PASS**; остаточний розширений набір згодом пройшов **38/38**. Це обмеження запуску, не пропущений успіх і не виправлення продуктового коду.
5. Review виявив, що початкова перевірка загального deadline не переривала довгі helper-команди. Додано `scripts/deployment-command.mjs`: async scope із абсолютним бюджетом, обмеження часу кожного child, SIGKILL і очікування фактичного close; прострочений scope не дозволяє нову команду, nested scope не подовжує батьківський. Cleanup має окремі скінченні таймаути поза вичерпаним бюджетом. Три реальні child-process тести підтвердили припинення delayed mutation, відсутність живого PID, незалежність concurrent scopes і можливість cleanup після expiry.
6. Проміжний run 2 пройшов реальний 2→4→2, C/D completed, repeat-at-four, браузер і missing-metric/recovery, але **FAIL** після stop/start: нові 2 pod/endpoints/executors уже були готові, PVC/CA збереглися, а перший HTTPS `/me` отримав transport failure. Новий square POST ще не подавався. Загальний час **536121 мс**, cleanup=true; повний набір тоді не зараховано як PASS. Причина — старий service port-forward залишав локальний socket відкритим із прив'язкою до видаленого Traefik pod. Stop тепер фізично завершує власний forwarder і чекає його close, start створює новий на тих самих портах. Окремий наступний mini-тест виявив HTTP503 до збіжності EndpointSlice/Traefik cache; provision/start тепер bounded-очікує **нормально перевірений CA/hostname HTTPS GET /api/health=200 із реальним UUID** перед поверненням. Невизначені POST не повторюються. Після обох виправлень **два справжні stop/start цикли** на новому namespace пройшли з першого `/me=200`, тією самою cookie, PVC/CA/credentials/результатом та новими completed квадратами. Попередні невдалі mini-діагностики не зараховані як PASS; їхні ресурси прибрано.
7. Проміжний run 3 пройшов розширення до 4, обидві browser load-фази, суворий repeat-at-four та foreign404, але завершився **FAIL** через негайний `ECONNRESET` під час running cancel POST. Запит не повторювався; останній snapshot мав 0 failed/0 restart. Work **127511 мс**, cleanup **15498 мс**. До cleanup не збережено достатньої діагностики для доведеного пояснення reset, тому його не приписуємо ні crash застосунку, ні достеменно forwarding. Додано безпечний pre-cleanup стан pod/forwarder та узгодження невизначеного cancel через читання; така спроба не зараховується до строгого 202 cross-handler proof. Наступна окрема intentional-cancel кандидатура можлива лише в межах тих самих лімітів, без повторного POST тому самому ID; реальний 202/інший handler/terminal cancelled лишаються обов'язковими.

Окремий bounded static2 diagnostic після run 3 пройшов: два справжні worker, live Chrome baseline, repeat deploy, foreign cancel404, **120 паралельних HTTPS GET**, один власний cancel **202→cancelled**; транспортних відмов **0**, app/PG/Traefik Ready із **0 restart**, forwarding PID незмінний. Дві інші задачі завершили по **200000000** ітерацій, cancelled мала **189151232** фактичні ітерації. Namespace/PVC/credentials/Chrome/forwarder прибрано. Reset не відтворено: його першопричина лишається **невстановленою**, а не оголошується виправленою без доказів. Новий реальний loopback committed-then-reset тест підтвердив рівно один POST, read-only узгодження, заборону підміняти відсутній 202 і відхилення failed worker. Це перевірка надійності driver, не додаткова HPA-метрика.

## Реальний обмежений HPA-сценарій

Команда **`npm run test:autoscale`** використовує окремий випадковий власний namespace, PG/PVC/test-БД, той самий production image/Traefik/HPA та три звичайні облікові записи. Межі executable: **3 власники × 3 active = максимум 9**, до **200 accepted** загалом, подача нових route jobs **120000 мс**, загальний deadline **720000 мс**, polling **2000 мс**. Для load лишається резерв двох accepted на browser square та restart square. Один normal-user паралельний burst перевіряє 3 accepted + 429. Невизначений POST не повторюється. Немає CPU burner, штучного sleep у пошуку, ручного scale до 3/4, змінених route timeout/TTL/lost_after або збільшених квот. Лише HPA керує replicas у вимірюваній фазі.

Один абсолютний epoch deadline передається всім helper child-командам, HTTP та browser observer. Команди фізично завершуються при expiry; HTTP timer зупиняє й активний повільний потік, а не лише idle socket. Browser abort закриває TLS/CDP і власний Chrome; concurrent POST очікуються через allSettled до cleanup, без залишених mutation promises. Паузи обмежені залишком бюджету. Cleanup має власні скінченні таймаути поза work budget; у summary окремо записуються work/cleanup/total elapsed. Додаткові негативні instrumentation-перевірки: прострочений browser deadline не запускає ownership/work; реальний частковий TLS-запит фізично перервано за **97 мс**; isolated Chrome із тестовим budget **2500 мс** завершився й прибрав профіль за **2543 мс** разом із cleanup. Ці перевірки не видаються за доказ autoscaling.

Фінальний **run 4 PASS**, namespace **courier-route-test-hpa-1fb9468125**, context **kind-courier-route**. Робота **497159 мс**, cleanup **15483 мс**, разом **512642 мс**; work budget 720000 мс не вичерпано. Пройдено **9 груп**, Chrome — **4 спостереження**, cleanupCompleted=true. Прийнято **84 jobs** загалом, включно з одним UI-квадратом і одним квадратом після restart. Максимум одночасних queued+running у trace — **9**, максимальна кількість nonterminating app — **4**. Транспортних відмов у фінальному прогоні **0**, невизначених cancel **0**.

Подача почалася на **45908 мс**, ініціювання нових load POST обмежене вікном 120000 мс; цикл driver зафіксував stop на **167897 мс** (разом із останнім polling). Усі load jobs кінцеві на **179169 мс**. Чотири coherent busy worker підтверджено на **97408 мс**, тобто через **51500 мс** після початку подачі; перше фізичне Ready=4 у trace — **77366 мс**. Повернення coherent 2 — **419506 мс**, через **240337 мс** після terminal усіх load jobs.

У таблиці CPU/RAM — фактичний min–max серед наявних app samples, не показник цілого Mac; HPA utilization має окремий sampling/reconciliation clock. Час observation відрізняється від timestamp/window Metrics API; Kubernetes і SQL читалися паралельно, тому проміжні desired/current/Ready/registry можуть різнитися. У початковому/expanded/кінцевому coherent snapshots перевірено точний збіг фізичних pod UID, Ready endpoints, instance UUID, свіжих метрик і DB-виконавців.

| Спостереження UTC / elapsed с | Точка | Timestamp app samples UTC / window с | CPU m / RAM MiB | HPA CPU% current→desired | Ready / terminating / endpoints / executors | queued / running / completed / cancelled / failed |
| --- | --- | --- | --- | --- | --- | --- |
| 23:44:46.981 / 44.445 | Початковий coherent idle | 23:44:29–23:44:34 / 7.114–13.755 | 19.9–23.5 / 21.7–22.8 | 9%; 2→2 | 2/0/2/2 | 0/0/0/0/0 |
| 23:44:48.683 / 46.147 | Два зайняті слоти й черга | 23:44:29–23:44:34 / 7.114–13.755 | 19.9–23.5 / 21.7–22.8 | 9%; 2→2 | 2/0/2/2 | 1/2/0/0/0 |
| 23:45:17.101 / 74.565 | Перше desired=4 | 23:45:02–23:45:04 / 18.672–19.971 | 763.9–779.5 / 44.9–45.1 | 308%; 2→4 | 2/0/2/4 | 5/4/10/0/0 |
| 23:45:39.944 / 97.408 | 4 coherent / busy / числова ETA | 23:45:14–23:45:26 / 10.868–15.168 | 976.1–986.8 / 39.2–46.7 | 392%; 4→4 | 4/0/4/4 | 4/4/25/0/0 |
| 23:46:50.668 / 168.132 | Подачу припинено | 23:46:23–23:46:36 / 10.609–19.155 | 982.2–986.8 / 46.1–49.8 | 393%; 4→4 | 4/0/4/4 | 3/4/73/2/0 |
| 23:47:01.706 / 179.169 | Усі load jobs кінцеві | 23:46:42–23:46:52 / 13.601–19.253 | 975.7–981.3 / 48.0–51.3 | 391%; 4→4 | 4/0/4/4 | 0/0/80/2/0 |
| 23:50:16.700 / 374.162 | Автоматичне зменшення до 3 | 23:49:59–23:50:08 / 13.833–17.028 | 5.6–24.9 / 34.9–40.3 | 4%; 4→3 | 3/0/3/3 | 0/0/80/2/0 |
| 23:51:02.044 / 419.506 | Знову рівно 2 coherent | 23:50:44–23:50:46 / 11.809–16.504 | 10.4–22.2 / 35.6–36.5 | 6%; 2→2 | 2/0/2/2 | 0/0/80/2/0 |

HPA сам задав desired=4 за реального CPU вище цілі; у нормальній фазі жодного п’ятого nonterminating app не спостерігалося. Після terminal CPU впав, controller витримав stabilization і зменшив число без ручного scale. Вікно 180 с не є обіцянкою повернення рівно на 180-й секунді: враховуються останні рекомендації, −1/30 с, reconciliation, фізичний вихід, endpoints та TTL реєстру. У normal load/downscale немає failed/timeout/OOM/worker_lost/server_shutdown; terminating враховано окремо.

### Початкові й додаткові справжні процеси

| Роль | Pod | Pod UID | Instance UUID |
| --- | --- | --- | --- |
| A | app-58c7cdd9fb-4mr9d | 3b4335ce-5cef-41d8-b50a-35fcf23ed4d6 | d9d13774-c7c9-4a3f-b23d-3b0c64f2d38d |
| B | app-58c7cdd9fb-qcmpf | 700470bf-6928-4b4a-9972-409d75238362 | 71751f00-3bf6-4934-ad4a-743eded1737b |
| C | app-58c7cdd9fb-4mfcr | f34c2ddf-0660-4cbb-8c39-f6ac9501ea85 | 5fb013ed-250e-4ba4-b38f-fa70454f2ae5 |
| D | app-58c7cdd9fb-bkl69 | 6890f378-4884-47dd-af21-9c3dcc8717c6 | b385ba11-707b-454c-8856-56395a25dda4 |

Усі чотири pod мали однаковий runtime containerd `imageID`/manifest digest **docker.io/library/import-2026-10-23@sha256:f52cc6c0ade231b74abfb952fc987a3a47704aba703e6da414ad5a626965443d**. Це manifest digest імпортованого OCI-образу, а не Docker config `.Id` f8… із таблиці середовища.

| Додатковий процес | Та сама job: positive running → completed | Спостережені фактичні ітерації | Terminal UTC / виконано |
| --- | --- | --- | --- |
| C / 5fb013ed-250e-4ba4-b38f-fa70454f2ae5 | 01e43223-490f-4d03-afbb-b62c191436cb | 126190592 > 0 | 2026-10-23T23:45:21.9063+00:00; 200000000/200000000 |
| D / b385ba11-707b-454c-8856-56395a25dda4 | 2d38127f-ed11-44fa-876e-58170fbf259e | 133963776 > 0 | 2026-10-23T23:45:21.69603+00:00; 200000000/200000000 |

Для кожної з цих двох jobs окремо прочитано справжні details і перевірено 500 точок, замкнену permutation 0→1..N→0, seed, повні 200 млн ітерацій та перераховану евклідову довжину з tolerance; length не гірша за початкову. 100% видається тільки completed. Audit усіх виконаних load jobs: **82**, максимум **1 committed queued→running claim на job**, instance_id audit збігається з persisted executedBy. Нормальних completed **80**, навмисних cancelled **2**; обидва наступні квадрати також completed. Одночасні running мають різні executedBy і відповідають одному busy слоту кожного свіжого процесу.

| Pod | Реальні advancing timestamps / samples | Піковий CPU m |
| --- | --- | --- |
| app-58c7cdd9fb-4mfcr | 2026-10-23T23:45:26Z → 2026-10-23T23:46:36Z; 6 samples | 986.800 |
| app-58c7cdd9fb-4mr9d | 2026-10-23T23:44:26Z → 2026-10-23T23:46:23Z; 9 samples | 993.420 |
| app-58c7cdd9fb-bkl69 | 2026-10-23T23:45:26Z → 2026-10-23T23:46:28Z; 6 samples | 982.226 |
| app-58c7cdd9fb-qcmpf | 2026-10-23T23:44:26Z → 2026-10-23T23:46:30Z; 10 samples | 989.089 |

Queued API metadata: baseline **10902 мс**, executorCount=**2**, basis=measured; expanded **250 мс**, executorCount=**4**, basis=measured. Це оцінка до старту, не гарантія й не час алгоритму. Одна й та сама авторизована cookie проходила через усі чотири HTTP UUID; окремий Chrome-сеанс звіряв той самий userId через кожен handler без повторного login. Foreign detail/cancel лишилися 404. Strict cross-handler cancel: job **9d0f6dfe-9ea3-45e4-a8b7-e3a9ceb969f9**, executedBy **5fb013ed-250e-4ba4-b38f-fa70454f2ae5**, handler **71751f00-3bf6-4934-ad4a-743eded1737b**, HTTP **202** → **cancelled**. Окремих intentional-cancel кандидатур **2**, повторного POST тому самому ID немає.

Repeat deploy при 4 на **101161 мс** зберіг replicas=4, generation=**3**, revision, exact annotation, template та всі чотири UID; HPA лишився власником replicas. Missing-container negative case: **False/FailedGetContainerResourceMetric**, replicas=**2**; правильний Resource CPU відновлено, shared Metrics Server не вимикався.

Stop видалив власний HPA перед 0; п’ятисекундна перевірка підтвердила, що він не воскресив app. Start відновив **2** із HPA; той самий PVC UID **0078bd6f-2a02-46da-b46f-d634bef9ba71**, CA/credentials/сесія/результат **5c0cabe0-09df-4d1b-a4fb-e16ab5a02cd6** збережені. Новий HTTPS square **57c77c1e-0420-4f38-ad01-48d8cf7b3210** completed, length=4/seed=0. Перший postrestart /me=200; невизначеного POST/retry немає.

Chrome: **1 login**, **1** новий UI POST після downscale; login → baseline → expanded → returned-to-two. Збережений результат/history/SVG, reload без POST і новий square/reload пройшли в тому самому сеансі. Viewport 1280×900 / 360×900; console errors **0**, failed JS/CSS **0**, mixed content **0**. **Усі 7 PNG фактично оглянуто**: desktop ETA 13 с / 2 виконавці / прогрес 3,7%; 360px ETA менше секунди / 4 виконавці / прогрес 14,5%; після downscale збережений 500-точковий маршрут, текстовий порядок, completed квадрат length=4/seed=0/час 2,525 мс і чіткий keyboard focus. Перекриття та горизонтальне обрізання не виявлені. History PNG показує секцію великої панелі, а не весь 500-точковий результат за один кадр.

## Git, архів, cleanup і наступна межа

Створені кодові коміти:

- `aaa774e` — `feat(deploy): add resource metrics and bounded autoscaling`.
- `b23317f` — `fix(deploy): renew HTTPS forwarding after explicit restart`.
- `305f755` — `test(autoscale): verify new replicas execute queued work`.

Звіт/README/PLAN/AGENTS, незмінний оригінал доручення 8 і його `.gitattributes` фіксуються окремим останнім docs-комітом. Хеш самого цього коміту повідомляється в чаті після commit, без самопосилального переписування звіту. Гілка **main**; після docs-коміту перевіряється порожній `git status --short`. Сторонніх змін на початку не було, історію не переписано, remote/push/публікацію не виконано. 30 захищених файлів, дослівний prompt і дев'ять Git-правил звірено; working/staged secret scan і whitespace-check власних файлів пройшли. Лише оригінальний prompt 8 із CRLF/кінцевими пробілами виключено з форматувальної перевірки без редагування його байтів.

Після всіх тестів **2026-10-23T23:54:09.507Z** окремо перевірено demo: **2 Ready app**, restarts=0, HPA current/desired=2/2, Metrics API Available=True, `https://localhost:8443/api/ready`=200 через **обидва** handler UUID `4071fb52-96bf-466b-8ed3-b442ecbda98f` і `369f67d4-3870-4d91-8c28-490a5aa26c99`. Власних namespace лишилося рівно два: `courier-route`, `courier-route-metrics`; тимчасових test namespace **0**. Єдиний Docker container — власний kind node; глобальний Docker context збережено `default`. `.env` має **0600**.

Власні test jobs/users/schema/PG/PVC/HPA/namespace, тимчасові контейнерні мережі/env, Chrome із профілями/cookie, port-forward та тестові HTTP/worker-процеси прибрано. Безпечні logs/summary/PNG лишаються тільки в ігнорованій `.local`. Немає прихованого генератора або активних load jobs. **Залишено запущеними** Colima profile/kind `courier-route`, demo **2 app + 1 Traefik + 1 PostgreSQL/PVC** та **1 shared Metrics Server**; завершені migration Job, CA і credentials збережено. Безпечна зупинка без видалення даних і наступний запуск:

```sh
npm run deploy:status
npm run deploy:stop
colima stop --profile courier-route
# Наступний запуск:
colima start --profile courier-route --cpu 6 --memory 8 --disk 40 --runtime docker --vm-type vz --mount-type virtiofs --activate=false
npm run deploy:local
```

`deploy:stop` видаляє лише власний HPA перед 0 і чекає app перед PG; shared Metrics Server/PVC/CA/credentials не видаляються. Namespace stop/start через той самий helper фактично перевірено двома mini-циклами та фінальним повним HPA run; усю VM у блоці 8 не перезапускали. Окремий host PostgreSQL 18.4 **залишено запущеним на 127.0.0.1:55432** у стані до роботи; він не переналаштовувався й не очищувався. Перевірена команда status і точні команди керування: **`npm run db:status`**, **`npm run db:stop`**, **`npm run db:start`**. Colima stop не зупиняє цей окремий host PostgreSQL.

ZIP: **`/Users/a860/Documents/CourierRoute-block-08.zip`**. Він створюється після фінального docs-коміту тільки з точного HEAD:

```sh
git archive --format=zip --output=../CourierRoute-block-08.zip HEAD
open -R /Users/a860/Documents/CourierRoute-block-08.zip
```

Перед передачею окремо перевіряються CRC, commit-коментар SHA, точний набір та кожен байт tracked файлів фінального HEAD. Архів містить джерела, звіт, lock, SQL і тести; `.git`, `.env`, `.local`, node_modules, dist, БД/PVC, kubeconfig, Secret values, TLS private keys, browser profiles, внутрішні PNG/logs/summary до нього не входять. Фінальний SHA й результат перевірки ZIP повідомляються в чаті після його створення. Архів лишається локальним.

Блок 9 — адміністраторська панель з усіма екземплярами/задачами та реальними метриками; блок 10 — повне приймання. Продуктового адміністративного API/UI або іншого функціоналу наперед не додано. Після блоку 8 — зупинка перед 9.
