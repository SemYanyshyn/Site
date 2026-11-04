# Відновлення public-demo — 04.11.2026

Початковий git status був чистим, гілка build/github-pages. Комітів і push за цим дорученням не виконано. Під час роботи з’явилися сторонні редагування клієнта та каталог css/; їх збережено й не включено у виправлення тунелю.

## Що виправлено

Старий regex приймав будь-який https://*.trycloudflare.com, тому URL API з помилки ставав адресою демо. Тепер parser приймає тільки окремий рядок адреси відразу за точним повідомленням успішного створення у штатному INF-банері. Зарезервовані api/www/docs/developers, credentials, порти, шляхи, query, lookalike domains та ERR-рядки не приймаються. Формат звірено з [кодом cloudflared](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go).

Новий core helper містить parser, очікування URL, bounded HTTPS-пробу, свіжий status та спільну перевірку start/restart. CLI залишає PID/start-time/executable guard, приватні файли й штатний deploy. Імпорт CLI не запускає його автоматично; state записується атомарно.

Перед deployment потрібні успішний банер, чинний власний процес і реальна публічна /api/ready. До цього Origins не змінюються. Після deployment перевіряються readiness та точний дозволений Origin. Повторний start знову перевіряє доступність; якщо окремий deploy:local скинув Origin, відновлює його тільки після підтвердження адреси й доступу. Помилка API повертає зрозуміле повідомлення, exit code 1 та state без службового URL.

Status розділяє running і ready. url видається лише для доступного сайту. phase обчислюється наново; recordedPhase є історією, checkedAt — часом поточного виклику, readiness.checkedAt — часом HTTP-проби. Старий ready чи живий процес самі по собі не дають позитивного результату.

Очікування адреси та кожне вікно readiness обмежені 30 секундами; HTTPS-проба — 5 секундами включно з тілом відповіді, PID-перевірки — окремими 3-секундними таймаутами. Readiness не слідує redirect, обмежує JSON 8 KiB й не вимикає перевірку TLS. Локально використовується наявний CA; публічно — звичайний trust store. Обмежені PID-перевірки можуть додати час до вікна очікування.

## Фактична діагностика

- cloudflared: 2026.10.7, built 2026-10-30. Бінарник не оновлювали.
- DNS API повернув A 104.16.230.132 / 104.16.231.132 та AAAA 2606:4700::6810:e784 / 2606:4700::6810:e684.
- Звичайні HTTPS GET до API через curl -4 і curl -6: HTTP 000, connect/TLS 0, TCP connection timeout приблизно 5,006 с. Це збій до TLS/HTTP-відповіді, а не доказ помилки сертифіката.
- Контрольний HTTPS-запит до GitHub: HTTP 200 приблизно за 0,74 с.
- У поточному оточенні proxy-змінні не встановлені; scutil не показав налаштованого proxy чи VPN-сервісу. Це не виключає сторонніх фільтрів або мережевих обмежень і не доводить вину VPN/провайдера/Cloudflare.
- Локальна CA-verified https://localhost:8443/api/ready перед і після спроби: status ready.
- Одна реальна спроба виправленого start: cloudflared записав failed to request quick Tunnel / context deadline exceeded; команда повернула exit code 1. Процес тунелю завершений, lock прибрано.
- Фінальний status: running=false, ready=false, url=null, phase=failed. У самому state.json також url=null.
- SHA256, розмір і mtime deployment.log та CA до/після збіглися. Штатний deployment не запускався; Origins і робочі дані цим запуском не змінювалися. Мережеві налаштування, VPN/proxy, PostgreSQL/PVC, кластер і credentials не видаляли й не пересоздавали.

Публічний доступ не підтверджено; URL демо не створено. HTML/JS/CSS, browser login і тестову задачу через публічний origin не перевіряли, бо такого доступного origin немає. Існуючі облікові записи не змінено, тимчасового користувача не створювали.

## Перевірки

- node --check для обох mjs, npm run typecheck та npm run build — PASS.
- npm run test:pages — 29 PASS, включно з 17 public-demo тестами (3 попередні й 14 нових).
- npm run test:unit — 54 PASS. Разом 83 тести; це не запуск повного npm test або browser-приймання.
- Нові сценарії: успішний банер, API timeout з URL у помилці, сторонні/небезпечні URL, exit до URL, deadline, stale ready, процес живий/сайт недоступний, свіжий status, заборона раннього deployment, повторний start, скинутий Origin, TLS/status/JSON/redirect і завислі headers/body.
- Наявні тести збережено. git diff --check — PASS.

## Наступний крок

Перемкнути MacBook на інше інтернет-з’єднання, наприклад мобільну точку доступу, й виконати один повторний запуск:

```sh
cd /Users/a860/Documents/Site
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run demo:public
npm run demo:public:status
```

Зупинка тільки тунелю:

```sh
npm run demo:public:stop
```

Не використовувати адресу API як посилання демо. Підтверджене посилання з’явиться у url лише при ready=true. Автоматичного переходу на інший сервіс, послаблення TLS або зміни мережевих налаштувань немає.
