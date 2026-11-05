# Тимчасове HTTPS-демо через Pinggy Free

Реалізовано й перевірено 04.11.2026. Комітів і push немає. Чинну адресу отримуйте через status: URL не зашитий у frontend або source-конфігурацію.

## Обраний сервіс та обмеження

Обрано Pinggy Free: безкоштовний SSH-тунель через TCP 443, публічний HTTPS, без реєстрації чи токена, сеанс до 60 хвилин. Після завершення/перезапуску буде новий випадковий URL. Це не платний тариф і не пробна підписка.

При першому відкритті у звичайному браузері Pinggy показує одноразове підтвердження переходу. Натисніть кнопку продовження, потім працюйте зі справжнім Courier Route. У перевірці не додавали screening-bypass headers і не вимикали TLS.

Офіційні джерела: [Quickstart](https://pinggy.io/docs/), [ціни й 60-хвилинний ліміт](https://pinggy.io/#pricing), [SSH usage](https://pinggy.io/docs/usages/), [browser screening](https://pinggy.io/docs/http_tunnels/screening/).

Перевірено також [localhost.run](https://localhost.run/docs/forever-free): безкоштовний nokey-режим доступний через SSH, HTTPS і робота застосунку спочатку підтвердилися. Однак сервіс реально змінив домен у живому з’єднанні приблизно через п’ять хвилин. Helper виявив невідповідність і приховав стару адресу. Цей варіант не залишено як фінальний через коротке життя анонімної адреси. Розглянуто [ngrok Free](https://ngrok.com/docs/pricing-limits/free-plan-limits), але додатковий акаунт/інсталяція не знадобилися після успіху Pinggy.

## Команди

```sh
cd /Users/a860/Documents/Site
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

npm run demo:ssh
npm run demo:ssh:status
npm run demo:ssh:stop
```

MacBook, інтернет, Colima/Kubernetes і SSH worker мають залишатися ввімкненими. Локальний https://localhost:8443/api/ready повинен бути готовим до start.

Status розділяє running та ready, показує checkedAt та орієнтовний expiresAt (ISO UTC). url повертається лише після свіжої HTTPS readiness з точним дозволеним Origin; при недоступності — null. Історичний ready не вважається доказом доступності. Після закінчення free-сеансу потрібно знову запустити helper. Для нової години перед показом:

```sh
npm run demo:ssh:stop
npm run demo:ssh
npm run demo:ssh:status
```

Старе посилання після restart не використовуйте. Повторний start при живому справному сеансі зберігає PID/URL і не виконує зайвого deployment. Рекомендовано одночасно використовувати один public helper: останній deployment визначає додатковий публічний Origin.

Stop перевіряє PID, час запуску, executable, worker script і session UUID, завершує лише власні worker/SSH/loopback-адаптер. Kubernetes, PostgreSQL/PVC, CA та дані залишаються. Наступний звичайний deploy:local без додаткової змінної повертає локальний allowlist.

Cloudflare helper і попереднє виправлення URL/status збережені без змін:

```sh
npm run demo:public
npm run demo:public:status
npm run demo:public:stop
```

## Схема й перевірки

Браузер → публічний HTTPS Pinggy → зашифрований SSH → HTTP лише на 127.0.0.1 із випадковим портом → HTTPS localhost:8443 з проєктним CA → Traefik → наявний Courier Route.

Адаптер задає Host localhost і перевіряє CA/hostname/SNI localhost. Origin, cookie, Set-Cookie, метод, шлях/query і тіло передаються без зміни; hop-by-hop headers прибираються. Frontend та API працюють з одного публічного origin. Авторизацію, захист Origin та перевірку TLS не послаблено.

URL приймається лише зі stdout поточного SSH-сеансу після точного Pinggy Free banner про створений 60-хвилинний сеанс. Сторонні URL, docs/dashboard/API, помилки, credentials, query, port і path не приймаються. Session UUID і PID метаданих повинні збігатися зі станом власного worker. До deployment потрібні підтверджене призначення адреси, живий worker і справжня публічна readiness. Точний Origin додається через наявний COURIER_ADDITIONAL_APP_ORIGINS і штатний deployment; після нього readiness повторюється з Origin.

Для SSH створюється окремий ключ .local/ssh-demo/id_ed25519 з mode 600. Він не вимагає реєстрації чи токена Pinggy, не додається в agent і не потрапляє до Git/Docker. Особисті ключі не використовуються: явний IdentityFile, IdentitiesOnly=yes, IdentityAgent=none, окремий known_hosts. Перше з’єднання використовує TOFU (StrictHostKeyChecking=accept-new); змінений відомий host key відхиляється. Глобальні SSH, macOS, VPN/proxy не змінюються. Запитів пароля в чат або термінальний prompt немає.

Призначення URL й кожне вікно readiness мають бюджет 30 с; HTTPS-проба — 5 с включно з тілом; SSH connect — 8 с/одна спроба, keepalive — 15 с/2 пропуски; локальний upstream — 30 с. PID-перевірки додатково обмежені 3 с. Немає нескінченного reconnect. Pinggy flags x:https і x:passpreflight зберігають HTTPS-only доступ та стандартні preflight-запити.

## Фактичні результати

- Синтаксис трьох mjs, npm run typecheck, npm run build — PASS.
- npm run test:pages — 39 PASS, з них 10 нових SSH-тестів; старі Cloudflare/Pages тести збережено.
- npm run test:unit — 54 PASS. Разом 93 автоматичні тести; це не повний npm test чи повторне HPA stress-приймання.
- Реальний TLS-fixture довів збереження Origin/cookie/тіла й відмову при неправильному CA; перевірено hard timeout. Також перевірені parser, небезпечні URL, stale ready, expiry, процес/доступність, ownership stop і deployment лише після перевірки.
- Фінальний Pinggy URL: /api/ready 200, реальні HTML/JS/CSS 200. Browser User-Agent отримує документований screening, а програма без browser UA отримує застосунок. Це не видається за проходження browser flow: його окремо виконано нижче.
- Ізольований Google Chrome з типовим TLS: звичайний клік screening → реєстрація нового тестового user → login → cookie після reload → одна реальна задача (3 доставки, 1000 ітерацій, seed 0) → completed, замкнений квадрат довжини 4 → logout. Немає uncaught JS exceptions. Desktop/mobile screenshots оглянуто.
- Anonymous me/jobs — 401; чужий Origin — 403; exact Origin дозволений. Cookie Secure/HttpOnly/SameSite=Lax/host-only, перевірена сесія через дві app-копії. Login200, шість me200, logout204.
- Для Pinggy фактично виконані repeat start, stop/status та новий start; після stop running=false/ready=false/url=null, локальний застосунок залишився готовим. Для попереднього localhost.run також перевірено закриття PID/порту та відсутність зайвого deployment на repeat start.
- UID PVC і SHA256 проєктного CA збіглися до/після. Кластер, PVC/дані, credentials та CA не видаляли й не пересоздавали. Cloudflare helper/core побайтово незмінні від початку цього доручення.
- Тимчасовий localhost.run мав один непідтверджений browser reload, потім успішну повторну перевірку; пізніше виявлено зміну адреси в живій сесії. Точну причину reload-таймауту не встановлено. Фінальний Pinggy browser flow пройшов після звичайного screening.
- У процесі оцінки створено два окремі тестові user (localhost.run і фінальний Pinggy), кожному по одній completed задачі. Існуючі облікові записи не використовували й не змінювали. Тестові записи залишені, не видалені.
- Нових npm-залежностей і змін package-lock.json немає; .local виключено з Git та Docker build.

Приватні докази: .local/ssh-demo/http-verification.json, browser-verification.json, session-verification.json, browser-desktop.png, browser-mobile.png, deployment.log. Дані тільки тестових користувачів — verification-account.json і verification-account-localhost-run.json у цій же ignored-папці з mode 600. Паролі, private key й cookie в чат не виводилися. Тимчасові профілі Chrome й TLS-fixture прибрано; фінальний Pinggy worker залишено працювати. Для актуального URL й стану використовуйте demo:ssh:status.

## Файли цього доручення

- scripts/ssh-demo.mjs — start/status/stop, приватний стан, точний Origin і штатний deployment.
- scripts/ssh-demo-worker.mjs — власні SSH і loopback-адаптер, bounded shutdown.
- scripts/ssh-demo-core.mjs — parser, ownership, TLS-адаптер, свіжі readiness/expiry.
- tests/ssh-demo.test.ts — регресійні й справжні TLS-перевірки.
- package.json — три npm-команди та включення тестів.
- README.md, docs/github-pages.md, docs/ssh-demo.md, PROJECT_PLAN.md — інструкції та фактичний звіт.

Попередні виправлення Cloudflare й сторонні зміни src/client, src/server, css/ збережено. Жодних commit/push.
