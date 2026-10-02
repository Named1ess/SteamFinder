import { useEffect, useRef, useState } from "react";
import { Graph, type IElementEvent } from "@antv/g6";
import { Expand, Minus, Plus, LocateFixed } from "lucide-react";
import type {
  GraphNode,
  GraphEdge,
} from "../../../../packages/shared/src/index";
import {
  createGraphTaskQueue,
  planGraphUpdate,
  type GraphPosition,
  type GraphSnapshot,
} from "../lib/graph-updates";
import { Button } from "./ui";
import { useProfileHover } from "./ProfileHoverCard";

type GraphCommand = "in" | "out" | "fit" | "focus";

export default function NetworkGraph({
  runId,
  nodes,
  edges,
  rootId,
  selectedId,
  highlightIds,
  layout,
  onSelect,
}: {
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootId: string;
  selectedId: string | null;
  highlightIds: string[];
  layout: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<{
    sync: () => void;
    states: () => void;
    command: (kind: GraphCommand) => void;
  } | null>(null);
  const latest = useRef({ nodes, edges, selectedId, highlightIds });
  latest.current = { nodes, edges, selectedId, highlightIds };
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const hover = useProfileHover();
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let rendered = false;
    let dirty = false;
    let dragging = false;
    let hoveredId: string | null = null;
    let commandId = 0;
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
        if (rendered) {
          for (const node of graph.getNodeData()) {
            const [x, y] = graph.getElementPosition(node.id);
            if (Number.isFinite(x) && Number.isFinite(y))
              positions.set(node.id, { x, y });
          }
        }
        const patch = planGraphUpdate(applied, next, rootId, layout, positions);
        if (patch.changed) {
          graph.removeData(patch.remove);
          graph.addData(patch.add);
          graph.updateData(patch.update);
          applied = next;
          dirty = true;
        }
        if (!rendered) {
          await graph.render();
          if (disposed) return;
          rendered = true;
          dirty = false;
          await graph.fitView(undefined, false);
        } else if (dirty) {
          // draw updates elements without rerunning layout or fitting the camera.
          await graph.draw();
          dirty = false;
        }
        if (disposed) return;
        await applyStates();
        if (!disposed) setError(null);
      });
    };
    const showProfile = (id: string, immediate = false) => {
      if (!rendered || disposed) return;
      const node = latest.current.nodes.find((item) => item.id === id);
      if (!node) return;
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
        selectRef.current(String(target.id));
        if ((event as IElementEvent).pointerType === "touch")
          showProfile(String(target.id), true);
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
      void queue.enqueue("resize", () => {
        const { width, height } = host.getBoundingClientRect();
        if (width > 0 && height > 0) graph.setSize(width, height);
      });
    });
    observer.observe(host);
    sessionRef.current = {
      sync,
      states: scheduleStates,
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
  }, [nodes, edges]);
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
