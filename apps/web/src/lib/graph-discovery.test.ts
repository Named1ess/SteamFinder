import { expect, it } from "vitest";
import { annotationTags, emptyGraphFilters, hasGraphFilters, taggedPlayerIds } from "./graph-discovery";

it("treats score zero and community zero as real criteria while a missing-data preference alone does not filter", () => {
  expect(hasGraphFilters(emptyGraphFilters())).toBe(false);
  expect(hasGraphFilters({ ...emptyGraphFilters(), unknown: "only" })).toBe(false);
  expect(hasGraphFilters({ ...emptyGraphFilters(), minScore: 0 })).toBe(true);
  expect(hasGraphFilters({ ...emptyGraphFilters(), community: 0 })).toBe(true);
  for (const criterion of [{ gameAppId: "730" }, { groupId: "103582791429521412" }, { tag: "常玩" }, { fetchStatus: "unknown" as const }]) {
    expect(hasGraphFilters({ ...emptyGraphFilters(), ...criterion })).toBe(true);
  }
});

it("uses exact personal tags across all annotations rather than just currently drawn nodes", () => {
  const notes = { "76561198000000003": { note: "常玩", tags: [] }, "76561198000000002": { note: "", tags: ["常玩", "队友"] }, "76561198000000001": { note: "", tags: ["常玩"] }, "76561198000000004": { note: "", tags: ["不常玩"] } };
  expect(taggedPlayerIds(notes, "常玩")).toEqual(["76561198000000001", "76561198000000002"]);
  expect(taggedPlayerIds(notes, "")).toEqual([]);
  expect(taggedPlayerIds(notes, "常")).toEqual([]);
  expect(annotationTags(notes)).toEqual(expect.arrayContaining(["常玩", "队友", "不常玩"]));
  expect(annotationTags(notes)).toHaveLength(3);
});
