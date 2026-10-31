import { describe, expect, it, vi } from 'vitest';

import { JobLanes, JobRunner } from '../../src/adapters/inbound/jobs/job-runner';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryJobQueue } from '../../src/adapters/outbound/in-memory/in-memory-job-queue';
import { SystemClock } from '../../src/adapters/outbound/system/system-clock';
import { startTestApp } from '../support/test-app';

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

describe('cooperative shutdown (D33)', () => {
  it('stop() signals the job in progress, waits for it and claims nothing else', async () => {
    const clock = new FixedClock();
    const queue = new InMemoryJobQueue(() => clock.now());
    const seen: string[] = [];
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runner = new JobRunner(
      queue,
      {
        // Like a batch execution: works until it is told to stop, then records its last step.
        EXECUTE_BATCH: (_job, signal) =>
          new Promise<void>((resolve) => {
            started();
            signal.addEventListener('abort', () => {
              seen.push('stopped cleanly');
              resolve();
            });
          }),
      },
      clock,
      1,
      silent,
    );
    await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {} });
    await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {} });
    runner.start();
    await running;

    expect(await runner.stop()).toBe(true);
    expect(seen).toEqual(['stopped cleanly']);
    // The second job stays queued for the next start.
    expect(await queue.claimNext(clock.now())).toMatchObject({ type: 'EXECUTE_BATCH' });
  });

  it('stop() waits at most the configured time for a job that does not stop, and says so', async () => {
    const clock = new FixedClock();
    const queue = new InMemoryJobQueue(() => clock.now());
    const logger = { error: vi.fn<(message: string) => void>() };
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runner = new JobRunner(
      queue,
      {
        PROCESS_DELIVERY_EVENT: () => {
          started();
          return new Promise<void>(() => undefined);
        },
      },
      clock,
      1,
      logger,
      { stopTimeoutMs: 50 },
    );
    await queue.enqueue({ type: 'PROCESS_DELIVERY_EVENT', payload: {} });
    runner.start();
    await running;

    const before = Date.now();
    expect(await new JobLanes([runner]).stop()).toBe(false);
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('did not finish within 50 ms'));
  });

  it('the system clock ends a wait early, without error, when its signal is aborted', async () => {
    const clock = new SystemClock();
    const shutdown = new AbortController();
    const before = Date.now();
    setTimeout(() => shutdown.abort(), 20);
    await clock.sleep(60_000, shutdown.signal);
    expect(Date.now() - before).toBeLessThan(5_000);
    await clock.sleep(60_000, shutdown.signal);
  });

  it('the job lanes stop before the HTTP server and the database close, then the loops', async () => {
    const order: string[] = [];
    const ctx = await startTestApp({ JOB_RUNNER_ENABLED: 'true' }, { adapters: { close: async () => void order.push('database closed') } });
    const stop = ctx.runner.stop.bind(ctx.runner);
    vi.spyOn(ctx.runner, 'stop').mockImplementation(async () => {
      order.push('lanes stopping');
      const finished = await stop();
      order.push('lanes stopped');
      return finished;
    });
    await ctx.app.close();
    expect(order).toEqual(['lanes stopping', 'lanes stopped', 'database closed']);
  });
});
