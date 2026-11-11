# Як я розумію Docker і Kubernetes у Courier Route

Тут тримаю шаблони локального розгортання, а самими командами керую через scripts/deploy-local.mjs

## Як пов’язані частини

1. Colima створює Linux-середовище на Mac і дає доступ до Docker через сокет профілю courier-route
2. Dockerfile описує, як із коду зібрати образ із готовим застосунком
3. kind запускає один вузол Kubernetes як контейнер у Docker цього профілю
4. kubectl застосовує ресурси Kubernetes із deploy/k8s через власний kubeconfig проєкту
5. PostgreSQL зберігає дані на PVC, а копії застосунку читають спільні сесії й задачі
6. Traefik приймає HTTPS і передає запити застосунку через Service
7. Metrics Server збирає показники, а HPA за ними змінює кількість копій застосунку

Кілька pod на одному kind-вузлі дають кілька процесів застосунку, але залишаються на одному MacBook

## Де шукаю потрібний код

| Файл | Що для себе шукаю |
| --- | --- |
| [Dockerfile](../Dockerfile) | Етапи збирання, залежності й запуск від користувача node |
| [.dockerignore](../.dockerignore) | Які файли дозволено передавати до Docker build |
| [kind-config.json](kind-config.json) | Вузол kind і зіставлення локальних HTTP/HTTPS-портів |
| [versions.json](versions.json) | Узгоджені версії, образи, digest і джерела |
| [k8s/README.md](k8s/README.md) | Мапу всіх Kubernetes-маніфестів |
| [deploy-local.mjs](../scripts/deploy-local.mjs) | Повний порядок перевірки, збирання й розгортання |
| [deployment-config.mjs](../scripts/deployment-config.mjs) | Видалення навчальних _comment-полів із JSON |
| [kind-config.mjs](../scripts/kind-config.mjs) | Сумісну стару назву того самого helper очищення |
| [deployment-command.mjs](../scripts/deployment-command.mjs) | Запуск зовнішніх команд, дедлайни й межі виводу |
| [deployment-autoscale.mjs](../scripts/deployment-autoscale.mjs) | Перевірку власника та передавання replicas під керування HPA |
| [deployment-status.mjs](../scripts/deployment-status.mjs) | Read-only звіт, свіжість метрик і перевірку HTTPS readiness |

## Як проходить локальний HTTPS-запит

Браузер відкриває `https://localhost:8443`, порт MacBook зіставлений із 30443 вузла kind, Service Traefik приймає його через NodePort, Ingress спрямовує шлях `/` до Service app, а далі запит потрапляє в один готовий pod застосунку на порт 3000

Локальна CA й серверний сертифікат зберігаються в `.local/deploy/tls`, TLS завершує Traefik

Порт 8443 є початковим значенням, фактично вибраний порт helper читає із власного стану кластера

Ця адреса доступна локально, публічний HTTPS-тунель запускається окремими demo-командами

## Команди, які використовую

Перед запуском переходжу в корінь `/Users/a860/Documents/Site`, профіль Colima має вже працювати

| Команда | Дія |
| --- | --- |
| `colima start --profile courier-route` | Запускаю окремий контейнерний профіль |
| `npm run deploy:preflight` | Перевіряю інструменти й доступ до Docker |
| `npm run image:build` | Збираю або повторно використовую перевірений образ |
| `npm run deploy:local` | Готую кластер за потреби й розгортаю застосунок |
| `npm run deploy:status` | Читаю ресурси, метрики й фактичну локальну readiness |
| `npm run deploy:status -- --verbose` | Переглядаю докладні ресурси й показники kubectl |
| `npm run deploy:stop` | Зупиняю app, Traefik і PostgreSQL, прибираю наш HPA, зберігаю PVC і кластер |

`deploy:local` може створювати ресурси, застосовувати міграції та оновлювати pod, тому це не просто відкриття браузера

Звичайний deploy:stop не видаляє PVC, credentials чи CA, а тестовий cleanup має інший шлях і може видаляти лише свій перевірений тестовий namespace

## Шаблони й незмінність налаштувань

JSON-шаблони не містять пояснювальних полів `_comment` та `_comment_*`; helper зберігає підтримку їх очищення для старих вхідних даних

Шаблони не передаю вручну в kubectl apply без helper, бо в них також є токени __NAMESPACE__, __OWNER_ID__ та інші значення для підстановки

Dockerfile, .dockerignore, скрипти та інші вихідні файли не містять коментарів

Очищення Dockerfile, .dockerignore або src змінює fingerprint образу при наступному явному build, бо helper хешує повні вихідні файли
