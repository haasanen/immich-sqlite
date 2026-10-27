# FORK-REDIS — Redis/BullMQ surface & local replacement design

Method: exhaustive grep of server/src + package.json (v3.3.5). All claims cite file:line.

## 1. Complete inventory (non-spec, non-test)

| File | Redis-family imports | Role |
|---|---|---|
| src/app.module.ts:1 | `@nestjs/bullmq` BullModule | registers queues (DI tokens) |
| src/repositories/job.repository.ts:1,4 | bullmq `Queue, Worker, JobsOptions, getQueueToken` | **the entire queue layer (298 lines)** |
| src/repositories/app.repository.ts:2,3 | `@socket.io/redis-adapter`, ioredis | socket.io pub/sub adapter for websocket fan-out |
| src/middleware/websocket.adapter.ts:3,4 | same | picks redis adapter when redis config present |
| src/repositories/config.repository.ts:2,4,7,209 | builds `RedisOptions`/`QueueOptions`, `ioredis://` URL parsing | connection config only |
| src/repositories/telemetry.repository.ts:7 | OTel instrumentation-ioredis | cosmetic; removable |

No other redis usage: NO app-level caching in redis (app settings cache is
in-process; verified by absence of ioredis imports elsewhere).

## 2. Exact BullMQ feature surface used (job.repository.ts)

Queue methods: add (with `jobId`, `delay`, `priority`, `deduplication.id` — options
only set for the 6 jobs in getJobOptions(), lines 257-284), addBulk (224),
getActiveCount (159), isPaused/pause/resume (164-172), drain (176),
clean(0,1000,type) (180), getJobCounts(active,completed,failed,delayed,waiting,paused) (183-191),
getJobs(status,0,1000) (250), getJob(id)+job.remove() (293-295), getWorkers() (119).
Worker: constructed once per QueueName with `concurrency` (settable at runtime,
line 154) and processor emitting 'JobRun' -> handlers (94-98).
checkWorkers() (115-135) only verifies a microservices worker is *connected* —
in a single-process install this is trivially true and can be constant.

Queues: `Object.values(QueueName)` (enum.ts) — Back*ground, BackgroundTask,
Microservices? (exact set at enum.ts QueueName; counted: 4 queues).

## 3. Restart semantics — proven self-healing

- queue.service.ts:83-90 AppBootstrap: api worker only watchWorkers();
  microservices worker startWorkers(). No dependency on redis-persisted state at boot.
- **Nightly reconciliation** (queue.service.ts:51-81 cron + 267-298 handleNightlyJobs):
  re-queues `AssetGenerateThumbnailsQueueAll {force:false}`,
  `FacialRecognitionQueueAll {force:false,nightly:true}`, cleanup/audit jobs,
  subject to nightlyTasks config. Job handlers are idempotent (skip existing artifacts).
- Consequence: an in-memory queue that LOSES pending jobs on crash/restart is
  recoverable by design — nightly jobs re-enqueue missing work. Acceptable per
  owner constraint ("Redis is just a temporary in-memory store anyway").
- Optional hardening (phase 1 extra): persist pending rows to SQLite `queue_jobs`
  table; reload into memory on boot. Cheap, keeps restart-exactness.

## 4. Replacement design — drop-in `local-queue` module

Keep JobRepository 95% unchanged: implement the used surface as a class with the
SAME method names as bullmq Queue/Worker in `src/repositories/local-queue.ts`:

- `LocalQueue.add(name, data, opts)`: INSERT into better-sqlite3 `queue_jobs`
  (id TEXT PK opts.jobId OR uuid, queue, name, data JSON, priority INT default 0,
  dedup_id TEXT UNIQUE-nullable INSERT OR IGNORE, delay_until INT ms,
  state waiting/delayed/active/completed/failed, created_at).
- `addBulk`: transaction insert.
- `LocalWorker(queue, cb, {concurrency})`: setInterval+immediate ticker claims
  rows `WHERE queue=? AND state IN ('waiting','delayed' AND due)` ordered by
  priority DESC, created_at ASC with an UPDATE ... RETURNING claim (single-writer
  WAL makes races safe), runs cb, sets state, prunes completed/failed per
  removeOnComplete semantics used by clean().
- pause/resume/isPaused: per-queue flag table row. drain: DELETE waiting.
  clean(0,1000,type): DELETE completed|failed LIMIT 1000.
  getJobCounts: one GROUP BY state. getJobs: SELECT LIMIT 1000. getActiveCount:
  count state='active'. getWorkers(): return [{rawname:'local'}] when worker
  started (satisfies checkWorkers; or patch checkWorkers to constant true).
- `getQueueToken` DI: replace BullModule.forRoot/register in app.module.ts with
  our own module providing same tokens.

## 5. Socket.io adapter

websocket.adapter.ts already branches on config (redis vs default). Replace redis
branch with socket.io's built-in in-process (default) adapter — single node needs
no pub/sub at all. app.repository.ts: drop create/createAdapter redis functions
(used only by that adapter).

## 6. Removal checklist (end-state: zero redis)

package.json: drop bullmq, @nestjs/bullmq, ioredis, @socket.io/redis-adapter,
@opentelemetry/instrumentation-ioredis. config.repository.ts: drop getRedisOptions
/`ioredis://` parsing (209) and env `REDIS_*`. docker: no valkey container.
env: remove REDIS_URL/REDIS_SOCKET paths from .env contract.

Risk register: (a) delayed/repeat semantics must honor jobIds dedup for
NotifyAlbumUpdate (jobId PK handles it); (b) clean() limits must cap table growth —
DELETE completed rows older than N via nightly; (c) getJobs DTO id/timestamp shape
must match queue.dto.ts fields (id, name, timestamp, data).
