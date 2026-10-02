import { z } from "zod";
import type {
  CrawlRun, RelationshipScoresResponse, RelationshipScoreRow, RelationshipScoreSummary,
  RelationshipScorePage, RelationshipOverview, RelationshipScoreDetail,
} from "../../../packages/shared/src/index.js";
import { validSteamId } from "./identity.js";
import { getGraphData, getRun, HttpError } from "./repository.js";
import { scoreRelationshipGraph } from "./relationship-scoring.js";
import { applyRelationshipGroups } from "./group-scoring.js";
import { getRunGroupSnapshots } from "./group-scores.js";
import { pool } from "./db.js";
import { config } from "./config.js";

export const relationshipScoresQuerySchema = z.object({
  center: z.string().refine(validSteamId).optional(),
});
export const relationshipPageQuerySchema = relationshipScoresQuerySchema.extend({
  page: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().max(200).trim().default(""),
  layer: z.enum(["all", "core", "close", "connected", "peripheral", "unknown"]).default("all"),
});
type PageOptions = z.input<typeof relationshipPageQuerySchema>;

/** Derive scores only from this run's persisted snapshot; this performs no writes. */
export async function getRelationshipScores(
  runId: string,
  centerId?: string,
): Promise<RelationshipScoresResponse> {
  return computeRelationshipScores(runId, centerId);
}

async function computeRelationshipScores(
  runId: string,
  centerId?: string,
  validatedRun?: CrawlRun,
): Promise<RelationshipScoresResponse> {
  if (centerId !== undefined && !validSteamId(centerId)) {
    throw new HttpError(400, "请选择有效的 Steam 玩家作为关系中心");
  }
  const run = validatedRun ?? await getRun(runId);
  const data = await getGraphData(runId, run);
  const center = centerId ?? run.rootId;
  if (!data.nodes.some((node) => node.id === center)) {
    throw new HttpError(400, "关系中心不属于该查询");
  }
  const now = Date.now();
  const groups = await getRunGroupSnapshots(runId);
  return {
    runId,
    algorithmVersion: "mutual-network-groups-v2",
    computedAt: new Date(now).toISOString(),
    sourceUpdatedAt: run.updatedAt,
    groupJobId: groups.jobId,
    groupSourceUpdatedAt: groups.updatedAt,
    ...applyRelationshipGroups(
      scoreRelationshipGraph(
        center,
        data.nodes,
        data.edges,
        data.fullyRepresented,
        now,
      ),
      groups.snapshots,
    ),
  };
}

const summary = (row: RelationshipScoreRow): RelationshipScoreSummary => ({
  player: row.player, score: row.score, layer: row.layer, distance: row.distance,
  isDirect: row.isDirect, mutualCount: row.mutualCount, networkScore: row.networkScore,
});

/** Match the visual ring capacities while giving every scored layer a turn. */
export function relationshipOverview(data: RelationshipScoresResponse): RelationshipOverview {
  const { rows, ...metadata } = data;
  const layers = ["core", "close", "connected", "peripheral"] as const;
  const limits = [24, 32, 44, 56];
  const buckets = layers.map((layer, i) => rows.filter((row) => row.layer === layer && row.score !== null).slice(0, limits[i]));
  const selected: RelationshipScoreSummary[] = [];
  for (let index = 0; selected.length < 100; index++) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[index] && selected.length < 100) {
        selected.push(summary(bucket[index]));
        added = true;
      }
    }
    if (!added) break;
  }
  return { ...metadata, rows: selected };
}

// Bound both age and total retained rows. Metadata versions are read on every
// access because player headers can change independently of a run's timestamp.
const cache = new Map<string, { expires: number; result: RelationshipScoresResponse }>();
const pending = new Map<string, Promise<RelationshipScoresResponse>>();
async function cachedScores(runId: string, centerId?: string): Promise<RelationshipScoresResponse> {
  if (centerId !== undefined && !validSteamId(centerId)) throw new HttpError(400, "请选择有效的 Steam 玩家作为关系中心");
  const run = await getRun(runId);
  const { rows } = await pool.query(
    `SELECT (SELECT md5(string_agg(ROW(p.id,p.name,p.avatar,p.profile_url,p.summary_at,n.depth,n.fetch_status,n.fetched_at,n.friend_count)::text,'' ORDER BY p.id)) FROM run_nodes n JOIN players p ON p.mode=$2 AND p.id=n.player_id WHERE n.run_id=$1) snapshot_version,
     (SELECT min(fetched_at + interval '1 day') FROM run_nodes WHERE run_id=$1 AND fetch_status='ok' AND fetched_at + interval '1 day' > now()) coverage_expires_at,
     j.id group_job_id,j.updated_at::text group_version
     FROM (SELECT 1) seed LEFT JOIN LATERAL
     (SELECT id,updated_at FROM group_collection_jobs WHERE run_id=$1 AND mode=$2 ORDER BY created_at DESC,id DESC LIMIT 1) j ON true`,
    [runId, config.mode],
  );
  const key = JSON.stringify([config.mode, runId, centerId ?? run.rootId, run.updatedAt,
    run.nodeCount, run.edgeCount, run.fetchedCount, run.privateCount, run.errorCount, rows[0]]);
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
  const hit = cache.get(key);
  if (hit) return hit.result;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = computeRelationshipScores(runId, centerId, run).then((result) => {
    // Coverage is time-dependent; a short TTL also bounds metadata races during
    // collection. Never serve an entry past the next 24-hour list expiry.
    const expires = Math.min(Date.now() + 2000, rows[0].coverage_expires_at?.getTime() ?? Infinity);
    cache.set(key, { result, expires });
    let retained = [...cache.values()].reduce((sum, entry) => sum + entry.result.rows.length, 0);
    while (cache.size > 8 || retained > 20000) {
      const oldest = cache.keys().next().value!;
      retained -= cache.get(oldest)!.result.rows.length;
      cache.delete(oldest);
    }
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export async function getRelationshipScorePage(runId: string, input: PageOptions = {}): Promise<RelationshipScorePage> {
  const parsed = relationshipPageQuerySchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "关系排行筛选参数无效");
  const { center, q, layer, limit, page } = parsed.data;
  const { rows, ...metadata } = await cachedScores(runId, center);
  const needle = q.toLowerCase();
  const matching = rows.filter((row) => (layer === "all" || row.layer === layer) && (row.player.name.toLowerCase().includes(needle) || row.player.id.includes(needle)));
  const pages = Math.max(1, Math.ceil(matching.length / limit));
  const current = Math.min(page, pages - 1);
  return { ...metadata, rows: matching.slice(current * limit, (current + 1) * limit).map(summary), page: current, pages, limit, total: matching.length };
}

export async function getRelationshipOverview(runId: string, centerId?: string): Promise<RelationshipOverview> {
  return relationshipOverview(await cachedScores(runId, centerId));
}

export async function getRelationshipScoreDetail(runId: string, playerId: string, centerId?: string): Promise<RelationshipScoreDetail> {
  if (!validSteamId(playerId)) throw new HttpError(400, "请选择有效的 Steam 玩家");
  const { rows, ...metadata } = await cachedScores(runId, centerId);
  const row = rows.find((row) => row.player.id === playerId);
  if (!row) throw new HttpError(404, "该玩家不在关系排行中");
  return { ...metadata, row };
}
