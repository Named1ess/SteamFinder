import { DEFAULT_ROOT } from "../../../packages/shared/src/index.js";
import { validSteamId } from "./identity.js";
import { parseFriendsPage, parseProfilePage } from "./community.js";
import { parsePublicGames } from "./community-games.js";
import { parsePublicGroups } from "./community-groups.js";
import type {
  PublicGames,
  PublicGroups,
  PublicProfileDetails,
  ProfileAlias,
} from "../../../packages/shared/src/index.js";
import { parsePublicAliases, parsePublicProfile } from "./community-profile.js";
import { SteamError, classifyStatus } from "./steam-error.js";
export { SteamError, classifyStatus } from "./steam-error.js";

export interface Player {
  id: string;
  name: string;
  avatar: string | null;
  profileUrl: string;
}
export interface Provider {
  readonly summaryBatchSize?: number;
  friends(id: string): Promise<string[]>;
  friendsWithPlayers?(
    id: string,
  ): Promise<{ friends: string[]; players: Player[] }>;
  summaries(ids: string[]): Promise<Player[]>;
  vanity(name: string): Promise<string>;
  games?(id: string): Promise<PublicGames>;
  groups?(id: string): Promise<PublicGroups>;
  profile?(id: string): Promise<PublicProfileDetails>;
  aliases?(id: string): Promise<ProfileAlias[]>;
}

export class PublicWebProvider implements Provider {
  readonly summaryBatchSize = 1;
  private async get(path: string, aliases = false): Promise<string> {
    const url = `https://steamcommunity.com/${path}?l=english`;
    const maxBytes = aliases ? 256 * 1024 : 8 * 1024 * 1024;
    try {
      const response = await fetch(url, {
        ...(aliases ? { method: "POST", body: "" } : {}),
        signal: AbortSignal.timeout(20000),
        redirect: "manual",
        headers: {
          "user-agent":
            "SteamFinder/0.1 (public Steam Community profile explorer)",
          accept: aliases ? "application/json" : "text/html",
          ...(aliases
            ? {
                "content-type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
              }
            : {}),
          "accept-language": "en-US,en;q=0.9",
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const listPage = /^profiles\/(\d{17})\/(friends|groups)\/$/.exec(path);
        const location = response.headers.get("location");
        // Hidden lists can redirect to the same player's profile. Mark
        // that list unavailable without following another unbudgeted request.
        if (
          listPage &&
          location &&
          [301, 302, 303, 307, 308].includes(response.status)
        ) {
          let isSameProfile = false;
          try {
            const target = new URL(location, url);
            isSameProfile =
              target.origin === "https://steamcommunity.com" &&
              !target.username &&
              !target.password &&
              target.pathname.replace(/\/$/, "") === `/profiles/${listPage[1]}`;
          } catch {}
          if (isSameProfile)
            throw new SteamError(
              "private",
              `${listPage[2] === "groups" ? "群组" : "好友"}页不可访问，Steam 已跳转至个人资料页`,
            );
        }
        throw classifyStatus(response.status);
      }
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes(aliases ? "application/json" : "text/html")
      ) {
        await response.body?.cancel();
        throw new SteamError(
          "invalid",
          aliases
            ? "Steam 返回的内容不是公开名称记录"
            : "Steam 返回的内容不是公开网页",
        );
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new SteamError("invalid", "Steam 网页过大，未保存不完整结果");
      }
      if (!response.body)
        throw new SteamError("invalid", "Steam 返回了空白网页");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new SteamError("invalid", "Steam 网页过大，未保存不完整结果");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error instanceof SteamError) throw error;
      throw new SteamError("transient", "Steam 公开网页网络请求失败");
    }
  }
  async friendsWithPlayers(id: string) {
    if (!validSteamId(id)) throw new SteamError("invalid", "无效的 Steam ID");
    return parseFriendsPage(await this.get(`profiles/${id}/friends/`), id);
  }
  async games(id: string): Promise<PublicGames> {
    if (!validSteamId(id)) throw new SteamError("invalid", "无效的 Steam ID");
    const html = await this.get(`profiles/${id}/`);
    return {
      ...parsePublicGames(html, id),
      profile: parsePublicProfile(html, id),
    };
  }
  async groups(id: string): Promise<PublicGroups> {
    if (!validSteamId(id)) throw new SteamError("invalid", "无效的 Steam ID");
    return parsePublicGroups(await this.get(`profiles/${id}/groups/`), id);
  }
  async profile(id: string): Promise<PublicProfileDetails> {
    if (!validSteamId(id)) throw new SteamError("invalid", "无效的 Steam ID");
    return parsePublicProfile(await this.get(`profiles/${id}/`), id);
  }
  async aliases(id: string): Promise<ProfileAlias[]> {
    if (!validSteamId(id)) throw new SteamError("invalid", "无效的 Steam ID");
    return parsePublicAliases(
      await this.get(`profiles/${id}/ajaxaliases/`, true),
    );
  }
  async friends(id: string): Promise<string[]> {
    return (await this.friendsWithPlayers(id)).friends;
  }
  async summaries(ids: string[]): Promise<Player[]> {
    if (ids.length !== 1 || !validSteamId(ids[0]))
      throw new SteamError(
        "invalid",
        "每次公开资料网页请求仅支持一个有效 Steam ID",
      );
    return [parseProfilePage(await this.get(`profiles/${ids[0]}/`), ids[0])];
  }
  async vanity(name: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 200)
      throw new SteamError("invalid", "无效的 Steam 自定义主页地址");
    return parseProfilePage(await this.get(`id/${encodeURIComponent(name)}/`))
      .id;
  }
}
export const demoIds = [
  DEFAULT_ROOT,
  ...Array.from({ length: 59 }, (_, i) =>
    String(76561198000000000n + BigInt(i + 1)),
  ),
];
export class DemoProvider implements Provider {
  async groups(id: string): Promise<PublicGroups> {
    const index = demoIds.indexOf(id);
    if (index === 12) throw new SteamError("private", "演示：群组列表未公开");
    if (index < 0 || index === 11) return { groups: [], totalCount: 0 };
    const groups = [index % 4, (index + 1) % 4].map((number) => ({
      id: String(103582791429521500n + BigInt(number)),
      name: `演示群组 ${number + 1} · 虚构`,
      url: `https://steamcommunity.com/gid/${103582791429521500n + BigInt(number)}`,
      memberCount: [12, 250, 12000, 600][number],
    }));
    return { groups, totalCount: groups.length };
  }
  async profile(id: string): Promise<PublicProfileDetails> {
    const index = demoIds.indexOf(id);
    if (index === 12) throw new SteamError("private", "演示：资料未公开");
    return {
      realName: `虚构资料名称 ${Math.max(0, index)}`,
      location:
        index === 11
          ? null
          : index % 3 === 0 || index % 5 === 0
            ? {
                label: "Shanghai, Shanghai, China",
                countryCode: "cn",
                locality: "Shanghai, Shanghai",
              }
            : index % 3 === 1
              ? {
                  label: "Beijing, China",
                  countryCode: "cn",
                  locality: "Beijing",
                }
              : { label: "Japan", countryCode: "jp", locality: null },
    };
  }
  async aliases(id: string): Promise<ProfileAlias[]> {
    const index = demoIds.indexOf(id);
    return [
      { name: `演示当前名 ${index}`, changedAt: "1 Oct, 2026 @ 12:00pm" },
      { name: `演示旧名 ${index}`, changedAt: "1 Jan, 2025 @ 1:00pm" },
    ];
  }
  async games(id: string): Promise<PublicGames> {
    const index = demoIds.indexOf(id);
    if (index === 12) throw new SteamError("private", "演示：游戏活动未公开");
    const selections = [
      { appId: "730", name: "Counter-Strike 2", minutes: 18000 },
      { appId: "570", name: "Dota 2", minutes: 6000 },
      { appId: "1172470", name: "Apex Legends", minutes: 12000 },
      { appId: "1172620", name: "Sea of Thieves", minutes: 1800 },
      { appId: "440", name: "Team Fortress 2", minutes: 3000 },
    ];
    return {
      scope: "profile_recent",
      profile: await this.profile(id),
      games: Array.from({ length: 3 }, (_, offset) => {
        const game =
          selections[(Math.max(index, 0) + offset) % selections.length];
        return {
          ...game,
          minutes:
            index === 11 && offset === 0
              ? null
              : Math.round(game.minutes * (1 + Math.max(index, 0) / 10)),
        };
      }),
    };
  }
  async vanity(_name: string) {
    return DEFAULT_ROOT;
  }
  async summaries(ids: string[]): Promise<Player[]> {
    return ids.map((id) => ({
      id,
      name:
        id === DEFAULT_ROOT
          ? "演示玩家 · 虚构起点"
          : `演示玩家 ${demoIds.indexOf(id)} · 虚构`,
      avatar: null,
      profileUrl: `https://steamcommunity.com/profiles/${id}`,
    }));
  }
  async friends(id: string): Promise<string[]> {
    const index = demoIds.indexOf(id);
    if (index === 12) throw new SteamError("private", "演示：好友列表未公开");
    if (index === -1) return [];
    const neighbors = new Set<number>();
    if (index === 0) for (let i = 1; i <= 12; i++) neighbors.add(i);
    else if (index <= 12) {
      neighbors.add(0);
      neighbors.add(index === 1 ? 11 : index - 1);
      neighbors.add(index === 11 ? 1 : index + 1);
      for (let i = 13; i < 60; i++)
        if ((i - 13) % 11 === index - 1 || (i - 13 + 1) % 11 === index - 1)
          neighbors.add(i);
    } else {
      neighbors.add(((index - 13) % 11) + 1);
      neighbors.add(((index - 13 + 1) % 11) + 1);
      if (index > 13) neighbors.add(index - 1);
      if (index < 59) neighbors.add(index + 1);
    }
    return [...neighbors]
      .filter((n) => n !== index)
      .map((n) => demoIds[n])
      .sort();
  }
}
