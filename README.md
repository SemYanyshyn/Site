# Courier Route

Навчальний планувальник короткого маршруту одного кур'єра на координатній площині: склад → усі точки доставки → склад. Координати й одиниці довжини умовні. Ітеративний пошук повертає найкращий знайдений маршрут без гарантії глобальної оптимальності.

Працюють особисті задачі й історія, справжні worker threads, PostgreSQL-черга з приблизною ETA, HTTPS через Traefik, 2–4 незалежні app-процеси під HPA та read-only панель адміністратора з реальними CPU/RAM. Пункти 1–8 і HTTPS входять у погоджений обсяг; межі 3 active / 100 outstanding / 2–4 pod — рішення проєкту, а не числа з умови викладача.

**[Сценарій демонстрації](docs/demo-guide.md) · [Матриця приймання 1–8](docs/acceptance-matrix.md) · [Фінальний звіт блоку 10](docs/block-10-report.md)**

Фінальні перевірки 24.10.2026: **227 npm-тестів (167 non-DB +60 PG)**, 8 container, 10 static/fault +9 HTTPS Chrome, 16 local Chrome, 7 admin груп та **один HPA 2→4→3→2** (10 груп, 81 accepted/80 completed/1 intentional cancelled/0 failed) пройшли. Фактично оглянуто **42 PNG**; HPA разом із cleanup тривав 9 хв 21,899 с. Межі доказів, проміжні помилки й відмінність від незалежного приймання керівником наведено у звіті.

Для вже підготовленого локального середовища:

```sh
cd /Users/a860/Documents/Site
export COURIER_DOCKER_HOST="unix://$HOME/.colima/courier-route/docker.sock"
export DOCKER_HOST="$COURIER_DOCKER_HOST"
npm run deploy:local
npm run deploy:status
curl --fail --cacert .local/deploy/tls/ca.crt https://localhost:8443/api/ready
open https://localhost:8443/
```

Потрібні запущений власний Colima-профіль, установлені залежності та інструменти; перший запуск описано нижче. Для звичайного браузера користувач сам надає довіру **лише локальній CA**, скрипти Keychain не змінюють. Зареєструйте свій логін, замініть `YOUR_LOGIN` у команді `npm run admin:role:deployment -- --username YOUR_LOGIN --role admin` та увійдіть повторно. Адміністратора за замовчуванням немає.

Фінальний аудит 24.10.2026 підтвердив demo **2 Ready / 0 terminating / 2 idle executor**, HPA current=desired=2 і звичайний CA-verified ready 200; тестові ресурси прибрано. Colima, спільний Metrics Server і окремий host PostgreSQL залишено працювати.

Зупинка demo зі збереженням PVC/CA/даних: `npm run deploy:stop`; за потреби після неї `colima stop --profile courier-route`. Окремий host PostgreSQL зупиняється через `npm run db:stop`.

Фінальний **source ZIP** містить код, міграції, manifests, документацію, приклади, тести й lock. Він не містить `.git`, `dist`, `node_modules`, `.env`, VM/PVC/готову БД, credentials, local CA/ключі чи приватні PNG/logs. Чистий source smoke і повторне використання наявного PVC — різні сценарії; точні результати та межі наведено у звіті 10. Історичні результати блоків збережено внизу цього README й у незмінних звітах. Свіжий source smoke з `git archive ed87fc4` без головних `.env/.local/node_modules/dist/.git` пройшов `npm ci`, typecheck/build, TS/built CLI й production/Vite HTTP без БД; нову VM/повний кластер для цього вдруге не створювали.

## Локальний HTTPS у Kubernetes

Основний шлях — окремий Colima-профіль і kind-кластер на macOS arm64. Із чистого checkout потрібні Node.js 24/npm 11, Docker CLI, Colima з працюючим daemon, kind, kubectl та OpenSSL у `PATH`. Для браузерної перевірки потрібен наявний Google Chrome. Ресурс власної VM: **6 CPU та 8 GiB RAM**; перше завантаження образів потребує мережі й вільного диска. Наявний придатний Docker runtime не потрібно замінювати заради другого; використовуємо окремий Colima-профіль `courier-route`.

Версії та офіційні джерела зафіксовані у [deploy/versions.json](deploy/versions.json); образи там і в Dockerfile закріплені тегом та digest.

| Компонент | Перевірена версія |
| --- | --- |
| Node.js / npm | `24.18.0` / `11.16.0`, `node:24.18.0-bookworm-slim` |
| kind / Kubernetes | `0.32.0` / `1.36.1`, `kindest/node:v1.36.1` |
| kubectl | `1.36.3` |
| PostgreSQL | `18.4`, `postgres:18.4-bookworm` |
| Traefik | `3.7.15`, `traefik:v3.7.15`, provider `kubernetesIngress` |
| Metrics Server | `0.9.0`, підтримує Kubernetes `1.34+`, зокрема наш `1.36.1` |

На цій машині відсутні інструменти встановлено командою `brew install colima docker kind kubernetes-cli`. Якщо поточний Homebrew пропонує інший kind, використайте закріплений 0.32.0 з офіційного release, наведеного у versions.json; preflight перевіряє kind і сумісний kubectl.

Із кореня проєкту виконайте:

```sh
npm ci
colima start --profile courier-route --cpu 6 --memory 8 --disk 40 --runtime docker --vm-type vz --mount-type virtiofs --activate=false
export COURIER_DOCKER_HOST="unix://$HOME/.colima/courier-route/docker.sock"
export DOCKER_HOST="$COURIER_DOCKER_HOST"
npm run deploy:preflight
npm run image:build
npm run deploy:local
npm run deploy:status
```

`--activate=false` й явний socket зберігають глобальний Docker context. `deploy:preflight` перевіряє доступність daemon та потрібних інструментів. Відсутній daemon або невідповідні версії завершують команду помилкою; сама наявність Docker CLI недостатня. Helm не потрібний: застосовуються локальні JSON-маніфести з `deploy/k8s/`.

`image:build` збирає production-образ із тегом, обчисленим із файлів збирання. Якщо локальний образ уже має правильний fingerprint label, nonroot user і закріплений Node, helper зберігає той самий artifact ID; після зміни build inputs створює новий тег. `deploy:local` завантажує образ у kind, установлює власний Metrics Server, піднімає окремий PostgreSQL, явно виконує зібрані міграції окремим Job, потім чекає Ready застосунку й Traefik та вмикає HPA. Останній JSON команди містить фактичні image, URL і шлях до CA. Образи, namespace й дані повторно використовуються; інший кластер не створюється.

Після rollout адреса — **https://localhost:8443/**. **http://localhost:8080/** перенаправляє на цей HTTPS-порт. Обидва зовнішні порти слухають лише loopback; `sudo`-порти й зміни `/etc/hosts` не потрібні. App Service і PostgreSQL доступні тільки всередині кластера.

Перед першим створенням можна вибрати вільні порти, наприклад:

```sh
COURIER_HTTP_PORT=18080 COURIER_HTTPS_PORT=18443 npm run deploy:local
```

Наявний кластер повторно використовує збережені port mappings: змінні не перебудовують їх автоматично. Зайнятий порт потребує іншого вибору до першого створення; чужі процеси не зупиняються. У наступних URL і перевірках використовуйте фактичний HTTPS-порт із виводу deploy.

Усі команди використовують власний kubeconfig `.local/deploy/kubeconfig`, context **`kind-courier-route`** та явний namespace, із перевіркою походження ресурсів. Поточний сторонній Kubernetes context не використовується. У namespace **`courier-route`** працюють **2–4 незалежні app pod**, по одному worker-слоту на процес, один Traefik і PostgreSQL. Metrics Server має окремий namespace **`courier-route-metrics`**. Це один kind node на тій самій фізичній машині; додаткові pod не створюють нові CPU або VM.

**Довіра до локальної CA.** Сертифікат сервера має SAN `localhost`/`127.0.0.1`, строк 30 днів; проєктна CA — 365 днів. Спочатку перевірте HTTPS зі звичайною перевіркою CA та імені:

```sh
curl --cacert .local/deploy/tls/ca.crt https://localhost:8443/api/health
curl -I http://localhost:8080/
```

Для звичайного браузерного профілю користувач самостійно імпортує **лише** `.local/deploy/tls/ca.crt` у власне сховище довіри/Keychain і дозволяє довіру до цієї проєктної CA після перевірки її походження. Скрипти не змінюють Keychain автоматично. До цього браузер може показувати попередження про невідому CA; передавати йому private key не потрібно.

Автоматизований Chrome використовує свіжий тимчасовий профіль. Driver спочатку перевіряє CA, hostname і строк звичайним TLS-клієнтом, а потім дозволяє в цьому профілі виняток тільки для SPKI фактичного leaf-сертифіката. Це обмеження browser driver: його успіх не доводить, що звичайний профіль уже довіряє CA. Загальне вимкнення перевірки сертифікатів не використовується.

**Конфігурація й дані.** Безпечні параметри містяться у [deploy/k8s/config.json](deploy/k8s/config.json); зміна ConfigMap через наступний deploy викликає rollout app pod. У контейнері `HOST=0.0.0.0`, точний `APP_ORIGINS=https://localhost:8443` узгоджується з обраним портом, `COOKIE_SECURE=true`. Cookie має `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` і не має `Domain`. TLS завершує Traefik; від Traefik до Express і від Express до PostgreSQL використовується внутрішнє з'єднання без TLS. Налаштування `trust proxy` не вмикається.

Випадкові паролі та згенеровані ключі зберігаються тільки в ігнорованій `.local` з обмеженими правами. Застосунок отримує URL ролі без superuser-прав через Secret; адміністративний пароль отримує лише PostgreSQL. CA private key до Kubernetes не завантажується. Секрети не входять до Docker build context, runtime-образу чи Git/ZIP.

Повторний deploy зберігає паролі, придатну CA, користувачів, сесії, задачі та PVC; завершений migration Job того самого образу використовується повторно. Для нового образу створюється окремий Job, а runner застосовує лише нові версії SQL. HTTP replicas не запускають міграції. Збережіть `.local/deploy/courier-route/credentials.json` разом із чинним PVC: за втрати локальних credentials автоматичне перепризначення паролів поверх наявних даних заборонене.

PostgreSQL 18 монтує PVC **2 GiB** у `/var/lib/postgresql`, `PGDATA=/var/lib/postgresql/18/docker`. Це інша БД, ніж локальний Postgres.app на `55432`. Перезапуск app/PG pod зберігає дані; видалення kind-кластера з його локальним сховищем не є резервним копіюванням.

Runtime app працює як UID/GID **1000**, з read-only root filesystem і обмеженим `/tmp`, без вихідних `.ts` застосунку та dev-залежностей. На app pod задано requests **250m CPU / 128 MiB**, limits **1 CPU / 384 MiB**; PostgreSQL — requests **100m / 128 MiB**, limits **1 CPU / 512 MiB**. Metrics Server запитує **100m / 200 MiB**, має limits **500m / 300 MiB**. Requests використовуються scheduler і HPA, а limits обмежують контейнер. Busy worker не робить readiness помилковим; readiness перевіряє БД/схему, health — живість HTTP.

**Перевірки після розгортання** запускайте послідовно:

```sh
COURIER_IMAGE="$(node --input-type=module -e "import { imageName } from './scripts/deploy-local.mjs'; console.log(await imageName())")"
npm run test:container -- "$COURIER_IMAGE"
npm run test:deployment
npm run test:admin:deployment
npm run test:autoscale
```

Container driver приймає тег **позиційним аргументом після `--`**, використовує `DOCKER_HOST` цього Colima-профілю й окремі тимчасові Docker-ресурси. У блоці 7 пройшли **8 груп**, включно з production UI/assets, CLI без source/dev tools, справжнім worker та SIGTERM під час пошуку. Наведена команда обчислює тег поточних файлів; спочатку зберіть цей образ через `image:build`.

`test:deployment` створює власний випадковий тестовий namespace із окремими PostgreSQL/PVC у **явно статичному режимі без HPA**, перевіряє HTTPS через Traefik, рівно дві replicas, спільні сесії/задачі, відмови й справжній Chrome. Його **10 deployment/fault + 9 HTTPS Chrome груп** залишаються окремою регресією. Наприкінці видаляються лише його тестові ресурси, профіль і credentials; демонстраційний namespace/PVC та спільний Metrics Server зберігаються. Це окрема перевірка від `test:autoscale` і локальних `npm test`/`test:browser`; актуальні результати — у [звіті 10](docs/block-10-report.md), історичні — у звітах 7–9.

## Адміністрування та походження даних

Зареєструйте свій логін звичайною формою. Нова реєстрація завжди має роль `user`; автоматичного адміністратора немає. Оператор явно надає роль **наявному** обліковому запису, після чого користувач входить знову й відкриває «Адміністрування». `YOUR_LOGIN` замініть власним логіном, пароль у CLI не передається:

```sh
# Host dev, застосункова роль PostgreSQL із локального .env
npm run db:migrate
npm run admin:role -- --username YOUR_LOGIN --role admin
npm run admin:role:built -- --username YOUR_LOGIN --role user
# Demo: власний .local/deploy/kubeconfig, kind-courier-route, namespace courier-route
npm run deploy:local
npm run admin:role:deployment -- --username YOUR_LOGIN --role admin
# Зняти роль тим самим перевіреним операторським helper-ом
npm run admin:role:deployment -- --username YOUR_LOGIN --role user
```

Helper перевіряє власний cluster/namespace/Deployment/Ready pod/image та ланцюжок ReplicaSet→Deployment UID перед запуском зібраного CLI. SQL параметризований; роль БД має бути без superuser/createdb/createrole. Невідомий логін завершується ненульовим кодом і не створюється; повторне призначення ідемпотентне. При знятті ролі наступний запит панелі повертає 403 навіть зі старою cookie й прогрітим кешем іншого процесу. Сеанс звичайного користувача та його маршрути залишаються доступними. Logout/expiry дають 401 й очищують приватний стан; DB-відмова дає 503.

Два API лише читають: `GET /api/admin/overview` та `GET /api/admin/jobs`. Кожен `/api/admin/*` спочатку заново читає чинну сесію й поточну роль із PostgreSQL; відповіді, включно з помилками, мають `Cache-Control: no-store`. Кеш інфраструктури не містить рішення про доступ. Адмін не отримує чужі координати/результати через список моніторингу та не отримує права скасувати чужу задачу. Jobs мають whitelist полів, owner UUID/login, стан, фактичні ітерації/відсоток, час, executedBy та причину помилки. Немає claim token, хешів паролів, session token, raw env чи Kubernetes credentials.

Пагінація: `limit=20` за замовчуванням, 1–50; `offset=0`, максимум 1000000. Доступні `status=active|queued|running|completed|cancelled|failed` та `executedBy=UUID`; невідомі/повторені/масивні параметри відхиляються. Порядок `created_at DESC,id DESC`, total і сторінка — один read-only REPEATABLE READ snapshot. Зведення рахує всі п'ять станів; читання не бере admission advisory lock. SQL має обмежені statement/lock/transaction timeouts, включно з очікуванням пулу.

Панель показує поточні фізичні app pod (Pending, NotReady, Ready, terminating), process UUID та один worker-слот на процес, busy/idle за БД, усіх власників задач, Deployment і фактичні HPA min/max/current/desired/conditions. Ready, бажаний pod і вільний слот мають різний зміст. Mapping потребує namespace+name+pod UID і відповідного часу запуску контейнера/процесу. Після рестарту процес має новий UUID; старий lease не додає ще одного live сервера. Недоступні/попередні записи винесені окремо: останні 60 с, до 100 записів із явною ознакою обрізання. Metadata міграції **004** nullable: старий host-процес/heartbeat допустимий. Міграція additive, запускається явно до rollout; SQL 001–003 не змінені, readiness вимагає 004 і реальні колонки.

CPU/RAM читаються сервером безпосередньо з namespaced Metrics API для контейнера **app разом із його worker threads**, а не всього Mac чи окремого потоку. CPU — ядра за `timestamp/window`, 1000 мCPU = 1 ядро; RAM — working set, MiB = 1048576 байтів. CPU/request може перевищувати 100%. У кожного sample є первісний timestamp, window й stale; старіший за запуск поточного контейнера/процесу sample не прив'язується до нього. DB snapshot time, час джерела та cache age відображаються окремо. Суми мають покриття придатних samples; `unknown/null` не підміняється нулем. [Семантика Kubernetes resource metrics](https://v1-36.docs.kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/).

`courier-route-monitor` має лише get/list pods і pod metrics у своєму namespace та get іменованих `Deployment/app` і `HPA/app`. Немає Secrets/logs/exec/scale/delete/nodes/чужого namespace. RBAC обмежує namespace; додатковий server-owned label selector та owner validation обмежують дані застосунку (RBAC не фільтрує pod за labels). `POD_UID`, `POD_NAME`, `POD_NAMESPACE` надходять із Downward API `fieldRef`; `ADMIN_CLUSTER_OWNER_ID` — із rendered `app-config` ConfigMap через `envFrom`. Projected bound token з TTL 3600 с та cluster CA змонтовані read-only тільки app; token і CA перечитуються при refresh, API hostname фіксований `kubernetes.default.svc`, CA/hostname перевіряються. Міграційний Job має automount=false. Worker отримує порожні env/execArgv, але thread має спільну файлову систему з app — це не окрема межа файлової ізоляції. [Projected ServiceAccount token](https://v1-36.docs.kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/), [RBAC](https://v1-36.docs.kubernetes.io/docs/reference/access-authn-authz/rbac/).

У host dev `ADMIN_KUBERNETES_ENABLED=false`: DB-списки працюють, фізичні pod/CPU/RAM/HPA невідомі; локальний kubeconfig не вгадується. При source403/timeout показуються partial/unknown або останні дані як stale з їхнім первісним часом. Це не людський logout/403. Одна single-flight refresh на процес, кеш 5 с, кожне джерело ≤2 с / 2 MiB, загальний HTTP budget 8 с від початку перед auth. Abort/shutdown зупиняють активні HTTP/SQL; немає фонового refresh після close. Панель опитує раз на 5 с лише відкрита й видима; покоління сеансу/панелі/сторінки та abort відсікають запізнілі відповіді. При 503 останні дані позначаються неактуальними. «Мої маршрути» повертає особистий UI; жодних адміністративних мутацій у панелі немає.

```sh
npm run test:admin
npm run test:admin:deployment
npm run test:autoscale # той самий bounded 2→4→2, додано read-only admin observer
npm run deploy:status
npm run deploy:stop   # свої app/Traefik/PG/HPA, PVC й CA зберігаються
npm run deploy:local  # явне відновлення demo
npm run db:status    # host PostgreSQL керується окремо
npm run db:stop
```

## Метрики та автоматичне розширення 2–4

Metrics Server `0.9.0` узято з [офіційного стабільного release](https://github.com/kubernetes-sigs/metrics-server/releases/tag/v0.9.0); [матриця цієї версії](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.0/README.md#compatibility-matrix) підтримує Kubernetes `1.34+`. У [versions.json](deploy/versions.json) зафіксовано image index digest, окремий arm64 digest та SHA256 вихідного `components.yaml`; deploy застосовує tracked JSON і не завантажує `releases/latest`. Один Metrics Server достатній для single-node kind.

Власні Namespace/Deployment/Service/ServiceAccount лежать у `courier-route-metrics`. Потрібні ClusterRole/ClusterRoleBinding і `APIService v1beta1.metrics.k8s.io` мають перевірювані owner labels; окремий наш RoleBinding у `kube-system` лише надає читання стандартної `extension-apiserver-authentication` конфігурації. Скрипт не привласнює й не перезаписує сторонній add-on. У блоці 9 app pod отримує окремий namespace-scoped ServiceAccount для читання моніторингу; його права описані у розділі адміністрування вище.

Є два явні локальні TLS-винятки для метрик. У перевіреному kind kubelet на `172.18.0.2:10250` має сертифікат лише з DNS SAN `courier-route-control-plane`, виданий окремою node CA; перевірка проти cluster CA не проходить. Тому **тільки наш Metrics Server** використовує `--kubelet-insecure-tls`. Офіційний `APIService` також має **`insecureSkipTLSVerify: true`**: aggregation API→Metrics Server шифрується, але сертифікат сервера не перевіряється. Kubernetes authn/authz збережені; kubectl перевіряє TLS API-сервера. Для зовнішнього production-кластера потрібні належні CA/serving certificates та перевірка обох з'єднань. HTTPS застосунку, його проєктна CA, cookie й Origin цими винятками не послаблюються.

[HPA app](deploy/k8s/hpa.json) використовує `autoscaling/v2` і CPU `Resource` metric цього app container:

| Параметр | Значення |
| --- | --- |
| Мінімум / максимум app replicas | **2 / 4** |
| Ціль середнього CPU utilization | **70%** |
| Scale-up | window **0 с**, максимум **+2 pod за 30 с** |
| Scale-down | window **180 с**, максимум **−1 pod за 30 с** |
| Requests кожного app | **250m CPU / 128 MiB** |
| Limits кожного app | **1000m CPU / 384 MiB** |

CPU utilization обчислюється від **requests**, а не від CPU limit чи всього Mac: 70% від 250m — приблизно **175m CPU на app pod**. `1000m` означає один CPU; завантажений worker може давати понад 100% utilization. Облік включає потоки контейнера. Metrics Server читає kubelet resource metrics приблизно раз на 15 с; CPU — середня швидкість за `window`, пам'ять — поточний working set. У raw API CPU може бути в nanocores (`1000000n = 1m`), memory — у байтах/`Ki`; `kubectl top` показує `m` та `Mi`. Це періодичні знімки для HPA, не точний профайлер або історична база.

Controller враховує готовність і відсутні метрики, тому desired, Ready та кількість живих виконавців можуть тимчасово різнитися. Pending pod не є готовим worker і не додає слот до ETA. PostgreSQL-реєстр використовує власні heartbeat/TTL; stopping процес перестає приймати claim. Точні строки scale-up/down й прискорення не гарантуються: усі pod ділять CPU тієї самої VM.

Поточний desired належить HPA: `app.json` не містить `spec.replicas`. Helper передає попереднє керування полем, вилучаючи тільки `replicas` зі старої last-applied annotation; початкові **2** задаються лише для нового або явно зупиненого Deployment. Повторний незмінний deploy при 4 не має скидати його до 2/1 чи міняти pod template. Оновлення image/config усе ще викликає rollout із **maxSurge=0 / maxUnavailable=1**. Це допускає тимчасову недоступність одного pod. Terminating процеси можуть ще існувати до фізичного виходу; `maxReplicas=4` сам по собі не доводить жорстку межу всіх живих процесів під час rollout.

Перевірте APIService, метрики та HPA з явними context/namespace:

```sh
npm run deploy:status
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route-metrics get deployment,service
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route-metrics get apiservice v1beta1.metrics.k8s.io
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get --raw /apis/metrics.k8s.io/v1beta1/nodes
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get --raw /apis/metrics.k8s.io/v1beta1/namespaces/courier-route/pods
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route top pods -l app.kubernetes.io/name=courier-route-app --containers
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get hpa app -o yaml
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get pods,endpointslices
npm run test:autoscale
```

`test:autoscale` використовує власний випадковий namespace/test-БД, той самий image/Traefik/TLS/HPA та **3 звичайних користувачів**, до **9** незавершених і до **200** прийнятих задач загалом. Нові справжні route jobs подаються не довше **120 с**, загальний deadline — **720 с** із завершенням усіх прийнятих задач і реальним cooldown. Межі алгоритму **500 / 200 млн / 30 с**, active/user=3 і global outstanding=100 не збільшуються. Невизначений POST автоматично не повторюється. Лише HPA змінює кількість replicas у вимірюваній фазі; driver не виконує manual scale до 3/4 і не запускає CPU burner.

Очікуваний доказ — **2→4 Ready→2**, одночасні чотири справжні worker та completed результат від кожного додаткового процесу, доступність тієї самої сесії через усі handlers, queued ETA з 2/4 виконавцями й збережена історія після cooldown. Browser observer використовує один сеанс протягом цього самого load run; після downscale створює лише одну малу UI-задачу. Окремо перевіряються repeat deploy при 4, missing-metric condition із відновленням і stop/start зі збереженням даних. Актуальні pass/fail, точний час і фактично оглянуті PNG наведено у [звіті 10](docs/block-10-report.md); історичний прогін збережено у [звіті 8](docs/block-08-report.md); сама наявність manifests або `kubectl top` не є цим доказом. Cleanup прибирає тільки власний тестовий namespace/PVC/HPA/profile/port-forwarding, спільний add-on і demo зберігаються.

За `<unknown>` перевірте `APIService Available`, свіжі `timestamp/window` raw metrics, CPU requests app і HPA `conditions/events`; відсутні метрики не означають 0% CPU. Для `FailedScrape`/TLS/403 перевірте logs нашого Metrics Server та RBAC, не вимикаючи authn/authz. За Pending/OOMKilled перевірте allocatable, requests/limits і pod events; не переходьте до manual scale для приховування проблеми. Після завершення jobs дочекайтеся падіння CPU, 180-секундного stabilization та наступних reconciliation; scale-down не має відбутися точно на 180-й секунді.

Кожна API-відповідь містить `X-Instance-Id` фактичного HTTP-процесу. Для перевірки маршрутизації можна кілька разів прочитати відкритий health із заголовками:

```sh
curl --cacert .local/deploy/tls/ca.crt -i https://localhost:8443/api/health
```

Балансувальник не закріплює сесію за pod. UUID обробника відповіді й `executedBy` задачі можуть відрізнятися: стан та сесії читаються зі спільної PostgreSQL, а обчислення виконує процес, який отримав claim. Браузер завжди використовує відносні `/api/...` на тому самому HTTPS-походженні.

Для діагностики використовуйте status і короткі app-логи з явним context/namespace:

```sh
npm run deploy:status
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get pods,svc,ingress,pvc
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route logs deployment/app --tail=50
```

За `503 /api/ready` перевірте стан PostgreSQL і migration Job у `deploy:status`; за TLS-помилки — CA, hostname і фактичний порт. Не друкуйте Secret, середовище pod, credentials-файли чи повний kubeconfig. Відмова перевірки походження ресурсу потребує з'ясування його власника, а не примусового видалення.

Звичайна зупинка й відновлення:

```sh
npm run deploy:stop
npm run deploy:local
```

`deploy:stop` спочатку видаляє **тільки власний namespaced HPA**, щоб controller не відновив replicas, потім зупиняє app і Traefik та чекає завершення app pod, далі зупиняє PostgreSQL. Це навмисний maintenance stop, а не scale-down HPA. Спільний Metrics Server, кластер, completed Job, PVC, CA й credentials зберігаються; інші namespace/HPA не зачіпаються. Наступний `deploy:local` відновлює базові дві replicas та HPA. За потреби після stop `colima stop --profile courier-route` зупиняє тільки цей профіль VM; перед наступним deploy знову запустіть його. Видалення namespace/PVC/кластера знищує дані й не є командою звичайної зупинки.

## Оточення для npm dev

- Node.js **24.x LTS**, npm **11.x**; `.nvmrc` містить `24`. Перевірене середовище каркаса: Node.js 24.18.0, npm 11.16.0, macOS arm64.
- Справжній PostgreSQL. У цьому середовищі знайдено **PostgreSQL 18.4** з наявного Postgres.app: `/Applications/Postgres.app/Contents/Versions/18/bin`. Повторне встановлення через Homebrew не потрібне.
- Вільні локальні порти **55432** для окремого PostgreSQL проєкту, **3000** і **3001** для двох Express-процесів та **5173** для Vite.
- Доступ до npm registry для встановлення залежностей. Цей окремий локальний npm dev не потребує Docker, Kubernetes чи Traefik. Обчислювальні CLI маршруту не потребують PostgreSQL.

## Перший запуск npm dev

Із кореня проєкту:

```sh
npm ci
npm run db:setup
npm run db:migrate
npm run db:check
npm run dev
```

`db:setup` використовує наявні PostgreSQL-бінарники та готує окремий кластер проєкту в `.local/postgres`, який слухає лише `127.0.0.1:55432`. Він створює роль застосунку `courier_route` без superuser-прав, робочу БД `courier_route` і окрему тестову БД `courier_route_test`. Випадковий пароль ролі записується тільки в ігнорований `.env` з правами `0600`; його не потрібно копіювати в команди чи чат. Чужі кластери й БД не використовуються для цього налаштування.

Відкрийте **http://127.0.0.1:5173/**. Vite проксіює відносні `/api/...` на Express. На сторінці можна зареєструватися, потім увійти, оновити сторінку зі збереженням чинної сесії та вийти. Реєстрація автоматично не авторизує. Після входу видно поточного користувача й кнопку виходу.

Логін: 3–32 латинські літери, цифри, `_` та `-`; крайні пробіли прибираються, регістр не розрізняється. Пароль: 15–128 символів Unicode за кількістю кодових точок; пробіли й регістр зберігаються. JavaScript не читає сесійну cookie. Зміни клієнта підхоплює Vite, сервер перезапускається через Node watch із `tsx`. `Ctrl+C` завершує обидва dev-процеси, активний worker і пул БД; PostgreSQL керується окремо.

## Пошук маршруту в браузері

Після входу відкривається робочий простір. Спочатку він отримує фактичні межі з `/api/jobs/limits`; до успішного читання запуск вимкнений. Вкажіть X/Y складу (початково `0`, `0`) і доставки: **одна пара `x y` на рядок**, розділювач — пробіл або табуляція, дробова частина — з крапкою. Наприклад:

```text
1 0
1 1
0 1
```

Порожні рядки ігноруються; помилка вказує фізичний номер рядка. Від'ємні, дробові й однакові координати дозволені; однакові доставки залишаються окремими. Мінімум — одна доставка. Бюджет — додатне ціле число в серверних межах; початково менше з 1000000 та дозволеного максимуму. Необов'язковий seed — ціле `0–4294967295`: порожній генерує сервер, **0 є явним значенням**. Кнопка «Заповнити квадрат» заповнює тільки поля; задача створюється лише натисканням «Знайти маршрут».

Після прийняття відкриваються деталі. Стани: «У черзі», «Обчислюється», «Завершено», «Скасовано», «Помилка». Прогрес та ітерації надходять із БД приблизно раз на секунду після завершення попереднього читання. 100% показується лише для completed. «Скасувати задачу» надсилає запит; для running напис «Очікуємо зупинки» ще не означає кінцевий стан. Закриття сторінки чи вихід із сеансу не скасовують прийняту задачу.

Історія показується сторінками по 20 без вигаданого загального числа; активні задачі — окремо. Виберіть рядок, щоб прочитати збережені деталі. Після reload відновлюються сеанс і задачі з БД, новий POST не надсилається. Результат містить найкращу й початкову довжину в умовних одиницях, фактичний seed, бюджет і виконані ітерації, **час роботи алгоритму** та SVG. Склад позначений квадратом, доставки — номерами від 1; текстовий порядок починається і закінчується складом. Для понад 40 доставок схема зберігає всі маркери, а номери й координати доступні в тексті. Редагування нового вводу не змінює збережену схему. Наближений результат не гарантує глобальної оптимальності; тривіальний вхід може завершитися з 0 ітерацій.

При 400/413/429/503 введення зберігається. Особистий active-ліміт, повна спільна черга й недоступність БД мають різні повідомлення. Після помилки читання останні дані залишаються з повідомленням і кнопкою оновлення. Якщо після POST відповідь втрачена, **«Запит міг бути прийнятий. Оновіть історію перед повторним запуском»**: спочатку перевірте історію, автоматичного повтору немає. За 401 приватні списки, чернетка, деталі та схема очищуються, потрібно увійти знову. У деталях queued відображається орієнтовний час **до початку**, отриманий з API; він може змінюватися. Після POST спочатку показано «Оцінюємо час очікування…», за відсутності придатних виконавців — невідома оцінка. Немає незалежного countdown у браузері. Після 503 попередня ETA явно позначена неоновленою; за running/terminal вона прибирається.

## Спільна черга та оцінка очікування

На кожен HTTP-процес припадає один фактичний важкий worker-слот. Процес реєструє свій реальний `instanceId` з health у PostgreSQL; heartbeat поновлює DB-дати. У прогнозі враховуються тільки свіжі процеси, які приймають claim. Busy-процес залишається майбутнім слотом, paused/stopping/прострочений — виключений. Реєстр зіставляється з running у jobs, тому попередній idle heartbeat не робить щойно committed claim вільним. Claim і finalization також займають слот. Якщо відомостей про busy-слот недостатньо, прогноз невідомий.

Новий claim потребує підтвердженої власної реєстрації. Heartbeat має максимум один SQL у польоті; після відмови виконується обмежене повторне читання/реєстрація, власний job-worker реально зупиняється. Shutdown припиняє нові claim/heartbeat, позначає процес недоступним за доступної БД, чекає виданих операцій і зупиняє worker до Pool.end. Busy не робить HTTP-ready помилковим. CLI не потребує БД/реєстрації.

Lease TTL і `jobs.lost_after` мають різне призначення. TTL прибирає з прогнозу зниклий процес; він **не перепризначає running**. Лише збережений `lost_after` завершує втрату як failed/worker_lost, без повторного обчислення. Grace з попереднього блоку незмінний: `max(configuredGrace, 2 × dispatcherPoll + 21000)` мс, default 21500. Реєстрація використовує інтервал 1000 мс, TTL 15000 мс; TTL ≥ 3 × interval + 6000 покриває кілька heartbeat та bounded DB-операцію (acquire 2 с, SQL до 3 с із резервом). Конфігурація всіх серверів повинна збігатися.

`GET /api/jobs/:id` тільки за queued додає:

```ts
queue: {
  estimatedWaitMs: number | null; // ціле, час ДО ПОЧАТКУ
  calculatedAt: string;          // один DB timestamp snapshot
  queuedAhead: number;           // queued-попередники всіх власників
  executorCount: number;         // свіжі придатні процеси, включно з busy
  basis: 'measured' | 'mixed' | 'timeout' | 'unavailable';
}
```

Початковий POST може бути без queue — ETA читається наступним звичайним GET, без затримки 202. За running/terminal поле відсутнє. Власна detail й metadata належать одній короткій read-only REPEATABLE READ транзакції на одному client; snapshot не бере admission lock. Назовні немає чужих id/входів/результатів чи реєстру, тільки агрегати. Крім власної detail виконуються чотири обмежені scalar SELECT: свіжі виконавці, running, усі queued-попередники (до 10000) й останні 200 completed/budget_exhausted кандидатів із додатними ітераціями; модель додатково відкидає непридатні. Чужі координати не копіюються до Node; кількість точок визначає SQL. SQL-відмова дає 503, а не вигадану успішну unknown-відповідь.

Модель визначає час звільнення кожного слота й розкладає queued-попередників за created_at/id на найраніше доступний слот через min-heap. Найменше наступне звільнення — ETA цільової; **власна тривалість цільової не додається**. Орієнтир SKIP LOCKED не гарантує точний порядок стартів при гонках.

- Idle-слот: 250 мс передачі. Busy searching з додатним прогресом: `min(залишок timeout, elapsed × (total−completed)/completed) + 500 мс`. Elapsed береться від DB started_at. Preparation/нуль прогресу використовує залишок фактичного timeout + 500 мс; finishing залишає 500 мс. Прийнятий cancel ще не звільняє слот.
- Історичний час — **finished_at − started_at**, включно зі startup/збереженням; це не result.elapsedMs алгоритму. Для завершеного budget_exhausted з додатною реально виконаною кількістю ітерацій обчислюється час на умовну роботу `C = iterations + pointCount²`; у групі `floor(log2(pointCount))` використовується медіана `duration/C` з останніх 200 SQL-кандидатів після перевірки скінченної додатної тривалості до 180 с, повних лічильників і понад двох доставок. Оцінена тривалість попередника — `clamp(median × C, 1, timeout) + 250 + 500` мс.
- Якщо відповідної статистики немає, тривалість попередника — фактичний configured timeout + 750 мс. Одна/дві доставки також використовують консервативний timeout-fallback; failed/cancelled/trivial/zero/непридатні samples не навчають звичайний пошук як миттєвий. Запаси 250/500 мс — налаштування моделі, не виміряні константи швидкості.
- `measured` означає, що використано прогрес/придатні samples або спостережену доступність без timeout-fallback; `mixed` — виміри разом із fallback, `timeout` — лише fallback, `unavailable` — null через відсутність придатних слотів чи суперечливий snapshot. За unknown UI не показує 0 секунд. Оцінка скінченна й обмежена 1400140000 мс для максимального snapshot; це технічна стеля, не обіцянка верхнього часу очікування.

Результат може змінюватися після нових вимірів, cancel/timeout, появи чи зникнення процесу. Cold fallback консервативний; переносити швидкість з іншої машини чи вимагати фіксованої похибки немає підстав. Прогноз не записується на кожен polling, не запускає обчислення й не впливає на admission/claim. У UI він оновлюється тільки наявним detail polling, без окремих таймерів/запитів кожній картці.

Для відтворення використайте описаний нижче запуск двох процесів з однаковими лімітами й спільною БД; створіть дві допустимі важкі задачі з реальним бюджетом пошуку та третю у межах active-квоти. Поки обидва worker працюють, третя приймається й очікує з ETA. Після фізичної зупинки/завершення одного worker вона виконується один раз. Автоматизований `test:queue` відтворює це на двох production-процесах із виділеною тестовою БД. Балансування через Traefik окремо перевіряє `test:deployment`; автоматичне масштабування 2–4 з панеллю адміністратора — `test:autoscale`.

## Конфігурація

Безпечний перелік змінних є в [.env.example](.env.example). `db:setup` готує робочий локальний `.env`; реальні адреси з паролями не слід комітити чи показувати в логах. Для вже налаштованого зовнішнього PostgreSQL заповніть `.env` самостійно за прикладом та забезпечте окрему тестову БД й роль без superuser-прав.

| Змінна | Значення / правила |
| --- | --- |
| `HOST` | За замовчуванням `127.0.0.1`; єдине інше дозволене значення — `0.0.0.0` для контейнера |
| `PORT` | Порт Express, за замовчуванням `3000`; ціле `1–65535`. Vite читає його для проксі |
| `DATABASE_URL` | Обов'язковий PostgreSQL URL робочої БД; лише для сервера |
| `TEST_DATABASE_URL` | PostgreSQL URL окремої БД з компонентом `test` в імені; обов'язковий для інтеграційних тестів |
| `APP_ORIGINS` | Обов'язковий явний список походжень через кому; локально `http://127.0.0.1:5173,http://127.0.0.1:3000` |
| `SESSION_TTL_SECONDS` | Строк сесії; за замовчуванням `28800` секунд (8 годин), допустимо `1–604800` |
| `COOKIE_SECURE` | `false` для окремого локального HTTP; `true` у HTTPS-розгортанні |
| `ROUTE_MAX_POINTS` | Максимум доставок: за замовчуванням `500`, конфігураційна межа `1–2000` |
| `ROUTE_MAX_ITERATIONS` | Максимум реальних спроб 2-opt: за замовчуванням `50000000`, конфігураційна межа `1–200000000` |
| `ROUTE_TIMEOUT_MS` | Повний бюджет часу worker: за замовчуванням `30000` мс, конфігураційна межа `1–120000` мс |
| `JOBS_MAX_ACTIVE_PER_USER` | Максимум `queued + running` одного власника: за замовчуванням `3`, межа `1–100` |
| `JOBS_MAX_OUTSTANDING` | Максимум `queued + running` усієї системи: за замовчуванням `100`, межа `1–10000` |
| `JOBS_POLL_INTERVAL_MS` | Період dispatcher: за замовчуванням `250` мс, межа `25–5000` мс |
| `EXECUTOR_HEARTBEAT_INTERVAL_MS` | Heartbeat реального процесу: default `1000` мс, ціле `100–5000` |
| `EXECUTOR_LEASE_TTL_MS` | Строк свіжості: default `15000` мс, ціле до `60000`, не менше `3 × heartbeat + 6000` мс |
| `JOBS_WORKER_LOST_GRACE_MS` | Мінімальний запас після збереженого timeout: за замовчуванням `5000` мс, межа `100–30000` мс; фактичний grace враховує також polling і DB-бюджети нижче |

Обов'язкова некоректна конфігурація зупиняє запуск зі зрозумілим повідомленням без рядка підключення. Змінні процесу мають пріоритет над `.env`; серверні npm-команди читають його через `--env-file-if-exists=.env`. `DATABASE_URL` не передається через `VITE_*` у клієнтський bundle. Після зміни портів або походжень оновіть відповідні значення `APP_ORIGINS` та перезапустіть dev. `localhost` і `127.0.0.1` — різні походження; приклади використовують `127.0.0.1` послідовно.

Route/jobs-параметри приймають лише додатні цілі десяткові значення в зазначених межах; нуль, дроби, нескінченність і перевищення конфігураційних меж зупиняють запуск. Модуль кожної координати обмежений константою **1000000**. Ці числа — проєктні налаштування, а не числа з вимог викладача. Усі процеси однієї системи повинні мати однакові route/jobs-ліміти. Читання route-конфігурації відокремлене від обов'язкових DB-налаштувань HTTP-сервера.

## PostgreSQL та міграції

```sh
npm run db:status
npm run db:stop
npm run db:start
npm run db:check
```

Команди керують лише окремим локальним кластером проєкту. Зупинка не видаляє `.local/postgres` і дані; наступний `db:start` використовує той самий кластер. Файли даних і логи `.local` виключені з Git. Не видаляйте каталог для звичайного перезапуску.

Міграції запускаються явно, окремо від HTTP-процесів:

```sh
npm run db:migrate
```

SQL зберігається у `migrations/`. Runner обліковує версії та контрольні суми в `schema_migrations`, застосовує кожну нову міграцію в транзакції через один client і тримає PostgreSQL advisory lock на цьому client протягом усього запуску. Повторний запуск пропускає вже застосовані версії; конкурентні запуски серіалізуються. Застосовані SQL-файли не редагуються: зміни схеми додаються новими версіями. Робочі таблиці не очищуються міграціями чи налаштуванням.

Міграція `001_auth` створює `users` і `sessions`: UUID користувача, унікальний нормалізований логін, хеш пароля, роль `user/admin`, часові поля `timestamptz`; хеш токена сесії, зовнішній ключ користувача, строки створення/завершення та індекси користувача й завершення сесії. Публічна реєстрація створює лише роль `user`.

Нова `002_jobs` додає одну таблицю `jobs`: власник, нормалізований вхід із фактичним seed, стан, лічильники прогресу, час, запит скасування, фактичний `instanceId`, приватний claim token, timeout/deadline, результат або безпечна причина відмови. Constraints пов'язують стан із результатом, `finished_at` і прогресом; індекси підтримують чергу, історію власника та прострочені running. Застосована `001_auth.sql` не змінена, існуючі користувачі й сесії зберігаються.

Нова `003_executor_registry` додає тільки реєстр реальних instanceId зі станом приймання claim, зайнятістю одного слота, current job та DB-датами started/last-seen/expiry. Constraints перевіряють дати й узгодженість busy/current job; індекси підтримують свіжі записи, running за instanceId та останні completed виміри. Users/sessions/jobs/results зберігаються. Застосовані `001_auth` і `002_jobs` не змінені; після застосування `003` також не редагується.

Міграція `004_executor_metadata` додає nullable pod UID/name/namespace до реєстру. Існуючі дані та старий heartbeat без metadata зберігаються; readiness перевіряє також нові колонки. `ADMIN_CLUSTER_OWNER_ID` є конфігурацією розгортання, не колонкою Downward API.

Для вже налаштованої БД достатньо `npm run db:start`, `npm run db:migrate` та `npm run db:check`. Повторний `db:setup` для оновлення схеми не потрібний. HTTP не запускає міграції автоматично; `/api/ready` повертає `503`, доки немає всіх чотирьох версій 001–004 і потрібної форми таблиць. `/api/health` залишається liveness навіть без БД.

## Збирання й запуск

```sh
npm run typecheck
npm run build
npm run db:migrate:built
npm start
```

Відкрийте **http://127.0.0.1:3000/**. Зібрані HTML, CSS/JS та API віддає один Express-процес з одного походження. `build` очищує лише `dist`, компілює backend, shared і worker, збирає frontend та копіює SQL до `dist/migrations` і JSON-приклади до `dist/examples`. `db:migrate:built` запускає зібраний JavaScript runner з цими SQL-файлами; після попередніх міграцій це безпечний повторний запуск. `start` потребує виконаного `build` та підготовленої БД. Цей окремий запуск використовує HTTP; HTTPS доступний через описане вище розгортання Traefik.

`typecheck` перевіряє strict TypeScript сервера, клієнта, shared, тестів та конфігурації Vite. HTTP-процес має окремий `pg.Pool` максимум на 5 з'єднань, кінцеві таймаути підключення/запитів і обробку помилок вільних з'єднань. SIGINT/SIGTERM закривають прийом HTTP й нові claim, зупиняють dispatcher та активний worker, записують доступний кінцевий стан до закриття пулу. Для зупинки через shutdown це `failed/server_shutdown`; раніше прийнятий користувацький cancel має пріоритет. Граничний час завершення процесу — 5 секунд; PostgreSQL керується окремо.

Для двох локальних процесів спочатку зберіть застосунок і явно застосуйте міграції. Потім відкрийте два термінали в корені одного проєкту:

```sh
# Термінал A
PORT=3000 APP_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:5173 npm start
```

```sh
# Термінал B
PORT=3001 APP_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:5173 npm start
```

Обидва процеси читають ту саму робочу `DATABASE_URL` з ігнорованого `.env`, однакові route/jobs-налаштування та мають різні `instanceId` у `/api/health`. Сесія, стан і скасування доступні через кожен порт; два вільні процеси можуть виконувати різні задачі одночасно. У цьому окремому сценарії два прикладні сервери доступні напряму; варіант із Traefik і HTTPS описано на початку README.

## Розрахунок маршруту через CLI

Після встановлення залежностей TS-demo працює без запуску HTTP або PostgreSQL:

```sh
npm run route:demo
npm run route:demo -- examples/route-medium.json
npm run build
npm run route:demo:built
npm run route:demo:built -- examples/route-small.json
npm run route:bench
ROUTE_MAX_ITERATIONS=200000000 npm run route:bench
```

Однаковий CLI використовує той самий executor у TS та зібраному JS. Без аргументу обирається `route-small.json` відносно модуля; build копіює приклади у `dist/examples`, тому зібраний CLI не потребує вихідних `.ts` чи каталогу `examples` у корені. Явно переданий шлях JSON рахується від поточної робочої папки. CLI повертає JSON кінцевого стану у stdout, фактичний прогрес — у stderr; exit code `0` для успіху, `1` для помилки та `2` для скасування. `Ctrl+C` або SIGTERM реально зупиняють worker.

Малий приклад [examples/route-small.json](examples/route-small.json) утворює квадрат із відомою довжиною `4`:

```json
{
  "warehouse": { "x": 0, "y": 0 },
  "points": [{ "x": 1, "y": 0 }, { "x": 1, "y": 1 }, { "x": 0, "y": 1 }],
  "iterations": 10000,
  "seed": 0
}
```

`warehouse` — склад з індексом `0`; `points` містить тільки доставки з індексами `1..N` у порядку масиву. Однакові координати дозволені та залишаються різними доставками. `iterations` — додатний цілий бюджет реальних 2-opt спроб. `seed` — необов'язкове ціле `0..4294967295`, зокрема `0`; за відсутності сервер генерує та повертає фактично використане зерно. Обчислення не змінює вхідні об'єкти.

Вхід перевіряється у runtime до створення worker. Мінімум — одна доставка; розмір і бюджет не можуть перевищувати серверні ліміти. Координати мають бути скінченними числами в дозволеній межі. Пропущені/зайві поля, рядки з цифрами, дробові лічильники, `NaN`, `Infinity` та поля підвищення timeout/максимумів відхиляються з українською помилкою `invalid_input`. Завеликий масив відхиляється до огляду його елементів, копіювання та побудови матриці.

Успішний результат містить `order: [0, ..., 0]` з кожною доставкою рівно раз, фактичну `length`, початкову `initialLength`, `seed`, `iterationsRequested`, `iterationsCompleted`, виміряний у worker `elapsedMs`, `approximate: true` та `terminationReason`. Довжина включає повернення на склад. Для 1–2 доставок (`trivial_input`) і нульової довжини (`zero_length`) можливе швидке завершення з чесними `iterationsCompleted: 0`; звичайний пошук виконує весь бюджет (`budget_exhausted`). Результат називається **найкращим знайденим маршрутом**.

Початкова побудова — найближчий сусід зі стабільним вибором при рівних відстанях. Потім simulated annealing розглядає справжні розвороти 2-opt: покращення приймаються, погіршення — з імовірністю `exp(-delta/T)`. Детермінований Mulberry32 використовує тільки заданий seed. Початкова температура `T0 = initialLength / (N+1) × 0.25`, кінцева `Tend = T0 × 0.0001`; охолодження геометричне протягом бюджету, із захистом найменших додатних чисел. Початковий і найкращий маршрути зберігаються окремо. Перед новим best та періодично довжина перераховується компенсованою сумою; фінальна `length` обчислюється за фактичним `order`. Однаковий нормалізований вхід, seed і завершений бюджет дають однакові порядок і довжину.

Матриця Float64 та найближчий сусід потребують `O(N²)` підготовки; матриця містить `8 × (N+1)²` байтів: **2008008** при 500 доставках або **32032008** при конфігураційній стелі 2000. Це пам'ять лише матриці. Дельта 2-opt рахується за `O(1)`, прийнятий розворот — за `O(k)` довжини сегмента, точні перевірки довжини й копії — за `O(N)`. Додаткова пам'ять маршрутів — `O(N)`.

В одному HTTP-процесі створюється один спільний executor із одним слотом. Зайнятість установлюється синхронно; другий start отримує `executor_busy`. Прихованої локальної черги немає. Побудова матриці, початкового маршруту й пошук відбуваються у worker. У dev невеликий `dev-worker.mjs` явно реєструє наявний `tsx` loader; зібраний `worker.js` працює без `tsx`, Vite або вихідних `.ts`. Worker отримує лише вхід/runId, порожній `env` та порожній `execArgv`; DB URL, паролі, cookie й успадковані preload йому не передаються.

Прогрес має етапи `preparing`, `searching`, `finishing`, реальні `completedIterations`/`totalIterations` та монотонний відсоток. Пошук надсилає події зі свого циклу приблизно кожні 150 мс; до перевіреного успіху відсоток `<100`, після готового результату й завершення потоку — `100`. Кінцевий стан executor: `completed` з результатом, `cancelled` або `failed` з причиною `timeout`/`worker_error`. Батьківський монотонний timeout охоплює запуск, підготовку, пошук і завершення; timeout та cancel викликають реальне припинення worker й чекають його зупинки перед звільненням слота. Частковий маршрут за timeout не видається за completed. Помилка callback прогресу ізольована від HTTP і життєвого циклу worker.

Benchmark використовує детермінований генератор у [src/server/route/examples.ts](src/server/route/examples.ts): 4 доставки / 10000 спроб / seed 0; 100 / 1000000 / seed 42; 500 / поточний серверний `ROUTE_MAX_ITERATIONS` / seed 42. Стандартний важкий бюджет — 50000000. Для всіх трьох сценаріїв потрібні `ROUTE_MAX_POINTS` не менше 500 і `ROUTE_MAX_ITERATIONS` не менше 1000000. Остання команда вище тимчасово задає серверний ліміт 200000000 лише процесу benchmark у межах конфігураційної стелі; вона не змінює `.env` чи стандартну межу 50000000. Це дозволяє виміряти кілька секунд реального пошуку на швидкій машині без затримок чи фіктивної роботи. Вхідний JSON не може підвищувати ліміти.

У JSON-виводі benchmark є фактичні ітерації, worker elapsed, повний wall time, CPU всіх потоків процесу, initial/best length, кількість прогрес-подій та RSS усього процесу з вибіркою кожні 50 мс. RSS не є точною пам'яттю одного worker. Виміри та обґрунтування лімітів на цій машині наведено у звіті блоку 3; тривалість залежить від обладнання.

## Збережені задачі й базова спільна черга

HTTP лише перевіряє вхід і власника та фіксує `queued`; відповідь `202` надсилається після commit без очікування обчислення. Користувача беруть зі спільної сесії. Якщо seed не надісланий, він генерується один раз до INSERT та зберігається разом із входом. Від'єднання клієнта не скасовує прийняту задачу.

Під час admission одна коротка PostgreSQL-транзакція `READ COMMITTED` бере спільний advisory transaction lock, рахує `queued + running` та робить INSERT. Локальні лічильники не визначають глобальні квоти. До активного ліміту входить running із запитом скасування, поки потік реально не зупинено й кінцевий стан не записано. Завершена історія не витрачає цей ліміт. Пагінація обмежує одну відповідь історії; автоматичного видалення старих записів немає.

Кожен HTTP-процес має один dispatcher і один executor. Dispatcher без накладання poll-циклів атомарно вибирає найстарішу queued за `created_at, id` через `FOR UPDATE SKIP LOCKED`, фіксує claim і тільки після commit запускає worker. Приватний claim token захищає всі progress/terminal UPDATE разом з `id` і `status=running`. Старий callback не змінює кінцевий стан. Локально зберігається лише поточний claim/worker і ще не записаний прогрес; прихованої черги чи автоматичного повторного обчислення немає.

Прогрес береться з реальних повідомлень executor. Одночасно можливі один UPDATE та один останній очікуваний snapshot. У running відсоток завжди `<100`; перевірений результат, `completed`, `100` і `finished_at` записуються одним кінцевим UPDATE після завершення worker. Користувацькі читання через будь-який сервер повертають збережений стан із PostgreSQL.

Queued cancel атомарно створює кінцевий `cancelled` без worker. Running cancel лише фіксує прапорець; dispatcher власника регулярно читає його незалежно від прогресу, реально припиняє потік і потім записує `cancelled`. Якщо прапорець уже прийнято до фіналізації, він має пріоритет над `completed` та `failed/timeout`; якщо кінцевий стан зафіксовано раніше, повторний cancel його не змінює.

При claim у БД зберігаються фактичний timeout і `lost_after = started_at + timeout + effectiveGrace`. `effectiveGrace = max(JOBS_WORKER_LOST_GRACE_MS, 2 × JOBS_POLL_INTERVAL_MS + 21000)` мс: 21 секунда покриває отримання відповіді UPDATE claim і commit (до 6 с), поточний і останній progress та terminal (кожен до 2 с отримання client + 3 с запиту). За стандартних налаштувань фактичний grace — **21500 мс**; максимальне значення за дозволених налаштувань — **31000 мс**. Це запас для recovery, а не додатковий час пошуку: worker усе одно обмежений своїм timeout. Готовий власний outcome записується відразу, серіалізовано з поточним poll, перед глобальним recovery. При зміні DB-таймаутів потрібно узгодити цей резерв.

Після записаного deadline будь-який живий dispatcher може атомарно перевести досі running у `failed/worker_lost`, без повторного запуску тієї самої задачі. До deadline новий сервер не оголошує чужі активні задачі втраченими. За недоступної БД нові claim припиняються, свій worker зупиняється з причиною `database_unavailable`, а невдалий кінцевий запис повторюється в наступних обмежених poll-циклах; до узгодження не береться інша локальна робота. Якщо процес не зберіг стан, залишається deadline-відновлення. Звичайний shutdown записує `failed/server_shutdown`, якщо раніший користувацький cancel не отримав пріоритет.

Базову спільну PostgreSQL-чергу створено у блоці 4, UI задач — у 5, реєстр потужності й ETA — у 6, балансувальник та HTTPS — у 7, Metrics Server і HPA — у 8. Історичні перевірки збережені у відповідних звітах; докази queued при зайнятих слотах і прогноз/факт — у звітах 6 та 8. Панель моніторингу реалізовано в блоці 9; фактичні перевірки — у [звіті 9](docs/block-09-report.md).

## Перевірки

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:route
npm run test:integration
npm run test:jobs
npm run test:client
npm run test:queue
npm run test:admin
npm run test:browser
```

`npm test` послідовно запускає unit, route/HTTP, PostgreSQL auth/jobs, client, queue та admin набори; перед ним також виконайте `npm run build`. Не запускайте інтеграційні набори одночасно: кожен керує своїми HTTP-процесами й cleanup. `npm run auth:check` — назва для того самого інтеграційного набору авторизації. Інструментарій — `node:test` і TypeScript; інтеграційним тестам потрібен справжній запущений PostgreSQL та явний `TEST_DATABASE_URL`. `test:route` не потребує БД та перевіряє алгоритм, executor, TS/built worker, реальні cancel/timeout, збої й відновлення слота, сигнали завершення та справжні HTTP health-відповіді під час pending пошуку у worker того самого процесу. Зібраний артефакт перевіряється також без вихідних `.ts` і `tsx`.

`test:client` не потребує БД чи браузера: перевіряє parser, runtime-відповіді, геометрію, невизначений POST, polling, пагінацію, cancel і гонки сеансів із контрольованим API/часом. Це не end-to-end. Окрема `test:browser` запускає справжній локальний Chrome через CDP без додаткових npm-залежностей, свіжий тимчасовий профіль, production-застосунок і Vite/proxy у випадковій схемі захищеної тестової БД. Потрібні попереднє збирання, TEST_DATABASE_URL і доступний Chrome; подробиці можливостей і фактичний результат — у звіті 6. Знімки для внутрішнього огляду залишаються в ігнорованій `.local`, профіль із cookie та тестова схема прибираються. Браузерний набір запускайте окремо від `npm test`.

За замовчуванням browser driver використовує встановлений Google Chrome у `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; інший наявний виконуваний файл можна задати через `COURIER_TEST_CHROME`. Відсутність браузера або правильної тестової БД завершує перевірку помилкою, без прихованого skip. Перевірені viewport — 1280×900 і 360×900; інші браузери й ручне випробування зі screen reader окремо не перевірялися.

Тести можуть змінювати схему й дані **тільки виділеної тестової БД**. Guard вимагає явно тестове ім'я, порівнює фактичні host/port/database із робочою БД, ураховує loopback/DNS-аліаси й відхиляє URL з перевизначенням адреси через query parameters. Порожня, неперевірена або робоча адреса не дозволяє очищення; відсутня БД не видається за успішний тест. Дані робочої БД тести не очищують.

Попередні 11 unit, 36 route/HTTP і 13 справжніх auth integration-сценаріїв залишаються регресією. `test:jobs` додає перевірки конфігурації, міграцій і справжньої PostgreSQL у випадковій ізольованій схемі: два незалежні production-процеси зі справжніми worker, атомарні квоти й claim, ownership, збережений прогрес, скасування через інший сервер, гонки, timeout, збої, перезапуск, втрата виконавця та shutdown. Cleanup видаляє лише створену тестову схему й зупиняє свої HTTP-процеси. Кількість і фактичні результати — у звіті відповідного блоку, а не в самому переліку сценаріїв. HTTP-перевірка не підтверджує відображення чи виконання JavaScript у браузері.

## HTTP API

```sh
curl --silent --show-error http://127.0.0.1:3000/api/health
curl --silent --show-error http://127.0.0.1:3000/api/ready
curl --silent --show-error http://127.0.0.1:3000/api/not-found
```

Health — liveness процесу: `200` з `status: "ok"` і стабільним протягом запуску `instanceId`; йому не потрібні БД або сесія. Ready дає `200` лише за доступного PostgreSQL і потрібної схеми; інакше `503`. Невідомий API дає JSON `404`. За недоступної БД liveness зберігається, а готовність і залежні від БД auth-запити дають `503`, без внутрішніх деталей.

| Маршрут | Успіх | Очікувані відмови |
| --- | --- | --- |
| `POST /api/auth/register` | `201 { user }`, без автоматичного входу | `409` — зайнятий нормалізований логін |
| `POST /api/auth/login` | `200 { user }` та сесійна cookie | `401` — однакове повідомлення для неправильного пароля й невідомого користувача |
| `GET /api/auth/me` | `200 { user }`, `Cache-Control: no-store` | `401` — немає чинної сесії |
| `POST /api/auth/logout` | `204`, відкликання сесії та очищення cookie | Повторний вихід також безпечний |

Усі auth-POST потребують `Content-Type: application/json` та дозволеного точного `Origin`. Відсутній, `null` чи чужий Origin дає `403`; неправильний Content-Type — `415`; невалідні поля/JSON — `400`; тіло понад 16 KiB — `413`. Відповідь помилки містить стабільний `code` та українське `message`. Зайві поля, зокрема `role`, відхиляються. Паролі, їхні хеші й токени не повертаються у JSON.

Усі `/api/jobs` потребують чинної спільної сесії та повертають `Cache-Control: no-store`. Job-POST використовує той самий точний Origin і JSON, але має окрему межу тіла **256 KiB**. Поганий JSON дає `400`, завелике тіло — `413`, Content-Type — `415`, Origin — `403`. За недоступної БД залежний API повертає `503/DATABASE_UNAVAILABLE`.

| Маршрут | Успішна відповідь і правила |
| --- | --- |
| `POST /api/jobs` | `202 JobDetails` і `Location: /api/jobs/:id` після commit queued. Тіло — тільки RouteInput; userId, status, claim, timeout і result відхиляються |
| `GET /api/jobs` | `{ jobs, limit, offset }`, лише власні компактні summary без повних input/result; порядок `createdAt DESC, id DESC` |
| `GET /api/jobs?status=active&limit=20&offset=0` | Лише queued/running; limit за замовчуванням 20, максимум 50; offset `0–1000000`. Дозволено також один конкретний status. Зайві, повторні чи невалідні query-параметри — `400/INVALID_QUERY` |
| `GET /api/jobs/limits` | `{ route: { maxPoints, maxIterations, timeoutMs, maxCoordinate }, maxActivePerUser }`; без env або секретів |
| `GET /api/jobs/:id` | Власні `JobDetails`; тільки queued містить актуальне поле `queue`. Input, status, progress, cancelRequested, часові поля, executedBy; result тільки completed, error тільки failed |
| `POST /api/jobs/:id/cancel` | Тіло `{}`. Queued → cancelled і `200`; running із прапорцем скасування → `202`; кінцевий стан → незмінний `200`. Повторний cancel безпечний |

Невалідний UUID дає `400/INVALID_JOB_ID`; чужа й відсутня задача однаково дають `404/JOB_NOT_FOUND`. Невалідний вхід — `400/INVALID_ROUTE_INPUT`, ліміт користувача — `429/USER_ACTIVE_LIMIT`, загальна місткість — `503/SYSTEM_OUTSTANDING_LIMIT`, без зайвого INSERT. Summary містить id, status, progress, cancelRequested, часові поля, executedBy й безпечну error за failed. Приватний claim token у жодній відповіді не повертається.

Стани — `queued`, `running`, `completed`, `cancelled`, `failed`. Причини failed: `timeout`, `worker_error`, `server_shutdown`, `database_unavailable`, `invalid_input`, `worker_lost`. Partial result не видається за completed. Для наступної спроби користувач створює нову задачу звичайним POST.

Для ручної перевірки auth створіть у редакторі ігнорований `.local/auth-request.json` із **власними тимчасовими** даними за такою структурою (значення нижче — placeholders):

```json
{"username":"your_login","password":"replace-with-your-own-password"}
```

Перед створенням тимчасових файлів виконайте `umask 077`; створіть `.local`, якщо його ще немає, та встановіть `chmod 600 .local/auth-request.json`. Приклади нижче не друкують заголовки з токенами й не вміщують пароль в історію shell. Вони створюють справжній тимчасовий обліковий запис і справжні власні задачі; не запускайте їх з даними стороннього користувача.

```sh
umask 077
curl --silent --show-error --fail-with-body \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  --data-binary @.local/auth-request.json http://127.0.0.1:3000/api/auth/register
curl --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  --data-binary @.local/auth-request.json --cookie-jar .local/auth.cookies \
  http://127.0.0.1:3000/api/auth/login
curl --silent --show-error --cookie .local/auth.cookies \
  http://127.0.0.1:3000/api/auth/me
```

Після успішного входу, до виходу, створіть задачу з наявного прикладу. Відповідь зберігається в ігнорованому файлі; змінна містить лише перевірений UUID, не cookie чи пароль:

```sh
curl --silent --show-error --fail-with-body \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  --cookie .local/auth.cookies --data-binary @examples/route-small.json \
  --output .local/job-created.json --write-out 'HTTP %{http_code}\n' \
  http://127.0.0.1:3000/api/jobs
ROUTE_JOB_ID=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { id } = JSON.parse(readFileSync(".local/job-created.json", "utf8"));
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) process.exit(1);
  process.stdout.write(id);
')
curl --silent --show-error --cookie .local/auth.cookies \
  http://127.0.0.1:3000/api/jobs/limits
curl --silent --show-error --cookie .local/auth.cookies \
  "http://127.0.0.1:3000/api/jobs/$ROUTE_JOB_ID"
curl --silent --show-error --cookie .local/auth.cookies \
  'http://127.0.0.1:3000/api/jobs?status=active&limit=20&offset=0'
curl --silent --show-error --cookie .local/auth.cookies \
  'http://127.0.0.1:3000/api/jobs?limit=20&offset=0'
curl --silent --show-error --fail-with-body \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  --cookie .local/auth.cookies --data '{}' \
  "http://127.0.0.1:3000/api/jobs/$ROUTE_JOB_ID/cancel"
```

Повторюйте GET конкретної задачі для polling, доки стан не стане кінцевим. Малий квадрат може встигнути завершитися до cancel; тоді коректною буде незмінна відповідь `completed` із кодом `200`. Для перевірки running використовуйте власний допустимий обсяг справжнього пошуку. За двох запущених процесів можна замінити порт GET/cancel на `3001`: сесія й стан спільні, а `executedBy` відповідає `/api/health` фактичного виконавця. Щоб подати наступну задачу, повторіть звичайний POST; спеціального API повторного запуску немає.

Завершіть сесію та видаліть тимчасові auth/cookie/JSON-файли після перевірки:

```sh
curl --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' \
  -H 'Origin: http://127.0.0.1:3000' -H 'Content-Type: application/json' \
  --data '{}' --cookie .local/auth.cookies --cookie-jar .local/auth.cookies \
  http://127.0.0.1:3000/api/auth/logout
rm .local/auth-request.json .local/auth.cookies .local/job-created.json
unset ROUTE_JOB_ID
```

Очікувані auth-коди: register `201`, login `200`, me `200`, logout `204`; `/me` і `/api/jobs` після виходу — `401`. Cookie `courier_session` має `Path=/`, `HttpOnly`, `SameSite=Lax`, узгоджені `Max-Age/Expires`; `Secure` залежить від конфігурації. Випадковий токен з 32 байтів зберігається лише в cookie, у БД — SHA-256 цього токена. Пароль хешується асинхронним `scrypt` з окремою 16-байтовою сіллю, `N=32768`, `r=8`, `p=3`, `maxmem=64 MiB`, ключем 64 байти та версією формату. Сесія перевіряється через спільну БД на кожному захищеному запиті; прострочені записи очищуються при успішному вході. `COOKIE_SECURE=true` саме по собі не реалізує HTTPS.

## Структура й залежності

```text
src/server/            Express, конфігурація, PostgreSQL, auth та міграції
src/server/route/      Алгоритм, валідація, worker/executor, CLI, benchmark, генератор
src/server/jobs/       Repository/API/dispatcher, реєстр виконавців, snapshot/estimator
src/server/admin/      Role gate, bounded read-only repository та Kubernetes provider
src/server/http/       Спільний guard JSON/Origin для мутацій
src/client/            Auth, форма маршруту, API/controller, історія, SVG, CSS
src/shared/            Контракти маршруту, задач і типи/валідація облікових даних
examples/              Невеликі JSON-входи маршруту
migrations/            Версійовані SQL-міграції
scripts/               Керування локальною БД, перевірки й збирання
Dockerfile             Збирання production runtime без source/dev tools
deploy/                Закріплені образи, kind-конфігурація й Kubernetes-маніфести
tests/                 Unit та справжні PostgreSQL/HTTP integration перевірки
docs/assignment.txt    Незмінний дослівний оригінал викладача
docs/block-01-report.md Первинний звіт блоку 1
docs/block-02-report.md Фактичні перевірки блоку 2
docs/block-03-report.md Фактичні перевірки й виміри блоку 3
docs/block-04-report.md Фактичні перевірки двох процесів і життєвого циклу задач
docs/block-05-report.md Фактичні перевірки клієнта та браузерного UI
docs/block-06-report.md Черга, виконавці, ETA та фактичні виміри/перевірки
docs/block-07-report.md Production Docker, Traefik/HTTPS і дві app replicas
docs/block-08-report.md Metrics Server, HPA та докази автоматичного масштабування
docs/block-09-report.md Панель адміністратора, roles/RBAC/metrics і HPA observer
docs/block-10-report.md Поточне фінальне наскрізне приймання
docs/acceptance-matrix.md Від вимог 1–8 до коду, сценаріїв і фактичних доказів
docs/demo-guide.md     Практичний показ для викладача
PROJECT_PLAN.md         План і матриця вимог
AGENTS.md               Постійні інструкції та Git-правила
```

Один npm-проєкт, ESM, `NodeNext` на сервері та `.js` у відносних імпортах TypeScript. `src/server` → `dist/server`, `src/shared` → `dist/shared`, клієнт → `dist/client`; static-шлях і шлях до worker обчислюються від модуля й не залежать від поточної робочої папки.

Версії прямих залежностей зафіксовано в `package.json`, усіх транзитивних — у `package-lock.json`. Runtime: `express@5.3.0` для HTTP/static, `pg@8.23.1` для PostgreSQL, `cookie@2.0.1` для парсингу/серіалізації cookie. Інструменти: `typescript@7.0.2`, `vite@8.3.5`, `tsx@4.23.15`, `concurrently@10.0.6`, типи `@types/express@5.0.6`, `@types/node@24.19.2`, `@types/pg@8.23.1`. Блоки 4–10 не додають npm-залежностей і не змінюють lock-файл; UI написано на HTML/CSS/TypeScript, browser drivers використовують вбудовані Node.js API та вже наявний Chrome.

## Історія приймання

Блоки 1 і 2 прийнято. Працюють запуск HTTP-сервера, PostgreSQL, явні міграції та форми реєстрації/входу/виходу зі спільними серверними сесіями. Під час блоку 2 виконавець пройшов 11 unit і 13 справжніх PostgreSQL integration-перевірок. Керівник повторив 11 unit та доступні перевірки коду/HTTP; 13 DB-тестів він не повторював через відсутність придатного PostgreSQL. Історичні результати збережено у [звіті блоку 2](docs/block-02-report.md).

Блок 3 прийнято після перегляду коду та незалежного повторення керівником `npm ci`, typecheck/build, 47 тестів без БД, TS/built CLI і важкого benchmark. Керівник не повторював 13 PostgreSQL-тестів через відсутність придатної БД; їхній успіх підтверджено звітом виконавця. У цьому середовищі 200 млн реальних спроб виконано за 4,33 с; у керівника — приблизно за 21,48 с з тією самою найкращою довжиною. Результати збережено у [звіті блоку 3](docs/block-03-report.md).

Блок 4 прийнято: PostgreSQL зберігає задачі, базову спільну чергу, прогрес, історію й запити скасування; API перевіряє власника та атомарні ліміти. Виконавець пройшов усі 87 тестів. Керівник повторив **50 non-DB** (11 unit + 36 route/HTTP + 3 jobs config), typecheck/build, TS/built CLI та production HTTP; **37 PG-сценаріїв** він не повторював через відсутність придатної БД/TEST_DATABASE_URL. Історичний [звіт блоку 4](docs/block-04-report.md) збережено.

Блок 5 прийнято керівником: він повторив npm ci, typecheck/build, 87 non-DB, TS/built CLI та production/dev HTTP. 37 PG-сценаріїв, 14 груп Chrome й огляд PNG підтверджені виконавцем; керівник їх не повторював через відсутність придатних PostgreSQL/Chrome і не оглядав локальні PNG. Історичний [звіт блоку 5](docs/block-05-report.md) збережено.

Блок 6 розширює спільну чергу реєстром живих виконавців та приблизним часом до початку queued-задачі в API й наявному UI. Реальні результати, метод моделі й обмеження — у [звіті блоку 6](docs/block-06-report.md), матриця — у [PROJECT_PLAN.md](PROJECT_PLAN.md). Блок 7 із production Docker, двома незалежними app replicas за Traefik та локальним HTTPS прийнято. Керівник повторив 119 non-DB, typecheck/build/CLI/HTTP, але не 49 PG, container/Kubernetes/Chrome-сценарії та огляд PNG; їхні результати підтверджені виконавцем у [звіті блоку 7](docs/block-07-report.md).

Блок 8 реалізує Metrics Server і CPU HPA з межами **2–4 app pod**. Виконавець перевірив реальний **2→4→3→2**, completed задачі додаткових C/D, repeat deploy і stop/start; **183 тести**, 8 container, 19 static HTTPS груп і 9 HPA груп + 4 Chrome-спостереження пройшли. Фактичні виміри, проміжні збої та межі перевірок — у [звіті блоку 8](docs/block-08-report.md). Блок 8 прийнято керівником із незалежними 134 non-DB/typecheck/build/CLI/HTTP; PG/runtime/Chrome/PNG він не повторював.

Блок 9 додає read-only панель адміністратора з PostgreSQL role gate, реальними pod/process/job CPU/RAM, partial/stale та операторським CLI. Виконавець пройшов 227 тестів (60 PG), container/static HTTPS, повторні 16 local Chrome, 7 admin груп і один HPA 2→4→3→2 з admin observer. Факти й обмеження історичного прогону — у [звіті 9](docs/block-09-report.md). Блок 9 прийнято керівником: незалежно повторено 167 non-DB, typecheck/build, CLI/HTTP, CRC і 35 захищених файлів; PG/runtime/Chrome/PNG та порівняння всіх файлів з локальним Git HEAD він не повторював. Окреме поточне наскрізне приймання блоку 10 підтвердило всі погоджені функціональні пункти 1–8; це результат виконавця, не твердження про новий незалежний runtime-запуск керівника.

## Git і фінальний архів

Локальний репозиторій у корені проєкту збережено з історією, основна гілка — **main**. Remote й push не налаштовано. Завершені логічні зміни комітяться окремо з короткими англійськими назвами `type(scope): description`, scope необов'язковий. Перед комітом перевіряються status, звичайний і staged diff та доречні перевірки. Повні постійні правила — у [AGENTS.md](AGENTS.md).

Ігноруються `node_modules`, `dist`, `.env`, локальні кластери/дані, cookie-файли й логи; `.env.example`, SQL, тести, JSON-приклади та lock-файл відстежуються. Дослівні вхідні тексти захищені від перетворення кінців рядків у `.gitattributes`. Явне завершальне доручення дозволило блок 10: перевірки всіх погоджених вимог, документацію та фінальний ZIP. Після перевіреного архіву робота зупиняється; публікація, remote/push чи надсилання викладачу потребують окремого доручення. App pod на одному локальному kind node є незалежними серверними процесами; заміна pod контролером Deployment не є HPA або відмовостійкістю фізичних машин.

ZIP для локальної перевірки створюється після фінального коміту з точного HEAD:

```sh
git archive --format=zip --output=../CourierRoute-block-10.zip HEAD
open -R /Users/a860/Documents/CourierRoute-block-10.zip
```

Архів містить відстежувані файли поточного коміту, включно зі звітом, міграціями, тестами та lock-файлом. `.git`, `.env`, `node_modules`, `dist`, локальні БД, логи й cookie до нього не включаються. Архів залишається локальним; завантаження чи push не виконується.
