import type {
  GroupScoreEvidence,
  GroupSnapshot,
  RelationshipScoresResponse,
  SteamGroup,
} from "../../../packages/shared/src/index.js";
import { relationshipLayer } from "./relationship-scoring.js";

type NetworkScores = Pick<
  RelationshipScoresResponse,
  "center" | "totalPlayers" | "totalEdges" | "coverage" | "layers" | "rows"
>;
const round = (value: number) => Math.round(value * 10) / 10;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function usableGroups(
  snapshot?: GroupSnapshot,
): Map<string, SteamGroup> | null {
  if (!snapshot || snapshot.status !== "ok" || !snapshot.complete) return null;
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  return groups.size === snapshot.totalCount ? groups : null;
}

/** Group membership is positive context, never evidence of a friendship edge. */
export function applyRelationshipGroups(
  network: NetworkScores,
  snapshots: ReadonlyMap<string, GroupSnapshot>,
): NetworkScores {
  const center = snapshots.get(network.center.id);
  const a = usableGroups(center);
  const rows = network.rows.map((row) => {
    const player = snapshots.get(row.player.id);
    const b = usableGroups(player);
    const groups: GroupScoreEvidence = {
      similarity: null,
      sharedCount: 0,
      unionCount: 0,
      centerCount: a?.size ?? null,
      playerCount: b?.size ?? null,
      centerStatus: center?.status ?? "unknown",
      playerStatus: player?.status ?? "unknown",
      centerFetchedAt: center?.fetchedAt ?? null,
      playerFetchedAt: player?.fetchedAt ?? null,
      commonGroups: [],
      reason:
        "双方需有完整公开群组快照；未采集、不可见或读取失败时保持网络基础分",
      contribution: 0,
    };
    let score = row.score;
    if (a && b) {
      const common = [...a.keys()].filter((id) => b.has(id)).sort(compareIds);
      const union = a.size + b.size - common.length;
      const overlap = union ? common.length / union : 0;
      groups.similarity = round(overlap * 100);
      groups.sharedCount = common.length;
      groups.unionCount = union;
      groups.commonGroups = common.slice(0, 20).map((id) => a.get(id)!);
      if (score !== null) {
        score = round(row.score! + (100 - row.score!) * 0.1 * overlap);
        groups.contribution = round(score - row.score!);
      }
      groups.reason =
        row.score === null
          ? "暂无已知好友路径；仅展示共同群组，不据此推断好友连接"
          : !a.size || !b.size
            ? "至少一方公开群组列表为空，保持网络基础分"
            : !common.length
              ? "完整公开群组列表没有交集，保持网络基础分"
              : "共同群组占双方群组并集的比例越高，加成越大；最多使用剩余分值的 10%";
    }
    return {
      ...row,
      networkScore: row.score,
      score,
      layer: relationshipLayer(score),
      groups,
    };
  });
  rows.sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      b.mutualCount - a.mutualCount ||
      (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
      compareIds(a.player.id, b.player.id),
  );
  return {
    ...network,
    rows,
    layers: network.layers.map((layer) => ({
      ...layer,
      count: rows.filter((row) => row.layer === layer.id).length,
    })),
  };
}
