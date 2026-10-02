import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Graph, type IElementEvent } from "@antv/g6";
import { Expand, Minus, Plus, LocateFixed } from "lucide-react";
import type { GraphViewportSnapshot } from "../../../../packages/shared/src/index";
import type { ExplorationEdge, ExplorationNode } from "../lib/graph-exploration";
import {
  createGraphTaskQueue,
  planGraphUpdate,
  type GraphPosition,
  type GraphSnapshot,
} from "../lib/graph-updates";
import {
  captureGraphViewport,
  rememberGraphPositions,
  restoreGraphViewport,
} from "../lib/graph-viewport";
import { Button } from "./ui";
import { useProfileHover } from "./ProfileHoverCard";

type GraphCommand = "in" | "out" | "fit" | "focus";

export interface NetworkGraphHandle {
  capture(): Promise<GraphViewportSnapshot | null>;
}

export default function NetworkGraph({
  ref,
  runId,
  nodes,
  edges,
  rootId,
  selectedId,
  highlightIds,
  layout,
  onSelect,
  onExpandCommunity,
  onRestoreComplete,
  viewRevision,
  restoreView,
}: {
  ref?: Ref<NetworkGraphHandle>;
  runId: string;
  nodes: ExplorationNode[];
  edges: ExplorationEdge[];
  rootId: string;
  selectedId: string | null;
  highlightIds: string[];
  layout: string;
  onSelect: (id: string) => void;
  onExpandCommunity?: (id: number) => void;
  onRestoreComplete?: (key: string) => void;
  viewRevision?: string;
  restoreView?: { key: string; snapshot: GraphViewportSnapshot };
}) {
  const container = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<{
    sync: () => void;
    states: () => void;
    command: (kind: GraphCommand) => void;
    capture: () => Promise<GraphViewportSnapshot | null>;
  } | null>(null);
  const latest = useRef({ nodes, edges, selectedId, highlightIds, viewRevision, restoreView });
  latest.current = { nodes, edges, selectedId, highlightIds, viewRevision, restoreView };
  const restoredKeys = useRef(new Set<string>());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const expandRef = useRef(onExpandCommunity);
  expandRef.current = onExpandCommunity;
  const restoredRef = useRef(onRestoreComplete);
  restoredRef.current = onRestoreComplete;
  const hover = useProfileHover();
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const [error, setError] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({
    capture: () => sessionRef.current?.capture() ?? Promise.resolve(null),
  }), []);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let rendered = false;
    let dirty = false;
    let dragging = false;
    let hoveredId: string | null = null;
    let commandId = 0;
    let appliedRevision = latest.current.viewRevision;
    let applied: GraphSnapshot = { nodes: [], edges: [] };
    const positions = new Map<string, GraphPosition>();
    setError(null);

    // An old asynchronous render can finish safely in its own detached mount
    // while a new run/layout starts; it never touches the new graph's canvas.
    const mount = document.createElement("div");
    mount.style.width = "100%";
    mount.style.height = "100%";
    host.appendChild(mount);
    const { width, height } = host.getBoundingClientRect();
    const graph = new Graph({
      container: mount,
      width,
      height,
      animation: false,
      padding: 60,
      node: {
        type: "circle",
        state: {
          selected: {
            stroke: "#d8fc96",
            lineWidth: 4,
            halo: true,
            haloFill: "#b8ed77",
            haloFillOpacity: 0.2,
            labelFill: "#efffdb",
            labelOpacity: 1,
          },
          highlight: {
            stroke: "#d8fc96",
            lineWidth: 3,
            halo: true,
            haloFill: "#b8ed77",
            haloFillOpacity: 0.12,
            labelOpacity: 1,
          },
          hover: { labelOpacity: 1, labelFill: "#e7f4ff", lineWidth: 3 },
          dim: { opacity: 0.23 },
        },
      },
      edge: {
        type: "line",
        style: {
          stroke: "#355269",
          lineWidth: 1,
          opacity: 0.5,
          // Edges are display-only; let pointer events reach the canvas for panning.
          pointerEvents: "none",
        },
        state: {
          highlight: { stroke: "#b8ed77", lineWidth: 2, opacity: 0.9 },
          dim: { opacity: 0.09 },
        },
      },
      layout:
        layout === "radial"
          ? undefined
          : { type: layout, nodeSize: 58, preventOverlap: true },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        {
          type: "drag-element",
          // G6 also ends dragging on native blur/contextmenu, which do not
          // emit node:dragend. Flush deferred data in all completion paths.
          onFinish: () => {
            dragging = false;
            sync();
          },
        },
      ],
    });
    const queue = createGraphTaskQueue((cause) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : "图谱渲染失败");
    });
    const applyStates = async () => {
      if (!rendered || disposed) return;
      const { selectedId, highlightIds } = latest.current;
      const highlight = new Set(highlightIds);
      const states: Record<string, string[]> = {};
      const includeChanged = (id: string, next: string[]) => {
        const current = graph.getElementState(id);
        if (
          current.length !== next.length ||
          current.some((state, index) => state !== next[index])
        ) {
          states[id] = next;
        }
      };
      for (const node of applied.nodes) {
        const next =
          node.id === selectedId
            ? ["selected"]
            : highlight.has(node.id)
              ? ["highlight"]
              : highlight.size
                ? ["dim"]
                : [];
        if (node.id === hoveredId) next.push("hover");
        includeChanged(node.id, next);
      }
      for (const edge of applied.edges) {
        includeChanged(
          edge.id,
          highlight.has(edge.source) && highlight.has(edge.target)
            ? ["highlight"]
            : highlight.size
              ? ["dim"]
              : [],
        );
      }
      if (Object.keys(states).length)
        await graph.setElementState(states, false);
    };
    const scheduleStates = () => {
      void queue.enqueue("states", applyStates);
    };
    const sync = () => {
      void queue.enqueue("data", async () => {
        if (dragging) return;
        const next = latest.current;
        if (!rendered && !next.nodes.length) return;
        if (rendered) rememberGraphPositions(graph, positions);
        const patch = planGraphUpdate(applied, next, rootId, layout, positions);
        if (patch.changed) {
          graph.removeData(patch.remove);
          graph.addData(patch.add);
          graph.updateData(patch.update);
          applied = next;
          dirty = true;
        }
        const firstRender = !rendered;
        if (!rendered) {
          await graph.render();
          if (disposed) return;
          rendered = true;
          dirty = false;
        } else if (dirty) {
          // draw updates elements without rerunning layout or fitting the camera.
          await graph.draw();
          dirty = false;
        }
        if (disposed) return;
        const restore = next.restoreView;
        const restoreKey = restore && `${runId}:${restore.key}`;
        if (restore && restoreKey && !restoredKeys.current.has(restoreKey)) {
          const restoredCamera = await restoreGraphViewport(graph, restore.snapshot, positions, () => disposed);
          if (disposed) return;
          if (!restoredCamera) await graph.fitView(undefined, false);
          if (disposed) return;
          restoredKeys.current.add(restoreKey);
          restoredRef.current?.(restore.key);
        } else if (firstRender || next.viewRevision !== appliedRevision) {
          await graph.fitView(undefined, false);
        }
        appliedRevision = next.viewRevision;
        if (disposed) return;
        if (hoveredId && !next.nodes.some((node) => node.id === hoveredId)) {
          hoveredId = null;
          hoverRef.current.close();
        }
        await applyStates();
        if (!disposed) setError(null);
      });
    };
    const showProfile = (id: string, immediate = false) => {
      if (!rendered || disposed) return;
      const node = latest.current.nodes.find((item) => item.id === id);
      // Community IDs are local graph projections, never Steam profiles.
      if (!node || node.kind === "community") return;
      const [x, y] = graph.getClientByCanvas(graph.getElementPosition(id));
      const radius =
        (node.id === rootId ? 31 : (36 + Math.min(node.degree, 15)) / 2) *
        graph.getZoom();
      hoverRef.current.show(
        node,
        {
          left: x - radius,
          right: x + radius,
          top: y - radius,
          bottom: y + radius,
        },
        immediate,
      );
    };
    graph.on("node:click", (event) => {
      if (disposed) return;
      const target = (event as IElementEvent).target;
      if (target?.id) {
        const id = String(target.id);
        const node = applied.nodes.find((item) => item.id === id);
        if (!node) return;
        if (node.kind === "community") {
          hoverRef.current.close();
          expandRef.current?.(node.community);
          return;
        }
        selectRef.current(id);
        if ((event as IElementEvent).pointerType === "touch")
          showProfile(id, true);
      }
    });
    graph.on("node:pointerenter", (event) => {
      if (disposed) return;
      hoveredId = String((event as IElementEvent).target.id);
      if ((event as IElementEvent).pointerType !== "touch")
        showProfile(hoveredId);
      scheduleStates();
    });
    graph.on("node:pointerleave", (event) => {
      if (disposed) return;
      if ((event as IElementEvent).pointerType !== "touch")
        hoverRef.current.leave();
      if (hoveredId === String((event as IElementEvent).target.id))
        hoveredId = null;
      scheduleStates();
    });
    graph.on("canvas:click", () => hoverRef.current.close());
    graph.on("node:dragstart", () => {
      dragging = true;
      hoverRef.current.close();
    });
    graph.on("canvas:dragstart", () => hoverRef.current.close());
    const observer = new ResizeObserver(() => {
      void queue.enqueue("resize", async () => {
        const { width, height } = host.getBoundingClientRect();
        const [currentWidth, currentHeight] = graph.getSize();
        if (width <= 0 || height <= 0 || (width === currentWidth && height === currentHeight)) return;
        graph.setSize(width, height);
        // A resized viewport should show the whole graph; data refreshes still
        // preserve the camera and dragged node positions in sync().
        if (rendered && !disposed) await graph.fitView(undefined, false);
      });
    });
    observer.observe(host);
    sessionRef.current = {
      sync,
      states: scheduleStates,
      capture() {
        // Flush pending data first; requests have their own keys and are never
        // coalesced away. Disposal settles all captures with null immediately.
        sync();
        return queue.request(() => rendered && !disposed
          ? captureGraphViewport(graph, positions)
          : null);
      },
      command(kind) {
        void queue.enqueue(`command-${commandId++}`, async () => {
          if (!rendered) return;
          const selected = latest.current.selectedId;
          if (kind === "fit") await graph.fitView(undefined, false);
          else if (kind === "focus") {
            if (
              selected &&
              applied.nodes.some((node) => node.id === selected)
            ) {
              await graph.focusElement(selected, false);
            }
          } else
            await graph.zoomTo(
              graph.getZoom() * (kind === "in" ? 1.25 : 0.8),
              false,
            );
        });
      },
    };
    sync();
    return () => {
      disposed = true;
      observer.disconnect();
      sessionRef.current = null;
      hoverRef.current.close();
      mount.remove();
      // G6's render/draw resumes after await; destroying the runtime earlier
      // would let those continuations access a destroyed canvas/model.
      void queue.dispose(() => graph.destroy()).catch(() => undefined);
    };
  }, [runId, rootId, layout]);

  useEffect(() => {
    sessionRef.current?.sync();
  }, [nodes, edges, viewRevision, restoreView]);
  useEffect(() => {
    sessionRef.current?.states();
  }, [selectedId, highlightIds]);
  const command = (kind: GraphCommand) => sessionRef.current?.command(kind);
  return (
    <>
      <div
        className="graph-renderer"
        ref={container}
        aria-label="Steam 好友关系图谱，拖动平移、滚轮缩放"
      />
      {error && (
        <div className="graph-error" role="alert">
          图谱暂时无法显示：{error}
        </div>
      )}
      <div className="canvas-controls">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => command("in")}
          title="放大"
          aria-label="放大"
        >
          <Plus size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => command("out")}
          title="缩小"
          aria-label="缩小"
        >
          <Minus size={17} />
        </Button>
        <span className="control-divider" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => command("fit")}
          title="适应画布"
          aria-label="适应画布"
        >
          <Expand size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={!selectedId}
          onClick={() => command("focus")}
          title="定位选中节点"
          aria-label="定位选中节点"
        >
          <LocateFixed size={17} />
        </Button>
      </div>
    </>
  );
}
