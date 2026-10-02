CREATE TABLE IF NOT EXISTS players (
  mode text NOT NULL, id text NOT NULL, name text NOT NULL, avatar text, profile_url text NOT NULL,
  summary_at timestamptz, PRIMARY KEY(mode,id)
);
CREATE TABLE IF NOT EXISTS friend_lists (
  mode text NOT NULL, owner_id text NOT NULL, fetched_at timestamptz,
  attempted_at timestamptz, status text NOT NULL DEFAULT 'unknown', friend_count integer,
  PRIMARY KEY(mode,owner_id)
);
CREATE TABLE IF NOT EXISTS friend_observations (
  mode text NOT NULL, owner_id text NOT NULL, friend_id text NOT NULL,
  PRIMARY KEY(mode,owner_id,friend_id)
);
CREATE TABLE IF NOT EXISTS friendship_edges (
  mode text NOT NULL, source text NOT NULL, target text NOT NULL,
  PRIMARY KEY(mode,source,target), CHECK(source < target)
);
CREATE TABLE IF NOT EXISTS crawl_runs (
  id uuid PRIMARY KEY, root_id text NOT NULL, mode text NOT NULL,
  depth integer NOT NULL, max_nodes integer NOT NULL, max_requests integer NOT NULL,
  status text NOT NULL DEFAULT 'queued', request_count integer NOT NULL DEFAULT 0,
  cache_hits integer NOT NULL DEFAULT 0, refresh boolean NOT NULL DEFAULT false,
  message text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS run_nodes (
  run_id uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE, player_id text NOT NULL,
  depth integer NOT NULL, expanded boolean NOT NULL DEFAULT false,
  observed boolean NOT NULL DEFAULT false, hydrated boolean NOT NULL DEFAULT false,
  PRIMARY KEY(run_id,player_id)
);
CREATE TABLE IF NOT EXISTS run_edges (
  run_id uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE, source text NOT NULL, target text NOT NULL,
  PRIMARY KEY(run_id,source,target)
);
CREATE TABLE IF NOT EXISTS request_budgets (
  mode text PRIMARY KEY, day date NOT NULL DEFAULT CURRENT_DATE, requests integer NOT NULL DEFAULT 0,
  last_call timestamptz NOT NULL DEFAULT '1970-01-01'
);
CREATE INDEX IF NOT EXISTS observations_friend ON friend_observations(mode,friend_id);
CREATE INDEX IF NOT EXISTS runs_history ON crawl_runs(mode,created_at DESC);
CREATE INDEX IF NOT EXISTS run_frontier ON run_nodes(run_id,expanded,depth);
ALTER TABLE run_nodes ADD COLUMN IF NOT EXISTS fetch_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE run_nodes ADD COLUMN IF NOT EXISTS fetched_at timestamptz;
ALTER TABLE run_nodes ADD COLUMN IF NOT EXISTS friend_count integer;
CREATE TABLE IF NOT EXISTS run_friend_observations (
  run_id uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  owner_id text NOT NULL, friend_id text NOT NULL,
  PRIMARY KEY(run_id,owner_id,friend_id)
);
-- Upgrade checkpoints produced before per-run evidence was added. Subsequent
-- migrations do not change a run's snapshots, including successful empty lists.
INSERT INTO run_friend_observations(run_id,owner_id,friend_id)
SELECT n.run_id,n.player_id,o.friend_id FROM run_nodes n JOIN crawl_runs r ON r.id=n.run_id
JOIN friend_observations o ON o.mode=r.mode AND o.owner_id=n.player_id
WHERE n.observed AND n.fetch_status='unknown' ON CONFLICT DO NOTHING;
UPDATE run_nodes n SET fetch_status=f.status,fetched_at=f.fetched_at,friend_count=f.friend_count
FROM crawl_runs r,friend_lists f WHERE r.id=n.run_id AND f.mode=r.mode AND f.owner_id=n.player_id
AND n.observed AND n.fetch_status='unknown';
CREATE TABLE IF NOT EXISTS vanity_resolutions (
  mode text NOT NULL, vanity text NOT NULL, player_id text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mode,vanity)
);
CREATE TABLE IF NOT EXISTS game_profiles (
  mode text NOT NULL, player_id text NOT NULL, status text NOT NULL DEFAULT 'unknown',
  scope text NOT NULL DEFAULT 'profile_recent', games jsonb NOT NULL DEFAULT '[]',
  fetched_at timestamptz, attempted_at timestamptz, message text,
  PRIMARY KEY(mode,player_id)
);
CREATE TABLE IF NOT EXISTS game_score_jobs (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  mode text NOT NULL, root_id text NOT NULL, status text NOT NULL DEFAULT 'queued',
  refresh boolean NOT NULL DEFAULT false, max_requests integer NOT NULL,
  request_count integer NOT NULL DEFAULT 0, cache_hits integer NOT NULL DEFAULT 0,
  message text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS game_score_players (
  job_id uuid NOT NULL REFERENCES game_score_jobs(id) ON DELETE CASCADE,
  player_id text NOT NULL, is_root boolean NOT NULL DEFAULT false,
  name text NOT NULL, avatar text, profile_url text NOT NULL,
  processed boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'unknown',
  scope text NOT NULL DEFAULT 'profile_recent', games jsonb NOT NULL DEFAULT '[]',
  fetched_at timestamptz, attempted_at timestamptz, message text,
  PRIMARY KEY(job_id,player_id)
);
CREATE INDEX IF NOT EXISTS game_job_history ON game_score_jobs(mode,run_id,created_at DESC);
CREATE INDEX IF NOT EXISTS game_job_pending ON game_score_players(job_id,processed,is_root);
ALTER TABLE game_profiles ADD COLUMN IF NOT EXISTS profile jsonb;
ALTER TABLE game_score_players ADD COLUMN IF NOT EXISTS profile jsonb;
CREATE TABLE IF NOT EXISTS player_details (
  mode text NOT NULL, player_id text NOT NULL, profile jsonb,
  profile_status text NOT NULL DEFAULT 'unknown', profile_fetched_at timestamptz,
  profile_attempted_at timestamptz, profile_message text,
  aliases jsonb NOT NULL DEFAULT '[]', aliases_status text NOT NULL DEFAULT 'unknown',
  aliases_fetched_at timestamptz, aliases_attempted_at timestamptz, aliases_message text,
  PRIMARY KEY(mode,player_id)
);
CREATE TABLE IF NOT EXISTS group_profiles (
  mode text NOT NULL, player_id text NOT NULL, status text NOT NULL DEFAULT 'unknown',
  groups jsonb NOT NULL DEFAULT '[]', total_count integer, complete boolean NOT NULL DEFAULT false,
  fetched_at timestamptz, attempted_at timestamptz, message text,
  PRIMARY KEY(mode,player_id)
);
CREATE TABLE IF NOT EXISTS group_collection_jobs (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  mode text NOT NULL, root_id text NOT NULL, status text NOT NULL DEFAULT 'queued',
  refresh boolean NOT NULL DEFAULT false, max_requests integer NOT NULL,
  request_count integer NOT NULL DEFAULT 0, cache_hits integer NOT NULL DEFAULT 0,
  message text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS group_collection_players (
  job_id uuid NOT NULL REFERENCES group_collection_jobs(id) ON DELETE CASCADE,
  player_id text NOT NULL, is_root boolean NOT NULL DEFAULT false, depth integer NOT NULL,
  processed boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'unknown',
  groups jsonb NOT NULL DEFAULT '[]', total_count integer, complete boolean NOT NULL DEFAULT false,
  fetched_at timestamptz, attempted_at timestamptz, message text,
  PRIMARY KEY(job_id,player_id)
);
CREATE INDEX IF NOT EXISTS group_job_history ON group_collection_jobs(mode,run_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS group_job_active ON group_collection_jobs(mode,run_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS group_job_pending ON group_collection_players(job_id,is_root DESC,depth,player_id) WHERE NOT processed;
