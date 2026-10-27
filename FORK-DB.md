# FORK-DB — database layer & SQLite portability (v3.3.5)

Method: greps cited per claim. All paths under server/.

## 1. Driver/dialect seams (fewer than expected)
- Single kysely factory: src/utils/database.ts:53 `getKyselyConfig` uses
  `PostgresJSDialect` (kysely + postgres-js) — imported at :20. Two Kysely
  constructions in main.ts (:48 admin, :68 user). No `pg` package anywhere;
  only plugin.repository.ts:3 `generic-pool` (unrelated to postgres).
- Port lever #1: swap `getKyselyConfig` to `SqliteDialect` (kysely built-in)
  + better-sqlite3 driver. One function.

## 2. Schema system
- src/schema/: 65 table definitions (TS/kysely migrations style), 102 migration
  files (TS, `sql\`\`` raw DDL). Applied at startup by DatabaseRepository
  (migrations table), plus `migration_overrides` table storing functions/triggers.
- PG-only DDL census (src/schema/**/*.ts): CREATE EXTENSION x6 (Initial:32 —
  uuid-ossp, unaccent, cube, earthdistance, pg_trgm + vector extension
  pgvector/VectorChord), vector(512) columns x2 (face_search :160,
  smart_search :187), vector indexes via vectorIndexQuery (:486,:519),
  USING gin x30 / gist x2, GENERATED ALWAYS x1, plpgsql functions x2 +
  statement-level triggers w/ transition tables (PersonSharing migration
  1790616293884 — REFERENCING NEW/OLD TABLE; SQLite has NO transition tables;
  flag: re-implement person-share cascade in app code or per-row triggers).
- Column types needing mapping: uuid->TEXT(+validators), timestamptz->TEXT ISO8601
  (kysely already parses via driver? verify at shim layer), jsonb->TEXT JSON1,
  vector(512)->separate vec0 virtual table keyed by same id, enum->TEXT.

## 3. Test harness (the port's acceptance gate — proven)
- Unit: 105 spec files, mocked DB, runs everywhere. Baseline 2323 pass (green).
- **Medium: 66 spec files (test/medium/**) — REAL database via testcontainers
  spinning `ghcr.io/immich-app/postgres:14-vectorchord0.4.3`
  (test/medium/globalSetup.ts:11). GitHub-hosted CI runners have docker ->
  fork-build workflow can run the FULL DB suite in CI.**
- Port gate design: after dialect swap, the SAME 66 specs must pass with
  globalSetup starting SQLite (no container) instead. Any spec asserting
  PG-specific error strings needs diffing.
- Action: add `fork-test` CI job (pnpm install -> build sdk/plugin-sdk ->
  vitest unit + medium) so every phase lands with measured proof.

## 4. Design: DDL shim vs forked migrations (decision recorded)
Chosen: TRANSLATE AT APPLY-TIME. Keep upstream migration TS files byte-identical;
wrap `sql\`\`` execution in a dialect adapter that rewrites PG DDL -> SQLite
(extensions->no-op or extension autoload; vector(N)->vec0 side table; gin/gist->
normal index; GENERATED ALWAYS->native (SQLite 3.31+ supports STORED/VIRTUAL);
plpgsql PersonSharing functions->app-level hooks registered in code).
Why: upstream ships ~12 new migrations per release; keeping files identical makes
rebase nearly free; overrides live in one shim module.

## 5. Risk register
- PersonSharing transition-table triggers: cleanest answer is app-layer (flagged).
- unaccent/pg_trgm: FTS5 unicode61 remove_diacritics=2 verified on box; fuzzy
  similarity approximated via FTS5 prefix + trigram (FTS5 trigram tokenizer
  exists in 3.34+ — verify behavior parity for person-name search).
- VectorChord ANN -> sqlite-vec KNN: exact search fine at personal-library scale
  (<1M vectors); sqlite-vec v0.1.9 verified doing 512d KNN on this machine.
- better-sqlite3 native module: builds on CI (node-gyp) — add smoke that
  loads math + FTS5 + vec0 extension at startup (ship .so in image).
- Concurrency: single writer per container via WAL + busy_timeout; immich's own
  multi-service writers collapse to 1 process in our single-container target.
