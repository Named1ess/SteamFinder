import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { saveList, failList } from "../src/repository.js";
import {
  getRelationshipScoreDetail,
  getRelationshipScorePage,
  getRelationshipOverview,
  getRelationshipScores,
  relationshipPageQuerySchema,
  relationshipOverview,
} from "../src/relationship-scores.js";
import type { RelationshipScoreRow, RelationshipScoresResponse } from "../../../packages/shared/src/index.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const runId = randomUUID(), jobId = randomUUID();
const ids = Array.from({ length: 136 }, (_, i) => String(76561200100070000n + BigInt(i)));
const group = { id: "103582791475937111", name: "Page fixture", url: "https://steamcommunity.com/gid/103582791475937111/", memberCount: 2 };

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query("INSERT INTO players(mode,id,name,profile_url,summary_at) SELECT $1,id,'Page fixture '||id,'https://steamcommunity.com/profiles/'||id,now() FROM unnest($2::text[]) p(id)", [config.mode, ids]);
  await pool.query("INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status) VALUES($1,$2,$3,3,1000,20,'completed')", [runId, ids[0], config.mode]);
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth,fetch_status,fetched_at,friend_count) SELECT $1,id,CASE WHEN ord=1 THEN 0 ELSE 3 END,'ok',now(),0 FROM unnest($2::text[]) WITH ORDINALITY p(id,ord)", [runId, ids]);
  await pool.query("INSERT INTO run_edges(run_id,source,target) SELECT $1,$2,id FROM unnest($3::text[]) p(id)", [runId, ids[0], ids.slice(1, 101)]);
  await pool.query("UPDATE players SET name='Needle past page one' WHERE mode=$1 AND id=$2", [config.mode, ids[134]]);
  await pool.query("INSERT INTO group_collection_jobs(id,run_id,mode,root_id,status,max_requests) VALUES($1,$2,$3,$4,'completed',20)", [jobId, runId, config.mode, ids[0]]);
  await pool.query("INSERT INTO group_collection_players(job_id,player_id,is_root,depth,processed,status,groups,total_count,complete,fetched_at) SELECT $1,id,id=$2,1,true,'ok',$3,1,true,now() FROM unnest($4::text[]) p(id)", [jobId, ids[0], JSON.stringify([group]), [ids[0], ids[1], ids[134]]]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (process.env.RUN_DATABASE_TESTS === "true") {
    await pool.query("DELETE FROM crawl_runs WHERE id=$1", [runId]);
    await pool.query("DELETE FROM friend_observations WHERE mode=$1 AND owner_id=ANY($2::text[])", [config.mode, ids]);
    await pool.query("DELETE FROM friendship_edges WHERE mode=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))", [config.mode, ids]);
    await pool.query("DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])", [config.mode, ids]);
    await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids]);
  }
  await pool.end();
});

it("bounds page requests and rejects malformed filters", () => {
  expect(relationshipPageQuerySchema.parse({})).toMatchObject({ page: 0, limit: 30, q: "", layer: "all" });
  for (const input of [{ page: -1 }, { page: 1.5 }, { limit: 0 }, { limit: 101 }, { q: "x".repeat(201) }, { layer: "bad" }, { center: "123" }, { page: ["1", "2"] }]) {
    expect(relationshipPageQuerySchema.safeParse(input).success).toBe(false);
  }
});

it("overview retains lower scored layers when the first layer fills the cap", () => {
  const rows = ["core", "close", "connected", "peripheral", "unknown"].flatMap((layer, layerIndex) => Array.from({ length: 120 }, (_, i) => ({
    player: { id: `${layer}-${i}`, name: layer, avatar: null, profileUrl: "", depth: 1 },
    layer, score: layer === "unknown" ? null : 80 - layerIndex * 20, mutualCount: 0, distance: 1, isDirect: false,
  }) as RelationshipScoreRow));
  const sample = relationshipOverview({ rows } as RelationshipScoresResponse);
  expect(sample.rows.length).toBeLessThanOrEqual(100);
  expect(new Set(sample.rows.map((r) => r.layer))).toEqual(new Set(["core", "close", "connected", "peripheral"]));
  expect(sample.rows.every((r) => !Object.hasOwn(r, "commonFriends") && !Object.hasOwn(r, "groups"))).toBe(true);
});

databaseIt("pages across the entire saved graph with exact legacy ranking and separate evidence", async () => {
  const legacy = await getRelationshipScores(runId);
  const all = [];
  for (let page = 0; page < 5; page++) {
    const result = await getRelationshipScorePage(runId, { page });
    expect(result.rows.length).toBeLessThanOrEqual(30);
    expect(result.total).toBe(135);
    expect(result.totalPlayers).toBe(135);
    all.push(...result.rows);
  }
  expect(all.map((r) => r.player.id)).toEqual(legacy.rows.map((r) => r.player.id));
  expect(all[0]).toMatchObject({ player: { id: ids[1] }, score: 23.5, networkScore: 15 });
  expect(all.every((row) => !Object.hasOwn(row, "commonFriends") && !Object.hasOwn(row, "groups"))).toBe(true);
  const detail = await getRelationshipScoreDetail(runId, ids[1]);
  expect(detail.row).toEqual(legacy.rows[0]);
  expect(detail.row.groups?.commonGroups).toEqual([group]);
  const overview = await getRelationshipOverview(runId);
  expect(overview.rows.length).toBeLessThanOrEqual(100);
  expect(overview.layers).toEqual(legacy.layers);
});

databaseIt("searches later pages and unknown layers without inventing evidence", async () => {
  const found = await getRelationshipScorePage(runId, { q: "  NEEDLE  ", layer: "unknown", page: 99 });
  expect(found).toMatchObject({ page: 0, pages: 1, total: 1 });
  expect(found.rows[0]).toMatchObject({ player: { id: ids[134] }, score: null });
  const detail = await getRelationshipScoreDetail(runId, ids[134]);
  expect(detail.row).toMatchObject({ score: null, groups: { sharedCount: 1, contribution: 0 } });
  expect((await getRelationshipScorePage(runId, { q: ids[135] })).rows[0].player.id).toBe(ids[135]);
  expect((await getRelationshipScorePage(runId, { q: "not in fixture" })).total).toBe(0);
  await expect(getRelationshipScoreDetail(runId, "123")).rejects.toMatchObject({ statusCode: 400 });
  await expect(getRelationshipScoreDetail(runId, "76561200100079999")).rejects.toMatchObject({ statusCode: 404 });
  await expect(getRelationshipScorePage(runId, { center: "76561200100079999" })).rejects.toMatchObject({ statusCode: 400 });
});

databaseIt("shares one scored snapshot across concurrent pages, overview and detail", async () => {
  // Select a different center so the request cannot hit a prior test's entry.
  const query = vi.spyOn(pool, "query");
  try {
    const [first, second, overview, detail] = await Promise.all([
      getRelationshipScorePage(runId, { center: ids[2] }),
      getRelationshipScorePage(runId, { center: ids[2], page: 1 }),
      getRelationshipOverview(runId, ids[2]),
      getRelationshipScoreDetail(runId, ids[0], ids[2]),
    ]);
    expect(first.rows).toHaveLength(30);
    expect(second.rows).toHaveLength(30);
    expect(overview.center.id).toBe(ids[2]);
    expect(detail.row.player.id).toBe(ids[0]);
    const graphReads = query.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("SELECT source,target FROM run_edges"));
    expect(graphReads).toHaveLength(1);
  } finally { query.mockRestore(); }
});

databaseIt("refreshes cached pages after profile, group, run and coverage revisions", async () => {
  await getRelationshipScorePage(runId);
  await pool.query("UPDATE players SET name='Changed page fixture' WHERE mode=$1 AND id=$2", [config.mode, ids[1]]);
  expect((await getRelationshipScorePage(runId, { q: "Changed page fixture" })).total).toBe(1);
  await pool.query("UPDATE group_collection_players SET status='error',complete=false WHERE job_id=$1 AND player_id=$2", [jobId, ids[1]]);
  await pool.query("UPDATE group_collection_jobs SET updated_at=clock_timestamp()+interval '1 second' WHERE id=$1", [jobId]);
  expect((await getRelationshipScoreDetail(runId, ids[1])).row.score).toBe(15);
  await pool.query("UPDATE run_nodes SET fetch_status='private' WHERE run_id=$1 AND player_id=$2", [runId, ids[1]]);
  await pool.query("UPDATE crawl_runs SET updated_at=clock_timestamp()+interval '1 second' WHERE id=$1", [runId]);
  expect((await getRelationshipScoreDetail(runId, ids[1])).row.evidence).toBe("partial");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000 + 1000);
  try {
    expect((await getRelationshipScorePage(runId)).coverage.completeLists).toBe(0);
  } finally { clock.mockRestore(); }
});

databaseIt("tracks node snapshot changes even when the serialized run timestamp is unchanged", async () => {
  const before = await getRelationshipScoreDetail(runId, ids[4], ids[2]);
  await pool.query("UPDATE run_nodes SET friend_count=1000 WHERE run_id=$1 AND player_id=$2", [runId, ids[0]]);
  await pool.query("UPDATE run_nodes SET depth=2 WHERE run_id=$1 AND player_id=$2", [runId, ids[4]]);
  const changed = await getRelationshipScoreDetail(runId, ids[4], ids[2]);
  expect(changed.row.player.depth).toBe(2);
  expect(changed.row.weightedMutual).toBeLessThan(before.row.weightedMutual);
  const fresh = await getRelationshipScorePage(runId);
  await pool.query("UPDATE run_nodes SET fetched_at=now()-interval '2 days' WHERE run_id=$1 AND player_id=$2", [runId, ids[4]]);
  expect((await getRelationshipScorePage(runId)).coverage.completeLists).toBe(fresh.coverage.completeLists - 1);
});

databaseIt("matches uncached scores after real successful and failed friend snapshot writes", async () => {
  expect((await getRelationshipScorePage(runId, { q: ids[120] })).rows[0].score).toBeNull();
  await saveList(ids[120], [ids[0]], runId);
  const afterSave = await getRelationshipScorePage(runId, { q: ids[120] });
  const legacy = await getRelationshipScores(runId);
  expect(afterSave.rows[0].score).toBe(15);
  expect(afterSave.rows[0].score).toBe(legacy.rows.find(row => row.player.id === ids[120])!.score);
  expect((await getRelationshipScoreDetail(runId, ids[120])).row).toEqual(legacy.rows.find(row => row.player.id === ids[120]));
  await failList(ids[120], "error", runId);
  const failedLegacy = await getRelationshipScores(runId);
  expect((await getRelationshipScorePage(runId, { q: ids[120] })).coverage).toEqual(failedLegacy.coverage);
  expect((await getRelationshipScoreDetail(runId, ids[120])).row).toEqual(failedLegacy.rows.find(row => row.player.id === ids[120]));
});
