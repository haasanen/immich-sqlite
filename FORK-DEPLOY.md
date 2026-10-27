# Deploying this fork

This fork runs Immich on **SQLite** with an **embedded job queue** — no Postgres,
no Redis, one database file, one machine. The server image is
`ghcr.io/haasanen/immich-sqlite`, versioned by the house convention
`<upstream-version>-h<N>` (upstream version verbatim + fork build counter):
this tree ports upstream `v3.3.5`, so releases are `v3.3.5-h1`, `v3.3.5-h2`,
... See FORK-SYNC.md for the porting and release procedure.

## How files get in (and why that's not an "upload")

This fork has no upload path: the API rejects uploads and the web app hides every
upload affordance. Photos enter through the **external library** you mount
read-only. Two detection mechanisms, both verified live:

- **Automatic scan (default ON)**: every library is rescanned on a cron
  (default: daily at midnight, configurable per-instance in admin settings ->
  External Libraries). Incremental: checkpointed by size+mtime, so a re-scan
  only processes changed files. Manual "scan now" available in the same screen.
- **File watcher (default OFF)**: set `library.watch.enabled: true` in the
  admin config JSON for near-real-time import of new files and removal of
  externally-deleted ones. Caveat: it uses filesystem events (inotify);
  network mounts (NFS/CIFS) generally do not emit them -- on those, rely on
  the scan cron.

Semantics worth knowing:
- New external file -> imported, then the full derivative pipeline runs
  (thumbnails, previews, metadata, face/smart-search ML). Derivatives live on
  the /data volume; your library mount is never written.
- File deleted outside immich: the asset is marked **offline** (hidden from
  the library, restorable if the file comes back) -- by the watcher on unlink
  (measured ~2s) or by the next scan. Your files are never touched either way.
- Measured on a live server: watcher imports a new file in ~6s; a file missed
  by the watcher is picked up by the next scheduled scan.
- Favorites, albums, tags, people names, memories -- all metadata edits are
  stored in the immich database, never in your photo files. Browse-only is
  about bytes on disk, not about organizing your library.

## docker-compose.yml

```yaml
services:
  immich-server:
    image: ghcr.io/haasanen/immich-sqlite:v3.3.5-h2
    restart: always
    ports:
      - "2283:2283"
    volumes:
      - ./immich:/data                          # DB file + generated thumbnails etc.
      - /share/pictures:/pictures:ro            # your library, READ-ONLY to immich

  # optional: ML (CLIP / faces / smart search / OCR). Pinned to the same
  # upstream version this fork line ports. For Intel GPU acceleration:
  # enable OpenVINO in Administration -> Settings -> Machine Learning and
  # pass through the GPU with devices: ["/dev/dri"].
  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.3.5
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
