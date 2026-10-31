import { describe, expect, it } from 'vitest';

import { JobLanes, JobRunner } from '../../src/adapters/inbound/jobs/job-runner';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';

const silent = { error: () => undefined };

describe('job lanes (D21)', () => {
  it('processes delivery work while a batch execution is still running', async () => {
    const clock = new FixedClock();
    const queue = new InMemoryJobQueue(() => clock.now());
    const done: string[] = [];
    let finishBatch: () => void = () => undefined;
    const batch = new Promise<void>((resolve) => {
      finishBatch = resolve;
    });
    const execution = new JobRunner(queue, { EXECUTE_BATCH: () => batch.then(() => void done.push('batch')) }, clock, 10, silent);
    const delivery = new JobRunner(queue, { PROCESS_DELIVERY_EVENT: async () => void done.push('webhook') }, clock, 10, silent);
    await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {} });
    await queue.enqueue({ type: 'PROCESS_DELIVERY_EVENT', payload: {} });

    const running = execution.tick();
    expect(await delivery.tick()).toBe(true);
    expect(done).toEqual(['webhook']);
    finishBatch();
    await running;
    expect(done).toEqual(['webhook', 'batch']);
  });

  it('each lane takes only its own job types; drain runs every lane until idle', async () => {
    const clock = new FixedClock();
    const queue = new InMemoryJobQueue(() => clock.now());
    const done: string[] = [];
    const lanes = new JobLanes([
      new JobRunner(queue, { EXECUTE_BATCH: async () => void done.push('batch') }, clock, 10, silent),
      new JobRunner(queue, { SWEEP_UNCONFIRMED: async () => void done.push('sweep') }, clock, 10, silent),
    ]);
    await queue.enqueue({ type: 'SWEEP_UNCONFIRMED', payload: {} });
    await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {} });
    expect(await lanes.lanes[1]?.tick()).toBe(true);
    expect(await lanes.lanes[1]?.tick()).toBe(false);
    expect(await lanes.drain()).toBe(1);
    expect(done).toEqual(['sweep', 'batch']);
  });
});
