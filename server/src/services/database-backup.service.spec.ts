import { JobStatus } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { AutoMocked, ServiceMocks, automock, getMocks } from 'test/utils.js';

// Fork (phase4): Postgres is gone from the product, so the pg_dump/psql backup
// and restore pipelines are removed. The service remains for the queue/cron
// surface and fails fast. Upload/download/list of backup files stay available
// as plain file operations.
describe(DatabaseBackupService.name, () => {
  let sut: DatabaseBackupService;
  let mocks: ServiceMocks;
  let maintenanceHealthRepositoryMock: AutoMocked<MaintenanceHealthRepository>;

  beforeEach(() => {
    mocks = getMocks();
    maintenanceHealthRepositoryMock = automock(MaintenanceHealthRepository, {
      args: [mocks.logger],
      strict: false,
    });
    sut = new DatabaseBackupService(
      mocks.logger as never,
      mocks.storage as never,
      mocks.config,
      mocks.systemMetadata as never,
      mocks.process,
      mocks.database as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      maintenanceHealthRepositoryMock as never,
    );
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  it('should fail the backup job fast on the SQLite engine', async () => {
    await expect(sut.handleBackupDatabase()).resolves.toBe(JobStatus.Failed);
    expect(mocks.process.spawnDuplexStream).not.toHaveBeenCalled();
  });

  it('should refuse restore on the SQLite engine', async () => {
    await expect(sut.restoreDatabaseBackup('immich-db-backup.sql.gz')).rejects.toThrow(
      'Database restore is not supported on the SQLite engine',
    );
  });
});
