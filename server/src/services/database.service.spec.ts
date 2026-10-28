import { DatabaseLock } from 'src/enum.js';
import { DatabaseService } from 'src/services/database.service.js';
import { envData, mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(DatabaseService.name, () => {
  let sut: DatabaseService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DatabaseService));
  });

  describe('onBootstrap', () => {
    it('should run migrations under the migrations lock', async () => {
      mocks.database.runMigrations.mockResolvedValue(1);

      await sut.onBootstrap();

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
      expect(mocks.database.runMigrations).toHaveBeenCalled();
    });

    it('should skip migrations when configured', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ database: { ...envData.database, skipMigrations: true } }));

      await sut.onBootstrap();

      expect(mocks.database.runMigrations).not.toHaveBeenCalled();
    });
  });
});
