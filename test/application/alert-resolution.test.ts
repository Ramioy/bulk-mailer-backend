import { describe, expect, it, vi } from 'vitest';

import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { RetryDeadEvent } from '../../src/application/events/dead-events';
import { MAX_DELIVERY_ATTEMPTS, OutboxRelay } from '../../src/application/events/outbox-relay';
import { RemoveReceipt } from '../../src/application/receipts/remove-receipt';
import { ResolveDuplicateConflict } from '../../src/application/receipts/resolve-duplicate-conflict';
import type { Alert, AlertType } from '../../src/domain/alert/alert';
import type { Receipt } from '../../src/domain/receipt/receipt';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const HOUR = 3_600_000;
const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout after 30000 ms' };

const alertsOf = async (fx: Pick<DeliveryFixture, 'repository'>, type: AlertType) => fx.repository.alerts.list({ type });
const reupload = (fx: DeliveryFixture) =>
  fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);

/** Resolved by the system, still waiting for the operator's acknowledgement. */
function expectResolvedNotAcknowledged(alert: Alert | undefined, resolution: unknown = expect.any(String)) {
  expect(alert).toMatchObject({ resolvedAt: expect.any(Date), resolution });
  expect(alert?.acknowledgedAt).toBeUndefined();
}

describe('D52: the system resolves an alert when its cause is resolved; acknowledging it stays the operator\'s', () => {
  it('UNCERTAIN_UNRESOLVED: when the operator resolves the receipt', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith(UNCERTAIN);
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setUnavailable(true);
    fx.clock.advance(HOUR);
    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('STILL_UNCERTAIN');
    const [raised] = await alertsOf(fx, 'UNCERTAIN_UNRESOLVED');
    expect(raised?.resolvedAt).toBeUndefined();

    expect(await fx.resolve.execute('operador', receipt.sha256, 'NOT_SENT', 'not in Processed Emails')).toMatchObject({ ok: true });
    expectResolvedNotAcknowledged((await alertsOf(fx, 'UNCERTAIN_UNRESOLVED'))[0], 'receipt FAILED');
    expect(await fx.repository.alerts.list({ pending: true, resolved: true })).toHaveLength(1);
    expect(await fx.repository.alerts.list({ pending: true, resolved: false, type: 'UNCERTAIN_UNRESOLVED' })).toEqual([]);
  });

  it('UNCERTAIN_UNRESOLVED: when a later delivery event proves the send', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith(UNCERTAIN);
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setUnavailable(true);
    fx.clock.advance(HOUR);
    await fx.reconcile.execute(attempt.attemptId, true);
    await fx.deliver('wr-late', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT' });
    expectResolvedNotAcknowledged((await alertsOf(fx, 'UNCERTAIN_UNRESOLVED'))[0], 'receipt SENT');
  });

  it('BATCH_STOPPED: carries its batch as reference and is resolved when a later execution of the batch completes', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await fx.uploadValid(2);
    const stopped = await fx.startAndRun();
    const [alert] = await alertsOf(fx, 'BATCH_STOPPED');
    expect(alert).toMatchObject({ subject: stopped, reference: '2026-10/CASH' });
    expect(alert?.resolvedAt).toBeUndefined();

    fx.clock.advance(HOUR);
    const completed = await fx.startAndRun();
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'COMPLETED' });
    expectResolvedNotAcknowledged((await alertsOf(fx, 'BATCH_STOPPED'))[0], `execution ${completed} completed`);
  });

  it('BATCH_STOPPED: is resolved when the stopped batch settles (D41)', async () => {
    const fx = deliveryFixture();
    // The send times out, then the provider account fails: the batch stops with one UNCERTAIN receipt.
    fx.email.respondWith(UNCERTAIN, { kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await fx.uploadValid(2);
    await fx.startAndRun();
    const pending = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).find((r) => r.state === 'PENDING') as Receipt;
    await new RemoveReceipt(fx.deps).execute('operador', pending.sha256);
    const uncertain = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).find((r) => r.state === 'UNCERTAIN') as Receipt;
    expect((await alertsOf(fx, 'BATCH_STOPPED'))[0]?.resolvedAt).toBeUndefined();

    // Removing reopened the batch (OPEN): only a STOPPED batch settles, so stop it again by hand to model D41.
    const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
    await fx.repository.batches.save({ ...(batch as NonNullable<typeof batch>), state: 'STOPPED' });
    await fx.resolve.execute('operador', uncertain.sha256, 'SENT', 'found in Processed Emails');
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'COMPLETED' });
    expectResolvedNotAcknowledged((await alertsOf(fx, 'BATCH_STOPPED'))[0], 'batch settled: nothing left to send or to resolve');
  });

  it.each(['HARD_BOUNCE', 'COMPLAINT'] as const)('%s: resolved when a resend of the receipt goes out, not when it fails', async (state) => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-bad', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state });
    expect((await alertsOf(fx, state))[0]).toMatchObject({ subject: receipt.sha256, reference: attempt.attemptId });
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });

    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113(to)' });
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'FAILED' } });
    expect((await alertsOf(fx, state))[0]?.resolvedAt).toBeUndefined();

    fx.clock.advance(HOUR);
    const sent = await fx.startAndRun();
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT' });
    const last = (await fx.repository.attempts.listByExecution(sent)).at(-1);
    expectResolvedNotAcknowledged((await alertsOf(fx, state))[0], `sent again (attempt ${last?.attemptId})`);
  });

  it('PROCESS_FAILED: resolved when the resend goes out', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESS_FAILED', detail: 'Process failed' });
    fx.clock.advance(7 * HOUR);
    await fx.sweep.execute();
    expect((await alertsOf(fx, 'PROCESS_FAILED'))[0]?.resolvedAt).toBeUndefined();
    await reupload(fx);
    const resent = await fx.resend.execute('operador', receipt.sha256);
    expect(resent).toMatchObject({ ok: true, value: { state: 'SENT' } });
    expectResolvedNotAcknowledged((await alertsOf(fx, 'PROCESS_FAILED'))[0], `sent again (attempt ${resent.ok ? resent.value.attemptId : ''})`);
  });

  it('a bounce of the resend itself, raised after it started, is not resolved by it', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    fx.clock.advance(HOUR);
    const resent = await fx.resend.execute('operador', receipt.sha256);
    fx.clock.advance(HOUR);
    await fx.deliver('w-2', { attemptId: resent.ok ? resent.value.attemptId : '', recipient: 'nuevo@altos.com', state: 'HARD_BOUNCE' });
    const [first, second] = await alertsOf(fx, 'HARD_BOUNCE');
    expect(first?.resolvedAt).toBeDefined();
    expect(second?.resolvedAt).toBeUndefined();
  });

  describe('DUPLICATE_CONFLICT', () => {
    it('resolved when the receipt is removed', async () => {
      const fx = deliveryFixture();
      await fx.uploadValid(1);
      const receipt = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0] as Receipt;
      // Content already being sent: the conflict cannot hold it back, so it is only warned (D31, point a).
      await fx.repository.receipts.save({ ...receipt, state: 'SENDING' });
      await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Otro Nombre', 'MULTA', '98765'), content: pdfBytes('receipt-0') }]);
      expect((await alertsOf(fx, 'DUPLICATE_CONFLICT'))[0]).toMatchObject({ subject: receipt.sha256 });
      // The send failed after all: the operator removes it.
      await fx.repository.receipts.save({ ...((await fx.receipt(receipt.sha256)) as Receipt), state: 'FAILED' });
      expect(await new RemoveReceipt(fx.deps).execute('operador', receipt.sha256)).toMatchObject({ ok: true });
      expectResolvedNotAcknowledged((await alertsOf(fx, 'DUPLICATE_CONFLICT'))[0], 'receipt removed by operador');
    });

    it('resolved when the operator resolves the conflict', async () => {
      const fx = deliveryFixture();
      const a = fileName('Conflicto A', 'MULTA', '104522');
      await fx.upload.execute('operador', OCT_2026, 'CASH', [
        { name: a, content: pdfBytes('conflict') },
        { name: fileName('Conflicto B', 'MULTA', '98765'), content: pdfBytes('conflict') },
      ]);
      const receipt = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0] as Receipt;
      await fx.repository.alerts.insert({ alertId: 'dc-1', type: 'DUPLICATE_CONFLICT', subject: receipt.sha256, detail: 'x', raisedAt: fx.clock.now() });
      expect(await new ResolveDuplicateConflict(fx.deps).execute('operador', receipt.sha256, a, 'the client confirmed')).toMatchObject({ ok: true });
      expectResolvedNotAcknowledged(await fx.repository.alerts.get('dc-1'), `conflict resolved by operador: ${a}`);
    });
  });

  it('OUTBOX_EVENT_DEAD: resolved when the revived event is delivered', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const bus = new InProcessEventBus();
    let down = true;
    bus.subscribe('RECEIPT_SENT', async () => {
      if (down) throw new Error('consumer down');
    });
    let n = 0;
    const relay = new OutboxRelay(repo, bus, new FixedClock(), { newId: () => `id-${(n += 1)}` });
    await repo.outbox.add({ eventId: 'ev-1', type: 'RECEIPT_SENT', occurredAt: new Date(), payload: {} });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) await relay.drain();
    expect((await alertsOf({ repository: repo }, 'OUTBOX_EVENT_DEAD'))[0]).toMatchObject({ subject: 'ev-1' });
    expect((await alertsOf({ repository: repo }, 'OUTBOX_EVENT_DEAD'))[0]?.resolvedAt).toBeUndefined();

    down = false;
    await new RetryDeadEvent({ repository: repo, clock: new FixedClock(), newId: () => 'au-1' }).execute('operador', 'ev-1');
    await relay.drain();
    expectResolvedNotAcknowledged((await alertsOf({ repository: repo }, 'OUTBOX_EVENT_DEAD'))[0], 'event delivered after being retried');
  });

  it('FILE_PURGE_FAILED: resolved when a later sweep deletes every file left', async () => {
    const fx = deliveryFixture();
    await fx.files.save({ period: OCT_2026, block: 'CASH', sha256: 'e'.repeat(64) as never }, pdfBytes('stray'));
    fx.clock.advance(2 * HOUR);
    const failing = vi.spyOn(fx.files, 'delete').mockRejectedValue(new Error('EROFS'));
    expect(await fx.fileJobs.purgeOrphans.execute()).toMatchObject({ failed: 1 });
    expect((await alertsOf(fx, 'FILE_PURGE_FAILED'))[0]?.resolvedAt).toBeUndefined();
    // Still failing: still unresolved.
    expect(await fx.fileJobs.purgeOrphans.execute()).toMatchObject({ failed: 1 });
    expect((await alertsOf(fx, 'FILE_PURGE_FAILED')).every((a) => a.resolvedAt === undefined)).toBe(true);

    failing.mockRestore();
    expect(await fx.fileJobs.purgeOrphans.execute()).toMatchObject({ deleted: 1, failed: 0 });
    for (const alert of await alertsOf(fx, 'FILE_PURGE_FAILED')) expectResolvedNotAcknowledged(alert, 'a later sweep deleted every file left');
  });

  it('never resolves the alerts that need a human, whatever happens to their subject afterwards', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-bad', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    const humanOnly: AlertType[] = [
      'COPY_BOUNCED',
      'WEBHOOKS_NOT_RECEIVED',
      'WEBHOOK_UNPARSED',
      'LATE_SEND_EVIDENCE',
      'DUPLICATE_SEND_DETECTED',
      'PROVIDER_UNKNOWN_ERROR',
      'MALICIOUS_FILE',
    ];
    for (const type of humanOnly) {
      await fx.repository.alerts.insert({ alertId: `h-${type}`, type, subject: receipt.sha256, reference: attempt.attemptId, detail: 'x', raisedAt: fx.clock.now() });
    }
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    fx.clock.advance(HOUR);
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'SENT' } });
    await fx.deliver('w-ok', { attemptId: (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1)?.attemptId as string, recipient: 'nuevo@altos.com', state: 'ACCEPTED' });
    await fx.uploadValid(2);
    await fx.startAndRun();
    await fx.fileJobs.purgeOrphans.execute();

    expect((await alertsOf(fx, 'HARD_BOUNCE'))[0]?.resolvedAt).toBeDefined();
    const stillOpen = await fx.repository.alerts.list({ resolved: false });
    expect(stillOpen.map((a) => a.type).sort()).toEqual([...humanOnly].sort());
  });
});
