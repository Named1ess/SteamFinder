import type {
  GraphEdge,
  GraphNode,
} from "../../../../packages/shared/src/index";

export interface ExplorationNode extends GraphNode {
  kind?: "community";
  memberIds?: string[];
  memberCount?: number;
  internalEdges?: number;
}

export interface ExplorationEdge extends GraphEdge {
  count?: number;
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const orderedPair = (a: string, b: string): [string, string] =>
  compareIds(a, b) <= 0 ? [a, b] : [b, a];
const compareEdges = (a: GraphEdge, b: GraphEdge) =>
  compareIds(a.id, b.id) ||
  compareIds(a.source, b.source) ||
  compareIds(a.target, b.target);

/** Fold the displayed graph only; original players and friendships remain intact. */
export function projectCommunities(
  nodes: GraphNode[],
  edges: GraphEdge[],
  collapsed: number[],
  protectedIds: string[] = [],
): {
  nodes: ExplorationNode[];
  edges: ExplorationEdge[];
  communities: Array<{
    id: number;
    memberIds: string[];
    count: number;
    collapsed: boolean;
  }>;
  representedPlayers: number;
} {
  const players = new Map(nodes.map((node) => [node.id, node]));
  const members = new Map<number, GraphNode[]>();
  for (const node of [...players.values()].sort((a, b) => compareIds(a.id, b.id))) {
    const group = members.get(node.community) ?? [];
    group.push(node);
    members.set(node.community, group);
  }

  const requested = new Set(collapsed);
  const protectedPlayers = new Set(protectedIds);
  const communities = [...members]
    .sort(([a], [b]) => a - b)
    .map(([id, group]) => ({
      id,
      memberIds: group.map((node) => node.id),
      count: group.length,
      collapsed:
        requested.has(id) &&
        group.length > 1 &&
        !group.some((node) => protectedPlayers.has(node.id)),
    }));

  const representatives = new Map<string, string>();
  const projectedNodes = new Map<string, ExplorationNode>();
  for (const community of communities) {
    const group = members.get(community.id)!;
    if (community.collapsed) {
      const id = `community:${community.id}`;
      projectedNodes.set(id, {
        id,
        name: `社群 ${community.id + 1} · ${community.count} 人`,
        avatar: null,
        profileUrl: "",
        depth: group.reduce(
          (minimum, node) => Math.min(minimum, node.depth),
          Infinity,
        ),
        fetchStatus: "unknown",
        fetchedAt: null,
        friendCount: null,
        degree: 0,
        community: community.id,
        kind: "community",
        memberIds: [...community.memberIds],
        memberCount: community.count,
        internalEdges: 0,
      });
      for (const member of group) representatives.set(member.id, id);
    } else {
      for (const member of group) {
        representatives.set(member.id, member.id);
        projectedNodes.set(member.id, { ...member });
      }
    }
  }

  // JSON pairs keep IDs with separators distinct. Sorting picks a repeatable
  // original edge when the same undirected friendship occurs more than once.
  const friendships = new Set<string>();
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const projectedEdges = new Map<string, ExplorationEdge>();
  for (const edge of [...edges].sort(compareEdges)) {
    if (
      edge.source === edge.target ||
      !players.has(edge.source) ||
      !players.has(edge.target)
    ) {
      continue;
    }

    const originalPair = JSON.stringify(orderedPair(edge.source, edge.target));
    if (friendships.has(originalPair)) continue;
    friendships.add(originalPair);

    const source = representatives.get(edge.source)!;
    const target = representatives.get(edge.target)!;
    if (source === target) {
      const aggregate = projectedNodes.get(source)!;
      aggregate.internalEdges = (aggregate.internalEdges ?? 0) + 1;
      continue;
    }

    const pair = orderedPair(source, target);
    const key = JSON.stringify(pair);
    if (source === edge.source && target === edge.target) {
      projectedEdges.set(key, { ...edge });
    } else {
      const existing = projectedEdges.get(key);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
      } else {
        const baseId = `community-edge:${key}`;
        let id = baseId;
        let suffix = 1;
        while (edgeIds.has(id)) id = `${baseId}:${suffix++}`;
        edgeIds.add(id);
        projectedEdges.set(key, {
          id,
          source: pair[0],
          target: pair[1],
          count: 1,
        });
      }
    }
  }

  for (const edge of projectedEdges.values()) {
    for (const endpoint of [edge.source, edge.target]) {
      const node = projectedNodes.get(endpoint)!;
      if (node.kind === "community") node.degree += 1;
    }
  }
  for (const node of projectedNodes.values()) {
    if (node.kind === "community") node.degree = Math.max(1, node.degree);
  }

  return {
    nodes: [...projectedNodes.values()].sort((a, b) => compareIds(a.id, b.id)),
    edges: [...projectedEdges.values()].sort(compareEdges),
    communities,
    representedPlayers: players.size,
  };
}
