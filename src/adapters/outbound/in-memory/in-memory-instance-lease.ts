import type { InstanceLease, LeaseState } from '../../../ports/instance-lease';

/** One lease shared by the instances of a test, judged by the given clock. */
export class InMemoryInstanceLease implements InstanceLease {
  private holder: string | undefined;
  private expiresAt = new Date(0);

  constructor(private readonly now: () => Date = () => new Date()) {}

  async acquire(instanceId: string, ttlSeconds: number): Promise<boolean> {
    if (this.holder !== undefined && this.holder !== instanceId && this.expiresAt > this.now()) return false;
    this.holder = instanceId;
    this.expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    return true;
  }

  async renew(instanceId: string, ttlSeconds: number): Promise<boolean> {
    if (this.holder !== instanceId || this.expiresAt <= this.now()) return false;
    this.expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    return true;
  }

  async release(instanceId: string): Promise<void> {
    if (this.holder === instanceId) this.expiresAt = new Date(this.now().getTime() - 1000);
  }

  async current(): Promise<LeaseState | undefined> {
    if (this.holder === undefined) return undefined;
    return { holder: this.holder, expiresAt: this.expiresAt, live: this.expiresAt > this.now() };
  }

  /** Tests: the lease expires now, as if its holder had stopped renewing long ago. */
  expire(): void {
    this.expiresAt = new Date(this.now().getTime() - 1000);
  }
}
