import { DynamicModule, Module } from '@nestjs/common';
import { join } from 'node:path';
import { QueueName } from 'src/enum.js';
import { LocalQueue, LocalQueueOptions } from 'src/repositories/local-queue.js';

/** Same token shape BullMQ used (@nestjs/bullmq getQueueToken), kept identical so call sites are unchanged. */
export const getQueueToken = (name?: string) => (name ? `QUEUE_${name}` : 'QUEUE');

export const queueDbPath = (): string =>
  process.env.IMMICH_QUEUE_DB ??
  join(process.env.IMMICH_QUEUE_DIR ?? process.env.IMMICH_MEDIA_LOCATION ?? '/data', 'immich-queue.db');

@Module({})
export class LocalQueueModule {
  static register(queueNames: QueueName[], options: Omit<LocalQueueOptions, 'dbPath'> = {}): DynamicModule {
    const dbPath = queueDbPath();
    const providers: { provide: string; useFactory: () => LocalQueue }[] = queueNames.map((name) => ({
      provide: getQueueToken(name),
      useFactory: () => new LocalQueue(name, { dbPath, ...options }),
    }));

    return { module: LocalQueueModule, providers, exports: providers.map((p) => p.provide), global: true };
  }
}
