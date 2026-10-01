import { load } from "cheerio";
import type {
  ProfileAlias,
  PublicProfileDetails,
} from "../../../packages/shared/src/index.js";
import { parseProfilePage } from "./community.js";
import { SteamError } from "./steam-error.js";

const clean = (text: string) =>
  text
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function parsePublicProfile(
  html: string,
  expectedId: string,
): PublicProfileDetails {
  const $ = load(html);
  parseProfilePage(html, expectedId);
  if (/private|not public/i.test($(".profile_private_info").text()))
    throw new SteamError("private", "个人资料未公开或不可访问");
  const realName =
    clean($(".header_real_name > bdi").first().text()).slice(0, 200) || null;
  const location = $(".header_location").first();
  const label = clean(location.text()).slice(0, 300);
  if (!label) return { realName, location: null };
  let countryCode: string | null = null;
  try {
    const flag = new URL(location.find(".profile_flag").attr("src") ?? "");
    if (
      flag.protocol === "https:" &&
      !flag.username &&
      !flag.password &&
      [
        "community.fastly.steamstatic.com",
        "community.akamai.steamstatic.com",
        "community.cloudflare.steamstatic.com",
        "steamcommunity.com",
      ].includes(flag.hostname)
    )
      countryCode =
        /^\/public\/images\/countryflags\/([a-z]{2})\.gif$/i
          .exec(flag.pathname)?.[1]
          .toLowerCase() ?? null;
  } catch {}
  // A comma can be part of a country's name. Only remove a positively known
  // English country suffix; unfamiliar Steam spellings stay country-only.
  let locality: string | null = null;
  if (countryCode) {
    for (const style of ["long", "short"] as const) {
      const country = new Intl.DisplayNames(["en"], {
        type: "region",
        style,
      }).of(countryCode.toUpperCase());
      const suffix = country ? `, ${country}` : "";
      if (suffix && label.toLowerCase().endsWith(suffix.toLowerCase())) {
        locality = clean(label.slice(0, -suffix.length)) || null;
        break;
      }
    }
  }
  return {
    realName,
    location: {
      label,
      countryCode,
      locality,
    },
  };
}

export function parsePublicAliases(text: string): ProfileAlias[] {
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    throw new SteamError("invalid", "公开曾用名格式无效");
  }
  if (!Array.isArray(values) || values.length > 100)
    throw new SteamError("invalid", "无法确认官网公开名称记录");
  return values.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("newname" in item) ||
      typeof item.newname !== "string" ||
      !item.newname.trim() ||
      item.newname.length > 1000
    )
      throw new SteamError("invalid", "公开名称记录格式发生变化");
    const changedAt =
      "timechanged" in item && typeof item.timechanged === "string"
        ? item.timechanged.slice(0, 200)
        : null;
    // Keep Steam's currently exposed record, including the current name. Render
    // strings as text in React, never as markup or a permanent complete history.
    return { name: item.newname, changedAt };
  });
}
