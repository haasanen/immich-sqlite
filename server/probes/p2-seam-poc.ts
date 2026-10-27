// Phase 2 seam proof-of-concept: Kysely with the SQLite dialect over
// better-sqlite3, typed with immich's own schema types. Not shipped code —
// a measurable check that the single dialect seam in database.ts can flip.
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import type { DB } from 'src/schema/index.js';
import type { AssetTable } from 'src/schema/tables/asset.table.js';

const sqlite = new Database(':memory:');
sqlite.exec(`
  create table asset (
    id text primary key,
    "deviceId" text not null,
    "ownerId" text not null,
    "stackId" text,
    "type" text not null check ("type" in ('IMAGE','VIDEO','AUDIO','OTHER')),
    "originalPath" text not null,
    "originalFileName" text,
    "originalMimeType" text,
    "thumbhash" blob,
    "duration" real not null default 0,
    "isVisible" integer not null default 1,
    "fileCreatedAt" text not null,
    "fileModifiedAt" text not null,
    "localCreatedAt" text not null,
    "updatedAt" text not null,
    "deletedAt" text
  );
`);

const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });

const row: Partial<AssetTable> = {
  id: '0196a9a0-0000-7000-8000-000000000001',
  deviceId: 'dev',
  ownerId: 'owner',
  type: 'IMAGE',
  originalPath: 'library/2026/IMG_1.jpg',
  fileCreatedAt: new Date().toISOString(),
  fileModifiedAt: new Date().toISOString(),
  localCreatedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const inserted = await db.insertInto('asset').values(row).returning(['id', 'type']).execute();
const selected = await db
  .selectFrom('asset')
  .select(['id', 'type', 'isVisible'])
  .where('id', '=', row.id!)
  .executeTakeFirstOrThrow();

// json_each array-param pattern (the ANY($1::uuid[]) replacement)
const ids = JSON.stringify([row.id!, '0196a9a0-0000-7000-8000-000000000002']);
const inSet = await db
  .selectFrom('asset')
  .select(['id'])
  .where(sql<boolean>`id in (select value from json_each(${ids}))`)
  .execute();

console.log('INSERT_RETURNING:', JSON.stringify(inserted));
console.log('SELECT:', JSON.stringify(selected));
console.log('JSON_EACH_IN:', JSON.stringify(inSet));
console.log('SEAM_OK');
