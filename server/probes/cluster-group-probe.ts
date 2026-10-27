import { createSqliteHandle, bootstrapSqliteSchema } from '../src/utils/sqlite-database.js';
import { Kysely, SqliteDialect } from 'kysely';

const handle = createSqliteHandle(':memory:');
const db = new Kysely({ dialect: new SqliteDialect({ database: handle.raw }) });
await bootstrapSqliteSchema(db);

const q = db.insertInto('cluster_group').defaultValues().returningAll();
console.log('SQL:', JSON.stringify(q.compile()));
try {
  const r = await q.executeTakeFirstOrThrow();
  console.log('ROW:', JSON.stringify(r));
} catch (e) {
  console.log('ERR:', e.message);
  const raw = handle.raw.prepare('insert into cluster_group default values returning *').all();
  console.log('RAW_ROWS:', JSON.stringify(raw).slice(0, 200));
}
