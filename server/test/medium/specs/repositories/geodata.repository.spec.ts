import { Kysely } from 'kysely';
import type { MapDB } from 'src/repositories/map.repository.js';
import { SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// map.repository resolves geodata files through config resource paths (buildFolder +
// 'geodata'); point the build folder at the committed fixture tree before any getEnv().
process.env.IMMICH_BUILD_DATA = 'test/resources/geodata-fixture';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  // not in the factory's real-repository switch; construct directly against the medium DB
  const map = new MapRepository(
    new ConfigRepository(),
    ctx.get(SystemMetadataRepository),
    ctx.get(LoggingRepository),
    database as unknown as Kysely<MapDB>,
  );
  return { ctx, map, search: ctx.get(SearchRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MapRepository.name + ' geodata (SQLite port)', () => {
  it('imports geodata from the shipped snapshot and records the marker', async () => {
    const { ctx, map } = setup();
    await map.init();

    const places = await defaultDatabase.selectFrom('geodata_places').selectAll().execute();
    expect(places.length).toBe(4);
    const countries = await defaultDatabase.selectFrom('naturalearth_countries').selectAll().execute();
    expect(countries.length).toBe(1);

    const smd = ctx.get(SystemMetadataRepository);
    const state = await smd.get(SystemMetadataKey.ReverseGeocodingState);
    expect(state?.lastUpdate).toBe('2026-01-01T00:00:00+0000');

    // second init must be a no-op (marker matches)
    await map.init();
    const places2 = await defaultDatabase.selectFrom('geodata_places').selectAll().execute();
    expect(places2.length).toBe(4);
  });

  it('reverse geocodes to the nearest place with admin names', async () => {
    const { map } = setup();
    const result = await map.reverseGeocode({ latitude: 48.14, longitude: 11.57 });
    expect(result).toEqual({ country: 'Germany', state: 'Bavaria', city: 'München' });
  });

  it('falls back to country polygons when no place is within the radius', async () => {
    const { map } = setup();
    const result = await map.reverseGeocode({ latitude: 50, longitude: 10 });
    expect(result).toEqual({ country: 'Germany', state: null, city: null });
  });

  it('returns nothing when outside imported data', async () => {
    const { map } = setup();
    const result = await map.reverseGeocode({ latitude: -33.87, longitude: 151.21 });
    expect(result).toEqual({ country: null, state: null, city: null });
  });

  it('matches places accent-insensitively through word similarity', async () => {
    const { search } = setup();
    const folded = await search.searchPlaces('munchen');
    expect(folded.map((p) => p.name)).toContain('München');
    const reverse = await search.searchPlaces('München');
    expect(reverse.map((p) => p.name)).toContain('München');
    const byAlternate = await search.searchPlaces('Londres');
    expect(byAlternate.map((p) => p.name)).toContain('London');
  });

  it('ranks places best-match-first (<->>> is a word-similarity distance, not a score)', async () => {
    const { search } = setup();
    // 'Munchenweiler' passes the similarity gate (7/8 of the needle's trigrams run
    // contiguously) but is a worse match than München == needle. If <->>> were
    // mapped to a raw score, ascending ORDER BY would surface Munchenweiler first.
    const items = await search.searchPlaces('munchen');
    const names = items.map((p) => p.name);
    expect(names).toContain('Munchenweiler');
    expect(names[0]).toBe('München');
    expect(names.indexOf('München')).toBeLessThan(names.indexOf('Munchenweiler'));
  });
});
