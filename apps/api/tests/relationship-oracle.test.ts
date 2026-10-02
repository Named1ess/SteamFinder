import { expect, it } from "vitest";
import type { GraphNode } from "../../../packages/shared/src/index.js";
import { scoreRelationshipGraph } from "../src/relationship-scoring.js";

it("matches an independent simple-path enumeration for every center in seeded random graphs", () => {
  let seed = 89171;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const now = Date.parse("2026-10-02T08:00:00Z");
  for (let sample = 0; sample < 32; sample++) {
    const nodes: GraphNode[] = Array.from({ length: 7 }, (_, i) => ({
      id: String(76561200100029000n + BigInt(i)),
      name: `Player ${i}`,
      avatar: null,
      profileUrl: "",
      depth: i === 0 ? 0 : 2,
      fetchStatus: "ok",
      fetchedAt: new Date(now).toISOString(),
      friendCount: sample % 2 ? 20 : null,
      degree: 0,
      community: 0,
    }));
    const adjacency = nodes.map(() => new Set<number>());
    const edges = [];
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        if (random() < 0.38) {
          adjacency[a].add(b);
          adjacency[b].add(a);
          edges.push({
            id: `${a}:${b}`,
            source: nodes[a].id,
            target: nodes[b].id,
          });
        }
      }
    }
    const weight = (index: number) =>
      1 / Math.max(1, adjacency[index].size, nodes[index].friendCount ?? 0);
    for (let root = 0; root < nodes.length; root++) {
      const result = scoreRelationshipGraph(
        nodes[root].id,
        nodes,
        edges,
        new Set(nodes.map((n) => n.id)),
        now,
      );
      for (let target = 0; target < nodes.length; target++) {
        if (root === target) continue;
        const row = result.rows.find((r) => r.player.id === nodes[target].id)!;
        let common = 0,
          resource2 = 0,
          count3 = 0,
          resource3 = 0;
        for (const a of adjacency[root]) {
          if (adjacency[a].has(target)) {
            common++;
            resource2 += weight(a);
          }
          for (const b of adjacency[a]) {
            if (
              new Set([root, a, b, target]).size === 4 &&
              adjacency[b].has(target)
            ) {
              count3++;
              resource3 += weight(a) * weight(b);
            }
          }
        }
        const left = new Set([...adjacency[root]].filter((x) => x !== target));
        const right = new Set([...adjacency[target]].filter((x) => x !== root));
        const union = new Set([...left, ...right]);
        expect(row.mutualCount).toBe(common);
        expect(row.weightedMutual).toBeCloseTo(resource2, 10);
        expect(row.threeHopPaths).toBe(count3);
        expect(row.weightedIndirect).toBeCloseTo(resource3, 10);
        expect(row.overlap).toBeCloseTo(
          union.size ? common / union.size : 0,
          10,
        );
      }
    }
  }
});
