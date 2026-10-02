import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { scheduleQueryRefresh } from "./query-refresh";

it("lets a slow snapshot finish and coalesces progress into one fresh read", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ["graph", "run-1", 500];
  let finish!: (value: number) => void;
  let requests = 0;
  let aborts = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: ({ signal }) => {
      signal.addEventListener("abort", () => aborts++);
      requests++;
      return requests === 1 ? new Promise<number>(resolve => { finish = resolve; }) : Promise.resolve(2);
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refreshes = Array.from({ length: 10 }, () => scheduleQueryRefresh(client, key.slice(0, 2)));
    expect(requests).toBe(1);
    expect(aborts).toBe(0);
    finish(1);
    await Promise.all(refreshes);
    expect(requests).toBe(2);
    expect(aborts).toBe(0);
    expect(observer.getCurrentResult().data).toBe(2);
  } finally { unsubscribe(); client.clear(); }
});

it("performs one trailing read when more progress arrives during the refresh", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ["relationship-scores", "run-2"];
  client.setQueryData(key, 0);
  const finishes: ((value: number) => void)[] = [];
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: () => new Promise<number>(resolve => finishes.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const first = scheduleQueryRefresh(client, key);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    const extra = Array.from({ length: 10 }, () => scheduleQueryRefresh(client, key));
    finishes[0](1);
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1](2);
    await Promise.all([first, ...extra]);
    expect(finishes).toHaveLength(2);
    expect(observer.getCurrentResult().data).toBe(2);
  } finally { unsubscribe(); client.clear(); }
});

it("marks inactive queries stale without starting background requests", async () => {
  const client = new QueryClient();
  const key = ["graph", "old-run"];
  client.setQueryData(key, { nodes: [] });
  await scheduleQueryRefresh(client, key);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
  client.clear();
});
