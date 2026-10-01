import { describe, expect, it } from "vitest";
import { calculateGameScore } from "../src/game-scoring.js";
import type { GameProfileSnapshot } from "../../../packages/shared/src/index.js";

const snapshot = (
  games: [string, number | null][],
  status: GameProfileSnapshot["status"] = "ok",
): GameProfileSnapshot => ({
  playerId: "76561199521553744",
  status,
  scope: "profile_recent",
  fetchedAt: "2026-10-02T00:00:00Z",
  attemptedAt: "2026-10-02T00:00:00Z",
  message: null,
  games: games.map(([appId, minutes]) => ({
    appId,
    minutes,
    name: `Game ${appId}`,
  })),
});
describe("visible-game similarity", () => {
  it("applies at most five percent for public location and leaves undisclosed locations neutral", () => {
    const a = snapshot([
      ["1", 75],
      ["2", 25],
    ]);
    const b = snapshot([
      ["1", 25],
      ["2", 75],
    ]);
    const location = {
      label: "Shanghai, Shanghai, China",
      countryCode: "cn",
      locality: "Shanghai, Shanghai",
    };
    a.profile = { realName: null, location };
    expect(calculateGameScore(a, b)).toMatchObject({
      gameScore: 70,
      score: 70,
      locationWeight: 0,
      locationSimilarity: null,
    });
    b.profile = {
      realName: "Unrelated",
      location: { ...location, locality: "ＳＨＡＮＧＨＡＩ,   Shanghai" },
    };
    expect(calculateGameScore(a, b)).toMatchObject({
      gameScore: 70,
      score: 71.5,
      locationWeight: 5,
      locationSimilarity: 100,
    });
    b.profile.location = {
      label: "Beijing, China",
      locality: "Beijing",
      countryCode: "cn",
    };
    expect(calculateGameScore(a, b)).toMatchObject({
      score: 69,
      locationSimilarity: 50,
    });
    b.profile.location = { label: "Japan", locality: null, countryCode: "jp" };
    expect(calculateGameScore(a, b)).toMatchObject({
      score: 66.5,
      locationSimilarity: 0,
    });
    b.profile.location.countryCode = null;
    expect(calculateGameScore(a, b)).toMatchObject({
      score: 70,
      locationWeight: 0,
      locationSimilarity: null,
    });
  });
  it("does not claim a full location match for country-only fields or score with missing games", () => {
    const a = snapshot([["1", 10]]),
      b = snapshot([["1", 10]]);
    a.profile = b.profile = {
      realName: null,
      location: { label: "China", countryCode: "cn", locality: null },
    };
    expect(calculateGameScore(a, b)).toMatchObject({
      score: 97.5,
      locationSimilarity: 50,
    });
    b.games = [];
    expect(calculateGameScore(a, b)).toMatchObject({
      score: null,
      gameScore: null,
      locationWeight: 0,
    });
    expect(calculateGameScore({ ...a, status: "error" }, a)).toMatchObject({
      score: null,
      locationSimilarity: null,
    });
  });
  it("gives identical proportions 100 regardless of total playtime", () => {
    const result = calculateGameScore(
      snapshot([
        ["1", 75],
        ["2", 25],
      ]),
      snapshot([
        ["1", 7500],
        ["2", 2500],
      ]),
    );
    expect(result).toMatchObject({
      score: 100,
      gameOverlap: 100,
      timeSimilarity: 100,
      sharedGameCount: 2,
      rootMinutes: 100,
      friendMinutes: 10000,
    });
  });
  it("weights game overlap 40% and distribution intersection 60%", () => {
    expect(
      calculateGameScore(
        snapshot([
          ["1", 75],
          ["2", 25],
        ]),
        snapshot([
          ["1", 25],
          ["2", 75],
        ]),
      ),
    ).toMatchObject({ score: 70, gameOverlap: 100, timeSimilarity: 50 });
    expect(
      calculateGameScore(
        snapshot([
          ["1", 50],
          ["2", 50],
        ]),
        snapshot([
          ["1", 50],
          ["3", 50],
        ]),
      ),
    ).toMatchObject({
      score: 43.3,
      gameOverlap: 33.3,
      timeSimilarity: 50,
      unionGameCount: 3,
    });
  });
  it("returns zero only for nonempty disjoint known samples", () => {
    expect(
      calculateGameScore(snapshot([["1", 10]]), snapshot([["2", 20]])),
    ).toMatchObject({ score: 0, sharedGameCount: 0 });
    expect(
      calculateGameScore(snapshot([]), snapshot([["2", 20]])).score,
    ).toBeNull();
  });
  it("keeps unknown or unavailable data out of the numeric ranking", () => {
    for (const status of ["unknown", "private", "error"] as const) {
      const result = calculateGameScore(
        snapshot([["1", 10]], status),
        snapshot([["1", 10]]),
      );
      expect(result.score).toBeNull();
      expect(result.gameOverlap).toBeNull();
      expect(result.reason).toBeTruthy();
    }
    const hidden = calculateGameScore(
      snapshot([["1", null]]),
      snapshot([["1", 10]]),
    );
    expect(hidden).toMatchObject({
      score: null,
      gameOverlap: 100,
      timeSimilarity: null,
      rootMinutes: null,
    });
    expect(hidden.sharedGames[0].rootMinutes).toBeNull();
  });
  it("cannot normalize zero or malformed times", () => {
    for (const minutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = calculateGameScore(
        snapshot([["1", minutes]]),
        snapshot([["1", 10]]),
      );
      expect(result.score).toBeNull();
      expect(result.reason).toBeTruthy();
    }
  });
  it("is symmetric, deduplicates app IDs, and preserves a zero observation", () => {
    const a = snapshot([
        ["1", 10],
        ["1", 10],
        ["2", 0],
      ]),
      b = snapshot([
        ["1", 20],
        ["3", 5],
      ]);
    const forward = calculateGameScore(a, b),
      reverse = calculateGameScore(b, a);
    expect(forward.score).toBe(reverse.score);
    expect(forward.rootGameCount).toBe(2);
    expect(forward.rootMinutes).toBe(10);
    expect(forward.sharedGameCount).toBe(1);
  });
});
