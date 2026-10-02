import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { CrawlRun, GraphFilters, GraphNode, GraphFilterRequest, GraphFilterResponse, GameProfileSnapshot, GroupSnapshot } from "../../../packages/shared/src/index.js";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { getGraphData, getRun, HttpError } from "../src/repository.js";
import { graphResponse } from "../src/graph.js";
import { getRelationshipScores } from "../src/relationship-scores.js";
import { filterGraph, graphFilterRequestSchema, registerGraphFilterRoutes, scoreFilterSnapshot, type FilterSources } from "../src/graph-filters.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const ids = Array.from({ length: 126 }, (_, i) => String(76561200100110000n + BigInt(i)));
const group = { id: "103582791475937111", name: "Filter group", url: "https://steamcommunity.com/gid/103582791475937111/", memberCount: 2 };
const defaults: GraphFilters = { minScore: null, community: null, gameAppId: "", groupId: "", fetchStatus: "all", tag: "", unknown: "exclude" };
const request = (filters: Partial<GraphFilters> = {}, rest: Partial<GraphFilterRequest> = {}): GraphFilterRequest => ({ filters: { ...defaults, ...filters }, limit: 100, page: 0, ...rest });
const nodes: GraphNode[] = ids.slice(0, 125).map((id, i) => ({ id, name: `Filter ${i}`, avatar: null, profileUrl: "", depth: i ? Math.min(i, 3) : 0, fetchStatus: "unknown", fetchedAt: null, friendCount: null, degree: 0, community: 0 }));
const edges = [[0, 1], [1, 2], [2, 3], [3, 4]].map(([a, b]) => ({ id: `${ids[a]}:${ids[b]}`, source: ids[a], target: ids[b] }));
const emptySources = () => ({ scores: new Map<string, number | null>(), games: new Map<string, Pick<GameProfileSnapshot, "status" | "games">>(), groups: new Map<string, GroupSnapshot>() }) satisfies FilterSources;
const run = { rootId: ids[0] } as CrawlRun;
function groupSnapshot(patch: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return { playerId: ids[0], status: "ok", groups: [group], totalCount: 1, complete: true, fetchedAt: null, attemptedAt: null, message: null, ...patch };
}

it("rejects incomplete, unsafe and oversized filter input", () => {
  expect(graphFilterRequestSchema.safeParse(request()).success).toBe(true);
  for (const limit of [100, 250, 500, 1000]) expect(graphFilterRequestSchema.safeParse(request({}, { limit })).success).toBe(true);
  for (const patch of [{ minScore: -1 }, { minScore: 101 }, { minScore: Infinity }, { community: -1 }, { community: 1.5 }, { community: Number.MAX_SAFE_INTEGER + 1 }, { gameAppId: "1e3" }, { gameAppId: "9007199254740992" }, { groupId: ids[0] }, { groupId: "1035827914295214080" }, { fetchStatus: "hidden" }, { tag: "x".repeat(25) }, { unknown: "all" }]) {
    expect(graphFilterRequestSchema.safeParse({ ...request(), filters: { ...defaults, ...patch } }).success).toBe(false);
  }
  for (const patch of [{ filters: {} }, { page: -1 }, { page: 100001 }, { limit: 101 }, { tagPlayerIds: Array(1001).fill(ids[0]) }, { tagPlayerIds: ["bad"] }, { focus: { playerId: ids[0], hops: 3 } }]) {
    expect(graphFilterRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
  }
});

it("matches a requested friend-list status exactly even when that status is unknown", () => {
  const players = nodes.slice(0, 4).map((node, index) => ({ ...node, fetchStatus: (["unknown", "ok", "private", "error"] as const)[index] }));
  for (const [index, fetchStatus] of (["unknown", "ok", "private", "error"] as const).entries()) {
    const result = filterGraph(run, players, [], request({ fetchStatus, unknown: "include" }), emptySources(), "test");
    expect(result).toMatchObject({ matched: 1, unknown: 0, excluded: 3 });
    expect(result.rows.map((row) => row.player.id)).toEqual([ids[index]]);
  }
});

it("lets a known failed condition dominate missing samples and score", () => {
  const sources = emptySources();
  sources.games.set(ids[0], { status: "ok", games: [{ appId: "570", name: "Dota", minutes: 0 }] });
  sources.games.set(ids[1], { status: "ok", games: [] });
  sources.games.set(ids[2], { status: "error", games: [{ appId: "570", name: "Stale", minutes: 0 }] });
  sources.scores.set(ids[0], 20);
  sources.scores.set(ids[2], 0);
  const result = filterGraph(run, nodes.slice(0, 4), [], request({ gameAppId: "570", minScore: 10, unknown: "include" }), sources, "test");
  expect(result).toMatchObject({ matched: 1, unknown: 1, excluded: 2, total: 2, scopeTotal: 4 });
  expect(result.rows.map((row) => [row.player.id, row.status])).toEqual([[ids[0], "match"], [ids[3], "unknown"]]);
  expect(result.rows[1].unknownReasons).toHaveLength(2);
  const only = filterGraph(run, nodes.slice(0, 4), [], request({ gameAppId: "570", minScore: 10, unknown: "only" }), sources, "test");
  expect(only.rows.map((row) => row.player.id)).toEqual([ids[3]]);
  const matches = filterGraph(run, nodes.slice(0, 4), [], request({ gameAppId: "570", minScore: 10 }), sources, "test");
  expect(matches.rows.map((row) => row.player.id)).toEqual([ids[0]]);
});

it("treats only complete consistent group snapshots as known", () => {
  const sources = emptySources();
  sources.groups.set(ids[0], groupSnapshot());
  sources.groups.set(ids[1], groupSnapshot({ groups: [], totalCount: 0 }));
  sources.groups.set(ids[2], groupSnapshot({ complete: false }));
  sources.groups.set(ids[3], groupSnapshot({ totalCount: 2 }));
  const result = filterGraph(run, nodes.slice(0, 4), [], request({ groupId: group.id, unknown: "include" }), sources, "test");
  expect(result).toMatchObject({ matched: 1, unknown: 2, excluded: 1, total: 3 });
});

it("scores the exact supplied graph and pinned groups with the unchanged relationship formula", () => {
  const players = nodes.slice(0, 3), knownEdges = edges.slice(0, 1);
  const groups = new Map([[ids[0], groupSnapshot()], [ids[1], groupSnapshot({ playerId: ids[1] })]]);
  const scores = scoreFilterSnapshot(run, players, knownEdges, new Set(), groups, 0);
  expect(scores.get(ids[1])).toBe(23.5);
  expect(scores.get(ids[2])).toBeNull();
  expect(scores.has(ids[0])).toBe(false);
  expect(scoreFilterSnapshot(run, players, knownEdges, new Set(), new Map(), 0).get(ids[1])).toBe(15);
  const unavailable = new Map(groups);
  unavailable.set(ids[1], groupSnapshot({ playerId: ids[1], status: "error" }));
  expect(scoreFilterSnapshot(run, players, knownEdges, new Set(), unavailable, 0).get(ids[1])).toBe(15);
});

it("keeps score zero known and missing local tags a definite nonmatch", () => {
  const sources = emptySources();
  sources.scores.set(ids[0], 0);
  const result = filterGraph(run, nodes.slice(0, 3), [], request({ minScore: 0, unknown: "include", tag: "exact" }, { tagPlayerIds: [ids[0], ids[2]] }), sources, "test");
  expect(result.rows.map((row) => [row.player.id, row.status])).toEqual([[ids[0], "match"], [ids[2], "unknown"]]);
  expect(result.excluded).toBe(1);
});

it("intersects focus with full-run communities and ignores root display depth", () => {
  const full = graphResponse(run, nodes, edges, nodes.length, 3);
  const result = filterGraph(run, nodes, edges, request({}, { focus: { playerId: ids[4], hops: 1 } }), emptySources(), "test");
  expect(result.rows.map((row) => row.player.id).sort()).toEqual([ids[3], ids[4]]);
  expect(result.graph.stats).toEqual(full.stats);
  expect(result.graph.focus).toEqual({ playerId: ids[4], hops: 1, totalNodes: 2 });
  for (const row of result.rows) expect(row.player).toEqual(full.nodes.find((node) => node.id === row.player.id));
  expect(() => filterGraph(run, nodes, edges, request({}, { focus: { playerId: ids[125], hops: 1 } }), emptySources(), "test")).toThrow();
});

it("paginates the entire matching list independently of the graph cap", () => {
  const first = filterGraph(run, nodes, edges, request(), emptySources(), "test");
  const last = filterGraph(run, nodes, edges, request({}, { page: 999 }), emptySources(), "test");
  expect(first).toMatchObject({ total: 125, matched: 125, unknown: 0, excluded: 0, page: 0, pages: 5, pageSize: 30 });
  expect(first.rows).toHaveLength(30);
  expect(first.graph.nodes).toHaveLength(100);
  expect(last).toMatchObject({ page: 4, pages: 5 });
  expect(last.rows).toHaveLength(5);
  expect(last.graph).toEqual(first.graph);
  const displayed = new Set(first.graph.nodes.map((node) => node.id));
  expect(first.graph.edges.every((edge) => displayed.has(edge.source) && displayed.has(edge.target))).toBe(true);
  expect(last.rows.some((row) => !displayed.has(row.player.id))).toBe(true);
});

it("shows a selected matching player beyond the graph cap without changing list membership", () => {
  const first = filterGraph(run, nodes, edges, request(), emptySources(), "test");
  const selected = filterGraph(run, nodes, edges, request({}, { selectedId: ids[124] }), emptySources(), "test");
  expect(selected.rows).toEqual(first.rows);
  expect(selected).toMatchObject({ total: 125, matched: 125, scopeTotal: 125 });
  expect(selected.graph.nodes).toHaveLength(100);
  expect(selected.graph.nodes.some((node) => node.id === ids[124])).toBe(true);
  const nonmatch = filterGraph(run, nodes, edges, request({ tag: "one" }, { tagPlayerIds: [ids[0]], selectedId: ids[124] }), emptySources(), "test");
  expect(nonmatch.graph.nodes.map((node) => node.id)).toEqual([ids[0]]);
});

const runId = randomUUID(), outsideRunId = randomUUID(), otherModeRunId = randomUUID();
const runIds = [runId, outsideRunId, otherModeRunId];
const gameJob = randomUUID(), oldGameJob = randomUUID(), wrongModeGameJob = randomUUID();
const groupJob = randomUUID(), oldGroupJob = randomUUID(), wrongModeGroupJob = randomUUID();
const otherMode = config.mode === "live" ? "demo" : "live";
const app = Fastify({ bodyLimit: 8192 });
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof HttpError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
registerGraphFilterRoutes(app);
app.post("/small-body", async () => ({ ok: true }));
const endpoint = (id: string = runId) => `/api/runs/${id}/filter`;

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query("INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,'Filter fixture','https://steamcommunity.com/profiles/'||id FROM unnest($2::text[]) p(id)", [config.mode, ids]);
  for (const [id, mode] of [[runId, config.mode], [outsideRunId, config.mode], [otherModeRunId, otherMode]]) await pool.query("INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status,request_count) VALUES($1,$2,$3,3,1000,20,'completed',7)", [id, ids[0], mode]);
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) SELECT $1,id,LEAST(ord::int-1,3) FROM unnest($2::text[]) WITH ORDINALITY p(id,ord)", [runId, ids.slice(0, 125)]);
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0)", [outsideRunId, ids[125]]);
  for (const edge of edges) await pool.query("INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3)", [runId, edge.source, edge.target]);
  for (const [table, old, latest, wrong] of [["game_score_jobs", oldGameJob, gameJob, wrongModeGameJob], ["group_collection_jobs", oldGroupJob, groupJob, wrongModeGroupJob]]) {
    for (const [id, mode, age] of [[old, config.mode, 3], [latest, config.mode, 2], [wrong, otherMode, 1]]) await pool.query(`INSERT INTO ${table}(id,run_id,mode,root_id,status,max_requests,created_at) VALUES($1,$2,$3,$4,'completed',20,now()-$5::int*interval '1 hour')`, [id, runId, mode, ids[0], age]);
  }
  for (const jobId of [oldGameJob, wrongModeGameJob]) await pool.query("INSERT INTO game_score_players(job_id,player_id,name,profile_url,processed,status,games) VALUES($1,$2,'Old','',true,'ok',$3)", [jobId, ids[3], JSON.stringify([{ appId: "999", name: "Old or wrong mode", minutes: 1 }])]);
  for (const jobId of [oldGroupJob, wrongModeGroupJob]) await pool.query("INSERT INTO group_collection_players(job_id,player_id,depth,processed,status,groups,total_count,complete) VALUES($1,$2,3,true,'ok',$3,1,true)", [jobId, ids[3], JSON.stringify([{ ...group, id: "103582791475937112", name: "Old or wrong mode" }])]);
  for (const [index, status, games] of [[0, "ok", [{ appId: "570", name: "Dota", minutes: 0 }]], [1, "ok", []], [2, "error", [{ appId: "570", name: "Stale", minutes: 0 }]]] as const) {
    await pool.query("INSERT INTO game_score_players(job_id,player_id,is_root,name,profile_url,processed,status,games) VALUES($1,$2,$3,'Filter','',true,$4,$5)", [gameJob, ids[index], index === 0, status, JSON.stringify(games)]);
    await pool.query("INSERT INTO group_collection_players(job_id,player_id,is_root,depth,processed,status,groups,total_count,complete) VALUES($1,$2,$3,$4,true,$5,$6,$7,$8)", [groupJob, ids[index], index === 0, index, status, JSON.stringify(index === 1 ? [] : [group]), index === 1 ? 0 : 1, status === "ok"]);
  }
  await pool.query("INSERT INTO game_profiles(mode,player_id,status,games) VALUES($1,$2,'ok',$3)", [config.mode, ids[3], JSON.stringify([{ appId: "570", name: "Global only", minutes: 0 }])]);
  await pool.query("INSERT INTO group_profiles(mode,player_id,status,groups,total_count,complete) VALUES($1,$2,'ok',$3,1,true)", [config.mode, ids[3], JSON.stringify([group])]);
});

afterAll(async () => {
  await app.close();
  if (process.env.RUN_DATABASE_TESTS === "true") {
    await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [runIds]);
    for (const table of ["players", "game_profiles", "group_profiles"]) await pool.query(`DELETE FROM ${table} WHERE mode=$1 AND ${table === "players" ? "id" : "player_id"}=ANY($2::text[])`, [config.mode, ids]);
  }
  await pool.end();
});

databaseIt("uses only available samples from the latest same-mode pinned jobs for facets and filtering", async () => {
  const options = await app.inject(`${endpoint()}-options`);
  expect(options.statusCode).toBe(200);
  expect(options.json()).toMatchObject({ games: [{ id: "570", name: "Dota", count: 1 }], groups: [{ id: group.id, name: group.name, count: 1 }], gamePlayers: 2, groupPlayers: 2, totalPlayers: 125 });
  const filtered = await app.inject({ method: "POST", url: endpoint(), payload: request({ gameAppId: "570", groupId: group.id, unknown: "include" }) });
  expect(filtered.statusCode).toBe(200);
  expect(filtered.json()).toMatchObject({ matched: 1, unknown: 123, excluded: 1, total: 124 });
  expect(filtered.json<GraphFilterResponse>().rows[0]).toMatchObject({ player: { id: ids[0] }, status: "match" });
  expect(filtered.json<GraphFilterResponse>().rows.find((row) => row.player.id === ids[3])?.status).toBe("unknown");
});

databaseIt("retains existing root-relative scores and performs no collection or writes", async () => {
  const before = (await pool.query("SELECT row_to_json(r) state FROM crawl_runs r WHERE id=ANY($1::uuid[])", [runIds])).rows;
  const jobsBefore = (await pool.query("SELECT (SELECT count(*) FROM game_score_jobs WHERE run_id=$1) games,(SELECT count(*) FROM group_collection_jobs WHERE run_id=$1) groups", [runId])).rows;
  const scores = await getRelationshipScores(runId);
  const response = await app.inject({ method: "POST", url: endpoint(), payload: request({ minScore: 0, unknown: "include" }) });
  expect(response.statusCode).toBe(200);
  const body = response.json<GraphFilterResponse>();
  for (const row of body.rows) expect(row.score).toBe(scores.rows.find((score) => score.player.id === row.player.id)?.score ?? null);
  expect(body.rows.find((row) => row.player.id === ids[0])?.status).toBe("unknown");
  expect((await pool.query("SELECT row_to_json(r) state FROM crawl_runs r WHERE id=ANY($1::uuid[])", [runIds])).rows).toEqual(before);
  expect((await pool.query("SELECT (SELECT count(*) FROM game_score_jobs WHERE run_id=$1) games,(SELECT count(*) FROM group_collection_jobs WHERE run_id=$1) groups", [runId])).rows).toEqual(jobsBefore);
});

databaseIt("preserves full communities, graph caps, list pages and focused run membership", async () => {
  const currentRun = await getRun(runId), data = await getGraphData(runId);
  const full = graphResponse(currentRun, data.nodes, data.edges, 1000, 3);
  const first = (await app.inject({ method: "POST", url: endpoint(), payload: request() })).json<GraphFilterResponse>();
  const last = (await app.inject({ method: "POST", url: endpoint(), payload: request({}, { page: 4 }) })).json<GraphFilterResponse>();
  expect(first.graph.stats).toEqual(full.stats);
  expect(first.graph.nodes).toHaveLength(100);
  expect(last).toMatchObject({ total: 125, pages: 5, page: 4 });
  expect(last.rows).toHaveLength(5);
  expect(last.graph).toEqual(first.graph);
  const focused = (await app.inject({ method: "POST", url: endpoint(), payload: request({}, { focus: { playerId: ids[4], hops: 1 } }) })).json<GraphFilterResponse>();
  expect(focused.scopeTotal).toBe(2);
  expect(focused.rows.map((row) => row.player.id).sort()).toEqual([ids[3], ids[4]]);
  const community = full.nodes.find((node) => node.id === ids[124])!.community;
  const selected = (await app.inject({ method: "POST", url: endpoint(), payload: request({ community }) })).json<GraphFilterResponse>();
  expect(selected.rows.map((row) => row.player.id)).toEqual(full.nodes.filter((node) => node.community === community).map((node) => node.id));
});

databaseIt("rejects foreign tagged or focused players, invalid IDs and other-mode runs", async () => {
  for (const patch of [{ tagPlayerIds: [ids[0], ids[125]] }, { focus: { playerId: ids[125], hops: 1 as const } }, { selectedId: ids[125] }]) {
    expect((await app.inject({ method: "POST", url: endpoint(), payload: request({}, patch) })).statusCode).toBe(400);
  }
  for (const id of ["bad", randomUUID(), otherModeRunId]) {
    expect((await app.inject(`${endpoint(id)}-options`)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: endpoint(id), payload: request() })).statusCode).toBe(404);
  }
  const tagged = (await app.inject({ method: "POST", url: endpoint(), payload: request({ tag: "exact", unknown: "include" }, { tagPlayerIds: [ids[124]] }) })).json<GraphFilterResponse>();
  expect(tagged.rows.map((row) => row.player.id)).toEqual([ids[124]]);
  const uncollected = await app.inject(`${endpoint(outsideRunId)}-options`);
  expect(uncollected.statusCode).toBe(200);
  expect(uncollected.json()).toMatchObject({ games: [], groups: [], gamePlayers: 0, groupPlayers: 0, totalPlayers: 1 });
});

databaseIt("allows bounded tag payloads above the default body size only on the filter endpoint", async () => {
  const payload = request({ tag: "all" }, { tagPlayerIds: Array(1000).fill(ids[0]) });
  expect((await app.inject({ method: "POST", url: endpoint(), payload })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/small-body", payload })).statusCode).toBe(413);
  expect((await app.inject({ method: "POST", url: endpoint(), payload: { ...request(), huge: "x".repeat(65536) } })).statusCode).toBe(413);
});
