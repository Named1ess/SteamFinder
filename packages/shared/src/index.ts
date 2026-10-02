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
export interface GraphViewportSnapshot {
  positions: Record<string, { x: number; y: number }>;
  viewport: { zoom: number; center: { x: number; y: number } } | null;
}
export interface GraphFocus {
  playerId: string;
  hops: 1 | 2;
}
export interface PlayerAnnotation {
  note: string;
  tags: string[];
}
export interface GraphFilters {
  minScore: number | null;
  community: number | null;
  gameAppId: string;
  groupId: string;
  fetchStatus: FetchStatus | "all";
  tag: string;
  unknown: "exclude" | "include" | "only";
}
export interface GraphFilterRequest {
  filters: GraphFilters;
  tagPlayerIds?: string[];
  selectedId?: string | null;
  focus?: GraphFocus | null;
  limit: number;
  page: number;
}
export interface GraphFilterRow {
  player: GraphNode;
  score: number | null;
  status: "match" | "unknown";
  unknownReasons: string[];
}
export interface GraphFilterResponse {
  graph: GraphResponse;
  rows: GraphFilterRow[];
  page: number;
  pages: number;
  pageSize: number;
  total: number;
  matched: number;
  unknown: number;
  excluded: number;
  scopeTotal: number;
  sourceVersion: string;
}
export interface GraphFilterOptions {
  communities: { id: number; size: number }[];
  games: { id: string; name: string; count: number }[];
  groups: { id: string; name: string; count: number }[];
  gamePlayers: number;
  groupPlayers: number;
  totalPlayers: number;
  sourceVersion: string;
}
export interface MultiFriendRequest {
  playerIds: string[];
  minConnections: number;
  page: number;
}
export interface MultiFriendRow {
  player: GraphNode;
  matchedIds: string[];
  count: number;
}
export interface MultiFriendResponse {
  runId: string;
  playerIds: string[];
  minConnections: number;
  rows: MultiFriendRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  complete: boolean;
  message: string;
}
export interface GraphViewState extends GraphViewportSnapshot {
  version: 1;
  layout: "radial" | "circular" | "grid";
  displayDepth: number;
  displayLimit: number;
  selectedId: string | null;
  search?: string;
  filters?: GraphFilters;
  focus: GraphFocus | null;
  collapsedCommunities: number[];
  annotations: Record<string, PlayerAnnotation>;
  sourceUpdatedAt: string;
}
export interface SavedGraphViewSummary {
  id: string;
  runId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface SavedGraphView extends SavedGraphViewSummary {
  state: GraphViewState;
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
export type RelationshipLayer =
  | "core"
  | "close"
  | "connected"
  | "peripheral"
  | "unknown";
export interface RelationshipScoreRow {
  player: PlayerSearchOption;
  score: number | null;
  layer: RelationshipLayer;
  distance: number | null;
  isDirect: boolean;
  mutualCount: number;
  weightedMutual: number;
  overlap: number;
  threeHopPaths: number;
  weightedIndirect: number;
  components: {
    direct: number;
    mutual: number;
    overlap: number;
    indirect: number;
  };
  commonFriends: PlayerSearchOption[];
  evidence: "complete" | "partial";
  /** Friend-network score before the optional shared-group bonus. */
  networkScore?: number | null;
  groups?: GroupScoreEvidence;
}
export interface RelationshipScoresResponse {
  runId: string;
  center: PlayerSearchOption;
  algorithmVersion: "mutual-network-v1" | "mutual-network-groups-v2";
  groupJobId?: string | null;
  groupSourceUpdatedAt?: string | null;
  computedAt: string;
  sourceUpdatedAt: string;
  totalPlayers: number;
  totalEdges: number;
  coverage: { completeLists: number; totalLists: number };
  layers: {
    id: RelationshipLayer;
    label: string;
    minScore: number | null;
    maxScore: number | null;
    count: number;
  }[];
  rows: RelationshipScoreRow[];
}
/** Ranking and ring payloads intentionally omit per-player evidence. */
export type RelationshipScoreSummary = Pick<
  RelationshipScoreRow,
  "player" | "score" | "layer" | "distance" | "isDirect" | "mutualCount" | "networkScore"
>;
export type RelationshipScoresMetadata = Omit<RelationshipScoresResponse, "rows">;
export interface RelationshipScorePage extends RelationshipScoresMetadata {
  rows: RelationshipScoreSummary[];
  page: number;
  pages: number;
  limit: number;
  /** Matching players across the entire saved graph. */
  total: number;
}
export interface RelationshipOverview extends RelationshipScoresMetadata {
  rows: RelationshipScoreSummary[];
}
export interface RelationshipScoreDetail extends RelationshipScoresMetadata {
  row: RelationshipScoreRow;
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
  focus?: GraphFocus & { totalNodes: number };
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

export interface SteamGroup {
  /** Stable Steam clan ID; this is not a player Steam ID. */
  id: string;
  name: string;
  url: string;
  memberCount: number | null;
}
export interface PublicGroups {
  groups: SteamGroup[];
  totalCount: number;
}
export interface GroupSnapshot {
  playerId: string;
  status: FetchStatus;
  groups: SteamGroup[];
  totalCount: number | null;
  complete: boolean;
  fetchedAt: string | null;
  attemptedAt: string | null;
  message: string | null;
}
export interface GroupCollectionJob {
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
export interface RunGroupsResponse {
  runId: string;
  job: GroupCollectionJob | null;
  updatedAt: string | null;
  coverage: {
    availablePlayers: number;
    unavailablePlayers: number;
    pendingPlayers: number;
    totalPlayers: number;
  };
}
export interface GroupScoreEvidence {
  similarity: number | null;
  sharedCount: number;
  unionCount: number;
  centerCount: number | null;
  playerCount: number | null;
  centerStatus: FetchStatus;
  playerStatus: FetchStatus;
  centerFetchedAt: string | null;
  playerFetchedAt: string | null;
  /** At most 20 examples; sharedCount includes all matching groups. */
  commonGroups: SteamGroup[];
  reason: string;
  contribution: number;
}
