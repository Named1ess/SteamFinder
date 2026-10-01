# SteamFinder Implementation Plan

> For agentic workers: use the implementation and review tools available in this session; independent frontend/backend work can run in parallel with the shared contract fixed first.

**Goal:** Ship a Docker-runnable Steam friendship explorer with persistent, resumable collection and interactive analysis.
**Architecture:** Shared TS contracts join React SPA, Fastify API and PG-backed worker. Nginx is the only host-facing service. Demo mode exercises the same persistence and task machinery as live Steam.
**Tech Stack:** React, Vite, Tailwind, G6, ECharts, TanStack Query, Fastify, Drizzle, PostgreSQL, pg-boss, Graphology.
**Spec:** ../specs/2026-10-02-steam-finder-design.md

## Global Constraints

- SteamID strings end-to-end; demo/live namespaces never mix.
- Page GET/reopen cannot call Steam. Keys stay server-side.
- Partial/private/error states are explicit; failed refresh never deletes good data.
- Default depth 2, max 3; default 1000 nodes/500 requests; max 10000 each; display cap 1000.
- All runtime services work via Docker Compose with a persistent database volume.

## Review Focus

1. URL inputs outside Steam and IDs beyond JS precision: unit validation tests.
2. Dense cyclic graphs and hitting a cap mid-list: worker checkpoint/integration tests.
3. Process death after committing progress: restart and idempotency integration.
4. Private/error refresh after a successful list: cache preservation tests.
5. Graph display truncation versus full-run analysis: integration and UI highlighting smoke.

## Task 1: Contracts, deployment and verification harness (root)

Files: packages/shared/src/index.ts, package.json, tsconfig.json, compose.yaml, Dockerfile, nginx.conf, .env.example, scripts/integration.ts, README.md.
- [x] Define exact shared API types and spec.
- [x] Create meaningful integration assertions; run against not-yet-running API and observe expected failure.
- [x] Add image build stages, health checks, migration service, named PG volume and proxy SSE settings.
- [x] Build, start and verify all services with Docker.

## Task 2: Backend and graph semantics (backend worker)

Own apps/api/**. Consume shared types without renaming fields. Produce API routes above; npm run api, worker, migrate entrypoints.
- [x] Write and run failing tests for URL normalization, graph cycles/mutual/path, limits and errors.
- [x] Implement Drizzle schemas + idempotent migration, mode-isolated repository, Steam/demo providers, durable BFS worker, Fastify routes and SSE.
- [x] Run focused tests and typecheck; report commands and limits.

## Task 3: Frontend (frontend worker)

Own apps/web/**. Consume /api contract; no backend or root package edits. Produce Vite production build.
- [x] Implement Chinese responsive graph workspace, accessible controls, explicit demo/error/loading/empty states.
- [x] Implement G6 lifecycle cleanup, graph subset and highlight modes, ECharts statistics, history/persistence, SSE reconnect/poll fallback.
- [x] Test meaningful data/selection logic; build/typecheck, provide browser verification hooks.

## Task 4: Integration and delivery (root + independent reviewer)

- [x] Run Docker demo end-to-end scenarios including persistence, budgets, resume and analysis.
- [x] Inspect actual browser, console and responsive layout; fix discovered defects.
- [x] Independent full-code review, resolve material findings with regression checks.
- [x] Record verified commands and usage; commit completed project locally, leave running demo and provide URL.
