# Fork sync procedure (port model)

This fork does **not** git-merge upstream. Upstream releases are ported by
reviewing upstream's own diff (A→B) and translating it onto this tree. The
measured reason: upstream v3.2→v3.3 touched 462 `server/src` files, and 66 of
them overlapped the files this fork had modified — merge-conflict maintenance
grows with every release while a ported diff stays flat. Postgres and Redis
were deleted from this product (phase4), so upstream changes to those areas are
**never** copied — only feature changes are.

## Sync marker (where "latest merged upstream version" lives)

The sync point is the **parent of our fork commit**: our single fork commit is
always grafted directly onto an upstream release tag, and that tag is pushed
into this repo. Read it with:

```
git tag --points-at <fork-commit>^     # e.g. -> v3.3.5
```

Never maintain a separate pointer file/tag — it drifts. After each port, the
fork commit is re-parented onto the new upstream tag (same tree, `commit-tree`
with `-p <new-tag>`), which moves the marker automatically.

## Procedure per upstream release (A = last synced tag, B = new tag)

1. **Fetch and bound the worklist**
   ```
   git fetch upstream --tags
   git diff --stat upstream-vA..upstream-vB -- server/ packages/ web/ | tail -1
   git diff --name-only upstream-vA..upstream-vB -- server/src > worklist-code.txt
   git diff --name-only upstream-vA..upstream-vB -- server/test > worklist-specs.txt
   ```
   Spec files are first-class: port upstream's spec changes too, otherwise our
   suite stops encoding upstream behavior and feature regressions go invisible.

2. **Triage every changed file** into exactly one bucket:
   - **port** — feature change in a file we did *not* modify: `git checkout
     upstream-vB -- <file>`. (These merge clean because our tree equals A here.)
   - **translate** — file we modified (adapter seams, SQLite layers, browse-only):
     read the upstream A→B diff for that file and re-apply its intent by hand
     onto our version. If the upstream change is Postgres-only (new PG
     operators, extension DDL, pg_dump, advisory-lock SQL), implement the
     equivalent in `server/src/utils/sqlite-database.ts` (SQL rewriter), the
     generated SQLite schema, or the JSON/vector helper shims — or record it as
     skipped if the feature needs PG-only capabilities we don't ship.
   - **skip-logged** — Postgres/Redis internals, upstream CI for PG, migration
     files under `server/src/schema/migrations` (deleted in this fork; schema
     changes instead regenerate `schema.sqlite` via `server/probes/gen-sqlite-schema.ts`
     and bump the bootstrap version), and UI/API areas the product removed
     (uploads, database backup/restore, DB engine config knobs).
     Append each entry to `FORK-SKIPPED.md` with the upstream commit id.

3. **Schema changes**: upstream `server/src/schema/**` diffs must be reflected
   in the SQLite bootstrap. Regenerate the schema, bump the bootstrap version,
   run the medium suite — FK/trigger/audit-hop emulations in the generator are
   the risky spots.

4. **Verify ladder** (all must pass before tagging):
   - `pnpm -C server exec tsc --noEmit`
   - unit: `mise run ci-unit` (must use `--config test/vitest.config.mjs`)
   - medium: `IMMICH_TEST_DB=sqlite node_modules/.bin/vitest run --config test/vitest.config.medium.mjs`
   - live production boot + HTTP loop (signup→login→scan→search→download): the
     suites do not catch boot-only bugs; this fork has bled on exactly that.
   - push `main`, CI green, then tag `vX.Y.Z` and verify the published ghcr
     manifest (`v*` tag pushes publish `ghcr.io/haasanen/immich-sqlite:<tag>`).

5. **Product invariants that must never regress** (no config option may
   reappear for any of them):
   - single engine: SQLite, always (no `DB_ENGINE`, no `DB_URL`, no PG driver)
   - no Redis/BullMQ anywhere (embedded in-process queue)
   - browse-only: uploads rejected server-side (`NODE_ENV=test` is the only
     exemption, used by the automated harness)
   - deploy requires **zero** environment variables.

## Where our port lives

- Fork-new adapter files (safe zone, never conflict with upstream):
  `server/src/utils/sqlite-database.ts` (SQL rewriter, vector/JSON helpers,
  SQLite bootstrap), `server/src/utils/sql-json*.ts`,
  `server/src/repositories/local-queue.ts`, `server/src/schema/schema.sqlite.ts`,
  `server/src/utils/browse-only.ts`.
- Modified upstream files (translate zone): repositories/services carrying the
  dialect-neutral SQL and the browse-only gate.
