import { createSqliteHandle, bootstrapSqliteSchema } from '../src/utils/sqlite-database.js';
import { Kysely, SqliteDialect } from 'kysely';

const handle = createSqliteHandle(':memory:');
const db = new Kysely({ dialect: new SqliteDialect({ database: handle.raw }) });
await bootstrapSqliteSchema(db);

// mimic newUser: create cluster group, then user insert like mediumFactory.userInsert
const cg = await db.insertInto('cluster_group').defaultValues().returningAll().executeTakeFirstOrThrow();
console.log('cg ok', cg.id.slice(0, 8));

const now = new Date().toISOString();
const user = {
  id: '01a1744a-0000-7000-8000-000000000001',
  email: 'a@b.c',
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  password: 'x',
  emailVerified: true,
  isAdmin: false,
  quotaUsageInBytes: 0,
  shouldChangePassword: false,
  status: 'active' as const,
  profileChangedAt: now,
  clusterGroupId: cg.id,
};
const res = await db.insertInto('user').values(user).returningAll().executeTakeFirst();
console.log('user result rows:', res ? 'one' : 'NONE');
const all = handle.raw.prepare('select id from "user"').all();
console.log('user table rows:', JSON.stringify(all));
