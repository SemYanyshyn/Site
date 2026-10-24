# Courier Route — сценарій показу

Показуємо робочий застосунок у VS Code й браузері. Основна частина займає приблизно 7–10 хвилин залежно від темпу й обладнання; повний HPA-цикл має окреме реальне очікування. [Матриця 1–8](acceptance-matrix.md) пов'язує кроки з вимогами, [звіт 10](block-10-report.md) містить поточні результати перевірок.

## Підготувати до приходу викладача

1. Відкрийте `/Users/a860/Documents/Site`. Перевірте `node --version` і `npm --version`: потрібні Node.js 24.x та npm 11.x. За вже налаштованого середовища не перевстановлюйте кластер на очах у викладача.
2. Запустіть **свій** Colima-профіль і demo, перевірте ready звичайним TLS-клієнтом:

```sh
cd /Users/a860/Documents/Site
colima start --profile courier-route --cpu 6 --memory 8 --disk 40 --runtime docker --vm-type vz --mount-type virtiofs --activate=false
export COURIER_DOCKER_HOST="unix://$HOME/.colima/courier-route/docker.sock"
export DOCKER_HOST="$COURIER_DOCKER_HOST"
npm run deploy:local
npm run deploy:status
curl --fail --cacert .local/deploy/tls/ca.crt https://localhost:8443/api/ready
open https://localhost:8443/
```

Очікуємо ready 200, два Ready app pod, HPA min 2 / max 4 і доступні метрики. `deploy:local` збирає або повторно використовує fingerprint-образ, явно виконує міграції й відновлює власні ресурси. Перший запуск з source ZIP потребує `npm ci` та інструментів із [README](../README.md#локальний-https-у-kubernetes); він може завантажувати образи. Фактичний URL і порти беріть із виводу helper-а: за інших port mappings замініть `8443` у наведених URL.

3. Для звичайного браузерного профілю користувач сам імпортує **лише** `.local/deploy/tls/ca.crt` у своє сховище довіри/Keychain після перевірки походження CA. Скрипти цього не роблять. Автоматизований тимчасовий Chrome має вузький leaf-SPKI виняток після нормальної TLS-перевірки; це не налаштовує довіру звичайного профілю. Private keys не імпортуйте й не показуйте.
4. Зареєструйте власний логін формою «Реєстрація», потім увійдіть. Логін — 3–32 латинські літери/цифри/`_`/`-`, пароль — 15–128 Unicode символів; пароль у документах і терміналі не записується. Публічна реєстрація завжди створює `user`.
5. Надайте admin **саме своєму вже наявному логіну**. Замініть `YOUR_LOGIN`, не виконуйте placeholder буквально:

```sh
npm run admin:role:deployment -- --username YOUR_LOGIN --role admin
```

Вийдіть і зайдіть повторно, перевірте кнопку «Адміністрування». Невідомий login CLI не створює; за замовчуванням admin немає. Для зняття ролі використайте ту саму команду з `--role user`.

Для наочного списку двох owners можна заздалегідь зареєструвати другий власний звичайний обліковий запис у приватному вікні й виконати один малий маршрут; роль admin надавайте лише явно обраному своєму login. Не використовуйте чужі акаунти.

Майте відкриті `docs/assignment.txt`, цю інструкцію та звіт 10. Не відкривайте `.env`, credentials, Secret, kubeconfig чи cookie. Особистий demo працює в namespace `courier-route`; автоматизовані drivers використовують інші ізольовані namespace й origin.

## Основна демонстрація: приблизно 7–10 хвилин

| Крок | Дія | Що побачити й пояснити | Пункт |
| --- | --- | --- | --- |
| 1. Вхід | Увійдіть власним логіном через HTTPS. | Особисті «Активні задачі» й «Історія»; сесія зберігається в PostgreSQL. Реєстрація не дає admin автоматично. | 4 |
| 2. Зрозумілий результат | Натисніть «Заповнити квадрат», задайте 10 000 ітерацій і seed `0`, потім «Знайти маршрут». | Completed, 100%, length 4, маршрут 0→1→2→3→0, замкнений SVG. Короткий квадрат може завершитися до першого polling — це нормальна швидкість. | 1, 2, 3 |
| 3. Збереження | Змініть чернетку, виберіть старий результат, оновіть сторінку. | SVG лишається зі збереженого input/result; історія й сесія збережені, reload не створює нову задачу. | 3, 4 |
| 4. Реальний progress і cancel | Вставте заготовлені координати важчого входу нижче, задайте дозволений API бюджет, запустіть і стежте за ітераціями. Натисніть «Скасувати задачу», дочекайтеся «Скасовано», після цього запустіть квадрат знову. | Ітерації справді зростають; running нижче 100%. «Очікуємо зупинки» ще не terminal; нова задача виконується після фізичного звільнення слота. Якщо задача вже completed, її cancel стану не змінює. | 1, 2, 3 |
| 5. Два worker і черга | За двох Ready/свіжих виконавців швидко подайте три власні допустимі важкі задачі, не чекаючи завершення попередньої. | Дві різні running мають різний `executedBy`; третя queued показує приблизний час **до старту** й потім справді починається. Четверта active відхиляється лімітом 3. Точний повторюваний доказ також є у фінальному static/HPA summary. | 3, 5, 6 |
| 6. Моніторинг | Відкрийте «Адміністрування», покажіть поточні app-сервери, UUID, busy, CPU/RAM, timestamp/window і список усіх власників; змініть фільтр, поверніться до «Мої маршрути». | Один слот на процес. Ready, busy і бажані HPA replicas різні. CPU — середнє за вікно app-контейнера, RAM — working set. Дані інших owners показуються тільки в read-only моніторинговому обсязі. | 8 |
| 7. Межі системи | Покажіть read-only UUID/endpoints нижче й таблицю A/B у звіті, поясніть HPA 2–4. Завершіть свої задачі або скасуйте лише власні незавершені й дочекайтеся terminal. | Один HTTPS origin, незалежні серверні процеси з реальними worker; додаткові pod ділять CPU одного kind node. Для повного HPA-показу є окремий driver, не ручний scale. | 5, 7 |

Квадрат можна ввести й вручну: склад `0 0`, доставки — по парі на рядок:

```text
1 0
1 1
0 1
```

Для важчого входу використайте наявний детермінований генератор після `npm run build`. На цій macOS команда копіює **лише 500 пар координат** у clipboard; вона не створює job і не виконує пошук:

```sh
node --input-type=module -e 'import { generateRouteInput } from "./dist/server/route/examples.js"; process.stdout.write(generateRouteInput(500, 200000000, 42).points.map(({ x, y }) => `${x} ${y}`).join("\n"));' | pbcopy
```

Вставте в поле доставок, склад `0 0`, seed `42`. У deployment дозволено до **200 000 000** ітерацій при 500 доставках і timeout **30 000 мс**; використовуйте фактичні межі, які показує UI з API. На швидшому комп'ютері обчислення може закінчитися раніше або HPA додасть слоти — не обіцяйте певної тривалості/черги. Для швидкого невеликого прикладу є [route-medium.json](../examples/route-medium.json): 10 доставок / 250 000 ітерацій. Збережений фінальний доказ двох busy та queued беріть зі звіту, якщо live-вікно вже минуло; не імітуйте progress.

## Як показати два справжні сервери

Ці читання без сесії не виводять credentials:

```sh
npm run deploy:status
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get pods -l app.kubernetes.io/name=courier-route-app -o custom-columns='NAME:.metadata.name,POD_UID:.metadata.uid,READY:.status.containerStatuses[0].ready,IMAGE:.status.containerStatuses[0].imageID'
kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get endpointslices -l kubernetes.io/service-name=app -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.uid}{" ready="}{.conditions.ready}{"\n"}{end}'
curl --cacert .local/deploy/tls/ca.crt -i https://localhost:8443/api/health
```

Повторіть health кілька разів: `X-Instance-Id` є UUID фактичного handler, а не клієнтським заголовком. Чергування health саме по собі доводить маршрутизацію, тому покажіть також таблицю **pod UID/process UUID → job → positive iterations → completed/result** у [звіті 10](block-10-report.md) і `executedBy` власних збережених задач. Worker-виконавець job може відрізнятися від handler поточного GET: дані спільні. Користувач завжди працює з одним origin, вручну обирати handler не потрібно.

## Окремий повний показ HPA

Це триваліша автоматизована перевірка; достатньо вже виконаного фінального прогону для захисту, другий stress заради скриншота не потрібний. Для нового свідомого повторення після підготовки runtime:

```sh
npm run test:autoscale
```

Driver використовує той самий production image, TLS/Traefik/HPA й ліміти: 3 звичайні load owners, максимум 9 active і 200 accepted, подавання до 120 с, загальний work budget 720 с та окремий скінченний cleanup. Четвертий admin observer не подає job. Не запускайте паралельно інші heavy/container/fault набори.

Підсумок команди називає `.local/autoscale-tests/<run-id>/summary.json`; він має `status`, `checks`, `timeline`, accepted/terminal split, C/D result proofs, admin observations і cleanup. Там же лишаються приватні desktop/360 PNG для локального огляду. Фінальний прогін блоку 10 від 24.10.2026 реально зайняв **9 хв 21,899 с**: 546,359 с роботи +15,540 с cleanup, в межах work budget 720 с. **10 груп PASS**, 81 прийнята задача =80 completed+1 навмисно cancelled, 0 failed/restart/transport. Safe summary: `.local/autoscale-tests/77f24f61-68a8-4df9-ac75-88250cbb8c35/summary.json`; 17 його PNG справді оглянуто. Це новий результат, окремий від історичного блоку 9.

HPA сам створює C/D: **2→4→3→2** допустимо. У фінальному прогоні чотири Ready/busy спостережено через 115,667 с, усі load jobs terminal через 196,041 с, фізичні 2 знову через 451,627 с. Доказ — positive-progress job і коректний completed result від кожного C/D, максимум 4 nonterminating під навантаженням, після cooldown фізично 2 pod / 2 Ready endpoints / 2 свіжі current registry. Desired=2 без фізичного зменшення недостатньо. Driver також перевіряє repeat при 4, missing metric/recovery і stop/start зі збереженням PVC/CA/session/results. Returned admin snapshot показав physical 2 та cached HPA current 3/desired 2; окремий узгоджений знімок driver-а підтвердив current=desired=2 — джерела й кеш мають різний час.

Це **власний випадковий test namespace з іншим HTTPS origin і тестовими акаунтами**. Demo `https://localhost:8443/` не покаже його навантаження. Driver сам запускає **headless** owner/admin Chrome observer на правильному test origin; видимих браузерних вікон він не відкриває. Для показу використовуйте безпечний summary і локальні PNG завершеного прогону, зокрема servers/jobs та окремі картки C/D. Не шукайте й не публікуйте cookies/паролі, не вводьте test credentials у demo. Cleanup закриває тільки свої Chrome/forwardings і видаляє власні disposable namespace/PVC; demo й спільний Metrics Server лишаються.

## Що сказати на захисті

- **Worker threads.** Побудова матриці й пошук виконуються в окремому worker, тому HTTP-процес продовжує відповідати. Один процес має один слот, progress рахує реальні ітерації, timeout/cancel фізично припиняють потік.
- **Traefik і черга.** Traefik розподіляє HTTP-запити між app-процесами. PostgreSQL-черга окремо атомарно призначає job виконавцю, тому UUID handler і `executedBy` не зобов'язані збігатися.
- **Спільна PostgreSQL.** У ній користувачі, сесії, jobs, progress, cancel і результати, тому login/читання/cancel працюють через будь-який handler. Локальний лічильник одного процесу не забезпечив би глобальну квоту.
- **Квота й історія.** Межа 3 active на власника та 100 outstanding у системі стосується queued+running. Completed історія зберігається й не стирається для звільнення квоти.
- **ETA.** Це приблизний час до початку за живими слотами, фактичним прогресом і збереженими вимірами. Він змінюється з навантаженням, не є countdown чи обіцянкою; невідоме значення показується явно.
- **HPA і ресурси.** HPA тримає 2–4 app pod та орієнтується на 70% CPU від request 250m; limit 1000m обмежує контейнер. Це додаткові контейнери одного node, не нові фізичні CPU або незалежні VM.
- **Адміністратор і метрики.** Кожний admin-запит спочатку читає чинну сесію/роль із БД; UI лише моніторить. CPU — window-average cores, RAM — app-container working set, з timestamp/coverage; Ready не означає idle, відмова metrics не означає logout.
- **Збереження й recovery.** Сесії та результати переживають app/PG restart на тому самому PVC. SIGTERM з активним worker дає `server_shutdown`, інфраструктурна втрата після persisted deadline/grace — `worker_lost`, без автоматичного повтору job.
- **Алгоритм і TLS.** Шукаємо найкращий знайдений евклідів маршрут з обмеженим бюджетом, без доведення глобального оптимуму. Зовнішній HTTPS завершується на Traefik; внутрішні Traefik→Express і Express→PostgreSQL з'єднання тут без TLS, локальні винятки Metrics Server описані в README.

## Якщо щось не готове

| Ознака | Безпечна перевірка й дія |
| --- | --- |
| Runtime не запущено | `colima status --profile courier-route`, `npm run deploy:preflight`; запустіть власний профіль командою підготовки, тоді `npm run deploy:local`. Не змінюйте чужий Docker context. |
| Порт зайнятий / URL не відповідає | `npm run deploy:status`, `lsof -nP -iTCP:8443 -sTCP:LISTEN`. Перевірте власника процесу й фактичний URL; чужий процес не зупиняйте. Інші `COURIER_HTTP_PORT`/`COURIER_HTTPS_PORT` задають **до першого створення** кластера, чинні mappings не переписуються. |
| CA не довірена | Перевірте `curl --cacert .local/deploy/tls/ca.crt https://localhost:8443/api/ready`. Якщо він успішний, налаштуйте ручну довіру проєктній CA у своєму звичайному профілі; не вимикайте TLS-перевірку. |
| Сертифікат прострочений | `openssl x509 -in .local/deploy/tls/localhost.crt -noout -dates` показує тільки строк. `npm run deploy:local` перевіряє придатність матеріалів; якщо helper відмовив, збережіть дані й виконайте його точну діагностику. Не стирайте PVC/credentials/CA навмання. |
| Ready 503 / schema не готова | `npm run deploy:status`, `kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get pods,jobs,pvc`. `npm run deploy:local` явно виконує compiled migrations до rollout; SQL 001–004 не редагуйте. Host dev окремо: `npm run db:start`, `npm run db:migrate`, `npm run db:check`. |
| Немає «Адміністрування» / 403 | Переконайтеся, що створили **свій** login саме в цьому origin/namespace; явно надайте йому роль операторським CLI й увійдіть повторно. Публічна форма не призначає admin. |
| Метрики unknown/stale/partial | `npm run deploy:status`; перевірте timestamp/window і source warning панелі, `kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route top pods -l app.kubernetes.io/name=courier-route-app --containers`. Дочекайтеся нового sample; невідоме — не нуль. Не розширюйте app SA права. |
| Після задач ще 3–4 pod | Перевірте HPA через `kubectl --kubeconfig .local/deploy/kubeconfig --context kind-courier-route --namespace courier-route get hpa app`. Scale-down має stabilization 180 с плюс метрики/reconciliation; дочекайтеся фізичних pod/endpoints, не робіть manual scale 4 чи 2 як доказ HPA. |
| POST мав мережеву помилку | Оновіть власну історію перед новою подачею. Невідомий результат POST не повторюється автоматично; completed у БД не підміняє відсутній strict cancel 202. |

## Завершення показу

Переконайтеся, що власні jobs terminal, а після HPA — знову фізично 2 Ready. Driver завершує свої дочірні процеси й cleanup сам; не вбивайте всі `node/docker/chrome` й не видаляйте namespace за широким selector.

Після фінального приймання 24.10.2026 demo залишено з 2 Ready/0 terminating/2 idle executor, HPA current=desired=2, normal CA ready 200; власні тестові ресурси прибрано. Colima, Metrics Server і host PostgreSQL працюють. Demo можна лишити працювати. Якщо потрібна зупинка:

```sh
npm run deploy:stop
# За потреби після зупинки demo — тільки власна VM:
colima stop --profile courier-route
# Host PostgreSQL — окремо від cluster PG/PVC:
npm run db:stop
```

`deploy:stop` спочатку прибирає свій HPA, чекає shutdown app, потім зупиняє PostgreSQL; PVC/CA/credentials зберігаються. Наступний запуск — власний Colima, потім `npm run deploy:local`; host БД — `npm run db:start`.

Source ZIP постачається без `.git`, готових `dist/node_modules`, `.env`, VM/PVC/БД, credentials, CA/private keys, внутрішніх PNG/logs/summary. Чистий source потребує інструкції запуску й нового локального оточення; повторне використання чинного PVC потребує збережених локальних credentials. Ні архів, ні матеріали не надсилаються викладачу автоматично.
