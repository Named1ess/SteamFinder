import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshQuerySnapshot, replaceQuerySnapshot } from "./query-refresh";

describe("run snapshot refresh", () => {
  it.each([
    ["graph", "run-1", 500, 2],
    ["run-players", "run-1", "", "player-1", ""],
  ])("replaces an initial pending %s response after collection ends", async (
    ...queryKey
  ) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    let resolveInitial!: (value: { players: string[] }) => void;
    const initialRequest = new Promise<{ players: string[] }>((resolve) => {
      resolveInitial = resolve;
    });
    let requests = 0;
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: () =>
        ++requests === 1
          ? initialRequest
          : Promise.resolve({ players: ["root", "new-friend"] }),
      refetchInterval: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
      const refresh = refreshQuerySnapshot(client, queryKey.slice(0, 2));
      resolveInitial({ players: ["root"] });
      await refresh;
      expect(observer.getCurrentResult().data).toEqual({
        players: ["root", "new-friend"],
      });
      expect(requests).toBe(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});

describe("game collection response", () => {
  it("keeps the newly started job when an older initial read finishes later", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const queryKey = ["game-scores", "run-1"];
    const beforeCollection = { job: null };
    const startedCollection = { job: { id: "new-job", status: "queued" } };
    let resolveRead!: (value: typeof beforeCollection) => void;
    const initialRead = new Promise<typeof beforeCollection>((resolve) => {
      resolveRead = resolve;
    });
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: () => initialRead,
    });
    const unsubscribe = observer.subscribe(() => {});
    const pendingRead = observer.refetch({ cancelRefetch: false });
    try {
      await replaceQuerySnapshot(client, queryKey, startedCollection);
      resolveRead(beforeCollection);
      await pendingRead;
      expect(client.getQueryData(queryKey)).toEqual(startedCollection);
      expect(observer.getCurrentResult().data).toEqual(startedCollection);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
