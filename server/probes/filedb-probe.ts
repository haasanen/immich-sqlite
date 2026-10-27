import { getKyselyConfig } from '../src/utils/database.js';
import { bootstrapSqliteSchema } from '../src/utils/sqlite-database.js';
import { Kysely } from 'kysely';

const filename = `/opt/data/cache/scratch/probe-file-${Date.now()}.db`;
const db = new Kysely(getKyselyConfig({ connectionType: 'sqlite', filename }));
await bootstrapSqliteSchema(db);
const cg = await db.insertInto('cluster_group').defaultValues().returningAll().executeTakeFirst();
console.log('first:', cg ? 'row' : 'NONE');
const cg2 = await db.insertInto('cluster_group').defaultValues().returningAll().execute();
console.log('second returning:', cg2.length);
const cnt = await db
  .selectFrom('cluster_group')
  .select((eb) => eb.fn.countAll().as('c'))
  .executeTakeFirst();
console.log('count:', JSON.stringify(cnt));
