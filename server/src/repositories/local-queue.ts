import Sqlite from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

/**
 * Embedded job queue replacing BullMQ (Redis). Same public surface as consumed
 * by JobRepository: add/addBulk/pause/resume/drain/clean/getJobCounts/getJobs/
 * getJob/remove/getActiveCount/isPaused + a worker with adjustable concurrency.
 * Durable state lives in a local SQLite file; queue is single-process by design.
 */

export enum LocalJobStatus {
  Waiting = 'waiting',
  Delayed = 'delayed',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed',
}

export type LocalJobsOptions = {
  jobId?: string;
  delay?: number;
  priority?: number;
  attempts?: number;
  backoffStrategy?: number | number[];
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  deduplication?: { id: string };
};

export type LocalQueueOptions = {
  dbPath: string;
  defaultJobOptions?: LocalJobsOptions;
};

export type LocalJobData = { id: string; name: string; timestamp: number; data: any };

const DEFAULT_PRIORITY = 2_097_152;
const DEDUP_WINDOW_MS = 30_000;
const POLL_INTERVAL_MS = 200;

type Row = {
  id: string;
  name: string;
  data: string;
  opts: string | null;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  delayUntil: number | null;
  createdAt: number;
  failedReason: string | null;
};

const openDb = (dbPath: string): Database => {
  const db = new Sqlite(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      opts TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 1,
      delayUntil INTEGER,
      createdAt INTEGER NOT NULL,
      finishedAt INTEGER,
      dedupId TEXT,
      failedReason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON jobs(queue, status, priority, createdAt);
    CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(queue, dedupId, createdAt);
  `);
  // crash recovery: any job left 'active' from a previous process is re-queued.
  db.prepare('UPDATE jobs SET status = ?, attempts = attempts + 1 WHERE status = ?').run(
    LocalJobStatus.Waiting,
    LocalJobStatus.Active,
  );
  return db;
};

export class LocalQueue {
  private db: Sqlite.Database;
  private paused = false;
  private wake?: () => void;
  private workers: LocalWorker[] = [];

  constructor(
    public readonly name: string,
    private options: LocalQueueOptions,
  ) {
    this.db = openDb(options.dbPath);
  }

  setWakeup(fn: () => void) {
    this.wake = fn;
  }

  attachWorker(worker: LocalWorker) {
    this.workers.push(worker);
  }

  detachWorker(worker: LocalWorker) {
    this.workers = this.workers.filter((w) => w !== worker);
  }

  getWorkers(): { rawname?: string }[] {
    return this.workers;
  }

  private defaults(): LocalJobsOptions {
    return this.options.defaultJobOptions ?? {};
  }

  add(name: string, data: any, opts?: LocalJobsOptions): { id: string } {
    const o = { ...this.defaults(), ...opts };
    const now = Date.now();

    if (o.deduplication?.id) {
      const existing = this.db
        .prepare('SELECT id FROM jobs WHERE queue = ? AND dedupId = ? AND createdAt > ?')
        .get(this.name, o.deduplication.id, now - DEDUP_WINDOW_MS);
      if (existing) {
        return existing as { id: string };
      }
    }

    const id = o.jobId ?? randomUUID();
    const delayed = !!o.delay && o.delay > 0;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, queue, name, data, opts, status, priority, maxAttempts, delayUntil, createdAt, dedupId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.name,
        name,
        JSON.stringify(data ?? {}),
        JSON.stringify(o),
        delayed ? LocalJobStatus.Delayed : LocalJobStatus.Waiting,
        o.priority ?? DEFAULT_PRIORITY,
        o.attempts ?? 1,
        delayed ? now + (o.delay as number) : null,
        now,
        o.deduplication?.id ?? null,
      );
    this.wake?.();
    return { id };
  }

  addBulk(jobs: { name: string; data: any; options?: LocalJobsOptions }[]): { id: string }[] {
    const out: { id: string }[] = [];
    const tx = this.db.transaction((items: typeof jobs) => {
      for (const job of items) {
        out.push(this.addSync(job.name, job.data, job.options));
      }
    });
    tx(jobs);
    this.wake?.();
    return out;
  }

  private addSync(name: string, data: any, opts?: LocalJobsOptions): { id: string } {
    const o = { ...this.defaults(), ...opts };
    const now = Date.now();
    if (o.deduplication?.id) {
      const existing = this.db
        .prepare('SELECT id FROM jobs WHERE queue = ? AND dedupId = ? AND createdAt > ?')
        .get(this.name, o.deduplication.id, now - DEDUP_WINDOW_MS);
      if (existing) {
        return existing as { id: string };
      }
    }
    const id = o.jobId ?? randomUUID();
    const delayed = !!o.delay && o.delay > 0;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, queue, name, data, opts, status, priority, maxAttempts, delayUntil, createdAt, dedupId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.name,
        name,
        JSON.stringify(data ?? {}),
        JSON.stringify(o),
        delayed ? LocalJobStatus.Delayed : LocalJobStatus.Waiting,
        o.priority ?? DEFAULT_PRIORITY,
        o.attempts ?? 1,
        delayed ? now + (o.delay as number) : null,
        now,
        o.deduplication?.id ?? null,
      );
    return { id };
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.wake?.();
  }

  drain(): number {
    const info = this.db
      .prepare(`DELETE FROM jobs WHERE queue = ? AND status IN (?, ?)`)
      .run(this.name, LocalJobStatus.Waiting, LocalJobStatus.Delayed);
    return info.changes;
  }

  clean(grace: number, limit: number, type: 'failed' | 'completed' = 'failed'): string[] {
    const rows = this.db
      .prepare(
        `DELETE FROM jobs WHERE queue = ? AND status = ? AND finishedAt <= ?
         RETURNING id`,
      )
      .all(this.name, type, Date.now() - grace);
    void limit;
    return (rows as { id: string }[]).map((r) => r.id);
  }

  getActiveCount(): number {
    const row = this.db
      .prepare('SELECT count(*) c FROM jobs WHERE queue = ? AND status = ?')
      .get(this.name, LocalJobStatus.Active);
    return (row as { c: number }).c;
  }

  getJobCounts(...states: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const state of states) {
      let sql = 'SELECT count(*) c FROM jobs WHERE queue = ?';
      const params: any[] = [this.name];
      switch (state) {
        case 'waiting': {
          sql += this.paused ? ' AND 0' : " AND status = 'waiting'";
          break;
        }
        case 'paused': {
          sql += this.paused ? " AND status = 'waiting'" : ' AND 0';
          break;
        }
        case 'delayed': {
          sql += " AND status = 'delayed'";
          break;
        }
        case 'active': {
          sql += " AND status = 'active'";
          break;
        }
        case 'completed': {
          sql += " AND status = 'completed'";
          break;
        }
        case 'failed': {
          sql += " AND status = 'failed'";
          break;
        }
        default: {
          sql += ' AND 0';
        }
      }
      out[state] = (this.db.prepare(sql).get(...params) as { c: number }).c;
    }
    return out;
  }

  getJobs(states: string[], start = 0, num = 1000): LocalJobData[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, data, createdAt FROM jobs WHERE queue = ? AND status IN (${states.map(() => '?').join(',')})
         ORDER BY createdAt ASC LIMIT ? OFFSET ?`,
      )
      .all(this.name, ...states, num, start) as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, timestamp: r.createdAt, data: JSON.parse(r.data) }));
  }

  getJob(id: string): LocalJobData | undefined {
    const r = this.db
      .prepare('SELECT id, name, data, createdAt FROM jobs WHERE queue = ? AND id = ?')
      .get(this.name, id) as any;
    if (!r) {
      return undefined;
    }
    return { id: r.id, name: r.name, timestamp: r.createdAt, data: JSON.parse(r.data) };
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE queue = ? AND id = ?').run(this.name, id);
  }

  /** internal worker API */
  claim(max: number): Row[] {
    if (this.paused) {
      return [];
    }
    const now = Date.now();
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'active' WHERE id IN (
           SELECT id FROM jobs WHERE queue = ? AND (status = 'waiting' OR (status = 'delayed' AND delayUntil <= ?))
           ORDER BY priority ASC, createdAt ASC LIMIT ?
         ) RETURNING id, name, data, opts, status, priority, attempts, maxAttempts, delayUntil, createdAt, failedReason`,
      )
      .all(this.name, now, max) as Row[];
  }

  finish(row: Row, error?: Error) {
    const o: LocalJobsOptions = row.opts ? JSON.parse(row.opts) : {};
    if (!error) {
      if (o.removeOnComplete ?? true) {
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
      } else {
        this.db.prepare("UPDATE jobs SET status = 'completed', finishedAt = ? WHERE id = ?").run(Date.now(), row.id);
      }
      return;
    }

    if (row.attempts + 1 < row.maxAttempts) {
      const backoff = this.backoff(o, row.attempts);
      this.db
        .prepare("UPDATE jobs SET status = 'waiting', attempts = attempts + 1, delayUntil = ? WHERE id = ?")
        .run(Date.now() + backoff, row.id);
      return;
    }

    if (o.removeOnFail ?? false) {
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id);
    } else {
      this.db
        .prepare(
          "UPDATE jobs SET status = 'failed', finishedAt = ?, attempts = attempts + 1, failedReason = ? WHERE id = ?",
        )
        .run(Date.now(), error.message, row.id);
    }
  }

  private backoff(o: LocalJobsOptions, attempt: number): number {
    const b = o.backoffStrategy;
    if (Array.isArray(b)) {
      return b[Math.min(attempt, b.length - 1)] ?? 0;
    }
    if (typeof b === 'number') {
      return b;
    }
    return Math.min(1000 * 2 ** attempt, 30_000);
  }

  close() {
    this.db.close();
  }
}

export class LocalWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = 0;
  private closed = false;

  constructor(
    private queue: LocalQueue,
    private processor: (job: LocalJobData) => unknown,
    public concurrency: number = 1,
    public rawname?: string,
  ) {
    queue.setWakeup(() => this.tick());
    queue.attachWorker(this);
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.tick();
  }

  private tick() {
    if (this.closed) {
      return;
    }
    const slots = this.concurrency - this.running;
    if (slots <= 0) {
      return;
    }
    const rows = this.queue.claim(slots);
    for (const row of rows) {
      this.running++;
      const job: LocalJobData = { id: row.id, name: row.name, timestamp: row.createdAt, data: JSON.parse(row.data) };
      void Promise.try(() => this.processor(job))
        .then(() => this.queue.finish(row))
        .catch((error: Error) => this.queue.finish(row, error))
        .finally(() => {
          this.running--;
          this.tick();
        });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.detachWorker(this);
    if (this.timer) {
      clearInterval(this.timer);
    }
    while (this.running > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
