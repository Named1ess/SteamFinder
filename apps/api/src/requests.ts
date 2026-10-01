import { config } from "./config.js";
import { pool } from "./db.js";
import { SteamError } from "./provider.js";
import { HttpError } from "./repository.js";
import type pg from "pg";
export class BudgetError extends Error {}
export class CancelledError extends Error {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A session advisory lock covers both reservation and the outbound call. API vanity
// resolution and worker friend/summary calls share this lock and persisted quota.
export async function steamRequest<T>(
  operation: () => Promise<T>,
  runId?: string,
  initialBudget?: { used: number; max: number },
  connection?: pg.PoolClient,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = connection ?? (await pool.connect());
    let error: unknown;
    let inTransaction = false;
    try {
      await client.query("SELECT pg_advisory_lock(72461501)");
      await client.query(
        `INSERT INTO request_budgets(mode) VALUES($1) ON CONFLICT DO NOTHING`,
        [config.mode],
      );
      const { rows } = await client.query(
        `SELECT *, CASE WHEN day=CURRENT_DATE THEN requests ELSE 0 END used FROM request_budgets WHERE mode=$1`,
        [config.mode],
      );
      const budget = rows[0];
      if (budget.used >= config.dailyLimit)
        throw new BudgetError("今日请求预算已用完，可稍后继续");
      if (initialBudget && initialBudget.used >= initialBudget.max)
        throw new BudgetError("请求预算已达到上限，可增加预算后继续");
      if (runId) {
        const { rows } = await client.query(
          "SELECT status,request_count,max_requests FROM crawl_runs WHERE id=$1",
          [runId],
        );
        if (!rows[0] || !["running", "queued"].includes(rows[0].status))
          throw new CancelledError();
        if (rows[0].request_count >= rows[0].max_requests)
          throw new BudgetError("请求预算已达到上限，可增加预算后继续");
      }
      await sleep(
        Math.max(
          0,
          config.delay - (Date.now() - new Date(budget.last_call).getTime()),
        ),
      );
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        `UPDATE request_budgets SET requests=CASE WHEN day=CURRENT_DATE THEN requests+1 ELSE 1 END,day=CURRENT_DATE,last_call=now() WHERE mode=$1`,
        [config.mode],
      );
      if (runId) {
        const reservation = await client.query(
          `UPDATE crawl_runs SET request_count=request_count+1,updated_at=now() WHERE id=$1 AND status IN ('queued','running') AND request_count<max_requests RETURNING id`,
          [runId],
        );
        if (!reservation.rows.length) {
          await client.query("ROLLBACK");
          inTransaction = false;
          throw new CancelledError();
        }
      }
      await client.query("COMMIT");
      inTransaction = false;
      if (initialBudget) initialBudget.used++;
      return await operation();
    } catch (caught) {
      error = caught;
    } finally {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      await client.query("SELECT pg_advisory_unlock(72461501)").catch(() => {});
      if (!connection) client.release();
    }
    if (
      error instanceof SteamError &&
      ["rate", "transient"].includes(error.kind) &&
      attempt < 2
    ) {
      await sleep(config.mode === "demo" ? 20 : 1000 * 2 ** attempt);
      continue;
    }
    throw error;
  }
  throw new HttpError(502, "Steam 请求失败");
}
