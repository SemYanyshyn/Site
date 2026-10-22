CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  progress_stage text NOT NULL DEFAULT 'preparing',
  completed_iterations bigint NOT NULL DEFAULT 0,
  total_iterations bigint NOT NULL,
  progress_percent double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  cancel_requested_at timestamptz,
  instance_id uuid,
  claim_token uuid,
  timeout_ms integer,
  lost_after timestamptz,
  result jsonb,
  failure_reason text,
  failure_message text,
  CONSTRAINT jobs_status CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  CONSTRAINT jobs_stage CHECK (progress_stage IN ('preparing', 'searching', 'finishing')),
  CONSTRAINT jobs_input CHECK (
    jsonb_typeof(input) = 'object'
    AND input ?& ARRAY['warehouse', 'points', 'seed', 'iterations']
    AND jsonb_typeof(input -> 'warehouse') = 'object'
    AND jsonb_typeof(input -> 'points') = 'array'
    AND jsonb_typeof(input -> 'seed') = 'number'
    AND jsonb_typeof(input -> 'iterations') = 'number'
    AND (input ->> 'iterations')::bigint = total_iterations
    AND (input ->> 'seed')::numeric BETWEEN 0 AND 4294967295
    AND (input ->> 'seed')::numeric = trunc((input ->> 'seed')::numeric)
  ),
  CONSTRAINT jobs_iterations CHECK (
    total_iterations BETWEEN 1 AND 200000000
    AND completed_iterations BETWEEN 0 AND total_iterations
  ),
  CONSTRAINT jobs_progress CHECK (
    progress_percent >= 0 AND progress_percent <= 100
    AND (progress_stage <> 'preparing' OR (completed_iterations = 0 AND progress_percent = 0))
    AND (status <> 'queued' OR (progress_stage = 'preparing' AND completed_iterations = 0 AND progress_percent = 0))
    AND (status <> 'completed' OR (progress_stage = 'finishing' AND progress_percent = 100))
    AND (status = 'completed' OR progress_percent < 100)
  ),
  CONSTRAINT jobs_result CHECK (
    (status = 'completed' AND result IS NOT NULL AND jsonb_typeof(result) = 'object')
    OR (status <> 'completed' AND result IS NULL)
  ),
  CONSTRAINT jobs_failure CHECK (
    (status = 'failed' AND failure_reason IS NOT NULL AND failure_message IS NOT NULL
      AND failure_reason IN ('timeout', 'worker_error', 'server_shutdown', 'database_unavailable', 'invalid_input', 'worker_lost')
      AND length(failure_message) BETWEEN 1 AND 500)
    OR (status <> 'failed' AND failure_reason IS NULL AND failure_message IS NULL)
  ),
  CONSTRAINT jobs_finished CHECK (
    (status IN ('completed', 'cancelled', 'failed')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT jobs_claim CHECK (
    (started_at IS NULL AND instance_id IS NULL AND claim_token IS NULL AND timeout_ms IS NULL AND lost_after IS NULL
      AND status IN ('queued', 'cancelled'))
    OR (started_at IS NOT NULL AND instance_id IS NOT NULL AND claim_token IS NOT NULL
      AND timeout_ms IS NOT NULL AND timeout_ms BETWEEN 1 AND 120000
      AND lost_after IS NOT NULL AND lost_after > started_at AND status <> 'queued')
  ),
  CONSTRAINT jobs_cancel CHECK (status <> 'queued' OR cancel_requested_at IS NULL)
);

CREATE INDEX jobs_queued_idx ON jobs(created_at, id) WHERE status = 'queued';
CREATE INDEX jobs_user_history_idx ON jobs(user_id, created_at DESC, id DESC);
CREATE INDEX jobs_user_active_idx ON jobs(user_id, created_at DESC, id DESC) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_lost_idx ON jobs(lost_after) WHERE status = 'running';
