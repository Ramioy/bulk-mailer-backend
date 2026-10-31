import { describe, expect, it } from 'vitest';

import { SweepUnconfirmed } from '../../src/application/delivery/reconciliation';
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

describe('D44: the sweep covers SOFT_BOUNCE, has a budget, and alerts only for sends that expect a webhook', () => {
  it('H8 (audit): a SOFT_BOUNCE 10 h old that the logs show as a hard bounce → HARD_BOUNCE, suppression, alert', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-sb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'SOFT_BOUNCE' });
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'HARD_BOUNCE', detail: 'hard bounce' });
    fx.clock.advance(10 * HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 1, updated: 1 });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toMatchObject({ reason: 'HARD_BOUNCE' });
    expect(await alertTypes(fx)).toContain('HARD_BOUNCE');
  });

  it('H9 (audit): an uncertain send proven not to exist expects no webhook: no WEBHOOKS_NOT_RECEIVED', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    fx.clock.advance(HOUR);
    await fx.reconcile.execute(attempt.attemptId, true);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
    fx.clock.advance(10 * HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ alerts: 0 });
    expect(await alertTypes(fx)).toEqual([]);
  });

  it('a send confirmed late from the logs is still a proven webhook loss, and the alert says so', async () => {
    const fx = deliveryFixture();
    const { attempt } = await uncertainOne(fx);
    fx.clock.advance(HOUR);
    await fx.reconcile.execute(attempt.attemptId, true);
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED' });
    const { receipt } = { receipt: (await fx.repository.receipts.listByState('FAILED'))[0] };
    expect(await fx.verify.receipt('operador', receipt?.sha256 as never)).toMatchObject({ ok: true, value: { state: 'SENT' } });
    fx.clock.advance(10 * HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ alerts: 1 });
    const [alert] = await fx.repository.alerts.list({ type: 'WEBHOOKS_NOT_RECEIVED' });
    expect(alert?.detail).toContain('1 of them first marked not sent and confirmed late, D34');
  });

  it('looks up at most the batch size per run; the next run starts with the sends left out', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(12);
    await fx.startAndRun();
    const sent = fx.email.calls.map((c) => c.attemptId as string);
    fx.clock.advance(7 * HOUR);
    const sweep = new SweepUnconfirmed({ ...fx.deliveryDeps, reconciliation: { ...fx.deliveryDeps.reconciliation, sweepBatchSize: 8 } });
    expect(await sweep.execute()).toMatchObject({ lookedUp: 8 });
    expect(fx.lookup.calls.map((c) => c.attemptId)).toEqual(sent.slice(0, 8));
    fx.lookup.calls.length = 0;
    expect(await sweep.execute()).toMatchObject({ lookedUp: 8 });
    expect(fx.lookup.calls.map((c) => c.attemptId)).toEqual([...sent.slice(8), ...sent.slice(0, 4)]);
  });
});
