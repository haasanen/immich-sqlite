import { Injectable } from '@nestjs/common';
import {
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type NotNull,
  type SelectQueryBuilder,
  type Selectable,
  type SqlBool,
  UpdateResult,
  type Updateable,
  sql,
} from 'kysely';
import { isEmpty, isUndefined, omitBy } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { LockableProperty, Stack } from 'src/database.js';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import {
  AssetFileType,
  AssetOrder,
  AssetOrderBy,
  AssetStatus,
  AssetType,
  AssetVisibility,
  CalendarHeatmapType,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetAudioTable, AssetKeyframeTable, AssetVideoTable } from 'src/schema/tables/asset-av.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetFileTable } from 'src/schema/tables/asset-file.table.js';
import { AssetJobStatusTable } from 'src/schema/tables/asset-job-status.table.js';
import { AssetMetadataTable } from 'src/schema/tables/asset-metadata.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import {
  anyUuid,
  asUuid,
  hasPeople,
  inSharedAlbum,
  removeUndefinedKeys,
  truncatedDate,
  unnest,
  withDefaultVisibility,
  withEdits,
  withExif,
  withFaces,
  withFacesAndPeople,
  withFilePath,
  withFiles,
  withLibrary,
  withOwner,
  withSmartSearch,
  withTagId,
  withTags,
} from 'src/utils/database.js';
import { globToPostgresRegex } from 'src/utils/misc.js';
import { jsonArrayFrom, jsonObjectFrom } from 'src/utils/sql-json.js';
import { sqliteRowObjectSql } from 'src/utils/sqlite-json-helpers.js';

export type AssetStats = Record<AssetType, number>;

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface AssetStatsOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  visibility?: AssetVisibility;
}

interface LivePhotoSearchOptions {
  ownerId: string;
  libraryId?: string | null;
  livePhotoCID: string;
  otherAssetId: string;
  type: AssetType;
}

interface AssetBuilderOptions {
  isFavorite?: boolean;
  isTrashed?: boolean;
  isDuplicate?: boolean;
  albumId?: string;
  tagId?: string;
  personId?: string;
  userIds?: string[];
  withStacked?: boolean;
  exifInfo?: boolean;
  status?: AssetStatus;
  assetType?: AssetType;
  visibility?: AssetVisibility;
  withCoordinates?: boolean;
  bbox?: BoundingBox;
}

export interface TimeBucketOptions extends AssetBuilderOptions {
  order?: AssetOrder;
  orderBy?: AssetOrderBy;
}

export interface TimeBucketItem {
  timeBucket: string;
  count: number;
}

export interface YearMonthDay {
  day: number;
  month: number;
  year: number;
}

interface AssetExploreFieldOptions {
  maxFields: number;
  minAssetsPerField: number;
}

interface AssetGetByChecksumOptions {
  ownerId: string;
  checksum: Buffer;
  libraryId?: string;
}

interface GetByIdsRelations {
  exifInfo?: boolean;
  faces?: { person?: boolean; withDeleted?: boolean; viewingUserId?: string };
  files?: boolean;
  library?: boolean;
  owner?: boolean;
  smartSearch?: boolean;
  stack?: { assets?: boolean };
  tags?: boolean;
  edits?: boolean;
}

type UpsertExifOptions = {
  exif: Insertable<AssetExifTable>;
  audio?: Insertable<AssetAudioTable>;
  video?: Insertable<AssetVideoTable>;
  keyframes?: Insertable<AssetKeyframeTable>;
  lockedPropertiesBehavior: 'override' | 'append' | 'skip';
};

const distinctLocked = <T extends LockableProperty[] | null>(_eb: ExpressionBuilder<DB, 'asset_exif'>, columns: T) =>
  // arrays are stored as JSON text; union through json_each for dedup.
  // json_group_array over zero rows is NULL, matching the '{}' -> null rule.
  sql<T>`(case when not exists (select 1 from json_each("asset_exif"."lockedProperties")
              union all select 1 from json_each(${columns}) limit 1)
        then null else (select json_group_array(value) from (
          select value, min(case when src = 0 then key else key + 100000 end) as pos
          from (select 0 as src, key, value from json_each("asset_exif"."lockedProperties")
                union all select 1 as src, key, value from json_each(${columns}))
          group by value order by pos)) end)`;

const getBoundingCircle = (bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const eastUnwrapped = west <= east ? east : east + 360;
  const centerLongitude = (((west + eastUnwrapped) / 2 + 540) % 360) - 180;
  const centerLatitude = (south + north) / 2;
  const radius = sql<number>`greatest(
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${south}, ${east})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${west})),
    earth_distance(ll_to_earth_public(${centerLatitude}, ${centerLongitude}), ll_to_earth_public(${north}, ${east}))
  )`;

  return { centerLatitude, centerLongitude, radius };
};

const withBoundingBox = <T>(qb: SelectQueryBuilder<DB, 'asset' | 'asset_exif', T>, bbox: BoundingBox) => {
  const { west, south, east, north } = bbox;
  const withLatitude = qb.where('asset_exif.latitude', '>=', south).where('asset_exif.latitude', '<=', north);

  if (west <= east) {
    return withLatitude.where('asset_exif.longitude', '>=', west).where('asset_exif.longitude', '<=', east);
  }

  return withLatitude.where((eb) =>
    eb.or([eb('asset_exif.longitude', '>=', west), eb('asset_exif.longitude', '<=', east)]),
  );
};

const AGG_BASE_COLS = [
  'duration',
  'id',
  'visibility',
  'isFavorite',
  'isImage',
  'isTrashed',
  'livePhotoVideoId',
  'fileCreatedAt',
  'localOffsetHours',
  'createdAt',
  'ownerId',
  'projectionType',
  'ratio',
  'status',
  'thumbhash',
];

const AGG_BOOL_COLS = new Set(['isFavorite', 'isImage', 'isTrashed']);

const aggCols = (eb: ExpressionBuilder<any, any>, cols: string[]) =>
  cols.map((c) =>
    eb.fn
      .coalesce(eb.fn('json_group_array', [AGG_BOOL_COLS.has(c) ? sql.raw(`json("${c}")`) : c]), sql.lit('[]'))
      .as(c),
  );

const aggColumnNames = (options: TimeBucketOptions, auth: AuthDto): string[] => {
  const cols = [...AGG_BASE_COLS];
  if (!auth.sharedLink || auth.sharedLink.showExif) cols.push('city', 'country');
  if (options.withCoordinates) cols.push('latitude', 'longitude');
  if (options.withStacked) cols.push('stack');
  return cols;
};

// SQLite equivalent of to_json(row of json-array columns): json_object with
// each aggregated TEXT column re-parsed as JSON so it embeds as an array.
const sqliteAggObject = (cols: string[]) =>
  sql<string>`json_object(${sql.join(
    cols.flatMap((c) => [sql.lit(c), sql`json(${sql.ref(`agg.${c}`)})`]),
    sql.raw(', '),
  )})`;

@Injectable()
export class AssetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({
    params: [
      {
        exif: { dateTimeOriginal: DummyValue.DATE, lockedProperties: ['dateTimeOriginal'] },
        lockedPropertiesBehavior: 'append',
      },
    ],
  })
  async upsertExif({ exif, audio, video, keyframes, lockedPropertiesBehavior }: UpsertExifOptions): Promise<void> {
    // SQLite has no data-modifying CTEs; the CTEs here are independent DML,
    // so run them as sequential statements in one transaction.
    await this.db.transaction().execute(async (trx) => {
      const sqliteExif: Insertable<AssetExifTable> = exif;
      if (audio) {
        await trx
          .insertInto('asset_audio')
          .values(audio)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('excluded.bitrate'),
              index: ref('excluded.index'),
              profile: ref('excluded.profile'),
              codecName: ref('excluded.codecName'),
            })),
          )
          .execute();
      }
      if (video) {
        await trx
          .insertInto('asset_video')
          .values(video)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              bitrate: ref('excluded.bitrate'),
              frameCount: ref('excluded.frameCount'),
              timeBase: ref('excluded.timeBase'),
              index: ref('excluded.index'),
              profile: ref('excluded.profile'),
              level: ref('excluded.level'),
              colorPrimaries: ref('excluded.colorPrimaries'),
              colorTransfer: ref('excluded.colorTransfer'),
              colorMatrix: ref('excluded.colorMatrix'),
              dvProfile: ref('excluded.dvProfile'),
              dvLevel: ref('excluded.dvLevel'),
              dvBlSignalCompatibilityId: ref('excluded.dvBlSignalCompatibilityId'),
              codecName: ref('excluded.codecName'),
              formatName: ref('excluded.formatName'),
              formatLongName: ref('excluded.formatLongName'),
              pixelFormat: ref('excluded.pixelFormat'),
            })),
          )
          .execute();
      }
      if (keyframes) {
        await trx
          .insertInto('asset_keyframe')
          .values(keyframes)
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet(({ ref }) => ({
              pts: ref('excluded.pts'),
              accDuration: ref('excluded.accDuration'),
              ownDuration: ref('excluded.ownDuration'),
              totalDuration: ref('excluded.totalDuration'),
              packetCount: ref('excluded.packetCount'),
              outputFrames: ref('excluded.outputFrames'),
            })),
          )
          .execute();
      }
      await this.upsertExifRow(trx, sqliteExif, lockedPropertiesBehavior);
    });
  }

  private async upsertExifRow(
    query: Kysely<DB>,
    exif: Insertable<AssetExifTable>,
    lockedPropertiesBehavior: 'override' | 'append' | 'skip',
  ): Promise<void> {
    await query
      .insertInto('asset_exif')
      .values(exif)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) => {
          const updateLocked = <T extends keyof AssetExifTable>(col: T) => eb.ref(`excluded.${col}`);
          const skipLocked = <T extends keyof AssetExifTable>(col: T) =>
            eb
              .case()
              .when(
                sql`exists (select 1 from json_each("asset_exif"."lockedProperties") je where je.value = ${eb.ref(`excluded.${col}`)})` as never,
                '=',
                eb.lit(1) as never,
              )
              .then(eb.ref(`asset_exif.${col}`))
              .else(eb.ref(`excluded.${col}`))
              .end();
          const ref = lockedPropertiesBehavior === 'skip' ? skipLocked : updateLocked;
          return {
            ...removeUndefinedKeys(
              {
                description: ref('description'),
                exifImageWidth: ref('exifImageWidth'),
                exifImageHeight: ref('exifImageHeight'),
                fileSizeInByte: ref('fileSizeInByte'),
                orientation: ref('orientation'),
                dateTimeOriginal: ref('dateTimeOriginal'),
                modifyDate: ref('modifyDate'),
                timeZone: ref('timeZone'),
                latitude: ref('latitude'),
                longitude: ref('longitude'),
                projectionType: ref('projectionType'),
                city: ref('city'),
                livePhotoCID: ref('livePhotoCID'),
                autoStackId: ref('autoStackId'),
                state: ref('state'),
                country: ref('country'),
                make: ref('make'),
                model: ref('model'),
                lensModel: ref('lensModel'),
                fNumber: ref('fNumber'),
                focalLength: ref('focalLength'),
                iso: ref('iso'),
                exposureTime: ref('exposureTime'),
                profileDescription: ref('profileDescription'),
                colorspace: ref('colorspace'),
                bitsPerSample: ref('bitsPerSample'),
                rating: ref('rating'),
                fps: ref('fps'),
                tags: ref('tags'),
                lockedProperties:
                  lockedPropertiesBehavior === 'append'
                    ? distinctLocked(eb, exif.lockedProperties ?? null)
                    : ref('lockedProperties'),
              },
              exif,
            ),
          };
        }),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], { model: DummyValue.STRING }] })
  @Chunked()
  async updateAllExif(ids: string[], options: Updateable<AssetExifTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        ...options,
        lockedProperties: distinctLocked(eb, Object.keys(options) as LockableProperty[]),
      }))
      .where('assetId', 'in', ids)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.NUMBER, DummyValue.STRING] })
  @Chunked()
  updateDateTimeOriginal(ids: string[], delta?: number, timeZone?: string) {
    return this.db
      .updateTable('asset_exif')
      .set((eb) => ({
        dateTimeOriginal: sql`"dateTimeOriginal" + ${(delta ?? 0) + ' minute'}::interval`,
        timeZone,
        lockedProperties: distinctLocked(eb, ['dateTimeOriginal', 'timeZone']),
      }))
      .where('assetId', 'in', ids)
      .returning(['assetId', 'dateTimeOriginal', 'timeZone'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, ['description']] })
  unlockProperties(assetId: string, properties: LockableProperty[]) {
    return this.db
      .updateTable('asset_exif')
      .where('assetId', '=', assetId)
      .set(() => ({
        lockedProperties: sql`(case when not exists (select 1 from json_each("asset_exif"."lockedProperties") where value not in (select value from json_each(${properties}))) then null else (select json_group_array(value) from (select value, key from json_each("asset_exif"."lockedProperties") where value not in (select value from json_each(${properties})) order by key)) end)`,
      }))
      .execute();
  }

  async upsertJobStatus(...jobStatus: Insertable<AssetJobStatusTable>[]): Promise<void> {
    if (jobStatus.length === 0) {
      return;
    }

    const values = jobStatus.map((row) => ({ ...row, assetId: asUuid(row.assetId) }));
    await this.db
      .insertInto('asset_job_status')
      .values(values)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet((eb) =>
          removeUndefinedKeys(
            {
              duplicatesDetectedAt: eb.ref('excluded.duplicatesDetectedAt'),
              facesRecognizedAt: eb.ref('excluded.facesRecognizedAt'),
              metadataExtractedAt: eb.ref('excluded.metadataExtractedAt'),
              ocrAt: eb.ref('excluded.ocrAt'),
            },
            values[0],
          ),
        ),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getMetadata(assetId: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .execute();
  }

  upsertMetadata(id: string, items: Array<{ key: string; value: Record<string, unknown> }>) {
    if (items.length === 0) {
      return [];
    }

    return this.db
      .insertInto('asset_metadata')
      .values(items.map((item) => ({ assetId: id, ...item })))
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['key', 'value', 'updatedAt'])
      .execute();
  }

  upsertBulkMetadata(items: Insertable<AssetMetadataTable>[]) {
    return this.db
      .insertInto('asset_metadata')
      .values(items)
      .onConflict((oc) =>
        oc
          .columns(['assetId', 'key'])
          .doUpdateSet((eb) => ({ key: eb.ref('excluded.key'), value: eb.ref('excluded.value') })),
      )
      .returning(['assetId', 'key', 'value', 'updatedAt'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getMetadataByKey(assetId: string, key: string) {
    return this.db
      .selectFrom('asset_metadata')
      .select(['key', 'value', 'updatedAt'])
      .where('assetId', '=', assetId)
      .where('key', '=', key)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async deleteMetadataByKey(id: string, key: string) {
    await this.db.deleteFrom('asset_metadata').where('assetId', '=', id).where('key', '=', key).execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, key: DummyValue.STRING }]] })
  async deleteBulkMetadata(items: Array<{ assetId: string; key: string }>) {
    if (items.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (tx) => {
      for (const { assetId, key } of items) {
        await tx.deleteFrom('asset_metadata').where('assetId', '=', assetId).where('key', '=', key).execute();
      }
    });
  }

  create(asset: Insertable<AssetTable>) {
    return this.db.insertInto('asset').values(asset).returningAll().executeTakeFirstOrThrow();
  }

  @ChunkedArray({ chunkSize: 4000 })
  async createAll(assets: Insertable<AssetTable>[]) {
    if (assets.length === 0) {
      return [];
    }
    const ids = await this.db.insertInto('asset').values(assets).returning('id').execute();
    return ids.map(({ id }) => id);
  }

  @GenerateSql({ params: [DummyValue.UUID, { year: 2000, day: 1, month: 1 }] })
  getByDayOfYear(
    ownerIds: string[],
    { year, day, month }: YearMonthDay,
  ): Promise<{ year: number; assets: { id: string; localDateTime: string }[] }[]> {
    // SQLite port: recursive year series instead of generate_series/make_date,
    // row_number() window instead of lateral limit(20), json_group_array row
    // objects instead of json_agg("res").
    return this.db
      .withRecursive(
        'years',
        sql`(select cast(strftime('%Y', min(substr("localDateTime", 1, 10))) as integer) as y from asset
             union all
             select y + 1 from years where y + 1 <= ${year - 1})` as any,
      )
      .with('res', (qb) =>
        qb
          .selectFrom('years')
          .innerJoin(
            (eb) =>
              eb
                .selectFrom('asset')
                .innerJoin('asset_job_status', 'asset.id', 'asset_job_status.assetId')
                .select(['asset.id', 'asset.localDateTime'])
                .select(
                  sql<number>`row_number() over (partition by substr(asset."localDateTime", 1, 10) order by asset."localDateTime" desc)`.as(
                    'rn',
                  ),
                )
                .where(
                  sql<SqlBool>`substr(asset."localDateTime", 1, 10) in (select date from (select printf('%04d-%02d-%02d', y, ${month}, ${day}) as date from years))`,
                )
                .where(sql<SqlBool>`asset."ownerId" in (select value from json_each(pg_array_json(${ownerIds})))`)
                .where('asset.visibility', '=', AssetVisibility.Timeline)
                .where((eb2) =>
                  eb2.exists((qb2) =>
                    qb2
                      .selectFrom('asset_file')
                      .whereRef('assetId', '=', 'asset.id')
                      .where('asset_file.type', '=', AssetFileType.Preview),
                  ),
                )
                .where('asset.deletedAt', 'is', null)
                .as('a'),
            (join) => join.onTrue(),
          )
          .select(['a.id', 'a.localDateTime'])
          .where('a.rn', '<=', 20),
      )
      .selectFrom('res')
      .select(sql<number>`cast(strftime('%Y', substr("localDateTime", 1, 10)) as integer)`.as('year'))
      .select(
        sql<unknown>`json_group_array(json_object('id', jval(res."id"), 'localDateTime', jval(res."localDateTime")))`.as(
          'assets',
        ),
      )
      .groupBy(sql`substr("localDateTime", 1, 10)`)
      .orderBy(sql`substr("localDateTime", 1, 10)`, 'desc')
      .$castTo<{ year: number; assets: { id: string; localDateTime: string }[] }>()
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  getByIds(ids: string[]) {
    return this.db.selectFrom('asset').selectAll('asset').where('asset.id', '=', anyUuid(ids)).execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray({ paramIndex: 0 })
  getByIdsWithAllRelationsButStacks(ids: string[], viewingUserId?: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .select(withFacesAndPeople({ viewingUserId }))
      .select(withTags)
      .$call(withExif)
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string): Promise<void> {
    await this.db.deleteFrom('asset').where('ownerId', '=', ownerId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByLibraryIdAndOriginalPath(libraryId: string, originalPath: string) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLivePhotoCount(motionId: string): Promise<number> {
    const [{ count }] = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('livePhotoVideoId', '=', asUuid(motionId))
      .execute();
    return count;
  }

  @GenerateSql()
  getFileSamples() {
    return this.db.selectFrom('asset_file').select(['assetId', 'path']).limit(sql.lit(3)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForCopy(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'stackId', 'originalPath', 'isFavorite'])
      .select(withFiles)
      .where('id', '=', asUuid(id))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(
    id: string,
    { exifInfo, faces, files, library, owner, smartSearch, stack, tags, edits }: GetByIdsRelations = {},
  ) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('asset.id', '=', asUuid(id))
      .$if(!!exifInfo, withExif)
      .$if(!!faces, (qb) =>
        qb
          .select(faces?.person ? withFacesAndPeople({ viewingUserId: faces.viewingUserId! }) : withFaces)
          .$narrowType<{ faces: NotNull }>(),
      )
      .$if(!!library, (qb) => qb.select(withLibrary))
      .$if(!!owner, (qb) => qb.select(withOwner))
      .$if(!!smartSearch, withSmartSearch)
      .$if(!!stack, (qb) =>
        qb
          .$if(!stack!.assets, (qb2) =>
            qb2.select((eb) =>
              jsonObjectFrom(eb.selectFrom('stack').selectAll('stack').whereRef('stack.id', '=', 'asset.stackId'))
                .$castTo<Stack | null>()
                .as('stack'),
            ),
          )
          .$if(!!stack!.assets, (qb2) =>
            qb2.select((eb) =>
              jsonObjectFrom(
                eb
                  .selectFrom('stack')
                  .selectAll('stack')
                  .select(() =>
                    sql`(select json_group_array(${sqliteRowObjectSql('stacked', 'id', 'asset')}) from "asset" as "stacked" where "stacked"."stackId" = "stack"."id" and "stacked"."id" != "stack"."primaryAssetId" and "stacked"."deletedAt" is null and "stacked"."visibility" = ${AssetVisibility.Timeline} order by "stacked"."fileCreatedAt" asc)`.as(
                      'assets',
                    ),
                  )
                  .whereRef('stack.id', '=', 'asset.stackId'),
              )
                .$castTo<Stack | null>()
                .as('stack'),
            ),
          ),
      )
      .$if(!!files, (qb) => qb.select(withFiles))
      .$if(!!tags, (qb) => qb.select(withTags))
      .$if(!!edits, (qb) => qb.select(withEdits))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID], {}] })
  @Chunked()
  async updateAll(ids: string[], options: Updateable<AssetTable>): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.updateTable('asset').set(options).where('id', '=', anyUuid(ids)).execute();
  }

  async updateByLibraryId(libraryId: string, options: Updateable<AssetTable>): Promise<void> {
    await this.db.updateTable('asset').set(options).where('libraryId', '=', asUuid(libraryId)).execute();
  }

  async update(asset: Updateable<AssetTable> & { id: string }) {
    const value = omitBy(asset, isUndefined);
    delete value.id;
    if (!isEmpty(value)) {
      return this.db.transaction().execute(async (tx) => {
        await tx.updateTable('asset').set(asset).where('id', '=', asUuid(asset.id)).executeTakeFirst();
        return tx
          .selectFrom('asset')
          .selectAll('asset')
          .$call(withExif)
          .$call((qb) => qb.select(withFaces))
          .$call((qb) => qb.select(withEdits))
          .where('asset.id', '=', asUuid(asset.id))
          .executeTakeFirst();
      });
    }

    return this.getById(asset.id, { exifInfo: true, faces: {}, edits: true });
  }

  async remove(asset: { id: string }): Promise<void> {
    await this.db.deleteFrom('asset').where('id', '=', asUuid(asset.id)).execute();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, checksum: DummyValue.BUFFER }] })
  getByChecksum({ ownerId, libraryId, checksum }: AssetGetByChecksumOptions) {
    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .$call((qb) => (libraryId ? qb.where('libraryId', '=', asUuid(libraryId)) : qb.where('libraryId', 'is', null)))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.BUFFER]] })
  getByChecksums(userId: string, checksums: Buffer[]) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'checksum', 'deletedAt'])
      .where('ownerId', '=', asUuid(userId))
      .where('checksum', 'in', checksums)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  async getUploadAssetIdByChecksum(ownerId: string, checksum: Buffer): Promise<string | undefined> {
    const asset = await this.db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .where('libraryId', 'is', null)
      .limit(1)
      .executeTakeFirst();

    return asset?.id;
  }

  findLivePhotoMatch(options: LivePhotoSearchOptions) {
    const { ownerId, otherAssetId, livePhotoCID, type } = options;
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .where('id', '!=', asUuid(otherAssetId))
      .where('ownerId', '=', asUuid(ownerId))
      .where('type', '=', type)
      .where('asset_exif.livePhotoCID', '=', livePhotoCID)
      .limit(1)
      .executeTakeFirst();
  }

  getStatistics(ownerId: string, { visibility, isFavorite, isTrashed }: AssetStatsOptions): Promise<AssetStats> {
    return this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Audio).as(AssetType.Audio))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Image).as(AssetType.Image))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Video).as(AssetType.Video))
      .select((eb) => eb.fn.countAll<number>().filterWhere('type', '=', AssetType.Other).as(AssetType.Other))
      .where('ownerId', '=', asUuid(ownerId))
      .$if(visibility === undefined, withDefaultVisibility)
      .$if(!!visibility, (qb) => qb.where('asset.visibility', '=', visibility!))
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .$if(!!isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
      .where('deletedAt', isTrashed ? 'is not' : 'is', null)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({
    params: [DummyValue.UUID, { from: DummyValue.DATE, to: DummyValue.DATE, type: CalendarHeatmapType.Upload }],
  })
  getCalendarHeatmap(ownerId: string, dto: { from: Date; to: Date; type: CalendarHeatmapType }) {
    const dateColumns: Record<CalendarHeatmapType, { order: AssetOrderBy; column: 'createdAt' | 'localDateTime' }> = {
      [CalendarHeatmapType.Upload]: { order: AssetOrderBy.CreatedAt, column: 'createdAt' },
      [CalendarHeatmapType.Taken]: { order: AssetOrderBy.TakenAt, column: 'localDateTime' },
    } as const;

    const { order, column } = dateColumns[dto.type];

    const date = truncatedDate<Date>(order, 'DAY');

    return this.db
      .selectFrom('asset')
      .select(date.as('date'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', asUuid(ownerId))
      .where(column, '>=', dto.from)
      .where(column, '<', dto.to)
      .where('deletedAt', 'is', null)
      .groupBy(date)
      .orderBy('date', 'asc')
      .execute();
  }

  @GenerateSql({ params: [{}, { user: { id: DummyValue.UUID } }] })
  async getTimeBuckets(options: TimeBucketOptions, auth: AuthDto): Promise<TimeBucketItem[]> {
    return this.db
      .with('asset', (qb) =>
        qb
          .selectFrom('asset')
          .select(truncatedDate<Date>(options.orderBy).as('timeBucket'))
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb
              .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
              .where(
                sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
                '@>',
                sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
              );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .$if(options.visibility === undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.albumId, (qb) =>
            qb
              .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
              .where('album_asset.albumId', '=', asUuid(options.albumId!)),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.withStacked, (qb) =>
            qb
              .leftJoin('stack', (join) =>
                join.onRef('stack.id', '=', 'asset.stackId').onRef('stack.primaryAssetId', '=', 'asset.id'),
              )
              .where((eb) => eb.or([eb('asset.stackId', 'is', null), eb(eb.table('stack'), 'is not', null)])),
          )
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              // TODO this should become a shared `hasAccess` style helper once implement sharing in more places
              const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              return options.personId ? eb.or([isOwner, inSharedAlbum(auth.user.id, 'asset.id')]) : isOwner;
            }),
          )
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!)),
      )
      .selectFrom('asset')
      .select(sql<string>`("timeBucket" AT TIME ZONE 'UTC')::date::text`.as('timeBucket'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .groupBy('timeBucket')
      .orderBy('timeBucket', options.order ?? 'desc')
      .execute() as any as Promise<TimeBucketItem[]>;
  }

  @GenerateSql({
    params: [DummyValue.TIME_BUCKET, { withStacked: true }, { user: { id: DummyValue.UUID } }],
  })
  async getTimeBucket(timeBucket: string, options: TimeBucketOptions, auth: AuthDto) {
    const order = options.order ?? 'desc';
    const query = this.db
      .with('cte', (qb) =>
        qb
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
          .select((eb) => [
            'asset.duration',
            'asset.id',
            'asset.visibility',
            ...(
              [
                [
                  sql`json(case when asset."isFavorite" and asset."ownerId" = ${auth.user.id} then 'true' else 'false' end)`,
                  'isFavorite',
                ],
                [sql`json(case when asset.type = 'IMAGE' then 'true' else 'false' end)`, 'isImage'],
                [sql`json(case when asset."deletedAt" is not null then 'true' else 'false' end)`, 'isTrashed'],
              ] as const
            ).map(([e, a]) => e.as(a)),
            'asset.livePhotoVideoId',
            sql`extract(epoch from (asset."localDateTime" AT TIME ZONE 'UTC' - asset."fileCreatedAt" at time zone 'UTC'))::real / 3600`.as(
              'localOffsetHours',
            ),
            'asset.ownerId',
            'asset.status',
            sql`asset."fileCreatedAt" at time zone 'utc'`.as('fileCreatedAt'),
            sql`asset."createdAt" at time zone 'utc'`.as('createdAt'),
            eb.fn('encode', ['asset.thumbhash', sql.lit('base64')]).as('thumbhash'),
            'asset_exif.projectionType',
            eb.fn
              .coalesce(
                eb
                  .case()
                  .when(sql`asset."height" = 0 or asset."width" = 0`)
                  .then(eb.lit(1))
                  .else(sql`round(asset."width"::numeric / asset."height"::numeric, 3)`)
                  .end(),
                eb.lit(1),
              )
              .as('ratio'),
          ])
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select(['asset_exif.city', 'asset_exif.country']),
          )
          .$if(!!options.withCoordinates, (qb) => qb.select(['asset_exif.latitude', 'asset_exif.longitude']))
          .where('asset.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .$if(options.visibility === undefined, withDefaultVisibility)
          .$if(!!options.visibility, (qb) => qb.where('asset.visibility', '=', options.visibility!))
          .$if(!!options.bbox, (qb) => {
            const bbox = options.bbox!;
            const circle = getBoundingCircle(bbox);

            const withBoundingCircle = qb.where(
              sql`earth_box(ll_to_earth_public(${circle.centerLatitude}, ${circle.centerLongitude}), ${circle.radius})`,
              '@>',
              sql`ll_to_earth_public(asset_exif.latitude, asset_exif.longitude)`,
            );

            return withBoundingBox(withBoundingCircle, bbox);
          })
          .where(
            truncatedDate(options.orderBy),
            '=',
            // SQLite buckets are plain YYYY-MM-DD strings, so clamp to the date part;
            // Postgres casts the full bucket (including 5-digit year forms) to timestamptz.
            timeBucket.replace(/^[+-]/, '').slice(0, 10),
          )
          .$if(!!options.albumId, (qb) =>
            qb.where((eb) =>
              eb.exists(
                eb
                  .selectFrom('album_asset')
                  .whereRef('album_asset.assetId', '=', 'asset.id')
                  .where('album_asset.albumId', '=', asUuid(options.albumId!)),
              ),
            ),
          )
          .$if(!!options.personId, (qb) => hasPeople(qb, [options.personId!]))
          .$if(!!options.userIds, (qb) =>
            qb.where((eb) => {
              const isOwner = eb('asset.ownerId', '=', anyUuid(options.userIds!));
              return options.personId ? eb.or([isOwner, inSharedAlbum(auth.user.id, 'asset.id')]) : isOwner;
            }),
          )
          .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
          .$if(!!options.withStacked, (qb) =>
            qb
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('stack')
                      .whereRef('stack.id', '=', 'asset.stackId')
                      .whereRef('stack.primaryAssetId', '!=', 'asset.id'),
                  ),
                ),
              )
              .leftJoinLateral(
                (eb) =>
                  eb
                    .selectFrom('asset as stacked')
                    .select(sql`array[stacked."stackId"::text, count('stacked')::text]`.as('stack'))
                    .whereRef('stacked.stackId', '=', 'asset.stackId')
                    .where('stacked.deletedAt', 'is', null)
                    .where('stacked.visibility', '=', AssetVisibility.Timeline)
                    .groupBy('stacked.stackId')
                    .as('stacked_assets'),
                (join) => join.onTrue(),
              )
              .select('stack'),
          )
          .$if(!!options.assetType, (qb) => qb.where('asset.type', '=', options.assetType!))
          .$if(options.isDuplicate !== undefined, (qb) =>
            qb.where('asset.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          )
          .$if(!!options.isTrashed, (qb) => qb.where('asset.status', '!=', AssetStatus.Deleted))
          .$if(!!options.tagId, (qb) => withTagId(qb, options.tagId!))
          .orderBy(
            options.orderBy === AssetOrderBy.CreatedAt
              ? sql`"createdAt"`
              : sql`(asset."localDateTime" AT TIME ZONE 'UTC')::date`,
            order,
          )
          .orderBy('asset.fileCreatedAt', order)
          .orderBy('asset.originalFileName', order),
      )
      .with('agg', (qb) =>
        qb
          .selectFrom('cte')
          .select((eb) => aggCols(eb, AGG_BASE_COLS))
          .$if(!auth.sharedLink || auth.sharedLink.showExif, (qb) =>
            qb.select((eb) => aggCols(eb, ['city', 'country'])),
          )
          .$if(!!options.withCoordinates, (qb) => qb.select((eb) => aggCols(eb, ['latitude', 'longitude'])))
          .$if(!!options.withStacked, (qb) =>
            qb.select((eb) => eb.fn.coalesce(eb.fn('json_group_array', ['stack']), sql.lit('[]')).as('stack')),
          ),
      )
      .selectFrom('agg')
      .select(sqliteAggObject(aggColumnNames(options, auth)).as('assets'));

    const row = await query.executeTakeFirstOrThrow();
    // the PG variant handed back to_json(agg)::text as a raw string; SQLite's
    // json parse plugin already produced the object, so re-stringify it
    return { ...row, assets: JSON.stringify(row.assets) };
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5, maxFields: 12 }] })
  async getAssetIdByCity(ownerId: string, { minAssetsPerField, maxFields }: AssetExploreFieldOptions) {
    const items = await this.db
      .with('cities', (qb) =>
        qb
          .selectFrom('asset_exif')
          .select('city')
          .where('city', 'is not', null)
          .groupBy('city')
          .having((eb) => eb.fn('count', [eb.ref('assetId')]), '>=', minAssetsPerField),
      )
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('cities', 'asset_exif.city', 'cities.city')
      .distinctOn('asset_exif.city')
      .select(['assetId as data', 'asset_exif.city as value'])
      .$narrowType<{ value: NotNull }>()
      .where('ownerId', '=', asUuid(ownerId))
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .limit(maxFields)
      .execute();

    return { fieldName: 'exifInfo.city', items };
  }

  @GenerateSql({ params: [DummyValue.UUID, 12] })
  async getRecentlyCreatedAssetIds(ownerId: string, maxAssets: number) {
    const items = await this.db
      .selectFrom('asset')
      .select(['id as data', 'createdAt as value'])
      .where('ownerId', '=', asUuid(ownerId))
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('type', '=', AssetType.Image)
      .where('deletedAt', 'is', null)
      .orderBy('value', 'desc')
      .limit(maxAssets)
      .execute();

    return { fieldName: 'createdAt', items };
  }

  async upsertFile(
    file: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >,
  ): Promise<void> {
    await this.db
      .insertInto('asset_file')
      .values(file)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
        })),
      )
      .execute();
  }

  async upsertFiles(
    files: Pick<
      Insertable<AssetFileTable>,
      'assetId' | 'path' | 'type' | 'isEdited' | 'isProgressive' | 'isTransparent'
    >[],
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_file')
      .values(files)
      .onConflict((oc) =>
        oc.columns(['assetId', 'type', 'isEdited']).doUpdateSet((eb) => ({
          path: eb.ref('excluded.path'),
          isProgressive: eb.ref('excluded.isProgressive'),
          isTransparent: eb.ref('excluded.isTransparent'),
        })),
      )
      .execute();
  }

  async deleteFile({
    assetId,
    type,
    edited,
  }: {
    assetId: string;
    type: AssetFileType;
    edited?: boolean;
  }): Promise<void> {
    await this.db
      .deleteFrom('asset_file')
      .where('assetId', '=', asUuid(assetId))
      .where('type', '=', type)
      .$if(edited !== undefined, (qb) => qb.where('isEdited', '=', edited!))
      .execute();
  }

  async deleteFiles(files: Pick<Selectable<AssetFileTable>, 'id'>[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('asset_file')
      .where('id', '=', anyUuid(files.map((file) => file.id)))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING], [DummyValue.STRING]] })
  async detectOfflineExternalAssets(
    libraryId: string,
    importPaths: string[],
    exclusionPatterns: string[],
  ): Promise<UpdateResult> {
    const paths = importPaths.map((importPath) => `${importPath}%`);
    const exclusions = exclusionPatterns.map((pattern) => globToPostgresRegex(pattern));

    return this.db
      .updateTable('asset')
      .set({
        isOffline: true,
        deletedAt: new Date(),
      })
      .where('isOffline', '=', false)
      .where('isExternal', '=', true)
      .where('libraryId', '=', asUuid(libraryId))
      .where((eb) =>
        eb.or([
          eb.not(eb.or(paths.map((path) => eb('originalPath', 'like', path)))),
          eb.or(exclusions.map((pattern) => eb('originalPath', '~*', pattern))),
        ]),
      )
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async filterNewExternalAssetPaths(libraryId: string, paths: string[]): Promise<string[]> {
    const result = await this.db
      .selectFrom(unnest(paths).as('path'))
      .select('path')
      .where((eb) =>
        eb.not(
          eb.exists(
            this.db
              .selectFrom('asset')
              .select('originalPath')
              .whereRef('asset.originalPath', '=', eb.ref('path'))
              .where('libraryId', '=', asUuid(libraryId))
              .where('isExternal', '=', true),
          ),
        ),
      )
      .execute();

    return result.map((row) => row.path as string);
  }

  async getLibraryAssetCount(libraryId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('libraryId', '=', asUuid(libraryId))
      .executeTakeFirstOrThrow();

    return count;
  }

  private buildGetForOriginal(ids: string[], isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .select('asset.id')
      .select('originalFileName')
      .where('asset.id', 'in', ids)
      .$if(isEdited, (qb) =>
        qb
          .leftJoin('asset_file', (join) =>
            join
              .onRef('asset.id', '=', 'asset_file.assetId')
              .on('asset_file.isEdited', '=', true)
              .on('asset_file.type', '=', AssetFileType.FullSize),
          )
          .select('asset_file.path as editedPath'),
      )
      .select('originalPath');
  }

  @GenerateSql({ params: [DummyValue.UUID, true] })
  getForOriginal(id: string, isEdited: boolean) {
    return this.buildGetForOriginal([id], isEdited).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [[DummyValue.UUID], true] })
  getForOriginals(ids: string[], isEdited: boolean) {
    return this.buildGetForOriginal(ids, isEdited).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Preview, true] })
  async getForThumbnail(id: string, type: AssetFileType, isEdited: boolean) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', type),
      )
      .select(['asset.originalPath', 'asset.originalFileName', 'asset_file.path as path'])
      .orderBy('asset_file.isEdited', isEdited ? 'desc' : 'asc')
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForVideo(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.originalPath'])
      .select((eb) => withFilePath(eb, AssetFileType.EncodedVideo).as('encodedVideoPath'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', AssetType.Video)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', id)
      .select(withEdits)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageWidth', 'asset_exif.exifImageHeight', 'asset_exif.orientation'])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForEdit(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.type', 'asset.livePhotoVideoId', 'asset.originalPath', 'asset.originalFileName'])
      .where('asset.id', '=', id)
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select([
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        'asset_exif.orientation',
        'asset_exif.projectionType',
      ])
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForMetadataExtractionTags(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.tags')
      .where('asset_exif.assetId', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForFaces(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (join) => join.onRef('asset_exif.assetId', '=', 'asset.id'))
      .select(['asset_exif.exifImageHeight', 'asset_exif.exifImageWidth', 'asset_exif.orientation'])
      .select(withEdits)
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForUpdateTags(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('tag')
            .select('tag.value')
            .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
            .whereRef('asset.id', '=', 'tag_asset.assetId'),
        ).as('tags'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
