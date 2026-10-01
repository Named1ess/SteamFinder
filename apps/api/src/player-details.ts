import type pg from "pg";
import type { PlayerDetailsSnapshot, PublicProfileDetails } from "../../../packages/shared/src/index.js";
import { pool } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./repository.js";
import { SteamError, type Provider } from "./provider.js";
import { BudgetError, steamRequest } from "./requests.js";
import { validSteamId } from "./identity.js";

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
type Reader = Pick<pg.PoolClient, "query">;

async function ensureKnownPlayer(playerId: string, reader: Reader = pool) {
  if (!validSteamId(playerId)) throw new HttpError(400, "Steam ID 格式无效");
  const { rows } = await reader.query("SELECT id FROM players WHERE mode=$1 AND id=$2", [config.mode, playerId]);
  if (!rows.length) throw new HttpError(404, "请先在好友图谱中采集该玩家");
}

async function readDetails(playerId: string, reader: Reader = pool): Promise<PlayerDetailsSnapshot> {
  const { rows } = await reader.query("SELECT * FROM player_details WHERE mode=$1 AND player_id=$2", [config.mode, playerId]);
  const row = rows[0];
  return {
    playerId,
    profile: row?.profile ?? null,
    profileStatus: row?.profile_status ?? "unknown",
    profileFetchedAt: iso(row?.profile_fetched_at),
    profileAttemptedAt: iso(row?.profile_attempted_at),
    profileMessage: row?.profile_message ?? null,
    aliases: row?.aliases ?? [],
    aliasesStatus: row?.aliases_status ?? "unknown",
    aliasesFetchedAt: iso(row?.aliases_fetched_at),
    aliasesAttemptedAt: iso(row?.aliases_attempted_at),
    aliasesMessage: row?.aliases_message ?? null,
  };
}

/** A read never initiates a Steam request, including unknown or failed entries. */
export async function getPlayerDetails(playerId: string): Promise<PlayerDetailsSnapshot> {
  await ensureKnownPlayer(playerId);
  return readDetails(playerId);
}

/** Also used inside the game snapshot transaction: the same HTML provides both. */
export async function saveProfileDetails(client: Reader, playerId: string, profile: PublicProfileDetails) {
  await client.query(
    `INSERT INTO player_details(mode,player_id,profile,profile_status,profile_fetched_at,profile_attempted_at)
     VALUES($1,$2,$3,'ok',now(),now())
     ON CONFLICT(mode,player_id) DO UPDATE SET profile=EXCLUDED.profile,profile_status='ok',
     profile_fetched_at=now(),profile_attempted_at=now(),profile_message=NULL`,
    [config.mode, playerId, JSON.stringify(profile)],
  );
}

async function saveFailure(client: Reader, playerId: string, field: "profile" | "aliases", error: unknown) {
  const status = error instanceof SteamError && error.kind === "private" ? "private" : "error";
  const message = error instanceof SteamError ? error.message : "公开资料暂时读取失败";
  // field is selected by our code, never interpolated from request input.
  await client.query(
    `INSERT INTO player_details(mode,player_id,${field}_status,${field}_attempted_at,${field}_message)
     VALUES($1,$2,$3,now(),$4)
     ON CONFLICT(mode,player_id) DO UPDATE SET ${field}_status=EXCLUDED.${field}_status,
     ${field}_attempted_at=now(),${field}_message=EXCLUDED.${field}_message`,
    [config.mode, playerId, status, message],
  );
}

/** At most two public page operations, each with the shared three-attempt limit. */
export async function collectPlayerDetails(
  playerId: string,
  options: { refresh?: boolean },
  provider: Provider,
): Promise<PlayerDetailsSnapshot> {
  const before = await getPlayerDetails(playerId);
  const client = await pool.connect();
  const lockKey = `player-details:${config.mode}:${playerId}`;
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,72461504))", [lockKey]);
    locked = true;
    const current = await readDetails(playerId, client);
    // A caller that waited for an in-flight refresh reuses that result too.
    const loadProfile = current.profileStatus === "unknown" || (options.refresh && current.profileAttemptedAt === before.profileAttemptedAt);
    const loadAliases = current.aliasesStatus === "unknown" || (options.refresh && current.aliasesAttemptedAt === before.aliasesAttemptedAt);
    const budget = { used: 0, max: 6 };
    if (loadProfile) {
      try {
        if (!provider.profile) throw new Error("Public profile source unavailable");
        const profile = await steamRequest(() => provider.profile!(playerId), undefined, budget, client);
        await saveProfileDetails(client, playerId, profile);
      } catch (error) {
        if (error instanceof BudgetError) throw error;
        await saveFailure(client, playerId, "profile", error);
      }
    }
    if (loadAliases) {
      try {
        if (!provider.aliases) throw new Error("Public alias source unavailable");
        const aliases = await steamRequest(() => provider.aliases!(playerId), undefined, budget, client);
        await client.query(
          `INSERT INTO player_details(mode,player_id,aliases,aliases_status,aliases_fetched_at,aliases_attempted_at)
           VALUES($1,$2,$3,'ok',now(),now())
           ON CONFLICT(mode,player_id) DO UPDATE SET aliases=EXCLUDED.aliases,aliases_status='ok',
           aliases_fetched_at=now(),aliases_attempted_at=now(),aliases_message=NULL`,
          [config.mode, playerId, JSON.stringify(aliases)],
        );
      } catch (error) {
        if (error instanceof BudgetError) throw error;
        await saveFailure(client, playerId, "aliases", error);
      }
    }
    return await readDetails(playerId, client);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,72461504))", [lockKey]).catch(() => {});
    client.release();
  }
}
