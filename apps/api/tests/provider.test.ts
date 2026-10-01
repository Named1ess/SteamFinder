import { expect, it } from "vitest";
import {
  LiveProvider,
  SteamError,
  classifyStatus,
  DemoProvider,
  demoIds,
} from "../src/provider.js";
it("distinguishes private lists from a real empty list in demo", async () => {
  const provider = new DemoProvider();
  await expect(provider.friends(demoIds[12])).rejects.toMatchObject({
    kind: "private",
  });
  await expect(provider.friends("76561199999999999")).resolves.toEqual([]);
});
it("classifies retryable and authorization HTTP failures without leaking credentials", () => {
  expect(classifyStatus(429).kind).toBe("rate");
  expect(classifyStatus(503).kind).toBe("transient");
  expect(classifyStatus(403).kind).toBe("unauthorized");
});
it("classifies real friend-list 401 as inaccessible and refuses malformed lists", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 401 });
    await expect(
      new LiveProvider("secret-key").friends(demoIds[0]),
    ).rejects.toMatchObject({ kind: "private" });
    globalThis.fetch = async () =>
      Response.json({ friendslist: { friends: [{ steamid: 123 }] } });
    await expect(
      new LiveProvider("secret-key").friends(demoIds[0]),
    ).rejects.toBeInstanceOf(SteamError);
  } finally {
    globalThis.fetch = original;
  }
});
