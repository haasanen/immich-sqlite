# FORK-SQL — rewrite plan for PG-heavy repository SQL (v3.3.5)

Audit: scripts/sql-audit.json (scripts/classify_sql.py). Totals: 37 files /
10,571 lines — 20 easy / 12 medium / 5 heavy. Evidence below is grep-cited.

## Construct → SQLite recipe (one example per CONSTRUCT type, not per hit)

### A. `= ANY($n::uuid[])` — the dominant pattern (search x49, person x6, +)
search.repository.sql:39,59,99,144,194…  `and "asset"."ownerId" = any ($3::uuid[])`
-> `and "asset"."ownerId" IN (SELECT value FROM json_each(?))`
(param passed as JSON array; SQLite has no array param type).
Same recipe covers `unnest($2::uuid[]) as "assetId"` (album:317,354) —
`unnest($3::album_user_role_enum[]) as "role"` (album:341) becomes a
json_each join too; zipped multi-unnest (album:340–341) becomes
`json_each(?) JOIN json_each(?) ON key=key` (positional zip via json_each "key").

### B. array_agg / array ctor / '{}' fallback — asset.repository.sql:453
`coalesce(array_agg("duration"), '{}') as "duration"` ->
`coalesce(json_group_array("duration"), json_array())`; consumers parse JSON.
Text[] columns (`"asset_exif"."lockedProperties" || $3`,
`unnest(... "lockedProperties")` asset:14,26,41,60) — column redesign:
store JSON TEXT (schema phase), reads via json_each, concat via
`json_group_array` over union. Flag: schema change, not query-only.

### C. date_trunc + AT TIME ZONE 'UTC' — asset:345,355,363,371,396,437,447; album:171,174; memory x6
All tz clauses are 'UTC' no-ops. Recipe: drop `AT TIME ZONE 'UTC'` entirely;
`date_trunc('DAY', x)` -> `strftime('%Y-%m-%dT00:00:00Z', x)` (MONTH: '%Y-%m-01T00:00:00Z');
`(x AT TIME ZONE 'UTC')::date::text` (asset:371) -> `strftime('%Y-%m-%d', x)`.
Dates stored ISO-UTC TEXT throughout; tz handling stays app-side (already UTC).

### D. pg_trgm similarity for geo/people — search:262–269, person:1032,
geodata-places.table.ts:7,12,17 (`f_unaccent(name) gin_trgm_ops`)
`coalesce(f_unaccent(name) <->>> f_unaccent($5), 0.1)` -> FTS5 trigram tokenizer:
shadow FTS5 table per searchable text (person.name, geodata names) with
`tokenize="trigram remove_diacritics 2"`; rank from bm25; keep LIKE fallback
for substring edge cases. Flag: NOT a drop-in operator — new FTS shadow tables
maintained by triggers (or app-level writes). f_unaccent custom function (schema
phase) deleted entirely.

### E. json path reads — person:224,423; search x4
`cast(value -> 'people' ->> 'minimumFaces' as integer)` ->
`json_extract(value, '$.people.minimumFaces')` — exact equivalent, mechanical.

### F. upserts + RETURNING — tag (178 L, only hits: on_conflict x5, returning x5),
album x3, cluster, ocr, activity, person x3, asset x1, move, album.user
SQLite native (since 3.24/3.35): MECHANICAL — no change (verified this box
executes `insert ... returning`). Note ON CONFLICT target index must exist (same as PG).

### G. casts — x49 search, x39 asset, x21 person, x18 memory…
`::uuid`/`::text` -> drop (SQLite untyped affinity); `::date` -> strftime;
`::integer` -> CAST AS INTEGER; `::interval`/arithmetic (asset:396
`localDateTime AT TIME ZONE 'UTC' - fileCreatedAt at time zone 'UTC'` for
duration compare) -> `(julianday(a)-julianday(b))` day arithmetic. Semi-mechanical
(106 casts total across files: scriptable with review).

### H. geo distance — search x4 `<@>` / earthdistance operators
-> haversine in SQL with math funcs:
`2*r*asin(sqrt(sin((radians(lat2)-radians(lat1))/2)^2 +
cos(radians(lat1))*cos(radians(lat2))*sin((radians(lon2)-radians(lon1))/2)^2))`
(verified this box: math funcs compiled in python build; must enable
SQLITE_ENABLE_MATH_FUNCTIONS in the image's better-sqlite3 build — flag.)

### I. misc — asset:542 `unnest(array[$1]::text[]) as "path"` -> json_each(?);
generate_series x1 (asset) -> recursive CTE; window functions native;
`<=>` x7 -> `IS` (SQLite null-safe equality); ILIKE x3 -> LIKE (ascii case)
or lower() = lower(); `EXTRACT/date_trunc` -> strftime.

## Effort ranking (heavy 5)
1. search.repository.sql (1,948 L) — hardest: A x49 + D + H + G x49.
2. asset.repository.sql (710 L) — C x20 + B (+ lockedProperties schema change).
3. person.repository.sql (1,418 L) — A x6 + D + E, mostly easy A/G.
4. album.repository.sql (449 L) — A zip + C + F.
5. tag.repository.sql (178 L) — F only: mechanical, zero semantic change.

## % of SQL lines edited (method: audit token counts)
Method: lines containing >=1 PG-only construct per audit JSON (upper bound;
many hits share a line): ~1,180 lines flagged across all 37 files (~11%),
of which ~70% are pure A/G conversions scriptable by regex+json_each templates.
Genuinely NEW structure needed: FTS5 shadow tables (D), vec0 tables (ML),
JSON columns (B) — schema-phase work, already scoped in FORK-DB.md.

No construct found that is impossible in SQLite; three need design (not
translation): array columns, trgm indexes, vector indexes.

## Verified against the runtime binding (better-sqlite3 12.11.1, Node 24)
- native build: node-gyp OK; math funcs (cos/asin/radians) present; FTS5
  trigram tokenizer present.
- sqlite-vec v0.1.9 vec0 512d KNN loads and queries IN better-sqlite3
  (not just sqlite CLI): new Database(path, {allowExtension:true}) +
  db.loadExtension(); inserts need BigInt/INTEGER rowids; KNN =
  WHERE embedding match ? AND k = N (JSON array param); no
  vec_quantize_f32 in this version. 50-vec probe returned exact-nearest
  rowid with distance 0.
