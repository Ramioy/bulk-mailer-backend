import type { InstanceLease } from '../../../ports/instance-lease';

export type InstanceRole = 'leader' | 'standby';

export interface CoordinatorLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LeaderWork {
  /** Crash recovery and release of abandoned jobs: once per leadership, before anything else. */
  recover(): Promise<void>;
  /** Starts the job lanes and the periodic loops. */
  start(): void;
  /** Stops them cooperatively (D33): the lanes stop claiming at once, the job in progress ends cleanly. */
  stop(): Promise<void>;
}

/**
 * D47: only the instance holding the lease runs the background work; any other one serves HTTP only, standing by.
 *
 *   standby --acquire--> leader (recovery, then lanes and loops)
 *   leader --renew fails or throws--> standby (lanes stopped, claiming stops at once)
 *   leader --shutdown--> lanes stopped, then the lease released
 *
 * The lease is renewed every third of its TTL, so a leader that cannot renew stops claiming at least two thirds of a
 * TTL before another instance can take over. Nest-free, so it can be tested with two instances and a fixed clock.
 */
export class InstanceCoordinator {
  private current: InstanceRole = 'standby';

  constructor(
    private readonly lease: InstanceLease,
    readonly instanceId: string,
    private readonly ttlSeconds: number,
    private readonly work: LeaderWork,
    private readonly logger: CoordinatorLogger,
  ) {}

  get role(): InstanceRole {
    return this.current;
  }

  /** Called at startup and then on every renewal tick. */
  async tick(): Promise<InstanceRole> {
    if (this.current === 'leader') {
      let renewed = false;
      try {
        renewed = await this.lease.renew(this.instanceId, this.ttlSeconds);
      } catch (error) {
        this.logger.error(`Instance lease: renewal failed (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!renewed) await this.stepDown();
      return this.current;
    }
    let acquired = false;
    try {
      acquired = await this.lease.acquire(this.instanceId, this.ttlSeconds);
    } catch (error) {
      this.logger.error(`Instance lease: could not ask for it (${error instanceof Error ? error.message : String(error)})`);
    }
    if (acquired) await this.lead();
    return this.current;
  }

  /** Shutdown: the work stops first, then the lease is given up so a new instance can take over at once. */
  async end(): Promise<void> {
    if (this.current !== 'leader') return;
    this.current = 'standby';
    await this.work.stop();
    await this.lease.release(this.instanceId).catch((error: unknown) => this.logger.error(`Instance lease: release failed (${String(error)})`));
  }

  private async lead(): Promise<void> {
    this.logger.log(`Instance ${this.instanceId} holds the lease: running recovery and the background work`);
    try {
      await this.work.recover();
    } catch (error) {
      // Without recovery the lanes must not start; the lease is given up so this or another instance retries.
      this.logger.error(`Recovery failed; giving the lease up (${error instanceof Error ? error.message : String(error)})`);
      await this.lease.release(this.instanceId).catch(() => undefined);
      return;
    }
    this.current = 'leader';
    this.work.start();
  }

  private async stepDown(): Promise<void> {
    this.current = 'standby';
    this.logger.warn(`Instance ${this.instanceId} lost the lease: stopping the background work, standing by`);
    await this.work.stop();
  }
}
