import { afterEach, expect, it, vi } from "vitest";
import { PublicWebProvider } from "../src/provider.js";

const id = "76561199521553744";
const identity = `<script>g_rgProfileData={"steamid":"${id}","personaname":"Player"};</script>`;
const header = (
  location = "Shanghai, Shanghai, China",
  code = "cn",
) => `${identity}
<div class="header_real_name ellipsis"><bdi> Name &amp; Name </bdi>
<div class="header_location"><img class="profile_flag" src="https://community.fastly.steamstatic.com/public/images/countryflags/${code}.gif">${location}</div></div>
<div id="application_config" data-config='{"COUNTRY":"GB"}'></div>`;
const html = (value: string) =>
  new Response(value, { headers: { "content-type": "text/html" } });
afterEach(() => vi.unstubAllGlobals());

it("extracts only the public name and displayed location, never the visitor's country", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html(header())),
  );
  const result = await new PublicWebProvider().profile(id);
  expect(result).toEqual({
    realName: "Name & Name",
    location: {
      label: "Shanghai, Shanghai, China",
      countryCode: "cn",
      locality: "Shanghai, Shanghai",
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html(header("Hong Kong", "hk"))),
  );
  expect((await new PublicWebProvider().profile(id)).location).toEqual({
    label: "Hong Kong",
    countryCode: "hk",
    locality: null,
  });
});
it("keeps absent public fields unknown and rejects wrong identities or private headers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      html(`${identity}<div class="header_real_name"><bdi> </bdi></div>`),
    ),
  );
  expect(await new PublicWebProvider().profile(id)).toEqual({
    realName: null,
    location: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html(header())),
  );
  await expect(
    new PublicWebProvider().profile("76561198000000001"),
  ).rejects.toThrow(/身份/);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      html(
        `${identity}<div class="profile_private_info">This profile is private.</div>`,
      ),
    ),
  );
  await expect(new PublicWebProvider().profile(id)).rejects.toThrow(
    /公开|访问/,
  );
});
it("does not trust arbitrary flag URLs as a geographic code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      html(
        header().replace(
          "community.fastly.steamstatic.com",
          "untrusted.example",
        ),
      ),
    ),
  );
  expect((await new PublicWebProvider().profile(id)).location).toMatchObject({
    countryCode: null,
  });
});
it("does not invent a locality when the country display name itself contains commas", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html(header("Korea, Republic of", "kr"))),
  );
  expect((await new PublicWebProvider().profile(id)).location).toMatchObject({
    countryCode: "kr",
    locality: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html(header("Mystery, Unrecognized Country", "cn"))),
  );
  expect(
    (await new PublicWebProvider().profile(id)).location?.locality,
  ).toBeNull();
});
it("reads the same anonymous POST used by Steam's alias popup and preserves current names", async () => {
  const fetchMock = vi.fn(
    async (_url: unknown, _options?: RequestInit) =>
      new Response(
        JSON.stringify([
          { newname: "Current & Name", timechanged: "2 Jul, 2023 @ 5:26pm" },
          {
            newname: "<script>old</script>",
            timechanged: "1 Jul, 2023 @ 4:00pm",
          },
        ]),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await new PublicWebProvider().aliases(id)).toEqual([
    { name: "Current & Name", changedAt: "2 Jul, 2023 @ 5:26pm" },
    { name: "<script>old</script>", changedAt: "1 Jul, 2023 @ 4:00pm" },
  ]);
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    `https://steamcommunity.com/profiles/${id}/ajaxaliases/?l=english`,
  );
  const options = fetchMock.mock.calls[0][1]!;
  expect(options.method).toBe("POST");
  expect(options.redirect).toBe("manual");
  expect(new Headers(options.headers).has("cookie")).toBe(false);
  expect(new Headers(options.headers).has("authorization")).toBe(false);
});
it("distinguishes an empty public alias history from invalid or inaccessible responses", async () => {
  for (const value of [
    { success: false },
    [{ newname: 7 }],
    [{ newname: "" }],
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(new PublicWebProvider().aliases(id)).rejects.toThrow();
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("[]", { headers: { "content-type": "application/json" } }),
    ),
  );
  expect(await new PublicWebProvider().aliases(id)).toEqual([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => html("Sign in")),
  );
  await expect(new PublicWebProvider().aliases(id)).rejects.toThrow();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("", { status: 302, headers: { location: "/login/" } }),
    ),
  );
  await expect(new PublicWebProvider().aliases(id)).rejects.toThrow();
});
it("captures profile metadata with the existing single game-page request", async () => {
  const fetchMock = vi.fn(async () =>
    html(
      header() +
        `<div class="recent_games"><div class="recent_game"><div class="game_name"><a href="https://steamcommunity.com/app/570">Dota 2</a></div><div class="game_info_details">10 hrs on record<br>last played today</div></div></div>`,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await new PublicWebProvider().games(id);
  expect(result.profile?.realName).toBe("Name & Name");
  expect(result.games[0].minutes).toBe(600);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
