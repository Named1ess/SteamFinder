import { randomUUID } from "node:crypto";
import type {
  GroupCollectionJob,
  GroupSnapshot,
  PublicGroups,
  RunGroupsResponse,
} from "../../../packages/shared/src/index.js";
import type pg from "pg";
import { pool, transaction } from "./db.js";
import { config } from "./config.js";
import { getRun, HttpError } from "./repository.js";
import { SteamError, type Provider } from "./provider.js";
import { BudgetError, CancelledError, steamRequest } from "./requests.js";

const iso = (value: Date | null) => value?.toISOString() ?? null;
const active = (status: string) => ["queued", "running"].includes(status);
const latestJob = `SELECT j.* FROM group_collection_jobs j JOIN crawl_runs r ON r.id=j.run_id
  WHERE j.run_id=$1 AND j.mode=$2 AND r.mode=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 1`;

async function readJob(id: string) {
  const { rows } = await pool.query(
    `SELECT j.* FROM group_collection_jobs j JOIN crawl_runs r ON r.id=j.run_id
     WHERE j.id=$1 AND j.mode=$2 AND r.mode=$2`,
    [id, config.mode],
  );
  if (!rows[0]) throw new HttpError(404, "找不到该群组采集任务");
  return rows[0];
}
function jobResponse(row: Record<string, any>): GroupCollectionJob {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    maxRequests: row.max_requests,
    requestCount: row.request_count,
    cacheHits: row.cache_hits,
    totalPlayers: row.total_players,
    processedPlayers: row.processed_players,
    message: row.message,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    completedAt: iso(row.completed_at),
  };
}
function snapshot(row: Record<string, any>): GroupSnapshot {
  return {
    playerId: row.player_id,
    status: row.status,
    groups: row.groups,
    totalCount: row.total_count,
    complete: row.complete,
    fetchedAt: iso(row.fetched_at),
    attemptedAt: iso(row.attempted_at),
    message: row.message,
  };
}

/** Both reads are exclusively database operations; opening a view never contacts Steam. */
export async function getRunGroups(runId: string): Promise<RunGroupsResponse> {
  const run = await getRun(runId);
  const { rows } = await pool.query(
    `WITH latest AS (${latestJob})
     SELECT j.*,
       count(p.player_id)::int total_players,
       count(p.player_id) FILTER (WHERE p.processed)::int processed_players,
       count(p.player_id) FILTER (WHERE p.processed AND p.status='ok' AND p.complete)::int available_players,
       count(p.player_id) FILTER (WHERE p.processed AND (p.status<>'ok' OR NOT p.complete))::int unavailable_players
     FROM latest j LEFT JOIN group_collection_players p ON p.job_id=j.id
     GROUP BY j.id,j.run_id,j.mode,j.root_id,j.status,j.refresh,j.max_requests,j.request_count,j.cache_hits,j.message,j.created_at,j.updated_at,j.completed_at`,
    [runId, config.mode],
  );
  const row = rows[0];
  if (!row)
    return {
      runId,
      job: null,
      updatedAt: null,
      coverage: {
        availablePlayers: 0,
        unavailablePlayers: 0,
        pendingPlayers: run.nodeCount,
        totalPlayers: run.nodeCount,
      },
    };
  return {
    runId,
    job: jobResponse(row),
    updatedAt: iso(row.updated_at),
    coverage: {
      availablePlayers: row.available_players,
      unavailablePlayers: row.unavailable_players,
      pendingPlayers: row.total_players - row.processed_players,
      totalPlayers: row.total_players,
    },
  };
}

/** Never consult the global cache for scoring: only this run's latest pinned job. */
export async function getRunGroupSnapshots(runId: string): Promise<{
  jobId: string | null;
  updatedAt: string | null;
  snapshots: Map<string, GroupSnapshot>;
}> {
  await getRun(runId);
  const { rows } = await pool.query(
    `WITH latest AS (${latestJob})
     SELECT j.id snapshot_job_id,j.updated_at snapshot_updated_at,p.*
     FROM latest j LEFT JOIN group_collection_players p ON p.job_id=j.id`,
    [runId, config.mode],
  );
  return {
    jobId: rows[0]?.snapshot_job_id ?? null,
    updatedAt: iso(rows[0]?.snapshot_updated_at ?? null),
    snapshots: new Map(
      rows
        .filter((row) => row.player_id)
        .map((row) => [row.player_id, snapshot(row)]),
    ),
  };
}

async function pinPlayers(
  client: pg.PoolClient,
  jobId: string,
  runId: string,
  rootId: string,
) {
  await client.query(
    `INSERT INTO group_collection_players(job_id,player_id,is_root,depth)
     SELECT $1,player_id,player_id=$3,depth FROM run_nodes WHERE run_id=$2
     ON CONFLICT(job_id,player_id) DO NOTHING`,
    [jobId, runId, rootId],
  );
}

export async function startGroupCollectionJob(
  runId: string,
  options: { refresh?: boolean; maxRequests?: number },
): Promise<{ jobId: string; enqueue: boolean }> {
  await getRun(runId);
  const maxRequests = options.maxRequests ?? 500;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000)
    throw new HttpError(400, "群组请求预算必须为 1 至 10000 的整数");
  return transaction(async (client) => {
    // Crawl expansion locks this row too, so the captured node set is well-defined.
    const run = await client.query(
      "SELECT root_id FROM crawl_runs WHERE id=$1 AND mode=$2 FOR UPDATE",
      [runId, config.mode],
    );
    if (!run.rows[0]) throw new HttpError(404, "找不到该查询");
    const rootId = run.rows[0].root_id;
    const { rows } = await client.query(latestJob, [runId, config.mode]);
    const latest = rows[0];
    // A queued row may have been committed just before API dispatch failed.
    // Re-delivery is safe because the collector serializes and checks its state.
    if (latest && active(latest.status))
      return { jobId: latest.id, enqueue: latest.status === "queued" };
    if (latest && !options.refresh) {
      const missing = await client.query(
        `SELECT 1 FROM run_nodes n WHERE n.run_id=$1 AND NOT EXISTS
         (SELECT 1 FROM group_collection_players p WHERE p.job_id=$2 AND p.player_id=n.player_id) LIMIT 1`,
        [runId, latest.id],
      );
      if (latest.status === "completed" && !missing.rows.length)
        return { jobId: latest.id, enqueue: false };
      if (latest.status !== "completed") {
        if (maxRequests < latest.request_count)
          throw new HttpError(400, "新预算不能少于群组已使用的请求数");
        await pinPlayers(client, latest.id, runId, rootId);
        await client.query(
          "UPDATE group_collection_jobs SET status='queued',max_requests=$2,message=NULL,updated_at=now(),completed_at=NULL WHERE id=$1",
          [latest.id, maxRequests],
        );
        return { jobId: latest.id, enqueue: true };
      }
    }
    const id = randomUUID();
    await client.query(
      "INSERT INTO group_collection_jobs(id,run_id,mode,root_id,refresh,max_requests) VALUES($1,$2,$3,$4,$5,$6)",
      [id, runId, config.mode, rootId, options.refresh ?? false, maxRequests],
    );
    await pinPlayers(client, id, runId, rootId);
    return { jobId: id, enqueue: true };
  });
}

async function pinCache(
  client: pg.PoolClient,
  jobId: string,
  playerId?: string,
) {
  return client.query(
    `UPDATE group_collection_players s SET processed=true,status=p.status,groups=p.groups,
     total_count=p.total_count,complete=p.complete,fetched_at=p.fetched_at,attempted_at=p.attempted_at,message=p.message
     FROM group_profiles p WHERE s.job_id=$1 AND NOT s.processed AND p.mode=$2 AND p.player_id=s.player_id
     AND p.status<>'unknown' AND ($3::text IS NULL OR s.player_id=$3) RETURNING s.player_id`,
    [jobId, config.mode, playerId ?? null],
  );
}
async function saveGroups(
  jobId: string,
  playerId: string,
  groups: PublicGroups,
) {
  if (
    !Number.isInteger(groups.totalCount) ||
    groups.totalCount < 0 ||
    new Set(groups.groups.map((group) => group.id)).size !==
      groups.totalCount ||
    groups.groups.length !== groups.totalCount
  )
    throw new SteamError("invalid", "公开群组列表不完整，暂时无法使用");
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO group_profiles(mode,player_id,status,groups,total_count,complete,fetched_at,attempted_at)
       VALUES($1,$2,'ok',$3,$4,true,now(),now()) ON CONFLICT(mode,player_id)
       DO UPDATE SET status='ok',groups=EXCLUDED.groups,total_count=EXCLUDED.total_count,
       complete=true,fetched_at=now(),attempted_at=now(),message=NULL`,
      [config.mode, playerId, JSON.stringify(groups.groups), groups.totalCount],
    );
    await pinCache(client, jobId, playerId);
    await client.query(
      "UPDATE group_collection_jobs SET updated_at=now() WHERE id=$1",
      [jobId],
    );
  });
}
async function saveFailure(jobId: string, playerId: string, error: unknown) {
  const status =
    error instanceof SteamError && error.kind === "private"
      ? "private"
      : "error";
  const message =
    error instanceof SteamError ? error.message : "公开群组暂时读取失败";
  await transaction(async (client) => {
    // Retain last successful content, but invalidate it for the refreshed score.
    await client.query(
      `INSERT INTO group_profiles(mode,player_id,status,complete,attempted_at,message) VALUES($1,$2,$3,false,now(),$4)
       ON CONFLICT(mode,player_id) DO UPDATE SET status=EXCLUDED.status,complete=false,attempted_at=now(),message=EXCLUDED.message`,
      [config.mode, playerId, status, message],
    );
    await pinCache(client, jobId, playerId);
    await client.query(
      "UPDATE group_collection_jobs SET updated_at=now() WHERE id=$1",
      [jobId],
    );
  });
}
async function finishJob(id: string, status: string, message: string | null) {
  await pool.query(
    "UPDATE group_collection_jobs SET status=$2,message=$3,updated_at=now(),completed_at=now() WHERE id=$1 AND mode=$4 AND status IN ('queued','running')",
    [id, status, message, config.mode],
  );
}
export async function recoverGroupCollectionJobs(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT j.id FROM group_collection_jobs j JOIN crawl_runs r ON r.id=j.run_id
     WHERE j.mode=$1 AND r.mode=$1 AND j.status IN ('queued','running') ORDER BY j.created_at,j.id`,
    [config.mode],
  );
  return rows.map((row) => row.id);
}

export async function collectGroupScores(jobId: string, provider: Provider) {
  const lock = await pool.connect();
  try {
    // Serialize replay and cache updates across workers, separately from request pacing.
    await lock.query("SELECT pg_advisory_lock(72461504)");
    const initial = await readJob(jobId);
    if (!active(initial.status)) return;
    if (!provider.groups) throw new Error("Public groups source unavailable");
    await pool.query(
      "UPDATE group_collection_jobs SET status='running',message=NULL,updated_at=now() WHERE id=$1 AND status='queued'",
      [jobId],
    );
    if (!initial.refresh)
      await transaction(async (client) => {
        const pinned = await pinCache(client, jobId);
        await client.query(
          "UPDATE group_collection_jobs SET cache_hits=cache_hits+$2,updated_at=now() WHERE id=$1",
          [jobId, pinned.rowCount],
        );
      });
    while (true) {
      const job = await readJob(jobId);
      if (job.status !== "running") return;
      const { rows } = await pool.query(
        "SELECT player_id FROM group_collection_players WHERE job_id=$1 AND NOT processed ORDER BY is_root DESC,depth,player_id LIMIT 1",
        [jobId],
      );
      if (!rows.length) {
        await finishJob(
          jobId,
          "completed",
          "已读取公开加入的群组；不可用资料不会降低关系评分",
        );
        return;
      }
      const playerId = rows[0].player_id;
      try {
        const groups = await steamRequest(
          () => provider.groups!(playerId),
          undefined,
          undefined,
          undefined,
          undefined,
          jobId,
        );
        await saveGroups(jobId, playerId, groups);
      } catch (error) {
        if (error instanceof BudgetError || error instanceof CancelledError)
          throw error;
        await saveFailure(jobId, playerId, error);
      }
    }
  } catch (error) {
    if (error instanceof CancelledError) return;
    await finishJob(
      jobId,
      error instanceof BudgetError ? "limited" : "failed",
      error instanceof BudgetError
        ? error.message
        : "群组采集暂时失败，可继续任务",
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(72461504)").catch(() => {});
    lock.release();
  }
}
