import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { CrawlRun, GraphNode, GraphEdge, GraphFilters, GraphFilterRequest, GraphFilterResponse, GraphFilterRow, GraphFilterOptions, GameProfileSnapshot, GroupSnapshot, SteamGroup } from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { graphResponse } from "./graph.js";
import { graphFiltersSchema } from "./graph-filter-schema.js";
import { validSteamId } from "./identity.js";
import { scoreRelationshipGraph } from "./relationship-scoring.js";
import { applyRelationshipGroups } from "./group-scoring.js";
import { getGraphData, getRun, HttpError } from "./repository.js";

export { graphFiltersSchema } from "./graph-filter-schema.js";

export interface FilterSources {
  scores: ReadonlyMap<string, number | null>;
  games: ReadonlyMap<string, Pick<GameProfileSnapshot, "status" | "games">>;
  groups: ReadonlyMap<string, GroupSnapshot>;
}

/** Keep score evidence and filter evidence on the same already-read snapshot. */
export function scoreFilterSnapshot(run: CrawlRun, nodes: GraphNode[], edges: GraphEdge[], fullyRepresented: ReadonlySet<string>, groups: ReadonlyMap<string, GroupSnapshot>, nowMs: number): Map<string, number | null> {
  const scores = applyRelationshipGroups(scoreRelationshipGraph(run.rootId, nodes, edges, fullyRepresented, nowMs), groups);
  return new Map(scores.rows.map((row) => [row.player.id, row.score]));
}
const playerId = z.string().refine(validSteamId);
export const graphFilterRequestSchema = z.object({
  filters: graphFiltersSchema,
  tagPlayerIds: z.array(playerId).max(1000).optional(),
  selectedId: playerId.nullable().optional(),
  focus: z.object({ playerId, hops: z.union([z.literal(1), z.literal(2)]) }).strict().nullable().optional(),
  limit: z.union([z.literal(100), z.literal(250), z.literal(500), z.literal(1000)]),
  page: z.number().int().min(0).max(100000),
}).strict();

function usableGroups(snapshot?: GroupSnapshot): SteamGroup[] | null {
  if (!snapshot || snapshot.status !== "ok" || !snapshot.complete) return null;
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  return groups.size === snapshot.totalCount ? [...groups.values()] : null;
}

function evaluatePlayer(player: GraphNode, filters: GraphFilters, sources: FilterSources, tagged: ReadonlySet<string>): GraphFilterRow | null {
  const score = sources.scores.get(player.id) ?? null;
  const conditions: (boolean | null)[] = [];
  const unknownReasons: string[] = [];
  const condition = (value: boolean | null, reason: string) => {
    conditions.push(value);
    if (value === null) unknownReasons.push(reason);
  };
  if (filters.minScore !== null) condition(score === null ? null : score >= filters.minScore, "相对查询起点的关系分不可用");
  if (filters.community !== null) condition(player.community === filters.community, "");
  if (filters.gameAppId) {
    const snapshot = sources.games.get(player.id);
    condition(snapshot?.status === "ok" ? snapshot.games.some((game) => game.appId === filters.gameAppId) : null, "公开游戏样本未采集、不可见或读取失败");
  }
  if (filters.groupId) {
    const groups = usableGroups(sources.groups.get(player.id));
    condition(groups ? groups.some((group) => group.id === filters.groupId) : null, "完整公开群组快照不可用");
  }
  if (filters.fetchStatus !== "all") condition(player.fetchStatus === filters.fetchStatus, "");
  if (filters.tag) condition(tagged.has(player.id), "");
  // Three-valued AND: missing evidence never rescues a known failed condition.
  if (conditions.includes(false)) return null;
  return { player, score, status: unknownReasons.length ? "unknown" : "match", unknownReasons };
}

/** Evaluate all saved players first; graph size and list pagination are independent. */
export function filterGraph(run: CrawlRun, nodes: GraphNode[], edges: GraphEdge[], input: GraphFilterRequest, sources: FilterSources, sourceVersion: string): GraphFilterResponse {
  const members = new Set(nodes.map((node) => node.id));
  const tagged = new Set(input.tagPlayerIds ?? []);
  if ([...tagged, ...(input.selectedId ? [input.selectedId] : [])].some((id) => !members.has(id))) throw new HttpError(400, "筛选中包含不属于该查询的玩家");
  // Enrich and determine focus before filtering so community IDs and statistics
  // remain identical to the ordinary full-run graph, including isolated players.
  const scoped = graphResponse(run, nodes, edges, nodes.length, 3, input.focus ?? undefined);
  const outcomes = scoped.nodes.map((node) => evaluatePlayer(node, input.filters, sources, tagged));
  const matches = outcomes.filter((row): row is GraphFilterRow => row !== null);
  const matched = matches.filter((row) => row.status === "match").length;
  const unknown = matches.length - matched;
  const chosen = matches.filter((row) => input.filters.unknown === "include" || row.status === (input.filters.unknown === "only" ? "unknown" : "match"));
  chosen.sort((a, b) => Number(a.status === "unknown") - Number(b.status === "unknown") || (b.score ?? -1) - (a.score ?? -1) || a.player.id.localeCompare(b.player.id));
  const visible = chosen.slice(0, input.limit).map((row) => row.player);
  const selected = input.selectedId ? chosen.find((row) => row.player.id === input.selectedId)?.player : undefined;
  if (selected && !visible.some((node) => node.id === selected.id)) visible.splice(visible.length - 1, 1, selected);
  const shownIds = new Set(visible.map((node) => node.id));
  const pageSize = 30, pages = Math.max(1, Math.ceil(chosen.length / pageSize)), page = Math.min(input.page, pages - 1);
  return {
    graph: { ...scoped, nodes: visible, edges: edges.filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target)), truncated: visible.length < chosen.length },
    rows: chosen.slice(page * pageSize, (page + 1) * pageSize),
    page, pages, pageSize, total: chosen.length, matched, unknown, excluded: scoped.nodes.length - matches.length, scopeTotal: scoped.nodes.length, sourceVersion,
  };
}

async function readSamples(runId: string) {
  const read = (jobs: string, players: string) => pool.query(
    `WITH latest AS (SELECT id,updated_at FROM ${jobs} WHERE run_id=$1 AND mode=$2 ORDER BY created_at DESC,id DESC LIMIT 1)
     SELECT j.id snapshot_job_id,j.updated_at snapshot_updated_at,p.* FROM latest j LEFT JOIN ${players} p ON p.job_id=j.id ORDER BY p.player_id`,
    [runId, config.mode],
  );
  const [gameRows, groupRows] = await Promise.all([read("game_score_jobs", "game_score_players"), read("group_collection_jobs", "group_collection_players")]);
  const games = new Map<string, Pick<GameProfileSnapshot, "status" | "games">>();
  const groups = new Map<string, GroupSnapshot>();
  for (const row of gameRows.rows) if (row.player_id) games.set(row.player_id, { status: row.processed ? row.status : "unknown", games: row.games });
  for (const row of groupRows.rows) if (row.player_id) groups.set(row.player_id, {
    playerId: row.player_id, status: row.processed ? row.status : "unknown", groups: row.groups, totalCount: row.total_count,
    complete: row.complete, fetchedAt: row.fetched_at?.toISOString() ?? null, attemptedAt: row.attempted_at?.toISOString() ?? null, message: row.message,
  });
  return { games, groups, versions: [gameRows.rows[0]?.snapshot_job_id, gameRows.rows[0]?.snapshot_updated_at, groupRows.rows[0]?.snapshot_job_id, groupRows.rows[0]?.snapshot_updated_at] };
}

async function readFilterData(runId: string) {
  const run = await getRun(runId);
  const [data, samples] = await Promise.all([getGraphData(runId, run), readSamples(runId)]);
  const sourceVersion = createHash("sha256").update(JSON.stringify([run.updatedAt, data.nodes, data.edges, samples.versions, [...samples.games], [...samples.groups]])).digest("hex");
  return { run, ...data, ...samples, sourceVersion };
}

function facetValues<T>(snapshots: Iterable<T[]>, identity: (item: T) => { id: string; name: string }) {
  const facets = new Map<string, { id: string; name: string; count: number }>();
  for (const items of snapshots) {
    const distinct = new Map(items.map((item) => { const value = identity(item); return [value.id, value]; }));
    for (const item of distinct.values()) {
      const previous = facets.get(item.id);
      facets.set(item.id, { ...item, name: previous?.name ?? item.name, count: (previous?.count ?? 0) + 1 });
    }
  }
  return [...facets.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function getGraphFilterOptions(runId: string): Promise<GraphFilterOptions> {
  const data = await readFilterData(runId);
  const members = new Set(data.nodes.map((node) => node.id));
  const games = [...data.games].filter(([id, snapshot]) => members.has(id) && snapshot.status === "ok").map(([, snapshot]) => snapshot.games);
  const groups = [...data.groups].filter(([id]) => members.has(id)).map(([, snapshot]) => usableGroups(snapshot)).filter((value): value is SteamGroup[] => value !== null);
  return {
    communities: graphResponse(data.run, data.nodes, data.edges, data.nodes.length, 3).stats.communities,
    games: facetValues(games, (game) => ({ id: game.appId, name: game.name })),
    groups: facetValues(groups, (group) => ({ id: group.id, name: group.name })),
    gamePlayers: games.length, groupPlayers: groups.length, totalPlayers: data.nodes.length, sourceVersion: data.sourceVersion,
  };
}

function runIdFrom(request: { params: unknown }): string {
  const { id } = request.params as { id: string };
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "找不到该查询");
  return id;
}

export function registerGraphFilterRoutes(app: FastifyInstance) {
  app.get("/api/runs/:id/filter-options", async (request) => getGraphFilterOptions(runIdFrom(request)));
  // This POST computes a view from saved data only; it never schedules collection.
  app.post("/api/runs/:id/filter", { bodyLimit: 64 * 1024 }, async (request) => {
    const runId = runIdFrom(request);
    const parsed = graphFilterRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "组合筛选参数无效");
    const data = await readFilterData(runId);
    const scores = scoreFilterSnapshot(data.run, data.nodes, data.edges, data.fullyRepresented, data.groups, Date.now());
    return filterGraph(data.run, data.nodes, data.edges, parsed.data, { games: data.games, groups: data.groups, scores }, data.sourceVersion);
  });
}
