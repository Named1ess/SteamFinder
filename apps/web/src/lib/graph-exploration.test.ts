import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphNode,
} from "../../../../packages/shared/src/index";
import { projectCommunities } from "./graph-exploration";

const player = (
  id: string,
  community: number,
  depth = 1,
): GraphNode => ({
  id,
  name: `Player ${id}`,
  avatar: `https://example.com/${id}.jpg`,
  profileUrl: `https://example.com/${id}`,
  depth,
  fetchStatus: "ok",
  fetchedAt: "2026-10-03T00:00:00.000Z",
  friendCount: 10,
  degree: 2,
  community,
});

const friendship = (id: string, source: string, target: string): GraphEdge => ({
  id,
  source,
  target,
});

describe("community projection", () => {
  it("collapses a community into a counted node and restores its players on expansion", () => {
    const nodes = [player("b", 4, 3), player("a", 4, 2), player("c", 8)];
    const edges = [friendship("ab", "a", "b"), friendship("bc", "b", "c")];
    const collapsed = projectCommunities(nodes, edges, [4]);

    expect(collapsed.nodes).toHaveLength(2);
    expect(collapsed.nodes.find((node) => node.kind === "community")).toEqual({
      id: "community:4",
      name: "社群 5 · 2 人",
      avatar: null,
      profileUrl: "",
      depth: 2,
      fetchStatus: "unknown",
      fetchedAt: null,
      friendCount: null,
      degree: 1,
      community: 4,
      kind: "community",
      memberIds: ["a", "b"],
      memberCount: 2,
      internalEdges: 1,
    });
    expect(collapsed.communities).toEqual([
      { id: 4, memberIds: ["a", "b"], count: 2, collapsed: true },
      { id: 8, memberIds: ["c"], count: 1, collapsed: false },
    ]);
    expect(collapsed.representedPlayers).toBe(3);

    const expanded = projectCommunities(nodes, edges, []);
    expect(expanded.nodes).toEqual([nodes[1], nodes[0], nodes[2]]);
    expect(expanded.edges).toEqual(edges);
    expect(expanded.communities.every((community) => !community.collapsed)).toBe(
      true,
    );
  });

  it.each(["root", "selected", "focus", "analysis"])(
    "keeps every member expanded when a %s player is protected",
    (protectedId) => {
      const nodes = [
        player(protectedId, 0),
        player("neighbor", 0),
        player("c", 1),
        player("d", 1),
      ];
      const result = projectCommunities(nodes, [], [0, 1], [protectedId]);

      expect(result.nodes.filter((node) => !node.kind).map((node) => node.id)).toEqual(
        [protectedId, "neighbor"].sort(),
      );
      expect(result.nodes.filter((node) => node.kind).map((node) => node.id)).toEqual(
        ["community:1"],
      );
      expect(result.communities.map((community) => community.collapsed)).toEqual([
        false,
        true,
      ]);
    },
  );

  it("counts internal and cross-community unique friendships separately", () => {
    const nodes = [
      player("a", 0),
      player("b", 0),
      player("c", 0),
      player("d", 1),
      player("e", 1),
      player("x", 2),
      player("y", 3),
    ];
    const edges = [
      friendship("ab", "a", "b"),
      friendship("ab-reverse", "b", "a"),
      friendship("ac", "a", "c"),
      friendship("bc", "b", "c"),
      friendship("de", "d", "e"),
      friendship("ad", "a", "d"),
      friendship("bd", "b", "d"),
      friendship("ce", "c", "e"),
      friendship("ax", "a", "x"),
      friendship("bx", "b", "x"),
      friendship("xy", "x", "y"),
    ];
    const result = projectCommunities(nodes, edges, [0, 1]);

    expect(result.nodes.find((node) => node.id === "community:0")).toMatchObject({
      memberCount: 3,
      internalEdges: 3,
      degree: 2,
    });
    expect(result.nodes.find((node) => node.id === "community:1")).toMatchObject({
      memberCount: 2,
      internalEdges: 1,
      degree: 1,
    });
    expect(result.edges).toHaveLength(3);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), source: "community:0", target: "community:1", count: 3 },
        { id: expect.any(String), source: "community:0", target: "x", count: 2 },
        { id: "xy", source: "x", target: "y" },
      ]),
    );
    expect(result.representedPlayers).toBe(7);
  });

  it("omits self and missing-endpoint edges and deduplicates unordered friendships", () => {
    const nodes = [player("a", 0), player("b", 0), player("a", 0)];
    const edges = [
      friendship("z-ab", "b", "a"),
      friendship("a-ab", "a", "b"),
      friendship("self", "a", "a"),
      friendship("missing-source", "missing", "b"),
      friendship("missing-target", "a", "missing"),
    ];
    const expanded = projectCommunities(nodes, edges, []);
    expect(expanded.edges).toEqual([friendship("a-ab", "a", "b")]);
    expect(expanded.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(expanded.representedPlayers).toBe(2);
    expect(expanded.communities).toEqual([
      { id: 0, memberIds: ["a", "b"], count: 2, collapsed: false },
    ]);

    const collapsed = projectCommunities(nodes, edges, [0]);
    expect(collapsed.nodes[0]).toMatchObject({ internalEdges: 1, degree: 1 });
    expect(collapsed.edges).toEqual([]);
  });

  it("ignores unknown collapse and protected IDs and leaves singleton communities expanded", () => {
    const result = projectCommunities(
      [player("z", 10), player("b", 2), player("a", 2)],
      [],
      [10, 99, 2, 2],
      ["missing"],
    );

    expect(result.communities).toEqual([
      { id: 2, memberIds: ["a", "b"], count: 2, collapsed: true },
      { id: 10, memberIds: ["z"], count: 1, collapsed: false },
    ]);
    expect(result.nodes.map((node) => node.id)).toEqual(["community:2", "z"]);
    expect(result.nodes[0].degree).toBe(1);
  });

  it("is stable when input ordering and repeated collapse requests change", () => {
    const nodes = [player("c", 10), player("a", 2), player("b", 2), player("d", 10)];
    const edges = [
      friendship("z-ab", "b", "a"),
      friendship("a-ab", "a", "b"),
      friendship("cd", "c", "d"),
      friendship("ac", "a", "c"),
      friendship("bd", "b", "d"),
    ];
    expect(projectCommunities(nodes, edges, [10, 2, 2])).toEqual(
      projectCommunities([...nodes].reverse(), [...edges].reverse(), [2, 10]),
    );
    expect(projectCommunities(nodes, edges, [])).toEqual(
      projectCommunities([...nodes].reverse(), [...edges].reverse(), []),
    );
  });

  it("keeps distinct friendships when identifiers contain separators", () => {
    const nodes = [
      player("a", 0),
      player("b:c", 1),
      player("a:b", 2),
      player("c", 3),
      player("with:colon", 4),
      player("with\"quote", 4),
    ];
    const edges = [
      friendship("first", "a", "b:c"),
      friendship("second", "a:b", "c"),
      friendship("third", "with:colon", "a"),
      friendship("fourth", "with\"quote", "b:c"),
    ];
    const result = projectCommunities(nodes, edges, [4]);

    expect(result.edges).toHaveLength(4);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(4);
    expect(result.edges.filter((edge) => edge.count).map((edge) => edge.count)).toEqual([
      1,
      1,
    ]);
  });

  it("does not give an aggregate edge the ID of an ordinary edge", () => {
    const nodes = [
      player("a", 0),
      player("b", 0),
      player("c", 1),
      player("x", 2),
      player("y", 3),
    ];
    const aggregateFriendship = friendship("ac", "a", "c");
    const baseline = projectCommunities(nodes, [aggregateFriendship], [0]);
    const ordinaryEdge = friendship(baseline.edges[0].id, "x", "y");
    const result = projectCommunities(nodes, [aggregateFriendship, ordinaryEdge], [0]);

    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.id)).size).toBe(2);
    expect(result.edges).toContainEqual(ordinaryEdge);
  });

  it("does not change the input nodes, edges, collapse list or protected list", () => {
    const nodes = [player("c", 1), player("b", 0), player("a", 0)];
    const edges = [friendship("bc", "b", "c"), friendship("ab", "a", "b")];
    const collapsed = [1, 0];
    const protectedIds = ["c"];
    const before = JSON.stringify({ nodes, edges, collapsed, protectedIds });
    for (const node of nodes) Object.freeze(node);
    for (const edge of edges) Object.freeze(edge);
    Object.freeze(nodes);
    Object.freeze(edges);
    Object.freeze(collapsed);
    Object.freeze(protectedIds);

    projectCommunities(nodes, edges, collapsed, protectedIds);
    expect(JSON.stringify({ nodes, edges, collapsed, protectedIds })).toBe(before);
  });

  it("handles an empty graph", () => {
    expect(projectCommunities([], [], [0], ["missing"])).toEqual({
      nodes: [],
      edges: [],
      communities: [],
      representedPlayers: 0,
    });
  });
});
