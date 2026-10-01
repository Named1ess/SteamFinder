import { randomUUID } from "node:crypto";
import type {
  CrawlRun,
  CreateRunInput,
  GraphEdge,
  GraphNode,
} from "../../../packages/shared/src/index.js";
import { pool, transaction } from "./db.js";
import { config } from "./config.js";
import type { Player } from "./provider.js";
import type pg from "pg";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const iso = (date: Date | null) => date?.toISOString() ?? null;
export async function getRun(id: string): Promise<CrawlRun> {
  const result = await pool.query(
    `SELECT r.*, COALESCE(p.name,r.root_id) root_name,
    (SELECT count(*)::int FROM run_nodes n WHERE n.run_id=r.id) node_count,
    (SELECT count(*)::int FROM run_edges e WHERE e.run_id=r.id) edge_count,
    (SELECT count(*)::int FROM run_nodes n WHERE n.run_id=r.id AND n.fetch_status='ok') fetched_count,
    (SELECT count(*)::int FROM run_nodes n WHERE n.run_id=r.id AND n.fetch_status='private') private_count,
    (SELECT count(*)::int FROM run_nodes n WHERE n.run_id=r.id AND n.fetch_status='error') error_count
    FROM crawl_runs r LEFT JOIN players p ON p.mode=r.mode AND p.id=r.root_id WHERE r.id=$1 AND r.mode=$2`,
    [id, config.mode],
  );
  const r = result.rows[0];
  if (!r) throw new HttpError(404, "找不到该查询");
  return {
    id: r.id,
    rootId: r.root_id,
    rootName: r.root_name,
    mode: r.mode,
    depth: r.depth,
    maxNodes: r.max_nodes,
    maxRequests: r.max_requests,
    status: r.status,
    nodeCount: r.node_count,
    edgeCount: r.edge_count,
    fetchedCount: r.fetched_count,
    privateCount: r.private_count,
    errorCount: r.error_count,
    requestCount: r.request_count,
    cacheHits: r.cache_hits,
    refresh: r.refresh,
    message: r.message,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    completedAt: iso(r.completed_at),
  };
}
export async function listRuns(): Promise<CrawlRun[]> {
  const { rows } = await pool.query(
    "SELECT id FROM crawl_runs WHERE mode=$1 ORDER BY created_at DESC LIMIT 100",
    [config.mode],
  );
  return Promise.all(rows.map((row) => getRun(row.id)));
}
export async function createRun(
  rootId: string,
  input: CreateRunInput,
  initialRequests = 0,
): Promise<{ run: CrawlRun; cached: boolean }> {
  if (!input.refresh) {
    const { rows } = await pool.query(
      `SELECT id FROM crawl_runs WHERE mode=$1 AND root_id=$2 AND depth=$3 AND max_nodes=$4 AND max_requests=$5 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [config.mode, rootId, input.depth, input.maxNodes, input.maxRequests],
    );
    if (rows.length) return { run: await getRun(rows[0].id), cached: true };
  }
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO players(mode,id,name,profile_url) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [
        config.mode,
        rootId,
        config.mode === "demo" ? "演示玩家 · 虚构起点" : rootId,
        `https://steamcommunity.com/profiles/${rootId}`,
      ],
    );
    await client.query(
      `INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,refresh,request_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        rootId,
        config.mode,
        input.depth,
        input.maxNodes,
        input.maxRequests,
        input.refresh ?? false,
        initialRequests,
      ],
    );
    await client.query(
      "INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0)",
      [id, rootId],
    );
  });
  return { run: await getRun(id), cached: false };
}
export async function getGraphData(
  id: string,
): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  fullyRepresented: Set<string>;
}> {
  const run = await getRun(id);
  const [nr, er] = await Promise.all([
    pool.query(
      `SELECT n.player_id id,n.depth,p.name,p.avatar,p.profile_url,n.fetch_status status,n.fetched_at,n.friend_count,NOT EXISTS(SELECT 1 FROM run_friend_observations o WHERE o.run_id=$1 AND o.owner_id=n.player_id AND NOT EXISTS(SELECT 1 FROM run_nodes other WHERE other.run_id=$1 AND other.player_id=o.friend_id)) represented FROM run_nodes n JOIN players p ON p.mode=$2 AND p.id=n.player_id WHERE n.run_id=$1 ORDER BY n.depth,n.player_id`,
      [id, run.mode],
    ),
    pool.query(
      "SELECT source,target FROM run_edges WHERE run_id=$1 ORDER BY source,target",
      [id],
    ),
  ]);
  return {
    nodes: nr.rows.map((r) => ({
      id: r.id,
      depth: r.depth,
      name: r.name,
      avatar: r.avatar,
      profileUrl: r.profile_url,
      fetchStatus: r.status ?? "unknown",
      fetchedAt: iso(r.fetched_at),
      friendCount: r.friend_count,
      degree: 0,
      community: 0,
    })),
    edges: er.rows.map((r) => ({
      id: `${r.source}:${r.target}`,
      source: r.source,
      target: r.target,
    })),
    fullyRepresented: new Set(
      nr.rows.filter((r) => r.represented).map((r) => r.id),
    ),
  };
}
export async function putPlayers(
  players: Player[],
  checkpoint?: { runId: string; ids: string[] },
): Promise<void> {
  await transaction(async (client) => {
    for (const player of players)
      await client.query(
        `INSERT INTO players(mode,id,name,avatar,profile_url,summary_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(mode,id) DO UPDATE SET name=EXCLUDED.name,avatar=EXCLUDED.avatar,profile_url=EXCLUDED.profile_url,summary_at=now()`,
        [config.mode, player.id, player.name, player.avatar, player.profileUrl],
      );
    if (checkpoint)
      await client.query(
        "UPDATE run_nodes SET hydrated=true WHERE run_id=$1 AND player_id=ANY($2::text[])",
        [checkpoint.runId, checkpoint.ids],
      );
  });
}
async function snapshotList(
  client: pg.PoolClient,
  runId: string,
  owner: string,
): Promise<void> {
  await client.query(
    "DELETE FROM run_friend_observations WHERE run_id=$1 AND owner_id=$2",
    [runId, owner],
  );
  await client.query(
    `INSERT INTO run_friend_observations(run_id,owner_id,friend_id) SELECT $1,owner_id,friend_id FROM friend_observations WHERE mode=$2 AND owner_id=$3 ON CONFLICT DO NOTHING`,
    [runId, config.mode, owner],
  );
  await client.query(
    `UPDATE run_nodes n SET observed=true,fetch_status=f.status,fetched_at=f.fetched_at,friend_count=f.friend_count FROM friend_lists f WHERE n.run_id=$1 AND n.player_id=$3 AND f.mode=$2 AND f.owner_id=$3`,
    [runId, config.mode, owner],
  );
}
export async function captureList(runId: string, owner: string): Promise<void> {
  await transaction(async (client) => {
    await snapshotList(client, runId, owner);
    await client.query(
      "UPDATE crawl_runs SET cache_hits=cache_hits+1,updated_at=now() WHERE id=$1",
      [runId],
    );
  });
}
export async function saveList(
  owner: string,
  friends: string[],
  runId?: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM friend_observations WHERE mode=$1 AND owner_id=$2",
      [config.mode, owner],
    );
    if (friends.length)
      await client.query(
        `INSERT INTO friend_observations(mode,owner_id,friend_id) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`,
        [config.mode, owner, friends.filter((id) => id !== owner)],
      );
    await client.query(
      `DELETE FROM friendship_edges e WHERE e.mode=$1 AND (e.source=$2 OR e.target=$2) AND NOT EXISTS(SELECT 1 FROM friend_observations o WHERE o.mode=e.mode AND ((o.owner_id=e.source AND o.friend_id=e.target) OR (o.owner_id=e.target AND o.friend_id=e.source)))`,
      [config.mode, owner],
    );
    await client.query(
      `INSERT INTO friendship_edges(mode,source,target) SELECT mode,least(owner_id,friend_id),greatest(owner_id,friend_id) FROM friend_observations WHERE mode=$1 AND owner_id=$2 AND owner_id<>friend_id ON CONFLICT DO NOTHING`,
      [config.mode, owner],
    );
    await client.query(
      `INSERT INTO friend_lists(mode,owner_id,status,fetched_at,attempted_at,friend_count) VALUES($1,$2,'ok',now(),now(),$3) ON CONFLICT(mode,owner_id) DO UPDATE SET status='ok',fetched_at=now(),attempted_at=now(),friend_count=EXCLUDED.friend_count`,
      [config.mode, owner, friends.length],
    );
    if (runId) await snapshotList(client, runId, owner);
  });
}
export async function failList(
  owner: string,
  status: "private" | "error",
  runId?: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO friend_lists(mode,owner_id,status,attempted_at) VALUES($1,$2,$3,now()) ON CONFLICT(mode,owner_id) DO UPDATE SET status=EXCLUDED.status,attempted_at=now()`,
      [config.mode, owner, status],
    );
    if (runId) await snapshotList(client, runId, owner);
  });
}
export async function finishRun(
  id: string,
  status: "completed" | "limited" | "failed",
  message: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE crawl_runs SET status=$2,message=$3,updated_at=now(),completed_at=now() WHERE id=$1 AND status IN ('running','queued')`,
    [id, status, message],
  );
}
