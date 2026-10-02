import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { HttpError } from "../src/repository.js";
import { registerSavedViewRoutes, savedViewInputSchema } from "../src/saved-views.js";
import { graphQuerySchema } from "../src/graph.js";
import type { GraphViewState, SavedGraphView } from "../../../packages/shared/src/index.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const runId = randomUUID(), outsideRunId = randomUUID(), otherModeRunId = randomUUID(), cappedRunId = randomUUID();
const runIds = [runId, outsideRunId, otherModeRunId, cappedRunId];
const ids = Array.from({ length: 4 }, (_, i) => String(76561200100080000n + BigInt(i)));
const otherMode = config.mode === "demo" ? "live" : "demo";
function state(patch: Partial<GraphViewState> = {}): GraphViewState {
  return {
    version: 1, layout: "radial", displayDepth: 2, displayLimit: 500,
    selectedId: ids[0], search: "好友", focus: { playerId: ids[1], hops: 2 }, collapsedCommunities: [0, 2],
    positions: { [ids[0]]: { x: 12, y: -8 }, "community:2": { x: 30, y: 20 } },
    viewport: { zoom: 1.5, center: { x: 14, y: 11 } },
    annotations: { [ids[1]]: { note: "一个备注", tags: ["朋友", "游戏"] } },
    sourceUpdatedAt: "2026-10-03T00:00:00.000Z", ...patch,
  };
}
const app = Fastify({ bodyLimit: 8192 });
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof HttpError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500).send({ message: (error as Error).message }));
registerSavedViewRoutes(app);
app.post("/small-body", async () => ({ ok: true }));
const endpoint = (id: string = runId, viewId?: string) => `/api/runs/${id}/views${viewId ? `/${viewId}` : ""}`;

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query("INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,'Saved view fixture','https://steamcommunity.com/profiles/'||id FROM unnest($2::text[]) p(id)", [config.mode, ids]);
  for (const [id, root, mode] of [[runId, ids[0], config.mode], [outsideRunId, ids[2], config.mode], [otherModeRunId, ids[3], otherMode], [cappedRunId, ids[0], config.mode]]) {
    await pool.query("INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status,request_count) VALUES($1,$2,$3,3,100,20,'completed',7)", [id, root, mode]);
  }
  for (const id of [runId, cappedRunId]) await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0),($1,$3,1)", [id, ids[0], ids[1]]);
  await pool.query("INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0),($3,$4,0)", [outsideRunId, ids[2], otherModeRunId, ids[3]]);
});
afterAll(async () => {
  await app.close();
  if (process.env.RUN_DATABASE_TESTS === "true") {
    await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [runIds]);
    await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [config.mode, ids]);
  }
  await pool.end();
});

it("accepts complete restore state and normalizes named views", () => {
  expect(savedViewInputSchema.parse({ name: "  My graph  ", state: state() })).toEqual({ name: "My graph", state: state() });
  expect(savedViewInputSchema.safeParse({ name: "", state: state() }).success).toBe(false);
  expect(savedViewInputSchema.safeParse({ name: " ", state: state() }).success).toBe(false);
  expect(savedViewInputSchema.safeParse({ name: "x".repeat(61), state: state() }).success).toBe(false);
});

it("preserves optional combined filters while accepting old saved states", () => {
  const filters = { minScore: 15, community: null, gameAppId: "570", groupId: "", fetchStatus: "all" as const, tag: "朋友", unknown: "include" as const };
  expect(savedViewInputSchema.parse({ name: "Filtered", state: state({ filters }) }).state.filters).toEqual(filters);
  expect(savedViewInputSchema.parse({ name: "Legacy", state: state() }).state).not.toHaveProperty("filters");
  for (const patch of [{ minScore: -1 }, { community: -1 }, { gameAppId: "bad" }, { groupId: ids[0] }, { tag: "x".repeat(25) }, { unknown: "all" }]) {
    expect(savedViewInputSchema.safeParse({ name: "Invalid", state: state({ filters: { ...filters, ...patch } as typeof filters }) }).success).toBe(false);
  }
});

it("rejects malformed restore state and out-of-bound graph coordinates", () => {
  const invalid: Partial<GraphViewState>[] = [
    { version: 2 as 1 }, { layout: "force" as "grid" }, { displayDepth: 4 }, { displayLimit: 501 },
    { selectedId: "community:1" }, { selectedId: "99999999999999999" }, { search: "x".repeat(201) },
    { focus: { playerId: ids[0], hops: 3 as 1 } },
    { collapsedCommunities: [-1] }, { collapsedCommunities: [0.2] },
    { positions: { fake: { x: 1, y: 1 } } }, { positions: { "community:-1": { x: 1, y: 1 } } },
    { positions: { [ids[0]]: { x: Infinity, y: 0 } } }, { positions: { [ids[0]]: { x: 1e7 + 1, y: 0 } } },
    { viewport: { zoom: 0, center: { x: 0, y: 0 } } }, { viewport: { zoom: 101, center: { x: 0, y: 0 } } },
    { viewport: { zoom: 1, center: { x: NaN, y: 0 } } },
    { annotations: { fake: { note: "", tags: [] } } },
    { annotations: { [ids[0]]: { note: "x".repeat(501), tags: [] } } },
    { annotations: { [ids[0]]: { note: "", tags: ["x".repeat(25)] } } },
    { annotations: { [ids[0]]: { note: "", tags: Array(6).fill("a") } } },
    { sourceUpdatedAt: "not a date" }, { collapsedCommunities: Array(10001).fill(0) },
    { positions: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`community:${i}`, { x: 0, y: 0 }])) },
    { annotations: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(76561200100080000n + BigInt(i)), { note: "", tags: [] }])) },
  ];
  for (const patch of invalid) expect(savedViewInputSchema.safeParse({ name: "Invalid", state: state(patch) }).success).toBe(false);
});

it("validates focus query pairs and limits without changing ordinary graph defaults", () => {
  expect(graphQuerySchema.parse({})).toEqual({ limit: 500, depth: 3 });
  expect(graphQuerySchema.parse({ focusCenter: ids[0], focusHops: "2" })).toMatchObject({ focusCenter: ids[0], focusHops: 2 });
  for (const input of [{ focusCenter: ids[0] }, { focusHops: 1 }, { focusCenter: "bad", focusHops: 1 }, { focusCenter: ids[0], focusHops: 3 }]) expect(graphQuerySchema.safeParse(input).success).toBe(false);
});

databaseIt("creates, lists, reloads, overwrites and deletes named views without changing collection state", async () => {
  const before = (await pool.query("SELECT request_count,cache_hits,updated_at FROM crawl_runs WHERE id=$1", [runId])).rows;
  const create = await app.inject({ method: "POST", url: endpoint(), payload: { name: "  First  ", state: state() } });
  expect(create.statusCode).toBe(200);
  const saved = create.json<SavedGraphView>();
  expect(saved).toMatchObject({ name: "First", runId, state: state() });
  expect(saved.createdAt).toMatch(/Z$/);
  expect(saved.updatedAt).toMatch(/Z$/);
  expect((await app.inject(endpoint())).json().views).toEqual([{ id: saved.id, runId, name: "First", createdAt: saved.createdAt, updatedAt: saved.updatedAt }]);
  expect((await app.inject(endpoint(runId, saved.id))).json()).toEqual(saved);
  const next = state({ layout: "grid", selectedId: null, focus: null, viewport: null, filters: { minScore: 0, community: null, gameAppId: "570", groupId: "", fetchStatus: "all", tag: "朋友", unknown: "include" } });
  const updated = await app.inject({ method: "PUT", url: endpoint(runId, saved.id), payload: { name: "Revised", state: next } });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ id: saved.id, name: "Revised", state: next, createdAt: saved.createdAt });
  expect((await app.inject(endpoint(runId, saved.id))).json().state).toEqual(next);
  expect((await app.inject({ method: "DELETE", url: endpoint(runId, saved.id) })).json()).toEqual({ ok: true });
  expect((await app.inject(endpoint(runId, saved.id))).statusCode).toBe(404);
  expect((await pool.query("SELECT request_count,cache_hits,updated_at FROM crawl_runs WHERE id=$1", [runId])).rows).toEqual(before);
});

databaseIt("rejects cross-run state references, malformed IDs and other-mode access", async () => {
  for (const patch of [{ focus: { playerId: ids[2], hops: 1 as const } }, { selectedId: ids[2] }, { positions: { [ids[2]]: { x: 0, y: 0 } } }, { annotations: { [ids[2]]: { note: "outside", tags: [] } } }]) {
    expect((await app.inject({ method: "POST", url: endpoint(), payload: { name: "Outside", state: state(patch) } })).statusCode).toBe(400);
  }
  expect((await app.inject(endpoint("not-a-uuid"))).statusCode).toBe(404);
  expect((await app.inject(endpoint(runId, "not-a-uuid"))).statusCode).toBe(404);
  expect((await app.inject(endpoint(otherModeRunId))).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: endpoint(otherModeRunId), payload: { name: "Other", state: state() } })).statusCode).toBe(404);
  const saved = (await app.inject({ method: "POST", url: endpoint(), payload: { name: "Private to run", state: state() } })).json<SavedGraphView>();
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    expect((await app.inject({ method, url: endpoint(outsideRunId, saved.id), ...(method === "PUT" ? { payload: { name: "Wrong run", state: state({ selectedId: ids[2], focus: null, positions: {}, annotations: {} }) } } : {}) })).statusCode).toBe(404);
  }
  expect((await app.inject(endpoint(runId, saved.id))).json().name).toBe("Private to run");
  await app.inject({ method: "DELETE", url: endpoint(runId, saved.id) });
});

databaseIt("enforces the twenty-view cap under concurrent writes while allowing overwrite and replacement", async () => {
  const attempts = await Promise.all(Array.from({ length: 24 }, (_, i) => app.inject({ method: "POST", url: endpoint(cappedRunId), payload: { name: `View ${i}`, state: state() } })));
  expect(attempts.filter((response) => response.statusCode === 200)).toHaveLength(20);
  expect(attempts.filter((response) => response.statusCode === 409)).toHaveLength(4);
  const saved = attempts.find((response) => response.statusCode === 200)!.json<SavedGraphView>();
  expect((await app.inject(endpoint(cappedRunId))).json().views).toHaveLength(20);
  expect((await app.inject({ method: "PUT", url: endpoint(cappedRunId, saved.id), payload: { name: "Overwrite at cap", state: state() } })).statusCode).toBe(200);
  await app.inject({ method: "DELETE", url: endpoint(cappedRunId, saved.id) });
  expect((await app.inject({ method: "POST", url: endpoint(cappedRunId), payload: { name: "Replacement", state: state() } })).statusCode).toBe(200);
});

databaseIt("scopes the larger payload limit to saved-view writes and cascades view deletion with the run", async () => {
  const positions = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`community:${i}`, { x: i, y: -i }]));
  const payload = { name: "Big layout", state: state({ positions }) };
  const saved = await app.inject({ method: "POST", url: endpoint(), payload });
  expect(saved.statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/small-body", payload })).statusCode).toBe(413);
  expect((await app.inject({ method: "POST", url: endpoint(), payload: { name: "Huge", state: state(), extra: "x".repeat(1024 * 1024) } })).statusCode).toBe(413);
  await pool.query("DELETE FROM crawl_runs WHERE id=$1", [runId]);
  expect((await pool.query("SELECT id FROM saved_graph_views WHERE run_id=$1", [runId])).rows).toHaveLength(0);
});
