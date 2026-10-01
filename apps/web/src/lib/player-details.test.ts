import { describe, expect, it, vi } from "vitest";
import type { PlayerDetailsSnapshot } from "../../../../packages/shared/src/index";
import { loadPlayerDetails, profileCardPosition } from "./player-details";

const snapshot = (
  status: PlayerDetailsSnapshot["profileStatus"],
): PlayerDetailsSnapshot => ({
  playerId: "76561199521553744",
  profile: null,
  profileStatus: status,
  profileFetchedAt: null,
  profileAttemptedAt: null,
  profileMessage: null,
  aliases: [],
  aliasesStatus: status,
  aliasesFetchedAt: null,
  aliasesAttemptedAt: null,
  aliasesMessage: null,
});
describe("public profile hover data", () => {
  it("collects once after a cache read only when a section is unknown", async () => {
    const cached = snapshot("ok");
    cached.aliasesStatus = "unknown";
    const read = vi.fn().mockResolvedValue(cached);
    const collect = vi.fn().mockResolvedValue(snapshot("ok"));
    await loadPlayerDetails(cached.playerId, read, collect);
    expect(read).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledExactlyOnceWith(cached.playerId, false);
  });
  it.each(["ok", "private", "error"] as const)(
    "reuses %s cache without a Steam request",
    async (status) => {
      const cached = snapshot(status);
      const collect = vi.fn();
      expect(
        await loadPlayerDetails(cached.playerId, async () => cached, collect),
      ).toBe(cached);
      expect(collect).not.toHaveBeenCalled();
    },
  );
  it("does not retry a failed collection automatically", async () => {
    const collect = vi.fn().mockRejectedValue(new Error("limited"));
    await expect(
      loadPlayerDetails("id", async () => snapshot("unknown"), collect),
    ).rejects.toThrow("limited");
    expect(collect).toHaveBeenCalledOnce();
  });
  it("keeps cards inside narrow and bottom-edge viewports", () => {
    expect(
      profileCardPosition(
        { left: 370, right: 390, top: 700, bottom: 740 },
        320,
        500,
        390,
        760,
      ),
    ).toEqual({ left: 38, top: 248 });
    expect(
      profileCardPosition(
        { left: 1, right: 20, top: 1, bottom: 20 },
        320,
        500,
        280,
        400,
      ),
    ).toEqual({ left: 12, top: 12 });
  });
});
