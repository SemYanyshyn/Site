-- Доповнюю наявний реєстр процесів відомостями про pod Kubernetes.
ALTER TABLE executor_registry
  -- Зберігаю UUID pod, його назву та простір імен; для роботи поза Kubernetes ці поля можуть бути порожніми.
  ADD COLUMN pod_uid uuid,
  ADD COLUMN pod_name text,
  ADD COLUMN pod_namespace text,
  -- Дозволяю або всі три порожні поля, або всі три заповнені з правильним форматом назв.
  ADD CONSTRAINT executor_registry_pod_metadata CHECK (
    (pod_uid IS NULL AND pod_name IS NULL AND pod_namespace IS NULL)
    OR (
      pod_uid IS NOT NULL AND pod_name IS NOT NULL AND pod_namespace IS NOT NULL
      AND length(pod_name) BETWEEN 1 AND 253
      AND pod_name ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
      AND length(pod_namespace) BETWEEN 1 AND 63
      AND pod_namespace ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    )
  );

-- Прискорюю пошук процесів за конкретним pod і часом останнього сигналу життя.
CREATE INDEX executor_registry_pod_idx ON executor_registry(pod_uid, last_seen_at DESC)
  WHERE pod_uid IS NOT NULL;
-- Допомагаю адмінпанелі знаходити останній процес усередині pod після перезапуску.
CREATE INDEX executor_registry_latest_process_idx
  ON executor_registry(pod_namespace, pod_uid, started_at DESC, instance_id DESC)
  WHERE pod_uid IS NOT NULL;
