import type {
  GraphEdge,
  GraphNode,
  PlayerSearchOption,
  RelationshipLayer,
  RelationshipScoreRow,
  RelationshipScoresResponse,
} from "../../../packages/shared/src/index.js";

type RelationshipGraphScores = Pick<
  RelationshipScoresResponse,
  "center" | "totalPlayers" | "totalEdges" | "coverage" | "layers" | "rows"
>;

const dayMs = 24 * 60 * 60 * 1000;
const round = (value: number) => Math.round(value * 10) / 10;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const playerOption = (node: GraphNode): PlayerSearchOption => ({
  id: node.id,
  name: node.name,
  avatar: node.avatar,
  profileUrl: node.profileUrl,
  depth: node.depth,
});

export function relationshipLayer(score: number | null): RelationshipLayer {
  if (score === null) return "unknown";
  if (score >= 60) return "core";
  if (score >= 35) return "close";
  if (score >= 15) return "connected";
  return "peripheral";
}

/**
 * Scores the entire observed undirected graph around one center. Raw evidence
 * metrics retain full precision; only components and their total round to 0.1.
 * totalPlayers and rows exclude the center. A supplied clock
 * makes coverage deterministic and keeps this computation independent of I/O.
 * Graph passes are O(V + E); sorting IDs and result rows costs O(V log V).
 */
export function scoreRelationshipGraph(
  centerId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  fullyRepresented: ReadonlySet<string>,
  nowMs: number,
): RelationshipGraphScores {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const center = byId.get(centerId);
  if (!center) throw new Error("关系中心不属于该查询");
  const ids = [...byId.keys()].sort(compareIds);
  const neighborSets = new Map(ids.map((id) => [id, new Set<string>()]));
  let totalEdges = 0;
  for (const { source, target } of edges) {
    const sourceNeighbors = neighborSets.get(source);
    const targetNeighbors = neighborSets.get(target);
    if (
      source === target ||
      !sourceNeighbors ||
      !targetNeighbors ||
      sourceNeighbors.has(target)
    )
      continue;
    sourceNeighbors.add(target);
    targetNeighbors.add(source);
    totalEdges++;
  }

  // Transpose in ID order to get sorted adjacency without sorting every edge
  // list. Stable summation makes input edge order irrelevant to raw metrics.
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const id of ids) {
    for (const neighbor of neighborSets.get(id)!)
      adjacency.get(neighbor)!.push(id);
  }
  const centerNeighbors = adjacency.get(centerId)!;
  const directIds = neighborSets.get(centerId)!;
  const weights = new Map<string, number>();
  const completeLists = new Set<string>();
  for (const id of ids) {
    const node = byId.get(id)!;
    const publicCount = Number.isFinite(node.friendCount)
      ? (node.friendCount ?? 0)
      : 0;
    weights.set(id, 1 / Math.max(1, adjacency.get(id)!.length, publicCount));
    const fetchedAt =
      node.fetchedAt === null ? Number.NaN : Date.parse(node.fetchedAt);
    if (
      node.fetchStatus === "ok" &&
      fetchedAt <= nowMs &&
      nowMs - fetchedAt < dayMs &&
      fullyRepresented.has(id)
    ) {
      completeLists.add(id);
    }
  }
  const completeNeighborhood = (id: string) =>
    completeLists.has(id) &&
    adjacency.get(id)!.every((neighbor) => completeLists.has(neighbor));
  const centerComplete = completeNeighborhood(centerId);

  const distances = new Map([[centerId, 0]]);
  const queue = [centerId];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const neighbor of adjacency.get(id)!) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distances.get(id)! + 1);
      queue.push(neighbor);
    }
  }

  // A[b] is the resource allocation over two-edge walks center -> a -> b.
  // Counts and bounded examples share the same pass over center's neighbors.
  const weightedMutual = new Map<string, number>();
  const mutualCounts = new Map<string, number>();
  const examples = new Map<string, string[]>();
  for (const intermediary of centerNeighbors) {
    const weight = weights.get(intermediary)!;
    for (const id of adjacency.get(intermediary)!) {
      if (id === centerId) continue;
      weightedMutual.set(id, (weightedMutual.get(id) ?? 0) + weight);
      mutualCounts.set(id, (mutualCounts.get(id) ?? 0) + 1);
      const common = examples.get(id) ?? [];
      if (common.length < 5) common.push(intermediary);
      examples.set(id, common);
    }
  }

  const rows: RelationshipScoreRow[] = [];
  for (const id of ids) {
    if (id === centerId) continue;
    const neighbors = adjacency.get(id)!;
    const isDirect = directIds.has(id);
    const mutualCount = mutualCounts.get(id) ?? 0;
    const ra2 = weightedMutual.get(id) ?? 0;
    const unionSize =
      centerNeighbors.length +
      neighbors.length -
      (isDirect ? 2 : 0) -
      mutualCount;
    const overlap = unionSize > 0 ? mutualCount / unionSize : 0;
    let ra3 = 0;
    let threeHopPaths = 0;
    for (const intermediary of neighbors) {
      if (intermediary === centerId) continue;
      // Exclude center -> target -> b -> target when target is a direct
      // neighbor; b=center is excluded above. All four vertices are distinct.
      ra3 +=
        weights.get(intermediary)! *
        Math.max(
          0,
          (weightedMutual.get(intermediary) ?? 0) -
            (isDirect ? weights.get(id)! : 0),
        );
      threeHopPaths +=
        (mutualCounts.get(intermediary) ?? 0) - (isDirect ? 1 : 0);
    }
    const components = {
      direct: isDirect ? 15 : 0,
      mutual: round((45 * ra2) / (ra2 + 1)),
      overlap: round(25 * overlap),
      indirect: round((15 * ra3) / (ra3 + 1)),
    };
    const distance = distances.get(id) ?? null;
    const score =
      distance === null
        ? null
        : round(
            components.direct +
              components.mutual +
              components.overlap +
              components.indirect,
          );
    rows.push({
      player: playerOption(byId.get(id)!),
      score,
      layer: relationshipLayer(score),
      distance,
      isDirect,
      mutualCount,
      weightedMutual: ra2,
      overlap,
      threeHopPaths,
      weightedIndirect: ra3,
      components,
      commonFriends: (examples.get(id) ?? []).map((common) =>
        playerOption(byId.get(common)!),
      ),
      evidence:
        centerComplete && completeNeighborhood(id) ? "complete" : "partial",
    });
  }
  rows.sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      b.mutualCount - a.mutualCount ||
      (a.distance ?? Number.POSITIVE_INFINITY) -
        (b.distance ?? Number.POSITIVE_INFINITY) ||
      compareIds(a.player.id, b.player.id),
  );
  const counts = new Map<RelationshipLayer, number>();
  for (const row of rows)
    counts.set(row.layer, (counts.get(row.layer) ?? 0) + 1);
  const layers: RelationshipScoresResponse["layers"] = [
    { id: "core", label: "核心层", minScore: 60, maxScore: 100, count: 0 },
    { id: "close", label: "紧密层", minScore: 35, maxScore: 59.9, count: 0 },
    {
      id: "connected",
      label: "连接层",
      minScore: 15,
      maxScore: 34.9,
      count: 0,
    },
    {
      id: "peripheral",
      label: "外围层",
      minScore: 0,
      maxScore: 14.9,
      count: 0,
    },
    {
      id: "unknown",
      label: "暂无已知路径",
      minScore: null,
      maxScore: null,
      count: 0,
    },
  ];
  for (const layer of layers) layer.count = counts.get(layer.id) ?? 0;
  return {
    center: playerOption(center),
    totalPlayers: rows.length,
    totalEdges,
    coverage: { completeLists: completeLists.size, totalLists: ids.length },
    layers,
    rows,
  };
}
