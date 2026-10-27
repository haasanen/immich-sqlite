import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Regression for the h4/h6 CI session-death bug: all SQLite "connections" share
 * one synchronous better-sqlite3 handle, and the shim emulates transaction
 * nesting with LIFO savepoints. If two top-level db.transaction() calls
 * interleave, commit/rollback release the WRONG savepoint and one flow's writes
 * silently vanish (observed as a freshly-created session row disappearing ->
 * "Invalid user token"). serializeTransactions() must keep top-level
 * transactions mutually exclusive while a transaction re-entered from inside
 * another transaction's callback runs as a savepoint (no deadlock, isolated
 * rollback).
 */
const insertKey = (db: Kysely<DB> | { execute: never }, key: string) =>
  sql`insert into system_metadata (key, value) values (${key}, '"x"')`.execute(db as never);

const keyRows = async (db: Kysely<DB>) => {
  const rows = await db.selectFrom('system_metadata').select('key').execute();
  return rows.map((r) => r.key).sort();
};

describe('SQLite transaction serialization', () => {
  it('a rolled-back transaction does not destroy a concurrent transaction-committed row', async () => {
    const db = await getKyselyDB();

    const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();

    const doomed = db
      .transaction()
      .execute(async (trx) => {
        await insertKey(trx, 'interleave-doomed');
        await gate;
        throw new Error('boom');
      })
      .catch(() => {});

    // starts while `doomed` holds the handle open; must NOT join its savepoint
    const survivor = db.transaction().execute(async (trx) => {
      await insertKey(trx, 'interleave-survivor');
    });

    releaseGate();
    await Promise.allSettled([doomed, survivor]);

    const rows = await keyRows(db);
    expect(rows).toContain('interleave-survivor');
    expect(rows).not.toContain('interleave-doomed');
  });

  it('serialized transactions both commit fully when run concurrently', async () => {
    const db = await getKyselyDB();

    await Promise.all([
      db.transaction().execute(async (trx) => {
        await insertKey(trx, 'serial-a');
      }),
      db.transaction().execute(async (trx) => {
        await insertKey(trx, 'serial-b');
      }),
    ]);

    const rows = await keyRows(db);
    expect(rows).toContain('serial-a');
    expect(rows).toContain('serial-b');
  });

  it('a transaction re-entered inside a callback uses a savepoint and does not deadlock', async () => {
    const db = await getKyselyDB();

    await db.transaction().execute(async (trx) => {
      await insertKey(trx, 'nest-outer');
      await db.transaction().execute(async () => {
        await insertKey(trx, 'nest-inner');
      });
    });

    const rows = await keyRows(db);
    expect(rows).toContain('nest-outer');
    expect(rows).toContain('nest-inner');
  });

  it('a failing re-entered transaction rolls back only its own writes', async () => {
    const db = await getKyselyDB();

    await db.transaction().execute(async (trx) => {
      await insertKey(trx, 'partial-outer');
      await db
        .transaction()
        .execute(async () => {
          await insertKey(trx, 'partial-inner');
          throw new Error('inner boom');
        })
        .catch(() => {});
    });

    const rows = await keyRows(db);
    expect(rows).toContain('partial-outer');
    expect(rows).not.toContain('partial-inner');
  });
});
