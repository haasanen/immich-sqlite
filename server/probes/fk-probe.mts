import { bootstrapSqliteSchema, createSqliteHandle } from '../src/utils/sqlite-database.js';
import { Kysely } from 'kysely';
import { DB } from '../src/schema/index.js';
import { getKyselyConfig } from '../src/utils/database.js';

const filename = `/tmp/zz-album-fk-${Date.now()}.db`;
const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'sqlite', filename }));
await bootstrapSqliteSchema(db);
const raw = createSqliteHandle(filename).raw;

console.info('FKS_ON_ALBUM', JSON.stringify(raw.prepare('pragma foreign_key_list("album")').all()));

const uuid = () => raw.prepare('select uuidv7() v').get().v as string;
const uid = uuid();
raw.prepare('insert into cluster_group (id) values (?)').run(uuid());
const aid = uuid();
const alid = uuid();

raw
  .prepare(
    `insert into "user" ("id","name","email","password","quotaUsageInBytes","status","updatedAt","deletedAt","clusterGroupId") values (?,'u','e@e.c','p',0,'active',now_iso(),null,(select id from cluster_group limit 1))`,
  )
  .run(uid);
raw
  .prepare(
    `insert into "asset" ("id","ownerId","checksum","checksumAlgorithm","originalFileName","originalPath","type","visibility","fileCreatedAt","fileModifiedAt","localDateTime","updatedAt","updateId") values (?,?, 'c','sha1','f.jpg','p','image','timeline',now_iso(),now_iso(),now_iso(),now_iso(),uuidv7())`,
  )
  .run(aid, uid);
raw
  .prepare(`insert into "album" ("id","albumName","updatedAt","updateId") values (?,'al',now_iso(),uuidv7())`)
  .run(alid);
raw
  .prepare(`insert into "album_user" ("albumId","userId","role","updatedAt") values (?,?,'owner',now_iso())`)
  .run(alid, uid);
raw.prepare(`insert into "album_asset" ("albumId","assetId","updatedAt") values (?,?,now_iso())`).run(alid, aid);

console.info('AA_COUNT', JSON.stringify(raw.prepare('select count(*) c from album_asset').get()));
try {
  raw.prepare('delete from album where id = ?').run(alid);
  console.info('DELETE_OK');
} catch (e: any) {
  console.info('DELETE_FAIL', e.message);
}
console.info('FKCHECK', JSON.stringify(raw.prepare('pragma foreign_key_check').all()));
console.info('AA_AFTER', JSON.stringify(raw.prepare('select count(*) c from album_asset').get()));
console.info('AU_AFTER', JSON.stringify(raw.prepare('select count(*) c from album_user').get()));
raw.close();
