import { useEffect, useRef, useState } from "react";
import { Graph, type IElementEvent } from "@antv/g6";
import { Expand, Minus, Plus, LocateFixed } from "lucide-react";
import type {
  GraphNode,
  GraphEdge,
} from "../../../../packages/shared/src/index";
import { depthRingPositions, graphInitials } from "../lib/graph";
import { Button } from "./ui";
import { useProfileHover } from "./ProfileHoverCard";

const colors = [
  "#61d7c0",
  "#8ba1f6",
  "#f0bd77",
  "#cd9aee",
  "#78bddb",
  "#b1d577",
];
export default function NetworkGraph({
  nodes,
  edges,
  rootId,
  selectedId,
  highlightIds,
  layout,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootId: string;
  selectedId: string | null;
  highlightIds: string[];
  layout: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const selectRef = useRef(onSelect);
  const hover = useProfileHover();
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const [ready, setReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  selectRef.current = onSelect;
  useEffect(() => {
    if (!container.current || !nodes.length) return;
    let disposed = false;
    let rendered = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    const positions = depthRingPositions(nodes, rootId);
    const graph = new Graph({
      container: container.current,
      animation: false,
      autoFit: "view",
      padding: 60,
      data: {
        nodes: nodes.map((node) => ({
          id: node.id,
          data: { ...node },
          style: {
            ...(layout === "radial" ? positions.get(node.id) : {}),
            size: node.id === rootId ? 62 : 36 + Math.min(node.degree, 15),
            fill: "#17283a",
            stroke:
              node.fetchStatus === "private"
                ? "#a78c68"
                : colors[node.community % colors.length],
            lineWidth: node.id === rootId ? 3 : 1.7,
            labelText: node.name,
            labelFill: "#b6c5d8",
            labelFontSize: 11,
            labelPlacement: "bottom",
            labelMaxWidth: 150,
            labelOpacity: nodes.length > 30 && node.id !== rootId ? 0 : 1,
            iconText: node.avatar ? undefined : graphInitials(node.name),
            iconSrc: node.avatar || undefined,
            iconWidth: node.id === rootId ? 48 : 28,
            iconHeight: node.id === rootId ? 48 : 28,
            iconFontSize:
              node.id === rootId || node.name.includes("演示玩家") ? 16 : 11,
            iconFill: "#edf7ff",
            halo: node.id === rootId,
            haloFill: "#61d7c0",
            haloFillOpacity: 0.09,
          },
        })),
        edges: edges.map((edge) => ({ ...edge })),
      },
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
        style: { stroke: "#355269", lineWidth: 1, opacity: 0.5 },
        state: {
          highlight: { stroke: "#b8ed77", lineWidth: 2, opacity: 0.9 },
          dim: { opacity: 0.09 },
        },
      },
      layout:
        layout === "radial"
          ? undefined
          : { type: layout, nodeSize: 58, preventOverlap: true },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
    });
    graphRef.current = graph;
    const showProfile = (id: string, immediate = false) => {
      const node = nodes.find((item) => item.id === id);
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
      const target = (event as IElementEvent).target;
      if (target?.id) {
        selectRef.current(String(target.id));
        if ((event as IElementEvent).pointerType === "touch")
          showProfile(String(target.id), true);
      }
    });
    graph.on("node:pointerenter", (event) => {
      const id = String((event as IElementEvent).target.id);
      if ((event as IElementEvent).pointerType !== "touch") showProfile(id);
      void graph
        .setElementState(id, [
          ...graph.getElementState(id).filter((state) => state !== "hover"),
          "hover",
        ])
        .catch(() => undefined);
    });
    graph.on("node:pointerleave", (event) => {
      if ((event as IElementEvent).pointerType !== "touch")
        hoverRef.current.leave();
      const id = String((event as IElementEvent).target.id);
      void graph
        .setElementState(
          id,
          graph.getElementState(id).filter((state) => state !== "hover"),
        )
        .catch(() => undefined);
    });
    graph.on("canvas:click", () => hoverRef.current.close());
    graph.on("node:dragstart", () => hoverRef.current.close());
    graph.on("canvas:dragstart", () => hoverRef.current.close());
    const observer = new ResizeObserver(() => {
      if (disposed || !container.current) return;
      const { width, height } = container.current.getBoundingClientRect();
      if (width > 0 && height > 0) {
        graph.setSize(width, height);
        if (rendered) {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (!disposed) void graph.fitView().catch(() => undefined);
          }, 120);
        }
      }
    });
    observer.observe(container.current);
    graph
      .render()
      .then(() => {
        if (!disposed) {
          rendered = true;
          setReady((value) => value + 1);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "图谱渲染失败");
      });
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      graphRef.current = null;
      hoverRef.current.close();
      graph.destroy();
    };
  }, [nodes, edges, rootId, layout]);
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    const highlight = new Set(highlightIds);
    const states: Record<string, string[]> = {};
    for (const node of nodes)
      states[node.id] =
        node.id === selectedId
          ? ["selected"]
          : highlight.has(node.id)
            ? ["highlight"]
            : highlight.size
              ? ["dim"]
              : [];
    for (const edge of edges)
      states[edge.id] =
        highlight.has(edge.source) && highlight.has(edge.target)
          ? ["highlight"]
          : highlight.size
            ? ["dim"]
            : [];
    void graph.setElementState(states).catch(() => undefined);
  }, [selectedId, highlightIds, ready, nodes, edges]);
  const command = (kind: "in" | "out" | "fit" | "focus") => {
    const graph = graphRef.current;
    if (!graph) return;
    const action =
      kind === "fit"
        ? graph.fitView()
        : kind === "focus" && selectedId
          ? graph.focusElement(selectedId)
          : graph.zoomTo(graph.getZoom() * (kind === "in" ? 1.25 : 0.8));
    void action.catch(() => undefined);
  };
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
