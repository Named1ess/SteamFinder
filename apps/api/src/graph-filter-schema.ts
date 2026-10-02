import { z } from "zod";

const appId = z.string().max(16).refine((id) => id === "" || (/^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0));
const clanId = z.string().max(18).refine((id) => {
  if (id === "") return true;
  if (!/^\d{18}$/.test(id)) return false;
  const value = BigInt(id), base = 103582791429521408n;
  return value >= base && value <= base + 4294967295n;
});

/** Shared with version-one saved views; every condition is explicit. */
export const graphFiltersSchema = z.object({
  minScore: z.number().finite().min(0).max(100).nullable(),
  community: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  gameAppId: appId,
  groupId: clanId,
  fetchStatus: z.enum(["all", "unknown", "ok", "private", "error"]),
  tag: z.string().max(24),
  unknown: z.enum(["exclude", "include", "only"]),
}).strict();
