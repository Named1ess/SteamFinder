import { afterEach, expect, it, vi } from "vitest";
import { parsePublicGames } from "../src/community-games.js";
import { PublicWebProvider } from "../src/provider.js";
const id = "76561199521553744";
const identity = `<script>g_rgProfileData={"steamid":"${id}","personaname":"Player"};</script>`;
const card = (app: string, time: string, name = "Game &amp; Friends") =>
  `<div class="recent_game"><div class="game_info"><div class="game_name"><a href="https://steamcommunity.com/app/${app}">${name}</a></div><div class="game_info_details">${time}<br>last played on 1 Oct</div></div></div>`;
afterEach(() => vi.unstubAllGlobals());
it("extracts visible app IDs and lifetime times, never overall two-week activity", () => {
  const result = parsePublicGames(
    `${identity}<div class="recentgame_recentplaytime">107.2 hours past 2 weeks</div><div class="recent_games">${card("570", "1,706 hrs on record")}${card("730", "3.6 hrs on record")}${card("440", "12 mins on record")}</div>`,
    id,
  );
  expect(result.scope).toBe("profile_recent");
  expect(result.games).toEqual([
    { appId: "570", name: "Game & Friends", minutes: 102360 },
    { appId: "730", name: "Game & Friends", minutes: 216 },
    { appId: "440", name: "Game & Friends", minutes: 12 },
  ]);
});
it("retains hidden playtime as null and distinguishes zero", () => {
  const result = parsePublicGames(
    `${identity}<div class="recent_games">${card("570", "")}${card("730", "0 hrs on record")}</div>`,
    id,
  );
  expect(result.games.map((g) => g.minutes)).toEqual([null, 0]);
});
it("does not mistake private activity, login screens or unrelated showcase games for a complete library", () => {
  expect(() =>
    parsePublicGames(
      `${identity}<div class="profile_private_info">This profile is private.</div>`,
      id,
    ),
  ).toThrow();
  expect(() =>
    parsePublicGames(`<div data-featuretarget="login"></div>`, id),
  ).toThrow();
  expect(() =>
    parsePublicGames(identity + card("570", "10 hrs on record"), id),
  ).toThrow();
  expect(() =>
    parsePublicGames(
      `${identity}<div class="recent_games">${card("570", "1 hr on record")}</div>`,
      "76561198000000001",
    ),
  ).toThrow(/身份/);
  expect(
    parsePublicGames(`${identity}<div class="recent_games"></div>`, id).games,
  ).toEqual([]);
});
it("rejects malformed game cards and deduplicates a repeated game", () => {
  expect(() =>
    parsePublicGames(
      `${identity}<div class="recent_games">${card("570", "1e3 hrs on record")}</div>`,
      id,
    ),
  ).toThrow();
  expect(() =>
    parsePublicGames(
      `${identity}<div class="recent_games">${card("570", "-10 hrs on record")}</div>`,
      id,
    ),
  ).toThrow();
  expect(() =>
    parsePublicGames(
      `${identity}<div class="recent_games">${card("invalid", "10 hrs on record")}</div>`,
      id,
    ),
  ).toThrow();
  expect(() =>
    parsePublicGames(
      `${identity}<div class="recent_games">${card("570", "1,23 hrs on record")}</div>`,
      id,
    ),
  ).toThrow();
  expect(
    parsePublicGames(
      `${identity}<div class="recent_games">${card("570", "10 hrs on record")}${card("570", "10 hrs on record")}</div>`,
      id,
    ).games,
  ).toHaveLength(1);
});
it("gets games from one anonymous profile HTML request without a games API or login", async () => {
  const fetchMock = vi.fn(
    async (_input: unknown, _init?: RequestInit) =>
      new Response(
        `${identity}<div class="recent_games">${card("570", "10 hrs on record")}</div>`,
        { headers: { "content-type": "text/html" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect((await new PublicWebProvider().games(id)).games[0].minutes).toBe(600);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    `https://steamcommunity.com/profiles/${id}/?l=english`,
  );
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("cookie")).toBe(
    false,
  );
});
