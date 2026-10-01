import { randomUUID } from "node:crypto";
import type {
  GameProfileSnapshot,
  GameScoreJob,
  GameScoresResponse,
  PublicGames,
} from "../../../packages/shared/src/index.js";
import type pg from "pg";
import { pool, transaction } from "./db.js";
import { config } from "./config.js";
import { getRun, HttpError } from "./repository.js";
import { SteamError, type Provider } from "./provider.js";
import { BudgetError, CancelledError, steamRequest } from "./requests.js";
import { calculateGameScore } from "./game-scoring.js";
import { saveProfileDetails } from "./player-details.js";

const iso = (value: Date | null) => value?.toISOString() ?? null;
const active = (status: string) => ["queued", "running"].includes(status);

async function readJob(id: string) {
  const { rows } = await pool.query(
    `SELECT j.*,
     (SELECT count(*)::int FROM game_score_players p WHERE p.job_id=j.id) total_players,
     (SELECT count(*)::int FROM game_score_players p WHERE p.job_id=j.id AND p.processed) processed_players
     FROM game_score_jobs j WHERE j.id=$1 AND j.mode=$2`,
    [id, config.mode],
  );
  if (!rows[0]) throw new HttpError(404, "找不到该游戏资料采集任务");
  return rows[0];
}
function jobResponse(row: Record<string, any>): GameScoreJob {
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
function snapshot(row: Record<string, any>): GameProfileSnapshot {
  return {
    playerId: row.player_id,
    status: row.status,
    scope: "profile_recent",
    games: row.games,
    profile: row.profile ?? null,
    fetchedAt: iso(row.fetched_at),
    attemptedAt: iso(row.attempted_at),
    message: row.message,
  };
}

/** Reading scores is exclusively a DB operation, including while jobs are active. */
export async function getGameScores(runId: string): Promise<GameScoresResponse> {
  const run = await getRun(runId);
  const result: GameScoresResponse = {
    runId,
    rootId: run.rootId,
    scope: "profile_recent",
    formulaVersion: "public-games-location-v2",
    root: null,
    job: null,
    rows: [],
  };
  const latest = await pool.query(
    "SELECT id FROM game_score_jobs WHERE run_id=$1 AND mode=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
    [runId, config.mode],
  );
  if (!latest.rows.length) return result;
  result.job = jobResponse(await readJob(latest.rows[0].id));
  const { rows } = await pool.query(
    "SELECT * FROM game_score_players WHERE job_id=$1 ORDER BY is_root DESC,player_id",
    [result.job.id],
  );
  const root = rows.find((row) => row.is_root);
  if (!root) throw new HttpError(500, "游戏资料任务缺少目标玩家快照");
  result.root = snapshot(root);
  result.rows = rows.filter((row) => !row.is_root).map((row) => {
    const observed = snapshot(row);
    return {
      player: {
        id: row.player_id,
        name: row.name,
        avatar: row.avatar,
        profileUrl: row.profile_url,
      },
      snapshot: observed,
      result: calculateGameScore(result.root!, observed),
    };
  }).sort((a, b) => {
    if (a.result.score === null && b.result.score !== null) return 1;
    if (a.result.score !== null && b.result.score === null) return -1;
    return (b.result.score ?? 0) - (a.result.score ?? 0) || a.player.id.localeCompare(b.player.id);
  });
  return result;
}

/** Pin the current direct-friend set and profile labels once per new job. */
export async function startGameScoreJob(
  runId: string,
  options: { refresh?: boolean; maxRequests?: number },
): Promise<{ jobId: string; enqueue: boolean }> {
  await getRun(runId);
  const maxRequests = options.maxRequests ?? 2000;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000)
    throw new HttpError(400, "游戏资料请求预算必须为 1 至 10000 的整数");
  return transaction(async (client) => {
    // This lock serializes submissions and fixes the friend set relative to crawl
    // expansion, which also locks its parent run before admitting new nodes.
    const { rows: runs } = await client.query(
      "SELECT root_id FROM crawl_runs WHERE id=$1 AND mode=$2 FOR UPDATE",
      [runId, config.mode],
    );
    if (!runs[0]) throw new HttpError(404, "找不到该查询");
    const { rows } = await client.query(
      "SELECT * FROM game_score_jobs WHERE run_id=$1 AND mode=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [runId, config.mode],
    );
    const latest = rows[0];
    if (latest && active(latest.status))
      return { jobId: latest.id, enqueue: false };
    if (latest && !options.refresh) {
      if (latest.status === "completed")
        return { jobId: latest.id, enqueue: false };
      if (maxRequests < latest.request_count)
        throw new HttpError(400, "新预算不能少于游戏资料已使用的请求数");
      await client.query(
        "UPDATE game_score_jobs SET status='queued',max_requests=$2,message=NULL,updated_at=now(),completed_at=NULL WHERE id=$1",
        [latest.id, maxRequests],
      );
      return { jobId: latest.id, enqueue: true };
    }
    const id = randomUUID();
    await client.query(
      "INSERT INTO game_score_jobs(id,run_id,mode,root_id,refresh,max_requests) VALUES($1,$2,$3,$4,$5,$6)",
      [id, runId, config.mode, runs[0].root_id, options.refresh ?? false, maxRequests],
    );
    await client.query(
      `INSERT INTO game_score_players(job_id,player_id,is_root,name,avatar,profile_url)
       SELECT $1,n.player_id,n.player_id=$3,p.name,p.avatar,p.profile_url
       FROM run_nodes n JOIN players p ON p.mode=$2 AND p.id=n.player_id
       WHERE n.run_id=$4 AND (n.player_id=$3 OR n.depth=1)`,
      [id, config.mode, runs[0].root_id, runId],
    );
    return { jobId: id, enqueue: true };
  });
}

async function pinCache(client: pg.PoolClient, jobId: string, playerId: string) {
  await client.query(
    `UPDATE game_score_players s SET processed=true,status=p.status,scope=p.scope,
     games=p.games,profile=p.profile,fetched_at=p.fetched_at,attempted_at=p.attempted_at,message=p.message
     FROM game_profiles p WHERE s.job_id=$1 AND s.player_id=$2 AND p.mode=$3 AND p.player_id=$2`,
    [jobId, playerId, config.mode],
  );
  await client.query("UPDATE game_score_jobs SET updated_at=now() WHERE id=$1", [jobId]);
}
async function saveGames(jobId: string, playerId: string, games: PublicGames) {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO game_profiles(mode,player_id,status,scope,games,profile,fetched_at,attempted_at)
       VALUES($1,$2,'ok',$3,$4,$5,now(),now())
       ON CONFLICT(mode,player_id) DO UPDATE SET status='ok',scope=EXCLUDED.scope,
       games=EXCLUDED.games,profile=EXCLUDED.profile,fetched_at=now(),attempted_at=now(),message=NULL`,
      [config.mode, playerId, games.scope, JSON.stringify(games.games), games.profile ? JSON.stringify(games.profile) : null],
    );
    if (games.profile) await saveProfileDetails(client, playerId, games.profile);
    await pinCache(client, jobId, playerId);
  });
}
async function saveFailure(jobId: string, playerId: string, error: unknown) {
  const status = error instanceof SteamError && error.kind === "private" ? "private" : "error";
  const message = error instanceof SteamError ? error.message : "公开游戏资料暂时读取失败";
  await transaction(async (client) => {
    // Only successful pages replace games. An inaccessible refresh retains the
    // last good cache, while the pinned failure status makes its score unknown.
    await client.query(
      `INSERT INTO game_profiles(mode,player_id,status,attempted_at,message) VALUES($1,$2,$3,now(),$4)
       ON CONFLICT(mode,player_id) DO UPDATE SET status=EXCLUDED.status,attempted_at=now(),message=EXCLUDED.message`,
      [config.mode, playerId, status, message],
    );
    await pinCache(client, jobId, playerId);
  });
}
async function finishJob(id: string, status: string, message: string | null) {
  await pool.query(
    "UPDATE game_score_jobs SET status=$2,message=$3,updated_at=now(),completed_at=now() WHERE id=$1 AND mode=$4 AND status IN ('queued','running')",
    [id, status, message, config.mode],
  );
}
export async function recoverGameScoreJobs(): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT id FROM game_score_jobs WHERE mode=$1 AND status IN ('queued','running') ORDER BY created_at,id",
    [config.mode],
  );
  return rows.map((row) => row.id);
}

export async function collectGameScores(jobId: string, provider: Provider) {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(72461503)");
    const initial = await readJob(jobId);
    if (!active(initial.status)) return;
    if (!provider.games) throw new Error("Public game profile source unavailable");
    await pool.query(
      "UPDATE game_score_jobs SET status='running',message=NULL,updated_at=now() WHERE id=$1 AND status='queued'",
      [jobId],
    );
    while (true) {
      const job = await readJob(jobId);
      if (job.status !== "running") return;
      const { rows } = await pool.query(
        "SELECT player_id FROM game_score_players WHERE job_id=$1 AND NOT processed ORDER BY is_root DESC,player_id LIMIT 1",
        [jobId],
      );
      if (!rows.length) {
        await finishJob(jobId, "completed", "仅比较公开主页展示的近期游戏样本，不代表完整游戏库");
        return;
      }
      const playerId = rows[0].player_id;
      if (!job.refresh) {
        const cached = await pool.query(
          "SELECT player_id FROM game_profiles WHERE mode=$1 AND player_id=$2 AND status<>'unknown'",
          [config.mode, playerId],
        );
        if (cached.rows.length) {
          await transaction(async (client) => {
            await pinCache(client, jobId, playerId);
            await client.query("UPDATE game_score_jobs SET cache_hits=cache_hits+1 WHERE id=$1", [jobId]);
          });
          continue;
        }
      }
      try {
        const games = await steamRequest(
          () => provider.games!(playerId), undefined, undefined, undefined, jobId,
        );
        await saveGames(jobId, playerId, games);
      } catch (error) {
        if (error instanceof BudgetError || error instanceof CancelledError) throw error;
        await saveFailure(jobId, playerId, error);
      }
    }
  } catch (error) {
    if (error instanceof CancelledError) return;
    await finishJob(
      jobId,
      error instanceof BudgetError ? "limited" : "failed",
      error instanceof BudgetError ? error.message : "游戏资料采集暂时失败，可继续任务",
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(72461503)").catch(() => {});
    lock.release();
  }
}
