# SteamFinder first release

The user approved implementing the proposed TS architecture and requested Docker for all runtime components. Build an operational local-first Steam friendship explorer, with an explicit demo mode when credentials are not configured. User authorization is to proceed with implementation; no additional approval stages are needed.

## Product

- Chinese UI: persistent query history, Steam URL/ID input, depth 1–3 (default 2), node/request budgets, progress and cancellation, resume, refresh.
- Central G6 graph: avatar or initials, pan/zoom, layout, selected node details, layer/search filters, graph limit independent of crawl budget.
- Two-node common friends and shortest path over collected run data; include necessary analysis nodes even outside displayed subset. Show missing/private/failed/boundary data explicitly.
- ECharts layers and community statistics, connector ranking. All metrics describe collected data, not all Steam users.
- Opening history or reloading a graph never queues external requests. Only explicit create/refresh/resume operations may do so.
- Demo data clearly labeled and segregated from live data; no inferred real-world profile claims.

## Runtime and data

React/TS/Vite + shadcn-style owned UI components + Tailwind, TanStack Query, G6, ECharts. Fastify/TS API and separate worker; PostgreSQL, Drizzle, pg-boss; Graphology algorithms. Nginx serves static frontend and proxies /api including SSE. Compose has PostgreSQL health check, one-shot migration, API, worker, frontend. Bind only frontend to localhost by default. Persist PG volume.

API contract types are in packages/shared/src/index.ts. Steam IDs stay strings. Normalize numeric profiles and vanity URLs without arbitrary outbound URLs. Steam key remains server-side, redacted from errors and logs. GET endpoints are read-only regarding Steam.

Persist players, per-owner complete friend-list observations (mode-separated), canonical friendship edges derived from observations, crawl runs and run nodes/checkpoints. Cache is reused until explicit refresh. Successful complete lists replace that owner's observation set atomically; inaccessible/error responses preserve old observations and freshness metadata and never erase known edges. Observations seen from either endpoint may support an edge. Cached old lists are labeled stale by time and latest attempt status.

BFS bounded by depth, nodes and outbound request budget. Deduplicate frontier nodes and calls; persistent checkpoints permit resume after restart. One global worker pipeline in this first release serializes external calls, with per-call pacing, bounded retry, explicit unauthorized/429/5xx/network classifications and daily request budget persisted by mode. Player summaries batched to at most 100. Count summary/vanity/friend/retry calls against limits. Keep partial results when budgets are reached. Do not mark private/error/boundary nodes as empty lists.

Default limits: depth 2, 1000 nodes, 500 requests; server depth max 3, node max 10000, requests max 10000, graph display cap 1000. The UI may choose smaller display limits. Volume/large-network capacity is a validation target, not a claimed benchmark.

## API

- GET /api/health, /api/config, /api/runs -> {runs}
- POST /api/runs (CreateRunInput) -> CreateRunResult; reuse same successful cached search unless refresh requested.
- GET /api/runs/:id -> CrawlRun
- GET /api/runs/:id/graph?limit=500&depth=3 -> GraphResponse
- GET /api/runs/:id/events -> named SSE event progress with CrawlRun JSON, eventual completion and clean disconnect
- POST /api/runs/:id/cancel -> CrawlRun
- POST /api/runs/:id/resume {maxNodes?,maxRequests?} -> CrawlRun (budgets are new total budgets, not increments)
- GET /api/runs/:id/analysis?kind=mutual|path&from=...&to=... -> AnalysisResult
- Error shape {message:string}, HTTP 400 invalid input, 404 missing resources, 409 invalid transitions, 503 missing key in live mode.

## Verification

Meaningful automated tests for identity precision/URL validation, cycles and depth, budget boundaries, mutual/path scope, privacy vs empty, retry classification. Docker integration against real PG and deterministic demo provider: create, finish, common friends/path, cache reuse with no increased request count, cancel/resume, limited run extension, process restart recovery and volume persistence. Build/typecheck, browser smoke of submit/history/filter/analysis, responsive screenshot inspection. Live network collection can only be verified when an API key is provided; report this limit.
