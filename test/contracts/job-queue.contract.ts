import { beforeEach, describe, expect, it } from 'vitest';

import type { JobQueue } from '../../src/ports/job-queue';
import { T0 } from '../support/builders';

const later = (ms: number) => new Date(T0.getTime() + ms);

export function jobQueueContract(name: string, create: () => Promise<JobQueue>): void {
  describe(`JobQueue contract: ${name}`, () => {
    let queue: JobQueue;

    beforeEach(async () => {
      queue = await create();
    });

    it('claims due jobs oldest first, each only once', async () => {
      const second = await queue.enqueue({ type: 'RECONCILE_ATTEMPT', payload: { n: 2 }, runAt: later(10) });
      const first = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: { n: 1 }, runAt: T0 });
      expect((await queue.claimNext(later(20)))?.jobId).toBe(first);
      expect((await queue.claimNext(later(20)))?.jobId).toBe(second);
      expect(await queue.claimNext(later(20))).toBeUndefined();
    });

    it('does not claim a job before its runAt', async () => {
      await queue.enqueue({ type: 'RECONCILE_ATTEMPT', payload: {}, runAt: later(5 * 60_000) });
      expect(await queue.claimNext(T0)).toBeUndefined();
      expect(await queue.claimNext(later(5 * 60_000))).toMatchObject({ type: 'RECONCILE_ATTEMPT', attempts: 1 });
    });

    it('never hands out completed or failed jobs again', async () => {
      const a = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {}, runAt: T0 });
      const b = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {}, runAt: T0 });
      await queue.claimNext(T0);
      await queue.claimNext(T0);
      await queue.complete(a);
      await queue.fail(b, 'boom');
      expect(await queue.releaseAbandoned()).toBe(0);
      expect(await queue.claimNext(later(1))).toBeUndefined();
    });

    it('releases jobs claimed by a process that died', async () => {
      const id = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: { batch: 'x' }, runAt: T0 });
      await queue.claimNext(T0);
      expect(await queue.releaseAbandoned()).toBe(1);
      expect(await queue.claimNext(T0)).toMatchObject({ jobId: id, payload: { batch: 'x' }, attempts: 2 });
    });
  });
}
