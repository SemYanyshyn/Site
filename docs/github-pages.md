# Публічний доступ і GitHub Pages

Стан на **02.11.2026**: обрано тимчасове безкоштовне demo з MacBook через Cloudflare Quick Tunnel. Це **справжній застосунок**, включно з backend, PostgreSQL, спільною чергою, worker threads, Traefik і наявним Kubernetes/HPA. Вигаданих результатів або localStorage-сховища задач немає.

GitHub Pages **не опубліковано**. Підготовлено клієнтську збірку і workflow; очікувана стандартна адреса підтвердженого публічного репозиторію `SemYanyshyn/Site` — `https://semyanyshyn.github.io/Site/`. Це адреса майбутнього Pages, а не готове посилання для користування зараз. Видимість репозиторію не змінювали.

## Поточне demo для викладача

```sh
cd /Users/a860/Documents/Site
# Node 24 і npm 11; на цьому Mac:
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run demo:public:status
```

Поле `url` містить фактичне посилання. Відкрийте **саме його корінь** у браузері й зареєструйтеся або ввійдіть своїм обліковим записом. Паролі й токени не потрібно передавати через чат. Нова реєстрація створює роль user; адмін доступ збережено тільки за фактично призначеною роллю. Роль не надається автоматично.

Для запуску/повторного запуску:

```sh
npm run demo:public
```

Скрипт використовує `.local/tools/cloudflared`, створює випадковий публічний URL, додає **тільки цей точний origin** поряд із `https://localhost:8443` та виконує штатний `deploy:local`. Він чекає звичайної локальної TLS-перевірки й справжнього публічного `/api/ready`. Повторний start при живому власному процесі повертає поточний URL. URL/state/PID/logs лишаються в ignored `.local/public-demo`, а не Git. Stop звіряє PID, час створення й команду процесу.

```sh
npm run demo:public:stop
```

Зупиняється тільки власний тунель. Kubernetes, PostgreSQL, PVC й локальний HTTPS залишаються. Наступний звичайний `npm run deploy:local` без `COURIER_ADDITIONAL_APP_ORIGINS` повертає перелік origins до локального. Після перезапуску тунелю адреса буде іншою; скрипт заново узгодить її через штатний deploy. Не підставляйте стару адресу вручну.

MacBook повинен залишатися увімкненим, підключеним до інтернету, без сну, із запущеним власним Colima/Kubernetes і тунелем. За потреби виконайте `caffeinate -i` у власному терміналі та завершіть Ctrl+C після показу. Це не автономний хмарний сервер. Quick Tunnel не вимагає домену чи Cloudflare-акаунта, але не має гарантії доступності; його hostname змінюється після нового запуску. Обмеження — 200 одночасних незавершених запитів і відсутність SSE; застосунок використовує звичайний JSON polling. [Офіційна документація](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Схема: браузер → публічний HTTPS Cloudflare → зашифрований тунель → `https://localhost:8443` → Traefik → справжні app pod → PostgreSQL. Для локального TLS `cloudflared` використовує проєктну `ca.crt`, `origin-server-name=localhost` і Host `localhost`, якого очікує існуючий Ingress. TLS-перевірку не вимкнено; private key у тунель не передається. [Параметри TLS origin](https://developers.cloudflare.com/tunnel/reference/origin-parameters/).

На цьому Mac офіційний `cloudflared 2026.10.7` завантажено лише в `.local/tools`; SHA256 архіву звірено з digest офіційного release: `3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd`. [Офіційний macOS arm64 архів](https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-darwin-arm64.tgz). Інший checkout потребує такого ж перевіреного executable за `.local/tools/cloudflared`, Node 24/npm 11 і підготовленого локального deployment за README; binaries/credentials до source не входять.

## Збірки й адреса API

```sh
npm ci
npm run typecheck
npm run build                 # повний чинний локальний/Docker build; base /
npm run build:pages           # тільки Vite client; base /Site/
node scripts/check-pages-artifact.mjs
```

`build.outDir` фактично дорівнює **dist/client**. Усього `dist` завантажувати не можна: повна збірка також містить server/shared/migrations/examples. Pages-збірка очищує тільки клієнтський outDir й не запускає backend, workers або міграції. Перевірка артефакту контролює файли, посилання HTML/CSS, відсутність symlinks та відомих серверних секретних форматів. Успішний build не означає успішний API-вхід.

Змінна `VITE_API_BASE_URL` — **публічний HTTPS origin без /api, іншого шляху, query, fragment або credentials**. Усі запити auth, jobs/limits/history/detail/cancel, admin і health використовують один transport у `src/client/api-endpoint.ts`. Порожнє значення зберігає `/api/...` і `same-origin`; налаштований origin додається до `/api/...` та використовує `credentials: include`. Таймаути, abort, перевірки відповідей, session/selection generations і заборона повтору невизначеного POST залишилися на місці.

Для поточного тунельного demo VITE-змінну **не потрібно** налаштовувати: фронтенд та API працюють з одного публічного origin, cookie — host-only, Secure, HttpOnly, SameSite=Lax. Адресу localhost у браузер викладача не вбудовано. Секрети, `DATABASE_URL`, `.env`, ключі або cookie ніколи не повинні бути VITE-змінними чи Actions artifact.

`PAGES_BASE_PATH` діє лише для `--mode pages`: за замовчуванням `/Site/`; `/` або порожній рядок означає корінь/custom domain. Звичайний `npm run build` завжди лишає `/`. Фактичні `configure-pages.outputs.base_path` та `base_url` використовуються під час дозволеної публікації.

## Міждоменна авторизація й майбутній Pages

API має точний allowlist `APP_ORIGINS`, credentialed CORS та bounded OPTIONS для GET/POST з Content-Type. Чужі/null/wildcard origins не отримують доступу; на POST збережені обов'язкові Origin і application/json. CORS не замінює сесійну автентифікацію або роль admin. `SESSION_COOKIE_SAME_SITE` за замовчуванням `lax`; опційний `none` дозволений тільки з `COOKIE_SECURE=true`, з такими ж attributes при logout. Domain не додається, cookie лишається HttpOnly.

**Pages на github.io та API на trycloudflare.com — різні sites.** Навіть `SameSite=None; Secure` й коректний CORS не обходять звичайне блокування сторонніх cookie. Тому поточне посилання викладачу віддає весь застосунок із одного origin; Pages не видається за готовий робочий застосунок. [CORS і сторонні cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [SameSite/Secure](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Для надійного окремого Pages frontend і API потрібні, наприклад, **ваші** HTTPS домени `courier.<ваш-домен>` і `api.<ваш-домен>`: перший — custom domain GitHub Pages з відповідним DNS, другий — справжній публічний backend/Traefik із чинним TLS. Вони будуть same-site, залишаючись різними origins; потрібні include credentials, точний frontend origin в APP_ORIGINS і Secure/HttpOnly/Lax на API. Це приклад схеми, не вигадані робочі адреси. Домен не купували, платних ресурсів не створювали. Без MacBook потрібен окремий доступний сервер/кластер і persistent PostgreSQL; таке розгортання ще не виконане.

## Workflow GitHub Pages

Файл `.github/workflows/pages.yml`: офіційні checkout/setup-node/configure-pages/upload-pages-artifact/deploy-pages, закріплені SHA актуальних офіційних releases на 02.11.2026. Node 24, npm 11.16.0, `npm ci`, typecheck, client/Pages HTTP тести, клієнтський build і перевірка ресурсів. Concurrency `github-pages`, мінімальні окремі permissions; deployment використовує environment `github-pages`.

За замовчуванням push/PR до main і ручний запуск **лише перевіряють збірку**. Upload/deploy заблоковані до налаштування backend. Коли реальні домени/авторизація узгоджені:

1. У Settings → Pages підтвердженого репозиторію Site виберіть Source **GitHub Actions**, налаштуйте фактичний custom domain за потреби.
2. У Settings → Secrets and variables → Actions → **Variables** додайте публічний `VITE_API_BASE_URL` і `PAGES_DEPLOYMENT_READY=true`. Це технічний прапорець готовності конфігурації, не доказ browser-приймання.
3. Код має бути в main звичайним процесом review/merge. Запустіть workflow вручну з `publish=true` або наступним push у main. PR/інша гілка не публікуються.
4. Перед upload preflight звіряє реальний HTTPS backend, health/ready, точний credentialed CORS, login OPTIONS і anonymous me401. Публікується тільки `dist/client`.
5. Після першої публікації перевірте **через фактичний Pages URL** зі звичайними налаштуваннями cookie: register/login/reload/logout, create/progress/result/history/cancel, admin/user403, desktop/360 px і console/network. До цього frontend-публікація не є повним прийманням застосунку.

Зараз Pages/Actions variables/environment не змінювали; workflow у GitHub не запускався. [Офіційний Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Vite base](https://vite.dev/guide/static-deploy).
