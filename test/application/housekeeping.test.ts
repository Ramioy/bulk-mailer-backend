import { describe, expect, it } from 'vitest';

import { deliveryFixture } from '../support/delivery-fixtures';

const DAY = 86_400_000;

describe('D50: finished work is purged after the retention, business records stay', () => {
  it('deletes finished jobs and dispatched events older than 30 days, is queued once, and keeps the rest', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(1);
    await fx.startAndRun();
    await fx.relay.drain();
    const purge = fx.fileJobs.purgeFinishedWork;
    expect(await purge.request()).toBe(true);
    expect(await purge.request()).toBe(false);

    expect(await purge.execute()).toEqual({ jobs: 0, events: 0 });
    fx.clock.advance(31 * DAY);
    const result = await purge.execute();
    expect(result.jobs).toBeGreaterThan(0);
    expect(result.events).toBeGreaterThan(0);
    // The pending purge job itself and every business record are kept.
    expect(await fx.jobs.hasPending('PURGE_FINISHED_WORK')).toBe(true);
    expect(await fx.repository.receipts.listByState('SENT')).toHaveLength(1);
    expect((await fx.repository.audit.list()).length).toBeGreaterThan(0);
  });
});
