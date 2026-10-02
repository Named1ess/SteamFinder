import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CrawlRun, GraphEdge, GraphNode, MultiFriendRequest, MultiFriendResponse } from "../../../packages/shared/src/index.js";
import { graphResponse } from "./graph.js";
import { validSteamId } from "./identity.js";
import { getGraphData, getRun, HttpError } from "./repository.js";

const pageSize = 30;
const dayMs = 24 * 60 * 60 * 1000;
export const multiFriendQuerySchema = z.object({
  players: z.string().max(179).transform(value => value.split(","))
    .pipe(z.array(z.string().refine(validSteamId)).min(3).max(10))
    .refine(ids => new Set(ids).size === ids.length),
  minConnections: z.coerce.number().int().min(1).max(10),
  page: z.coerce.number().int().min(0).max(100000).default(0),
}).strict().refine(query => query.minConnections <= query.players.length)
  .transform(({ players, minConnections, page }): MultiFriendRequest => ({ playerIds: players, minConnections, page }));

interface MultiFriendSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fullyRepresented: Set<string>;
}

export function analyzeMultiFriends(
  run: CrawlRun,
  snapshot: MultiFriendSnapshot,
  request: MultiFriendRequest,
  nowMs: number,
): MultiFriendResponse {
  const selected = new Set(request.playerIds);
  const members = new Set(snapshot.nodes.map(node => node.id));
  if (request.playerIds.some(id => !members.has(id)))
    throw new HttpError(400, "分析玩家不属于该查询");

  // Use the same full-run enrichment as the main graph. Page membership must not
  // renumber communities or change a player's saved-graph degree.
  const enriched = graphResponse(run, snapshot.nodes, snapshot.edges, snapshot.nodes.length, Infinity).nodes;
  const byId = new Map(enriched.map(node => [node.id, node]));
  const canonicalEdges = new Map<string, GraphEdge>();
  const matches = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (edge.source === edge.target || !members.has(edge.source) || !members.has(edge.target)) continue;
    const [source, target] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
    const key = `${source}:${target}`;
    if (canonicalEdges.has(key)) continue;
    canonicalEdges.set(key, { id: key, source, target });
    const sourceSelected = selected.has(source), targetSelected = selected.has(target);
    if (sourceSelected === targetSelected) continue;
    const candidateId = sourceSelected ? target : source;
    const selectedId = sourceSelected ? source : target;
    if (!matches.has(candidateId)) matches.set(candidateId, new Set());
    matches.get(candidateId)!.add(selectedId);
  }

  const candidates = [...matches].filter(([, connected]) => connected.size >= request.minConnections)
    .map(([id, connected]) => ({ player: byId.get(id)!, matchedIds: [...connected].sort(), count: connected.size }))
    .sort((left, right) => right.count - left.count || left.player.id.localeCompare(right.player.id));
  const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const page = Math.min(request.page, pages - 1);
  const rows = candidates.slice(page * pageSize, (page + 1) * pageSize);
  const pageIds = new Set(rows.map(row => row.player.id));
  const complete = request.playerIds.every(id => {
    const player = byId.get(id)!;
    const fetchedAt = player.fetchedAt === null ? Number.NaN : Date.parse(player.fetchedAt);
    return player.fetchStatus === "ok" && fetchedAt <= nowMs && nowMs - fetchedAt < dayMs
      && snapshot.fullyRepresented.has(id);
  });
  return {
    runId: run.id,
    playerIds: [...request.playerIds],
    minConnections: request.minConnections,
    rows,
    total: candidates.length,
    page,
    pages,
    pageSize,
    nodes: [...request.playerIds.map(id => byId.get(id)!), ...rows.map(row => row.player)],
    edges: [...canonicalEdges.values()].filter(edge =>
      (selected.has(edge.source) && pageIds.has(edge.target)) || (pageIds.has(edge.source) && selected.has(edge.target)),
    ).sort((left, right) => left.id.localeCompare(right.id)),
    complete,
    message: complete
      ? "所选玩家的好友列表快照完整且在 24 小时内采集；结果仅基于该查询已知关系，不代表全部 Steam 网络。"
      : "所选玩家存在未采集、私密、失败、过期或未完整纳入图谱的好友列表；结果仅覆盖该查询已知关系。",
  };
}

export function registerMultiFriendRoutes(app: FastifyInstance) {
  app.get("/api/runs/:id/multi-friends", async request => {
    const { id } = request.params as { id: string };
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, "找不到该查询");
    const query = multiFriendQuerySchema.safeParse(request.query);
    if (!query.success) throw new HttpError(400, "请选择 3–10 位不同的有效玩家，并提供有效的连接数门槛和页码");
    const run = await getRun(id);
    const snapshot = await getGraphData(id, run);
    return analyzeMultiFriends(run, snapshot, query.data, Date.now());
  });
}
