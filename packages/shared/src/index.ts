export type DataMode = "demo" | "live";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "limited"
  | "failed"
  | "cancelled";
export type FetchStatus = "unknown" | "ok" | "private" | "error";
export interface AppConfig {
  mode: DataMode;
  maxDepth: number;
  maxNodes: number;
  defaultRoot: string;
  requestDelayMs: number;
}
export interface CrawlRun {
  id: string;
  rootId: string;
  rootName: string;
  mode: DataMode;
  depth: number;
  maxNodes: number;
  maxRequests: number;
  status: RunStatus;
  nodeCount: number;
  edgeCount: number;
  fetchedCount: number;
  privateCount: number;
  errorCount: number;
  requestCount: number;
  cacheHits: number;
  refresh: boolean;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface GraphNode {
  id: string;
  name: string;
  avatar: string | null;
  profileUrl: string;
  depth: number;
  fetchStatus: FetchStatus;
  fetchedAt: string | null;
  friendCount: number | null;
  degree: number;
  community: number;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}
export type PlayerSearchOption = Pick<
  GraphNode,
  "id" | "name" | "avatar" | "profileUrl" | "depth"
>;
export interface PlayerSearchResponse {
  players: PlayerSearchOption[];
  total: number;
  selected: PlayerSearchOption | null;
}
export interface GraphStats {
  layers: { depth: number; count: number }[];
  communities: { id: number; size: number }[];
  topConnectors: { id: string; name: string; count: number }[];
  fetchedNodes: number;
  privateNodes: number;
  failedNodes: number;
  frontierNodes: number;
}
export interface GraphResponse {
  run: CrawlRun;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  truncated: boolean;
  totalNodes: number;
  totalEdges: number;
}
export interface CreateRunInput {
  input: string;
  depth: number;
  maxNodes: number;
  maxRequests: number;
  refresh?: boolean;
}
export interface CreateRunResult {
  run: CrawlRun;
  cached: boolean;
}
export interface AnalysisResult {
  kind: "mutual" | "path";
  nodeIds: string[];
  path: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  complete: boolean;
  message: string;
}
export interface GamePlaytime {
  appId: string;
  name: string;
  /** Lifetime minutes shown for this game; null means hidden or unavailable. */
  minutes: number | null;
}
export interface PublicGames {
  scope: "profile_recent";
  games: GamePlaytime[];
  /** Public header captured with the same page, absent on older snapshots. */
  profile?: PublicProfileDetails | null;
}
export interface ProfileLocation {
  label: string;
  countryCode: string | null;
  /** Exact displayed subnational text, without inferring a city or region. */
  locality: string | null;
}
export interface PublicProfileDetails {
  realName: string | null;
  location: ProfileLocation | null;
}
export interface ProfileAlias {
  name: string;
  changedAt: string | null;
}
export interface PlayerDetailsSnapshot {
  playerId: string;
  profile: PublicProfileDetails | null;
  profileStatus: FetchStatus;
  profileFetchedAt: string | null;
  profileAttemptedAt: string | null;
  profileMessage: string | null;
  aliases: ProfileAlias[];
  aliasesStatus: FetchStatus;
  aliasesFetchedAt: string | null;
  aliasesAttemptedAt: string | null;
  aliasesMessage: string | null;
}
export interface GameProfileSnapshot extends PublicGames {
  playerId: string;
  status: FetchStatus;
  fetchedAt: string | null;
  attemptedAt: string | null;
  message: string | null;
}
export interface GameScoreBreakdown {
  score: number | null;
  gameScore: number | null;
  locationSimilarity: number | null;
  /** 5 when both locations and the game score are usable, otherwise 0. */
  locationWeight: number;
  locationReason: string;
  /** Component percentages, before the base 40%/60% weights. */
  gameOverlap: number | null;
  timeSimilarity: number | null;
  sharedGameCount: number;
  unionGameCount: number;
  rootGameCount: number;
  friendGameCount: number;
  rootMinutes: number | null;
  friendMinutes: number | null;
  reason: string | null;
  sharedGames: {
    appId: string;
    name: string;
    rootMinutes: number | null;
    friendMinutes: number | null;
  }[];
}
export interface GameScoreRow {
  player: Pick<GraphNode, "id" | "name" | "avatar" | "profileUrl">;
  snapshot: GameProfileSnapshot;
  result: GameScoreBreakdown;
}
export interface GameScoreJob {
  id: string;
  runId: string;
  status: RunStatus;
  maxRequests: number;
  requestCount: number;
  cacheHits: number;
  totalPlayers: number;
  processedPlayers: number;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface GameScoresResponse {
  runId: string;
  rootId: string;
  scope: "profile_recent";
  formulaVersion: "public-games-location-v2";
  root: GameProfileSnapshot | null;
  job: GameScoreJob | null;
  rows: GameScoreRow[];
}
export const DEFAULT_ROOT = "76561199521553744";
