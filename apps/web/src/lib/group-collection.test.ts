import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { RunGroupsResponse } from "../../../../packages/shared/src/index";
import { createGroupScoreSync } from "./group-collection";
import { replaceQuerySnapshot } from "./query-refresh";

function snapshot(runId = "run-1"): RunGroupsResponse {
  return {
    runId,
    updatedAt: "2026-10-03T00:00:01.000Z",
    job: {
      id: "groups-1",
      runId,
      status: "completed",
      maxRequests: 500,
      requestCount: 2,
      cacheHits: 0,
      totalPlayers: 2,
      processedPlayers: 2,
      message: null,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:01.000Z",
      completedAt: "2026-10-03T00:00:01.000Z",
    },
    coverage: {
      availablePlayers: 2,
      unavailablePlayers: 0,
      pendingPlayers: 0,
      totalPlayers: 2,
    },
  };
}

describe("group evidence refresh", () => {
  it("replaces initial pending scores when a group job finishes without polling", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const key = ["relationship-scores", "run-1", "center"];
    let resolveOld!: (score: number) => void;
    const pending = new Promise<number>((resolve) => { resolveOld = resolve; });
    let requests = 0;
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => ++requests === 1 ? pending : Promise.resolve(59.5),
      refetchInterval: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const sync = createGroupScoreSync(client, "run-1");
      const refresh = sync(snapshot());
      resolveOld(55);
      await refresh;
      expect(observer.getCurrentResult().data).toBe(59.5);
      expect(requests).toBe(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("refreshes each changed group version once and never updates another run", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    let requests = 0;
    let otherRequests = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["relationship-scores", "run-1", "center"],
      queryFn: async () => ++requests,
    });
    const otherObserver = new QueryObserver(client, {
      queryKey: ["relationship-scores", "run-2", "center"],
      queryFn: async () => ++otherRequests,
    });
    const unsubscribe = observer.subscribe(() => {});
    const unsubscribeOther = otherObserver.subscribe(() => {});
    try {
      await Promise.all([
        observer.refetch({ cancelRefetch: false }),
        otherObserver.refetch({ cancelRefetch: false }),
      ]);
      const sync = createGroupScoreSync(client, "run-1");
      const current = snapshot();
      await sync(current);
      expect(observer.getCurrentResult().data).toBe(2);
      await sync({ ...current, coverage: { ...current.coverage } });
      await sync(snapshot("run-2"));
      expect(observer.getCurrentResult().data).toBe(2);
      expect(otherObserver.getCurrentResult().data).toBe(1);
      await sync({ ...current, job: { ...current.job!, status: "failed" } });
      expect(observer.getCurrentResult().data).toBe(3);
      await sync({ ...current, job: { ...current.job!, id: "groups-2", status: "failed" } });
      expect(observer.getCurrentResult().data).toBe(4);
      await sync({ ...current, job: { ...current.job!, id: "groups-2", status: "failed", updatedAt: "2026-10-03T00:00:02.000Z" } });
      expect(observer.getCurrentResult().data).toBe(5);
      await sync({ ...current, updatedAt: "2026-10-03T00:00:03.000Z", job: { ...current.job!, id: "groups-2", status: "failed", updatedAt: "2026-10-03T00:00:02.000Z" } });
      expect(observer.getCurrentResult().data).toBe(6);
    } finally {
      unsubscribe();
      unsubscribeOther();
      client.clear();
    }
  });

  it("keeps a newly created group job when an older GET completes later", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const key = ["run-groups", "run-1"];
    const previous = { ...snapshot(), job: null, updatedAt: null };
    const started = snapshot();
    started.job!.status = "queued";
    let resolveOld!: (data: RunGroupsResponse) => void;
    const pending = new Promise<RunGroupsResponse>((resolve) => { resolveOld = resolve; });
    const observer = new QueryObserver(client, { queryKey: key, queryFn: () => pending });
    const unsubscribe = observer.subscribe(() => {});
    const read = observer.refetch({ cancelRefetch: false });
    try {
      await replaceQuerySnapshot(client, key, started);
      resolveOld(previous);
      await read;
      expect(observer.getCurrentResult().data).toEqual(started);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
