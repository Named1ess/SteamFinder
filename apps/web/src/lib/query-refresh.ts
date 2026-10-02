import type { QueryClient, QueryKey } from "@tanstack/react-query";

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
