process.env.IMMICH_TEST_DB = 'sqlite';
import { getKyselyDB } from '../test/utils.js';

const db = await getKyselyDB('probe');
const cg = await db.insertInto('cluster_group').defaultValues().returningAll().executeTakeFirst();
console.log('cg row:', cg ? 'yes' : 'NONE');
const rows = await db.selectFrom('cluster_group').selectAll().execute();
console.log('cluster_group rows after:', rows.length);
const second = await db.insertInto('cluster_group').defaultValues().returningAll().execute();
console.log('second insert returning rows:', second.length);
