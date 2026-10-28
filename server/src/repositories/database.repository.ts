import { Injectable } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import z from 'zod';
import { GenerateSql } from 'src/decorators.js';
import { DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
// eslint-disable-next-line import-x/no-duplicates
import 'src/schema/index.js'; // make sure all schema definitions are imported for schemaFromCode
// eslint-disable-next-line import-x/no-duplicates
import { DB } from 'src/schema/index.js';
import { bootstrapSqliteSchema } from 'src/utils/sqlite-database.js';

export const probes: Record<VectorIndex, number> = {
  [VectorIndex.Clip]: 1,
  [VectorIndex.Face]: 1,
};

@Injectable()
export class DatabaseRepository {
  private readonly asyncLock = new AsyncLock();

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(DatabaseRepository.name);
  }

  async shutdown() {
    await this.db.destroy();
  }

  @GenerateSql({ params: [[DatabaseExtension.Vector]] })
  @GenerateSql()
  async vacuum({ analyze = false, table }: { analyze?: boolean; table?: keyof DB } = {}): Promise<void> {
    try {
      await sql`VACUUM ${sql.raw(analyze ? 'ANALYZE' : '')} ${sql.raw(table ?? '')}`.execute(this.db);
    } catch (error) {
      this.logger.warn(`Failed to vacuum ${table || 'database'}: ${error}`);
      this.logger.warn('If using Docker, consider increasing shm_size for the database.');
    }
  }

  reindex(table: keyof DB, { concurrently = false } = {}): Promise<unknown> {
    return sql`REINDEX TABLE ${sql.raw(concurrently ? 'CONCURRENTLY' : '')} ${sql.raw(table)}`.execute(this.db);
  }

  // SQLite port: VACUUM INTO is the engine-native online backup (the pg_dump
  // equivalent): a standalone, consistent copy of the live database written by
  // the engine itself without blocking readers.
  backupDatabase(filePath: string): Promise<unknown> {
    return sql`VACUUM INTO ${filePath}`.execute(this.db);
  }

  async getSqliteVersion(): Promise<string> {
    const { rows } = await sql<{ v: string }>`select sqlite_version() as v`.execute(this.db);
    return rows[0].v;
  }

  getMigrations() {
    return this.db.selectFrom('kysely_migrations').select(['name', 'timestamp']).orderBy('name', 'asc').execute();
  }

  async getDimensionSize(table: string, column = 'embedding'): Promise<number> {
    // SQLite port: there is no pg_attribute typmod for a vector column type —
    // embeddings live as JSON text. The effective dimension is tracked in
    // system_metadata when the model's dimension is applied.
    const { rows } = await sql<{ value: string }>`
      select "value" from "system_metadata" where "key" = ${`smart-search-dimension-${table}`}
    `.execute(this.db);
    const dimSize = Number(rows[0]?.value);
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      this.logger.warn(`Could not retrieve dimension size of column '${column}' in table '${table}', assuming 512`);
      return 512;
    }
    return dimSize;
  }

  async setDimensionSize(dimSize: number): Promise<void> {
    if (
      !z
        .int()
        .min(1)
        .max(2 ** 16)
        .safeParse(dimSize).success
    ) {
      throw new Error(`Invalid CLIP dimension size: ${dimSize}`);
    }

    // SQLite port: embeddings are JSON text (no vector(n) column to re-type and
    // no vchordrq index to rebuild). Swapping the model dimension means the old
    // embeddings are incompatible — drop them and record the new dimension.
    await this.deleteAllSearchEmbeddings();
    await sql`
      insert into "system_metadata" ("key", "value") values (${'smart-search-dimension-smart_search'}, ${String(dimSize)})
      on conflict ("key") do update set "value" = excluded."value"
    `.execute(this.db);

    await sql`vacuum analyze ${sql.table('smart_search')}`.execute(this.db);
  }

  async deleteAllSearchEmbeddings(): Promise<void> {
    await sql`truncate ${sql.table('smart_search')}`.execute(this.db);
  }

  private targetProbeCount(lists: number) {
    return Math.ceil(lists / 8);
  }

  private async getRowCount(table: keyof DB): Promise<number> {
    const { count } = await this.db
      .selectFrom(this.db.dynamic.table(table).as('t'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return count;
  }

  async runMigrations(): Promise<number> {
    // Single-engine fork: the SQLite schema bootstrap IS the migration path
    // (idempotent; applied flag distinguishes first-apply from no-op).
    this.logger.log('Applying SQLite schema');
    const applied = await bootstrapSqliteSchema(this.db as any);
    return applied ? 1 : 0;
  }

  async migrateFilePaths(sourceFolder: string, targetFolder: string): Promise<void> {
    // remove trailing slashes
    if (sourceFolder.endsWith('/')) {
      sourceFolder = sourceFolder.slice(0, -1);
    }

    if (targetFolder.endsWith('/')) {
      targetFolder = targetFolder.slice(0, -1);
    }

    // escaping regex special characters with a backslash
    const sourceRegex = '^' + sourceFolder.replaceAll(/[-[\]{}()*+?.,\\^$|#\s]/g, String.raw`\$&`);
    const source = sql.raw(`'${sourceRegex}'`);
    const target = sql.lit(targetFolder);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('asset')
        .set((eb) => ({
          originalPath: eb.fn('REGEXP_REPLACE', ['originalPath', source, target]),
        }))
        .execute();

      await tx
        .updateTable('asset_file')
        .set((eb) => ({ path: eb.fn('REGEXP_REPLACE', ['path', source, target]) }))
        .execute();

      await tx
        .updateTable('person')
        .set((eb) => ({ thumbnailPath: eb.fn('REGEXP_REPLACE', ['thumbnailPath', source, target]) }))
        .execute();

      await tx
        .updateTable('user')
        .set((eb) => ({ profileImagePath: eb.fn('REGEXP_REPLACE', ['profileImagePath', source, target]) }))
        .execute();
    });
  }

  // SQLite (single-engine fork): pg advisory locks are no-op SQL functions and every
  // Kysely "connection" is the same synchronous handle, so database locks are purely
  // in-process. They must NOT hold a db.connection() lease across the callback: with
  // Kysely's connection mutex active that lease would deadlock against the callback's
  // own queries on this.db (and a lost lease-based advisory lock buys nothing here).
  private readonly heldLocks = new Set<string>();

  async withLock<R>(lock: DatabaseLock, callback: () => Promise<R>): Promise<R> {
    const name = DatabaseLock[lock];
    return this.asyncLock.acquire(name, async () => {
      this.heldLocks.add(name);
      try {
        return await callback();
      } finally {
        this.heldLocks.delete(name);
      }
    });
  }

  tryLock(lock: DatabaseLock): Promise<boolean> {
    const name = DatabaseLock[lock];
    if (this.heldLocks.has(name)) {
      return Promise.resolve(false);
    }
    this.heldLocks.add(name);
    return Promise.resolve(true);
  }

  releaseLock(lock: DatabaseLock): void {
    this.heldLocks.delete(DatabaseLock[lock]);
  }

  isBusy(lock: DatabaseLock): boolean {
    return this.asyncLock.isBusy(DatabaseLock[lock]);
  }

  async wait(lock: DatabaseLock): Promise<void> {
    await this.asyncLock.acquire(DatabaseLock[lock], () => {});
  }
}
