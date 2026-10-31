import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import type { Adapters } from '../../../composition/adapters';
import type { DeliveryUseCases } from '../../../composition/delivery-use-cases';
import type { ExecutionUseCases } from '../../../composition/execution-use-cases';
import { ADAPTERS, DELIVERY_USE_CASES, EXECUTION_USE_CASES, JOB_RUNNER, OUTBOX_RELAY } from '../../../composition/tokens';
import type { OutboxRelay } from '../../../application/events/outbox-relay';
import { PollingLoop } from './polling-loop';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config';
import type { JobLanes } from './job-runner';

/**
 * At startup: crash recovery first, then release abandoned jobs, then start taking jobs. The outbox relay and the
 * periodic sweep of unconfirmed sends (queued as a job, so it runs between other jobs) run in their own loops.
 */
@Injectable()
export class BackgroundWork implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BackgroundWork');
  private outboxLoop: PollingLoop | undefined;
  private sweepLoop: PollingLoop | undefined;
  private recentLoop: PollingLoop | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(EXECUTION_USE_CASES) private readonly executions: ExecutionUseCases,
    @Inject(JOB_RUNNER) private readonly runner: JobLanes,
    @Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay,
    @Inject(DELIVERY_USE_CASES) private readonly delivery: DeliveryUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobRunnerEnabled) return;
    const recovered = await this.executions.recover.execute();
    if (recovered.uncertain > 0 || recovered.interrupted) {
      this.logger.warn(`Recovered after restart: ${recovered.uncertain} receipt(s) UNCERTAIN, interrupted execution ${recovered.interrupted ?? '-'}`);
    }
    await this.adapters.jobQueue.releaseAbandoned();
    this.runner.start();
    this.outboxLoop = new PollingLoop('Outbox relay', () => this.relay.drain(), this.config.jobRunnerPollMs, this.logger);
    this.outboxLoop.start();
    this.sweepLoop = new PollingLoop('Sweep of unconfirmed sends', () => this.delivery.followUps.requestSweep(), this.config.reconcileSweepIntervalMinutes * 60_000, this.logger);
    this.sweepLoop.start();
    // Every minute while a batch runs and shortly after (D21); idle otherwise.
    this.recentLoop = new PollingLoop(
      'Recent sends check',
      () => this.delivery.followUps.requestRecentCheck(() => this.delivery.recentSends.active()),
      this.config.deliveryCheckIntervalSeconds * 1000,
      this.logger,
    );
    this.recentLoop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner.stop();
    await this.outboxLoop?.stop();
    await this.sweepLoop?.stop();
    await this.recentLoop?.stop();
  }
}
