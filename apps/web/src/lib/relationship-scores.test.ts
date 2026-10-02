import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  RelationshipLayer,
  RelationshipScoreRow,
} from "../../../../packages/shared/src/index";
import {
  filterRelationshipScores,
  paginateRelationshipScores,
  rankRelationshipScores,
  refreshRelationshipScores,
  relationshipRingNodes,
} from "./relationship-scores";

describe("relationship refresh", () => {
  it("replaces an initial pending request with the final snapshot when polling has stopped", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const queryKey = ["relationship-scores", "run-1", "center-1"];
    let resolveInitial!: (value: { snapshot: string }) => void;
    const initialRequest = new Promise<{ snapshot: string }>((resolve) => {
      resolveInitial = resolve;
    });
    let requests = 0;
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: () => {
        requests++;
        return requests === 1
          ? initialRequest
          : Promise.resolve({ snapshot: "final" });
      },
      refetchInterval: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(client.getQueryData(queryKey)).toBeUndefined();
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
      const refresh = refreshRelationshipScores(client, "run-1");
      resolveInitial({ snapshot: "old" });
      await refresh;
      expect(client.getQueryData(queryKey)).toEqual({ snapshot: "final" });
      expect(observer.getCurrentResult().data).toEqual({ snapshot: "final" });
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle");
      expect(requests).toBe(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});

function row(
  id: string,
  score: number | null = 50,
  layer: RelationshipLayer = "connected",
  overrides: Partial<RelationshipScoreRow> = {},
): RelationshipScoreRow {
  return {
    player: { id, name: id, avatar: null, profileUrl: "", depth: 1 },
    score,
    layer,
    distance: 1,
    isDirect: true,
    mutualCount: 0,
    weightedMutual: 0,
    overlap: 0,
    threeHopPaths: 0,
    weightedIndirect: 0,
    components: { direct: 0, mutual: 0, overlap: 0, indirect: 0 },
    commonFriends: [],
    evidence: "complete",
    ...overrides,
  };
}

describe("relationship ranking and filtering", () => {
  it("ranks scores before mutual count, distance, and exact ASCII IDs without mutation", () => {
    const rows = [
      row("unknown", null, "unknown", { mutualCount: 99 }),
      row("zero", 0),
      row("a", 50),
      row("Z", 50),
      row("76561199521553745", 50),
      row("76561199521553744", 50),
      row("far", 50, "connected", { distance: 2 }),
      row("no-distance", 50, "connected", { distance: null }),
      row("mutual", 50, "connected", { mutualCount: 1, distance: 3 }),
      row("high", 80),
    ];
    const original = [...rows];
    expect(rankRelationshipScores(rows).map((item) => item.player.id)).toEqual([
      "high",
      "mutual",
      "76561199521553744",
      "76561199521553745",
      "Z",
      "a",
      "far",
      "no-distance",
      "zero",
      "unknown",
    ]);
    expect(rows).toEqual(original);
  });

  it("combines trimmed case-insensitive name or ID search with a layer filter", () => {
    const alice = row("76561199521553744", 80, "core");
    alice.player.name = "Alice";
    const otherAlice = row("76561199521553745", 50, "connected");
    otherAlice.player.name = "ALICE Two";
    const unknown = row("UNKNOWN-ID", null, "unknown");
    const rows = [otherAlice, unknown, alice];
    expect(filterRelationshipScores(rows, "  aLiCe  ", "all")).toEqual([
      otherAlice,
      alice,
    ]);
    expect(filterRelationshipScores(rows, "alice", "core")).toEqual([alice]);
    expect(filterRelationshipScores(rows, "553744", "all")).toEqual([alice]);
    expect(filterRelationshipScores(rows, "unknown-id", "unknown")).toEqual([
      unknown,
    ]);
    expect(filterRelationshipScores(rows, "   ", "all")).toEqual(rows);
    expect(filterRelationshipScores(rows, "absent", "all")).toEqual([]);
  });
});

describe("relationship pagination", () => {
  const rows = Array.from({ length: 65 }, (_, index) => row(String(index)));

  it("defaults to 30 rows and clamps stale page numbers after filtering", () => {
    expect(paginateRelationshipScores(rows, 1)).toEqual({
      rows: rows.slice(30, 60),
      page: 1,
      pages: 3,
      total: 65,
    });
    const filtered = filterRelationshipScores(rows, "64", "all");
    expect(paginateRelationshipScores(filtered, 2)).toEqual({
      rows: [rows[64]],
      page: 0,
      pages: 1,
      total: 1,
    });
    expect(paginateRelationshipScores([], 2)).toEqual({
      rows: [],
      page: 0,
      pages: 1,
      total: 0,
    });
  });

  it("uses a custom page size and keeps negative or fractional pages in bounds", () => {
    expect(paginateRelationshipScores(rows, 100, 20)).toEqual({
      rows: rows.slice(60),
      page: 3,
      pages: 4,
      total: 65,
    });
    expect(paginateRelationshipScores(rows, -1, 20).page).toBe(0);
    expect(paginateRelationshipScores(rows, 1.8, 20).rows).toEqual(
      rows.slice(20, 40),
    );
    expect(paginateRelationshipScores(rows, Number.NaN).page).toBe(0);
    expect(paginateRelationshipScores(rows, 0, 0).rows).toHaveLength(30);
  });
});

describe("relationship rings", () => {
  it("places known scores on their layer radii and excludes unavailable rows", () => {
    const nodes = relationshipRingNodes([
      row("core", 95, "core"),
      row("close", 80, "close"),
      row("connected", 50, "connected"),
      row("zero", 0, "peripheral"),
      row("no-score", null, "core"),
      row("unknown", 50, "unknown"),
    ]);
    expect(
      nodes.map(({ row: item, radius }) => [item.player.id, radius]),
    ).toEqual([
      ["core", 78],
      ["close", 126],
      ["connected", 174],
      ["zero", 220],
    ]);
    for (const node of nodes) {
      expect(Math.hypot(node.x - 250, node.y - 250)).toBeCloseTo(node.radius);
    }
  });

  it("distributes the capped sample across every layer and retains each layer's top ranks", () => {
    const layers = ["core", "close", "connected", "peripheral"] as const;
    const rows = layers.flatMap((layer) =>
      Array.from({ length: 40 }, (_, index) =>
        row(`${layer}-${index}`, 100 - index, layer),
      ),
    );
    const nodes = relationshipRingNodes(rows, 200);
    expect(nodes).toHaveLength(100);
    const counts = { core: 24, close: 26, connected: 25, peripheral: 25 };
    for (const layer of layers) {
      const ids = nodes
        .filter((node) => node.row.layer === layer)
        .map((node) => node.row.player.id);
      expect(ids).toHaveLength(counts[layer]);
      expect(ids).toContain(`${layer}-0`);
      expect(ids).toContain(`${layer}-${counts[layer] - 1}`);
      expect(ids).not.toContain(`${layer}-${counts[layer]}`);
    }
    expect(relationshipRingNodes([...rows].reverse(), 200)).toEqual(nodes);
  });

  it("preserves a minority layer without overfilling the core ring", () => {
    const rows = Array.from({ length: 110 }, (_, index) =>
      row(`core-${index}`, 100 - index / 2, "core"),
    );
    rows.push(row("only-close", 70, "close"));
    const nodes = relationshipRingNodes(rows);
    expect(nodes).toHaveLength(25);
    expect(nodes.some((node) => node.row.player.id === "only-close")).toBe(
      true,
    );
    expect(nodes.filter((node) => node.row.layer === "core")).toHaveLength(24);
    expect(relationshipRingNodes(rows, 0)).toEqual([]);
    expect(relationshipRingNodes(rows, -2)).toEqual([]);
    expect(relationshipRingNodes(rows, 3)).toHaveLength(3);
  });

  it.each([
    ["core", 24],
    ["close", 32],
    ["connected", 44],
    ["peripheral", 56],
  ] as const)(
    "limits a crowded %s ring to its %i highest ranked players",
    (layer, count) => {
      const rows = Array.from({ length: 100 }, (_, index) =>
        row(`player-${index}`, 100 - index, layer),
      );
      const nodes = relationshipRingNodes([...rows].reverse());
      expect(nodes).toHaveLength(count);
      expect(nodes[0].row.player.id).toBe("player-0");
      expect(nodes.at(-1)?.row.player.id).toBe(`player-${count - 1}`);
    },
  );

  it("spaces players evenly at distinct angles within each ring", () => {
    const nodes = relationshipRingNodes([
      row("a", 90, "core"),
      row("b", 89, "core"),
      row("c", 88, "core"),
    ]);
    const angles = nodes
      .map((node) => Math.atan2(node.y - 250, node.x - 250))
      .sort((a, b) => a - b);
    expect(angles[1] - angles[0]).toBeCloseTo((2 * Math.PI) / 3);
    expect(angles[2] - angles[1]).toBeCloseTo((2 * Math.PI) / 3);
    expect(angles[0] + 2 * Math.PI - angles[2]).toBeCloseTo((2 * Math.PI) / 3);
  });
});
