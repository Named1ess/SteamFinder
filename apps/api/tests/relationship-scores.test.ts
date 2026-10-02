import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import {
  getRelationshipScores,
  relationshipScoresQuerySchema,
} from "../src/relationship-scores.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const runId = randomUUID(),
  outsideRunId = randomUUID(),
  otherModeRunId = randomUUID();
const otherMode = config.mode === "demo" ? "live" : "demo";
const ids = Array.from({ length: 605 }, (_, i) =>
  String(76561200100020000n + BigInt(i)),
);

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query(
    "INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,'Relationship fixture '||id,'https://steamcommunity.com/profiles/'||id FROM unnest($2::text[]) p(id)",
    [config.mode, ids],
  );
  await pool.query(
    "INSERT INTO players(mode,id,name,profile_url) VALUES($1,$2,'Other mode private name','https://steamcommunity.com/profiles/'||$2)",
    [otherMode, ids[0]],
  );
  for (const [id, root, mode] of [
    [runId, ids[0], config.mode],
    [outsideRunId, ids[604], config.mode],
    [otherModeRunId, ids[0], otherMode],
  ]) {
    await pool.query(
      "INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status,request_count) VALUES($1,$2,$3,3,1000,20,'completed',7)",
      [id, root, mode],
    );
  }
  await pool.query(
    "INSERT INTO run_nodes(run_id,player_id,depth,fetch_status,fetched_at,friend_count) SELECT $1,id,CASE WHEN ord=1 THEN 0 ELSE 3 END,'ok',now(),CASE WHEN ord<=2 THEN 1 ELSE 0 END FROM unnest($2::text[]) WITH ORDINALITY p(id,ord)",
    [runId, ids.slice(0, 604)],
  );
  await pool.query(
    "INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0),($3,$4,0)",
    [outsideRunId, ids[604], otherModeRunId, ids[0]],
  );
  await pool.query(
    "INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3),($1,$4,$5)",
    [runId, ids[0], ids[1], ids[550], ids[551]],
  );
  await pool.query(
    "UPDATE run_nodes SET friend_count=1 WHERE run_id=$1 AND player_id=ANY($2::text[])",
    [runId, [ids[550], ids[551]]],
  );
  await pool.query(
    "INSERT INTO run_friend_observations(run_id,owner_id,friend_id) VALUES($1,$2,$3),($1,$3,$2),($1,$4,$5),($1,$5,$4),($1,$6,$7)",
    [runId, ids[0], ids[1], ids[550], ids[551], ids[2], ids[604]],
  );
});

afterAll(async () => {
  if (process.env.RUN_DATABASE_TESTS === "true") {
    await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [
      [runId, outsideRunId, otherModeRunId],
    ]);
    await pool.query("DELETE FROM players WHERE id=ANY($1::text[])", [ids]);
  }
  await pool.end();
});

it("accepts an optional valid Steam center and rejects malformed or out-of-range IDs", () => {
  expect(relationshipScoresQuerySchema.parse({})).toEqual({});
  expect(relationshipScoresQuerySchema.parse({ center: ids[550] })).toEqual({
    center: ids[550],
  });
  for (const center of [
    "",
    "123",
    "99999999999999999",
    `${ids[0]} `,
    [ids[0], ids[1]],
  ]) {
    expect(relationshipScoresQuerySchema.safeParse({ center }).success).toBe(
      false,
    );
  }
});

databaseIt(
  "defaults to the root and includes every persisted player beyond display and depth caps",
  async () => {
    const result = await getRelationshipScores(runId);
    expect(result.center.id).toBe(ids[0]);
    expect(result.totalPlayers).toBe(603);
    expect(result.totalEdges).toBe(2);
    expect(result.rows).toHaveLength(603);
    expect(result.rows[0]).toMatchObject({
      player: { id: ids[1] },
      score: 15,
      evidence: "complete",
    });
    expect(result.rows.find((r) => r.player.id === ids[550])).toMatchObject({
      score: null,
      distance: null,
    });
    expect(result.coverage).toEqual({ completeLists: 603, totalLists: 604 });
    expect(result.algorithmVersion).toBe("mutual-network-groups-v2");
    expect(result.groupJobId).toBeNull();
    expect(result.rows[0].groups).toMatchObject({
      contribution: 0,
      similarity: null,
    });
    expect(Number.isFinite(Date.parse(result.computedAt))).toBe(true);
  },
);

databaseIt(
  "adds only this run's pinned group evidence and excludes failed refreshes",
  async () => {
    const groupJobId = randomUUID();
    const group = {
      id: "103582791475930111",
      name: "Shared fixture",
      url: "https://steamcommunity.com/gid/103582791475930111/",
      memberCount: 12,
    };
    try {
      await pool.query(
        "INSERT INTO group_collection_jobs(id,run_id,mode,root_id,status,max_requests) VALUES($1,$2,$3,$4,'completed',10)",
        [groupJobId, runId, config.mode, ids[0]],
      );
      for (const id of [ids[0], ids[1], ids[550]]) {
        await pool.query(
          `INSERT INTO group_collection_players(job_id,player_id,is_root,depth,processed,status,groups,total_count,complete,fetched_at,attempted_at)
         VALUES($1,$2,$3,1,true,'ok',$4,1,true,now(),now())`,
          [groupJobId, id, id === ids[0], JSON.stringify([group])],
        );
      }
      const result = await getRelationshipScores(runId);
      expect(result.groupJobId).toBe(groupJobId);
      expect(result.groupSourceUpdatedAt).toEqual(expect.any(String));
      expect(result.rows.find((row) => row.player.id === ids[1])).toMatchObject(
        {
          networkScore: 15,
          score: 23.5,
          groups: { sharedCount: 1, similarity: 100, contribution: 8.5 },
        },
      );
      expect(
        result.rows.find((row) => row.player.id === ids[550]),
      ).toMatchObject({
        score: null,
        groups: { sharedCount: 1, contribution: 0 },
      });
      expect((await getRelationshipScores(outsideRunId)).groupJobId).toBeNull();
      // A global cache refresh must not silently rewrite this run's snapshots.
      await pool.query(
        "INSERT INTO group_profiles(mode,player_id,status,complete,groups,total_count) VALUES($1,$2,'ok',true,'[]',0) ON CONFLICT(mode,player_id) DO UPDATE SET groups='[]',total_count=0",
        [config.mode, ids[0]],
      );
      expect(
        (await getRelationshipScores(runId)).rows.find(
          (row) => row.player.id === ids[1],
        )?.score,
      ).toBe(23.5);
      await pool.query(
        "UPDATE group_collection_players SET status='error',complete=false WHERE job_id=$1 AND player_id=$2",
        [groupJobId, ids[1]],
      );
      const failed = await getRelationshipScores(runId);
      expect(failed.rows.find((row) => row.player.id === ids[1])).toMatchObject(
        {
          score: 15,
          groups: { similarity: null, contribution: 0, playerStatus: "error" },
        },
      );
    } finally {
      await pool.query("DELETE FROM group_collection_jobs WHERE id=$1", [
        groupJobId,
      ]);
      await pool.query(
        "DELETE FROM group_profiles WHERE mode=$1 AND player_id=$2",
        [config.mode, ids[0]],
      );
    }
  },
);

databaseIt(
  "recenters the full saved graph without exposing another mode's profile",
  async () => {
    const result = await getRelationshipScores(runId, ids[550]);
    expect(result.center).toMatchObject({ id: ids[550], depth: 3 });
    expect(result.rows[0]).toMatchObject({
      player: { id: ids[551] },
      score: 15,
      distance: 1,
    });
    expect(result.rows.find((r) => r.player.id === ids[0])?.player.name).toBe(
      `Relationship fixture ${ids[0]}`,
    );
    expect(result.rows.some((r) => r.player.id === ids[550])).toBe(false);
  },
);

databaseIt(
  "rejects unknown runs, other-mode runs, and centers outside the selected run",
  async () => {
    await expect(getRelationshipScores(randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getRelationshipScores(otherModeRunId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getRelationshipScores(runId, ids[604])).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(getRelationshipScores(runId, "123")).rejects.toMatchObject({
      statusCode: 400,
    });
  },
);

databaseIt(
  "does not change collection, run request counts, jobs, or source timestamps",
  async () => {
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT request_count,cache_hits,updated_at,status,
    (SELECT count(*) FROM run_nodes WHERE run_id=$1) nodes,
    (SELECT count(*) FROM run_edges WHERE run_id=$1) edges,
    (SELECT count(*) FROM game_score_jobs WHERE run_id=$1) jobs
    FROM crawl_runs WHERE id=$1`,
          [runId],
        )
      ).rows;
    const before = await snapshot();
    const first = await getRelationshipScores(runId),
      second = await getRelationshipScores(runId, ids[550]);
    expect(await snapshot()).toEqual(before);
    expect(first.sourceUpdatedAt).toBe(before[0].updated_at.toISOString());
    expect(second.sourceUpdatedAt).toBe(first.sourceUpdatedAt);
  },
);
