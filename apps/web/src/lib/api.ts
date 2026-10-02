import type {
  AnalysisResult,
  AppConfig,
  CrawlRun,
  CreateRunInput,
  CreateRunResult,
  GraphResponse,
  GameScoresResponse,
  PlayerDetailsSnapshot,
  PlayerSearchResponse,
  RelationshipScoresResponse,
  RunGroupsResponse,
} from "../../../../packages/shared/src/index";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.message || `请求失败（${response.status}）`);
  return body as T;
}
export const api = {
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
  graph: (id: string, limit: number, depth: number, signal?: AbortSignal) =>
    request<GraphResponse>(
      `/runs/${encodeURIComponent(id)}/graph?limit=${limit}&depth=${depth}`,
      { signal },
    ),
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
