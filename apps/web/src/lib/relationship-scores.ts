import type { QueryClient } from "@tanstack/react-query";
import type {
  RelationshipLayer,
  RelationshipScoreRow,
} from "../../../../packages/shared/src/index";

/** Cancel even the first pending fetch before requesting a newer run snapshot. */
export async function refreshRelationshipScores(
  client: QueryClient,
  runId: string,
): Promise<void> {
  await client.cancelQueries({ queryKey: ["relationship-scores", runId] });
  await client.invalidateQueries({ queryKey: ["relationship-scores", runId] });
}

export type ScoredRelationshipLayer = Exclude<RelationshipLayer, "unknown">;

export const relationshipLayers = [
  "core",
  "close",
  "connected",
  "peripheral",
] as const satisfies readonly ScoredRelationshipLayer[];

export const layerColors: Record<RelationshipLayer, string> = {
  core: "#e8c874",
  close: "#58c9bd",
  connected: "#6d9fe8",
  peripheral: "#8293ad",
  unknown: "#727985",
};

const ringRadii: Record<ScoredRelationshipLayer, number> = {
  core: 78,
  close: 126,
  connected: 174,
  peripheral: 220,
};

const ringLimits: Record<ScoredRelationshipLayer, number> = {
  core: 24,
  close: 32,
  connected: 44,
  peripheral: 56,
};

/** Preserve precise Steam IDs and make ranking independent of input order or locale. */
export function rankRelationshipScores(
  rows: readonly RelationshipScoreRow[],
): RelationshipScoreRow[] {
  return [...rows].sort(
    (a, b) =>
      (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
      b.mutualCount - a.mutualCount ||
      (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
      (a.player.id < b.player.id ? -1 : a.player.id > b.player.id ? 1 : 0),
  );
}

export function filterRelationshipScores(
  rows: readonly RelationshipScoreRow[],
  search: string,
  layer: RelationshipLayer | "all",
): RelationshipScoreRow[] {
  const query = search.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (layer === "all" || row.layer === layer) &&
      (row.player.name.toLowerCase().includes(query) ||
        row.player.id.toLowerCase().includes(query)),
  );
}

/** Clamp after filtering so a stale page never hides the remaining results. */
export function paginateRelationshipScores(
  rows: readonly RelationshipScoreRow[],
  page: number,
  pageSize = 30,
): {
  rows: RelationshipScoreRow[];
  page: number;
  pages: number;
  total: number;
} {
  const size =
    Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 30;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const currentPage = Math.min(
    pages - 1,
    Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0),
  );
  return {
    rows: rows.slice(currentPage * size, (currentPage + 1) * size),
    page: currentPage,
    pages,
    total: rows.length,
  };
}

export interface RelationshipRingNode {
  row: RelationshipScoreRow;
  x: number;
  y: number;
  radius: number;
}

/** Share the sample across layers while keeping each ring readable. */
export function relationshipRingNodes(
  rows: readonly RelationshipScoreRow[],
  limit = 100,
): RelationshipRingNode[] {
  const capacity = Math.max(
    0,
    Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 100),
  );
  const ranked = rankRelationshipScores(rows);
  const groups = relationshipLayers.map((layer) => ({
    layer,
    rows: ranked.filter((row) => row.layer === layer && row.score !== null),
    count: 0,
  }));
  let selected = 0;
  while (selected < capacity) {
    let added = false;
    for (const group of groups) {
      if (selected >= capacity) break;
      if (group.count < Math.min(group.rows.length, ringLimits[group.layer])) {
        group.count++;
        selected++;
        added = true;
      }
    }
    if (!added) break;
  }
  return groups.flatMap((group, layerIndex) =>
    group.rows.slice(0, group.count).map((row, index) => {
      const radius = ringRadii[group.layer];
      const angle =
        -Math.PI / 2 + layerIndex * 0.35 + (index * 2 * Math.PI) / group.count;
      return {
        row,
        x: 250 + Math.cos(angle) * radius,
        y: 250 + Math.sin(angle) * radius,
        radius,
      };
    }),
  );
}
