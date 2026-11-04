# Як deploy-local.mjs підключається до Colima

Ключове місце — об’єкт `dockerEnvironment` у [scripts/deploy-local.mjs](../scripts/deploy-local.mjs):

```js
const dockerEnvironment = {
  ...process.env,
  DOCKER_HOST:
    process.env.COURIER_DOCKER_HOST ??
    `unix://${homedir()}/.colima/courier-route/docker.sock`,
};
```

- `homedir()` повертає домашню папку користувача. На цьому Mac типовий повний шлях — `/Users/a860/.colima/courier-route/docker.sock`.
- `unix://` означає підключення через локальний Unix-сокет. Сам сокет надає працюючий профіль Colima; цей скрипт не створює його й не запускає Colima.
- `COURIER_DOCKER_HOST` дозволяє явно вибрати іншу адресу. Якщо змінної немає, використовується сокет профілю courier-route.
- `...process.env` зберігає інші змінні оточення для дочірньої команди. Об’єкт не змінює глобальні налаштування термінала.

Фактичний запуск видно у `preflight()`:

```js
run("docker", ["version", "--format", "{{.Server.Version}}"], {
  env: dockerEnvironment,
});
```

`run()` передає `env` у `runDeploymentCommand()`. У [scripts/deployment-command.mjs](../scripts/deployment-command.mjs) ця функція запускає команду через `spawn(command, args, { cwd, env, ... })`. Docker отримує `DOCKER_HOST` і звертається до Docker у профілі Colima через вказаний сокет.

Такий самий `env: dockerEnvironment` використовується для перевірки й збирання образів у `buildImage()`, команд kind у `clusterState()` та завантаження образу в `loadOwnedImage()`. Через це вони працюють з одним контейнерним середовищем.

`kubectlFor()` має інший спосіб підключення: параметри kubeconfig, context і namespace визначають доступ до API Kubernetes. Це також пояснено коментарями біля функції.

03.11.2026 англомовні коментарі у надісланому deploy-local.mjs перекладено українською; додано пояснення наведених блоків. Надісланий текст збігався з початковим робочим файлом. Попереднє незакомічене форматування збережено; до окремого коміту підготовлено тільки зміни коментарів відносно HEAD, без цього форматування.

Перевірки: native syntax, npm run typecheck і npm run build пройшли. Порівняння через esbuild із вилученням коментарів окремо для робочого файлу й версії коміту підтвердило незмінність виконавчого коду. Усі 50 рядків коментарів містять український текст. Перевірочний підхід через старий TypeScript createPrinter виявився несумісним з установленим TypeScript7; замість нього виконано успішне порівняння через наявний esbuild. Deploy, Colima, Docker і Kubernetes для цієї зміни не запускалися.


## Де описую та створюю кластер

04.11.2026 додано особисті українські коментарі в scripts/deploy-local.mjs:

- Біля cluster, context, kubeconfig і statePath пояснено назву кластера, запис підключення та службові файли.
- У clusterState() пояснено пошук через kind get clusters, повторне використання власного кластера й перевірки контейнера вузла та портів.
- Біля читання deploy/kind-config.json пояснено джерело опису кластера, вилучення нотаток і підстановку образу та портів.
- Біля kind create cluster пояснено --name, --config, --kubeconfig і --wait 180s.
- У kubectlFor(), assertClusterOwnership() і main() пояснено вибір власного кластера, простору імен та умову дозволеного створення.

Порівняння виконуваного коду без коментарів через esbuild, перевірка синтаксису, typecheck/build і diff --check пройшли. Кластер не створювався й не перезапускався; попереднє незакомічене форматування deploy-local.mjs і редагування Dockerfile збережені поза комітом.
