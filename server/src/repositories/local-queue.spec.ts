import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalQueue, LocalWorker } from 'src/repositories/local-queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LocalQueue', () => {
  const open: { queue?: LocalQueue; workers: LocalWorker[] } = { workers: [] };

  function makeQueue(name = 'test') {
    open.queue = new LocalQueue(name, {
      dbPath: ':memory:',
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
    });
    return open.queue;
  }

  function makeWorker(queue: LocalQueue, fn: (job: any) => unknown, concurrency = 1, rawname?: string) {
    const worker = new LocalWorker(queue, fn, concurrency, rawname);
    open.workers.push(worker);
    return worker;
  }

  const count = (queue: LocalQueue, state: string): number => {
    const counts = queue.getJobCounts(state);
    return counts[state];
  };

  afterEach(async () => {
    for (const w of open.workers) {
      await w.close();
    }
    open.workers = [];
    open.queue?.close();
    open.queue = undefined;
  });

  it('runs jobs in FIFO order', async () => {
    const queue = makeQueue();
    const seen: string[] = [];
    makeWorker(queue, (job) => void seen.push(job.name));
    queue.add('a', {});
    queue.add('b', {});
    queue.add('c', {});
    await sleep(500);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('honors priority (lower number first)', async () => {
    const queue = makeQueue();
    queue.add('low', { tag: 'low' });
    queue.add('high', { tag: 'high' }, { priority: 1 });
    const seen: string[] = [];
    makeWorker(queue, (job) => void seen.push(job.data.tag));
    await sleep(500);
    expect(seen).toEqual(['high', 'low']);
  });

  it('delays jobs', async () => {
    const queue = makeQueue();
    const t0 = Date.now();
    let ran = 0;
    makeWorker(queue, () => void ran++);
    queue.add('late', {}, { delay: 300 });
    await sleep(150);
    expect(ran).toBe(0);
    expect(count(queue, 'delayed')).toBe(1);
    await sleep(500);
    expect(ran).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it('deduplicates by jobId', () => {
    const queue = makeQueue();
    const j1 = queue.add('dup', { x: 1 }, { jobId: 'fixed-id' });
    const j2 = queue.add('dup', { x: 2 }, { jobId: 'fixed-id' });
    expect(j2.id).toBe(j1.id);
    const rows = queue.getJobs(['waiting', 'active', 'completed', 'delayed']);
    expect(rows.filter((r) => r.id === j1.id)).toHaveLength(1);
  });

  it('deduplicates within window by dedup id', () => {
    const queue = makeQueue();
    const j1 = queue.add('dd', {}, { deduplication: { id: 'k' } });
    const j2 = queue.add('dd', {}, { deduplication: { id: 'k' } });
    expect(j2.id).toBe(j1.id);
  });

  it('retries failed jobs up to attempts with backoff', async () => {
    const queue = makeQueue();
    let calls = 0;
    makeWorker(queue, () => {
      calls++;
      if (calls < 3) {
        throw new Error('boom');
      }
    });
    queue.add('flaky', {}, { attempts: 3, backoffStrategy: 10 });
    await sleep(1000);
    expect(calls).toBe(3);
    expect(count(queue, 'failed')).toBe(0);
  });

  it('keeps failed jobs when removeOnFail is false', async () => {
    const queue = makeQueue();
    makeWorker(queue, () => {
      throw new Error('nope');
    });
    queue.add('dead', {}, { attempts: 1, removeOnFail: false });
    await sleep(400);
    expect(count(queue, 'failed')).toBe(1);
    const jobs = queue.getJobs(['failed']);
    expect(jobs.map((j) => j.name)).toEqual(['dead']);
  });

  it('pause stops dispatch; resume continues', async () => {
    const queue = makeQueue();
    let ran = 0;
    makeWorker(queue, () => void ran++);
    queue.pause();
    queue.add('held', {});
    await sleep(300);
    expect(ran).toBe(0);
    const counts = queue.getJobCounts('waiting', 'paused');
    expect(counts.waiting).toBe(0);
    expect(counts.paused).toBe(1);
    queue.resume();
    await sleep(400);
    expect(ran).toBe(1);
  });

  it('drain removes waiting and delayed jobs', () => {
    const queue = makeQueue();
    queue.add('gone', {});
    queue.add('gone2', {}, { delay: 5000 });
    const removed = queue.drain();
    expect(removed).toBe(2);
    expect(count(queue, 'waiting')).toBe(0);
  });

  it('clean removes failed jobs after grace', async () => {
    const queue = makeQueue();
    makeWorker(queue, () => {
      throw new Error('x');
    });
    queue.add('dead1', {}, { attempts: 1, removeOnFail: false });
    queue.add('dead2', {}, { attempts: 1, removeOnFail: false });
    await sleep(400);
    const cleaned = queue.clean(0, 1000, 'failed');
    expect(cleaned).toHaveLength(2);
    expect(count(queue, 'failed')).toBe(0);
  });

  it('getActiveCount reflects in-flight jobs', async () => {
    const queue = makeQueue();
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    makeWorker(queue, () => gate, 2);
    queue.add('slow', {});
    await sleep(300);
    expect(queue.getActiveCount()).toBe(1);
    resolve();
    await sleep(300);
    expect(queue.getActiveCount()).toBe(0);
  });

  it('getJob/remove supports deprecated removeJob path', () => {
    const queue = makeQueue();
    const { id } = queue.add('removable', {}, { jobId: 'rm-1' });
    const job = queue.getJob(id);
    expect(job).toBeDefined();
    queue.remove(id);
    const gone = queue.getJob(id);
    expect(gone).toBeUndefined();
  });

  it('crash recovery re-queues active jobs on reopen', () => {
    const file = join(tmpdir(), `local-queue-crash-${Date.now()}.db`);
    const q1 = new LocalQueue('crash', { dbPath: file });
    open.queue = q1;
    q1.add('stuck', {});
    expect(q1.claim(1)).toHaveLength(1);
    q1.close(); // no clean finish

    const q2 = new LocalQueue('crash', { dbPath: file });
    open.queue = q2;
    expect(count(q2, 'waiting')).toBe(1);
  });

  it('reports attached workers for presence check', async () => {
    const queue = makeQueue();
    const worker = makeWorker(queue, () => null, 1, 'q:w:microservices');
    await sleep(50);
    expect(queue.getWorkers().some((w) => w.rawname?.endsWith(':w:microservices'))).toBe(true);
    await worker.close();
    expect(queue.getWorkers()).toHaveLength(0);
  });
});
