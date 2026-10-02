import { z } from "zod";
import type { RelationshipScoresResponse } from "../../../packages/shared/src/index.js";
import { validSteamId } from "./identity.js";
import { getGraphData, getRun, HttpError } from "./repository.js";
import { scoreRelationshipGraph } from "./relationship-scoring.js";

export const relationshipScoresQuerySchema = z.object({
  center: z.string().refine(validSteamId).optional(),
});

/** Derive scores only from this run's persisted snapshot; this performs no writes. */
export async function getRelationshipScores(
  runId: string,
  centerId?: string,
): Promise<RelationshipScoresResponse> {
  if (centerId !== undefined && !validSteamId(centerId)) {
    throw new HttpError(400, "请选择有效的 Steam 玩家作为关系中心");
  }
  const run = await getRun(runId);
  const data = await getGraphData(runId);
  const center = centerId ?? run.rootId;
  if (!data.nodes.some((node) => node.id === center)) {
    throw new HttpError(400, "关系中心不属于该查询");
  }
  const now = Date.now();
  return {
    runId,
    algorithmVersion: "mutual-network-v1",
    computedAt: new Date(now).toISOString(),
    sourceUpdatedAt: run.updatedAt,
    ...scoreRelationshipGraph(
      center,
      data.nodes,
      data.edges,
      data.fullyRepresented,
      now,
    ),
  };
}
