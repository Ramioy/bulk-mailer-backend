import { beforeEach, describe, expect, it } from 'vitest';

import type { BulkMailerRepository } from '../../src/ports/bulk-mailer-repository';
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

    it('claims only the given types when asked (one lane per kind of work)', async () => {
      const batch = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: {}, runAt: T0 });
      const webhook = await queue.enqueue({ type: 'PROCESS_DELIVERY_EVENT', payload: {}, runAt: later(1) });
      expect((await queue.claimNext(later(5), ['PROCESS_DELIVERY_EVENT', 'RECONCILE_ATTEMPT']))?.jobId).toBe(webhook);
      expect(await queue.claimNext(later(5), ['RECONCILE_ATTEMPT'])).toBeUndefined();
      expect((await queue.claimNext(later(5), ['EXECUTE_BATCH']))?.jobId).toBe(batch);
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

    it('D38: says whether a job of a type is waiting or running, not once it is done or failed', async () => {
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(false);
      const a = await queue.enqueue({ type: 'CHECK_RECENT_SENDS', payload: {}, runAt: T0 });
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(true);
      expect(await queue.hasPending('SWEEP_UNCONFIRMED')).toBe(false);
      await queue.claimNext(T0);
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(true);
      await queue.complete(a);
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(false);
      const b = await queue.enqueue({ type: 'CHECK_RECENT_SENDS', payload: {}, runAt: T0 });
      await queue.claimNext(T0);
      await queue.fail(b, 'boom');
      expect(await queue.hasPending('CHECK_RECENT_SENDS')).toBe(false);
    });

    it('releases jobs claimed by a process that died', async () => {
      const id = await queue.enqueue({ type: 'EXECUTE_BATCH', payload: { batch: 'x' }, runAt: T0 });
      await queue.claimNext(T0);
      expect(await queue.releaseAbandoned()).toBe(1);
      expect(await queue.claimNext(T0)).toMatchObject({ jobId: id, payload: { batch: 'x' }, attempts: 2 });
    });
  });
}

/** D40: a job queued in a repository transaction lives in the queue's table: it exists if and only if it commits. */
export function transactionalJobsContract(name: string, create: () => Promise<{ repository: BulkMailerRepository; queue: JobQueue }>): void {
  describe(`Transactional jobs contract: ${name}`, () => {
    it('a job queued in a transaction that commits is claimed by the queue', async () => {
      const { repository, queue } = await create();
      const jobId = await repository.transaction((tx) => tx.jobs.enqueue({ type: 'EXECUTE_BATCH', payload: { executionId: 'e1' }, runAt: T0 }));
      expect(await queue.hasPending('EXECUTE_BATCH')).toBe(true);
      expect(await queue.claimNext(later(1))).toMatchObject({ jobId, type: 'EXECUTE_BATCH', payload: { executionId: 'e1' }, attempts: 1 });
    });

    it('a job queued in a transaction that fails does not exist', async () => {
      const { repository, queue } = await create();
      await expect(
        repository.transaction(async (tx) => {
          await tx.jobs.enqueue({ type: 'EXECUTE_BATCH', payload: {}, runAt: T0 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await queue.hasPending('EXECUTE_BATCH')).toBe(false);
      expect(await queue.claimNext(later(1))).toBeUndefined();
    });
  });
}
