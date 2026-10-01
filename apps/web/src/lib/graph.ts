import type {
  AnalysisResult,
  GraphEdge,
  GraphNode,
  GraphResponse,
} from "../../../../packages/shared/src/index";

export interface AnalysisSelection {
  runId: string | null;
  from: string;
  to: string;
}
export function matchesAnalysisSelection(
  submitted: AnalysisSelection,
  latest: AnalysisSelection,
) {
  return (
    submitted.runId === latest.runId &&
    submitted.from === latest.from &&
    submitted.to === latest.to
  );
}

export function mergeGraph(
  base: Pick<GraphResponse, "nodes" | "edges"> | undefined,
  analysis?: AnalysisResult | null,
) {
  const nodes = new Map<string, GraphNode>(
    (base?.nodes ?? []).map((node) => [node.id, node]),
  );
  for (const node of analysis?.nodes ?? []) nodes.set(node.id, node);
  const edges = new Map<string, GraphEdge>(
    (base?.edges ?? []).map((edge) => [edge.id, edge]),
  );
  for (const edge of analysis?.edges ?? []) edges.set(edge.id, edge);
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(
      (edge) => nodes.has(edge.source) && nodes.has(edge.target),
    ),
  };
}
export function initials(name: string) {
  return [...name.trim()].slice(0, 2).join("").toUpperCase() || "?";
}
export function graphInitials(name: string) {
  if (name.includes("演示玩家")) {
    if (name.includes("起点")) return "起点";
    const number =
      name.match(/演示玩家\s*(\d+)/u)?.[1] ?? name.match(/虚构\s*(\d+)/u)?.[1];
    if (number) return number;
  }
  return initials(name);
}
/** Stable depth rings. Circumference grows with population so adjacent nodes have room. */
export function depthRingPositions(
  nodes: GraphNode[],
  rootId: string,
  spacing = 72,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const rings = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    if (node.id === rootId) {
      positions.set(node.id, { x: 0, y: 0 });
      continue;
    }
    const depth = Math.max(1, node.depth);
    rings.set(depth, [...(rings.get(depth) ?? []), node]);
  }
  let previousRadius = 0;
  for (const [depth, ring] of [...rings].sort(([a], [b]) => a - b)) {
    ring.sort((a, b) => a.community - b.community || a.id.localeCompare(b.id));
    const radius = Math.max(
      depth * 170,
      previousRadius + 170,
      ring.length > 1 ? spacing / (2 * Math.sin(Math.PI / ring.length)) : 0,
    );
    previousRadius = radius;
    ring.forEach((node, index) => {
      const angle =
        (index / ring.length) * Math.PI * 2 -
        Math.PI / 2 +
        (depth % 2 ? 0 : 0.15);
      positions.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    });
  }
  return positions;
}
export const activeRun = (status?: string) =>
  status === "running" || status === "queued";
export const statusText: Record<string, string> = {
  queued: "等待采集",
  running: "采集中",
  completed: "已完成",
  limited: "已达上限",
  failed: "采集失败",
  cancelled: "已暂停",
};
export const fetchText: Record<string, string> = {
  unknown: "未采集 / 边界",
  ok: "好友列表已采集",
  private: "好友列表不可访问",
  error: "采集失败",
};
export function relativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}
