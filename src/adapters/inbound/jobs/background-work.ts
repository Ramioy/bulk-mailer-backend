import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import type { Adapters } from '../../../composition/adapters';
import type { ExecutionUseCases } from '../../../composition/execution-use-cases';
import { ADAPTERS, EXECUTION_USE_CASES, JOB_RUNNER } from '../../../composition/tokens';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config';
import type { JobRunner } from './job-runner';

/** At startup: crash recovery first, then release abandoned jobs, then start taking jobs. */
@Injectable()
export class BackgroundWork implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BackgroundWork');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(EXECUTION_USE_CASES) private readonly executions: ExecutionUseCases,
    @Inject(JOB_RUNNER) private readonly runner: JobRunner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobRunnerEnabled) return;
    const recovered = await this.executions.recover.execute();
    if (recovered.uncertain > 0 || recovered.interrupted) {
      this.logger.warn(`Recovered after restart: ${recovered.uncertain} receipt(s) UNCERTAIN, interrupted execution ${recovered.interrupted ?? '-'}`);
    }
    await this.adapters.jobQueue.releaseAbandoned();
    this.runner.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner.stop();
  }
}
