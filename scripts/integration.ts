import assert from "node:assert/strict";
import type {
  AnalysisResult,
  AppConfig,
  CrawlRun,
  CreateRunResult,
  GraphResponse,
  PlayerSearchResponse,
} from "../packages/shared/src/index.ts";

const base = process.env.TEST_BASE_URL ?? "http://localhost:8080";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${await response.clone().text()}`,
  );
  return response.json() as Promise<T>;
}
async function terminal(id: string): Promise<CrawlRun> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await request<CrawlRun>(`/runs/${id}`);
    if (!["queued", "running"].includes(run.status)) return run;
    await delay(600);
  }
  throw new Error(`Run ${id} did not settle within 60 seconds`);
}
async function main() {
  const config = await request<AppConfig>("/config");
  assert.equal(
    config.mode,
    "demo",
    "Integration suite must use demo mode; never spend real Steam quota",
  );
  const input = {
    input: config.defaultRoot,
    depth: 2,
    maxNodes: 1000,
    maxRequests: 500,
  };
  const created = await request<CreateRunResult>("/runs", input);
  const run = await terminal(created.run.id);
  assert.equal(run.status, "completed", JSON.stringify(run));
  const graph = await request<GraphResponse>(
    `/runs/${run.id}/graph?limit=1000`,
  );
  assert.ok(graph.nodes.length > 15, "Demo needs a useful overlapping network");
  assert.ok(
    graph.edges.length > graph.nodes.length,
    "Demo must contain cycles",
  );
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, graph.nodes.length);
  assert.ok(graph.nodes.every((n) => typeof n.id === "string" && n.depth <= 2));
  assert.ok(
    graph.nodes.some((n) => n.fetchStatus === "private"),
    "Private != zero friends",
  );
  // A deeper historical query may already have populated this boundary's lists.
  assert.ok(
    graph.nodes.some((n) => n.depth === run.depth),
    "Depth boundary must remain explicit even when globally cached",
  );
  const direct = graph.nodes.filter((n) => n.depth === 1);
  assert.ok(direct.length >= 2);
  const [a, b] = direct;
  const mutual = await request<AnalysisResult>(
    `/runs/${run.id}/analysis?kind=mutual&from=${a.id}&to=${b.id}`,
  );
  assert.ok(
    mutual.nodeIds.includes(config.defaultRoot),
    "Direct friends share root",
  );
  const path = await request<AnalysisResult>(
    `/runs/${run.id}/analysis?kind=path&from=${a.id}&to=${b.id}`,
  );
  assert.equal(path.path[0], a.id);
  assert.equal(path.path.at(-1), b.id);
  const tiny = await request<GraphResponse>(`/runs/${run.id}/graph?limit=5`);
  assert.equal(tiny.nodes.length, 5);
  assert.equal(tiny.truncated, true);
  const visibleIds = new Set(tiny.nodes.map((n) => n.id));
  assert.ok(
    tiny.edges.every(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    ),
  );
  const outside = graph.nodes.find((node) => !visibleIds.has(node.id))!;
  const allPlayers = await request<PlayerSearchResponse>(
    `/runs/${run.id}/players?limit=3`,
  );
  assert.equal(allPlayers.total, graph.totalNodes);
  assert.equal(allPlayers.players.length, 3);
  const found = await request<PlayerSearchResponse>(
    `/runs/${run.id}/players?q=${outside.id}&selectedId=${outside.id}`,
  );
  assert.equal(found.players[0].id, outside.id);
  assert.equal(found.selected?.id, outside.id);
  const excluded = await request<PlayerSearchResponse>(
    `/runs/${run.id}/players?q=${outside.id}&excludeId=${outside.id}`,
  );
  assert.equal(excluded.total, 0);
  const outsidePath = await request<AnalysisResult>(
    `/runs/${run.id}/analysis?kind=path&from=${run.rootId}&to=${outside.id}`,
  );
  assert.equal(outsidePath.path.at(-1), outside.id);
  console.log(
    "PASS: searchable analysis players cover the entire saved run beyond the display cap",
  );
  const reused = await request<CreateRunResult>("/runs", input);
  assert.equal(reused.cached, true);
  assert.equal(reused.run.id, run.id);
  await request(`/runs/${run.id}/graph`);
  const unchanged = await request<CrawlRun>(`/runs/${run.id}`);
  assert.equal(
    unchanged.requestCount,
    run.requestCount,
    "Reopening must never call Steam",
  );
  console.log(
    "PASS: persisted cyclic graph, private/frontier status, common friends, path, display cap, cache-only reopen",
  );

  const capped = await request<CreateRunResult>("/runs", {
    ...input,
    maxNodes: 8,
    refresh: true,
  });
  const limited = await terminal(capped.run.id);
  assert.equal(limited.status, "limited");
  assert.ok(limited.nodeCount <= 8, "Node cap must be exact");
  await request(`/runs/${limited.id}/resume`, {
    maxNodes: 1000,
    maxRequests: 500,
  });
  const resumed = await terminal(limited.id);
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.equal(
    resumed.nodeCount,
    graph.totalNodes,
    "Resuming mid-neighbor list must recover omitted neighbors",
  );
  console.log(
    "PASS: exact node limit, durable resume and complete frontier recovery",
  );

  const requestCapped = await request<CreateRunResult>("/runs", {
    ...input,
    maxRequests: 1,
    refresh: true,
  });
  const requestLimited = await terminal(requestCapped.run.id);
  assert.equal(requestLimited.status, "limited");
  assert.ok(
    requestLimited.requestCount <= 1,
    "All outbound calls share exact request budget",
  );
  await request(`/runs/${requestLimited.id}/resume`, { maxRequests: 500 });
  assert.equal((await terminal(requestLimited.id)).status, "completed");
  console.log("PASS: outbound request budget and resume");

  const cancellable = await request<CreateRunResult>("/runs", {
    ...input,
    depth: 3,
    refresh: true,
  });
  const cancelled = await request<CrawlRun>(
    `/runs/${cancellable.run.id}/cancel`,
    {},
  );
  assert.equal(cancelled.status, "cancelled");
  const settledCancel = await terminal(cancelled.id);
  await delay(1000);
  const stillCancelled = await request<CrawlRun>(`/runs/${cancelled.id}`);
  assert.equal(stillCancelled.status, "cancelled");
  assert.ok(
    stillCancelled.requestCount <= settledCancel.requestCount + 1,
    "Only an already in-flight call may settle after cancel",
  );
  await request(`/runs/${cancelled.id}/resume`, {});
  assert.equal((await terminal(cancelled.id)).status, "completed");
  console.log("PASS: cancel is durable, stopped tasks resume");

  const invalid = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      input: "https://example.com/profiles/76561199521553744/",
    }),
  });
  assert.equal(invalid.status, 400);
  const excessive = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, depth: 99 }),
  });
  assert.equal(excessive.status, 400);
  console.log("PASS: unsupported domains and excessive depth rejected");
  console.log(`Integration complete. Persisted demo run: ${run.id}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
