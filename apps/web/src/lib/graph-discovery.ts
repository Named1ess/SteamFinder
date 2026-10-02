import type { GraphFilters, PlayerAnnotation } from "../../../../packages/shared/src/index";

export const emptyGraphFilters = (): GraphFilters => ({
  minScore: null, community: null, gameAppId: "", groupId: "", fetchStatus: "all", tag: "", unknown: "exclude",
});

export function hasGraphFilters(filters: GraphFilters) {
  return filters.minScore !== null || filters.community !== null || !!filters.gameAppId ||
    !!filters.groupId || filters.fetchStatus !== "all" || !!filters.tag;
}

export function taggedPlayerIds(annotations: Record<string, PlayerAnnotation>, tag: string): string[] {
  return tag ? Object.keys(annotations).filter(id => annotations[id].tags.includes(tag)).sort() : [];
}

export function annotationTags(annotations: Record<string, PlayerAnnotation>): string[] {
  return [...new Set(Object.values(annotations).flatMap(annotation => annotation.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
