import type { EdgeData, NodeData } from "@antv/g6";
import type {
  GraphEdge,
  GraphNode,
} from "../../../../packages/shared/src/index";
import { depthRingPositions, graphInitials } from "./graph";

const colors = [
  "#61d7c0",
  "#8ba1f6",
  "#f0bd77",
  "#cd9aee",
  "#78bddb",
  "#b1d577",
];

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphPosition {
  x: number;
  y: number;
}

function nodeData(node: GraphNode, rootId: string, crowded: boolean): NodeData {
  const root = node.id === rootId;
  return {
    id: node.id,
    data: { ...node },
    // Existing nodes deliberately receive no coordinates: G6 owns their layout
    // and drag positions. Empty strings also clear a previously rendered icon.
    style: {
      size: root ? 62 : 36 + Math.min(node.degree, 15),
      fill: "#17283a",
      stroke:
        node.fetchStatus === "private"
          ? "#a78c68"
          : colors[node.community % colors.length],
      lineWidth: root ? 3 : 1.7,
      labelText: node.name,
      labelFill: "#b6c5d8",
      labelFontSize: 11,
      labelPlacement: "bottom",
      labelMaxWidth: 150,
      labelOpacity: crowded && !root ? 0 : 1,
      iconText: node.avatar ? "" : graphInitials(node.name),
      iconSrc: node.avatar || "",
      iconWidth: root ? 48 : 28,
      iconHeight: root ? 48 : 28,
      iconFontSize: root || node.name.includes("演示玩家") ? 16 : 11,
      iconFill: "#edf7ff",
      halo: root,
      haloFill: "#61d7c0",
      haloFillOpacity: 0.09,
    },
  };
}

/** Compute model mutations without replacing coordinates or unchanged data. */
export function planGraphUpdate(
  previous: GraphSnapshot,
  next: GraphSnapshot,
  rootId: string,
  layout: string,
  positions: ReadonlyMap<string, GraphPosition>,
) {
  const patch = {
    changed: false,
    add: { nodes: [] as NodeData[], edges: [] as EdgeData[] },
    update: { nodes: [] as NodeData[] },
    remove: { nodes: [] as string[], edges: [] as string[] },
  };
  const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const oldEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const newEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  const crowded = next.nodes.length > 30;
  const crowdingChanged = crowded !== previous.nodes.length > 30;

  for (const node of next.nodes) {
    const old = oldNodes.get(node.id);
    if (!old) patch.add.nodes.push(nodeData(node, rootId, crowded));
    else if (
      (crowdingChanged && node.id !== rootId) ||
      (Object.keys(node) as (keyof GraphNode)[]).some(
        (key) => node[key] !== old[key],
      )
    )
      patch.update.nodes.push(nodeData(node, rootId, crowded));
  }
  for (const node of previous.nodes) {
    if (!newNodes.has(node.id)) patch.remove.nodes.push(node.id);
  }
  for (const edge of previous.edges) {
    const nextEdge = newEdges.get(edge.id);
    if (
      !nextEdge ||
      nextEdge.source !== edge.source ||
      nextEdge.target !== edge.target
    ) {
      patch.remove.edges.push(edge.id);
    }
  }
  for (const edge of next.edges) {
    const old = oldEdges.get(edge.id);
    if (!old || old.source !== edge.source || old.target !== edge.target) {
      patch.add.edges.push({ ...edge });
    }
  }

  if (patch.add.nodes.length) {
    const rings = depthRingPositions(next.nodes, rootId);
    const root = positions.get(rootId) ?? { x: 0, y: 0 };
    const placed = new Map<string, GraphPosition>();
    const cells = new Map<string, GraphPosition[]>();
    const cellSize = 72;
    const reserve = (point: GraphPosition) => {
      const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
      const cell = cells.get(key) ?? [];
      cell.push(point);
      cells.set(key, cell);
    };
    const collides = (point: GraphPosition) => {
      const x = Math.floor(point.x / cellSize),
        y = Math.floor(point.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (
            cells
              .get(`${x + dx},${y + dy}`)
              ?.some(
                (other) =>
                  Math.hypot(other.x - point.x, other.y - point.y) <
                  cellSize - 0.001,
              )
          )
            return true;
        }
      }
      return false;
    };
    for (const id of newNodes.keys()) {
      const point = positions.get(id);
      if (point) {
        placed.set(id, point);
        reserve(point);
      }
    }
    const neighbors = new Map<string, string[]>();
    for (const edge of next.edges) {
      for (const [id, neighbor] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ]) {
        const ids = neighbors.get(id) ?? [];
        ids.push(neighbor);
        neighbors.set(id, ids);
      }
    }
    for (const node of patch.add.nodes) {
      let point = positions.get(node.id);
      if (!point) {
        const ring = rings.get(node.id) ?? { x: 0, y: 0 };
        const neighbor =
          layout === "radial"
            ? undefined
            : neighbors
                .get(node.id)
                ?.map((id) => placed.get(id))
                .find((position) => position !== undefined);
        const seed = neighbor
          ? { x: neighbor.x + 100, y: neighbor.y }
          : { x: root.x + ring.x, y: root.y + ring.y };
        point = seed;
        for (let step = 1; collides(point); step++) {
          const radius = cellSize * Math.sqrt(step);
          const angle = step * 2.399963229728653;
          point = {
            x: seed.x + radius * Math.cos(angle),
            y: seed.y + radius * Math.sin(angle),
          };
        }
        placed.set(node.id, point);
        reserve(point);
      }
      node.style = { ...node.style, ...point };
    }
  }
  patch.changed = Boolean(
    patch.add.nodes.length ||
      patch.add.edges.length ||
      patch.update.nodes.length ||
      patch.remove.nodes.length ||
      patch.remove.edges.length,
  );
  return patch;
}

/** Serialize G6's asynchronous rendering and coalesce work by its purpose. */
export function createGraphTaskQueue(onError: (error: unknown) => void) {
  const pending = new Map<string, () => void | Promise<void>>();
  let closed = false;
  let running: Promise<void> | null = null;
  let disposing: Promise<void> | undefined;
  return {
    enqueue(key: string, action: () => void | Promise<void>): Promise<void> {
      if (closed) return Promise.resolve();
      pending.set(key, action);
      running ??= Promise.resolve().then(async () => {
        try {
          while (!closed && pending.size) {
            const [nextKey, nextAction] = pending.entries().next().value!;
            pending.delete(nextKey);
            try {
              await nextAction();
            } catch (error) {
              onError(error);
            }
          }
        } finally {
          running = null;
        }
      });
      return running;
    },
    dispose(cleanup: () => void): Promise<void> {
      closed = true;
      pending.clear();
      disposing ??= (running ?? Promise.resolve()).then(cleanup);
      return disposing;
    },
  };
}
