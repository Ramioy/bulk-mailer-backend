import { describe, expect, it } from 'vitest';

import { CheckRecentSends } from '../../src/application/delivery/reconciliation';
import { deliveryFixture } from '../support/delivery-fixtures';
import { startTestApp } from '../support/test-app';

describe('D38: periodic delivery work is not queued twice', () => {
  it('the per-minute check is queued once while one is waiting or running; again once it is done', async () => {
    const fx = deliveryFixture();
    await fx.sendOne();
    const tick = () => fx.followUps.requestRecentCheck(() => fx.recentSends.active());
    expect(await tick()).toBe(true);
    expect(await tick()).toBe(false);
    const job = await fx.jobs.claimNext(fx.clock.now(), ['CHECK_RECENT_SENDS']);
    expect(await tick()).toBe(false);
    expect(await fx.jobs.claimNext(fx.clock.now(), ['CHECK_RECENT_SENDS'])).toBeUndefined();
    await fx.jobs.complete(job?.jobId as string);
    expect(await tick()).toBe(true);
  });

  it('the hourly sweep too', async () => {
    const fx = deliveryFixture();
    expect(await fx.followUps.requestSweep()).toBe(true);
    expect(await fx.followUps.requestSweep()).toBe(false);
    const job = await fx.jobs.claimNext(fx.clock.now(), ['SWEEP_UNCONFIRMED']);
    await fx.jobs.fail(job?.jobId as string, 'boom');
    expect(await fx.followUps.requestSweep()).toBe(true);
  });
});

describe('D38: webhooks never wait behind lookups', () => {
  it('a webhook queued after 50 checks is processed by its own lane first', async () => {
    const ctx = await startTestApp();
    try {
      const queue = ctx.adapters.jobQueue;
      for (let i = 0; i < 50; i += 1) await queue.enqueue({ type: 'CHECK_RECENT_SENDS', payload: {} });
      await queue.enqueue({ type: 'PROCESS_DELIVERY_EVENT', payload: { webhookRequestId: 'w-1' } });
      const [execution, webhooks, lookups] = ctx.runner.lanes;
      expect(await execution?.tick()).toBe(false);
      expect(await webhooks?.tick()).toBe(true);
      expect(await queue.hasPending('PROCESS_DELIVERY_EVENT')).toBe(false);
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(true);
      expect(await webhooks?.tick()).toBe(false);
      expect(await lookups?.drain()).toBe(50);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('D38: budget and rotation of the per-minute check', () => {
  it('looks up at most the batch size per check; the next check starts with the sends left out', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(30);
    await fx.startAndRun();
    const sent = fx.email.calls.map((c) => c.attemptId as string);
    expect(sent).toHaveLength(30);

    expect(await fx.recentSends.execute()).toEqual({ checked: 20, updated: 0 });
    expect(fx.lookup.calls.map((c) => c.attemptId)).toEqual(sent.slice(0, 20));
    fx.lookup.calls.length = 0;
    expect(await fx.recentSends.execute()).toEqual({ checked: 20, updated: 0 });
    expect(fx.lookup.calls.map((c) => c.attemptId)).toEqual([...sent.slice(20), ...sent.slice(0, 10)]);
  });

  it('a send whose lookup found the logs API unavailable is skipped for the backoff cycles', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(2);
    await fx.startAndRun();
    const check = new CheckRecentSends({ ...fx.deliveryDeps, reconciliation: { ...fx.deliveryDeps.reconciliation, recentCheckBackoffCycles: 2 } });
    fx.lookup.setUnavailable(true);
    expect(await check.execute()).toEqual({ checked: 2, updated: 0 });
    fx.lookup.setUnavailable(false);
    fx.lookup.calls.length = 0;
    expect(await check.execute()).toEqual({ checked: 0, updated: 0 });
    expect(await check.execute()).toEqual({ checked: 0, updated: 0 });
    expect(fx.lookup.calls).toEqual([]);
    expect(await check.execute()).toEqual({ checked: 2, updated: 0 });
  });
});
