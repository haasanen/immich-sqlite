import { Kysely } from 'kysely';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumRepository.name, () => {
  describe('addAssetIds (Postgres unnest cast shim)', () => {
    it('links all requested assets through the uuid[] array path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        ids.push(asset.id);
      }

      await sut.addAssetIds(album.id, ids);

      const found = await sut.getAssetIds(album.id, ids);
      expect(found.size).toBe(3);
    });
  });
});
