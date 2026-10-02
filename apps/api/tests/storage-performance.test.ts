import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { crawl } from "../src/crawler.js";
import {
  captureList, createRun, failList, getGraphData, getRun, listRuns, putPlayers, saveList,
} from "../src/repository.js";
import type { Player, Provider } from "../src/provider.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const runs: string[] = [];
const ids = Array.from({ length: 300 }, (_, i) => String(76561200100050000n + BigInt(i)));
const player = (id: string): Player => ({ id, name: `Storage fixture ${id}`, avatar: null, profileUrl: `https://steamcommunity.com/profiles/${id}` });
const provider: Provider = {
  vanity: async () => ids[0], summaries: async (batch) => batch.map(player), friends: async () => [],
};

async function newRun(maxNodes = 100, depth = 2) {
  const { run } = await createRun(ids[0], { input: ids[0], maxNodes, depth, maxRequests: 100, refresh: true });
  runs.push(run.id);
  return run;
}

async function nodes(runId: string, selected: string[]) {
  await putPlayers(selected.map(player));
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth,hydrated) SELECT $1,unnest($2::text[]),1,true ON CONFLICT DO NOTHING", [runId, selected]);
}

async function edges(runId: string) {
  const { rows } = await pool.query("SELECT source,target FROM run_edges WHERE run_id=$1 ORDER BY source,target", [runId]);
  return rows;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [runs.splice(0)]);
  await pool.query("DELETE FROM friend_observations WHERE mode=$1 AND owner_id=ANY($2::text[])", [config.mode, ids]);
  await pool.query("DELETE FROM friendship_edges WHERE mode=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))", [config.mode, ids]);
  await pool.query("DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])", [config.mode, ids]);
  await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids]);
});
afterAll(async () => { await pool.end(); });

databaseIt("returns the newest 100 history rows with matching statistics in one query", async () => {
  await putPlayers(ids.slice(0, 5).map(player));
  const history: string[] = Array.from({ length: 105 }, () => randomUUID());
  runs.push(...history);
  await pool.query(`INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,created_at)
    SELECT id,$2,$3,2,100,100,'2099-01-01'::timestamptz+ordinality*interval '1 second'
    FROM unnest($1::uuid[]) WITH ORDINALITY AS fixtures(id,ordinality)`, [history, ids[0], config.mode]);
  const newest = history[104];
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth,fetch_status) SELECT $1,id,1,status FROM unnest($2::text[],$3::text[]) AS n(id,status)", [newest, ids.slice(0, 4), ["ok", "private", "error", "unknown"]]);
  await pool.query("INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3),($1,$2,$4)", [newest, ids[0], ids[1], ids[2]]);
  const expected = await getRun(newest);
  const query = vi.spyOn(pool, "query");
  const result = await listRuns();
  expect(result.map((run) => run.id)).toEqual(history.slice(5).reverse());
  expect(result[0]).toEqual(expected);
  expect(result[0]).toMatchObject({ mode: config.mode, nodeCount: 4, edgeCount: 2, fetchedCount: 1, privateCount: 1, errorCount: 1 });
  expect(result[1]).toMatchObject({ nodeCount: 0, edgeCount: 0, fetchedCount: 0, privateCount: 0, errorCount: 0 });
  expect(result.every((run) => run.mode === config.mode)).toBe(true);
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRestore();
  const originalMode = config.mode;
  try {
    config.mode = originalMode === "demo" ? "live" : "demo";
    expect((await listRuns()).some((run) => history.includes(run.id))).toBe(false);
    await expect(getRun(newest)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    config.mode = originalMode;
  }
});

databaseIt("bulk upserts player metadata with last duplicate winning and atomic hydration", async () => {
  const run = await newRun();
  const batch = ids.slice(0, 250).map(player);
  batch.push({ ...player(ids[0]), name: "Last duplicate", avatar: "https://example.test/avatar.jpg" });
  const query = vi.spyOn(pg.Client.prototype, "query");
  await putPlayers(batch, { runId: run.id, ids: [ids[0]] });
  expect(query.mock.calls.length).toBeLessThanOrEqual(4);
  query.mockRestore();
  const result = await pool.query("SELECT name,avatar,summary_at FROM players WHERE mode=$1 AND id=$2", [config.mode, ids[0]]);
  expect(result.rows[0]).toMatchObject({ name: "Last duplicate", avatar: "https://example.test/avatar.jpg", summary_at: expect.any(Date) });
  const count = await pool.query("SELECT count(*)::int count FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids.slice(0, 250)]);
  expect(count.rows[0].count).toBe(250);
  expect((await pool.query("SELECT hydrated FROM run_nodes WHERE run_id=$1", [run.id])).rows).toEqual([{ hydrated: true }]);
  await putPlayers([], { runId: run.id, ids: [ids[0]] });
});

databaseIt("uses an already validated run for graph reads while rejecting mismatched identities or modes", async () => {
  const run = await newRun();
  const expected = await getGraphData(run.id);
  const query = vi.spyOn(pool, "query");
  expect(await getGraphData(run.id, run)).toEqual(expected);
  expect(query).toHaveBeenCalledTimes(2);
  await expect(getGraphData(run.id, { ...run, id: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
  await expect(getGraphData(run.id, { ...run, mode: run.mode === "demo" ? "live" : "demo" })).rejects.toMatchObject({ statusCode: 404 });
});

databaseIt("refreshes only owner edges, preserving reverse observations, old private/error lists and historical snapshots", async () => {
  const run = await newRun();
  await nodes(run.id, ids.slice(0, 4));
  await saveList(ids[0], [ids[1], ids[2]], run.id);
  await saveList(ids[1], [ids[0]], run.id);
  await saveList(ids[2], [ids[3]], run.id);
  expect(await edges(run.id)).toEqual([
    { source: ids[0], target: ids[1] }, { source: ids[0], target: ids[2] }, { source: ids[2], target: ids[3] },
  ]);
  const identity = async () => (await pool.query("SELECT ctid::text identity FROM run_edges WHERE run_id=$1 AND source=$2 AND target=$3", [run.id, ids[2], ids[3]])).rows[0].identity;
  const unrelated = await identity();
  await failList(ids[0], "private", run.id);
  await failList(ids[0], "error", run.id);
  expect(await getRun(run.id)).toMatchObject({ edgeCount: 3, errorCount: 1 });
  await saveList(ids[0], [], run.id);
  expect(await edges(run.id)).toEqual([{ source: ids[0], target: ids[1] }, { source: ids[2], target: ids[3] }]);
  expect(await identity()).toBe(unrelated);
  await saveList(ids[1], [], run.id);
  expect(await edges(run.id)).toEqual([{ source: ids[2], target: ids[3] }]);
  await saveList(ids[2], []);
  expect(await edges(run.id)).toEqual([{ source: ids[2], target: ids[3] }]);
});

databaseIt("admits sorted capped batches and resumes without rewriting previously supported edges", async () => {
  const run = await newRun(5, 1);
  const calls: string[] = [];
  const source: Provider = { ...provider, friends: async (id) => { calls.push(id); return ids.slice(1, 51).reverse(); } };
  const query = vi.spyOn(pg.Client.prototype, "query");
  await crawl(run.id, source);
  const firstQueries = query.mock.calls.map(([sql]) => sql);
  query.mockRestore();
  expect(await getRun(run.id)).toMatchObject({ status: "limited", nodeCount: 5, edgeCount: 4, requestCount: 2 });
  expect((await pool.query("SELECT player_id FROM run_nodes WHERE run_id=$1 ORDER BY player_id", [run.id])).rows.map((row) => row.player_id)).toEqual(ids.slice(0, 5));
  expect(firstQueries.filter((sql) => /INSERT INTO players\(/.test(sql))).toHaveLength(2);
  expect(firstQueries.filter((sql) => /INSERT INTO run_nodes\(/.test(sql))).toHaveLength(1);
  expect(firstQueries.some((sql) => /^DELETE FROM run_edges WHERE run_id=\$1\s*$/.test(sql))).toBe(false);
  const before = (await pool.query("SELECT ctid::text identity FROM run_edges WHERE run_id=$1 AND source=$2 AND target=$3", [run.id, ids[0], ids[1]])).rows[0].identity;
  await pool.query("UPDATE crawl_runs SET status='queued',max_nodes=100 WHERE id=$1", [run.id]);
  await crawl(run.id, source);
  expect(await getRun(run.id)).toMatchObject({ status: "completed", nodeCount: 51, edgeCount: 50 });
  const after = (await pool.query("SELECT ctid::text identity FROM run_edges WHERE run_id=$1 AND source=$2 AND target=$3", [run.id, ids[0], ids[1]])).rows[0].identity;
  expect(after).toBe(before);
  expect(calls).toEqual([ids[0]]);
});

databaseIt("adds incoming observations from past owners when a pending owner admits a node", async () => {
  const run = await newRun();
  await nodes(run.id, ids.slice(0, 3));
  await putPlayers([player(ids[3])]);
  await pool.query("UPDATE run_nodes SET hydrated=true,observed=true,expanded=(player_id<>$2) WHERE run_id=$1", [run.id, ids[2]]);
  await pool.query("INSERT INTO run_friend_observations(run_id,owner_id,friend_id) VALUES($1,$2,$3),($1,$4,$3),($1,$2,$4)", [run.id, ids[1], ids[3], ids[2]]);
  await pool.query("INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3)", [run.id, ids[1], ids[2]]);
  const untouched = (await pool.query("SELECT ctid::text identity FROM run_edges WHERE run_id=$1", [run.id])).rows[0].identity;
  await crawl(run.id, provider);
  expect(await edges(run.id)).toEqual([
    { source: ids[1], target: ids[2] }, { source: ids[1], target: ids[3] }, { source: ids[2], target: ids[3] },
  ]);
  expect((await pool.query("SELECT ctid::text identity FROM run_edges WHERE run_id=$1 AND source=$2 AND target=$3", [run.id, ids[1], ids[2]])).rows[0].identity).toBe(untouched);
  expect(await getRun(run.id)).toMatchObject({ status: "completed", nodeCount: 4, edgeCount: 3 });
});

databaseIt("checks cancellation under the run lock before admitting a discovered batch", async () => {
  const run = await newRun();
  await crawl(run.id, { ...provider, friends: async () => {
    await pool.query("UPDATE crawl_runs SET status='cancelled' WHERE id=$1", [run.id]);
    return ids.slice(1, 50);
  } });
  expect(await getRun(run.id)).toMatchObject({ status: "cancelled", nodeCount: 1, edgeCount: 0, requestCount: 2 });
});

databaseIt("advances only the target run version when a late saved or failed list updates its snapshot", async () => {
  const target = await newRun();
  const history = await newRun();
  await nodes(target.id, ids.slice(0, 2));
  await nodes(history.id, ids.slice(0, 2));
  await saveList(ids[0], [ids[1]], history.id);
  const oldTimestamp = "2000-01-01T00:00:00.000Z";
  await pool.query(
    "UPDATE crawl_runs SET status=CASE WHEN id=$1 THEN 'cancelled' ELSE 'completed' END,updated_at=$3 WHERE id=ANY($2::uuid[])",
    [target.id, [target.id, history.id], oldTimestamp],
  );
  const historicalSnapshot = await getRun(history.id);
  await saveList(ids[0], [ids[1]], target.id);
  const saved = await getRun(target.id);
  expect(saved.updatedAt > oldTimestamp).toBe(true);
  expect(saved).toMatchObject({ status: "cancelled", edgeCount: 1, fetchedCount: 1 });
  expect(await getRun(history.id)).toEqual(historicalSnapshot);

  for (const status of ["private", "error"] as const) {
    await pool.query("UPDATE crawl_runs SET updated_at=$2 WHERE id=$1", [target.id, oldTimestamp]);
    await failList(ids[0], status, target.id);
    const failed = await getRun(target.id);
    expect(failed.updatedAt > oldTimestamp).toBe(true);
    expect(failed).toMatchObject({ status: "cancelled", edgeCount: 1 });
    expect(failed[status === "private" ? "privateCount" : "errorCount"]).toBe(1);
    expect(await getRun(history.id)).toEqual(historicalSnapshot);
  }

  // A fixed timestamp ahead of the transaction clock makes millisecond version
  // advancement deterministic without sleeping or relying on test execution speed.
  await pool.query("UPDATE crawl_runs SET updated_at=$2 WHERE id=$1", [target.id, "2100-01-01T00:00:00.123Z"]);
  await saveList(ids[0], [ids[1]], target.id);
  expect((await getRun(target.id)).updatedAt).toBe("2100-01-01T00:00:00.124Z");
  await failList(ids[0], "private", target.id);
  expect((await getRun(target.id)).updatedAt).toBe("2100-01-01T00:00:00.125Z");
  await captureList(target.id, ids[0]);
  expect(await getRun(target.id)).toMatchObject({ updatedAt: "2100-01-01T00:00:00.126Z", cacheHits: 1 });
  expect(await getRun(history.id)).toEqual(historicalSnapshot);
});
