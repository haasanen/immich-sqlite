import { Injectable } from '@nestjs/common';
import { Expression, Insertable, Kysely, NotNull, SqlBool, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readLine from 'node:readline';
import { citiesFile, reverseGeocodeMaxDistance } from 'src/constants.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetVisibility, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { GeodataPlacesTable } from 'src/schema/tables/geodata-places.table.js';
import { NaturalEarthCountriesTable } from 'src/schema/tables/natural-earth-countries.table.js';

export interface MapMarkerSearchOptions {
  isArchived?: boolean;
  isFavorite?: boolean;
  fileCreatedBefore?: Date;
  fileCreatedAfter?: Date;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface ReverseGeocodeResult {
  country: string | null;
  state: string | null;
  city: string | null;
}

export interface MapDB extends DB {
  geodata_places_tmp: GeodataPlacesTable;
  naturalearth_countries_tmp: NaturalEarthCountriesTable;
}

interface CountryNames {
  byAlpha2: Map<string, string>;
  byAlpha3: Map<string, string>;
}

// Ray-casting point-in-polygon (x=longitude, y=latitude); replaces PG polygon `@>`
const pointInPolygon = (x: number, y: number, ring: [number, number][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

@Injectable()
export class MapRepository {
  private countryNames?: Promise<CountryNames>;

  constructor(
    private configRepository: ConfigRepository,
    private metadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
    @InjectKysely() private db: Kysely<MapDB>,
  ) {
    this.logger.setContext(MapRepository.name);
  }

  async init(): Promise<void> {
    this.logger.log('Initializing metadata repository');
    const { resourcePaths } = this.configRepository.getEnv();
    const geodataDate = await readFile(resourcePaths.geodata.dateFile, 'utf8');

    // TODO move to service init
    const geocodingMetadata = await this.metadataRepository.get(SystemMetadataKey.ReverseGeocodingState);
    if (geocodingMetadata?.lastUpdate === geodataDate) {
      await this.ensurePlacesTrgmIndex();
      return;
    }

    await Promise.all([this.importGeodata(), this.importNaturalEarthCountries()]);

    await this.metadataRepository.set(SystemMetadataKey.ReverseGeocodingState, {
      lastUpdate: geodataDate,
      lastImportFileName: citiesFile,
    });

    this.logger.log('Geodata import completed');
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getAlbumMapMarkers(albumId: string) {
    return this.mapMarkersQuery()
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  getMapMarkers(
    authUserId: string,
    ownerIds: string[],
    albumIds: string[],
    { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore }: MapMarkerSearchOptions = {},
  ) {
    return this.mapMarkersQuery()
      .$if(isArchived === true, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('asset.visibility', '=', AssetVisibility.Timeline),
            eb.and([eb('asset.ownerId', '=', authUserId), eb('asset.visibility', '=', AssetVisibility.Archive)]),
          ]),
        ),
      )
      .$if(isArchived === false || isArchived === undefined, (qb) =>
        qb.where('asset.visibility', '=', AssetVisibility.Timeline),
      )
      .$if(isFavorite !== undefined, (q) => q.where('isFavorite', '=', isFavorite!))
      .$if(fileCreatedAfter !== undefined, (q) => q.where('fileCreatedAt', '>=', fileCreatedAfter!))
      .$if(fileCreatedBefore !== undefined, (q) => q.where('fileCreatedAt', '<=', fileCreatedBefore!))
      .where((eb) => {
        const expression: Expression<SqlBool>[] = [];

        if (ownerIds.length > 0) {
          expression.push(eb('ownerId', 'in', ownerIds));
        }

        if (albumIds.length > 0) {
          expression.push(
            eb.exists((eb) =>
              eb
                .selectFrom('album_asset')
                .whereRef('asset.id', '=', 'album_asset.assetId')
                .where('album_asset.albumId', 'in', albumIds),
            ),
          );
        }

        return eb.or(expression);
      })
      .execute();
  }

  private mapMarkersQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (builder) =>
        builder
          .onRef('asset.id', '=', 'asset_exif.assetId')
          .on('asset_exif.latitude', 'is not', null)
          .on('asset_exif.longitude', 'is not', null),
      )
      .where('asset.deletedAt', 'is', null)
      .orderBy('fileCreatedAt', 'desc')
      .select([
        'id',
        'asset_exif.latitude as lat',
        'asset_exif.longitude as lon',
        'asset_exif.city',
        'asset_exif.state',
        'asset_exif.country',
      ])
      .$narrowType<{ lat: NotNull; lon: NotNull }>();
  }

  async reverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult> {
    this.logger.debug(`Request: ${point.latitude},${point.longitude}`);

    const countryNames = await this.loadCountryNames();

    // FORK (SQLite): earthdistance/GiST do not exist here. Bounding-box prefilter
    // (served by idx_geodata_places_latlon) + haversine scalar reproduces earth_box +
    // earth_distance semantics at this radius; 25 km keeps the box small.
    const dLat = reverseGeocodeMaxDistance / 111_320;
    const dLon = reverseGeocodeMaxDistance / (111_320 * Math.max(Math.cos((point.latitude * Math.PI) / 180), 0.01));

    const response = await this.db
      .selectFrom('geodata_places')
      .selectAll()
      .where(
        sql<SqlBool>`(latitude between ${point.latitude - dLat} and ${point.latitude + dLat}) and
             (longitude between ${point.longitude - dLon} and ${point.longitude + dLon}) and
             geo_distance_m(${point.latitude}, ${point.longitude}, latitude, longitude) <= ${reverseGeocodeMaxDistance}`,
      )
      .orderBy(sql`geo_distance_m(${point.latitude}, ${point.longitude}, latitude, longitude)`)
      .limit(1)
      .executeTakeFirst();

    if (response) {
      this.logger.verboseFn(() => `Raw: ${JSON.stringify(response, null, 2)}`);

      const { countryCode, name: city, admin1Name } = response;
      const country = countryNames.byAlpha2.get(countryCode) ?? null;
      const state = admin1Name;

      return { country, state, city };
    }

    this.logger.log(
      `Empty response from database for city reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}. Likely cause: no nearby large populated place (500+ within ${reverseGeocodeMaxDistance / 1000}km). Falling back to country boundaries.`,
    );

    const polygons = await this.loadCountryPolygons();
    const hit = polygons.find((p) => pointInPolygon(point.longitude, point.latitude, p.ring));

    if (!hit) {
      this.logger.log(
        `Empty response from database for natural earth country reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}`,
      );

      return { country: null, state: null, city: null };
    }

    const { admin_a3 } = hit;
    const country = countryNames.byAlpha3.get(admin_a3) ?? null;
    const state = null;
    const city = null;

    return { country, state, city };
  }

  private countryPolygons?: Promise<{ admin_a3: string; ring: [number, number][] }[]>;

  private loadCountryPolygons() {
    this.countryPolygons ??= this.readCountryPolygons().catch((error) => {
      this.countryPolygons = undefined;
      throw error;
    });
    return this.countryPolygons;
  }

  private async readCountryPolygons() {
    const rows = await this.db.selectFrom('naturalearth_countries').select(['admin_a3', 'coordinates']).execute();
    const out: { admin_a3: string; ring: [number, number][] }[] = [];
    for (const row of rows) {
      const ring: [number, number][] = Array.from(
        row.coordinates.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g),
        (m) => [Number(m[1]), Number(m[2])],
      );
      if (ring.length > 2) {
        out.push({ admin_a3: row.admin_a3, ring });
      }
    }
    this.logger.log(`Loaded ${out.length} country polygons for reverse-geocode fallback`);
    return out;
  }

  // init() skips the geodata import when it is up to date, so load the names on demand
  private async loadCountryNames(): Promise<CountryNames> {
    this.countryNames ??= this.readCountryNames();
    try {
      return await this.countryNames;
    } catch (error) {
      this.countryNames = undefined;
      throw error;
    }
  }

  private async readCountryNames(): Promise<CountryNames> {
    const byAlpha2 = new Map<string, string>();
    const byAlpha3 = new Map<string, string>();

    const { resourcePaths } = this.configRepository.getEnv();
    const filePath = resourcePaths.geodata.countryInfo;
    if (!existsSync(filePath)) {
      throw new Error(`Geodata file ${filePath} not found`);
    }

    const lineReader = readLine.createInterface({ input: createReadStream(filePath) });
    for await (const line of lineReader) {
      if (line.startsWith('#')) {
        continue;
      }
      // Columns: ISO alpha-2, ISO alpha-3, ISO numeric, fips, Country, ...
      const fields = line.split('\t', 5);
      const alpha2 = fields[0];
      const alpha3 = fields[1];
      const name = fields[4]?.trim();
      if (!name) {
        continue;
      }
      if (alpha2) {
        byAlpha2.set(alpha2, name);
      }
      if (alpha3) {
        byAlpha3.set(alpha3, name);
      }
    }

    this.logger.log(`Loaded ${byAlpha2.size} country names from ${filePath}`);
    return { byAlpha2, byAlpha3 };
  }

  private async importNaturalEarthCountries() {
    const { resourcePaths } = this.configRepository.getEnv();
    const geoJSONData = JSON.parse(await readFile(resourcePaths.geodata.naturalEarthCountriesPath, 'utf8'));
    if (geoJSONData.type !== 'FeatureCollection' || !Array.isArray(geoJSONData.features)) {
      this.logger.fatal('Invalid GeoJSON FeatureCollection');
      return;
    }

    const entities: Insertable<NaturalEarthCountriesTable>[] = [];
    for (const feature of geoJSONData.features) {
      for (const entry of feature.geometry.coordinates) {
        const coordinates: number[][][] = feature.geometry.type === 'MultiPolygon' ? entry[0] : entry;
        const featureRecord: Insertable<NaturalEarthCountriesTable> = {
          admin: feature.properties.ADMIN,
          admin_a3: feature.properties.ADM0_A3,
          type: feature.properties.TYPE,
          coordinates: `(${coordinates.map((point) => `(${point[0]},${point[1]})`).join(', ')})`,
        };
        entities.push(featureRecord);
        if (feature.geometry.type === 'Polygon') {
          break;
        }
      }
    }

    // FORK (SQLite): table + PK already exist from the boot schema; truncate + refill.
    await this.db.deleteFrom('naturalearth_countries').execute();
    await this.db.insertInto('naturalearth_countries').values(entities).execute();
  }

  private async importGeodata() {
    const { resourcePaths } = this.configRepository.getEnv();
    const [admin1, admin2] = await Promise.all([
      this.loadAdmin(resourcePaths.geodata.admin1),
      this.loadAdmin(resourcePaths.geodata.admin2),
    ]);

    // FORK (SQLite): table + PK ship in the boot schema; truncate + refill.
    await this.db.deleteFrom('geodata_places').execute();
    await this.loadCities500(admin1, admin2);
    await this.createGeodataIndices();
    await this.buildPlacesTrgmIndex();
  }

  // FORK (SQLite): volumes created before the trigram index existed (or where the
  // snapshot marker matches and the import is a no-op) must still get a usable
  // prefilter: build whenever geodata rows exist but the index is empty.
  private async ensurePlacesTrgmIndex() {
    const { count: places } = await this.db
      .selectFrom('geodata_places')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(places) === 0) {
      return;
    }
    await sql`create virtual table if not exists geodata_places_trgm using fts5(txt, tokenize='trigram')`.execute(
      this.db,
    );
    const row = await this.db
      .selectFrom(sql`geodata_places_trgm`.as('t'))
      .select(sql`count(*)`.as('c'))
      .executeTakeFirstOrThrow();
    if (Number(row.c) === 0) {
      await this.buildPlacesTrgmIndex();
    }
  }

  private async loadCities500(admin1Map: Map<string, string>, admin2Map: Map<string, string>) {
    const { resourcePaths } = this.configRepository.getEnv();
    const cities500 = resourcePaths.geodata.cities500;
    if (!existsSync(cities500)) {
      throw new Error(`Geodata file ${cities500} not found`);
    }

    this.logger.log(`Starting geodata import`);
    const startTime = performance.now();

    const input = createReadStream(cities500, { highWaterMark: 512 * 1024 * 1024 });
    let bufferGeodata = [];
    const lineReader = readLine.createInterface({ input });
    let count = 0;

    let futures = [];
    for await (const line of lineReader) {
      const lineSplit = line.split('\t');
      if ((lineSplit[7] === 'PPLX' && lineSplit[8] !== 'AU') || lineSplit[7] === 'PPLH') {
        continue;
      }

      const geoData = {
        id: Number.parseInt(lineSplit[0]),
        name: lineSplit[1],
        alternateNames: lineSplit[3],
        latitude: Number(lineSplit[4]),
        longitude: Number(lineSplit[5]),
        countryCode: lineSplit[8],
        admin1Code: lineSplit[10],
        admin2Code: lineSplit[11],
        modificationDate: lineSplit[18],
        admin1Name: admin1Map.get(`${lineSplit[8]}.${lineSplit[10]}`) ?? null,
        admin2Name: admin2Map.get(`${lineSplit[8]}.${lineSplit[10]}.${lineSplit[11]}`) ?? null,
      };
      bufferGeodata.push(geoData);
      // SQLite binds are capped at 32766 parameters per statement; this row shape has
      // 11 columns, so 2000 rows per insert (22k binds) is the safe fork batch size.
      if (bufferGeodata.length < 2000) {
        continue;
      }

      const curLength = bufferGeodata.length;
      futures.push(
        this.db
          .insertInto('geodata_places')
          .values(bufferGeodata)
          .execute()

          .then(() => {
            count += curLength;
            if (count % 10_000 === 0) {
              this.logger.log(`${count} geodata records imported`);
            }
          }),
      );
      bufferGeodata = [];
      // leave spare connection for other queries
      if (!(futures.length >= 9)) {
        continue;
      }

      await Promise.all(futures);
      futures = [];
    }

    if (bufferGeodata.length > 0) {
      await this.db.insertInto('geodata_places').values(bufferGeodata).execute();
      count += bufferGeodata.length;
    }

    await Promise.all(futures);

    const duration = performance.now() - startTime;
    const seconds = duration / 1000;
    const recordsPerSecond = Math.round(count / seconds);

    this.logger.log(
      `Successfully imported ${count} geodata records in ${seconds.toFixed(2)}s (${recordsPerSecond} records/second)`,
    );
  }

  private async loadAdmin(filePath: string) {
    if (!existsSync(filePath)) {
      this.logger.error(`Geodata file ${filePath} not found`);
      throw new Error(`Geodata file ${filePath} not found`);
    }

    const input = createReadStream(filePath, { highWaterMark: 512 * 1024 * 1024 });
    const lineReader = readLine.createInterface({ input });

    const adminMap = new Map<string, string>();
    for await (const line of lineReader) {
      const lineSplit = line.split('\t');
      adminMap.set(lineSplit[0], lineSplit[1]);
    }

    return adminMap;
  }

  private createGeodataIndices() {
    // FORK (SQLite): PK ships in the boot schema. The PG GiST earth-coordinate index
    // and gin_trgm expression indexes have no SQLite equivalent; the lat/lon composite
    // serves the bbox prefilter, and pg_trgm comparisons run in JS scalars instead.
    return this.db.schema
      .createIndex('idx_geodata_places_latlon')
      .ifNotExists()
      .on('geodata_places')
      .columns(['latitude', 'longitude'])
      .execute();
  }

  // FORK (SQLite): Postgres accelerates pg_trgm place search with a GIN expression
  // index; SQLite has no GIN. An FTS5 table with the built-in trigram tokenizer over
  // accent-folded searchable text serves as the prefilter for the word-similarity
  // gate in searchPlaces. Superset-safe: any word_similarity >= 0.6 match shares a
  // contiguous run of >= 3 trigrams with some needle word — i.e. a shared >= 3-char
  // substring — which the trigram tokenizer indexes. Needles with any word < 3 chars
  // skip the prefilter (see SearchRepository.placesTrgmPrefilter).
  private async buildPlacesTrgmIndex() {
    const t0 = Date.now();
    await sql`create virtual table if not exists geodata_places_trgm using fts5(txt, tokenize='trigram')`.execute(
      this.db,
    );
    await sql`delete from geodata_places_trgm`.execute(this.db);

    let lastId = -1;
    let count = 0;
    while (true) {
      // Compose the searchable text in SQL, prefixed with a space: some geonames
      // alternateNames values are bare pronunciations like "[ɔˈɕɛlskɔ]", and Kysely's
      // ParseJSONResultsPlugin JSON.parses any result string starting with '[' — the
      // leading space keeps the value out of its sniffing while being trigram-irrelevant.
      const rows = await sql<{ id: number; txt: string }>`
        select "id", (' ' || ${this.txtExpr()}) as txt from geodata_places
        where "id" > ${lastId} order by "id" asc limit 5000
      `.execute(this.db);
      if (rows.rows.length === 0) {
        break;
      }
      lastId = rows.rows.at(-1)!.id;
      await sql`insert into geodata_places_trgm(rowid, txt) values ${sql.join(
        rows.rows.map((row) => sql`(${row.id}, ${row.txt})`),
        sql`, `,
      )}`.execute(this.db);
      count += rows.rows.length;
    }
    this.logger.log(
      `Built geodata_places_trgm index for ${count} records in ${((Date.now() - t0) / 1000).toFixed(2)}s`,
    );
  }

  private txtExpr() {
    return sql`f_unaccent(
      "name" || ' ' || coalesce("admin1Name", '') || ' ' || coalesce("admin2Name", '') || ' ' || coalesce("alternateNames", '')
    )`;
  }
}
