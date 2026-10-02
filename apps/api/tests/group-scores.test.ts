import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PublicGroups } from "../../../packages/shared/src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { createRun, putPlayers } from "../src/repository.js";
import { SteamError, type Provider } from "../src/provider.js";
import {
  collectGroupScores,
  getRunGroups,
  getRunGroupSnapshots,
  startGroupCollectionJob,
  recoverGroupCollectionJobs,
} from "../src/group-scores.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const ids = Array.from({ length: 1002 }, (_, i) =>
  String(76561200100009000n + BigInt(i)),
);
const groups: PublicGroups = {
  groups: [
    {
      id: "103582791429521001",
      name: "Fixture group",
      url: "https://steamcommunity.com/groups/fixture",
      memberCount: 42,
    },
  ],
  totalCount: 1,
};
async function addNodes(runId: string, extraIds: string[]) {
  await putPlayers(
    extraIds.map((id) => ({
      id,
      name: `Group fixture ${id}`,
      avatar: null,
      profileUrl: `https://steamcommunity.com/profiles/${id}`,
    })),
  );
  await pool.query(
    "INSERT INTO run_nodes(run_id,player_id,depth) SELECT $1,id,CASE WHEN id=$3 THEN 1 ELSE 2 END FROM unnest($2::text[]) id",
    [runId, extraIds, ids[1]],
  );
}
async function fixture(count = 4) {
  const { run } = await createRun(ids[0], {
    input: ids[0],
    depth: 3,
    maxNodes: 10000,
    maxRequests: 100,
    refresh: true,
  });
  await addNodes(run.id, ids.slice(1, count));
  return run.id;
}
async function cleanup(runIds: string[]) {
  await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [runIds]);
  await pool.query(
    "DELETE FROM group_profiles WHERE player_id=ANY($1::text[])",
    [ids],
  );
  await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [
    config.mode,
    ids,
  ]);
}
function providerWith(
  operation: (id: string) => Promise<PublicGroups>,
): Provider {
  return {
    groups: operation,
    vanity: async () => ids[0],
    summaries: async () => [],
    friends: async () => [],
  };
}
afterAll(async () => {
  await pool.end();
});

databaseIt(
  "reads groups without requests and resumes a one-request budget across all saved depths",
  async () => {
    const runId = await fixture();
    const calls: string[] = [];
    const provider = providerWith(async (id) => {
      calls.push(id);
      return groups;
    });
    try {
      expect(await getRunGroups(runId)).toMatchObject({
        job: null,
        coverage: {
          availablePlayers: 0,
          unavailablePlayers: 0,
          pendingPlayers: 4,
          totalPlayers: 4,
        },
      });
      expect((await getRunGroupSnapshots(runId)).snapshots.size).toBe(0);
      const first = await startGroupCollectionJob(runId, {
        refresh: true,
        maxRequests: 1,
      });
      await collectGroupScores(first.jobId, provider);
      expect(await getRunGroups(runId)).toMatchObject({
        job: {
          status: "limited",
          requestCount: 1,
          totalPlayers: 4,
          processedPlayers: 1,
        },
        coverage: {
          availablePlayers: 1,
          unavailablePlayers: 0,
          pendingPlayers: 3,
        },
      });
      const pinned = await getRunGroupSnapshots(runId);
      expect(pinned.snapshots.get(ids[0])).toMatchObject({
        status: "ok",
        complete: true,
        totalCount: 1,
      });
      expect(pinned.snapshots.get(ids[1])).toMatchObject({
        status: "unknown",
        complete: false,
      });
      await getRunGroups(runId);
      await getRunGroupSnapshots(runId);
      expect(calls).toEqual([ids[0]]);
      const resume = await startGroupCollectionJob(runId, { maxRequests: 4 });
      expect(resume).toEqual({ jobId: first.jobId, enqueue: true });
      await collectGroupScores(resume.jobId, provider);
      expect(await getRunGroups(runId)).toMatchObject({
        job: { status: "completed", requestCount: 4, processedPlayers: 4 },
        coverage: { availablePlayers: 4, pendingPlayers: 0 },
      });
      expect(calls).toEqual(ids.slice(0, 4));
      expect(await startGroupCollectionJob(runId, {})).toEqual({
        jobId: first.jobId,
        enqueue: false,
      });
      await collectGroupScores(first.jobId, provider);
      expect(calls).toHaveLength(4);
    } finally {
      await cleanup([runId]);
    }
  },
);

databaseIt(
  "charges retries to the exact budget and recovers a running checkpoint idempotently",
  async () => {
    const runId = await fixture(1);
    let calls = 0;
    try {
      const first = await startGroupCollectionJob(runId, { maxRequests: 1 });
      await collectGroupScores(
        first.jobId,
        providerWith(async () => {
          calls++;
          throw new SteamError("transient", "try again");
        }),
      );
      expect(calls).toBe(1);
      expect(await getRunGroups(runId)).toMatchObject({
        job: { status: "limited", requestCount: 1, processedPlayers: 0 },
      });
      await expect(
        startGroupCollectionJob(runId, { maxRequests: 0 }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await startGroupCollectionJob(runId, { maxRequests: 2 });
      await pool.query(
        "UPDATE group_collection_jobs SET status='running' WHERE id=$1",
        [first.jobId],
      );
      expect(await recoverGroupCollectionJobs()).toContain(first.jobId);
      const provider = providerWith(async () => {
        calls++;
        return groups;
      });
      await Promise.all([
        collectGroupScores(first.jobId, provider),
        collectGroupScores(first.jobId, provider),
      ]);
      expect(await getRunGroups(runId)).toMatchObject({
        job: { status: "completed", requestCount: 2, processedPlayers: 1 },
      });
      expect(calls).toBe(2);
      expect(await recoverGroupCollectionJobs()).not.toContain(first.jobId);
    } finally {
      await cleanup([runId]);
    }
  },
);

databaseIt(
  "re-enqueues a queued submission after dispatch was lost and duplicate delivery does not refetch",
  async () => {
    const runId = await fixture(1);
    let calls = 0;
    try {
      const initial = await startGroupCollectionJob(runId, { maxRequests: 1 });
      const retried = await startGroupCollectionJob(runId, { maxRequests: 1 });
      expect(retried).toEqual({ jobId: initial.jobId, enqueue: true });
      expect(await recoverGroupCollectionJobs()).toContain(initial.jobId);
      const provider = providerWith(async () => {
        calls++;
        expect(await startGroupCollectionJob(runId, {})).toEqual({
          jobId: initial.jobId,
          enqueue: false,
        });
        return groups;
      });
      await Promise.all([
        collectGroupScores(initial.jobId, provider),
        collectGroupScores(retried.jobId, provider),
      ]);
      expect(calls).toBe(1);
      expect(await getRunGroups(runId)).toMatchObject({
        job: { status: "completed", requestCount: 1, processedPlayers: 1 },
      });
    } finally {
      await cleanup([runId]);
    }
  },
);

databaseIt(
  "pins failed refreshes as unavailable while retaining old successful groups and historical snapshots",
  async () => {
    const runId = await fixture();
    try {
      const old = await startGroupCollectionJob(runId, {
        refresh: true,
        maxRequests: 10,
      });
      await collectGroupScores(
        old.jobId,
        providerWith(async () => groups),
      );
      const fresh = await startGroupCollectionJob(runId, {
        refresh: true,
        maxRequests: 10,
      });
      await collectGroupScores(
        fresh.jobId,
        providerWith(async (id) => {
          if (id === ids[0]) throw new SteamError("private", "private groups");
          if (id === ids[1])
            throw new SteamError("transient", "unavailable groups");
          return groups;
        }),
      );
      expect(await getRunGroups(runId)).toMatchObject({
        job: { id: fresh.jobId, status: "completed", requestCount: 6 },
        coverage: {
          availablePlayers: 2,
          unavailablePlayers: 2,
          pendingPlayers: 0,
        },
      });
      const pinned = await getRunGroupSnapshots(runId);
      expect(pinned.jobId).toBe(fresh.jobId);
      expect(pinned.snapshots.get(ids[0])).toMatchObject({
        status: "private",
        complete: false,
        groups: groups.groups,
      });
      expect(pinned.snapshots.get(ids[1])).toMatchObject({
        status: "error",
        complete: false,
        groups: groups.groups,
      });
      const cache = await pool.query(
        "SELECT status,complete,groups,fetched_at FROM group_profiles WHERE mode=$1 AND player_id=$2",
        [config.mode, ids[0]],
      );
      expect(cache.rows[0]).toMatchObject({
        status: "private",
        complete: false,
        groups: groups.groups,
        fetched_at: expect.any(Date),
      });
      const historical = await pool.query(
        "SELECT status,complete FROM group_collection_players WHERE job_id=$1",
        [old.jobId],
      );
      expect(
        historical.rows.every((row) => row.status === "ok" && row.complete),
      ).toBe(true);
    } finally {
      await cleanup([runId]);
    }
  },
);

databaseIt(
  "isolates run snapshots and modes while reusing mode-scoped cached groups",
  async () => {
    const firstRun = await fixture(2);
    const secondRun = await fixture(2);
    const otherMode = config.mode === "demo" ? "live" : "demo";
    const otherJobId = randomUUID();
    try {
      for (const id of ids.slice(0, 2))
        await pool.query(
          "INSERT INTO group_profiles(mode,player_id,status,complete,groups,total_count) VALUES($1,$2,'ok',true,$3,1)",
          [otherMode, id, JSON.stringify(groups.groups)],
        );
      const submitted = await Promise.all([
        startGroupCollectionJob(firstRun, {}),
        startGroupCollectionJob(firstRun, { refresh: true }),
      ]);
      expect(submitted[0].jobId).toBe(submitted[1].jobId);
      expect(submitted.every((job) => job.enqueue)).toBe(true);
      const seen: string[] = [];
      await collectGroupScores(
        submitted[0].jobId,
        providerWith(async (id) => {
          seen.push(id);
          return groups;
        }),
      );
      expect(seen).toEqual(ids.slice(0, 2));
      expect((await getRunGroupSnapshots(secondRun)).snapshots.size).toBe(0);
      const second = await startGroupCollectionJob(secondRun, {});
      await collectGroupScores(
        second.jobId,
        providerWith(async () => {
          throw new Error("cache must avoid network");
        }),
      );
      expect(await getRunGroups(secondRun)).toMatchObject({
        job: { status: "completed", requestCount: 0, cacheHits: 2 },
        coverage: { availablePlayers: 2 },
      });
      await pool.query(
        "UPDATE group_profiles SET groups='[]',total_count=0 WHERE mode=$1 AND player_id=ANY($2::text[])",
        [config.mode, ids],
      );
      expect(
        (await getRunGroupSnapshots(firstRun)).snapshots.get(ids[0])?.groups,
      ).toEqual(groups.groups);
      await pool.query(
        "INSERT INTO group_collection_jobs(id,run_id,mode,root_id,status,max_requests) VALUES($1,$2,$3,$4,'running',4)",
        [otherJobId, firstRun, otherMode, ids[0]],
      );
      expect(await recoverGroupCollectionJobs()).not.toContain(otherJobId);
      expect((await getRunGroups(firstRun)).job?.id).toBe(submitted[0].jobId);
      await pool.query("UPDATE crawl_runs SET mode=$2 WHERE id=$1", [
        secondRun,
        otherMode,
      ]);
      await expect(getRunGroups(secondRun)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(getRunGroupSnapshots(secondRun)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        startGroupCollectionJob(secondRun, {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanup([firstRun, secondRun]);
    }
  },
);

databaseIt(
  "includes players beyond the canvas limit and starts a new pinned job after run growth",
  async () => {
    const runId = await fixture(1001);
    try {
      await pool.query(
        "INSERT INTO group_profiles(mode,player_id,status,complete,groups,total_count) SELECT $1,id,'ok',true,'[]'::jsonb,0 FROM unnest($2::text[]) id",
        [config.mode, ids],
      );
      const initial = await startGroupCollectionJob(runId, { maxRequests: 1 });
      await collectGroupScores(
        initial.jobId,
        providerWith(async () => {
          throw new Error("cache must avoid network");
        }),
      );
      expect(await getRunGroups(runId)).toMatchObject({
        job: {
          status: "completed",
          totalPlayers: 1001,
          cacheHits: 1001,
          requestCount: 0,
        },
      });
      expect((await getRunGroupSnapshots(runId)).snapshots.size).toBe(1001);
      await addNodes(runId, [ids[1001]]);
      const grown = await startGroupCollectionJob(runId, { maxRequests: 1 });
      expect(grown.jobId).not.toBe(initial.jobId);
      expect(grown.enqueue).toBe(true);
      await collectGroupScores(
        grown.jobId,
        providerWith(async () => {
          throw new Error("cache must avoid network");
        }),
      );
      expect(await getRunGroups(runId)).toMatchObject({
        job: { status: "completed", totalPlayers: 1002 },
        coverage: { availablePlayers: 1002 },
      });
    } finally {
      await cleanup([runId]);
    }
  },
  30000,
);
