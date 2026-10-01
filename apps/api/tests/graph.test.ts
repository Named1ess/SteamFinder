import { expect, it } from "vitest";
import { graphResponse, analyze } from "../src/graph.js";
import type {
  CrawlRun,
  GraphNode,
} from "../../../packages/shared/src/index.js";
const nodes: GraphNode[] = ["a", "b", "c", "d", "e"].map((id, i) => ({
  id,
  name: id,
  avatar: null,
  profileUrl: "",
  depth: i === 0 ? 0 : 1,
  fetchStatus: i === 4 ? "private" : "ok",
  fetchedAt: new Date().toISOString(),
  friendCount: [3, 2, 2, 2, 1][i],
  degree: 0,
  community: 0,
}));
const edges = [
  ["a", "b"],
  ["a", "c"],
  ["b", "d"],
  ["c", "d"],
  ["a", "e"],
].map(([source, target]) => ({ id: `${source}:${target}`, source, target }));
it("computes statistics on full collected graph despite display truncation and cycles", () => {
  const result = graphResponse({} as CrawlRun, nodes, edges, 2, 3);
  expect(result.nodes).toHaveLength(2);
  expect(result.totalNodes).toBe(5);
  expect(result.totalEdges).toBe(5);
  expect(result.stats.topConnectors[0]).toMatchObject({ id: "a", count: 3 });
  expect(result.stats.privateNodes).toBe(1);
  expect(result.truncated).toBe(true);
});
it("finds mutual friends and shortest paths across full run including hidden display nodes", () => {
  const mutual = analyze("mutual", "a", "d", nodes, edges);
  expect(mutual.nodeIds.sort()).toEqual(["b", "c"]);
  expect(mutual.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
  expect(mutual.complete).toBe(true);
  const path = analyze("path", "e", "d", nodes, edges);
  expect(path.path).toHaveLength(4);
  expect(path.path[0]).toBe("e");
  expect(path.path[3]).toBe("d");
  expect(path.complete).toBe(false);
});
it("does not claim complete mutual results when a node cap omitted known friends", () => {
  const result = analyze(
    "mutual",
    "a",
    "b",
    nodes.slice(0, 2),
    edges.slice(0, 1),
  );
  expect(result.complete).toBe(false);
});
it("keeps full-graph community and degree attributes when analysis adds hidden nodes", () => {
  const result = graphResponse({} as CrawlRun, nodes, edges, 1000, 3);
  const path = analyze("path", "e", "d", nodes, edges);
  expect(result.stats.communities.length).toBeGreaterThan(1);
  for (const node of path.nodes) {
    const full = result.nodes.find((item) => item.id === node.id)!;
    expect(node.community).toBe(full.community);
    expect(node.degree).toBe(full.degree);
  }
});
