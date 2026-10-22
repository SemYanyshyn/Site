# Звіт блоку 1 — Courier Route

Дата: 22 жовтня 2026 року, Europe/Kiev.

**1. Статус: готово.** Документацію й каркас створено, усі доступні обов'язкові перевірки пройдено. Візуальна перевірка недоступна через відсутність браузерного підключення. Блок 2 не розпочато.

**2. Середовище.** macOS 26.6.2 (25G83), Darwin arm64; RAM — 24 GiB, вільна пам'ять за `os.freemem()` на момент виміру — 404 570 112 байтів (385,8 MiB). `sysctl hw.memsize` обмежений sandbox; пам'ять визначено через `node:os`. Node.js 24.18.0, npm 11.16.0, Git 2.54.0 (Apple Git-157). У `package.json` дозволено Node 24.x та npm 11.x; у `.nvmrc` — 24. Підтримуваність гілки перевірено за [офіційним графіком Node.js](https://github.com/nodejs/Release/blob/main/schedule.json), сумісність Vite — за [його документацією](https://vite.dev/guide/) і метаданими npm.

`docker`, `kubectl`, `psql`, `traefik` не знайдені в PATH. PostgreSQL і Kubernetes не запускалися; вони не потрібні для блоку 1. Глобальні інструменти не оновлювалися.

**3. Створено.** Один npm-проєкт: TypeScript strict, Express, HTML/CSS/TypeScript, Vite; без UI-фреймворків. `GET /api/health` повертає `status: "ok"` та стабільний протягом запуску UUID `instanceId`, з `Cache-Control: no-store`. Невідомий API дає JSON 404; є базова обробка помилок, валідація порту та завершення HTTP через SIGINT/SIGTERM з межею 5 секунд.

Українська сторінка «Планувальник маршруту кур'єра» виконує справжній `fetch('/api/health')`, перевіряє відповідь і має повідомлення про недоступність та таймаут запиту 5 секунд. У dev працює проксі Vite, у зібраному режимі Express віддає клієнт та API з одного походження. Backend — ESM/NodeNext із `.js`-імпортами; static-шлях обчислюється від модуля. Майбутні worker-файли розміщуватимуться в `src/server` і збиратимуться в `dist/server`.

Створено план 10 блоків із 23 рядками матриці вимог; усі продуктові вимоги позначені «Не реалізовано». Зафіксовано спільний стан у PostgreSQL, атомарне призначення задач, один worker на сервер, мінімум два серверні екземпляри, справжній прогрес/скасування/таймаут, Traefik/HTTPS, HPA 2–4 та реальні адмінметрики. Постійні Git-правила записані в AGENTS і плані.

Робоча папка спочатку була порожня. Файл завдання в її корені був відсутній, тому використано раніше наданий `/Users/a860/Documents/Downloads/ChromeDow/CourierRoute_Block_01_Codex.txt`; незмінену копію збережено в корені. `docs/assignment.txt` витягнуто побайтово між маркерами, без маркерів, зі збереженням CRLF і пробілів. SHA-256: `e2f79e841593c37c3b4968e05c70b697577d3991cc8ac688143311719f0959bb`.

**4. Основні файли.**

```text
Site/
├── AGENTS.md, PROJECT_PLAN.md, README.md
├── CourierRoute_Block_01_Codex.txt
├── docs/
│   ├── assignment.txt
│   └── block-01-report.md
├── src/
│   ├── server/index.ts
│   ├── client/index.html, main.ts, styles.css
│   └── shared/health.ts
├── scripts/clean.mjs
├── package.json, package-lock.json
├── tsconfig.json, tsconfig.{server,client,tools}.json
├── vite.config.ts
└── .gitignore, .gitattributes, .env.example, .nvmrc
```

`node_modules` і `dist` створені локально та виключені з Git. Локальні `.env` і логи також ігноруються; безпечний `.env.example` та lock-файл відстежуються.

**5. Команди запуску.** Із `/Users/a860/Documents/Site`, з Node 24.x, npm 11.x і вільними портами:

```sh
npm install
npm run dev
```

Dev: http://127.0.0.1:5173/; Express: http://127.0.0.1:3000/api/health.

```sh
npm run typecheck
npm run build
npm start
```

Зібраний застосунок: http://127.0.0.1:3000/. `.env` необов'язковий; `cp .env.example .env` створює конфігурацію з єдиним `PORT=3000`. Обидва dev-процеси читають цей порт; Vite залишається на 5173. Сервери слухають `127.0.0.1`. `Ctrl+C` завершує процеси.

**6. Фактичні перевірки.**

| Перевірка | Результат |
| --- | --- |
| Встановлення залежностей і кореневий `npm install` | Успішно, exit 0; останній запуск перевірив 118 пакетів і повідомив 0 vulnerabilities |
| `npm run typecheck` | Успішно, exit 0; сервер, клієнт, shared і конфігурація Vite |
| `npm run build` | Успішно, exit 0; backend JS, клієнт HTML, CSS і JS |
| `npm start`, `GET /api/health` | 200 JSON; `status=ok`, UUID; повторний запит має той самий `instanceId` |
| Production `GET /` | 200 HTML; українські title і `lang=uk` |
| Обидва зібрані CSS/JS-ресурси | 200; правильні MIME-типи й непорожній вміст |
| `/api/not-found`, `/api`, `/missing-page` | 404 JSON із повідомленням про помилку |
| Другий процес на порту 3001 | Інший `instanceId`; HTML доступний навіть із робочої папки `/private/tmp` |
| SIGTERM другого процесу | Коректне завершення, exit 0; SIGINT основного сервера — exit 0 |
| Некоректний `PORT=invalid` | Відмова з повідомленням, exit 1 |
| `npm run dev` | Vite і Express успішно стартують; сторінка, `/main.ts`, `/styles.css` — 200 |
| Dev `/api/health`, `/api/not-found` | Реальний проксі: 200 JSON з тим самим UUID, що й прямий Express; невідомий API — 404 JSON |
| Зупинка dev | Ctrl+C завершує обидва процеси; Express закриває HTTP |
| Lock-файл, оригінал, Git | Manifest і lock узгоджені; усі resolved URL з npm registry; assignment побайтово тотожний; `.env.example` не ігнорується |

Зібрані ресурси: `index-CKNBYwZ-.js` (1,48 kB) і `index-CXcmlcyd.css` (1,83 kB); HTML — 2,13 kB. Після перевірок тимчасові сервери зупинено; слухачів на 3000, 3001 і 5173 не залишено.

Початкові обмеження sandbox (`git init`: EPERM, npm registry: ENOTFOUND, запуск сервера: EPERM) усунено повторенням із потрібними дозволами інструмента. Встановлення мало попередження npm про невизначену політику install scripts для `esbuild` і `fsevents`; це не заблокувало перевірені команди. Помилок коду під час typecheck/build/HTTP не виявлено.

**Не перевірено:** візуальне відображення, виконання клієнтського JavaScript і повідомлення про недоступність саме в браузері. Browser повернув `No browser is available`, список підключень — `[]`. HTTP-перевірки не є візуальними. Інших заблокованих перевірок блоку 1 немає.

**7. Нові прямі залежності.** `express@5.3.0` — HTTP і static; `typescript@7.0.2` — типи й компіляція; `vite@8.3.5` — клієнт і dev-проксі; `tsx@4.23.15` — запуск TS у dev; `concurrently@10.0.6` — спільне керування dev-процесами; `@types/express@5.0.6` і `@types/node@24.19.2` — типи. Усі прямі версії точні; транзитивні зафіксовані lock-файлом.

**8. Наступні функції.** PostgreSQL/pg, користувачі, сесії, авторизація, алгоритм, worker threads, ліміти задач, прогрес, скасування, історія, черга й оцінка очікування, форма та схема маршруту, Docker/Kubernetes, балансування, HTTPS, HPA/Metrics Server і адмінпанель не реалізовані. Фальшивих задач, маршрутів чи прогресу немає.

**9. Git.** Корінь — `/Users/a860/Documents/Site`, гілка — `main`. Використано наявну справжню ідентичність без зміни глобальних налаштувань. Remote і push не налаштовано. Перед комітами переглянуто status, звичайний і staged diff, виконано доречні перевірки.

Коміти, відомі до коміту цього звіту:

- `bb26a3a docs: define project requirements and implementation plan`
- `e7c3246 feat: add verified Express and Vite application scaffold`

Звіт і фінальний статус плану входять в окремий `docs`-коміт; його остаточний хеш наведено в чаті. Фінальний `git status --short` — порожній, робоче дерево чисте; результат перевіряється після цього коміту й також наводиться в чаті. Сторонніх змін не було.

**10. Ручні дії.** Для завершення доступної частини блоку 1 не потрібні. Візуальне приймання потребує підключеного браузера або ручного відкриття локальної сторінки після запуску. Подальша робота зупинена перед блоком 2 до перевірки керівником і нового завдання.
