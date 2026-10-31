import { describe, expect, it, vi } from 'vitest';

import { OCT_2026 } from '../support/builders';
import { deliveryFixture } from '../support/delivery-fixtures';
import { executionFixture } from '../support/execution-fixtures';

const HOUR = 3_600_000;

describe('D40: StartExecution queues its job in the same transaction', () => {
  it('the job exists once the execution is registered', async () => {
    const fx = executionFixture();
    const version = await fx.uploadValid(1);
    const started = await fx.start.execute('operador', OCT_2026, 'CASH', version);
    expect(await fx.jobs.claimNext(fx.clock.now(), ['EXECUTE_BATCH'])).toMatchObject({ payload: { executionId: started.ok ? started.value.executionId : '' } });
  });

  it('if queueing fails nothing is registered: no RUNNING execution, no RUNNING batch, no audit, no event', async () => {
    const fx = executionFixture();
    const version = await fx.uploadValid(1);
    const auditBefore = (await fx.repository.audit.list()).length;
    vi.spyOn(fx.repository.jobs, 'enqueue').mockRejectedValueOnce(new Error('connection lost'));
    await expect(fx.start.execute('operador', OCT_2026, 'CASH', version)).rejects.toThrow('connection lost');

    expect(await fx.repository.executions.running()).toBeUndefined();
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('OPEN');
    expect(await fx.repository.audit.list()).toHaveLength(auditBefore);
    expect((await fx.repository.outbox.lockPending(100)).map((p) => p.event.type)).not.toContain('EXECUTION_STARTED');
    expect(await fx.jobs.hasPending('EXECUTE_BATCH')).toBe(false);

    // Nothing is left behind: the operator just sends again.
    await fx.startAndRun();
    expect((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => r.state)).toEqual(['SENT']);
  });
});

describe('D40: follow-ups queue through the relay, at least once', () => {
  it('RECEIPT_UNCERTAIN and WEBHOOK_RECEIVED queue their jobs when the relay delivers them', async () => {
    const fx = deliveryFixture();
    fx.bus.subscribe('RECEIPT_UNCERTAIN', (e) => fx.followUps.onReceiptUncertain(e));
    fx.bus.subscribe('WEBHOOK_RECEIVED', (e) => fx.followUps.onWebhookReceived(e));
    fx.email.respondWith({ kind: 'UNCERTAIN', detail: 'timeout' });
    const { attempt } = await fx.sendOne();
    await fx.recordWebhook.execute({ webhookRequestId: 'w-1', provider: 'ZEPTOMAIL', receivedAt: fx.clock.now(), body: '{}', events: [] });
    await fx.relay.drain();
    fx.clock.advance(2 * HOUR);
    const jobs = [];
    for (let job = await fx.jobs.claimNext(fx.clock.now()); job; job = await fx.jobs.claimNext(fx.clock.now())) jobs.push([job.type, job.payload]);
    expect(jobs).toEqual([
      ['PROCESS_DELIVERY_EVENT', { webhookRequestId: 'w-1' }],
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: false }],
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: false }],
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: true }],
    ]);
  });

  it('a failure halfway is retried by the relay; the job queued twice changes nothing more', async () => {
    const fx = deliveryFixture();
    fx.bus.subscribe('RECEIPT_UNCERTAIN', (e) => fx.followUps.onReceiptUncertain(e));
    fx.email.respondWith({ kind: 'UNCERTAIN', detail: 'timeout' });
    const { receipt, attempt } = await fx.sendOne();
    const enqueue = fx.jobs.enqueue.bind(fx.jobs);
    let calls = 0;
    vi.spyOn(fx.jobs, 'enqueue').mockImplementation(async (job) => {
      calls += 1;
      if (calls === 2) throw new Error('queue down');
      return enqueue(job);
    });
    await fx.relay.drain();
    expect((await fx.repository.outbox.lockPending(100)).find((p) => p.event.type === 'RECEIPT_UNCERTAIN')?.attempts).toBe(1);
    await fx.relay.drain();
    expect((await fx.repository.outbox.lockPending(100)).find((p) => p.event.type === 'RECEIPT_UNCERTAIN')).toBeUndefined();

    // Every lookup is scheduled (the 5-minute one twice); running them all fails the receipt once.
    fx.clock.advance(2 * HOUR);
    const scheduled: Array<{ attemptId: string; final: boolean }> = [];
    for (let job = await fx.jobs.claimNext(fx.clock.now()); job; job = await fx.jobs.claimNext(fx.clock.now())) scheduled.push(job.payload as never);
    expect(scheduled.map((p) => p.final)).toEqual([false, false, false, true]);
    for (const p of scheduled) await fx.reconcile.execute(p.attemptId, p.final);
    expect(scheduled.every((p) => p.attemptId === attempt.attemptId)).toBe(true);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
    expect((await fx.repository.receipts.history(receipt.sha256)).filter((h) => h.event === 'FAILED')).toHaveLength(1);
  });
});
