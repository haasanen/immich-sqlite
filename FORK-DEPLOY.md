# Deploying this fork

This fork runs Immich on **SQLite** with an **embedded job queue** — no Postgres,
no Redis, one database file, one machine. The server image is
`ghcr.io/haasanen/immich-sqlite`, versioned like Immich itself (the fork's
first release line is `v3.3.6`, based on upstream `v3.3.5`; `v3.3.7` adds the
browse-only web UI and the single-engine cleanup).

## docker-compose.yml

```yaml
services:
  immich-server:
    image: ghcr.io/haasanen/immich-sqlite:v3.3.5-h1
    restart: always
    ports:
      - "2283:2283"
    volumes:
      - ./immich:/data                          # DB file + generated thumbnails etc.
      - /share/pictures:/pictures:ro            # your library, READ-ONLY to immich

  # optional: ML (CLIP / faces / smart search). Uses Intel CPU/GPU via OpenVINO.
  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:release
    restart: always
    volumes:
      - ./model-cache:/cache
```

That's the whole stack: one service (plus optional ML). No Postgres, no Redis.

## Configuration

There is none. The server is a browse-only photo library on a single SQLite
file — that is the product, not a mode. The library DB (`immich.db`) and the
embedded job queue (`immich-queue.db`) default onto the `/data` volume
automatically, so `./immich:/data` is all persistence you need. Uploads cannot be re-enabled by any
setting; photos enter the library only via read-only external library scans.
(Upstream's Postgres/queue configuration variables are not read by this fork.)

## Feeding the library (read-only)

1. Start the server, create the admin account in the web UI.
2. In **Administration → External libraries**, add a library:
   - Import path: `/pictures` (the read-only mount above)
   - Exclusion pattern: e.g. `**/.@eaDir/**`, `**/.thumbnails/**`
3. Click **Scan**. Assets appear as normal — they are *owned* by the library,
   not uploaded. Changes on disk are picked up on later scans; deletion is
   detected but the files themselves are never modified (mount is `:ro`).

## Notes / current limitations on SQLite

- Reverse geocoding (map data import) is Postgres-only upstream; on SQLite the
  geodata import is skipped. Places/albums-by-location features are
  unavailable; dates, people, duplicates, favourites, search-by-name all work.
- Full-text search across all supported fields uses SQLite FTS; unaccented
  matching is ASCII-only.
