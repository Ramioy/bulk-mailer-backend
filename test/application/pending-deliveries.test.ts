import { describe, expect, it } from 'vitest';

import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';

const HOUR = 3_600_000;
const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout' };
const alertTypes = async (fx: DeliveryFixture) => (await fx.repository.alerts.list()).map((a) => a.type);

async function uncertainOne(fx: DeliveryFixture) {
  fx.email.respondWith(UNCERTAIN);
  return fx.sendOne();
}

describe('D43: an UNCERTAIN the last scheduled lookup could not resolve does not vanish', () => {
  it('H11 (audit): final lookup with the logs unavailable → alert once; the hourly sweep keeps looking and confirms it later', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    fx.lookup.setUnavailable(true);
    fx.clock.advance(HOUR);
    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('STILL_UNCERTAIN');
    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('STILL_UNCERTAIN');
    const alerts = await fx.repository.alerts.list({ type: 'UNCERTAIN_UNRESOLVED' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ subject: receipt.sha256 });
    expect(alerts[0]?.detail).toContain(attempt.attemptId);
    expect(alerts[0]?.detail).toContain('logs API was unavailable (simulated outage)');
    expect(alerts[0]?.detail).toContain(`/receipts/${receipt.sha256}/verify-delivery`);

    // Next hour: still unavailable, looked up, not failed.
    fx.clock.advance(HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 1, updated: 0 });
    // Logs recovered but it is not there yet: still never failed by the sweep.
    fx.lookup.setUnavailable(false);
    fx.clock.advance(HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 1, updated: 0 });
    expect((await fx.receipt(receipt.sha256)).state).toBe('UNCERTAIN');
    // It shows up in the logs: SENT.
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED' });
    fx.clock.advance(HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 1, updated: 1 });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'ACCEPTED' });
    // Beyond 72 h it is no longer swept.
    const other = deliveryFixture();
    await uncertainOne(other);
    other.lookup.setUnavailable(true);
    other.clock.advance(73 * HOUR);
    expect(await other.sweep.execute()).toMatchObject({ lookedUp: 0 });
  });

  it('no alert when the last scheduled lookup resolves it, either way', async () => {
    const found = deliveryFixture();
    const sent = await uncertainOne(found);
    found.lookup.setResult(sent.attempt.attemptId, { kind: 'FOUND', status: 'PROCESSED' });
    expect(await found.reconcile.execute(sent.attempt.attemptId, true)).toBe('SENT');
    const notFound = deliveryFixture();
    const lost = await uncertainOne(notFound);
    expect(await notFound.reconcile.execute(lost.attempt.attemptId, true)).toBe('FAILED');
    expect([...(await alertTypes(found)), ...(await alertTypes(notFound))]).not.toContain('UNCERTAIN_UNRESOLVED');
  });

  it('the sweep does not look up an UNCERTAIN before its last scheduled lookup', async () => {
    const fx = deliveryFixture();
    await uncertainOne(fx);
    fx.clock.advance(30 * 60_000);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 0 });
  });
});
