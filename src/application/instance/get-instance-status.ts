import type { InstanceLease } from '../../ports/instance-lease';

export interface InstanceStatus {
  readonly instanceId: string;
  /** `leader` runs the background work; `standby` serves HTTP only (D47). */
  readonly role: 'leader' | 'standby';
  /** Who holds the lease now and until when (by the database clock), if anyone. */
  readonly leaseHolder?: string;
  readonly leaseExpiresAt?: Date;
}

/** D47: which instance answered and whether it runs the background work, as the lease in the database says. */
export class GetInstanceStatus {
  constructor(private readonly deps: { readonly instanceLease: InstanceLease; readonly instanceId: string }) {}

  async execute(): Promise<InstanceStatus> {
    const lease = await this.deps.instanceLease.current();
    const leader = lease?.live === true && lease.holder === this.deps.instanceId;
    return {
      instanceId: this.deps.instanceId,
      role: leader ? 'leader' : 'standby',
      ...(lease?.live ? { leaseHolder: lease.holder, leaseExpiresAt: lease.expiresAt } : {}),
    };
  }
}
