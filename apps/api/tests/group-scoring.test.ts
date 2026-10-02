import { describe, expect, it } from "vitest";
import type {
  GroupSnapshot,
  RelationshipScoresResponse,
  SteamGroup,
} from "../../../packages/shared/src/index.js";
import { applyRelationshipGroups } from "../src/group-scoring.js";

const group = (id: string): SteamGroup => ({
  id,
  name: `Group ${id}`,
  url: `https://steamcommunity.com/gid/${id}/`,
  memberCount: 10,
});
const snapshot = (
  playerId: string,
  ids: string[],
  extra: Partial<GroupSnapshot> = {},
): GroupSnapshot => ({
  playerId,
  status: "ok",
  groups: ids.map(group),
  totalCount: new Set(ids).size,
  complete: true,
  fetchedAt: "2026-10-03T00:00:00Z",
  attemptedAt: "2026-10-03T00:00:00Z",
  message: null,
  ...extra,
});
function graph(
  scores: Array<number | null> = [34, 36],
): Pick<
  RelationshipScoresResponse,
  "center" | "totalPlayers" | "totalEdges" | "coverage" | "layers" | "rows"
> {
  return {
    center: {
      id: "root",
      name: "Root",
      avatar: null,
      profileUrl: "",
      depth: 0,
    },
    totalPlayers: scores.length,
    totalEdges: 1,
    coverage: { completeLists: 0, totalLists: scores.length + 1 },
    layers: [
      { id: "core", label: "核心层", minScore: 60, maxScore: 100, count: 0 },
      { id: "close", label: "紧密层", minScore: 35, maxScore: 59.9, count: 0 },
      {
        id: "connected",
        label: "连接层",
        minScore: 15,
        maxScore: 34.9,
        count: 0,
      },
      {
        id: "peripheral",
        label: "外围层",
        minScore: 0,
        maxScore: 14.9,
        count: 0,
      },
      {
        id: "unknown",
        label: "暂无已知路径",
        minScore: null,
        maxScore: null,
        count: 0,
      },
    ],
    rows: scores.map((score, i) => ({
      player: {
        id: `p${i}`,
        name: `P${i}`,
        avatar: null,
        profileUrl: "",
        depth: 1,
      },
      score,
      layer: score === null ? "unknown" : "connected",
      distance: score === null ? null : 1,
      isDirect: true,
      mutualCount: 1,
      weightedMutual: 0,
      overlap: 0,
      threeHopPaths: 0,
      weightedIndirect: 0,
      components: { direct: 15, mutual: 0, overlap: 0, indirect: 0 },
      commonFriends: [],
      evidence: "partial",
    })),
  };
}
const evidence = (...values: GroupSnapshot[]) =>
  new Map(values.map((value) => [value.playerId, value]));

describe("shared groups in relationship scores", () => {
  it("adds a bounded positive bonus and updates ranking and layer counts", () => {
    const base = graph([36, 34]);
    const result = applyRelationshipGroups(
      base,
      evidence(
        snapshot("root", ["1"]),
        snapshot("p0", ["2"]),
        snapshot("p1", ["1"]),
      ),
    );
    expect(result.rows.map((row) => row.score)).toEqual([40.6, 36]);
    expect(result.rows[0]).toMatchObject({
      player: { id: "p1" },
      networkScore: 34,
      layer: "close",
      groups: { contribution: 6.6, similarity: 100, sharedCount: 1 },
    });
    expect(result.layers.find((layer) => layer.id === "close")?.count).toBe(2);
    expect(base.rows[1].score).toBe(34);
  });
  it("uses the complete union, deduplicates identities, and does not compare names", () => {
    const result = applyRelationshipGroups(
      graph([40]),
      evidence(snapshot("root", ["1", "1", "2"]), snapshot("p0", ["2", "3"])),
    );
    expect(result.rows[0]).toMatchObject({
      score: 42,
      groups: {
        similarity: 33.3,
        sharedCount: 1,
        unionCount: 3,
        centerCount: 2,
        playerCount: 2,
        contribution: 2,
      },
    });
    expect(result.rows[0].groups?.commonGroups.map((g) => g.id)).toEqual(["2"]);
  });
  it.each(["unknown", "private", "error"] as const)(
    "never uses %s snapshots or old successful contents",
    (status) => {
      const result = applyRelationshipGroups(
        graph([40]),
        evidence(snapshot("root", ["1"]), snapshot("p0", ["1"], { status })),
      );
      expect(result.rows[0]).toMatchObject({
        score: 40,
        groups: { similarity: null, contribution: 0, sharedCount: 0 },
      });
    },
  );
  it("does not invent negative evidence from missing or incomplete groups", () => {
    for (const unavailable of [
      undefined,
      snapshot("p0", ["1"], { complete: false }),
      snapshot("p0", ["1"], { totalCount: 2 }),
    ]) {
      const values = evidence(snapshot("root", ["1"]));
      if (unavailable) values.set("p0", unavailable);
      expect(
        applyRelationshipGroups(graph([40]), values).rows[0],
      ).toMatchObject({
        score: 40,
        groups: { similarity: null, contribution: 0 },
      });
    }
  });
  it("distinguishes a public empty list from an unknown list without penalizing either", () => {
    const result = applyRelationshipGroups(
      graph([40]),
      evidence(snapshot("root", []), snapshot("p0", [])),
    );
    expect(result.rows[0]).toMatchObject({
      score: 40,
      groups: {
        similarity: 0,
        centerCount: 0,
        playerCount: 0,
        contribution: 0,
      },
    });
  });
  it("shows shared groups but never creates a friendship path for disconnected players", () => {
    const result = applyRelationshipGroups(
      graph([null]),
      evidence(snapshot("root", ["1"]), snapshot("p0", ["1"])),
    );
    expect(result.rows[0]).toMatchObject({
      score: null,
      networkScore: null,
      layer: "unknown",
      groups: { sharedCount: 1, similarity: 100, contribution: 0 },
    });
  });
  it("keeps totals within 100, zero baseline bonus at most 10, and exact displayed sums", () => {
    for (const score of [0, 15, 33.3, 59.9, 99.9, 100]) {
      const result = applyRelationshipGroups(
        graph([score]),
        evidence(snapshot("root", ["1"]), snapshot("p0", ["1"])),
      );
      const row = result.rows[0];
      expect(row.score).toBeGreaterThanOrEqual(score);
      expect(row.score).toBeLessThanOrEqual(100);
      expect(row.groups!.contribution).toBeLessThanOrEqual(10);
      expect(Math.round((score + row.groups!.contribution) * 10) / 10).toBe(
        row.score,
      );
    }
  });
  it("caps examples while using all shared memberships and is stable under input ordering", () => {
    const ids = Array.from({ length: 30 }, (_, i) =>
      String(103582791475930000n + BigInt(i)),
    );
    const first = applyRelationshipGroups(
      graph([40]),
      evidence(snapshot("root", ids), snapshot("p0", [...ids].reverse())),
    );
    const second = applyRelationshipGroups(
      graph([40]),
      evidence(snapshot("root", [...ids].reverse()), snapshot("p0", ids)),
    );
    expect(first).toEqual(second);
    expect(first.rows[0].groups).toMatchObject({
      sharedCount: 30,
      similarity: 100,
    });
    expect(first.rows[0].groups!.commonGroups).toHaveLength(20);
  });
});
