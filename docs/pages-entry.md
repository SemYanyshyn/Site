# Courier Route — опублікована сторінка переходу

**Фактичне посилання GitHub Pages: https://semyanyshyn.github.io/Site/**

02.11.2026 опубліковано окрему українську сторінку Courier Route з описом, зеленою кнопкою та поясненням: демо доступне, поки MacBook і HTTPS-тунель увімкнені. Вхід і задачі виконуються після звичайного переходу на сайт справжнього демо. На Pages немає форми входу, API-клієнта, JavaScript застосунку або збереження задач.

## Як оновити адресу кнопки

1. У поточному локальному проєкті з наявним механізмом тунелю виконайте:

   ```sh
   cd /Users/a860/Documents/Site
   npm run demo:public:status
   ```

   Використайте значення `url`, коли `running=true` і `phase=ready`. Ця команда тільки читає стан; вона не перезапускає тунель або Kubernetes.

2. Відкрийте **[landing/demo-url.json у гілці pages/demo-entry](https://github.com/SemYanyshyn/Site/blob/pages/demo-entry/landing/demo-url.json)** і натисніть значок олівця **Edit this file**. Замініть тільки значення `demoUrl` новою HTTPS-адресою з кінцевим `/`. Це **єдине джерело адреси** для сторінки; HTML, SCSS і workflow редагувати не потрібно.
3. Натисніть **Commit changes** і виберіть коміт безпосередньо в **pages/demo-entry**. Не комітьте цю зміну в main або build/github-pages.
4. У [Actions](https://github.com/SemYanyshyn/Site/actions) дочекайтеся успішного **Publish Courier Route entry page**. Workflow перевірить справжній `/api/ready` та HTML демо перед публікацією; недоступне демо зупиняє оновлення. Посилання Pages залишається тим самим. Оновіть сторінку після deployment, за потреби — з очищенням browser cache.

Змінити `demoUrl` і зробити коміт у `pages/demo-entry` — достатня дія для оновлення Pages. Налаштовувати CORS/cookie/бекенд або зливати feature-гілку не потрібно.

## Ізоляція та публікація

- Гілку **pages/demo-entry** створено від актуального `origin/main` на `c24d48b`. Код `build/github-pages` не зливався в main; main залишився на тому самому SHA. Основна робоча папка Site залишилася на своїй feature-гілці.
- Джерела сторінки — `landing/index.html`, `styles.scss`, `demo-url.json`, `build.mjs`. Палітра узгоджена з основним зеленим дизайном: `#204f40`, `#203b31`, `#f5f7f2`, `#e7f0e5`; авторські стилі написані тільки в SCSS. Сторінка має mobile media query і видимий keyboard focus.
- Локальне збирання з Node24/npm11 після npm ci: `node landing/build.mjs --verify-demo`. Вихід — **dist/pages-entry**. Звичайні npm scripts, Vite client build, package/lock і код основного застосунку не змінювалися.
- Офіційний workflow `.github/workflows/pages-entry.yml` запускається після push змін landing/workflow до **pages/demo-entry**. Node24, npm11.16.0, npm ci, SCSS build, перевірка живого демо, configure-pages/upload-pages-artifact/deploy-pages з pinned SHA, окремі мінімальні permissions, concurrency github-pages та environment github-pages.
- GitHub Pages увімкнено з `build_type=workflow`, HTTPS enforced. Environment приймає deployment тільки з точної гілки **pages/demo-entry**. Перенесення всього feature-коду у main не виконувалося.
- Фактичний завантажений `github-pages` artifact перевірено після download: **лише index.html і assets/styles.css**, побайтово однакові з локальною збіркою, без symlinks/hardlinks. SCSS/source/config/docs, dist/client, server, .env, залежності та Kubernetes-файли не публікуються.

## Результати перевірки

[Успішний build і deployment](https://github.com/SemYanyshyn/Site/actions/runs/41470583524) — commit `2340455` (`feat(pages): publish a standalone Courier Route demo entry`). Обидві jobs завершилися success.

Перед публікацією чинну адресу перевірено через наявний `npm run demo:public:status`; running=true/phase=ready. Додаткові HTTPS readiness і HTML перевірки пройшли локально та у GitHub Actions. Адресу тунелю не вигадували й не перезапускали.

Після фактичного deployment виконано **HTTP-перевірку** саме опублікованого Pages:

- HTML200 та CSS200, правильні MIME і побайтовий збіг зі зібраними файлами.
- Рівно одна кнопка-посилання; href точно дорівнює поточному demoUrl.
- За href з опублікованого HTML виконано справжній HTTPS-перехід: кінцева адреса демо без перенаправлення, HTML200 Courier Route, api/ready200.
- На сторінці немає form/input/script, викликів /api чи окремої форми авторизації. Це звичайна навігація до іншого origin, а не міждоменний API-вхід.
- `npm run typecheck`, незмінний повний `npm run build` в ізольованій папці, SCSS build, native syntax, actionlint1.7.12 і git diff --check — PASS. Наявні тести не змінювалися; повторного прогону DB/HPA/fault suites для окремої статичної сторінки не було.
- Diff проти origin/main для src/deploy/migrations/package/lock/Vite/tsconfig порожній. Основний застосунок, його інтерфейс, авторизація, дані та Kubernetes не редагувалися; до робочої БД не зверталися із записом.

Browser runtime у цьому сеансі не має підключеного браузера (порожній discovery). Тому HTTP-перехід не видається за виконаний клік у браузері чи візуальне приймання. Стилі скомпільовані, опублікований CSS перевірений; desktop/mobile screenshot та visual assertions не заявляються пройденими.

[Офіційний workflow GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). Усі зміни сторінки/документації закомічені окремо; SHA фінального docs-коміту й статус Git наведені у чаті, без циклу комітів заради власного хешу.
