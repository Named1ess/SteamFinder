import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import {
  playerSearchQuerySchema,
  searchRunPlayers,
} from "../src/player-search.js";

const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
const runId = randomUUID();
const outsideRunId = randomUUID();
const otherModeRunId = randomUUID();
const otherMode = config.mode === "demo" ? "live" : "demo";
const ids = Array.from({ length: 601 }, (_, i) =>
  String(76561200100012000n + BigInt(i)),
);
const names = ids.map((_, i) => `Fixture ${String(i).padStart(3, "0")}`);
names[10] = names[11] = "Duplicate";
names[20] = "AlphaBeta";
names[21] = "alpha";
names[30] = "春日玩家";
names[40] = "100% real";
names[41] = "under_score";
names[550] = "Beyond canvas limit";
function search(query: Record<string, unknown> = {}, id = runId) {
  return searchRunPlayers(id, playerSearchQuerySchema.parse(query));
}

beforeAll(async () => {
  if (process.env.RUN_DATABASE_TESTS !== "true") return;
  await pool.query(
    "INSERT INTO players(mode,id,name,profile_url) SELECT $1,id,name,'https://steamcommunity.com/profiles/'||id FROM unnest($2::text[],$3::text[]) AS p(id,name)",
    [config.mode, ids, names],
  );
  for (const [id, root, mode] of [
    [runId, ids[0], config.mode],
    [outsideRunId, ids[600], config.mode],
    [otherModeRunId, ids[550], otherMode],
  ]) {
    await pool.query(
      "INSERT INTO crawl_runs(id,root_id,mode,depth,max_nodes,max_requests,status,request_count) VALUES($1,$2,$3,3,1000,20,'completed',7)",
      [id, root, mode],
    );
  }
  await pool.query(
    "INSERT INTO run_nodes(run_id,player_id,depth) SELECT $1,id,CASE WHEN ord=1 THEN 0 WHEN ord<=501 THEN 1 ELSE 3 END FROM unnest($2::text[]) WITH ORDINALITY AS p(id,ord)",
    [runId, ids.slice(0, 600)],
  );
  await pool.query(
    "INSERT INTO run_nodes(run_id,player_id,depth) VALUES($1,$2,0),($3,$4,0)",
    [outsideRunId, ids[600], otherModeRunId, ids[550]],
  );
  await pool.query(
    "INSERT INTO players(mode,id,name,profile_url) VALUES($1,$2,'Other mode secret','https://steamcommunity.com/profiles/'||$2)",
    [otherMode, ids[550]],
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

it("bounds and normalizes search inputs and rejects malformed player identifiers", () => {
  expect(playerSearchQuerySchema.parse({ q: "  春日  " })).toMatchObject({
    q: "春日",
    limit: 30,
  });
  expect(playerSearchQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  for (const input of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { q: "x".repeat(201) },
    { selectedId: "123" },
    { excludeId: "99999999999999999" },
  ]) {
    expect(playerSearchQuerySchema.safeParse(input).success).toBe(false);
  }
});

databaseIt(
  "searches all collected depths beyond 500 canvas nodes with a bounded response",
  async () => {
    const initial = await search();
    expect(initial.total).toBe(600);
    expect(initial.players).toHaveLength(30);
    expect(initial.selected).toBeNull();
    const found = await search({ q: "beyond" });
    expect(found.total).toBe(1);
    expect(found.players[0]).toMatchObject({
      id: ids[550],
      name: "Beyond canvas limit",
      depth: 3,
    });
    expect(
      (await search({ q: ids[550].slice(-7) })).players.map((p) => p.id),
    ).toEqual([ids[550]]);
  },
);

databaseIt(
  "matches case-insensitive and Chinese names, keeps duplicate IDs distinct and treats wildcards literally",
  async () => {
    expect((await search({ q: "ALPHA" })).players.map((p) => p.id)).toEqual([
      ids[21],
      ids[20],
    ]);
    expect((await search({ q: "duplicate" })).players.map((p) => p.id)).toEqual(
      [ids[10], ids[11]],
    );
    expect((await search({ q: "春日" })).players.map((p) => p.id)).toEqual([
      ids[30],
    ]);
    expect((await search({ q: "%" })).players.map((p) => p.id)).toEqual([
      ids[40],
    ]);
    expect((await search({ q: "_" })).players.map((p) => p.id)).toEqual([
      ids[41],
    ]);
    expect((await search({ q: "' OR 1=1 --" })).total).toBe(0);
  },
);

databaseIt(
  "counts before limiting and resolves selected IDs independently of the search query",
  async () => {
    const result = await search({
      q: "duplicate",
      limit: 1,
      selectedId: ids[550],
    });
    expect(result.total).toBe(2);
    expect(result.players.map((p) => p.id)).toEqual([ids[10]]);
    expect(result.selected?.id).toBe(ids[550]);
    const excluded = await search({
      q: "duplicate",
      excludeId: ids[10],
      selectedId: ids[10],
    });
    expect(excluded.total).toBe(1);
    expect(excluded.players.map((p) => p.id)).toEqual([ids[11]]);
    expect(excluded.selected).toBeNull();
    expect(
      (await search({ q: "no match", selectedId: ids[550] })).selected?.id,
    ).toBe(ids[550]);
    expect((await search({ selectedId: ids[600] })).selected).toBeNull();
  },
);

databaseIt(
  "isolates other runs and modes without changing request or collection state",
  async () => {
    const before = await pool.query(
      "SELECT request_count,cache_hits,updated_at,(SELECT count(*) FROM run_nodes WHERE run_id=$1) nodes FROM crawl_runs WHERE id=$1",
      [runId],
    );
    expect((await search({ q: ids[600] })).total).toBe(0);
    expect((await search({ q: "Other mode" })).total).toBe(0);
    await expect(search({}, otherModeRunId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(search({}, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
    const after = await pool.query(
      "SELECT request_count,cache_hits,updated_at,(SELECT count(*) FROM run_nodes WHERE run_id=$1) nodes FROM crawl_runs WHERE id=$1",
      [runId],
    );
    expect(after.rows).toEqual(before.rows);
  },
);
