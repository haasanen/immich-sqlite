import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { DateTime } from 'luxon';
import path, { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { DatabaseBackupListResponseDto } from 'src/dtos/database-backup.dto.js';
import { CacheControl, DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName, StorageFolder } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getConfig } from 'src/utils/config.js';
import {
  isFailedDatabaseBackupName,
  isValidDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
} from 'src/utils/database-backups.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { handlePromiseError } from 'src/utils/misc.js';

@Injectable()
export class DatabaseBackupService {
  constructor(
    private readonly logger: LoggingRepository,
    private readonly storageRepository: StorageRepository,
    private readonly configRepository: ConfigRepository,
    private readonly systemMetadataRepository: SystemMetadataRepository,
    private readonly processRepository: ProcessRepository,
    private readonly databaseRepository: DatabaseRepository,
    private readonly userRepository: UserRepository,
    @Optional()
    private readonly cronRepository: CronRepository,
    @Optional()
    private readonly jobRepository: JobRepository,
    @Optional()
    private readonly maintenanceHealthRepository: MaintenanceHealthRepository,
  ) {
    this.logger.setContext(this.constructor.name);
  }

  private backupLock = false;

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      backup: { database },
    },
  }: ArgOf<'ConfigInit'>) {
    if (!this.cronRepository || !this.jobRepository) {
      return;
    }

    // SQLite port: backups run through VACUUM INTO (engine-native online
    // snapshot); the same cron/retention surface drives them, so the lock and
    // cron registration below apply to this engine too.
    this.backupLock = await this.databaseRepository.tryLock(DatabaseLock.BackupDatabase);

    if (this.backupLock) {
      this.cronRepository.create({
        name: 'backupDatabase',
        expression: database.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.DatabaseBackup }), this.logger),
        start: database.enabled,
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { backup } }: ArgOf<'ConfigUpdate'>) {
    if (!this.cronRepository || !this.jobRepository || !this.backupLock) {
      return;
    }

    this.cronRepository.update({
      name: 'backupDatabase',
      expression: backup.database.cronExpression,
      start: backup.database.enabled,
    });
  }

  @OnJob({ name: JobName.DatabaseBackup, queue: QueueName.BackupDatabase })
  async handleBackupDatabase(): Promise<JobStatus> {
    try {
      await this.createSqliteDatabaseBackup();
    } catch (error) {
      this.logger.error(`Failed to run database backup: ${error}`);
      return JobStatus.Failed;
    }

    await this.cleanupDatabaseBackups();
    return JobStatus.Success;
  }

  // SQLite port: the pg_dump pipeline is gone; VACUUM INTO writes a standalone
  // consistent snapshot (WAL folded in) without blocking readers. The snapshot
  // lands as <name>.sqlite.tmp, is gzipped to <name>.sqlite.gz, and the tmp is
  // removed. An interrupted run leaves a .tmp which the retention pass reaps
  // via isFailedDatabaseBackupName.
  private async createSqliteDatabaseBackup(): Promise<string> {
    this.logger.debug('Database Backup Started');

    const databaseVersion = await this.databaseRepository.getSqliteVersion();
    this.logger.log(`Database Backup Starting. Database Version: sqlite${databaseVersion}`);

    const filename = `immich-db-backup-${DateTime.now().toFormat("yyyyLLdd'T'HHmmss")}-v${serverVersion.toString()}-sqlite${databaseVersion}.sqlite`;
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const snapshotPath = path.join(backupsFolder, `${filename}.tmp`);
    const filePath = path.join(backupsFolder, `${filename}.gz`);

    try {
      await this.databaseRepository.backupDatabase(snapshotPath);
      await pipeline(
        this.storageRepository.createPlainReadStream(snapshotPath),
        this.storageRepository.createGzip(),
        this.storageRepository.createWriteStream(filePath),
      );
    } finally {
      await this.storageRepository.unlink(snapshotPath).catch(() => void 0);
    }

    const { size } = await this.storageRepository.stat(filePath);
    this.logger.log(`Database Backup Finished. File: ${filename}.gz Size: ${size}`);
    return filename;
  }

  async uploadBackup(file: Express.Multer.File): Promise<void> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const fn = basename(file.originalname);
    if (!isValidDatabaseBackupName(fn)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const filePath = path.join(backupsFolder, `uploaded-${fn}`);
    await this.storageRepository.createOrOverwriteFile(filePath, file.buffer);
  }

  downloadBackup(fileName: string): ImmichFileResponse {
    if (!isValidDatabaseBackupName(fileName)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const filePath = path.join(StorageCore.getBaseFolder(StorageFolder.Backups), fileName);

    return {
      path: filePath,
      fileName,
      cacheControl: CacheControl.PrivateWithoutCache,
      contentType: fileName.endsWith('.gz') ? 'application/gzip' : 'application/sql',
    };
  }

  async listBackups(): Promise<DatabaseBackupListResponseDto> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const files = await this.storageRepository.readdir(backupsFolder);
    const timezone = DateTime.local().zoneName;

    const validFiles = files
      .filter((fn) => isValidDatabaseBackupName(fn))
      .toSorted((a, b) => (a.startsWith('uploaded-') === b.startsWith('uploaded-') ? a.localeCompare(b) : 1))
      .toReversed();

    const backups = await Promise.all(
      validFiles.map(async (filename) => {
        const stats = await this.storageRepository.stat(path.join(backupsFolder, filename));
        return { filename, filesize: stats.size, timezone };
      }),
    );

    return {
      backups,
    };
  }

  async deleteBackup(files: string[]): Promise<void> {
    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);

    if (files.some((filename) => !isValidDatabaseBackupName(filename))) {
      throw new BadRequestException('Invalid backup name!');
    }

    await Promise.all(files.map((filename) => this.storageRepository.unlink(path.join(backupsFolder, filename))));
  }

  async cleanupDatabaseBackups() {
    this.logger.debug(`Database Backup Cleanup Started`);
    const {
      backup: { database: config },
    } = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      {
        withCache: false,
      },
    );

    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const files = await this.storageRepository.readdir(backupsFolder);
    const backups = files
      .filter((filename) => isValidDatabaseRoutineBackupName(filename))
      .toSorted()
      .toReversed();
    const failedBackups = files.filter((filename) => isFailedDatabaseBackupName(filename));

    const toDelete = backups.slice(config.keepLastAmount);
    toDelete.push(...failedBackups);

    for (const file of toDelete) {
      await this.storageRepository.unlink(path.join(backupsFolder, file));
    }

    this.logger.debug(`Database Backup Cleanup Finished, deleted ${toDelete.length} backups`);
  }

  restoreDatabaseBackup(
    _filename: string,
    _progressCb?: (action: 'backup' | 'restore' | 'migrations' | 'rollback', progress: number) => void,
  ): Promise<void> {
    // Fork (phase4): restore drives psql against Postgres. No Postgres here.
    return Promise.reject(new Error('Database restore is not supported on the SQLite engine'));
  }
}
