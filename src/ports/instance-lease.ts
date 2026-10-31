/** Who holds the lease and until when, by the store's clock (D47). */
export interface LeaseState {
  readonly holder: string;
  readonly expiresAt: Date;
  /** Not expired yet. */
  readonly live: boolean;
}

/**
 * D47: at most one instance runs the background work (C5). The lease lives in the shared store, so two processes see
 * the same holder; expiry is judged by the store's clock, never by each instance's.
 */
export interface InstanceLease {
  /** Takes the lease if it is free, expired or already ours; true when this instance holds it now. */
  acquire(instanceId: string, ttlSeconds: number): Promise<boolean>;
  /** Extends it only if this instance holds it and it has not expired; false otherwise. */
  renew(instanceId: string, ttlSeconds: number): Promise<boolean>;
  /** Gives it up at once (shutdown), if this instance holds it. */
  release(instanceId: string): Promise<void>;
  current(): Promise<LeaseState | undefined>;
}
