import { describe, expect, it } from 'vitest';

import { ProviderIncidentTracker, SourceIncidentTracker } from './incident-policy';
import type { SendOutcome } from './send-outcome';

const uncertain = (retryAfterSeconds?: number): SendOutcome => ({ kind: 'UNCERTAIN', detail: '503', retryAfterSeconds });
const connection: SendOutcome = { kind: 'CONNECTION_FAILED', detail: 'ECONNREFUSED' };
const accepted: SendOutcome = { kind: 'ACCEPTED', providerRequestId: 'r' };

describe('ProviderIncidentTracker (§9.2.1)', () => {
  it('waits base, then base × 2, and stops at the third consecutive incident', () => {
    const tracker = new ProviderIncidentTracker();
    expect(tracker.register(uncertain())).toEqual({ action: 'WAIT', seconds: 30, consecutiveIncidents: 1 });
    expect(tracker.register(uncertain())).toEqual({ action: 'WAIT', seconds: 60, consecutiveIncidents: 2 });
    expect(tracker.register(uncertain())).toEqual({ action: 'STOP', reason: 'PROVIDER_UNAVAILABLE', consecutiveIncidents: 3 });
  });

  it('honours a longer Retry-After', () => {
    expect(new ProviderIncidentTracker().register(uncertain(120))).toMatchObject({ action: 'WAIT', seconds: 120 });
  });

  it('stops immediately when Retry-After exceeds the ceiling', () => {
    expect(new ProviderIncidentTracker().register(uncertain(601))).toMatchObject({ action: 'STOP', reason: 'PROVIDER_UNAVAILABLE' });
  });

  it('accepts a Retry-After equal to the ceiling', () => {
    expect(new ProviderIncidentTracker().register(uncertain(600))).toMatchObject({ action: 'WAIT', seconds: 600 });
  });

  it('a definitive response resets the count', () => {
    const tracker = new ProviderIncidentTracker();
    tracker.register(uncertain());
    tracker.register(uncertain());
    expect(tracker.register(accepted)).toEqual({ action: 'CONTINUE' });
    expect(tracker.register(uncertain())).toMatchObject({ action: 'WAIT', seconds: 30, consecutiveIncidents: 1 });
  });

  it('connection failures count without waiting and share the count with uncertain responses', () => {
    const tracker = new ProviderIncidentTracker();
    expect(tracker.register(connection)).toEqual({ action: 'CONTINUE' });
    expect(tracker.register(uncertain())).toMatchObject({ action: 'WAIT', seconds: 60, consecutiveIncidents: 2 });
    expect(tracker.register(connection)).toMatchObject({ action: 'STOP', consecutiveIncidents: 3 });
  });

  it('uses a configured policy', () => {
    const tracker = new ProviderIncidentTracker({ baseWaitSeconds: 5, maxWaitSeconds: 60, stopAfter: 2 });
    expect(tracker.register(uncertain())).toMatchObject({ action: 'WAIT', seconds: 5 });
    expect(tracker.register(uncertain())).toMatchObject({ action: 'STOP' });
  });
});

describe('SourceIncidentTracker', () => {
  it('stops after three consecutive source failures; a success resets', () => {
    const tracker = new SourceIncidentTracker();
    tracker.register(false);
    tracker.register(false);
    tracker.register(true);
    tracker.register(false);
    tracker.register(false);
    expect(tracker.register(false)).toEqual({ action: 'STOP', reason: 'SOURCE_UNAVAILABLE', consecutiveIncidents: 3 });
  });
});
