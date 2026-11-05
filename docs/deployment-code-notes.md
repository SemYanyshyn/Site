# Мої пояснення Docker і Kubernetes

05.11.2026 — доповнив українські коментарі від першої особи без кінцевих крапок у Dockerfile, .dockerignore, шести deployment helper та дванадцяти JSON-шаблонах deploy

## Що пояснив

Розділив Colima, Docker, kind, kubectl, pod і фізичний MacBook, пояснив побудову образу, власний kubeconfig, ownerId, дедлайни команд, конфігурацію й Secret, локальну CA, міграції, імпорт образу у вузол, звичайну зупинку та тестовий cleanup

У маніфестах пояснив Service, Deployment, StatefulSet, Job, Ingress, HPA, Metrics Server, RBAC, probes, requests/limits і постійне сховище

Англомовні коментарі переклав, у Dockerfile виправив пошкоджений вступний коментар, у JSON використав підтримувані helper поля _comment і _comment_*

Додав [мапу розгортання](../deploy/README.md) та [мапу Kubernetes-файлів](../deploy/k8s/README.md)

## Фактичні перевірки

- Рядки коду поза коментарями й виконуваний JavaScript усіх шести helper незмінні
- Інструкції Dockerfile та правила .dockerignore без коментарів незмінні
- Усі дванадцять JSON-конфігурацій після очищення реальним deploymentConfigWithoutNotes структурно збігаються з початковими
- Кінцевих крапок у коментарях немає
- node --check для шести скриптів — PASS
- npm run typecheck — PASS
- npm run build — PASS
- npm run test:unit — 54 PASS
- git diff --check — PASS

Реальне Docker-збирання, deployment, preflight і команди керування кластером для цих пояснень не запускалися, робочі PostgreSQL/PVC, credentials і CA не змінювалися

Майбутній явний build може отримати інший fingerprint образу, бо helper хешує повні вихідні файли, включно з коментарями, поточні контейнери від цих правок не змінюються

Користувацькі зміни src/client/jobs-view.ts, src/server/route/algorithm.ts і правку src/shared/health.ts, що з’явилася під час роботи, збережено поза комітом цього завдання
