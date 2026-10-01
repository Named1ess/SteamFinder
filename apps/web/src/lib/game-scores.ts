import type {
  FetchStatus,
  GameScoreRow,
} from "../../../../packages/shared/src/index";

/** Game-set knowledge is independent of whether lifetime hours permit a composite score. */
export function hasGameSetComparison(
  row: GameScoreRow,
  rootStatus: FetchStatus,
): boolean {
  return (
    rootStatus === "ok" &&
    row.snapshot.status === "ok" &&
    row.result.rootGameCount > 0 &&
    row.result.friendGameCount > 0
  );
}

/** A missing or inaccessible sample must never become a zero score. */
export function gameScoreValue(
  row: GameScoreRow,
  rootStatus: FetchStatus,
): number | null {
  if (
    rootStatus !== "ok" ||
    row.snapshot.status !== "ok" ||
    row.result.score === null ||
    !Number.isFinite(row.result.score)
  )
    return null;
  return row.result.score;
}
export function rankGameScores(
  rows: GameScoreRow[],
  rootStatus: FetchStatus,
): GameScoreRow[] {
  return [...rows].sort(
    (a, b) =>
      (gameScoreValue(b, rootStatus) ?? -1) -
        (gameScoreValue(a, rootStatus) ?? -1) ||
      a.player.name.localeCompare(b.player.name, "zh-CN") ||
      a.player.id.localeCompare(b.player.id),
  );
}
export function formatGameHours(minutes: number | null): string {
  if (minutes === null) return "未知";
  return `${(minutes / 60).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时`;
}
