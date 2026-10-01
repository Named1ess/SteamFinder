import type { CreateRunInput } from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { parseIdentity } from "./identity.js";
import type { Provider } from "./provider.js";
import { steamRequest } from "./requests.js";
import { createRun, HttpError } from "./repository.js";
import { pool } from "./db.js";

async function resolveVanity(
  vanity: string,
  refresh: boolean,
  provider: Provider,
  budget: { used: number; max: number },
) {
  const client = await pool.connect();
  try {
    // Recheck after acquiring the per-mode/name lock so simultaneous submissions
    // share one resolution. The same connection reserves the outbound quota.
    await client.query("SELECT pg_advisory_lock(hashtext($1),hashtext($2))", [
      `steamfinder-vanity-${config.mode}`,
      vanity,
    ]);
    if (!refresh) {
      const { rows } = await client.query(
        "SELECT player_id FROM vanity_resolutions WHERE mode=$1 AND vanity=$2",
        [config.mode, vanity],
      );
      if (rows.length) return rows[0].player_id as string;
    }
    const id = await steamRequest(
      () => provider.vanity(vanity),
      undefined,
      budget,
      client,
    );
    await client.query(
      `INSERT INTO vanity_resolutions(mode,vanity,player_id) VALUES($1,$2,$3)
       ON CONFLICT(mode,vanity) DO UPDATE SET player_id=EXCLUDED.player_id,resolved_at=now()`,
      [config.mode, vanity, id],
    );
    return id;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", [
        `steamfinder-vanity-${config.mode}`,
        vanity,
      ])
      .catch(() => {});
    client.release();
  }
}

export async function createSearch(input: CreateRunInput, provider: Provider) {
  let identity;
  try {
    identity = parseIdentity(input.input);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const initialBudget = { used: 0, max: input.maxRequests };
  const root =
    identity.id ??
    (await resolveVanity(
      identity.vanity!,
      input.refresh ?? false,
      provider,
      initialBudget,
    ));
  return createRun(root, input, initialBudget.used);
}
