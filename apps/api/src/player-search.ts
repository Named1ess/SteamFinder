import { z } from "zod";
import type {
  PlayerSearchOption,
  PlayerSearchResponse,
} from "../../../packages/shared/src/index.js";
import { pool } from "./db.js";
import { validSteamId } from "./identity.js";
import { getRun } from "./repository.js";

const playerIdSchema = z.string().refine(validSteamId);
export const playerSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  excludeId: playerIdSchema.optional(),
  selectedId: playerIdSchema.optional(),
});

export async function searchRunPlayers(
  runId: string,
  query: z.infer<typeof playerSearchQuerySchema>,
): Promise<PlayerSearchResponse> {
  const run = await getRun(runId);
  const columns = `n.player_id id,p.name,p.avatar,p.profile_url "profileUrl",n.depth`;
  const membership = `FROM run_nodes n JOIN players p ON p.id=n.player_id AND p.mode=$2 WHERE n.run_id=$1`;
  const matching = `${membership} AND ($4::text IS NULL OR n.player_id<>$4)
    AND (strpos(lower(p.name),lower($3))>0 OR strpos(n.player_id,$3)>0)`;
  const parameters = [runId, run.mode, query.q, query.excludeId ?? null];
  const [list, count, selected] = await Promise.all([
    pool.query<PlayerSearchOption>(
      `SELECT ${columns} ${matching}
       ORDER BY CASE WHEN n.player_id=$3 THEN 0 WHEN lower(p.name)=lower($3) THEN 1 ELSE 2 END,
       lower(p.name),n.player_id LIMIT $5`,
      [...parameters, query.limit],
    ),
    pool.query<{ total: number }>(
      `SELECT count(*)::int total ${matching}`,
      parameters,
    ),
    query.selectedId && query.selectedId !== query.excludeId
      ? pool.query<PlayerSearchOption>(
          `SELECT ${columns} ${membership} AND n.player_id=$3`,
          [runId, run.mode, query.selectedId],
        )
      : Promise.resolve({ rows: [] as PlayerSearchOption[] }),
  ]);
  return {
    players: list.rows,
    total: count.rows[0].total,
    selected: selected.rows[0] ?? null,
  };
}
