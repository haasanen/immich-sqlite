import { Kysely, sql } from 'kysely';
import 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { bootstrapSqliteSchema } from 'src/utils/sqlite-database.js';
import { tmpdir } from 'node:os';

const file = `${tmpdir()}/p3-trig-${Date.now()}.db`;
const db = new Kysely(getKyselyConfig({ connectionType: 'sqlite', filename: file }));
await bootstrapSqliteSchema(db);

const run = async (s: string) => {
  await sql.raw(s).execute(db);
};
const q = async (s: string) => (await sql.raw(s).execute(db)).rows;

console.log('fk_pragma=', JSON.stringify(await q('pragma foreign_keys')));

await run(
  `insert into cluster_group (id,name,createdAt,updatedAt,updateId) values ('c1','n','2020-01-01','2020-01-01','u1')`,
);
await run(
  `insert into "user" (id,email,createdAt,updatedAt,profileImagePath,isAdmin,shouldChangePassword,quotaUsageInBytes,status,profileChangedAt,updateId,clusterGroupId)
   values ('u1','e@x.com','2020-01-01','2020-01-01','',0,0,0,'active','2020-01-01','uu1','c1')`,
);
await run(
  `insert into album (id,albumName,createdAt,updatedAt,updateId) values ('a1','al','2020-01-01','2020-01-01','au1')`,
);
await run(
  `insert into album_user (albumId,userId,role,createdAt,updatedAt,createId,updateId) values ('a1','u1','owner','2020-01-01','2020-01-01','c','c')`,
);

await run(`create table zz_hoplog (t text, h integer)`);
await run(
  `create trigger zz_t after delete on "album_user" begin insert into zz_hoplog values ('album_user', audit_hop('album_user')); end`,
);
await run(`delete from "album" where id='a1'`);
console.log('audit_hop_now=', JSON.stringify(await q(`select audit_hop('album_user') h`)));
console.log('album_users_after=', JSON.stringify(await q('select count(*) c from album_user')));
console.log('hoplog=', JSON.stringify(await q('select * from zz_hoplog')));
console.log('album_user_audit=', JSON.stringify(await q('select * from album_user_audit')));
process.exit(0);
