import { afterAll, expect, it } from "vitest";
import type { PublicProfileDetails } from "../../../packages/shared/src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { createRun, putPlayers } from "../src/repository.js";
import { SteamError, type Provider } from "../src/provider.js";
import { collectPlayerDetails, getPlayerDetails } from "../src/player-details.js";
import { collectGameScores, getGameScores, startGameScoreJob } from "../src/game-scores.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const ids = ["76561200100008500", "76561200100008501"];
const profile: PublicProfileDetails = {
  realName: "Public fixture name",
  location: { label: "Shanghai, Shanghai, China", countryCode: "CN", locality: "Shanghai, Shanghai" },
};
const aliases = [{ name: "Earlier fixture name", changedAt: "1 Oct, 2026" }];
function providerWith(overrides: Partial<Provider> = {}): Provider {
  return {
    vanity: async () => ids[0], summaries: async () => [], friends: async () => [],
    profile: async () => profile, aliases: async () => aliases,
    ...overrides,
  };
}
async function fixture() {
  await putPlayers(ids.map((id) => ({ id, name: `Details fixture ${id}`, avatar: null, profileUrl: `https://steamcommunity.com/profiles/${id}` })));
}
async function cleanup() {
  await pool.query("DELETE FROM player_details WHERE player_id=ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM game_profiles WHERE player_id=ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM players WHERE id=ANY($1::text[])", [ids]);
}
afterAll(async () => { await pool.end(); });

databaseIt("reads unknown details without fetching and only accepts known players in the current mode", async () => {
  await fixture();
  try {
    expect(await getPlayerDetails(ids[0])).toMatchObject({ playerId: ids[0], profile: null, profileStatus: "unknown", aliases: [], aliasesStatus: "unknown" });
    expect((await pool.query("SELECT count(*)::int count FROM player_details WHERE mode=$1 AND player_id=$2", [config.mode, ids[0]])).rows[0].count).toBe(0);
    await expect(getPlayerDetails("../../elsewhere")).rejects.toMatchObject({ statusCode: 400 });
    await expect(getPlayerDetails("99999999999999999")).rejects.toMatchObject({ statusCode: 400 });
    await expect(getPlayerDetails("76561200100009999")).rejects.toMatchObject({ statusCode: 404 });
    await pool.query("UPDATE players SET mode=$1 WHERE mode=$2 AND id=$3", [config.mode === "demo" ? "live" : "demo", config.mode, ids[1]]);
    let calls = 0;
    await expect(collectPlayerDetails(ids[1], {}, providerWith({ profile: async () => { calls++; return profile; } }))).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toBe(0);
  } finally { await cleanup(); }
});

databaseIt("deduplicates simultaneous loads and explicit refreshes while keeping GET and repeated POST cached", async () => {
  await fixture();
  let profileCalls = 0, aliasCalls = 0;
  const provider = providerWith({
    profile: async () => { profileCalls++; await new Promise(resolve => setTimeout(resolve, 80)); return profile; },
    aliases: async () => { aliasCalls++; return aliases; },
  });
  try {
    const snapshots = await Promise.all([collectPlayerDetails(ids[0], {}, provider), collectPlayerDetails(ids[0], {}, provider)]);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0]).toMatchObject({ profile, profileStatus: "ok", aliases, aliasesStatus: "ok" });
    await getPlayerDetails(ids[0]);
    await collectPlayerDetails(ids[0], {}, provider);
    expect([profileCalls, aliasCalls]).toEqual([1, 1]);
    await Promise.all([collectPlayerDetails(ids[0], { refresh: true }, provider), collectPlayerDetails(ids[0], { refresh: true }, provider)]);
    expect([profileCalls, aliasCalls]).toEqual([2, 2]);
  } finally { await cleanup(); }
});

databaseIt("preserves good details on failed refreshes and caps both retrying sources at six requests", async () => {
  await fixture();
  try {
    const original = await collectPlayerDetails(ids[0], {}, providerWith());
    let calls = 0;
    const failing = providerWith({
      profile: async () => { calls++; throw new SteamError("transient", "Fixture header unavailable"); },
      aliases: async () => { calls++; throw new SteamError("transient", "Fixture aliases unavailable"); },
    });
    const failed = await collectPlayerDetails(ids[0], { refresh: true }, failing);
    expect(calls).toBe(6);
    expect(failed).toMatchObject({ profile, profileStatus: "error", profileFetchedAt: original.profileFetchedAt, aliases, aliasesStatus: "error", aliasesFetchedAt: original.aliasesFetchedAt });
    expect(failed.profileAttemptedAt).not.toBe(original.profileAttemptedAt);
    await collectPlayerDetails(ids[0], {}, failing);
    expect(calls).toBe(6);
  } finally { await cleanup(); }
});

databaseIt("reuses headers from game collection and keeps score snapshot locations immutable across detail refreshes", async () => {
  await fixture();
  const { run } = await createRun(ids[0], { input: ids[0], depth: 1, maxNodes: 10, maxRequests: 10, refresh: true });
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,1)", [run.id, ids[1]]);
  let headerCalls = 0, aliasCalls = 0;
  const provider = providerWith({
    profile: async () => { headerCalls++; return { realName: "Changed public name", location: null }; },
    aliases: async () => { aliasCalls++; return aliases; },
    games: async () => ({ scope: "profile_recent", games: [{ appId: "10", name: "Fixture game", minutes: 100 }], profile }),
  });
  try {
    const job = await startGameScoreJob(run.id, { refresh: true, maxRequests: 2 });
    await collectGameScores(job.jobId, provider);
    const before = await getGameScores(run.id);
    expect(before.formulaVersion).toBe("public-games-location-v2");
    expect(before.root?.profile).toEqual(profile);
    expect(before.rows[0].snapshot.profile).toEqual(profile);
    expect((await getPlayerDetails(ids[0])).profile).toEqual(profile);
    await collectPlayerDetails(ids[0], {}, provider);
    expect([headerCalls, aliasCalls]).toEqual([0, 1]);
    await collectPlayerDetails(ids[0], { refresh: true }, provider);
    expect(headerCalls).toBe(1);
    expect((await getPlayerDetails(ids[0])).profile?.location).toBeNull();
    const after = await getGameScores(run.id);
    expect(after.root).toEqual(before.root);
    expect(after.rows).toEqual(before.rows);
  } finally {
    await pool.query("DELETE FROM crawl_runs WHERE id=$1", [run.id]);
    await cleanup();
  }
});
