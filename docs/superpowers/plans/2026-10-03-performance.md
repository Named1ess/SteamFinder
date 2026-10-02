# SteamFinder performance improvements

The user approved the six optimizations discussed in the preceding review. Preserve public-page-only collection, historical snapshots, score formulas, budgets, cancellation/recovery, and the edge-panning fix already in the working tree.

## Tasks

1. Keep the G6 graph instance for a run/layout, update changed data while preserving camera and dragged node positions; fit only initially, on explicit fit, or a new run/layout. Test metadata-only changes, added/removed analysis nodes, resizing, dragging, and switching runs.
2. Coalesce background query refreshes without repeatedly cancelling slow requests. Use SSE while healthy with polling as fallback; refresh only when progress changes; preserve final-snapshot correctness and explicit mutation replacement.
3. Enable gzip for JavaScript, CSS, SVG, and JSON responses in Nginx, excluding streaming SSE. Check actual response headers, decoded content, asset caching, and SSE streaming.
4. Add bounded server-side relationship ranking pages with search/layer filtering, a bounded overview for rings, and separate per-player score evidence. Preserve old full-response API compatibility. Load score panels when near the viewport; preserve state after first activation, active task updates, center switching, and hash navigation.
5. Batch history statistics and player upserts, remove repeated graph/run validation where a validated run is available. Verify response parity, mode isolation, history ordering/limit, and query-count improvement.
6. Batch discovered-node insertion and maintain only affected run edges during collection. Test capped budgets/resume, incoming observations for newly admitted nodes, reverse observation support, removed observations, private/error preservation, and unrelated edges remaining untouched.

## Validation and delivery

- Relevant tests first, then full PostgreSQL-backed test suite, TypeScript check, Docker production build.
- Browser interaction checks on the saved run plus local/mocked progress responses; no new live Steam collection.
- Compare uncompressed/compressed response size and SQL counts; do not claim unmeasured large-graph performance.
- Deploy updated local Docker services without deleting volumes or rewriting saved live data.
- Review all diffs and document any remaining limits.

## Completed validation

All six tasks implemented and deployed with `docker compose up -d`, preserving database volumes and the saved live run. The existing edge pointer-events fix remains in place.

- TypeScript check and 194 tests in 27 files passed with PostgreSQL tests enabled; Docker web/API builds succeeded. API, web and database are healthy; worker reports ready and migrations completed.
- Browser checks passed for incremental graph updates (same canvas and identical pixels after metadata changes), display filters, analysis node addition/removal, rapid layout switches and resizing. No extra run/graph requests during unchanged healthy SSE progress; offscreen score panels made no initial score requests. Slow initial responses cannot overwrite the final completed graph or player search.
- Relationship first load makes exactly three score requests. Pagination, full-network search, layers, center changes, empty results, cold hash navigation, and 390px/768px layouts passed. Review fixes cover stale detail refresh errors, true full-network ring counts, snapshot cache invalidation and redundant initial refreshes.
- Saved live run still has 469 nodes, 499 edges and two Steam requests; all 468 legacy score rows match the baseline. Required first score response bodies total 7,988 compressed bytes versus the original full JSON's 532,452 bytes. SSE is uncompressed. Browser verification started no collection jobs.
- Database tests verify a single history SQL query, batch player writes, owner-scoped edge maintenance, cancellation, budgets/resume, reverse support, historical isolation and late snapshot versions.

Remaining limits: graph layout is rerun on an explicit layout/run change; incremental additions preserve existing positions. Server scoring still computes the full persisted network on cache misses, with a short bounded cache shared by paged views. No unmeasured large-network latency or capacity claim is made.
