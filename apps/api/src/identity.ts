export function validSteamId(id: unknown): id is string {
  if (typeof id !== "string" || !/^\d{17}$/.test(id)) return false;
  const value = BigInt(id),
    base = 76561197960265728n;
  return value >= base && value <= base + 4294967295n;
}
export function parseIdentity(input: string): { id?: string; vanity?: string } {
  if (typeof input !== "string" || input.length > 300)
    throw new Error("请输入有效的 Steam ID 或个人资料网址");
  const value = input.trim();
  if (validSteamId(value)) return { id: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的 Steam ID 或个人资料网址");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.hostname !== "steamcommunity.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("只支持 Steam 社区个人资料网址");
  const match = /^\/(profiles|id)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error("无效的 Steam 个人资料网址");
  if (match[1] === "profiles") {
    if (!validSteamId(match[2]))
      throw new Error("Steam ID 必须为有效的 17 位个人账号 ID");
    return { id: match[2] };
  }
  return { vanity: match[2] };
}
