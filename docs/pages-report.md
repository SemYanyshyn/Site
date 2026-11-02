# Підготовка Pages і публічне demo Courier Route

**02.11.2026.** Проєкт `/Users/a860/Documents/Site`; початковий HEAD `c24d48b`, `main` синхронізовано з origin, незакомічених користувацьких змін не було. Фактичний remote `https://github.com/SemYanyshyn/Site.git`, public, default branch main; GitHub підтвердив права доступу. На початку Pages не існувало (`has_pages=false`, API Pages404), публічного backend/домену не було, локальне demo було ready.

Користувач окремо підтвердив відсутність зовнішнього backend і обрав **тимчасове demo з MacBook через HTTPS-тунель**. Це розширення початкової підготовки Pages, а не заміна backend макетом. Жодних платних ресурсів або доменів не створено.

## Фактичний результат

- Публічне **справжнє demo** запущене: frontend та API на одному origin Cloudflare Quick Tunnel → проєктний TLS → Traefik → два наявні app pod → спільний PostgreSQL. Поточну адресу повертає `npm run demo:public:status`; вона не зашита в source або README, бо змінюється після нового тунелю. Фактичне посилання наведено у фінальному чаті.
- Локальний `https://localhost:8443/` лишився доступним зі звичайною CA/hostname-перевіркою. HPA current2/min2/max4, Traefik1/1, PostgreSQL1/1, Metrics API Available. Використано штатний deploy/image/migrations зі збереженням PVC та даних; app image `courier-route:block07-355a3a8499081544`.
- **GitHub Pages не опубліковано.** Підготовлено Vite mode pages, API transport, офіційний guarded workflow й інструкцію. Очікувана стандартна адреса — `https://semyanyshyn.github.io/Site/`; це не чинне посилання на застосунок.
- Pages і trycloudflare є різними sites; credentialed CORS/None самі не обходять third-party-cookie blocking. Поточний обраний шлях віддає весь застосунок з одного origin та залишає Secure/HttpOnly/Lax. Для окремого надійного Pages потрібна підтверджена same-site схема або інше окремо перевірене рішення.

## Зміни

1. `vite.config.ts`, `build:pages`: `/Site/` для репозиторію й `/` для root/custom domain, тільки `dist/client`; звичайна повна збірка лишається з base `/`. Неправильні шляхи/API конфігурація відхиляються без віддзеркалення секретів.
2. `api-endpoint.ts` і `shared/public-api.ts`: один HTTPS API transport для auth/jobs/limits/history/detail/cancel/admin/health; локальний режим відносний, зовнішній — include credentials. Наявні abort/deadline/error/generation механізми збережені.
3. `http/cors.ts`, session config: точні origins, OPTIONS без auth/DB/мутацій, без wildcard, збережені JSON/Origin guard, RBAC, host-only HttpOnly cookie. Default Lax незмінний; None вимагає Secure.
4. `.github/workflows/pages.yml`: Node24/npm11.16.0, npm ci/typecheck/client+Pages checks, клієнтський build/asset audit; окремі permissions, concurrency, manual run, environment github-pages. Upload тільки dist/client; preflight справжнього backend і explicit readiness flag перед публікацією. Всі п'ять actions звірені з офіційними releases й pinned SHA.
5. `public-demo.mjs`/`public-origins.mjs`: start/status/stop власного тунелю, перевірка PID/часу/команди перед kill, точний додатковий HTTPS origin разом із localhost, приватний локальний state/logs. TLS не вимкнений; default config виключає випадкове використання account tunnel credentials. Stop не видаляє локальні ресурси.
6. Змістовні нові API/CORS/cookie/config/deployment safety тести й один справжній PostgreSQL cross-origin session сценарій; старі tests не прибирали й не послаблювали. Інструкції й поточний план актуалізовані.

Технічний коміт: `01074be` — `feat(deploy): prepare Pages and add a secure public demo`. Фінальний docs-коміт/стан push наведено в чаті без циклу зміни документа заради власного SHA.

## Виконані перевірки

Середовище: macOS arm64; **Node24.18.0/npm11.16.0**, наявний PostgreSQL18.4. cloudflared2026.10.7 встановлено тільки в ignored `.local/tools`, digest офіційного release звірено перед extraction. Системний Node26 не використано для build/test/deploy. Залежності відтворені npm ci, без оновлення lock або версій проєкту.

| Перевірка | Фактичний результат |
| --- | --- |
| npm ci | PASS |
| npm run typecheck | PASS |
| npm run build | PASS; фінально відновлена звичайна повна збірка з root assets |
| npm test | **270 passed, 0 failed/cancelled/skipped** |
| Розкладка suites | unit51, route45, auth14, jobs27, client66, queue26, admin26, pages/public15 |
| PostgreSQL | **61 справжній PG сценарій**, решта209 non-DB; тільки явно перевірена test DB/власні ізольовані schemas |
| Новий PG session сценарій | реєстрація → login → session через другий незалежний процес → user403 для admin → logout → перший процес401; Secure/HttpOnly/None та точний CORS перевірені як HTTP headers |
| Pages /Site/ | actual build, 3 клієнтські файли; статична HTTP сторінка й обидва JS/CSS resources200 з правильними MIME/шляхами |
| Pages root/custom domain | actual build + asset audit з base /, PASS |
| Секрети | серверний DATABASE_URL sentinel не потрапив у Pages JS; personal DB URL/password не потрапили у staged diff; .env/.local/dist/node_modules не staged |
| Workflow | YAML parse, **actionlint1.7.12 PASS**; фактичний GitHub Actions run ще не виконувався |
| Public frontend | HTML200, hashed JS200 й SCSS-generated CSS200; без localhost у public JS, без /Site/ assets у normal demo |
| Public API | ready200, 8 health readings від **двох різних реальних UUID**, збіг JSON UUID/X-Instance-Id |
| Public guards | anonymous auth/me/jobs/admin401; точні OPTIONS204, validation400, foreign Origin403; /.env і server source404 |
| Local demo | CA-verified https://localhost:8443/api/ready200, app2/2 ready, HPA2–4 збережено |
| Повторний demo:start | той самий URL/процес і ready; нового тунелю/deploy не створено |
| Protected source | 27 UI/SCSS/algorithm/migration/runtime files побайтово збігаються з початковим HEAD; lock/Dockerfile/Ingress/production config незмінні |
| Git | diff --check і вибірковий staged audit PASS; попередні користувацькі зміни не відкидалися |

Public HTTP audit **не виконував login/CRUD/змін ролі у робочій БД**. Початкові users/sessions/jobs/schema_migrations порівняно за повними row digests до/після; усі збіглися. Збережено **1 користувача, 2 сесії, 128 задач й 4 міграції**, усі збережені jobs/results всередині незмінних рядків. `.env`, CA, leaf certificate і private key побайтово незмінні. PostgreSQL pod UID і PVC UID ті самі. Тестові auth/jobs/role mutations виконувалися тільки у власних test schemas.

Приватні фактичні logs/summaries: `.local/pages-verification/npm-test-final.log`, `public-http.json`, `pages-artifact.json`, `before-public-demo.json`, `.local/public-demo/deployment.log`. Вони не входять у Git/Pages. У першому readonly resource audit був неправильний синтаксис kubectl get для різних kinds; виправлено на окремі PVC/Pod запити й увесь public audit успішно повторено. Це була помилка перевірочного wrapper, а не зміна ресурсів.

## Межі й поточні процеси

- **Public browser acceptance не виконано.** Browser runtime повернув `No browser is available`, discovery — порожній список. Desktop/360px, console/mixed-content, вхід/reload/вихід/задачі/cancel/admin через зовнішній браузер не заявляються пройденими. HTTP/PG тести не видаються за browser/visual перевірку. Інтерфейс/SCSS збережено; історичні приймання не перераховувалися як нові.
- Застосовано [Browser SKILL](/Users/a860/.codex/plugins/cache/openai-bundled/browser/26.818.41705/skills/control-in-app-browser/SKILL.md). Його правило: “If the requested backend remains unavailable, report that plainly instead of controlling it through an unrelated browser tool or source-code workaround.” Недоступний browser не замінювали обхідною автоматизацією. Для продовження UI-приймання потрібен підключений підтримуваний браузер або ручна перевірка за інструкцією.
- Повторний HPA stress/fault/container/старі Chrome suites не запускалися: алгоритм/квоти/ролі/маніфести не змінені. Поточний normal image реально зібрано й розгорнуто штатним шляхом; Kubernetes/handlers перевірені. Це не нове повне приймання всіх вимог 1–8.
- Тунель **залишено працювати за прямим вибором користувача**. Локальний Kubernetes/Colima і host PostgreSQL теж працюють. Тимчасові тестові HTTP/PG schemas і static server прибрані suites/runner.
- `npm run demo:public:stop` зупиняє тільки тунель; `npm run deploy:stop` штатно зупиняє власний Kubernetes demo зі збереженням PVC; `npm run db:stop` — окремий host PostgreSQL. Для статусу: `demo:public:status`, `deploy:status`, `db:status`. Node24 PATH наведено в інструкції.
- [Повна інструкція](github-pages.md) пояснює реальне поточне посилання, майбутній Pages, same-site домени та умови автономного хостингу. Адреса тимчасова, доступність залежить від MacBook/мережі/процесу; постійний сервер ще не розгорнуто.
