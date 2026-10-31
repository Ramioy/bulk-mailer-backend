import { BatchStopReason } from '../shared/error-types';
import type { SendOutcome } from './send-outcome';

export interface ProviderIncidentPolicy {
  /** Wait after the first uncertain response. Default 30 s. */
  readonly baseWaitSeconds: number;
  /** A `Retry-After` above this ceiling stops the batch instead of waiting. Default 10 min. */
  readonly maxWaitSeconds: number;
  /** Consecutive incidents that stop the batch. Default 3. */
  readonly stopAfter: number;
}

export const DEFAULT_PROVIDER_INCIDENT_POLICY: ProviderIncidentPolicy = {
  baseWaitSeconds: 30,
  maxWaitSeconds: 600,
  stopAfter: 3,
};

export type IncidentDecision =
  | { readonly action: 'CONTINUE' }
  /** Reported to the interface before the wait starts. */
  | { readonly action: 'WAIT'; readonly seconds: number; readonly consecutiveIncidents: number }
  | { readonly action: 'STOP'; readonly reason: BatchStopReason; readonly consecutiveIncidents: number };

/**
 * Growing wait (docs/context/09-idempotency-and-uncertain-sends.md §9.2.1).
 * Connection failures and uncertain responses share the consecutive-incident count;
 * only uncertain responses wait. A definitive provider response resets the count.
 */
export class ProviderIncidentTracker {
  private consecutive = 0;
  private unknownRejections = 0;

  constructor(private readonly policy: ProviderIncidentPolicy = DEFAULT_PROVIDER_INCIDENT_POLICY) {}

  get consecutiveIncidents(): number {
    return this.consecutive;
  }

  register(outcome: SendOutcome): IncidentDecision {
    // A rejection with an unknown code is a definitive answer (no wait), but three in a row stop the batch (M1).
    if (outcome.kind === 'UNKNOWN_REJECTION') {
      this.consecutive = 0;
      this.unknownRejections += 1;
      if (this.unknownRejections >= this.policy.stopAfter) {
        return { action: 'STOP', reason: BatchStopReason.PROVIDER_UNKNOWN_ERROR, consecutiveIncidents: this.unknownRejections };
      }
      return { action: 'CONTINUE' };
    }
    this.unknownRejections = 0;
    if (outcome.kind !== 'CONNECTION_FAILED' && outcome.kind !== 'UNCERTAIN') {
      this.consecutive = 0;
      return { action: 'CONTINUE' };
    }

    this.consecutive += 1;
    const stop = { action: 'STOP', reason: BatchStopReason.PROVIDER_UNAVAILABLE, consecutiveIncidents: this.consecutive } as const;
    if (this.consecutive >= this.policy.stopAfter) return stop;
    if (outcome.kind === 'CONNECTION_FAILED') return { action: 'CONTINUE' };

    const computed = this.policy.baseWaitSeconds * 2 ** (this.consecutive - 1);
    const seconds = Math.max(computed, outcome.retryAfterSeconds ?? 0);
    if (seconds > this.policy.maxWaitSeconds) return stop;
    return { action: 'WAIT', seconds, consecutiveIncidents: this.consecutive };
  }
}

/** Consecutive failures of the contract source during an execution. */
export class SourceIncidentTracker {
  private consecutive = 0;

  constructor(private readonly stopAfter: number = DEFAULT_PROVIDER_INCIDENT_POLICY.stopAfter) {}

  register(sourceAvailable: boolean): IncidentDecision {
    if (sourceAvailable) {
      this.consecutive = 0;
      return { action: 'CONTINUE' };
    }
    this.consecutive += 1;
    if (this.consecutive >= this.stopAfter) {
      return { action: 'STOP', reason: BatchStopReason.SOURCE_UNAVAILABLE, consecutiveIncidents: this.consecutive };
    }
    return { action: 'CONTINUE' };
  }
}
