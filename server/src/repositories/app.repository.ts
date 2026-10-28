import { Injectable } from '@nestjs/common';
import { ExitCode } from 'src/enum.js';
import { AppRestartEvent } from 'src/repositories/event.repository.js';

@Injectable()
export class AppRepository {
  private closeFn?: () => Promise<void>;

  exitApp() {
    /* eslint-disable unicorn/no-process-exit */
    void this.closeFn?.().finally(() => process.exit(ExitCode.AppRestart));

    // in exceptional circumstance, the application may hang
    setTimeout(() => process.exit(ExitCode.AppRestart), 2000);
    /* eslint-enable unicorn/no-process-exit */
  }

  setCloseFn(fn: () => Promise<void>) {
    this.closeFn = fn;
  }

  sendOneShotAppRestart(_state: AppRestartEvent): void {
    // Redisless by design: no cross-socket fan-out. The supervisor in main.ts
    // owns worker lifecycle, so a plain exit is sufficient.
    this.exitApp();
  }
}
