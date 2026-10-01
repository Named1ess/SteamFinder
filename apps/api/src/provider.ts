import { DEFAULT_ROOT } from "../../../packages/shared/src/index.js";
import { validSteamId } from "./identity.js";

export interface Player {
  id: string;
  name: string;
  avatar: string | null;
  profileUrl: string;
}
export interface Provider {
  friends(id: string): Promise<string[]>;
  summaries(ids: string[]): Promise<Player[]>;
  vanity(name: string): Promise<string>;
}
export class SteamError extends Error {
  constructor(
    public kind: "private" | "unauthorized" | "rate" | "transient" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
export function classifyStatus(status: number): SteamError {
  if (status === 401 || status === 403)
    return new SteamError(
      "unauthorized",
      "Steam 拒绝授权，请检查服务器 API 密钥",
    );
  if (status === 429) return new SteamError("rate", "Steam 请求频率超限");
  if (status >= 500) return new SteamError("transient", "Steam 服务暂时不可用");
  return new SteamError("invalid", "Steam 返回无效响应");
}
export class LiveProvider implements Provider {
  constructor(private key: string) {}
  private async get(
    path: string,
    params: Record<string, string>,
    friendList = false,
  ): Promise<any> {
    const url = new URL(`https://api.steampowered.com/${path}`);
    url.search = new URLSearchParams({ key: this.key, ...params }).toString();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch {
      throw new SteamError("transient", "Steam 网络请求失败");
    }
    // GetFriendList returns 401 for unavailable/private friend lists. It cannot prove an empty list.
    if (friendList && response.status === 401)
      throw new SteamError("private", "好友列表未公开");
    if (!response.ok) throw classifyStatus(response.status);
    try {
      return await response.json();
    } catch {
      throw new SteamError("invalid", "Steam 响应格式无效");
    }
  }
  async friends(id: string): Promise<string[]> {
    const body = await this.get(
      "ISteamUser/GetFriendList/v1/",
      { steamid: id, relationship: "friend" },
      true,
    );
    if (!Array.isArray(body.friendslist?.friends))
      throw new SteamError("private", "好友列表未公开");
    const ids = body.friendslist.friends.map((item: any) => item.steamid);
    if (ids.some((id: unknown) => !validSteamId(id)))
      throw new SteamError("invalid", "Steam 好友数据无效");
    return [...new Set<string>(ids)].sort();
  }
  async summaries(ids: string[]): Promise<Player[]> {
    if (ids.length > 100)
      throw new Error("Summary batches must contain at most 100 IDs");
    const body = await this.get("ISteamUser/GetPlayerSummaries/v2/", {
      steamids: ids.join(","),
    });
    if (!Array.isArray(body.response?.players))
      throw new SteamError("invalid", "Steam 资料数据无效");
    return body.response.players
      .filter(
        (p: any) => typeof p.steamid === "string" && ids.includes(p.steamid),
      )
      .map((p: any) => ({
        id: p.steamid,
        name: String(p.personaname ?? p.steamid).slice(0, 200),
        avatar:
          typeof p.avatarfull === "string" &&
          p.avatarfull.startsWith("https://")
            ? p.avatarfull
            : null,
        profileUrl: `https://steamcommunity.com/profiles/${p.steamid}`,
      }));
  }
  async vanity(name: string): Promise<string> {
    const body = await this.get("ISteamUser/ResolveVanityURL/v1/", {
      vanityurl: name,
    });
    if (body.response?.success !== 1 || !validSteamId(body.response.steamid))
      throw new SteamError("invalid", "找不到该 Steam 用户");
    return body.response.steamid;
  }
}
export const demoIds = [
  DEFAULT_ROOT,
  ...Array.from({ length: 59 }, (_, i) =>
    String(76561198000000000n + BigInt(i + 1)),
  ),
];
export class DemoProvider implements Provider {
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
