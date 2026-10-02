import type { QueryClient, QueryKey } from "@tanstack/react-query";

type PendingRefresh = { dirty: boolean; promise: Promise<void> };
const pendingRefreshes = new WeakMap<QueryClient, Map<string, PendingRefresh>>();

/** Allow a slow read to finish, then combine progress updates into a fresh read. */
export function scheduleQueryRefresh(
  client: QueryClient,
  queryKey: QueryKey,
): Promise<void> {
  let pending = pendingRefreshes.get(client);
  if (!pending) {
    pending = new Map();
    pendingRefreshes.set(client, pending);
  }
  const key = JSON.stringify(queryKey);
  const existing = pending.get(key);
  if (existing) {
    existing.dirty = true;
    return existing.promise;
  }
  const state: PendingRefresh = { dirty: true, promise: Promise.resolve() };
  pending.set(key, state);
  state.promise = (async () => {
    while (state.dirty) {
      // Reuse only already-running reads; inactive views should remain inactive.
      await client.refetchQueries(
        { queryKey, predicate: query => query.state.fetchStatus === "fetching" },
        { cancelRefetch: false },
      );
      // The next read includes every update received while waiting.
      state.dirty = false;
      await client.invalidateQueries({ queryKey }, { cancelRefetch: false });
    }
  })().finally(() => {
    if (pending.get(key) === state) pending.delete(key);
  });
  return state.promise;
}

/** Invalidation alone reuses the first pending fetch, which may hold an older snapshot. */
export async function refreshQuerySnapshot(
  client: QueryClient,
  queryKey: QueryKey,
): Promise<void> {
  await client.cancelQueries({ queryKey });
  await client.invalidateQueries({ queryKey });
}

/** A mutation response must not be overwritten by a read started before it. */
export async function replaceQuerySnapshot<T>(
  client: QueryClient,
  queryKey: QueryKey,
  data: T,
): Promise<void> {
  await client.cancelQueries({ queryKey });
  client.setQueryData(queryKey, data);
}
