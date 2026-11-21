BEGIN;
CREATE TABLE IF NOT EXISTS votes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voter_hash text NOT NULL UNIQUE,
  game text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  google_synced_at timestamptz
);
CREATE INDEX IF NOT EXISTS votes_pending ON votes(id) WHERE google_synced_at IS NULL;
CREATE TABLE IF NOT EXISTS voter_sessions (
  token_hash text PRIMARY KEY, voter_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS voter_sessions_expiry ON voter_sessions(expires_at);
CREATE TABLE IF NOT EXISTS request_limits (
  ip_hash text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS request_limits_expiry ON request_limits(expires_at);
CREATE TABLE IF NOT EXISTS sheets_sync (
  id integer PRIMARY KEY CHECK (id = 1),
  owner text, available_at timestamptz NOT NULL DEFAULT '-infinity',
  last_error text, last_success timestamptz
);
INSERT INTO sheets_sync(id) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
