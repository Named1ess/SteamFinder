# Graph discovery implementation plan

> For agentic workers: use subagent-driven-development for independent backend and UI tasks, with root integration and review.

Goal: implement the two approved next features: combined filtering linked to a player list and graph; multi-player mutual-friend analysis. No new Steam collection, sign-in, dependency or scoring formula.

## Design and contracts

- Work on `codex/graph-discovery` in the existing checkout to preserve the established Docker workflow. The user approved implementation; proceed with routine design choices without additional approval. Do not commit, merge or push in this implementation turn.
- Shared contracts live in `packages/shared/src/index.ts`. Add optional `filters` to version-1 saved views so existing views still load. Labels are local view annotations, not public Steam profile fields.
- Filters combine with AND: minimum relationship score relative to the query root, community, public game sample, public Steam group, friend-list fetch status and an exact personal tag. Evaluate across all saved players, intersecting a one/two-hop focus when present. Root display depth is ignored while filtering and disabled visibly. Display limit caps graph only; matching list paginates independently at 30. Explicit apply/clear avoids requests on each keystroke.
- Missing samples or unavailable relationship score mean unknown. A known failed condition excludes even if other conditions are unknown. Users choose matches only, matches plus unknown, or unknown only. Missing tags are a known nonmatch; absence of a game from an available sample means that sample does not match, never absence from the complete game library. Use only the run's latest pinned game/group jobs, not global caches. No automatic collection.
- Read-only POST `/api/runs/:id/filter` accepts GraphFilterRequest (64 KiB route limit for up to 1000 tagged IDs) and returns GraphFilterResponse. GET `/api/runs/:id/filter-options` supplies full-run community/game/group facets. Scores preserve existing algorithm and group semantics. Both enforce mode/run membership, finite bounds and bounded inputs. Graph contains only selected matches and their induced known edges, and uses full-run community IDs/statistics. Pagination never changes graph membership.
- GET `/api/runs/:id/multi-friends?players=id,id,id&minConnections=N&page=0` accepts 3–10 distinct valid players within this run and threshold 1–selected count. Treat graph as undirected, deduplicate edges, ignore self edges, exclude selected players from results. Rank by connection count descending then ID. Page size 30; draw selected players plus current result page and their connecting edges, independent of root depth/display cap/filter criteria. Show known-data completeness. Editing inputs, switching focus/filter/view/run or starting pair analysis invalidates prior asynchronous results.
- UI: collapsible combined-filter tool and result list adjacent to graph; additional inspector tab for multi-player analysis reusing searchable PlayerCombobox. Clicking a matching player shows details, including a result beyond the current graph cap. Selected candidates remain distinct from community aggregates. Filter conditions persist in saved views, multi-analysis must be cleared before saving. Small screens wrap controls and lists without horizontal overflow.

## Tasks / ledger

- [x] Filter backend and tests: new graph-filters.ts, graph-filter tests, schema persistence; API registration integrated by root. Tests cover three-valued AND, snapshot/mode isolation, no writes, counts/paging, focus, caps, foreign tagged IDs, unknown samples and game-vs-library semantics.
- [x] Multi-analysis backend and tests: new multi-friends.ts and tests; API registration integrated by root. Test selected-player exclusion, duplicates, undirected counting, threshold/page bounds, exact membership and incomplete lists.
- [x] UI components: GraphFilterPanel.tsx and MultiFriendPanel.tsx plus discovery styles. Own request timing and error states without changing App. Integrate API methods/types supplied by root.
- [x] Root integration: App state, active graph query, focus/analysis precedence, clicked list nodes, saved filters, stale-response guards, query refresh and viewport fitting. Pure derivations tested before integration.
- [x] Review and verify: full PostgreSQL suite/typecheck, Docker build/deploy preserving volumes, browser combinations/unknown/pagination/multi-analysis/late responses/saved-view compatibility/mobile. Verify existing source counts and scores unchanged; remove temporary fixtures/views.

## Review focus

1. An old filter or analysis response must not overwrite a newer run/view/selection.
2. The list covers all matches while graph caps do not silently change analytical counts.
3. Unknown cannot masquerade as false or score zero, and failed refreshes cannot use stale global sample content.
4. Saved filters must reproduce tag matching, including tags outside the current display cap.
5. Clearing filters and analysis restores normal graph behaviour, drag, resize and saved positions.

## Verification record

- Full Docker PostgreSQL suite: 259 tests across 35 files passed; TypeScript passed. Production API/web images built, and api/web healthy with worker running after deployment; database volume preserved.
- Final independent source review found no remaining actionable bugs. Integration fixes addressed filter-list selection while a multi subgraph is active, facet query-key consistency, and score/filter evidence using the same pinned snapshots. Literal group-score regression checks 15 → 23.5.
- Real saved-data browser checks: 468 score-filter matches independent of a 100-player canvas cap; page-5 selection inserted into graph; exact local tag persisted/reloaded with view; public game matches/unknown/exclusions; focus intersection; empty filtered view saving; old views without filters restore correctly.
- Multi results matched an independently computed adjacency oracle; at-least-one produced 317 candidates for the fixture's three selected players, with 30 per page and 33 graph nodes. All-selected mode, excluding selected players, result details, duplicate rejection and filter-list exit from multi mode passed.
- Fault injection passed: late filter response, late multi response after editing/filtering/focusing/loading a legacy view/starting pair analysis, filter-options/result failure retries, and mocked group-job completion invalidating both active filters and options. No real collection was started.
- Browser scripts are local ignored artifacts: `output/playwright/verify-discovery.js`, `verify-discovery-races.js`, `verify-discovery-refresh.js`. 390px and 768px screenshots checked without overflow; three inspector tabs align. Existing graph-exploration and graph-auto-fit scripts passed again, including saved coordinates and viewport restoration.
- Baseline HTTP comparison: all 468 relationship rows unchanged, run remains 469 nodes / 499 edges / 2 Steam requests. No real group job exists, and all temporary verification views were deleted. No commits, merges or pushes were made.

## Follow-up bug audit

- Confirmed before fixing with `output/playwright/audit-discovery-readiness.js`: a 503 ordinary graph read incorrectly disabled focus and left its error above a successful independent multi subgraph. Readiness and graph-query error presentation now follow the displayed graph; the original failure is shown again when exiting multi mode.
- Confirmed before fixing with `output/playwright/audit-discovery-stale-failure.js`: a pair-analysis failure arriving after applying filters leaked into the new view. Pair mutation variables now capture selection and generation at submission; pending state and errors use the same scope checks as results. Each new submission advances its generation, and current failures remain visible.
- Both reproduction scripts passed after rebuilding and deploying web. `verify-discovery-races.js` passed again; all 259 tests and TypeScript passed. Final HTTP comparison confirmed score/data/request-count parity. No production backend changes were needed.
- Independent review found no actionable regressions in these fixes. A suspected dormant-filter camera reset could not be reproduced and was not treated as a confirmed defect. A separate synthetic 10,000-node / 99,990-edge backend check validated result totals, final-page counts, caps and selected-player adjacency; this is not an end-to-end capacity guarantee.
