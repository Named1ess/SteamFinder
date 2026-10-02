import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphNode,
} from "../../../packages/shared/src/index.js";
import {
  relationshipLayer,
  scoreRelationshipGraph,
} from "../src/relationship-scoring.js";

const now = Date.parse("2026-10-02T12:00:00Z");
function node(id: string, changes: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name: `Player ${id}`,
    avatar: null,
    profileUrl: `https://steamcommunity.com/profiles/${id}`,
    depth: 0,
    fetchStatus: "ok",
    fetchedAt: new Date(now - 1000).toISOString(),
    friendCount: null,
    degree: 999,
    community: 0,
    ...changes,
  };
}
function edge(source: string, target: string): GraphEdge {
  return { id: `${source}:${target}`, source, target };
}
function score(
  ids: string[],
  pairs: [string, string][],
  changes: Record<string, Partial<GraphNode>> = {},
) {
  const nodes = ids.map((id) => node(id, changes[id]));
  return scoreRelationshipGraph(
    "r",
    nodes,
    pairs.map(([a, b]) => edge(a, b)),
    new Set(ids),
    now,
  );
}
const row = (result: ReturnType<typeof score>, id: string) =>
  result.rows.find((r) => r.player.id === id)!;

describe("observed relationship scoring", () => {
  it("gives a direct pair 15 without inventing reciprocal three-hop paths", () => {
    const result = score(["r", "v"], [["r", "v"]]);
    expect(row(result, "v")).toMatchObject({
      score: 15,
      layer: "connected",
      distance: 1,
      isDirect: true,
      mutualCount: 0,
      weightedMutual: 0,
      overlap: 0,
      threeHopPaths: 0,
      weightedIndirect: 0,
      components: { direct: 15, mutual: 0, overlap: 0, indirect: 0 },
    });
    expect(result.totalPlayers).toBe(1);
    expect(result.totalEdges).toBe(1);
  });

  it("scores a triangle at 55 and excludes repeated vertices from three-hop evidence", () => {
    expect(
      row(
        score(
          ["r", "a", "v"],
          [
            ["r", "a"],
            ["a", "v"],
            ["v", "r"],
          ],
        ),
        "v",
      ),
    ).toMatchObject({
      score: 55,
      layer: "close",
      mutualCount: 1,
      weightedMutual: 0.5,
      overlap: 1,
      threeHopPaths: 0,
      weightedIndirect: 0,
      components: { direct: 15, mutual: 15, overlap: 25, indirect: 0 },
    });
  });

  it("scores both distinct common neighbors in a diamond at 47.5", () => {
    expect(
      row(
        score(
          ["r", "a", "b", "v"],
          [
            ["r", "a"],
            ["r", "b"],
            ["a", "v"],
            ["b", "v"],
          ],
        ),
        "v",
      ),
    ).toMatchObject({
      score: 47.5,
      distance: 2,
      mutualCount: 2,
      weightedMutual: 1,
      overlap: 1,
      threeHopPaths: 0,
      components: { direct: 0, mutual: 22.5, overlap: 25, indirect: 0 },
    });
  });

  it("scores an exactly three-edge chain at 3 and separates longer paths from unknown", () => {
    const result = score(
      ["r", "a", "b", "v", "far", "x", "y"],
      [
        ["r", "a"],
        ["a", "b"],
        ["b", "v"],
        ["v", "far"],
        ["x", "y"],
      ],
    );
    expect(row(result, "v")).toMatchObject({
      score: 3,
      distance: 3,
      layer: "peripheral",
      threeHopPaths: 1,
      weightedIndirect: 0.25,
    });
    expect(row(result, "far")).toMatchObject({
      score: 0,
      distance: 4,
      layer: "peripheral",
    });
    expect(row(result, "x")).toMatchObject({
      score: null,
      distance: null,
      layer: "unknown",
    });
    expect(result.rows.slice(-2).map((r) => r.player.id)).toEqual(["x", "y"]);
    expect(result.layers.find((l) => l.id === "unknown")?.count).toBe(2);
  });

  it("counts oriented simple paths through a four-player clique and sums rounded components", () => {
    const result = score(
      ["r", "a", "b", "v"],
      [
        ["r", "a"],
        ["r", "b"],
        ["r", "v"],
        ["a", "b"],
        ["a", "v"],
        ["b", "v"],
      ],
    );
    expect(row(result, "v")).toMatchObject({
      score: 60.7,
      layer: "core",
      threeHopPaths: 2,
      components: { direct: 15, mutual: 18, overlap: 25, indirect: 2.7 },
    });
    expect(row(result, "v").weightedIndirect).toBeCloseTo(2 / 9, 12);
  });

  it("uses stored public counts only as a hub penalty, with actual adjacency as its lower bound", () => {
    const pairs: [string, string][] = [
      ["r", "a"],
      ["a", "v"],
    ];
    const ordinary = row(score(["r", "a", "v"], pairs), "v");
    const hub = row(
      score(["r", "a", "v"], pairs, { a: { friendCount: 100 } }),
      "v",
    );
    expect(ordinary).toMatchObject({
      score: 40,
      weightedMutual: 0.5,
      overlap: 1,
    });
    expect(hub).toMatchObject({
      score: 25.4,
      weightedMutual: 0.01,
      overlap: 1,
    });
    expect(
      row(score(["r", "a", "v"], pairs, { a: { friendCount: 1 } }), "v").score,
    ).toBe(40);
    const indirectHub = row(
      score(
        ["r", "a", "b", "v"],
        [
          ["r", "a"],
          ["a", "b"],
          ["b", "v"],
        ],
        { a: { friendCount: 10 }, b: { friendCount: 10 } },
      ),
      "v",
    );
    expect(indirectHub).toMatchObject({ score: 0.1, threeHopPaths: 1 });
    expect(indirectHub.weightedIndirect).toBeCloseTo(0.01, 12);
  });

  it("deduplicates reversed edges and ignores loops and endpoints outside the graph", () => {
    const clean = score(
      ["r", "a", "v"],
      [
        ["r", "a"],
        ["a", "v"],
      ],
    );
    const dirty = score(
      ["r", "a", "v"],
      [
        ["r", "a"],
        ["a", "r"],
        ["r", "a"],
        ["a", "v"],
        ["v", "a"],
        ["a", "a"],
        ["r", "outside"],
      ],
    );
    expect(dirty).toEqual(clean);
  });

  it("retains observed positive scores for private players and computes evidence from both neighborhoods", () => {
    const ids = ["r", "a", "b", "v", "outside"];
    const pairs: [string, string][] = [
      ["r", "a"],
      ["a", "b"],
      ["b", "v"],
    ];
    expect(row(score(ids, pairs), "v").evidence).toBe("complete");
    const incompleteNeighborhoods: Record<string, Partial<GraphNode>>[] = [
      { v: { fetchStatus: "private" } },
      { a: { fetchedAt: new Date(now - 86400000).toISOString() } },
      { b: { fetchStatus: "error" } },
      { r: { fetchedAt: null } },
    ];
    for (const changes of incompleteNeighborhoods) {
      expect(row(score(ids, pairs, changes), "v")).toMatchObject({
        score: 3,
        evidence: "partial",
      });
    }
    const nodes = ids.map((id) => node(id));
    const result = scoreRelationshipGraph(
      "r",
      nodes,
      pairs.map(([a, b]) => edge(a, b)),
      new Set(["r", "a", "v", "outside"]),
      now,
    );
    expect(row(result, "v")).toMatchObject({ score: 3, evidence: "partial" });
    expect(result.coverage).toEqual({ completeLists: 4, totalLists: 5 });
    expect(
      row(score(ids, pairs, { outside: { fetchStatus: "private" } }), "v")
        .evidence,
    ).toBe("complete");
  });

  it("returns stable rankings and only the first five sorted common-friend examples", () => {
    const ids = ["r", "v", ...Array.from({ length: 8 }, (_, i) => `a${i}`)];
    const pairs: [string, string][] = ids.slice(2).flatMap(
      (a) =>
        [
          ["r", a],
          [a, "v"],
        ] as [string, string][],
    );
    const nodes = ids.map((id) => node(id));
    const edges = pairs.map(([a, b]) => edge(a, b));
    const result = scoreRelationshipGraph("r", nodes, edges, new Set(ids), now);
    const shuffled = scoreRelationshipGraph(
      "r",
      [...nodes].reverse(),
      [...edges].reverse(),
      new Set(ids),
      now,
    );
    expect(shuffled).toEqual(result);
    expect(row(result, "v").commonFriends.map((p) => p.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
    expect(row(result, "v").mutualCount).toBe(8);
    expect(
      result.rows.filter((r) => r.player.id !== "v").map((r) => r.player.id),
    ).toEqual(ids.slice(2));
  });

  it.each([
    [null, "unknown"],
    [0, "peripheral"],
    [14.9, "peripheral"],
    [15, "connected"],
    [34.9, "connected"],
    [35, "close"],
    [59.9, "close"],
    [60, "core"],
    [100, "core"],
  ] as const)("assigns the layer at the %s score boundary", (value, layer) => {
    expect(relationshipLayer(value)).toBe(layer);
  });

  it("ranks a 10,000-player sparse graph without expanding its enormous path count", () => {
    const ids = [
      "r",
      ...Array.from(
        { length: 9999 },
        (_, i) => `p${String(i).padStart(5, "0")}`,
      ),
    ];
    const nodes = ids.map((id) => node(id));
    // Two connected hubs create almost 100 million simple oriented paths.
    const edges = [
      edge("r", ids[1]),
      ...ids.slice(2).flatMap((id) => [edge("r", id), edge(ids[1], id)]),
    ];
    const start = performance.now();
    const result = scoreRelationshipGraph("r", nodes, edges, new Set(ids), now);
    expect(result.rows).toHaveLength(9999);
    expect(result.totalEdges).toBe(19997);
    expect(
      result.rows.every(
        (r) => r.score !== null && r.score >= 0 && r.score <= 100,
      ),
    ).toBe(true);
    expect(result.rows.every((r) => r.commonFriends.length <= 5)).toBe(true);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
