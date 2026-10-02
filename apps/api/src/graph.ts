import type {
  AnalysisResult,
  CrawlRun,
  GraphEdge,
  GraphNode,
  GraphResponse,
  GraphFocus,
} from "../../../packages/shared/src/index.js";
import { z } from "zod";
import { validSteamId } from "./identity.js";
import { HttpError } from "./repository.js";
import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import { bidirectional } from "graphology-shortest-path";
export const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  depth: z.coerce.number().int().min(0).max(3).default(3),
  focusCenter: z.string().refine(validSteamId).optional(),
  focusHops: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2)])).optional(),
}).refine((query) => (query.focusCenter === undefined) === (query.focusHops === undefined), {
  message: "焦点玩家和跳数必须同时提供",
});
function buildGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const graph = new UndirectedGraph();
  nodes.forEach((node) => graph.addNode(node.id));
  edges.forEach((edge) => {
    if (
      edge.source !== edge.target &&
      graph.hasNode(edge.source) &&
      graph.hasNode(edge.target) &&
      !graph.hasEdge(edge.source, edge.target)
    )
      graph.addEdge(edge.source, edge.target);
  });
  return graph;
}
function enrichNodes(graph: UndirectedGraph, nodes: GraphNode[]) {
  const communities = graph.size
    ? louvain(graph, { randomWalk: false, getEdgeWeight: null })
    : Object.fromEntries(nodes.map((n, i) => [n.id, i]));
  return nodes.map((node) => ({
    ...node,
    degree: graph.degree(node.id),
    community: communities[node.id] ?? 0,
  }));
}
export function graphResponse(
  run: CrawlRun,
  nodes: GraphNode[],
  edges: GraphEdge[],
  limit: number,
  depth: number,
  focus?: GraphFocus,
): GraphResponse {
  const graph = buildGraph(nodes, edges);
  const enriched = enrichNodes(graph, nodes);
  const layers = new Map<number, number>(),
    counts = new Map<number, number>();
  enriched.forEach((n) => {
    layers.set(n.depth, (layers.get(n.depth) ?? 0) + 1);
    counts.set(n.community, (counts.get(n.community) ?? 0) + 1);
  });
  let candidates = enriched.filter((node) => node.depth <= depth);
  if (focus) {
    if (!graph.hasNode(focus.playerId)) throw new HttpError(400, "焦点玩家不属于该查询");
    const distances = new Map<string, number>([[focus.playerId, 0]]);
    const queue = [focus.playerId];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index], distance = distances.get(id)!;
      if (distance >= focus.hops) continue;
      for (const neighbor of graph.neighbors(id)) {
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, distance + 1);
        queue.push(neighbor);
      }
    }
    candidates = enriched.filter((node) => distances.has(node.id)).sort((a, b) =>
      distances.get(a.id)! - distances.get(b.id)! || a.id.localeCompare(b.id),
    );
  }
  const visible = candidates.slice(0, limit);
  const ids = new Set(visible.map((n) => n.id));
  return {
    run,
    nodes: visible,
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    totalNodes: nodes.length,
    totalEdges: edges.length,
    ...(focus ? { focus: { ...focus, totalNodes: candidates.length } } : {}),
    truncated: visible.length < nodes.length,
    stats: {
      layers: [...layers]
        .sort((a, b) => a[0] - b[0])
        .map(([depth, count]) => ({ depth, count })),
      communities: [...counts]
        .sort((a, b) => a[0] - b[0])
        .map(([id, size]) => ({ id, size })),
      topConnectors: [...enriched]
        .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((n) => ({ id: n.id, name: n.name, count: n.degree })),
      fetchedNodes: nodes.filter((n) => n.fetchStatus === "ok").length,
      privateNodes: nodes.filter((n) => n.fetchStatus === "private").length,
      failedNodes: nodes.filter((n) => n.fetchStatus === "error").length,
      frontierNodes: nodes.filter((n) => n.fetchStatus === "unknown").length,
    },
  };
}
export function analyze(
  kind: "mutual" | "path",
  from: string,
  to: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  fullyRepresented?: Set<string>,
): AnalysisResult {
  const graph = buildGraph(nodes, edges);
  if (!graph.hasNode(from) || !graph.hasNode(to))
    throw new Error("分析节点不属于该查询");
  const path = kind === "path" ? (bidirectional(graph, from, to) ?? []) : [];
  const right = new Set(graph.neighbors(to));
  const nodeIds =
    kind === "mutual"
      ? graph
          .neighbors(from)
          .filter((id) => right.has(id))
          .sort()
      : path;
  const ids = new Set([from, to, ...nodeIds]);
  const chosen = enrichNodes(graph, nodes).filter((n) => ids.has(n.id));
  const isComplete = (n: GraphNode) =>
    n.fetchStatus === "ok" &&
    n.fetchedAt !== null &&
    Date.now() - new Date(n.fetchedAt).getTime() < 24 * 60 * 60 * 1000 &&
    (fullyRepresented
      ? fullyRepresented.has(n.id)
      : n.friendCount !== null && graph.degree(n.id) >= n.friendCount);
  const complete = (
    kind === "mutual"
      ? nodes.filter((n) => n.id === from || n.id === to)
      : nodes
  ).every(isComplete);
  return {
    kind,
    nodeIds,
    path,
    nodes: chosen,
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    complete,
    message: complete
      ? "结果基于该查询已采集的图；不代表全部 Steam 网络。"
      : "存在未采集、私密或失败的好友列表；结果仅覆盖已知关系。",
  };
}
