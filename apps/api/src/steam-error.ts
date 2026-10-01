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
    return new SteamError("unauthorized", "Steam 公开网页拒绝访问，请稍后重试");
  if (status === 429) return new SteamError("rate", "Steam 网页请求频率超限");
  if (status >= 500) return new SteamError("transient", "Steam 网页暂时不可用");
  return new SteamError(
    "invalid",
    "Steam 网页不可用或发生重定向，未读取好友列表",
  );
}
