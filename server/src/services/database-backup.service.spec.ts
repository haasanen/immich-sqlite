import { Readable, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { JobStatus } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { AutoMocked, ServiceMocks, automock, getMocks } from 'test/utils.js';

// Fork (phase4): Postgres is gone from the product, so the pg_dump/psql backup
// pipelines are replaced by VACUUM INTO snapshots (gzipped). Restore stays
// unsupported in-process (a live SQLite file cannot be swapped under itself);
// manual restore is documented in the wiki deploy runbook. Upload/download/list
// of backup files stay available as plain file operations.
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

  it('creates a gzipped VACUUM INTO snapshot and reaps the tmp file', async () => {
    mocks.database.getSqliteVersion.mockResolvedValue('3.53.2');
    mocks.database.backupDatabase.mockResolvedValue(undefined);
    const written: string[] = [];
    mocks.storage.createPlainReadStream.mockReturnValue(Readable.from(['snapshot']) as never);
    mocks.storage.createGzip.mockReturnValue(createGzip());
    mocks.storage.createWriteStream.mockImplementation((filepath: string) => {
      written.push(filepath);
      return new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }) as never;
    });
    mocks.storage.unlink.mockResolvedValue(undefined);
    mocks.storage.stat.mockResolvedValue({ size: 42 } as never);
    mocks.storage.readdir.mockResolvedValue([]);

    await expect(sut.handleBackupDatabase()).resolves.toBe(JobStatus.Success);

    expect(mocks.database.backupDatabase.mock.calls[0][0]).toMatch(
      /immich-db-backup-\d{8}T\d{6}-v.*-sqlite3\.53\.2\.sqlite\.tmp$/,
    );
    expect(written[0]).toMatch(/immich-db-backup-\d{8}T\d{6}-v.*-sqlite3\.53\.2\.sqlite\.gz$/);
    expect(mocks.storage.unlink.mock.calls[0][0]).toMatch(/\.sqlite\.tmp$/);
  });

  it('fails the job and leaves the tmp for retention when the snapshot errors', async () => {
    mocks.database.getSqliteVersion.mockResolvedValue('3.53.2');
    mocks.database.backupDatabase.mockRejectedValue(new Error('disk full'));
    mocks.storage.unlink.mockResolvedValue(undefined);

    await expect(sut.handleBackupDatabase()).resolves.toBe(JobStatus.Failed);
  });

  it('should refuse restore on the SQLite engine', async () => {
    await expect(sut.restoreDatabaseBackup('immich-db-backup.sql.gz')).rejects.toThrow(
      'Database restore is not supported on the SQLite engine',
    );
  });
});
