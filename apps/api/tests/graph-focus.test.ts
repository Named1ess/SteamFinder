import { expect, it } from "vitest";
import { graphResponse } from "../src/graph.js";
import type { CrawlRun, GraphNode } from "../../../packages/shared/src/index.js";

const ids = Array.from({ length: 7 }, (_, i) => String(76561200100080000n + BigInt(i)));
const nodes: GraphNode[] = ids.map((id, i) => ({
  id, name: `Focus fixture ${i}`, avatar: null, profileUrl: "",
  depth: [0, 1, 1, 2, 2, 3, 3][i], fetchStatus: "unknown", fetchedAt: null,
  friendCount: null, degree: 0, community: 0,
}));
// Root -- 1 -- 3 -- 5; root -- 2 -- 4 -- 5; isolated player 6.
const edges = [[0, 1], [1, 3], [3, 5], [0, 2], [2, 4], [4, 5]].map(([a, b]) => ({
  id: `${ids[a]}:${ids[b]}`, source: ids[a], target: ids[b],
}));
const run = {} as CrawlRun;

it("focuses around a hidden saved player and ignores root display depth", () => {
  const result = graphResponse(run, nodes, edges, 100, 1, { playerId: ids[5], hops: 1 });
  expect(result.nodes.map((node) => node.id)).toEqual([ids[5], ids[3], ids[4]]);
  expect(result.edges.map((edge) => edge.id)).toEqual([`${ids[3]}:${ids[5]}`, `${ids[4]}:${ids[5]}`]);
  expect(result.focus).toEqual({ playerId: ids[5], hops: 1, totalNodes: 3 });
  expect(result.totalNodes).toBe(7);
  expect(result.totalEdges).toBe(6);
});

it("caps nearest focus nodes deterministically, always keeping the center", () => {
  const result = graphResponse(run, [...nodes].reverse(), [...edges].reverse(), 4, 0, { playerId: ids[5], hops: 2 });
  expect(result.nodes.map((node) => node.id)).toEqual([ids[5], ids[3], ids[4], ids[1]]);
  expect(result.focus?.totalNodes).toBe(5);
  expect(graphResponse(run, nodes, edges, 1, 0, { playerId: ids[5], hops: 2 }).nodes.map((node) => node.id)).toEqual([ids[5]]);
});

it("retains full graph statistics and community assignments in focus mode", () => {
  const full = graphResponse(run, nodes, edges, 100, 3);
  const focused = graphResponse(run, nodes, edges, 100, 1, { playerId: ids[5], hops: 2 });
  expect(focused.stats).toEqual(full.stats);
  for (const node of focused.nodes) expect(node).toEqual(full.nodes.find((item) => item.id === node.id));
  expect(focused.nodes.some((node) => node.id === ids[0])).toBe(false);
  expect(focused.nodes.some((node) => node.id === ids[6])).toBe(false);
});

it("keeps isolated focus centers and rejects centers outside the run", () => {
  expect(graphResponse(run, nodes, edges, 100, 0, { playerId: ids[6], hops: 2 }).nodes.map((node) => node.id)).toEqual([ids[6]]);
  expect(() => graphResponse(run, nodes, edges, 100, 3, { playerId: "76561200100089999", hops: 1 })).toThrow();
});
