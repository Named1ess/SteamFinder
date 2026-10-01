import type {
  GamePlaytime,
  GameProfileSnapshot,
  GameScoreBreakdown,
} from "../../../packages/shared/src/index.js";

const round = (value: number) => Math.round(value * 10) / 10;
const normalizeLocation = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
function compareLocation(
  root: GameProfileSnapshot,
  friend: GameProfileSnapshot,
) {
  const a = root.status === "ok" ? root.profile?.location : null;
  const b = friend.status === "ok" ? friend.profile?.location : null;
  if (
    !a?.countryCode ||
    !b?.countryCode ||
    !/^[a-z]{2}$/i.test(a.countryCode) ||
    !/^[a-z]{2}$/i.test(b.countryCode)
  )
    return {
      similarity: null,
      reason: "任一方位置未公开或无法比较，位置不参与评分",
    };
  if (a.countryCode.toLowerCase() !== b.countryCode.toLowerCase())
    return { similarity: 0, reason: "公开填写的国家或地区不同" };
  if (
    a.locality &&
    b.locality &&
    normalizeLocation(a.locality) === normalizeLocation(b.locality)
  )
    return { similarity: 100, reason: "公开填写的国家或地区及具体地点相同" };
  return {
    similarity: 50,
    reason: "公开填写的国家或地区相同，具体地点不同或未填写",
  };
}
function uniqueGames(games: GamePlaytime[]) {
  const result = new Map<string, GamePlaytime>();
  for (const game of games)
    if (!result.has(game.appId)) result.set(game.appId, game);
  return result;
}
function total(games: GamePlaytime[]): number | null {
  if (
    games.some(
      (game) =>
        game.minutes === null ||
        !Number.isFinite(game.minutes) ||
        game.minutes < 0,
    )
  )
    return null;
  const sum = [...uniqueGames(games).values()].reduce(
    (value, game) => value + game.minutes!,
    0,
  );
  return Number.isFinite(sum) ? sum : null;
}
function unavailable(
  snapshot: GameProfileSnapshot,
  label: string,
): string | null {
  if (snapshot.status === "unknown") return `${label}的游戏资料尚未采集`;
  if (snapshot.status === "private")
    return `${label}的游戏活动未公开或不可访问`;
  if (snapshot.status === "error")
    return `${label}的游戏资料读取失败；旧缓存不用于本次评分`;
  return null;
}

/** Similarity of the observed sample only, never a claim about a full library. */
export function calculateGameScore(
  root: GameProfileSnapshot,
  friend: GameProfileSnapshot,
): GameScoreBreakdown {
  const a = uniqueGames(root.status === "ok" ? root.games : []);
  const b = uniqueGames(friend.status === "ok" ? friend.games : []);
  const shared = [...a.keys()].filter((id) => b.has(id));
  const union = new Set([...a.keys(), ...b.keys()]);
  const rootTotal = root.status === "ok" ? total(root.games) : null;
  const friendTotal = friend.status === "ok" ? total(friend.games) : null;
  const location = compareLocation(root, friend);
  const result: GameScoreBreakdown = {
    score: null,
    gameScore: null,
    locationSimilarity: location.similarity,
    locationWeight: 0,
    locationReason: location.reason,
    gameOverlap: null,
    timeSimilarity: null,
    sharedGameCount: shared.length,
    unionGameCount: union.size,
    rootGameCount: a.size,
    friendGameCount: b.size,
    rootMinutes: rootTotal,
    friendMinutes: friendTotal,
    reason: unavailable(root, "目标玩家") ?? unavailable(friend, "好友"),
    sharedGames: shared.map((appId) => ({
      appId,
      name: a.get(appId)!.name,
      rootMinutes: a.get(appId)!.minutes,
      friendMinutes: b.get(appId)!.minutes,
    })),
  };
  if (result.reason) return result;
  if (!a.size || !b.size) {
    result.reason = "公开主页没有足够的游戏样本，无法评分";
    return result;
  }
  const overlap = shared.length / union.size;
  result.gameOverlap = round(overlap * 100);
  if (rootTotal === null || friendTotal === null) {
    result.reason = "部分展示游戏的累计时长未公开或无效，暂不计算综合分";
    return result;
  }
  if (rootTotal <= 0 || friendTotal <= 0) {
    result.reason = "展示游戏的累计时长总和为零，无法比较时长分布";
    return result;
  }
  const timeOverlap = Math.min(
    1,
    shared.reduce(
      (sum, appId) =>
        sum +
        Math.min(
          a.get(appId)!.minutes! / rootTotal,
          b.get(appId)!.minutes! / friendTotal,
        ),
      0,
    ),
  );
  result.timeSimilarity = round(timeOverlap * 100);
  const gameScore = 40 * overlap + 60 * timeOverlap;
  result.gameScore = round(gameScore);
  result.locationWeight = location.similarity === null ? 0 : 5;
  result.score = round(
    location.similarity === null
      ? gameScore
      : gameScore * 0.95 + location.similarity * 0.05,
  );
  return result;
}
