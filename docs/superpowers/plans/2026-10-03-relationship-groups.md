# Shared Steam groups in relationship scores

> **For agentic workers:** Use superpowers:subagent-driven-development. Root coordinates scoring and final verification; parser, collection, and UI tasks own separate files.

**Goal:** Include public joined groups only in relationship layers, as requested; game similarity stays unchanged.

**Design:** Group membership is an auxiliary positive signal. Let B be the existing network score and J the Jaccard overlap of two complete public group lists. Final score = round(B + (100 - B) × 0.10 × J, 1). Shared groups cannot establish an unknown friendship path: null base stays null. Empty, missing, private, failed, incomplete, or no shared groups never reduce B. Show base, bonus, overlap, snapshot states and linked common-group examples.

**Storage and collection:** An explicit run-level group job pins all currently saved run nodes, prioritizes root and nearer players, and fetches one anonymous groups HTML page per player via the existing rate limit and request budget. A complete parser requires deduplicated card count to match Steam cGroups. Unexpected pagination or markup is unavailable, never a fabricated empty list. Global mode-scoped cache is pinned into each run job; GET endpoints only read the database. Refresh failures retain old content but exclude it from current scoring. Worker recovery resumes unfinished jobs. Existing runs without groups retain their scores.

**Tech Stack:** Existing TypeScript, React Query, Fastify, PostgreSQL, pg-boss, Cheerio, Docker.

**Scope:** User explicitly selected relationship layers only and delegated weight choice. Public HTML only, no Steam login/API key. No automatic full-network Steam collection when opening a page. Preserve existing data and snapshots. Continue in the current feature branch and checkout already deployed locally.

## Tasks

- [x] Parser/provider: real HTML-backed fixtures; ID/empty/private/challenge/truncation validation; demo groups.
- [x] Persistence/job/API: additive tables, exact budget/retry/resume/cache behavior, queue recovery, run/mode isolation, tests.
- [x] Scoring: complete public-list Jaccard; positive bounded bonus; rerank and recount layers; unavailable/disconnected/dedup/boundary tests.
- [x] UI: independent collect/cache/refresh toolbar with progress and budget; bonus and common groups in explanations; final-response refresh and run isolation.
- [x] Verification: full tests with PostgreSQL, typecheck, build, browser mock and saved-data checks; deploy locally; inspect final diff.

## Review focus

- Private or incomplete lists never become empty public lists or penalize a player.
- A popular shared group alone cannot fabricate a friend path or dominate network evidence.
- Every outbound page attempt consumes both persistent daily and job quotas.
- Older jobs and another mode cannot silently change this run's pinned score evidence.
- Initial slow GETs cannot overwrite a new group job or its final scores.

## Progress

- Public-page inspection: root has zero groups; LLL has one complete group card. Current observed pages use a full HTML list and client-side search, without pagination. Count mismatch will be rejected.
- Verification: 154 tests across 22 files passed with PostgreSQL enabled. Typecheck and Docker API/web production builds passed. Existing 469-node live run retains all previous scores and 2 crawl requests while group job remains absent.
- Browser: mocked collection records the selected request budget, terminal response updates ranking and bonus details, Steam group links are correct, and 390/768px screenshots show no horizontal overflow. Failed queued submission can be resubmitted with its original parameters after reading its status. No live collection job was started by these checks.
- Review fixes: queued jobs can be safely re-enqueued and API startup recovers the commit/enqueue gap; score tests now prove actual reordering. Disable budget entry until group metadata loads to avoid losing edits when the initial run panel remounts.
