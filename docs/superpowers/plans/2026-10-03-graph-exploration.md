# Graph exploration implementation plan

Approved scope: the three recommended additions — local focus, community collapse, and saved views with player notes/tags. Existing public-page collection, scoring, manual graph positions, edge panning and responsive fitting remain supported.

## Design and contracts

- Focus is a database-only graph query around any saved player, one or two undirected hops, bounded by the existing display limit. Always include the center; ignore root-based display depth during focus. Statistics remain for the whole persisted run and clearly distinguish the focused display.
- Collapse communities in the currently displayed graph. Aggregate nodes are visually distinct, show member and internal connection counts; aggregate edges count underlying unique friendships. A click expands the community. Aggregates never masquerade as Steam profiles or enter score/analysis inputs. Selected, root and analysis-highlighted players stay expanded.
- Save named views in PostgreSQL, scoped to run and data mode, maximum 20 per run. Restore layout, display filters, focus, collapsed communities, selected player, positions, camera center/zoom and player notes/tags. Explicit save/overwrite/load/delete UI; notes are saved with the view. Validate identifiers, finite coordinates, bounded payloads, and forbid cross-run player references. No automatic live collection.
- Use existing shared checkout on a feature branch to preserve local Docker setup. Independent file ownership allows parallel implementation; no commit/push is requested for this feature turn.

Shared state contract is defined in packages/shared/src/index.ts. Browser exploration node/edge types live in apps/web/src/lib/graph-exploration.ts. NetworkGraph exposes a capture handle and accepts explicit restore snapshots and view revisions. Ordinary data refresh does not reset camera; explicit focus/fold changes fit, resize fits, explicit restore respects saved camera.

## Tasks

- [x] Backend: focus selection, saved-view schema/endpoints/validation, database isolation and budget tests.
- [x] Graph projection: pure folding/aggregate counting and tests including protected nodes, malformed/self/duplicate edges and unchanged input.
- [x] Renderer: aggregate styling/expansion, queued camera capture/restore, explicit view changes; preserve hover semantics for real players.
- [x] UI: focus controls and player search, community controls, named view management, notes/tags; clear statuses and responsive layout.
- [x] Verify: relevant tests then full PostgreSQL suite/typecheck/build, browser focus/fold/save/reload/resize checks using saved data or isolated demo fixtures. Deploy local containers preserving volumes.

## Progress

Planning complete. No new packages needed. The other suggested features (cross-filtering, historical diffs, game heatmaps, exports) remain future suggestions outside this three-feature scope.

Implementation and local deployment complete. Full PostgreSQL suite: 232 tests / 32 files; TypeScript and production Docker builds pass. Browser checks pass for focus outside the root display filter, community expansion, saved-view CRUD, notes/tags/search restoration, exact saved coordinates/camera restoration, responsive fitting and progress-update preservation. DELETE regression was reproduced and fixed by omitting JSON Content-Type when no request body is sent. Existing 469-node/499-edge query, all 468 score rows and two Steam requests are unchanged. Temporary verification views were removed.

Browser fault injection also passed: a positive-control path response renders normally, while the same delayed response after focus or saved-view loading is discarded without restoring old highlights or merging old path nodes into the current view.
