import { load, type CheerioAPI } from "cheerio";
import type {
  PublicGroups,
  SteamGroup,
} from "../../../packages/shared/src/index.js";
import { parseProfilePage } from "./community.js";
import { SteamError } from "./steam-error.js";

const clean = (value: string) =>
  value
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const invalid = (message = "无法确认完整群组列表，Steam 网页结构可能已变化") =>
  new SteamError("invalid", message);

function groupCount($: CheerioAPI): number {
  // Steam embeds a flat JSON counts object. Parse data only, never page JavaScript.
  for (const script of $("script").toArray()) {
    const match = /\bg_rgCounts\s*=\s*(\{[^{}]*\})\s*;?/.exec($(script).text());
    if (!match) continue;
    let counts: Record<string, unknown>;
    try {
      counts = JSON.parse(match[1]);
    } catch {
      throw invalid();
    }
    if (
      counts.success !== 1 ||
      !Number.isSafeInteger(counts.cGroups) ||
      (counts.cGroups as number) < 0
    )
      throw invalid();
    return counts.cGroups as number;
  }
  throw invalid();
}

function groupUrl(value: string | undefined, groupId: string): string {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol === "https:" &&
      url.hostname === "steamcommunity.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (/^\/groups\/[^/]+\/?$/.test(url.pathname) ||
        url.pathname.replace(/\/$/, "") === `/gid/${groupId}`)
    )
      return url.href;
  } catch {}
  throw invalid("Steam 网页群组地址无效");
}

function memberCount(value: string): number | null {
  const match = /^(\d+|\d{1,3}(?:,\d{3})+) Members?$/i.exec(clean(value));
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** A successful result always contains the full, count-checked public list. */
export function parsePublicGroups(
  html: string,
  expectedId: string,
): PublicGroups {
  const $ = load(html);
  if (/private|not public/i.test($(".profile_private_info").text()))
    throw new SteamError("private", "群组列表未公开或不可访问");
  parseProfilePage(html, expectedId);
  const totalCount = groupCount($);
  if (!$("#groups_list #search_results").length) throw invalid();
  const groups = new Map<string, SteamGroup>();
  for (const element of $(
    "#groups_list #search_results .group_block",
  ).toArray()) {
    const card = $(element);
    const ids = card
      .find("a.steamLink[href]")
      .toArray()
      .map(
        (link) =>
          /^javascript:\s*OpenGroupChat\(\s*['"]([1-9]\d{17})['"]\s*\)\s*;?\s*$/.exec(
            $(link).attr("href") ?? "",
          )?.[1],
      )
      .filter((id): id is string => Boolean(id));
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== 1)
      throw invalid("Steam 网页群组身份无效，未保存不完整结果");
    const id = ids[0];
    const title = card.find(".groupTitle a.linkTitle").first();
    const name = clean(title.text());
    if (!name) throw invalid("Steam 网页群组名称不完整");
    const group: SteamGroup = {
      id,
      name: name.slice(0, 200),
      url: groupUrl(title.attr("href"), id),
      memberCount: memberCount(
        card
          .find(".memberRow a.groupMemberStat[href$='/members']")
          .first()
          .text(),
      ),
    };
    if (!groups.has(id)) groups.set(id, group);
  }
  if (groups.size !== totalCount)
    throw invalid("Steam 网页群组数量与列表不一致，未保存不完整结果");
  // Hidden lists can render an empty shell; require its public navigation too.
  if (!groups.size && !$("[data-navid='groups/']").length)
    throw new SteamError("private", "群组列表未公开或无法确认");
  return {
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)),
    totalCount,
  };
}
