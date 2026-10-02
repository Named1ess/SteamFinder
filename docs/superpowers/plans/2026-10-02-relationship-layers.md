# Relationship layers implementation plan

> Execute in the existing project with backend and frontend subtasks in parallel, then review and verify together.

Goal: add an independent graph-only relationship score and near-to-far layer visualization, calculated from the entire persisted run around a searchable center. Keep Docker deployment, existing history and all other features.

## Design and scope

- GET `/api/runs/:id/relationship-scores?center=<SteamID>`; center defaults to run root and must belong to that run/mode. No Steam calls, jobs, database writes, or new dependencies. Persisted graph is the reusable source; derived results do not need a new table.
- Shared response contracts live in `packages/shared/src/index.ts`. Every collected player except the center receives a row, independent of graph display caps/depth.
- Undirected simple graph: ignore invalid endpoints, self loops, repeated/reversed edges. Use actual degree for adjacency; intermediary penalty degree = max(1, observed degree, stored public friend count).
- Custom heuristic score = 15 for a direct edge + 45×RA2/(RA2+1) + 25×Jaccard + 15×RA3/(RA3+1). RA2 is sum of inverse intermediary degrees over common friends. Jaccard compares endpoint neighbor sets after excluding each other. RA3 sums inverse degree products over simple paths of exactly three edges, excluding backtracking/repeated nodes. Components rounded to 0.1, score is their rounded sum. This is not a probability or actual friendship closeness.
- Compute RA2/common counts by scanning center neighbors. For RA3, let A[b]=sum weights of center neighbors adjacent to b. For each v!=root, sum w(b)*(A[b] - (direct(v)?w(v):0)) across b in N(v), b!=root, clamping floating error to zero. Analogous count pass yields distinct oriented simple 3-hop paths. Complexity O(V+E), plus deterministic row sorting; do not enumerate paths.
- BFS distance is independent of score. Score is null only if no observed path exists; such players form a separate unknown group. Connected players beyond three hops may score 0; say evidence is weak, never assert real-world strangers. Layers: core≥60, close≥35, connected≥15, peripheral<15, unknown=null. Labels: 核心层 / 紧密层 / 连接层 / 外围层 / 暂无已知路径.
- Sort descending score, null last, then common count descending, distance ascending, ID ascending. Common friend examples bounded to 5 and sorted IDs. Coverage is separate from score, not a multiplier: complete requires fresh (24h), successful, fully represented lists. Per-row complete requires both endpoints and their immediate neighbors complete, sufficient for the scored ≤3-hop neighborhoods.
- UI: `RelationshipScoresPanel` before game scores and a sidebar anchor. Searchable center (reuse PlayerCombobox), score-layer summary cards, bounded interactive concentric-ring visualization, searchable/paginated ranked list, selected-player breakdown with common friend names/counts, distance, direct edge, three-hop paths, components and sample coverage. At most ~100 visual nodes; all rows stay searchable. Rings encode score tiers, not friendship degrees; layer click filters list. No massive DOM for 10k players.
- Current run keyed component; center edits clear scores until committed. Query abort/stale isolation; invalidation on run node/edge/status/updatedAt changes; no automatic external collection. Support mobile, keyboard, loading/error/empty/unknown states. Existing profile hover on player avatar remains available.
- Formula disclosure in UI and README: custom weights, hub penalty, partial graph caveat and difference from game similarity. Resource-allocation motivation: https://arxiv.org/abs/0901.0553 ; three-edge local-path motivation: https://arxiv.org/abs/0905.3558 . The combined formula and thresholds are project choices, not scientifically calibrated closeness.

## Tasks

- [x] Backend: pure scoring + GET route, tests first for exact fixtures, extra mutual evidence, hub penalty, backtracking, cycles, duplicates, disconnected/private, score bounds/tier boundaries, determinism and 10k sparse graph. Real PostgreSQL isolation/read-only/search-center tests.
- [x] Frontend: panel, radial score view, API helper/CSS and App integration. Verify sort/filter/pagination/center reset where meaningful; browser test user flows and mobile.
- [x] Root: inspect implementations, review algorithm independently, full Docker tests/typecheck/build, read-only live API and browser verification, update README, deploy containers, local commit.

Review focus: unknown versus zero; graph display cap independence; hub score inflation; stale results after center/run changes; bounded layout/list rendering; unchanged Steam request counts.

## Verification and review outcomes

120 tests passed, including PostgreSQL and a 32-graph exhaustive-path oracle. Typecheck and Docker production build passed. HTTP integration passed. Browser verified full-run scores despite depth/canvas caps, searchable center, dirty-input reset, layer/ranking filters, pagination, keyboard ring selection, mobile center selection, no POST requests, and unchanged Steam request count. Screenshots checked at 1440, 768 and 390px.

Review fix: cancel the initial pending relationship request before invalidating on a run revision, retaining stable cache keys; a QueryClient/QueryObserver regression covers final collection completion while a stale request is pending. Tablet layer cards switch to three columns to avoid long-label overflow. The map uses at most 100 representatives and per-ring limits 24/32/44/56; all players remain in the searchable ranking.
