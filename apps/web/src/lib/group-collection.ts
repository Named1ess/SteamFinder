import type { QueryClient } from "@tanstack/react-query";
import type { RunGroupsResponse } from "../../../../packages/shared/src/index";
import { refreshRelationshipScores, scheduleRelationshipScores } from "./relationship-scores";

/** One score refresh for each observed group revision, isolated to this run. */
export function createGroupScoreSync(
  client: QueryClient,
  runId: string | undefined,
): (snapshot: RunGroupsResponse) => Promise<void> {
  let previous: string | undefined;
  return async (snapshot) => {
    if (!runId || snapshot.runId !== runId) return;
    const revision = JSON.stringify([
      snapshot.updatedAt,
      snapshot.job?.id,
      snapshot.job?.updatedAt,
      snapshot.job?.status,
    ]);
    if (revision === previous) return;
    const initial = previous === undefined;
    previous = revision;
    if (initial && !snapshot.job) return;
    if (snapshot.job && ["queued", "running"].includes(snapshot.job.status))
      await scheduleRelationshipScores(client, runId);
    else await refreshRelationshipScores(client, runId);
  };
}
