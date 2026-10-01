import { describe, expect, it } from "vitest";
import type { GameScoreRow } from "../../../../packages/shared/src/index";
import {
  gameScoreValue,
  hasGameSetComparison,
  rankGameScores,
} from "./game-scores";

const row = (
  id: string,
  score: number | null,
  status: GameScoreRow["snapshot"]["status"] = "ok",
): GameScoreRow => ({
  player: { id, name: id, avatar: null, profileUrl: "" },
  snapshot: {
    playerId: id,
    status,
    scope: "profile_recent",
    games: [],
    fetchedAt: null,
    attemptedAt: null,
    message: null,
  },
  result: {
    score,
    gameScore: score,
    locationSimilarity: null,
    locationWeight: 0,
    locationReason: "位置缺失，不参与评分",
    gameOverlap: score,
    timeSimilarity: score,
    sharedGameCount: 0,
    unionGameCount: 1,
    rootGameCount: 1,
    friendGameCount: 1,
    rootMinutes: 60,
    friendMinutes: 60,
    reason: null,
    sharedGames: [],
  },
});

describe("game score presentation", () => {
  it("keeps known game overlap available when a hidden lifetime prevents scoring", () => {
    const sample = row("a", null);
    sample.result.gameOverlap = 50;
    sample.result.sharedGameCount = 1;
    sample.result.timeSimilarity = null;
    sample.result.rootMinutes = null;
    expect(hasGameSetComparison(sample, "ok")).toBe(true);
    expect(gameScoreValue(sample, "ok")).toBeNull();
  });
  it("keeps disjoint nonempty game sets known even with missing time", () => {
    const sample = row("a", null);
    sample.result.gameOverlap = 0;
    sample.result.sharedGameCount = 0;
    sample.result.timeSimilarity = null;
    expect(hasGameSetComparison(sample, "ok")).toBe(true);
    expect(sample.result.sharedGameCount).toBe(0);
  });
  it("does not present retained or empty game sets as a current comparison", () => {
    expect(hasGameSetComparison(row("a", null, "private"), "ok")).toBe(false);
    expect(hasGameSetComparison(row("a", null), "unknown")).toBe(false);
    const empty = row("a", null);
    empty.result.friendGameCount = 0;
    expect(hasGameSetComparison(empty, "ok")).toBe(false);
  });
  it("keeps an actual zero score distinct from unavailable data", () => {
    expect(gameScoreValue(row("a", 0), "ok")).toBe(0);
    expect(gameScoreValue(row("b", null), "ok")).toBeNull();
  });
  it.each(["unknown", "private", "error"] as const)(
    "does not score a %s friend using retained old values",
    (status) => {
      expect(gameScoreValue(row("a", 88, status), "ok")).toBeNull();
    },
  );
  it("does not score any friend when the root sample is unavailable", () => {
    expect(gameScoreValue(row("a", 88), "private")).toBeNull();
  });
  it("ranks real zero above unknown, preserves precise IDs and leaves source data unchanged", () => {
    const rows = [
      row("76561199521553744", null),
      row("76561199521553745", 0),
      row("76561199521553746", 91),
    ];
    expect(rankGameScores(rows, "ok").map((item) => item.player.id)).toEqual([
      "76561199521553746",
      "76561199521553745",
      "76561199521553744",
    ]);
    expect(rows[0].player.id).toBe("76561199521553744");
  });
});
