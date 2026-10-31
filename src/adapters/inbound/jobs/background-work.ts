import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { Adapters } from '../../../composition/adapters';
import type { DeliveryUseCases } from '../../../composition/delivery-use-cases';
import type { ExecutionUseCases } from '../../../composition/execution-use-cases';
import type { FileUseCases } from '../../../composition/file-use-cases';
import { ADAPTERS, DELIVERY_USE_CASES, EXECUTION_USE_CASES, FILE_USE_CASES, INSTANCE_ID, JOB_RUNNER, OUTBOX_RELAY } from '../../../composition/tokens';
import type { OutboxRelay } from '../../../application/events/outbox-relay';
import { PollingLoop } from './polling-loop';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config';
import { InstanceCoordinator } from './instance-coordinator';
import type { JobLanes } from './job-runner';

/**
 * Nest adapter around the InstanceCoordinator (D47): only the instance holding the lease runs crash recovery, the
 * release of abandoned jobs, the job lanes and the periodic loops (outbox relay, sweeps, checks); any other one serves
 * HTTP only and keeps asking for the lease. On shutdown the lanes stop first (cooperatively, D33), then the loops,
 * then the lease is released.
 */
@Injectable()
export class BackgroundWork implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('BackgroundWork');
  private readonly loops: PollingLoop[];
  private readonly coordinator: InstanceCoordinator;
  private leaseLoop: PollingLoop | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(EXECUTION_USE_CASES) private readonly executions: ExecutionUseCases,
    @Inject(JOB_RUNNER) private readonly runner: JobLanes,
    @Inject(OUTBOX_RELAY) relay: OutboxRelay,
    @Inject(DELIVERY_USE_CASES) delivery: DeliveryUseCases,
    @Inject(FILE_USE_CASES) files: FileUseCases,
    @Inject(INSTANCE_ID) instanceId: string,
  ) {
    this.loops = [
      new PollingLoop('Outbox relay', () => relay.drain(), config.jobRunnerPollMs, this.logger),
      new PollingLoop('Sweep of unconfirmed sends', () => delivery.followUps.requestSweep(), config.reconcileSweepIntervalMinutes * 60_000, this.logger),
      // Every minute while a batch runs and shortly after (D21); idle otherwise.
      new PollingLoop('Recent sends check', () => delivery.followUps.requestRecentCheck(() => delivery.recentSends.active()), config.deliveryCheckIntervalSeconds * 1000, this.logger),
      // D41: files no receipt needs, left by a crash or a failed deletion.
      new PollingLoop('Orphan file sweep', () => files.purgeOrphans.request(), config.fileOrphanSweepIntervalMinutes * 60_000, this.logger),
      // D50: daily housekeeping of finished jobs and dispatched outbox events.
      new PollingLoop('Finished work purge', () => files.purgeFinishedWork.request(), 24 * 3_600_000, this.logger),
    ];
    this.coordinator = new InstanceCoordinator(
      adapters.instanceLease,
      instanceId,
      config.instanceLeaseTtlSeconds,
      {
        recover: () => this.recover(),
        start: () => {
          this.runner.start();
          for (const loop of this.loops) loop.start();
        },
        stop: async () => {
          await this.runner.stop();
          await Promise.all(this.loops.map((loop) => loop.stop()));
        },
      },
      this.logger,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobRunnerEnabled) return;
    if ((await this.coordinator.tick()) === 'standby') this.logger.warn('Another instance holds the lease; this one serves HTTP only (D47)');
    // Renewal for the leader, and a new attempt for a standby instance, every third of the TTL.
    this.leaseLoop = new PollingLoop('Instance lease', () => this.coordinator.tick(), (this.config.instanceLeaseTtlSeconds * 1000) / 3, this.logger);
    this.leaseLoop.start();
  }

  /**
   * Before, not on, application shutdown: Nest closes the HTTP server, and with it the database (the `onClose` hook of
   * `bootstrap.ts`), between the two hooks. The execution in progress needs the database to record its last receipt
   * and stop as INTERRUPTED (D33), and the lease is released in the database. The outbox loop keeps relaying while the
   * lanes stop.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.leaseLoop?.stop();
    await this.coordinator.end();
  }

  private async recover(): Promise<void> {
    const recovered = await this.executions.recover.execute();
    if (recovered.uncertain > 0 || recovered.interrupted) {
      this.logger.warn(`Recovered: ${recovered.uncertain} receipt(s) UNCERTAIN, interrupted execution ${recovered.interrupted ?? '-'}`);
    }
    await this.adapters.jobQueue.releaseAbandoned();
  }
}
