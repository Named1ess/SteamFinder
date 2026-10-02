import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { GraphViewState, SavedGraphView, SavedGraphViewSummary } from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { validSteamId } from "./identity.js";
import { getRun, HttpError } from "./repository.js";

const playerId = z.string().refine(validSteamId);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const positionId = z.string().refine((value) => (
  /^community:(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value.slice(10)))
) || validSteamId(value));
export const graphViewStateSchema = z.object({
  version: z.literal(1),
  layout: z.enum(["radial", "circular", "grid"]),
  displayDepth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  displayLimit: z.union([z.literal(100), z.literal(250), z.literal(500), z.literal(1000)]),
  selectedId: playerId.nullable(),
  search: z.string().max(200).optional(),
  focus: z.object({ playerId, hops: z.union([z.literal(1), z.literal(2)]) }).strict().nullable(),
  collapsedCommunities: z.array(z.number().int().nonnegative()).max(10000),
  positions: z.record(positionId, point).refine((positions) => Object.keys(positions).length <= 10000),
  viewport: z.object({ zoom: z.number().finite().positive().max(100), center: point }).strict().nullable(),
  annotations: z.record(playerId, z.object({
    note: z.string().max(500), tags: z.array(z.string().trim().min(1).max(24)).max(5),
  }).strict()).refine((annotations) => Object.keys(annotations).length <= 1000),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();
export const savedViewInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  state: graphViewStateSchema,
}).strict();

function idsFrom(request: { params: unknown }): { runId: string; viewId?: string } {
  const { id, viewId } = request.params as { id: string; viewId?: string };
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "找不到该查询");
  if (viewId !== undefined && !z.uuid().safeParse(viewId).success) throw new HttpError(404, "找不到该视图");
  return { runId: id, viewId };
}
function summary(row: pg.QueryResultRow): SavedGraphViewSummary {
  return { id: row.id, runId: row.run_id, name: row.name, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function view(row: pg.QueryResultRow): SavedGraphView {
  return { ...summary(row), state: row.state as GraphViewState };
}
async function verifyMembership(client: pg.PoolClient, runId: string, state: GraphViewState) {
  const ids = new Set([
    ...Object.keys(state.positions).filter(validSteamId),
    ...Object.keys(state.annotations),
    ...(state.selectedId ? [state.selectedId] : []),
    ...(state.focus ? [state.focus.playerId] : []),
  ]);
  if (!ids.size) return;
  const members = await client.query<{ player_id: string }>(
    "SELECT player_id FROM run_nodes WHERE run_id=$1 AND player_id=ANY($2::text[])", [runId, [...ids]],
  );
  if (members.rows.length !== ids.size) throw new HttpError(400, "视图中包含不属于该查询的玩家");
}
async function save(runId: string, body: unknown, viewId?: string): Promise<SavedGraphView> {
  await getRun(runId);
  const input = savedViewInputSchema.safeParse(body);
  if (!input.success) throw new HttpError(400, "视图名称或状态无效");
  return transaction(async (client) => {
    // Serialize per-run saves so concurrent requests cannot exceed the cap.
    const locked = await client.query("SELECT id FROM crawl_runs WHERE id=$1 AND mode=$2 FOR UPDATE", [runId, config.mode]);
    if (!locked.rows.length) throw new HttpError(404, "找不到该查询");
    if (viewId) {
      const existing = await client.query("SELECT id FROM saved_graph_views WHERE run_id=$1 AND id=$2", [runId, viewId]);
      if (!existing.rows.length) throw new HttpError(404, "找不到该视图");
    } else {
      const count = await client.query<{ total: number }>("SELECT count(*)::int total FROM saved_graph_views WHERE run_id=$1", [runId]);
      if (count.rows[0].total >= 20) throw new HttpError(409, "每个查询最多保存 20 个视图，请覆盖或删除已有视图");
    }
    await verifyMembership(client, runId, input.data.state);
    const result = viewId
      ? await client.query("UPDATE saved_graph_views SET name=$3,state=$4::jsonb,updated_at=now() WHERE run_id=$1 AND id=$2 RETURNING *", [runId, viewId, input.data.name, JSON.stringify(input.data.state)])
      : await client.query("INSERT INTO saved_graph_views(id,run_id,name,state) VALUES($1,$2,$3,$4::jsonb) RETURNING *", [randomUUID(), runId, input.data.name, JSON.stringify(input.data.state)]);
    if (!result.rows.length) throw new HttpError(404, "找不到该视图");
    return view(result.rows[0]);
  });
}

export function registerSavedViewRoutes(app: FastifyInstance) {
  app.get("/api/runs/:id/views", async (request) => {
    const { runId } = idsFrom(request);
    await getRun(runId);
    const result = await pool.query("SELECT id,run_id,name,created_at,updated_at FROM saved_graph_views WHERE run_id=$1 ORDER BY updated_at DESC,id", [runId]);
    return { views: result.rows.map(summary) };
  });
  app.get("/api/runs/:id/views/:viewId", async (request) => {
    const { runId, viewId } = idsFrom(request);
    await getRun(runId);
    const result = await pool.query("SELECT * FROM saved_graph_views WHERE run_id=$1 AND id=$2", [runId, viewId]);
    if (!result.rows.length) throw new HttpError(404, "找不到该视图");
    return view(result.rows[0]);
  });
  app.post("/api/runs/:id/views", { bodyLimit: 1024 * 1024 }, async (request) => {
    const { runId } = idsFrom(request);
    return save(runId, request.body);
  });
  app.put("/api/runs/:id/views/:viewId", { bodyLimit: 1024 * 1024 }, async (request) => {
    const { runId, viewId } = idsFrom(request);
    return save(runId, request.body, viewId);
  });
  app.delete("/api/runs/:id/views/:viewId", async (request) => {
    const { runId, viewId } = idsFrom(request);
    await getRun(runId);
    const result = await pool.query("DELETE FROM saved_graph_views WHERE run_id=$1 AND id=$2 RETURNING id", [runId, viewId]);
    if (!result.rows.length) throw new HttpError(404, "找不到该视图");
    return { ok: true };
  });
}
