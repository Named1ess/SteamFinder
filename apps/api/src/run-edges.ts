import type pg from "pg";

/** Include both directions so older owners can support newly admitted endpoints. */
export async function insertRunEdges(
  client: pg.PoolClient,
  runId: string,
  affectedIds: string[],
): Promise<void> {
  if (!affectedIds.length) return;
  await client.query(
    `INSERT INTO run_edges(run_id,source,target)
    SELECT DISTINCT $1,least(o.owner_id,o.friend_id),greatest(o.owner_id,o.friend_id)
    FROM run_friend_observations o
    JOIN run_nodes a ON a.run_id=$1 AND a.player_id=o.owner_id
    JOIN run_nodes b ON b.run_id=$1 AND b.player_id=o.friend_id
    WHERE o.run_id=$1 AND o.owner_id<>o.friend_id
      AND (o.owner_id=ANY($2::text[]) OR o.friend_id=ANY($2::text[]))
    ON CONFLICT DO NOTHING`,
    [runId, affectedIds],
  );
}
