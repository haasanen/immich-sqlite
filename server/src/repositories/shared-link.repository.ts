import { Injectable } from '@nestjs/common';
import {
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type Selectable,
  type ShallowDehydrateObject,
  type SqlBool,
  type Updateable,
  sql,
} from 'kysely';
import { omit } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import { Album, columns } from 'src/database.js';
import { ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { SharedLinkType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table.js';
import { jsonArrayFrom, jsonObjectFrom } from 'src/utils/sql-json.js';
import { sqliteRowObjectSql } from 'src/utils/sqlite-json-helpers.js';

export type SharedLinkSearchOptions = {
  userId: string;
  id?: string;
  albumId?: string;
};

const withSharedAssets = (eb: ExpressionBuilder<DB, 'shared_link'>) => {
  return eb
    .selectFrom('shared_link_asset')
    .whereRef('shared_link.id', '=', 'shared_link_asset.sharedLinkId')
    .innerJoin('asset', 'asset.id', 'shared_link_asset.assetId')
    .where('asset.deletedAt', 'is', null)
    .selectAll('asset')
    .orderBy('asset.fileCreatedAt', 'asc');
};

export const withExifInfo = (eb: ExpressionBuilder<DB, 'asset'>) => {
  return eb
    .selectFrom('asset_exif')
    .select(columns.exif)
    .whereRef('asset_exif.assetId', '=', 'asset.id')
    .as('exifInfo');
};

const jsonCols = (cols: readonly string[], alias: string) =>
  cols.map((c) => `'${c.split('.').at(-1)}', "${alias}"."${c.split('.').at(-1)}"`).join(', ');

const sqliteAssetWithExif = (whereRef: string) =>
  sql.raw(
    `(select json_group_array(jo) from (select json_set(${sqliteRowObjectSql('asset', 'id')}, '$.exifInfo', ` +
      `(select json_object(${jsonCols(columns.exif, 'asset_exif')}) from "asset_exif" where "asset_exif"."assetId" = "asset"."id")) as jo ` +
      `from "asset" where ${whereRef} and "asset"."deletedAt" is null order by "asset"."fileCreatedAt" asc limit -1))`,
  );

const sqliteAlbumUsers = (albumRef: string) =>
  sql.raw(
    `(select json_group_array(json_object('role', "album_user"."role", 'user', ` +
      `(select json_object(${jsonCols(columns.user, 'user')}) from "user" where "user"."id" = "album_user"."userId"))) ` +
      `from "album_user" where "album_user"."role" = 'owner' and "album_user"."albumId" = ${albumRef})`,
  );

@Injectable()
export class SharedLinkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  get(userId: string, id: string) {
    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .select((eb) =>
        jsonArrayFrom(
          withSharedAssets(eb).select((eb2) =>
            jsonObjectFrom(
              eb2.selectFrom('asset_exif').whereRef('asset_exif.assetId', '=', 'asset.id').select(columns.exif),
            ).as('exifInfo'),
          ),
        ).as('assets'),
      )

      .$call((qb) =>
        qb.select((eb) =>
          jsonObjectFrom(
            eb
              .selectFrom('album')
              .whereRef('album.id', '=', 'shared_link.albumId')
              .where('album.deletedAt', 'is', null)
              .selectAll('album')
              .select(sqliteAlbumUsers('"album"."id"').as('albumUsers'))
              .select(
                sqliteAssetWithExif(
                  `exists (select 1 from "album_asset" aa2 where aa2."assetId" = "asset"."id" and aa2."albumId" = "album"."id")`,
                ).as('assets'),
              ),
          )
            .$castTo<ShallowDehydrateObject<Album> | null>()
            .as('album'),
        ),
      )
      .where('shared_link.id', '=', id)
      .where('shared_link.userId', '=', userId)
      .where(
        sql<SqlBool>`(shared_link."type" = ${SharedLinkType.Individual} or exists (select 1 from "album" a where a."id" = "shared_link"."albumId" and a."deletedAt" is null))`,
      )
      .orderBy('shared_link.createdAt', 'desc')
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, albumId: DummyValue.UUID }] })
  getAll({ userId, id, albumId }: SharedLinkSearchOptions) {
    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .select((eb) => jsonArrayFrom(withSharedAssets(eb).limit(1)).as('assets'))
      .where('shared_link.userId', '=', userId)

      .$call((qb) =>
        qb.select((eb) =>
          jsonObjectFrom(
            eb
              .selectFrom('album')
              .whereRef('album.id', '=', 'shared_link.albumId')
              .where('album.deletedAt', 'is', null)
              .selectAll('album')
              .select(sqliteAlbumUsers('"album"."id"').as('albumUsers')),
          )
            .$castTo<ShallowDehydrateObject<Album> | null>()
            .as('album'),
        ),
      )
      .where(
        sql<SqlBool>`(shared_link."type" = ${SharedLinkType.Individual} or exists (select 1 from "album" a where a."id" = "shared_link"."albumId" and a."deletedAt" is null))`,
      )
      .$if(!!albumId, (eb) => eb.where('shared_link.albumId', '=', albumId!))
      .$if(!!id, (eb) => eb.where('shared_link.id', '=', id!))
      .orderBy('shared_link.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  getByKey(key: Buffer) {
    return this.authBuilder().where('shared_link.key', '=', key).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  getBySlug(slug: string) {
    return this.authBuilder().where('shared_link.slug', '=', slug).executeTakeFirst();
  }

  private authBuilder() {
    return this.db
      .selectFrom('shared_link')
      .leftJoin('album', 'album.id', 'shared_link.albumId')
      .where('album.deletedAt', 'is', null)
      .select((eb) => [
        'shared_link.id',
        'shared_link.userId',
        'shared_link.albumId',
        'shared_link.expiresAt',
        'shared_link.showExif',
        'shared_link.allowUpload',
        'shared_link.allowDownload',
        'shared_link.password',
        jsonObjectFrom(
          eb.selectFrom('user').select(columns.authUser).whereRef('user.id', '=', 'shared_link.userId'),
        ).as('user'),
      ])
      .where((eb) => eb.or([eb('shared_link.type', '=', SharedLinkType.Individual), eb('album.id', 'is not', null)]));
  }

  async create(entity: Insertable<SharedLinkTable> & { assetIds?: string[] }) {
    const { id } = await this.db
      .insertInto('shared_link')
      .values(omit(entity, 'assetIds'))
      .returningAll()
      .executeTakeFirstOrThrow();

    if (entity.assetIds && entity.assetIds.length > 0) {
      await this.db
        .insertInto('shared_link_asset')
        .values(entity.assetIds!.map((assetId) => ({ assetId, sharedLinkId: id })))
        .execute();
    }

    return this.getSharedLinks(id);
  }

  async update(entity: Updateable<SharedLinkTable> & { id: string; assetIds?: string[] }) {
    const { id } = await this.db
      .updateTable('shared_link')
      .set(omit(entity, 'assets', 'album', 'assetIds'))
      .where('shared_link.id', '=', entity.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (entity.assetIds && entity.assetIds.length > 0) {
      await this.db
        .insertInto('shared_link_asset')
        .values(entity.assetIds!.map((assetId) => ({ assetId, sharedLinkId: id })))
        .execute();
    }

    return this.getSharedLinks(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('shared_link').where('shared_link.id', '=', id).execute();
  }

  @ChunkedArray({ paramIndex: 1 })
  async addAssets(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }

    return await this.db
      .insertInto('shared_link_asset')
      .values(assetIds.map((assetId) => ({ assetId, sharedLinkId: id })))
      .onConflict((oc) => oc.doNothing())
      .returning(['shared_link_asset.assetId'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  private getSharedLinks(id: string) {
    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.id', '=', id)
      .select(
        sqliteAssetWithExif(
          `exists (select 1 from "shared_link_asset" sla where sla."assetId" = "asset"."id" and sla."sharedLinkId" = "shared_link"."id")`,
        )
          .$castTo<any>()
          .as('assets'),
      )
      .executeTakeFirstOrThrow();

    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.id', '=', id)
      .leftJoin('shared_link_asset', 'shared_link_asset.sharedLinkId', 'shared_link.id')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset')
            .whereRef('asset.id', '=', 'shared_link_asset.assetId')
            .selectAll('asset')
            .innerJoinLateral(withExifInfo, (join) => join.onTrue())
            .as('assets'),
        (join) => join.onTrue(),
      )
      .select((eb) =>
        eb.fn
          .coalesce(eb.fn.jsonAgg('assets').filterWhere('assets.id', 'is not', null), sql`'[]'`)
          .$castTo<
            (ShallowDehydrateObject<Selectable<AssetTable>> & {
              exifInfo: ShallowDehydrateObject<Selectable<AssetExifTable>>;
            })[]
          >()
          .as('assets'),
      )
      .groupBy('shared_link.id')
      .executeTakeFirstOrThrow();
  }
}
