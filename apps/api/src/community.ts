import { load, type CheerioAPI } from "cheerio";
import { validSteamId } from "./identity.js";
import { SteamError } from "./steam-error.js";
import type { Player } from "./provider.js";

// Read JSON literals embedded by Steam without evaluating page JavaScript.
function assignedJson(
  $: CheerioAPI,
  variable: string,
): Record<string, unknown> | null {
  for (const script of $("script").toArray()) {
    const source = $(script).text();
    const match = new RegExp(`\\b${variable}\\s*=\\s*\\{`).exec(source);
    if (!match) continue;
    const start = match.index + match[0].length - 1;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          throw new SteamError("invalid", "Steam 网页资料格式发生变化");
        }
      }
    }
  }
  return null;
}

function publicIdentity($: CheerioAPI, expectedId?: string) {
  const data = assignedJson($, "g_rgProfileData");
  if (!data || !validSteamId(data.steamid))
    throw new SteamError(
      "invalid",
      "无法识别 Steam 公开网页，可能需要验证或页面结构已变化",
    );
  if (expectedId && data.steamid !== expectedId)
    throw new SteamError("invalid", "Steam 网页身份与查询对象不一致");
  return {
    id: data.steamid as string,
    name:
      typeof data.personaname === "string"
        ? data.personaname.slice(0, 200)
        : (data.steamid as string),
  };
}

function avatarUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseProfilePage(html: string, expectedId?: string): Player {
  const $ = load(html);
  const identity = publicIdentity($, expectedId);
  const avatar = avatarUrl($("meta[property='og:image']").attr("content"));
  return {
    ...identity,
    avatar,
    profileUrl: `https://steamcommunity.com/profiles/${identity.id}`,
  };
}

export function parseFriendsPage(
  html: string,
  expectedId: string,
): { friends: string[]; players: Player[] } {
  const $ = load(html);
  if (
    $(".profile_private_info")
      .text()
      .match(/private|not public/i)
  )
    throw new SteamError("private", "好友列表未公开");
  publicIdentity($, expectedId);
  const counts = assignedJson($, "g_rgCounts");
  if (
    !$("#friends_list #search_results").length ||
    !counts ||
    counts.success !== 1 ||
    !Number.isSafeInteger(counts.cFriends) ||
    (counts.cFriends as number) < 0
  )
    throw new SteamError(
      "invalid",
      "无法确认完整好友列表，Steam 网页结构可能已变化",
    );

  const players = new Map<string, Player>();
  for (const element of $("#friends_list .friend_block_v2").toArray()) {
    const card = $(element);
    const id = card.attr("data-steamid");
    if (!validSteamId(id) || id === expectedId)
      throw new SteamError("invalid", "Steam 网页好友身份数据无效");
    const content = card.find(".friend_block_content").first();
    const name = content
      .contents()
      .filter((_, node) => node.type === "text")
      .text()
      .trim();
    if (!name) throw new SteamError("invalid", "Steam 网页好友资料不完整");
    const avatar = card
      .find(".player_avatar img")
      .not(".profile_avatar_frame img")
      .first();
    players.set(id as string, {
      id: id as string,
      name: name.slice(0, 200),
      avatar: avatarUrl(
        avatar.attr("src") ?? avatar.attr("srcset")?.split(/\s+/)[0],
      ),
      profileUrl: `https://steamcommunity.com/profiles/${id}`,
    });
  }
  if (players.size !== counts.cFriends)
    throw new SteamError(
      "invalid",
      "Steam 网页好友数量与列表不一致，未保存不完整结果",
    );
  // Steam also renders an empty shell for hidden lists, with cFriends:0/success:1.
  // The missing Friends navigation distinguishes that shell from a public empty list.
  if (!players.size && !$("[data-navid='friends']").length)
    throw new SteamError("private", "好友列表未公开或无法确认，已保留已有关系");
  const friends = [...players.keys()].sort();
  return { friends, players: friends.map((id) => players.get(id)!) };
}
