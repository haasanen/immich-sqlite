# Fork plan — immich-sqlite

Owner-directed fork: single-container Immich with **no postgres, no redis**,
SQLite storage, Intel-GPU (OpenVINO) ML, read-only browsing of an external
photo tree. Upstream refuses SQLite (issue #562); this fork does the port.

## Ground rules
- `upstream` remote = immich-app/immich; `main` = latest synced release tag.
- Fork work lives on phase branches, rebase onto new upstream tags via the DDL shim.
- Acceptance gate: upstream vitest suites green against the new backend.
- NO deployment-specific values anywhere in this repo (host paths, hostnames,
  device facts). Every location/port is configuration (compose env / .env),
  never baked into the image or committed files. The repo stays generic.

## Local dev/test harness (measured)
- node v24 (upstream mise pin; system node 26 breaks mock-fs), pnpm 11.27.1.
- Build `@immich/sdk` + `@immich/plugin-sdk` before server tests (workspace deps).
- Baseline v3.3.5 unit suite: 105/105 files, 2323 tests passed, 0 failed.
- CI: `fork-build.yml` -> ghcr image per push; inherited upstream workflows disabled.

## Measured coupling (v3.3.5)
- 36 tables; 37 repo .sql files, 10,534 raw PG lines; kysely elsewhere.
- PG tokens: array_agg x17, unnest x14, ::uuid x106, at time zone x15, <=> x7,
  ilike x3. No DISTINCT ON. Extensions: uuid-ossp, unaccent, pg_trgm,
  cube+earthdistance (~4 uses), plpgsql, vector(512)+VectorChord.
- Redis seam: job.repository.ts (298 lines) wraps ALL BullMQ Queue/Worker use;
  websocket.adapter.ts uses redis pub/sub for socket.io.

## Phases
1. **embedded queue** — SQLite-backed queue implementing the same
   `IJobRepository` surface (enqueue with delay/repeat, per-queue concurrency,
   pause/resume, clean, job status for UI). Drop bullmq/ioredis deps. Drop
   valkey from compose. Postgres stays during this phase.
2. **SQLite schema** — kysely SqliteDialect; DDL shim translating upstream
   migrations (uuid→TEXT, timestamptz→TEXT ISO + triggers as needed, jsonb→TEXT
   json1, generated columns); foreign_keys ON, WAL, busy_timeout.
3. **SQL port + emulations** — FTS5 (unaccent+fuzzy), haversine geo,
   sqlite-vec KNN for face_search/smart_search; audit remaining tokens.
4. **single container** — one node process: web static + api + embedded queue
   workers; ML container separate and optional (OpenVINO/A770).
5. **read-only posture** — external library :ro mount; uploads blocked at proxy.

## Test env note
Agent container has no docker socket: phase gates run vitest against a locally
installed postgres (phase 1), then against sqlite (phase 2+). Full e2e on owner NAS.
