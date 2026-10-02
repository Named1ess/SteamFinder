import type { Graph } from "@antv/g6";
import type { GraphViewportSnapshot } from "../../../../packages/shared/src/index";
import type { GraphPosition } from "./graph-updates";

type NodeReader = { getNodeData(): { id: string }[] };
type CaptureGraph = NodeReader & Pick<Graph, "getElementPosition" | "getViewportCenter" | "getZoom">;
type RestoreGraph = NodeReader & Pick<Graph,
  "updateNodeData" | "draw" | "zoomTo" | "getSize" | "getViewportByCanvas" | "translateBy"
>;

function finitePosition(point: GraphPosition) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Merge the live positions into the cache, retaining nodes hidden by filters. */
export function rememberGraphPositions(
  graph: NodeReader & Pick<Graph, "getElementPosition">,
  positions: Map<string, GraphPosition>,
) {
  for (const node of graph.getNodeData()) {
    const [x, y] = graph.getElementPosition(node.id);
    if (finitePosition({ x, y })) positions.set(node.id, { x, y });
  }
}

export function captureGraphViewport(
  graph: CaptureGraph,
  positions: Map<string, GraphPosition>,
): GraphViewportSnapshot {
  rememberGraphPositions(graph, positions);
  const [x, y] = graph.getViewportCenter();
  const zoom = graph.getZoom();
  return {
    positions: Object.fromEntries([...positions]
      .filter(([, point]) => finitePosition(point))
      .map(([id, point]) => [id, { ...point }])),
    viewport: finitePosition({ x, y }) && Number.isFinite(zoom) && zoom > 0
      ? { center: { x, y }, zoom }
      : null,
  };
}

/** Called inside the render queue, after the requested graph data is drawn. */
export async function restoreGraphViewport(
  graph: RestoreGraph,
  snapshot: GraphViewportSnapshot,
  positions: Map<string, GraphPosition>,
  disposed: () => boolean,
) {
  if (disposed()) return false;
  positions.clear();
  for (const [id, point] of Object.entries(snapshot.positions)) {
    if (finitePosition(point)) positions.set(id, { ...point });
  }
  const visible = graph.getNodeData().flatMap(({ id }) => {
    const point = positions.get(id);
    return point ? [{ id, style: { ...point } }] : [];
  });
  if (visible.length) {
    graph.updateNodeData(visible);
    await graph.draw();
  }
  const camera = snapshot.viewport;
  if (disposed() || !camera || !finitePosition(camera.center) ||
      !Number.isFinite(camera.zoom) || camera.zoom <= 0) return false;
  await graph.zoomTo(camera.zoom, false);
  if (disposed()) return false;
  const [width, height] = graph.getSize();
  const [x, y] = graph.getViewportByCanvas([camera.center.x, camera.center.y]);
  // G6 translations are viewport offsets. Convert the saved world point only
  // after zooming, then place it at the center of the current canvas dimensions.
  await graph.translateBy([width / 2 - x, height / 2 - y], false);
  return !disposed();
}
