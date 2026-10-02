import type {
  AnalysisResult,
  AppConfig,
  CrawlRun,
  CreateRunInput,
  CreateRunResult,
  GraphResponse,
  GraphFocus,
  GraphViewState,
  SavedGraphView,
  SavedGraphViewSummary,
  GraphFilterOptions,
  GraphFilterRequest,
  GraphFilterResponse,
  MultiFriendRequest,
  MultiFriendResponse,
  GameScoresResponse,
  PlayerDetailsSnapshot,
  PlayerSearchResponse,
  RelationshipScoresResponse,
  RelationshipScorePage,
  RelationshipOverview,
  RelationshipScoreDetail,
  RelationshipLayer,
  RunGroupsResponse,
} from "../../../../packages/shared/src/index";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.message || `请求失败（${response.status}）`);
  return body as T;
}
export const api = {
  filterOptions: (id: string, signal?: AbortSignal) => request<GraphFilterOptions>(`/runs/${encodeURIComponent(id)}/filter-options`, { signal }),
  filterGraph: (id: string, input: GraphFilterRequest, signal?: AbortSignal) => request<GraphFilterResponse>(`/runs/${encodeURIComponent(id)}/filter`, { method: "POST", body: JSON.stringify(input), signal }),
  multiFriends: (id: string, input: MultiFriendRequest, signal?: AbortSignal) => request<MultiFriendResponse>(`/runs/${encodeURIComponent(id)}/multi-friends?${new URLSearchParams({ players: input.playerIds.join(","), minConnections: String(input.minConnections), page: String(input.page) })}`, { signal }),
  config: () => request<AppConfig>("/config"),
  playerDetails: (id: string) =>
    request<PlayerDetailsSnapshot>(
      `/players/${encodeURIComponent(id)}/details`,
    ),
  collectPlayerDetails: (id: string, refresh: boolean) =>
    request<PlayerDetailsSnapshot>(
      `/players/${encodeURIComponent(id)}/details`,
      {
        method: "POST",
        body: JSON.stringify({ refresh }),
      },
    ),
  runs: () => request<{ runs: CrawlRun[] }>("/runs"),
  run: (id: string) => request<CrawlRun>(`/runs/${encodeURIComponent(id)}`),
  graph: (id: string, limit: number, depth: number, signal?: AbortSignal, focus?: GraphFocus | null) =>
    request<GraphResponse>(
      `/runs/${encodeURIComponent(id)}/graph?${new URLSearchParams({ limit: String(limit), depth: String(depth), ...(focus ? { focusCenter: focus.playerId, focusHops: String(focus.hops) } : {}) })}`,
      { signal },
    ),
  views: (id: string, signal?: AbortSignal) => request<{ views: SavedGraphViewSummary[] }>(`/runs/${encodeURIComponent(id)}/views`, { signal }),
  view: (id: string, viewId: string) => request<SavedGraphView>(`/runs/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}`),
  saveView: (id: string, name: string, state: GraphViewState, viewId?: string) => request<SavedGraphView>(
    `/runs/${encodeURIComponent(id)}/views${viewId ? `/${encodeURIComponent(viewId)}` : ""}`,
    { method: viewId ? "PUT" : "POST", body: JSON.stringify({ name, state }) },
  ),
  deleteView: (id: string, viewId: string) => request<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}/views/${encodeURIComponent(viewId)}`, { method: "DELETE" }),
  create: (input: CreateRunInput) =>
    request<CreateRunResult>("/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancel: (id: string) =>
    request<CrawlRun>(`/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  resume: (id: string, maxNodes: number, maxRequests: number) =>
    request<CrawlRun>(`/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: JSON.stringify({ maxNodes, maxRequests }),
    }),
  analysis: (id: string, kind: "mutual" | "path", from: string, to: string) =>
    request<AnalysisResult>(
      `/runs/${encodeURIComponent(id)}/analysis?${new URLSearchParams({ kind, from, to })}`,
    ),
  searchPlayers: (
    id: string,
    {
      q,
      selectedId,
      excludeId,
      signal,
    }: {
      q: string;
      selectedId: string;
      excludeId: string;
      signal?: AbortSignal;
    },
  ) => {
    const params = new URLSearchParams({ q, limit: "30" });
    if (selectedId) params.set("selectedId", selectedId);
    if (excludeId) params.set("excludeId", excludeId);
    return request<PlayerSearchResponse>(
      `/runs/${encodeURIComponent(id)}/players?${params}`,
      { signal },
    );
  },
  gameScores: (id: string, signal?: AbortSignal) =>
    request<GameScoresResponse>(`/runs/${encodeURIComponent(id)}/game-scores`, {
      signal,
    }),
  relationshipScores: (id: string, center: string, signal?: AbortSignal) =>
    request<RelationshipScoresResponse>(
      `/runs/${encodeURIComponent(id)}/relationship-scores?${new URLSearchParams({ center })}`,
      { signal },
    ),
  relationshipPage: (id: string, center: string, options: { page: number; q: string; layer: RelationshipLayer | "all" }, signal?: AbortSignal) =>
    request<RelationshipScorePage>(
      `/runs/${encodeURIComponent(id)}/relationship-scores/page?${new URLSearchParams({ center, page: String(options.page), q: options.q, layer: options.layer, limit: "30" })}`,
      { signal },
    ),
  relationshipOverview: (id: string, center: string, signal?: AbortSignal) =>
    request<RelationshipOverview>(
      `/runs/${encodeURIComponent(id)}/relationship-scores/overview?${new URLSearchParams({ center })}`,
      { signal },
    ),
  relationshipDetail: (id: string, center: string, playerId: string, signal?: AbortSignal) =>
    request<RelationshipScoreDetail>(
      `/runs/${encodeURIComponent(id)}/relationship-scores/players/${encodeURIComponent(playerId)}?${new URLSearchParams({ center })}`,
      { signal },
    ),
  runGroups: (id: string, signal?: AbortSignal) =>
    request<RunGroupsResponse>(`/runs/${encodeURIComponent(id)}/groups`, {
      signal,
    }),
  collectGroups: (id: string, refresh: boolean, maxRequests: number) =>
    request<RunGroupsResponse>(`/runs/${encodeURIComponent(id)}/groups`, {
      method: "POST",
      body: JSON.stringify({ refresh, maxRequests }),
    }),
  collectGameScores: (id: string, refresh: boolean, maxRequests: number) =>
    request<GameScoresResponse>(`/runs/${encodeURIComponent(id)}/game-scores`, {
      method: "POST",
      body: JSON.stringify({ refresh, maxRequests }),
    }),
};
