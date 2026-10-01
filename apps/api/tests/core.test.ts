import { describe, it, expect } from "vitest";
import { parseIdentity } from "../src/identity.js";

describe("Steam identities", () => {
  it("keeps IDs beyond JavaScript precision as strings", () => {
    expect(parseIdentity("76561199521553744")).toEqual({
      id: "76561199521553744",
    });
    expect(
      parseIdentity("https://steamcommunity.com/profiles/76561199521553744/"),
    ).toEqual({ id: "76561199521553744" });
    expect(parseIdentity("76561202255233023")).toEqual({
      id: "76561202255233023",
    });
    expect(() => parseIdentity("76561202255233024")).toThrow();
  });
  it("normalizes vanity URLs without permitting arbitrary outbound hosts", () => {
    expect(
      parseIdentity("https://steamcommunity.com/id/example_player/"),
    ).toEqual({ vanity: "example_player" });
    for (const value of [
      "https://evil.test/id/player",
      "https://steamcommunity.com.evil.test/id/player",
      "123",
      "https://user:pass@steamcommunity.com/id/player",
      "https://steamcommunity.com:444/id/player",
    ]) {
      expect(() => parseIdentity(value)).toThrow();
    }
  });
});
