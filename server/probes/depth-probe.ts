import { getKyselyDB } from '../test/utils.js';

const db = await getKyselyDB();
const r1 = await db
  .insertInto('cluster_group')
  .values({ id: '01960000-0000-7000-8000-000000000001' })
  .returningAll()
  .executeTakeFirstOrThrow();
await db
  .insertInto('user')
  .values({ id: '01960000-0000-7000-8000-0000000000a1', email: 'a@b.c', clusterGroupId: r1.id })
  .execute();
await db
  .insertInto('user')
  .values({ id: '01960000-0000-7000-8000-0000000000a2', email: 'd@e.f', clusterGroupId: r1.id })
  .execute();
await db
  .insertInto('partner')
  .values({ sharedById: '01960000-0000-7000-8000-0000000000a1', sharedWithId: '01960000-0000-7000-8000-0000000000a2' })
  .execute();
console.log('partner rows', await db.selectFrom('partner').selectAll().execute());
await db.deleteFrom('user').where('id', '=', '01960000-0000-7000-8000-0000000000a1').execute();
console.log('partner after', await db.selectFrom('partner').selectAll().execute());
console.log('partner_audit', await db.selectFrom('partner_audit').selectAll().execute());
console.log('user_audit', await db.selectFrom('user_audit').selectAll().execute());
