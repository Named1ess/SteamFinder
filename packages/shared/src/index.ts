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
  hasApiKey: boolean;
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
export const DEFAULT_ROOT = "76561199521553744";
