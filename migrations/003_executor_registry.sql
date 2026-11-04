-- Створюю реєстр серверних процесів, які можуть брати задачі зі спільної черги.
CREATE TABLE executor_registry (
  -- Кожен запущений процес має власний UUID; це ідентифікатор саме процесу.
  instance_id uuid PRIMARY KEY,
  -- Зберігаю час запуску, останнього сигналу життя й закінчення чинності запису.
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Позначаю, чи процес готовий брати нові задачі.
  accepting_claims boolean NOT NULL,
  -- Зберігаю зайнятість одного обчислювального слота та ідентифікатор поточної задачі.
  busy boolean NOT NULL,
  current_job_id uuid,
  -- Перевіряю послідовність дат і не дозволяю поточну задачу в незайнятого процесу.
  CONSTRAINT executor_registry_clock CHECK (last_seen_at >= started_at AND expires_at > last_seen_at),
  CONSTRAINT executor_registry_job CHECK (current_job_id IS NULL OR busy)
);

-- Швидше знаходжу свіжі процеси, які приймають задачі.
CREATE INDEX executor_registry_fresh_idx ON executor_registry(expires_at) WHERE accepting_claims;
-- Швидше знаходжу активні задачі конкретного процесу.
CREATE INDEX jobs_running_instance_idx ON jobs(instance_id) WHERE status = 'running';
-- Вибираю історію успішних задач із вичерпаним бюджетом ітерацій для оцінки очікування в черзі.
CREATE INDEX jobs_duration_samples_idx ON jobs(finished_at DESC, id DESC)
  WHERE status = 'completed' AND (result ->> 'terminationReason') = 'budget_exhausted' AND completed_iterations > 0;
