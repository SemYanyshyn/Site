# Як я орієнтуюся в Kubernetes-маніфестах

Маніфест описує бажаний стан ресурсу, а Kubernetes намагається привести реальний стан до цього опису

## Моя мапа файлів

| Файл | За що відповідає |
| --- | --- |
| [namespace.json](namespace.json) | Групую ресурси Courier Route в одному просторі імен |
| [config.json](config.json) | Передаю несекретні налаштування через ConfigMap |
| [postgres.json](postgres.json) | Запускаю PostgreSQL як StatefulSet зі Service та PVC для даних |
| [migrate.json](migrate.json) | Одноразово застосовую міграції перед оновленням застосунку |
| [app.json](app.json) | Запускаю копії backend із frontend і даю їм внутрішній Service |
| [traefik.json](traefik.json) | Приймаю зовнішній трафік через NodePort, запускаю Traefik та його права читання |
| [ingress.json](ingress.json) | Пов’язую hostname, TLS і шлях із сервісом застосунку |
| [metrics-server.json](metrics-server.json) | Реєструю джерело CPU/RAM у Metrics API зі своїми правами та namespace |
| [hpa.json](hpa.json) | Масштабую app від 2 до 4 копій із ціллю CPU 70% від requests |
| [monitor-rbac.json](monitor-rbac.json) | Дозволяю застосунку читати потрібні дані адмінпанелі без прав зміни й читання Secret |

## Що собі запам’ятовую

- `metadata` задає назву, namespace та мітки, `spec` описує бажаний стан
- `status` повертає сам Kubernetes, у вихідному шаблоні не вигадую готовий стан
- `selector` вибирає pod за мітками, а не за випадковим порядком їх створення
- Deployment керує копіями застосунку, StatefulSet дає стабільну ідентичність PostgreSQL
- Kubernetes Job для міграцій не є користувацькою задачею пошуку маршруту
- Service дає сталу адресу, Ingress описує правила, Traefik фактично приймає й передає запити
- startupProbe контролює запуск, livenessProbe може спричинити перезапуск, readinessProbe визначає готовність приймати трафік
- `requests` описує запит ресурсів для планування, `limits` — межі споживання контейнера
- `250m` CPU означає чверть ядра, `128Mi` — 128 мебібайтів пам’яті
- ConfigMap містить несекретні параметри, Secret для паролів і TLS helper створює окремо без збереження значень у Git
- PVC зберігає дані PostgreSQL поза життєвим циклом pod, видалення pod не рівнозначне видаленню PVC
- ServiceAccount і RBAC визначають права pod у Kubernetes, це не ролі user/admin у вебзастосунку

Детальні пояснення блоків знаходжу в `_comment`-полях, вони видаляються helper перед застосуванням конфігурацій
