import { afterEach, expect, it, vi } from "vitest";
import {
  PublicWebProvider,
  classifyStatus,
  DemoProvider,
  demoIds,
} from "../src/provider.js";
import { parseFriendsPage, parseProfilePage } from "../src/community.js";

const root = demoIds[0];
const friend = demoIds[1];
const header = `<script>var g_rgProfileData = ${JSON.stringify({ steamid: root, personaname: '测试 } 玩家; "name"', url: `https://steamcommunity.com/profiles/${root}/` })};</script>`;
function friendsPage(count: number, cards: string) {
  return `${header}<script>var g_rgCounts = {"cFriends":${count},"success":1};</script><a data-navid="friends"></a><div id="friends_list"><div id="search_results">${cards}</div></div>`;
}
function card(id: string, name = "朋友 &amp; 好友") {
  return `<div class="selectable friend_block_v2 persona online" data-steamid="${id}"><a class="selectable_overlay" href="https://steamcommunity.com/profiles/${id}"></a><div class="player_avatar"><img src="https://avatars.fastly.steamstatic.com/example_medium.jpg"></div><div class="friend_block_content">${name}<br><span class="friend_small_text">Online<br>Counter-Strike 2</span></div></div>`;
}
afterEach(() => vi.unstubAllGlobals());

it("extracts exact string IDs, decoded names and avatars only from friend cards", () => {
  const result = parseFriendsPage(
    friendsPage(1, card(friend) + card(friend)) +
      `<div data-steamid="${demoIds[2]}"></div>`,
    root,
  );
  expect(result.friends).toEqual([friend]);
  expect(result.players).toEqual([
    {
      id: friend,
      name: "朋友 & 好友",
      avatar: "https://avatars.fastly.steamstatic.com/example_medium.jpg",
      profileUrl: `https://steamcommunity.com/profiles/${friend}`,
    },
  ]);
});
it("requires a public list, friends navigation and confirmed count to accept an empty list", () => {
  expect(parseFriendsPage(friendsPage(0, ""), root).friends).toEqual([]);
  expect(() =>
    parseFriendsPage(
      friendsPage(0, "").replace('<a data-navid="friends"></a>', ""),
      root,
    ),
  ).toThrow(/未公开|无法确认/);
  expect(() =>
    parseFriendsPage(`${header}<div id="friends_list"></div>`, root),
  ).toThrow();
  expect(() => parseFriendsPage(friendsPage(2, card(friend)), root)).toThrow(
    /数量/,
  );
  expect(() => parseFriendsPage(friendsPage(1, card("123")), root)).toThrow();
});
it("does not mistake private, login, captcha, missing or changed pages for empty lists", () => {
  expect(() =>
    parseFriendsPage(
      `${header}<div class="profile_private_info">This profile is private.</div>`,
      root,
    ),
  ).toThrow(/未公开/);
  for (const html of [
    "<form action='/login'>Sign in</form>",
    "<div>Verify you are human</div>",
    "<h1>Sorry!</h1>",
    `${header}<div>Changed layout</div>`,
  ]) {
    expect(() => parseFriendsPage(html, root)).toThrow();
  }
  expect(() => parseFriendsPage(friendsPage(1, card(friend)), friend)).toThrow(
    /身份/,
  );
});
it("parses hundreds of friends without truncation", () => {
  const ids = Array.from({ length: 500 }, (_, i) =>
    String(76561198010000000n + BigInt(i)),
  );
  const result = parseFriendsPage(
    friendsPage(500, ids.map((id) => card(id)).join("")),
    root,
  );
  expect(result.friends).toHaveLength(500);
  expect(result.friends).toEqual([...ids].sort());
});
it("reads profile JSON as data, validates identity and ignores unsafe avatar URLs", () => {
  const player = parseProfilePage(
    `${header}<meta property="og:image" content="https://avatars.fastly.steamstatic.com/avatar.jpg">`,
    root,
  );
  expect(player).toMatchObject({
    id: root,
    name: '测试 } 玩家; "name"',
    avatar: "https://avatars.fastly.steamstatic.com/avatar.jpg",
  });
  expect(
    parseProfilePage(
      `${header}<meta property="og:image" content="javascript:alert(1)">`,
    ).avatar,
  ).toBeNull();
  expect(() => parseProfilePage(header, friend)).toThrow(/身份/);
  expect(() =>
    parseProfilePage("<script>g_rgProfileData = doSomething();</script>"),
  ).toThrow();
});
it("only fetches anonymous HTML community pages and resolves vanity from the page", async () => {
  const fetchMock = vi.fn(
    async (_input: unknown, _options?: RequestInit) =>
      new Response(friendsPage(1, card(friend)), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const provider = new PublicWebProvider();
  expect(provider.summaryBatchSize).toBe(1);
  expect(await provider.friends(root)).toEqual([friend]);
  expect(await provider.vanity("example")).toBe(root);
  expect(await provider.summaries([root])).toHaveLength(1);
  await expect(provider.summaries([root, friend])).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
    `https://steamcommunity.com/profiles/${root}/friends/?l=english`,
    "https://steamcommunity.com/id/example/?l=english",
    `https://steamcommunity.com/profiles/${root}/?l=english`,
  ]);
  for (const [, options] of fetchMock.mock.calls) {
    expect(options?.redirect).toBe("manual");
    const headers = new Headers(options?.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
  }
});
it("does not follow redirects or treat access errors/non-HTML as a private empty list", async () => {
  const provider = new PublicWebProvider();
  for (const status of [301, 302, 401, 403, 429, 503]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", {
            status,
            headers: { location: "https://example.com/" },
          }),
      ),
    );
    await expect(provider.friends(root)).rejects.toThrow();
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ friends: [] })),
  );
  await expect(provider.friends(root)).rejects.toThrow();
  expect(classifyStatus(429).kind).toBe("rate");
  expect(classifyStatus(503).kind).toBe("transient");
  expect(classifyStatus(403).message).not.toMatch(/密钥|API/);
});
it("marks a friends-page redirect to the same profile as unavailable without another request", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response("", {
        status: 302,
        headers: { location: `https://steamcommunity.com/profiles/${root}` },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(new PublicWebProvider().friends(root)).rejects.toMatchObject({
    kind: "private",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("distinguishes private lists from a real empty list in demo", async () => {
  const provider = new DemoProvider();
  await expect(provider.friends(demoIds[12])).rejects.toMatchObject({
    kind: "private",
  });
  await expect(provider.friends("76561199999999999")).resolves.toEqual([]);
});
