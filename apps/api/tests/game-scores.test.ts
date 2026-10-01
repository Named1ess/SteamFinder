import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PublicGames } from "../../../packages/shared/src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { createRun, putPlayers } from "../src/repository.js";
import { SteamError, type Provider } from "../src/provider.js";
import {
  collectGameScores,
  getGameScores,
  startGameScoreJob,
  recoverGameScoreJobs,
} from "../src/game-scores.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const ids = Array.from({ length: 5 }, (_, i) =>
  String(76561200100007000n + BigInt(i)),
);
const games: PublicGames = {
  scope: "profile_recent",
  games: [{ appId: "10", name: "Fixture Game", minutes: 100 }],
};
async function fixture() {
  const { run } = await createRun(ids[0], {
    input: ids[0], depth: 2, maxNodes: 100, maxRequests: 100, refresh: true,
  });
  await putPlayers(ids.slice(1).map((id) => ({
    id, name: `Game score fixture ${id}`, avatar: null,
    profileUrl: `https://steamcommunity.com/profiles/${id}`,
  })));
  for (const [i, id] of ids.slice(1).entries()) {
    await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,$3)",
      [run.id, id, i < 3 ? 1 : 2]);
  }
  return run.id;
}
async function cleanup(runId: string) {
  await pool.query("DELETE FROM crawl_runs WHERE id=$1", [runId]);
  await pool.query("DELETE FROM game_profiles WHERE player_id=ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids]);
}
function providerWith(operation: (id: string) => Promise<PublicGames>): Provider & {
  games(id: string): Promise<PublicGames>;
} {
  return { games: operation, vanity: async () => ids[0], summaries: async () => [], friends: async () => [] };
}
afterAll(async () => { await pool.end(); });

databaseIt("keeps game-score GET read-only and resumes exact budgets for all direct friends", async () => {
  const runId = await fixture();
  const calls: string[] = [];
  const provider = providerWith(async (id) => { calls.push(id); return games; });
  try {
    expect(await getGameScores(runId)).toMatchObject({ job: null, root: null, rows: [] });
    const first = await startGameScoreJob(runId, { refresh: true, maxRequests: 1 });
    await collectGameScores(first.jobId, provider);
    const limited = await getGameScores(runId);
    expect(limited.job).toMatchObject({ status: "limited", requestCount: 1, totalPlayers: 4, processedPlayers: 1 });
    expect(calls).toEqual([ids[0]]);
    expect(limited.rows.map(row => row.player.id).sort()).toEqual(ids.slice(1, 4));
    expect(limited.rows.every(row => row.result.score === null)).toBe(true);
    await getGameScores(runId);
    expect(calls).toEqual([ids[0]]);

    const resumed = await startGameScoreJob(runId, { maxRequests: 4 });
    expect(resumed).toMatchObject({ jobId: first.jobId, enqueue: true });
    await collectGameScores(resumed.jobId, provider);
    const completed = await getGameScores(runId);
    expect(completed.job).toMatchObject({ status: "completed", requestCount: 4, processedPlayers: 4 });
    expect(calls).toEqual(ids.slice(0, 4));
    expect(completed.rows.every(row => row.result.score === 100)).toBe(true);
    const cached = await startGameScoreJob(runId, {});
    expect(cached).toEqual({ jobId: first.jobId, enqueue: false });
    await collectGameScores(first.jobId, provider);
    expect(calls).toEqual(ids.slice(0, 4));
  } finally { await cleanup(runId); }
});

databaseIt("preserves successful global games after a failed refresh without scoring the old data", async () => {
  const runId = await fixture();
  try {
    const original = await startGameScoreJob(runId, { refresh: true, maxRequests: 10 });
    await collectGameScores(original.jobId, providerWith(async () => games));
    const first = await getGameScores(runId);
    expect(first.rows.every(row => row.result.score === 100)).toBe(true);
    const refreshed = await startGameScoreJob(runId, { refresh: true, maxRequests: 10 });
    let attempts = 0;
    await collectGameScores(refreshed.jobId, providerWith(async (id) => {
      attempts++;
      if (id === ids[1]) throw new SteamError("private", "Fixture game activity is private");
      if (id === ids[2]) throw new SteamError("transient", "Fixture game activity failed");
      return games;
    }));
    const result = await getGameScores(runId);
    expect(result.job).toMatchObject({ status: "completed", requestCount: 6 });
    expect(attempts).toBe(6);
    expect(result.rows[0].player.id).toBe(ids[3]);
    for (const id of ids.slice(1, 3)) {
      expect(result.rows.find(row => row.player.id === id)?.result.score).toBeNull();
      const preserved = await pool.query("SELECT status,games,fetched_at FROM game_profiles WHERE mode=$1 AND player_id=$2", [config.mode, id]);
      expect(preserved.rows[0].games).toEqual(games.games);
      expect(preserved.rows[0].fetched_at).toBeInstanceOf(Date);
    }
    const historical = await pool.query("SELECT status,games FROM game_score_players WHERE job_id=$1 AND NOT is_root ORDER BY player_id", [original.jobId]);
    expect(historical.rows.every(row => row.status === "ok")).toBe(true);
    expect(result.job?.id).toBe(refreshed.jobId);
    expect(first.job?.id).toBe(original.jobId);
    expect(historical.rows.map(row => row.games)).toEqual([games.games, games.games, games.games]);
  } finally { await cleanup(runId); }
});

databaseIt("recovers only current-mode jobs from pinned checkpoints and ignores another mode's game cache", async () => {
  const runId = await fixture();
  const otherMode = config.mode === "demo" ? "live" : "demo";
  const otherJobId = randomUUID();
  const calls: string[] = [];
  const provider = providerWith(async (id) => { calls.push(id); return games; });
  try {
    for (const id of ids.slice(0, 4)) {
      await pool.query(
        "INSERT INTO game_profiles(mode,player_id,status,games,fetched_at,attempted_at) VALUES($1,$2,'ok',$3,now(),now())",
        [otherMode, id, JSON.stringify(games.games)],
      );
    }
    const submission = await startGameScoreJob(runId, { maxRequests: 1 });
    const duplicate = await startGameScoreJob(runId, { refresh: true, maxRequests: 4 });
    expect(duplicate).toEqual({ jobId: submission.jobId, enqueue: false });
    await collectGameScores(submission.jobId, provider);
    expect(calls).toEqual([ids[0]]);
    const pinned = await getGameScores(runId);
    const originalNames = pinned.rows.map(row => row.player.name);
    await pool.query(
      "UPDATE players SET name='Changed after score job started' WHERE mode=$1 AND id=ANY($2::text[])",
      [config.mode, ids],
    );
    await pool.query(
      "INSERT INTO game_score_jobs(id,run_id,mode,root_id,status,max_requests) VALUES($1,$2,$3,$4,'running',4)",
      [otherJobId, runId, otherMode, ids[0]],
    );
    await pool.query("UPDATE game_score_jobs SET status='running',max_requests=4 WHERE id=$1", [submission.jobId]);
    const recovered = await recoverGameScoreJobs();
    expect(recovered).toContain(submission.jobId);
    expect(recovered).not.toContain(otherJobId);
    await collectGameScores(submission.jobId, provider);
    const completed = await getGameScores(runId);
    expect(completed.job).toMatchObject({ status: "completed", requestCount: 4, processedPlayers: 4 });
    expect(completed.rows.map(row => row.player.name)).toEqual(originalNames);
    expect(calls).toEqual(ids.slice(0, 4));
    expect((await getGameScores(runId)).job?.requestCount).toBe(4);
  } finally { await cleanup(runId); }
});

databaseIt("keeps available friend snapshots when the refreshed root game activity becomes private", async () => {
  const runId = await fixture();
  try {
    const old = await startGameScoreJob(runId, { refresh: true, maxRequests: 10 });
    await collectGameScores(old.jobId, providerWith(async () => games));
    const fresh = await startGameScoreJob(runId, { refresh: true, maxRequests: 10 });
    await collectGameScores(fresh.jobId, providerWith(async (id) => {
      if (id === ids[0]) throw new SteamError("private", "Fixture root game activity is private");
      return games;
    }));
    const response = await getGameScores(runId);
    expect(response.job).toMatchObject({ status: "completed", requestCount: 4, processedPlayers: 4 });
    expect(response.root?.status).toBe("private");
    expect(response.rows.every(row => row.snapshot.status === "ok")).toBe(true);
    expect(response.rows.every(row => row.result.score === null)).toBe(true);
    const cached = await pool.query("SELECT status,games FROM game_profiles WHERE mode=$1 AND player_id=$2", [config.mode, ids[0]]);
    expect(cached.rows[0]).toEqual({ status: "private", games: games.games });
    expect(response.rows.map(row => row.player.id)).toEqual(ids.slice(1, 4));
  } finally { await cleanup(runId); }
});
