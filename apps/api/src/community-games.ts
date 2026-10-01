import { load } from "cheerio";
import type {
  GamePlaytime,
  PublicGames,
} from "../../../packages/shared/src/index.js";
import { parseProfilePage } from "./community.js";
import { SteamError } from "./steam-error.js";

export function parsePublicGames(
  html: string,
  expectedId: string,
): PublicGames {
  const $ = load(html);
  if (
    $(".profile_private_info")
      .text()
      .match(/private|not public/i)
  )
    throw new SteamError("private", "游戏活动未公开：个人资料不可访问");
  parseProfilePage(html, expectedId);
  if (!$(".recent_games").length)
    throw new SteamError(
      "private",
      "公开主页未展示游戏活动，无法读取游戏和时长",
    );
  const games = new Map<string, GamePlaytime>();
  for (const element of $(".recent_games .recent_game").toArray()) {
    const card = $(element),
      link = card.find(".game_name a").first();
    let url: URL;
    try {
      url = new URL(link.attr("href") ?? "");
    } catch {
      throw new SteamError("invalid", "公开游戏卡片格式发生变化");
    }
    const appId = /^\/app\/(\d+)\/?$/.exec(url.pathname)?.[1];
    const name = link.text().trim();
    if (
      url.protocol !== "https:" ||
      !["steamcommunity.com", "store.steampowered.com"].includes(
        url.hostname,
      ) ||
      !appId ||
      !/^[1-9]\d{0,9}$/.test(appId) ||
      !name
    )
      throw new SteamError("invalid", "公开游戏卡片身份或名称无效");
    let detail = "";
    for (const node of card
      .find(".game_info_details")
      .first()
      .contents()
      .toArray()) {
      if (node.type === "tag" && node.name === "br") break;
      detail += $(node).text();
    }
    const time =
      /^(\S+)\s+(hrs?|hours?|mins?|minutes?)\s+on\s+record\s*$/i.exec(
        detail.trim(),
      );
    if (!time && /on\s+record/i.test(detail))
      throw new SteamError("invalid", "公开游戏时长格式无效");
    let minutes: number | null = null;
    if (time) {
      if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(time[1]))
        throw new SteamError("invalid", "公开游戏时长格式无效");
      const amount = Number(time[1].replaceAll(",", ""));
      minutes = Math.round(amount * (/^(?:hr|hour)/i.test(time[2]) ? 60 : 1));
      if (!Number.isSafeInteger(minutes) || minutes < 0)
        throw new SteamError("invalid", "公开游戏时长超出有效范围");
    }
    // Profile cards represent only the games Steam currently chooses to show.
    // Missing games and hidden times are never converted to an empty full library.
    if (!games.has(appId))
      games.set(appId, { appId, name: name.slice(0, 200), minutes });
  }
  return { scope: "profile_recent", games: [...games.values()] };
}
