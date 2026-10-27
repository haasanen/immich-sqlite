import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { BootstrapEventPriority, DatabaseLock } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class DatabaseService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.DatabaseService })
  async onBootstrap() {
    // Single-engine fork (phase4): the SQLite schema is created/migrated under
    // the migrations lock — identical to what the test harness runs. Upstream's
    // Postgres version gate, extension management (pgvector/vchord lifecycle),
    // vector reindex checks and pg_prewarm preparation are removed with the
    // Postgres engine itself.
    await this.databaseRepository.withLock(DatabaseLock.Migrations, async () => {
      const { database } = this.configRepository.getEnv();
      if (!database.skipMigrations) {
        await this.databaseRepository.runMigrations();
      }
    });
  }
}
