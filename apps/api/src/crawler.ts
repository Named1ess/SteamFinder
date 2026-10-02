import type { Provider } from "./provider.js";
import { SteamError } from "./provider.js";
import { pool, transaction } from "./db.js";
import { config } from "./config.js";
import {
  getRun,
  putPlayers,
  saveList,
  failList,
  finishRun,
  captureList,
} from "./repository.js";
import { steamRequest, BudgetError, CancelledError } from "./requests.js";
import { insertRunEdges } from "./run-edges.js";

export async function crawl(id: string, provider: Provider): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(72461502)");
    const initial = await getRun(id);
    if (!["running", "queued"].includes(initial.status)) return;
    await pool.query(
      `UPDATE crawl_runs SET status='running',message=NULL,updated_at=now() WHERE id=$1 AND status='queued'`,
      [id],
    );
    while (true) {
      const run = await getRun(id);
      if (run.status !== "running") return;
      // Reuse metadata observed during this run's friend-page fetch. Public profile
      // pages accept one ID per request; demo providers retain 100-ID batches.
      const hydration = await pool.query(
        `SELECT n.player_id,p.summary_at,p.summary_at>=r.created_at fresh FROM run_nodes n JOIN crawl_runs r ON r.id=n.run_id JOIN players p ON p.mode=$2 AND p.id=n.player_id WHERE n.run_id=$1 AND NOT n.hydrated ORDER BY n.depth,n.player_id LIMIT 100`,
        [id, config.mode],
      );
      if (hydration.rows.length) {
        const missing = hydration.rows.filter(
          (r) => !r.summary_at || (run.refresh && !r.fresh),
        );
        const needed = missing
          .slice(0, provider.summaryBatchSize ?? 100)
          .map((r) => r.player_id);
        const postponed = new Set(
          missing.slice(needed.length).map((r) => r.player_id),
        );
        const hydratedIds = hydration.rows
          .filter((r) => !postponed.has(r.player_id))
          .map((r) => r.player_id);
        if (needed.length) {
          try {
            await putPlayers(
              await steamRequest(() => provider.summaries(needed), id),
              { runId: id, ids: hydratedIds },
            );
          } catch (error) {
            if (error instanceof BudgetError || error instanceof CancelledError)
              throw error;
            if (error instanceof SteamError && error.kind === "unauthorized")
              throw error;
            await pool.query(
              `UPDATE crawl_runs SET message='部分玩家资料获取失败，已保留已知关系',updated_at=now() WHERE id=$1`,
              [id],
            );
          }
        }
        await pool.query(
          "UPDATE run_nodes SET hydrated=true WHERE run_id=$1 AND player_id=ANY($2::text[])",
          [id, hydratedIds],
        );
        continue;
      }
      const pending = await pool.query(
        `SELECT player_id,depth,observed FROM run_nodes WHERE run_id=$1 AND NOT expanded AND depth<$2 ORDER BY depth,player_id LIMIT 1`,
        [id, run.depth],
      );
      if (!pending.rows.length) {
        await finishRun(id, "completed", run.message);
        return;
      }
      const node = pending.rows[0];
      const cached = await pool.query(
        "SELECT * FROM friend_lists WHERE mode=$1 AND owner_id=$2",
        [config.mode, node.player_id],
      );
      const hasCompleteCache = !!cached.rows[0]?.fetched_at;
      if (!node.observed) {
        if (hasCompleteCache && !run.refresh) {
          await captureList(id, node.player_id);
        } else {
          try {
            const result = await steamRequest(
              async () =>
                provider.friendsWithPlayers
                  ? provider.friendsWithPlayers(node.player_id)
                  : {
                      friends: await provider.friends(node.player_id),
                      players: [],
                    },
              id,
            );
            if (result.players.length) await putPlayers(result.players);
            await saveList(node.player_id, result.friends, id);
          } catch (error) {
            if (error instanceof BudgetError || error instanceof CancelledError)
              throw error;
            await failList(
              node.player_id,
              error instanceof SteamError && error.kind === "private"
                ? "private"
                : "error",
              id,
            );
            if (error instanceof SteamError && error.kind === "unauthorized")
              throw error;
          }
        }
      }
      const fullyExpanded = await transaction(async (client) => {
        const locked = await client.query(
          "SELECT status,max_nodes FROM crawl_runs WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (locked.rows[0]?.status !== "running") throw new CancelledError();
        const existing = await client.query(
          "SELECT count(*)::int count FROM run_nodes WHERE run_id=$1",
          [id],
        );
        const capacity = Math.max(0, locked.rows[0].max_nodes - existing.rows[0].count);
        const neighbors = await client.query(
          `SELECT o.friend_id FROM run_friend_observations o WHERE o.run_id=$1 AND o.owner_id=$2
          AND NOT EXISTS(SELECT 1 FROM run_nodes n WHERE n.run_id=$1 AND n.player_id=o.friend_id)
          ORDER BY o.friend_id LIMIT $3`,
          [id, node.player_id, capacity + 1],
        );
        const complete = neighbors.rows.length <= capacity;
        const admitted = neighbors.rows.slice(0, capacity).map((row) => row.friend_id as string);
        if (admitted.length) {
          await client.query(
            `INSERT INTO players(mode,id,name,profile_url)
            SELECT $1,id,CASE WHEN $1='demo' THEN '演示玩家 · 虚构 ' || right(id,4) ELSE id END,
              'https://steamcommunity.com/profiles/' || id FROM unnest($2::text[]) AS discovered(id)
            ON CONFLICT DO NOTHING`,
            [config.mode, admitted],
          );
          await client.query(
            "INSERT INTO run_nodes(run_id,player_id,depth) SELECT $1,unnest($2::text[]),$3 ON CONFLICT DO NOTHING",
            [id, admitted, node.depth + 1],
          );
        }
        await insertRunEdges(client, id, [node.player_id, ...admitted]);
        await client.query(
          "UPDATE run_nodes SET expanded=$3 WHERE run_id=$1 AND player_id=$2",
          [id, node.player_id, complete],
        );
        await client.query(
          "UPDATE crawl_runs SET updated_at=now() WHERE id=$1",
          [id],
        );
        return complete;
      });
      if (!fullyExpanded) {
        await finishRun(id, "limited", "节点预算已达到上限，可增加预算后继续");
        return;
      }
    }
  } catch (error) {
    if (error instanceof CancelledError) return;
    if (error instanceof BudgetError)
      await finishRun(id, "limited", error.message);
    else
      await finishRun(
        id,
        "failed",
        error instanceof SteamError
          ? error.message
          : "采集任务暂时失败，可继续查询",
      );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(72461502)").catch(() => {});
    lock.release();
  }
}
