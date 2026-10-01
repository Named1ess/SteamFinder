import type {
  GamePlaytime,
  GameProfileSnapshot,
  GameScoreBreakdown,
} from "../../../packages/shared/src/index.js";

const round = (value: number) => Math.round(value * 10) / 10;
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
  const result: GameScoreBreakdown = {
    score: null,
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
  result.score = round(40 * overlap + 60 * timeOverlap);
  return result;
}
