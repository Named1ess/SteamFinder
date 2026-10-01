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
