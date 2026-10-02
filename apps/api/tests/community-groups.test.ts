import { afterEach, expect, it, vi } from "vitest";
import { DemoProvider, demoIds, PublicWebProvider } from "../src/provider.js";

const playerId = "76561199521553744";
const groupId = "103582791475935550";
// Minimal structural fixture from the anonymous groups page. Names are synthetic.
const identity = `<script>var g_rgProfileData = {"steamid":"${playerId}","personaname":"Test player"};</script>`;
function page(count: number, cards = "") {
  return `${identity}<script>var g_rgCounts = {"cFriends":16,"cGroups":${count},"success":1};</script>
    <a data-navid="groups/"></a><div id="groups_list"><div id="search_results">
    <div id="search_results_empty" style="display:none">Sorry, there are no groups to show.</div>
    ${cards}</div></div>`;
}
function card(
  id = groupId,
  name = "Test &amp; Friends",
  members = "1,234 Members",
) {
  return `<div class="group_block invite_row"><div class="group_block_details">
    <div class="ellipsis groupTitle"><a class="linkTitle" href="https://steamcommunity.com/groups/test-${id}">${name}</a><span class="pubGroup"> - Public</span></div>
    <div class="memberRow"><a class="groupMemberStat linkStandard" href="https://steamcommunity.com/groups/test-${id}/members">${members}</a>
    <span class="groupMemberStat membersOnline">3 Online</span>
    <a class="groupMemberStat linkStandard steamLink" href="javascript:OpenGroupChat( '${id}' )">6 In Group Chat</a></div></div></div>`;
}
const response = (html: string) =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
async function read(html: string, id = playerId) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(html)),
  );
  const provider = new PublicWebProvider();
  expect(provider.groups).toBeTypeOf("function");
  return provider.groups(id);
}
afterEach(() => vi.unstubAllGlobals());

it("reads complete public group cards with exact clan IDs rather than names or slugs", async () => {
  expect(
    await read(page(1, card() + card()) + card("103582791475935551")),
  ).toEqual({
    totalCount: 1,
    groups: [
      {
        id: groupId,
        name: "Test & Friends",
        url: `https://steamcommunity.com/groups/test-${groupId}`,
        memberCount: 1234,
      },
    ],
  });
});

it("accepts a confirmed public empty list but rejects an unconfirmed empty shell", async () => {
  expect(await read(page(0))).toEqual({ groups: [], totalCount: 0 });
  await expect(
    read(page(0).replace('<a data-navid="groups/"></a>', "")),
  ).rejects.toMatchObject({ kind: "private" });
});

it("rejects wrong player identities, private pages, login pages and changed markup", async () => {
  await expect(read(page(0), demoIds[1])).rejects.toMatchObject({
    kind: "invalid",
  });
  await expect(
    read(
      `${identity}<div class="profile_private_info">This profile is private.</div>`,
    ),
  ).rejects.toMatchObject({ kind: "private" });
  for (const html of [
    "<form action='/login'>Sign in</form>",
    "<h1>Verify you are human</h1>",
    `${identity}<div>Changed layout</div>`,
  ]) {
    await expect(read(html)).rejects.toMatchObject({ kind: "invalid" });
  }
});

it("rejects truncated, malformed and unsuccessful list counts instead of silently paging or truncating", async () => {
  for (const html of [
    page(2, card()),
    page(0, card()),
    page(-1),
    page(1, card()).replace('"cGroups":1', '"cGroups":"1"'),
    page(1, card()).replace('"success":1', '"success":0'),
    page(1, card()).replace('"cGroups":1', '"cGroups":1.5'),
    page(1, card()).replace('"cGroups":1', '"unrelated":1'),
  ])
    await expect(read(html)).rejects.toMatchObject({ kind: "invalid" });
});

it("rejects cards without a valid stable group identity or a public Steam group link", async () => {
  for (const content of [
    card(playerId),
    card("1035827914759355500"),
    card("0"),
    card().replace("javascript:OpenGroupChat", "javascript:OtherFunction"),
    card().replace(' )"', ' );alert(1)"'),
    card(groupId, " "),
    card().replace(
      'class="linkTitle" href="https://steamcommunity.com/',
      'class="linkTitle" href="https://evil.example/',
    ),
    card().replace(
      'class="linkTitle" href="https://steamcommunity.com/',
      'class="linkTitle" href="https://name@steamcommunity.com/',
    ),
    card().replace(
      'class="linkTitle" href="https://steamcommunity.com/',
      'class="linkTitle" href="http://steamcommunity.com/',
    ),
  ])
    await expect(read(page(1, content))).rejects.toMatchObject({
      kind: "invalid",
    });
});

it("keeps undisclosed or malformed member counts unknown instead of taking online counts", async () => {
  for (const members of [
    "",
    "Members",
    "1.2k Members",
    "1,23 Members",
    "9007199254740992 Members",
  ]) {
    expect(
      (await read(page(1, card(groupId, "Test group", members)))).groups[0]
        .memberCount,
    ).toBeNull();
  }
  expect(
    (await read(page(1, card(groupId, "Test group", "1 Member")))).groups[0]
      .memberCount,
  ).toBe(1);
});

it("reads hundreds of groups without losing exact IDs or imposing a display limit", async () => {
  const ids = Array.from({ length: 500 }, (_, i) =>
    String(103582791475930000n + BigInt(i)),
  );
  const result = await read(
    page(ids.length, ids.map((id) => card(id)).join("")),
  );
  expect(result.totalCount).toBe(500);
  expect(result.groups.map((group) => group.id).sort()).toEqual(ids);
});

it("uses one anonymous HTML request with manual redirects for a groups operation", async () => {
  const fetchMock = vi.fn(async (_url: unknown, _options?: RequestInit) =>
    response(page(0)),
  );
  vi.stubGlobal("fetch", fetchMock);
  const provider = new PublicWebProvider();
  expect(provider.groups).toBeTypeOf("function");
  await provider.groups(playerId);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(
    `https://steamcommunity.com/profiles/${playerId}/groups/?l=english`,
  );
  const options = fetchMock.mock.calls[0][1]!;
  expect(options.redirect).toBe("manual");
  expect(options.method ?? "GET").toBe("GET");
  expect(new Headers(options.headers).has("cookie")).toBe(false);
  expect(new Headers(options.headers).has("authorization")).toBe(false);
  await expect(provider.groups("invalid")).rejects.toMatchObject({
    kind: "invalid",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("treats a redirect to the same profile as private without following another page", async () => {
  for (const suffix of ["", "/", "?l=english", "/?l=english"]) {
    const fetchMock = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: {
            location: `https://steamcommunity.com/profiles/${playerId}${suffix}`,
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PublicWebProvider();
    expect(provider.groups).toBeTypeOf("function");
    await expect(provider.groups(playerId)).rejects.toMatchObject({
      kind: "private",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});

it("rejects unrelated redirects and non-HTML responses without accepting an empty list", async () => {
  for (const result of [
    new Response("", {
      status: 302,
      headers: { location: "https://steamcommunity.com/login/" },
    }),
    new Response("", {
      status: 302,
      headers: {
        location: `https://steamcommunity.com/profiles/${demoIds[1]}`,
      },
    }),
    Response.json({ groups: [] }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => result),
    );
    const provider = new PublicWebProvider();
    expect(provider.groups).toBeTypeOf("function");
    await expect(provider.groups(playerId)).rejects.toMatchObject({
      kind: "invalid",
    });
  }
});

it("supplies demo overlap while retaining public empty and private group states", async () => {
  const provider = new DemoProvider();
  expect(provider.groups).toBeTypeOf("function");
  const root = await provider.groups(demoIds[0]);
  const friend = await provider.groups(demoIds[1]);
  expect(
    root.groups.some((group) =>
      friend.groups.some((other) => group.id === other.id),
    ),
  ).toBe(true);
  expect(root.totalCount).toBe(root.groups.length);
  expect(await provider.groups(demoIds[11])).toEqual({
    groups: [],
    totalCount: 0,
  });
  await expect(provider.groups(demoIds[12])).rejects.toMatchObject({
    kind: "private",
  });
});
