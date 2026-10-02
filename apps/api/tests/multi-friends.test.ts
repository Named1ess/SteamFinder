import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { CrawlRun, GraphEdge, GraphNode, MultiFriendRequest, MultiFriendResponse } from "../../../packages/shared/src/index.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { graphResponse } from "../src/graph.js";
import { HttpError } from "../src/repository.js";
import { analyzeMultiFriends, multiFriendQuerySchema, registerMultiFriendRoutes } from "../src/multi-friends.js";

const now = Date.parse("2026-10-03T12:00:00.000Z");
const ids = Array.from({ length: 1100 }, (_, i) => String(76561200100120000n + BigInt(i)));
const selected = ids.slice(0, 3);
const runId = randomUUID(), outsideRunId = randomUUID(), otherModeRunId = randomUUID();
const run = { id: runId } as CrawlRun;
const otherMode = config.mode === "demo" ? "live" : "demo";
const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
function node(id: string, patch: Partial<GraphNode> = {}): GraphNode {
  return { id, name: id, avatar: null, profileUrl: `https://steamcommunity.com/profiles/${id}`, depth: 3,
    fetchStatus: "ok", fetchedAt: new Date(now - 1000).toISOString(), friendCount: 3, degree: 0, community: 0, ...patch };
}
const nodes = ids.slice(0, 8).map(id => node(id));
const edge = (source: string, target: string): GraphEdge => ({ id: `${source}:${target}`, source, target });
const pairs = [[0, 1], [1, 2], [0, 3], [1, 3], [2, 3], [0, 4], [1, 4], [1, 5], [2, 5], [0, 6], [4, 5]];
const edges = pairs.map(([a, b]) => edge(ids[a], ids[b]));
const snapshot = { nodes, edges, fullyRepresented: new Set(selected) };
const request: MultiFriendRequest = { playerIds: selected, minConnections: 2, page: 0 };
const app = Fastify();
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof HttpError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
registerMultiFriendRoutes(app);
function endpoint(query: Record<string, string> = {}, id: string = runId) {
  return `/api/runs/${id}/multi-friends?${new URLSearchParams({ players: selected.join(","), minConnections: "2", ...query })}`;
}

it("requires three to ten distinct valid IDs and a bounded threshold and page", () => {
  expect(multiFriendQuerySchema.parse({ players: selected.join(","), minConnections: "2" })).toEqual(request);
  expect(multiFriendQuerySchema.parse({ players: ids.slice(0, 10).join(","), minConnections: "10", page: "100000" })).toMatchObject({ minConnections: 10, page: 100000 });
  for (const patch of [
    { players: ids.slice(0, 2).join(",") }, { players: ids.slice(0, 11).join(",") },
    { players: [ids[0], ids[1], ids[1]].join(",") }, { players: [ids[0], ids[1], "99999999999999999"].join(",") },
    { players: [ids[0], ids[1], "abc"].join(",") }, { players: selected },
    { minConnections: "0" }, { minConnections: "4" }, { minConnections: "1.5" }, { minConnections: "Infinity" },
    { page: "-1" }, { page: "0.5" }, { page: "NaN" }, { page: "100001" },
  ]) expect(multiFriendQuerySchema.safeParse({ players: selected.join(","), minConnections: "2", ...patch }).success).toBe(false);
});

it("counts distinct undirected selected connections and excludes selected players and self edges", () => {
  const dirty = [...edges, edge(ids[3], ids[0]), edge(ids[0], ids[3]), edge(ids[0], ids[0]), edge(ids[3], ids[3]), edge(ids[0], ids[100])];
  const result = analyzeMultiFriends(run, { ...snapshot, edges: dirty }, { ...request, playerIds: [...selected].reverse() }, now);
  expect(result.rows.map(row => ({ id: row.player.id, count: row.count, matchedIds: row.matchedIds }))).toEqual([
    { id: ids[3], count: 3, matchedIds: selected },
    { id: ids[4], count: 2, matchedIds: [ids[0], ids[1]] },
    { id: ids[5], count: 2, matchedIds: [ids[1], ids[2]] },
  ]);
  expect(result.total).toBe(3);
  expect(new Set(result.nodes.map(player => player.id))).toEqual(new Set(ids.slice(0, 6)));
  expect(result.edges).toHaveLength(7);
  expect(result.edges.every(item => selected.includes(item.source) !== selected.includes(item.target))).toBe(true);
  expect(new Set(result.edges.map(item => [item.source, item.target].sort().join(":"))).size).toBe(7);
});

it("uses the threshold without treating missing known connections as positive matches", () => {
  expect(analyzeMultiFriends(run, snapshot, { ...request, minConnections: 3 }, now).rows.map(row => row.player.id)).toEqual([ids[3]]);
  expect(analyzeMultiFriends(run, snapshot, { ...request, minConnections: 1 }, now).rows.map(row => row.player.id)).toEqual(ids.slice(3, 7));
  const empty = analyzeMultiFriends(run, { ...snapshot, edges: [edge(ids[0], ids[6])] }, { ...request, page: 900 }, now);
  expect(empty).toMatchObject({ total: 0, pages: 1, page: 0, rows: [], edges: [] });
  expect(new Set(empty.nodes.map(player => player.id))).toEqual(new Set(selected));
});

it("paginates the entire graph beyond 1000 nodes and draws only the requested page", () => {
  const largeNodes = ids.slice(0, 1043).map(id => node(id));
  const largeEdges = ids.slice(3, 1043).flatMap(id => selected.map(source => edge(source, id)));
  const largeSnapshot = { nodes: largeNodes, edges: largeEdges, fullyRepresented: new Set(selected) };
  const first = analyzeMultiFriends(run, largeSnapshot, { ...request, minConnections: 3 }, now);
  expect(first).toMatchObject({ total: 1040, page: 0, pages: 35, pageSize: 30 });
  expect(first.rows).toHaveLength(30);
  expect(first.rows[0].player.id).toBe(ids[3]);
  expect(first.rows[29].player.id).toBe(ids[32]);
  const last = analyzeMultiFriends(run, largeSnapshot, { ...request, page: 100000 }, now);
  expect(last).toMatchObject({ total: 1040, page: 34, pages: 35, pageSize: 30 });
  expect(last.rows).toHaveLength(20);
  expect(last.rows[0].player.id).toBe(ids[1023]);
  expect(last.rows[19].player.id).toBe(ids[1042]);
  expect(last.nodes).toHaveLength(23);
  expect(last.edges).toHaveLength(60);
  expect(last.nodes.some(player => player.id === ids[3])).toBe(false);
});

it("preserves full-run community labels and degrees rather than recomputing the result subgraph", () => {
  const full = graphResponse(run, nodes, edges, nodes.length, 3);
  const result = analyzeMultiFriends(run, snapshot, request, now);
  for (const player of result.nodes) expect(player).toEqual(full.nodes.find(item => item.id === player.id));
  expect(result.nodes.find(player => player.id === ids[0])?.degree).toBe(4);
  expect(result.edges.filter(item => item.source === ids[0] || item.target === ids[0])).toHaveLength(2);
});

it("reports completeness only for fresh successful fully represented selected snapshots", () => {
  expect(analyzeMultiFriends(run, snapshot, request, now).complete).toBe(true);
  for (const patch of [
    { fetchStatus: "private" as const }, { fetchStatus: "error" as const }, { fetchStatus: "unknown" as const },
    { fetchedAt: null }, { fetchedAt: "invalid" },
    { fetchedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() },
    { fetchedAt: new Date(now + 1000).toISOString() },
  ]) {
    const partial = { ...snapshot, nodes: nodes.map(player => player.id === ids[2] ? { ...player, ...patch } : player) };
    const result = analyzeMultiFriends(run, partial, request, now);
    expect(result.complete).toBe(false);
    expect(result.rows[0]).toMatchObject({ count: 3, matchedIds: selected });
  }
  expect(analyzeMultiFriends(run, { ...snapshot, fullyRepresented: new Set(ids.slice(0, 2)) }, request, now).complete).toBe(false);
  const privateCandidate = { ...snapshot, nodes: nodes.map(player => player.id === ids[3] ? { ...player, fetchStatus: "private" as const } : player) };
  expect(analyzeMultiFriends(run, privateCandidate, request, now).complete).toBe(true);
});

it("rejects analysis players that are absent from this graph", () => {
  expect(() => analyzeMultiFriends(run, snapshot, { ...request, playerIds: [ids[0], ids[1], ids[10]] }, now)).toThrow(HttpError);
});

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query("INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,'Multi fixture '||id,'https://steamcommunity.com/profiles/'||id FROM unnest($2::text[]) p(id)", [config.mode, ids.slice(0, 11)]);
  await pool.query("INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,'Other mode secret','https://steamcommunity.com/profiles/'||id FROM unnest($2::text[]) p(id)", [otherMode, ids.slice(0, 8)]);
  for (const [id, root, mode] of [[runId, ids[0], config.mode], [outsideRunId, ids[10], config.mode], [otherModeRunId, ids[0], otherMode]]) {
    await pool.query("INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status,request_count) VALUES($1,$2,$3,3,1000,20,'completed',7)", [id, root, mode]);
  }
  for (const id of [runId, otherModeRunId]) {
    await pool.query("INSERT INTO run_nodes(run_id,player_id,depth,fetch_status,fetched_at,friend_count) SELECT $1,id,3,'ok',now(),3 FROM unnest($2::text[]) p(id)", [id, ids.slice(0, 8)]);
  }
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0)", [outsideRunId, ids[10]]);
  for (const [a, b] of pairs) {
    await pool.query("INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3)", [runId, ids[a], ids[b]]);
    await pool.query("INSERT INTO run_friend_observations(run_id,owner_id,friend_id) VALUES($1,$2,$3)", [runId, ids[a], ids[b]]);
  }
  await pool.query("INSERT INTO run_edges(run_id,source,target) VALUES($1,$2,$3)", [otherModeRunId, ids[0], ids[7]]);
  await pool.query("INSERT INTO friend_lists(mode,owner_id,status,friend_count) SELECT $1,id,'private',0 FROM unnest($2::text[]) p(id)", [config.mode, selected]);
  await pool.query("INSERT INTO friendship_edges(mode,source,target) VALUES($1,$2,$3)", [config.mode, ids[0], ids[7]]);
});

afterAll(async () => {
  await app.close();
  if (process.env.RUN_DATABASE_TESTS === "true") {
    await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [[runId, outsideRunId, otherModeRunId]]);
    await pool.query("DELETE FROM friendship_edges WHERE mode=$1 AND source=$2 AND target=$3", [config.mode, ids[0], ids[7]]);
    await pool.query("DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])", [config.mode, selected]);
    await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids.slice(0, 11)]);
    await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [otherMode, ids.slice(0, 8)]);
  }
  await pool.end();
});

databaseIt("uses only the pinned run graph and snapshots without modifying collection state", async () => {
  const readState = async () => (await pool.query(`SELECT row_to_json(r) run,
    (SELECT jsonb_agg(n ORDER BY player_id) FROM run_nodes n WHERE n.run_id=$1) nodes,
    (SELECT jsonb_agg(e ORDER BY source,target) FROM run_edges e WHERE e.run_id=$1) edges,
    (SELECT jsonb_agg(o ORDER BY owner_id,friend_id) FROM run_friend_observations o WHERE o.run_id=$1) observations
    FROM crawl_runs r WHERE id=$1`, [runId])).rows;
  const before = await readState();
  const response = await app.inject(endpoint());
  expect(response.statusCode).toBe(200);
  const result = response.json<MultiFriendResponse>();
  expect(result).toMatchObject({ runId, playerIds: selected, total: 3, complete: true });
  expect(result.rows.map(row => row.player.id)).toEqual(ids.slice(3, 6));
  expect(result.rows.every(row => row.player.name.startsWith("Multi fixture "))).toBe(true);
  expect((await app.inject(endpoint({ minConnections: "1" }))).json<MultiFriendResponse>().rows.map(row => row.player.id)).toEqual(ids.slice(3, 7));
  expect(await readState()).toEqual(before);
});

databaseIt("marks omitted or unavailable selected lists incomplete while retaining known positive results", async () => {
  await pool.query("INSERT INTO run_friend_observations(run_id,owner_id,friend_id) VALUES($1,$2,$3)", [runId, ids[2], ids[10]]);
  try {
    const partial = (await app.inject(endpoint())).json<MultiFriendResponse>();
    expect(partial.complete).toBe(false);
    expect(partial.rows[0]).toMatchObject({ count: 3, matchedIds: selected });
  } finally {
    await pool.query("DELETE FROM run_friend_observations WHERE run_id=$1 AND owner_id=$2 AND friend_id=$3", [runId, ids[2], ids[10]]);
  }
  await pool.query("UPDATE run_nodes SET fetch_status='unknown' WHERE run_id=$1 AND player_id=$2", [runId, ids[2]]);
  try {
    const partial = (await app.inject(endpoint({ minConnections: "3" }))).json<MultiFriendResponse>();
    expect(partial.complete).toBe(false);
    expect(partial.rows.map(row => row.player.id)).toEqual([ids[3]]);
  } finally {
    await pool.query("UPDATE run_nodes SET fetch_status='ok' WHERE run_id=$1 AND player_id=$2", [runId, ids[2]]);
  }
});

databaseIt("enforces HTTP bounds, exact run membership and mode isolation", async () => {
  const invalidQueries: Record<string, string>[] = [
    { players: ids.slice(0, 2).join(",") }, { players: [ids[0], ids[1], ids[1]].join(",") },
    { players: [ids[0], ids[1], ids[10]].join(",") }, { minConnections: "4" }, { page: "100001" },
  ];
  for (const patch of invalidQueries) expect((await app.inject(endpoint(patch))).statusCode).toBe(400);
  expect((await app.inject(endpoint({}, otherModeRunId))).statusCode).toBe(404);
  expect((await app.inject(endpoint({}, randomUUID()))).statusCode).toBe(404);
  expect((await app.inject(endpoint({}, "not-a-uuid"))).statusCode).toBe(404);
});
