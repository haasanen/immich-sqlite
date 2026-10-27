import { sql } from 'kysely';
import { getKyselyDB } from '../test/utils.js';

const db = await getKyselyDB();
const q = sql.raw(
  'select distinct cast(strftime(\'%Y\', (asset."localDateTime") as REAL)) as "year" from "asset" where "asset"."ownerId" = \'u\' and exists (select 1 from "asset_face" where "asset_face"."assetId" = "asset"."id") and cast(strftime(\'%m\', (asset."localDateTime") as REAL)) = 1 and (asset."localDateTime") >= make_date(2000, 1, 1) order by year desc',
);
try {
  await q.execute(db);
  console.log('EXECUTED OK');
} catch (e) {
  console.log('ERR:', (e as Error).message);
}
process.exit(0);
