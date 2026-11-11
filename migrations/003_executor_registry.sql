CREATE TABLE executor_registry (
  instance_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepting_claims boolean NOT NULL,
  busy boolean NOT NULL,
  current_job_id uuid,
  CONSTRAINT executor_registry_clock CHECK (last_seen_at >= started_at AND expires_at > last_seen_at),
  CONSTRAINT executor_registry_job CHECK (current_job_id IS NULL OR busy)
);

CREATE INDEX executor_registry_fresh_idx ON executor_registry(expires_at) WHERE accepting_claims;
CREATE INDEX jobs_running_instance_idx ON jobs(instance_id) WHERE status = 'running';
CREATE INDEX jobs_duration_samples_idx ON jobs(finished_at DESC, id DESC)
  WHERE status = 'completed' AND (result ->> 'terminationReason') = 'budget_exhausted' AND completed_iterations > 0;
