export function isValidDatabaseBackupName(filename: string) {
  return filename.match(/^[\d\w-.]+\.(?:sql|sqlite)(?:\.gz)?$/);
}

export function isValidDatabaseRoutineBackupName(filename: string) {
  const oldBackupStyle = filename.match(/^immich-db-backup-\d+\.sql\.gz$/);
  //immich-db-backup-20250729T114018-v1.136.0-pg14.17.sql.gz
  const newBackupStyle = filename.match(/^immich-db-backup-\d{8}T\d{6}-v.*-pg.*\.sql\.gz$/);
  // SQLite port: immich-db-backup-20261028T114018-v3.3.5-sqlite3.53.2.sqlite.gz
  const sqliteBackupStyle = filename.match(/^immich-db-backup-\d{8}T\d{6}-v.*-sqlite.*\.sqlite\.gz$/);
  return oldBackupStyle || newBackupStyle || sqliteBackupStyle;
}

export function isFailedDatabaseBackupName(filename: string) {
  // partial pg dumps (.sql.gz.tmp) and partial sqlite snapshots (.sqlite.tmp)
  // are both reaped by the retention job.
  return filename.match(/^immich-db-backup-.*\.tmp$/);
}

export function findDatabaseBackupVersion(filename: string) {
  return /-v(.*)-/.exec(filename)?.[1];
}

export class UnsupportedPostgresError extends Error {
  constructor(databaseVersion: string) {
    super(`Unsupported PostgreSQL version: ${databaseVersion}`);
  }
}
