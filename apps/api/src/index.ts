import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { DemoProvider, PublicWebProvider, SteamError } from "./provider.js";
import { BudgetError } from "./requests.js";
import {
  getRun,
  listRuns,
  getGraphData,
  HttpError,
} from "./repository.js";
import { graphResponse, analyze } from "./graph.js";
import { boss, startQueue, enqueue, enqueueGameScores } from "./queue.js";
import { createSearch } from "./search.js";
import { getGameScores, startGameScoreJob } from "./game-scores.js";
import { collectPlayerDetails, getPlayerDetails } from "./player-details.js";
import { playerSearchQuerySchema, searchRunPlayers } from "./player-search.js";
import { getRelationshipScores, relationshipScoresQuerySchema } from "./relationship-scores.js";
const app = Fastify({ logger: false, bodyLimit: 8192 });
const provider =
  config.mode === "demo" ? new DemoProvider() : new PublicWebProvider();
const createSchema = z
  .object({
    input: z.string().min(1).max(300),
    depth: z.number().int().min(1).max(3),
    maxNodes: z.number().int().min(1).max(10000),
    maxRequests: z.number().int().min(1).max(10000),
    refresh: z.boolean().optional(),
  })
  .strict();
const resumeSchema = z
  .object({
    maxNodes: z.number().int().min(1).max(10000).optional(),
    maxRequests: z.number().int().min(1).max(10000).optional(),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, "参数无效，请检查查询深度和预算");
  return result.data;
}
function idFrom(request: { params: unknown }): string {
  const id = (request.params as { id: string }).id;
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "找不到该查询");
  return id;
}
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError)
    return reply.code(error.statusCode).send({ message: error.message });
  if (error instanceof BudgetError)
    return reply.code(429).send({ message: error.message });
  if (error instanceof SteamError)
    return reply
      .code(error.kind === "invalid" ? 400 : 502)
      .send({ message: error.message });
  return reply
    .code((error as { statusCode?: number }).statusCode === 400 ? 400 : 500)
    .send({ message: "服务暂时无法完成请求" });
});
app.get("/api/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true, mode: config.mode };
});
app.get("/api/config", async () => ({
  mode: config.mode,
  maxDepth: 3,
  maxNodes: 10000,
  defaultRoot: config.defaultRoot,
  requestDelayMs: config.delay,
}));
app.get("/api/runs", async () => ({ runs: await listRuns() }));
app.get("/api/players/:id/details", async (request) => getPlayerDetails((request.params as { id: string }).id));
app.post("/api/players/:id/details", async (request) => {
  const options = parse(z.object({ refresh: z.boolean().optional() }).strict(), request.body ?? {});
  return collectPlayerDetails((request.params as { id: string }).id, options, provider);
});
app.post("/api/runs", async (request) => {
  const input = parse(createSchema, request.body);
  const result = await createSearch(input, provider);
  if (!result.cached) await enqueue(result.run.id);
  return result;
});
app.get("/api/runs/:id", async (request) => getRun(idFrom(request)));
app.get("/api/runs/:id/players", async (request) =>
  searchRunPlayers(idFrom(request), parse(playerSearchQuerySchema, request.query)),
);
app.get("/api/runs/:id/game-scores", async (request) => getGameScores(idFrom(request)));
app.get("/api/runs/:id/relationship-scores", async (request) =>
  getRelationshipScores(idFrom(request), parse(relationshipScoresQuerySchema, request.query).center),
);
app.post("/api/runs/:id/game-scores", async (request) => {
  const id = idFrom(request);
  const options = parse(
    z.object({
      refresh: z.boolean().optional(),
      maxRequests: z.number().int().min(1).max(10000).default(2000),
    }).strict(),
    request.body ?? {},
  );
  const submission = await startGameScoreJob(id, options);
  if (submission.enqueue) await enqueueGameScores(submission.jobId);
  return getGameScores(id);
});
app.get("/api/runs/:id/graph", async (request) => {
  const id = idFrom(request);
  const query = parse(
    z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(500),
      depth: z.coerce.number().int().min(0).max(3).default(3),
    }),
    request.query,
  );
  const run = await getRun(id),
    data = await getGraphData(id);
  return graphResponse(run, data.nodes, data.edges, query.limit, query.depth);
});
app.get("/api/runs/:id/analysis", async (request) => {
  const id = idFrom(request);
  const query = parse(
    z.object({
      kind: z.enum(["mutual", "path"]),
      from: z.string().min(1),
      to: z.string().min(1),
    }),
    request.query,
  );
  const data = await getGraphData(id);
  if (
    !data.nodes.some((n) => n.id === query.from) ||
    !data.nodes.some((n) => n.id === query.to)
  )
    throw new HttpError(400, "分析节点不属于该查询");
  return analyze(
    query.kind,
    query.from,
    query.to,
    data.nodes,
    data.edges,
    data.fullyRepresented,
  );
});
app.post("/api/runs/:id/cancel", async (request) => {
  const id = idFrom(request);
  await getRun(id);
  const result = await pool.query(
    `UPDATE crawl_runs SET status='cancelled',message='查询已取消，可继续',updated_at=now(),completed_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id`,
    [id],
  );
  if (!result.rows.length)
    throw new HttpError(409, "只能取消等待或采集中的查询");
  return getRun(id);
});
app.post("/api/runs/:id/resume", async (request) => {
  const id = idFrom(request),
    old = await getRun(id),
    input = parse(resumeSchema, request.body ?? {});
  const maxNodes = input.maxNodes ?? old.maxNodes,
    maxRequests = input.maxRequests ?? old.maxRequests;
  if (maxNodes < old.nodeCount || maxRequests < old.requestCount)
    throw new HttpError(400, "新预算不能少于已采集节点和已使用请求数");
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE crawl_runs SET status='queued',max_nodes=$2,max_requests=$3,message=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('cancelled','limited','failed') RETURNING id`,
      [id, maxNodes, maxRequests],
    );
    if (!updated.rows.length) throw new HttpError(409, "该查询状态不支持继续");
    await client.query(
      `UPDATE run_nodes SET expanded=false,observed=false WHERE run_id=$1 AND fetch_status='error' AND depth<$2`,
      [id, old.depth],
    );
  });
  await enqueue(id);
  return getRun(id);
});
app.get("/api/runs/:id/events", async (request, reply) => {
  const id = idFrom(request);
  const initial = await getRun(id);
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false,
    pending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const send = (run: Awaited<ReturnType<typeof getRun>>) => {
    if (closed) return;
    reply.raw.write(`event: progress\ndata: ${JSON.stringify(run)}\n\n`);
    if (!["queued", "running"].includes(run.status)) {
      if (timer) clearInterval(timer);
      closed = true;
      reply.raw.end();
    }
  };
  send(initial);
  if (!closed)
    timer = setInterval(async () => {
      if (pending || closed) return;
      pending = true;
      try {
        send(await getRun(id));
      } catch {
        if (timer) clearInterval(timer);
        closed = true;
        reply.raw.end();
      } finally {
        pending = false;
      }
    }, 700);
  reply.raw.on("close", () => {
    closed = true;
    if (timer) clearInterval(timer);
  });
});
await startQueue();
await app.listen({ port: config.port, host: "0.0.0.0" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
