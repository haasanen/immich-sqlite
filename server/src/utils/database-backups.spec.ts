import {
  findDatabaseBackupVersion,
  isFailedDatabaseBackupName,
  isValidDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
} from 'src/utils/database-backups.js';

describe('database backup name validation', () => {
  const sqliteBackup = 'immich-db-backup-20261028T114018-v3.3.5-sqlite3.53.2.sqlite.gz';

  it('accepts sqlite snapshots as valid backup names', () => {
    expect(isValidDatabaseBackupName(sqliteBackup)).toBeTruthy();
    expect(isValidDatabaseBackupName('uploaded-immich.sqlite.gz')).toBeTruthy();
    // upstream pg names keep working
    expect(isValidDatabaseBackupName('immich-db-backup-20250729T114018-v1.136.0-pg14.17.sql.gz')).toBeTruthy();
  });

  it('recognizes sqlite snapshots as routine backups for retention', () => {
    expect(isValidDatabaseRoutineBackupName(sqliteBackup)).toBeTruthy();
    expect(isValidDatabaseBackupName('manual-snapshot.sqlite.gz')).toBeTruthy();
    expect(isValidDatabaseRoutineBackupName('manual-snapshot.sqlite.gz')).toBeFalsy();
  });

  it('treats interrupted sqlite snapshots as failed backups', () => {
    expect(isFailedDatabaseBackupName(`${sqliteBackup.slice(0, -3)}.tmp`)).toBeTruthy();
    expect(isFailedDatabaseBackupName('immich-db-backup-x.sql.gz.tmp')).toBeTruthy();
    expect(isFailedDatabaseBackupName(sqliteBackup)).toBeFalsy();
  });

  it('extracts the immich version from sqlite backup names', () => {
    expect(findDatabaseBackupVersion(sqliteBackup)).toBe('3.3.5');
  });
});
