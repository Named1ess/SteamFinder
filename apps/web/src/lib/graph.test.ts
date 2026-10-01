import { describe, expect, it } from "vitest";
import {
  depthRingPositions,
  graphInitials,
  initials,
  matchesAnalysisSelection,
  mergeGraph,
} from "./graph";
import type {
  AnalysisResult,
  GraphNode,
} from "../../../../packages/shared/src/index";

const node = (id: string): GraphNode => ({
  id,
  name: id,
  avatar: null,
  profileUrl: "",
  depth: 0,
  fetchStatus: "unknown",
  fetchedAt: null,
  friendCount: null,
  degree: 0,
  community: 0,
});

describe("analysis response selection guard", () => {
  const submitted = {
    runId: "run-a",
    from: "76561199521553744",
    to: "76561199521553745",
  };
  it("accepts a result for the unchanged run and endpoints", () => {
    expect(matchesAnalysisSelection(submitted, { ...submitted })).toBe(true);
  });
  it.each([
    { ...submitted, runId: "run-b" },
    { ...submitted, runId: null },
    { ...submitted, from: "76561199521553746" },
    { ...submitted, to: "76561199521553746" },
  ])("discards a result after selection changes to %o", (latest) => {
    expect(matchesAnalysisSelection(submitted, latest)).toBe(false);
  });
});
describe("analysis graph merge", () => {
  it("preserves exact string identifiers and includes analysis nodes beyond display limit", () => {
    const a = "76561199521553744",
      b = "76561199521553745";
    const result: AnalysisResult = {
      kind: "path",
      nodeIds: [a, b],
      path: [a, b],
      nodes: [node(b)],
      edges: [{ id: "ab", source: a, target: b }],
      complete: false,
      message: "",
    };
    const merged = mergeGraph({ nodes: [node(a)], edges: [] }, result);
    expect(merged.nodes.map((n) => n.id)).toEqual([a, b]);
    expect(merged.edges).toHaveLength(1);
  });
  it("deduplicates overlapping nodes and omits dangling edges", () => {
    expect(
      mergeGraph({
        nodes: [node("a"), node("a")],
        edges: [{ id: "missing", source: "a", target: "b" }],
      }),
    ).toEqual({ nodes: [node("a")], edges: [] });
  });
  it("uses unicode initials without splitting a character", () => {
    expect(initials("🛰 Orbit")).toBe("🛰 ");
    expect(initials("星河")).toBe("星河");
  });
  it("gives generated demo players distinct icons", () => {
    expect(graphInitials("演示玩家 18 · 虚构")).toBe("18");
    expect(graphInitials("演示玩家 · 虚构起点")).toBe("起点");
  });
  it("spreads a crowded layer over a full circle with at least 72 units of separation", () => {
    const nodes = [
      node("root"),
      ...Array.from({ length: 150 }, (_, i) => ({
        ...node(`player-${i}`),
        depth: 1,
      })),
    ];
    const positions = depthRingPositions(nodes, "root");
    expect(positions.get("root")).toEqual({ x: 0, y: 0 });
    const ring = nodes.slice(1).map((item) => positions.get(item.id)!);
    expect(Math.min(...ring.map((point) => point.x))).toBeLessThan(-1000);
    expect(Math.max(...ring.map((point) => point.x))).toBeGreaterThan(1000);
    for (let i = 0; i < ring.length; i++)
      for (let j = i + 1; j < ring.length; j++)
        expect(
          Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y),
        ).toBeGreaterThanOrEqual(71.999);
    expect(depthRingPositions([...nodes].reverse(), "root")).toEqual(positions);
  });
});
