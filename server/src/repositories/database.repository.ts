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

  async withLock<R>(lock: DatabaseLock, callback: () => Promise<R>): Promise<R> {
    let res;
    await this.asyncLock.acquire(DatabaseLock[lock], async () => {
      await this.db.connection().execute(async (connection) => {
        try {
          await this.acquireLock(lock, connection);
          if (process.env.LOCK_TRACE) console.error('LOCK_TRACE callback start', DatabaseLock[lock]);
          res = await callback();
          if (process.env.LOCK_TRACE) console.error('LOCK_TRACE callback end', DatabaseLock[lock]);
        } finally {
          await this.releaseLock(lock, connection);
        }
      });
    });

    return res as R;
  }

  tryLock(lock: DatabaseLock): Promise<boolean> {
    return this.db.connection().execute(async (connection) => this.acquireTryLock(lock, connection));
  }

  isBusy(lock: DatabaseLock): boolean {
    return this.asyncLock.isBusy(DatabaseLock[lock]);
  }

  async wait(lock: DatabaseLock): Promise<void> {
    await this.asyncLock.acquire(DatabaseLock[lock], () => {});
  }

  private async acquireLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    if (process.env.LOCK_TRACE) console.error('LOCK_TRACE acquire', lock);
    await sql`SELECT pg_advisory_lock(${lock}) as pg_advisory_lock`.execute(connection);
    if (process.env.LOCK_TRACE) console.error('LOCK_TRACE acquired', lock);
  }

  private async acquireTryLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<boolean> {
    const { rows } = await sql<{
      pg_try_advisory_lock: boolean;
    }>`SELECT pg_try_advisory_lock(${lock}) as pg_try_advisory_lock`.execute(connection);
    return rows[0].pg_try_advisory_lock;
  }

  private async releaseLock(lock: DatabaseLock, connection: Kysely<DB>): Promise<void> {
    await sql`SELECT pg_advisory_unlock(${lock}) as pg_advisory_unlock`.execute(connection);
  }
}
