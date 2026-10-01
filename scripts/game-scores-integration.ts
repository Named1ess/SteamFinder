import assert from "node:assert/strict";
import type {
  AppConfig,
  CreateRunResult,
  CrawlRun,
  GameScoresResponse,
  GraphResponse,
  PlayerDetailsSnapshot,
} from "../packages/shared/src/index.ts";

const base = process.env.TEST_BASE_URL ?? "http://localhost:8080";
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
const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
async function settle<T>(
  load: () => Promise<T>,
  status: (value: T) => string,
): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await load();
    if (!["running", "queued"].includes(status(value))) return value;
    await pause();
  }
  throw new Error("Background job did not finish within 60 seconds");
}
const config = await request<AppConfig>("/config");
assert.equal(
  config.mode,
  "demo",
  "Game score integration must not request real Steam data",
);
const created = await request<CreateRunResult>("/runs", {
  input: config.defaultRoot,
  depth: 2,
  maxNodes: 1000,
  maxRequests: 500,
});
const run = await settle(
  () => request<CrawlRun>(`/runs/${created.run.id}`),
  (r) => r.status,
);
assert.equal(run.status, "completed");
const path = `/runs/${run.id}/game-scores`;
const graph = await request<GraphResponse>(`/runs/${run.id}/graph?limit=1000`);
await request<GameScoresResponse>(path, { refresh: true, maxRequests: 1 });
const limited = await settle(
  () => request<GameScoresResponse>(path),
  (r) => r.job!.status,
);
assert.equal(limited.job!.status, "limited");
assert.equal(limited.job!.requestCount, 1);
assert.equal(limited.job!.processedPlayers, 1);
await request<GameScoresResponse>(path, { maxRequests: 50 });
const complete = await settle(
  () => request<GameScoresResponse>(path),
  (r) => r.job!.status,
);
assert.equal(complete.job!.id, limited.job!.id);
assert.equal(complete.job!.status, "completed");
assert.equal(complete.scope, "profile_recent");
assert.equal(complete.formulaVersion, "public-games-location-v2");
assert.ok(complete.rows.some((r) => r.result.locationWeight === 5));
assert.ok(complete.rows.some((r) => r.result.locationSimilarity === 50));
const direct = graph.nodes
  .filter((n) => n.depth === 1)
  .map((n) => n.id)
  .sort();
assert.deepEqual(complete.rows.map((r) => r.player.id).sort(), direct);
assert.equal(complete.job!.processedPlayers, direct.length + 1);
assert.equal(complete.job!.requestCount, direct.length + 1);
assert.ok(complete.rows.some((r) => r.result.score === 100));
assert.ok(
  complete.rows.some(
    (r) => r.snapshot.status === "private" && r.result.score === null,
  ),
);
assert.ok(
  complete.rows.some(
    (r) =>
      r.snapshot.games.some((g) => g.minutes === null) &&
      r.result.score === null,
  ),
);
assert.ok(
  complete.rows.every(
    (r) =>
      r.result.score === null || (r.result.score >= 0 && r.result.score <= 100),
  ),
);
const before = complete.job!.requestCount;
const readAgain = await request<GameScoresResponse>(path);
const cached = await request<GameScoresResponse>(path, {});
assert.equal(readAgain.job!.requestCount, before);
assert.equal(cached.job!.id, complete.job!.id);
assert.equal(cached.job!.requestCount, before);
assert.deepEqual(
  cached.rows.map((r) => [r.player.id, r.result.score]),
  complete.rows.map((r) => [r.player.id, r.result.score]),
);
console.log(
  "PASS: direct friends only, exact game request budget, durable resume, visible-sample scores, unavailable/hidden times, cache-only reopening",
);
const detailsPath = `/players/${run.rootId}/details`;
const fromGames = await request<PlayerDetailsSnapshot>(detailsPath);
assert.deepEqual(fromGames.profile, complete.root!.profile);
const details = await request<PlayerDetailsSnapshot>(detailsPath, {
  refresh: true,
});
assert.equal(details.profileStatus, "ok");
assert.equal(details.aliasesStatus, "ok");
assert.ok(details.aliases.length >= 1);
assert.deepEqual(await request<PlayerDetailsSnapshot>(detailsPath), details);
assert.deepEqual(
  await request<PlayerDetailsSnapshot>(detailsPath, {}),
  details,
);
assert.deepEqual((await request<GameScoresResponse>(path)).root, complete.root);
console.log(
  "PASS: hover profile and alias HTTP cache, shared game header, immutable score location snapshots",
);
console.log(`Game scores verified for run: ${run.id}`);
