import { afterAll, expect, it } from "vitest";
import { pool } from "../src/db.js";
import { config } from "../src/config.js";
import { createRun, getRun, saveList, failList } from "../src/repository.js";
import { crawl } from "../src/crawler.js";
import {
  DemoProvider,
  demoIds,
  SteamError,
  type Provider,
} from "../src/provider.js";
import { steamRequest, BudgetError } from "../src/requests.js";
import { createSearch } from "../src/search.js";
const databaseIt = process.env.RUN_DATABASE_TESTS === "true" ? it : it.skip;
afterAll(async () => {
  await pool.end();
});

databaseIt(
  "reuses persisted vanity resolutions without requests and explicitly re-resolves on refresh",
  async () => {
    const root = "76561200100004000";
    const replacement = "76561200100004001";
    const vanity = "steamfinder_vanity_regression";
    const runs: string[] = [];
    const otherMode = config.mode === "demo" ? "live" : "demo";
    let calls = 0;
    const provider: Provider = {
      vanity: async () => {
        calls++;
        return calls === 1 ? root : replacement;
      },
      summaries: async () => [],
      friends: async () => [],
    };
    const input = {
      input: `https://steamcommunity.com/id/${vanity}/`,
      depth: 1,
      maxNodes: 10,
      maxRequests: 5,
    };
    try {
      await pool.query(
        "INSERT INTO vanity_resolutions(mode,vanity,player_id) VALUES($1,$2,$3) ON CONFLICT(mode,vanity) DO UPDATE SET player_id=EXCLUDED.player_id",
        [otherMode, vanity, replacement],
      );
      const first = await createSearch(input, provider);
      runs.push(first.run.id);
      expect(first.run).toMatchObject({ rootId: root, requestCount: 1 });
      await pool.query(
        "UPDATE crawl_runs SET status='completed',completed_at=now() WHERE id=$1",
        [first.run.id],
      );
      const duplicate = await createSearch(input, provider);
      runs.push(duplicate.run.id);
      expect(duplicate.cached).toBe(true);
      expect(duplicate.run.id).toBe(first.run.id);
      expect(duplicate.run.requestCount).toBe(1);
      expect(calls).toBe(1);
      const refreshed = await createSearch({ ...input, refresh: true }, provider);
      runs.push(refreshed.run.id);
      expect(refreshed.cached).toBe(false);
      expect(refreshed.run).toMatchObject({ rootId: replacement, requestCount: 1 });
      expect(calls).toBe(2);
    } finally {
      await pool.query("DELETE FROM vanity_resolutions WHERE vanity=$1", [vanity]);
      await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [runs]);
      await pool.query("DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])", [
        config.mode,
        [root, replacement],
      ]);
    }
  },
);

databaseIt(
  "keeps supported friendships when an owner becomes private and deletes only unsupported provenance",
  async () => {
    const a = "76561199000000101",
      b = "76561199000000102",
      c = "76561199000000103";
    try {
      await saveList(a, [b, c]);
      await saveList(b, [a]);
      await failList(a, "private");
      const preserved = await pool.query(
        "SELECT friend_count,status,fetched_at FROM friend_lists WHERE mode=$1 AND owner_id=$2",
        [config.mode, a],
      );
      expect(preserved.rows[0]).toMatchObject({
        friend_count: 2,
        status: "private",
      });
      expect(preserved.rows[0].fetched_at).toBeInstanceOf(Date);
      await saveList(a, []);
      const remaining = await pool.query(
        "SELECT source,target FROM friendship_edges WHERE mode=$1 AND source=$2 ORDER BY target",
        [config.mode, a],
      );
      expect(remaining.rows).toEqual([{ source: a, target: b }]);
    } finally {
      await pool.query(
        "DELETE FROM friend_observations WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, [a, b, c]],
      );
      await pool.query(
        "DELETE FROM friendship_edges WHERE mode=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))",
        [config.mode, [a, b, c]],
      );
      await pool.query(
        "DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, [a, b, c]],
      );
    }
  },
);
databaseIt(
  "resumes a capped root expansion without losing omitted cached neighbors and bounds outbound attempts",
  async () => {
    const created = await createRun(demoIds[0], {
      input: demoIds[0],
      depth: 2,
      maxNodes: 8,
      maxRequests: 500,
      refresh: true,
    });
    try {
      await crawl(created.run.id, new DemoProvider());
      const capped = await getRun(created.run.id);
      expect(capped.status).toBe("limited");
      expect(capped.nodeCount).toBe(8);
      await pool.query(
        "UPDATE crawl_runs SET status='queued',max_nodes=1000 WHERE id=$1",
        [capped.id],
      );
      await crawl(capped.id, new DemoProvider());
      const resumed = await getRun(capped.id);
      expect(resumed.status).toBe("completed");
      expect(resumed.nodeCount).toBe(60);
      expect(resumed.privateCount).toBe(1);
      const count = await pool.query(
        "SELECT depth,count(*)::int count FROM run_nodes WHERE run_id=$1 GROUP BY depth ORDER BY depth",
        [capped.id],
      );
      expect(count.rows).toEqual([
        { depth: 0, count: 1 },
        { depth: 1, count: 12 },
        { depth: 2, count: 47 },
      ]);
      const requests = resumed.requestCount;
      await crawl(capped.id, new DemoProvider());
      expect((await getRun(capped.id)).requestCount).toBe(requests);
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=$1", [created.run.id]);
    }
    const tiny = await createRun(demoIds[0], {
      input: demoIds[0],
      depth: 2,
      maxNodes: 100,
      maxRequests: 1,
      refresh: true,
    });
    try {
      await crawl(tiny.run.id, new DemoProvider());
      expect(await getRun(tiny.run.id)).toMatchObject({
        status: "limited",
        requestCount: 1,
      });
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=$1", [tiny.run.id]);
    }
  },
);
databaseIt(
  "collects 500 direct friends in bounded summary batches without expanding the depth frontier",
  async () => {
    const ids = Array.from({ length: 501 }, (_, i) =>
      String(76561200100000000n + BigInt(i)),
    );
    const batches: number[] = [],
      friendCalls: string[] = [];
    const provider: Provider = {
      vanity: async () => ids[0],
      summaries: async (batch) => {
        batches.push(batch.length);
        return batch.map((id) => ({
          id,
          name: "Synthetic test player",
          avatar: null,
          profileUrl: `https://steamcommunity.com/profiles/${id}`,
        }));
      },
      friends: async (id) => {
        friendCalls.push(id);
        return id === ids[0] ? ids.slice(1) : [];
      },
    };
    const created = await createRun(ids[0], {
      input: ids[0],
      depth: 1,
      maxNodes: 1000,
      maxRequests: 100,
      refresh: true,
    });
    try {
      await crawl(created.run.id, provider);
      const run = await getRun(created.run.id);
      expect(run).toMatchObject({
        status: "completed",
        nodeCount: 501,
        edgeCount: 500,
        requestCount: 7,
      });
      expect(batches).toEqual([1, 100, 100, 100, 100, 100]);
      expect(friendCalls).toEqual([ids[0]]);
      const result = await pool.query(
        "SELECT count(DISTINCT player_id)::int count,max(depth)::int depth FROM run_nodes WHERE run_id=$1",
        [run.id],
      );
      expect(result.rows[0]).toEqual({ count: 501, depth: 1 });
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=$1", [created.run.id]);
      await pool.query(
        "DELETE FROM friend_observations WHERE mode=$1 AND owner_id=$2",
        [config.mode, ids[0]],
      );
      await pool.query(
        "DELETE FROM friendship_edges WHERE mode=$1 AND (source=$2 OR target=$2)",
        [config.mode, ids[0]],
      );
      await pool.query(
        "DELETE FROM friend_lists WHERE mode=$1 AND owner_id=$2",
        [config.mode, ids[0]],
      );
      await pool.query(
        "DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])",
        [config.mode, ids],
      );
    }
  },
);
databaseIt(
  "removes obsolete canonical edges from a refreshed run while preserving completed historical snapshots",
  async () => {
    const ids = ["76561200100001000", "76561200100001001", "76561200100001002"];
    const provider: Provider = {
      vanity: async () => ids[0],
      summaries: async (batch) =>
        batch.map((id) => ({
          id,
          name: "Refresh regression fixture",
          avatar: null,
          profileUrl: `https://steamcommunity.com/profiles/${id}`,
        })),
      friends: async (id) => (id === ids[0] ? ids.slice(1) : [ids[0]]),
    };
    const runs: string[] = [];
    try {
      await saveList(ids[0], ids.slice(1));
      await saveList(ids[1], [ids[0], ids[2]]);
      await saveList(ids[2], [ids[0], ids[1]]);
      const old = await createRun(ids[0], {
        input: ids[0],
        depth: 2,
        maxNodes: 100,
        maxRequests: 100,
      });
      runs.push(old.run.id);
      await crawl(old.run.id, provider);
      expect((await getRun(old.run.id)).edgeCount).toBe(3);
      const fresh = await createRun(ids[0], {
        input: ids[0],
        depth: 2,
        maxNodes: 100,
        maxRequests: 100,
        refresh: true,
      });
      runs.push(fresh.run.id);
      await crawl(fresh.run.id, provider);
      expect(await getRun(fresh.run.id)).toMatchObject({
        status: "completed",
        edgeCount: 2,
      });
      expect((await getRun(old.run.id)).edgeCount).toBe(3);
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [
        runs,
      ]);
      await pool.query(
        "DELETE FROM friend_observations WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM friendship_edges WHERE mode=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])",
        [config.mode, ids],
      );
    }
  },
);
databaseIt(
  "resumes the original owner snapshot after another run refreshes the shared cache",
  async () => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      String(76561200100002000n + BigInt(i)),
    );
    const build = (neighbors: string[]): Provider => ({
      vanity: async () => ids[0],
      summaries: async (batch) =>
        batch.map((id) => ({
          id,
          name: "Snapshot fixture",
          avatar: null,
          profileUrl: `https://steamcommunity.com/profiles/${id}`,
        })),
      friends: async (id) => (id === ids[0] ? neighbors : []),
    });
    const runs: string[] = [];
    try {
      const original = await createRun(ids[0], {
        input: ids[0],
        depth: 1,
        maxNodes: 2,
        maxRequests: 100,
        refresh: true,
      });
      runs.push(original.run.id);
      await crawl(original.run.id, build(ids.slice(1, 4)));
      expect(await getRun(original.run.id)).toMatchObject({
        status: "limited",
        nodeCount: 2,
      });
      const refresh = await createRun(ids[0], {
        input: ids[0],
        depth: 1,
        maxNodes: 100,
        maxRequests: 100,
        refresh: true,
      });
      runs.push(refresh.run.id);
      await crawl(refresh.run.id, build(ids.slice(4)));
      await pool.query(
        "UPDATE crawl_runs SET status='queued',max_nodes=100 WHERE id=$1",
        [original.run.id],
      );
      await crawl(original.run.id, build(ids.slice(4)));
      const result = await pool.query(
        "SELECT player_id FROM run_nodes WHERE run_id=$1 ORDER BY player_id",
        [original.run.id],
      );
      expect(result.rows.map((r) => r.player_id)).toEqual(ids.slice(0, 4));
      expect(await getRun(original.run.id)).toMatchObject({
        status: "completed",
        edgeCount: 3,
      });
      expect(await getRun(refresh.run.id)).toMatchObject({
        status: "completed",
        nodeCount: 3,
        edgeCount: 2,
      });
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [
        runs,
      ]);
      await pool.query(
        "DELETE FROM friend_observations WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM friendship_edges WHERE mode=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM friend_lists WHERE mode=$1 AND owner_id=ANY($2::text[])",
        [config.mode, ids],
      );
      await pool.query(
        "DELETE FROM players WHERE mode=$1 AND id=ANY($2::text[])",
        [config.mode, ids],
      );
    }
  },
);
databaseIt(
  "counts every retry against the persisted run budget and stops before an excess attempt",
  async () => {
    const root = "76561200100003000";
    const runs: string[] = [];
    try {
      const success = await createRun(root, {
        input: root,
        depth: 1,
        maxNodes: 10,
        maxRequests: 3,
        refresh: true,
      });
      runs.push(success.run.id);
      let calls = 0;
      await expect(
        steamRequest(async () => {
          calls++;
          if (calls < 3)
            throw new SteamError("transient", "Synthetic transient failure");
          return "ok";
        }, success.run.id),
      ).resolves.toBe("ok");
      expect(calls).toBe(3);
      expect((await getRun(success.run.id)).requestCount).toBe(3);
      const limited = await createRun(root, {
        input: root,
        depth: 1,
        maxNodes: 10,
        maxRequests: 2,
        refresh: true,
      });
      runs.push(limited.run.id);
      let excess = 0;
      await expect(
        steamRequest(async () => {
          excess++;
          throw new SteamError("rate", "Synthetic rate limit");
        }, limited.run.id),
      ).rejects.toBeInstanceOf(BudgetError);
      expect(excess).toBe(2);
      expect((await getRun(limited.run.id)).requestCount).toBe(2);
    } finally {
      await pool.query("DELETE FROM crawl_runs WHERE id=ANY($1::uuid[])", [
        runs,
      ]);
      await pool.query("DELETE FROM players WHERE mode=$1 AND id=$2", [
        config.mode,
        root,
      ]);
    }
  },
);
