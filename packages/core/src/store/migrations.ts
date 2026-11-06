export const MIGRATIONS: readonly { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE sessions (
  id text PRIMARY KEY,
  runtime_id text NOT NULL,
  workspace text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  read_only boolean NOT NULL,
  created_at text NOT NULL,
  capabilities jsonb NOT NULL,
  active_run_id text,
  native_session_ref text,
  last_sequence integer NOT NULL DEFAULT 0,
  pruned_through integer NOT NULL DEFAULT 0
);
CREATE TABLE runs (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  prompt text NOT NULL,
  state text NOT NULL,
  created_at text NOT NULL,
  started_at text,
  ended_at text,
  error jsonb
);
CREATE INDEX runs_session_idx ON runs (session_id);
CREATE INDEX runs_state_idx ON runs (state);
CREATE TABLE events (
  session_id text NOT NULL,
  sequence integer NOT NULL,
  run_id text,
  type text NOT NULL,
  payload jsonb NOT NULL,
  extensions jsonb,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT events_session_sequence_uq UNIQUE (session_id, sequence)
);
CREATE INDEX events_occurred_idx ON events (occurred_at);
CREATE TABLE approvals (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  run_id text NOT NULL,
  tool_id text,
  runtime_id text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  description text,
  target jsonb NOT NULL,
  allowed_scopes jsonb NOT NULL,
  available_decisions jsonb NOT NULL,
  state text NOT NULL,
  decision text,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  version integer NOT NULL
);
CREATE INDEX approvals_session_idx ON approvals (session_id);
CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN settings jsonb NOT NULL DEFAULT '{"permissionMode":"default"}';
CREATE TABLE attachments (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  kind text NOT NULL,
  sha256 text NOT NULL,
  abs_path text NOT NULL,
  created_at text NOT NULL,
  referenced_by_run text
);
CREATE INDEX attachments_session_idx ON attachments (session_id);
CREATE INDEX attachments_run_idx ON attachments (referenced_by_run);
`,
  },
];
