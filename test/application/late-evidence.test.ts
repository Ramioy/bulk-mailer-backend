import { describe, expect, it } from 'vitest';

import { RunExecution } from '../../src/application/sending/run-execution';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import type { EmailProvider } from '../../src/ports/email-provider';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const HOUR = 3_600_000;
const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout after 30000 ms' };

const alerts = async (fx: DeliveryFixture) => fx.repository.alerts.list();
const alertTypes = async (fx: DeliveryFixture) => (await alerts(fx)).map((a) => a.type);
const pendingEvents = async (fx: DeliveryFixture) => (await fx.repository.outbox.lockPending(1000)).map((p) => p.event);
const reupload = (fx: DeliveryFixture) =>
  fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);

/** One send left UNCERTAIN and then failed by the last reconciliation, as in the audit's scenario H1. */
async function failedNotFound(fx: DeliveryFixture) {
  fx.email.respondWith(UNCERTAIN);
  const { receipt, attempt } = await fx.sendOne();
  // Sent at 15:00 (then the 30 s wait after the uncertain response); the last lookup 60 min later.
  fx.clock.advance(HOUR);
  expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('FAILED');
  expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
  fx.clock.advance(HOUR);
  return { receipt, attempt };
}

describe('D34: late evidence that a send failed as not found did go out', () => {
  it('H1 (audit): a late webhook turns FAILED / NOT_FOUND_AT_PROVIDER into SENT, with an alert; it is not sent again', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await failedNotFound(fx);

    expect(await fx.deliver('w-late', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' })).toEqual(['APPLIED']);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'ACCEPTED', errorType: undefined, errorDetail: undefined });
    expect((await fx.repository.receipts.history(receipt.sha256)).slice(-2)).toMatchObject([
      { event: 'SENT', detail: `SENT confirmed late by delivery webhook (attempt ${attempt.attemptId})` },
      { event: 'DELIVERY_ACCEPTED' },
    ]);
    const [late] = await alerts(fx);
    expect(late).toMatchObject({ type: 'LATE_SEND_EVIDENCE', subject: receipt.sha256 });
    expect(late?.detail).toContain(receipt.fileName);
    expect(late?.detail).toContain(attempt.attemptId);
    expect(late?.detail).toContain('marked FAILED / NOT_FOUND_AT_PROVIDER at 2026-10-15T16:00:30.000Z');
    expect(late?.detail).toContain('ACCEPTED from the delivery webhook');
    expect((await pendingEvents(fx)).find((e) => e.type === 'RECEIPT_RESOLVED' && e.payload.late === true)?.payload).toEqual({
      sha256: receipt.sha256,
      attemptId: attempt.attemptId,
      state: 'SENT',
      by: 'delivery webhook',
      late: true,
    });

    // The same evidence again, now from the logs: the receipt is SENT already, so no second alert.
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED' });
    expect(await fx.verify.receipt('operador', receipt.sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_VERIFIABLE' });
    expect(await fx.deliver('w-late-again', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' })).toEqual(['RECORDED']);
    expect(await alertTypes(fx)).toEqual(['LATE_SEND_EVIDENCE']);

    // Before D34 it stayed FAILED and the next execution sent it again (after re-uploading the purged file).
    // Now the same content is a duplicate of a SENT receipt and there is nothing to send.
    expect(await reupload(fx)).toMatchObject({ ok: true, value: { results: [{ outcome: 'DUPLICATE' }] } });
    const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
    expect(await fx.start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0)).toMatchObject({ ok: false });
    expect(fx.email.calls).toHaveLength(1);
  });

  it('the operator’s "not sent" is corrected the same way, here by a manual verification of the logs', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith(UNCERTAIN);
    const { receipt, attempt } = await fx.sendOne();
    await fx.resolve.execute('operador', receipt.sha256, 'NOT_SENT', 'not in Processed Emails');
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });

    // Not in the logs yet: verifiable, and nothing changes.
    expect(await fx.verify.receipt('operador', receipt.sha256)).toMatchObject({ ok: true, value: { result: 'NOT_FOUND', state: 'FAILED' } });
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESSED', emailReference: 'ref-1' });
    expect(await fx.verify.receipt('operador', receipt.sha256)).toEqual({
      ok: true,
      value: { sha256: receipt.sha256, fileName: receipt.fileName, result: 'UPDATED', providerStatus: 'PROCESSED', state: 'SENT', deliveryState: 'UNCONFIRMED' },
    });
    expect((await fx.repository.receipts.history(receipt.sha256)).at(-1)?.detail).toBe(`SENT confirmed late by provider logs (attempt ${attempt.attemptId})`);
    expect((await alerts(fx)).map((a) => [a.type, a.detail.includes('PROCESSED from the provider logs')])).toEqual([['LATE_SEND_EVIDENCE', true]]);
  });

  it('the batch verification includes FAILED / NOT_FOUND_AT_PROVIDER receipts and nothing else that failed', async () => {
    const fx = deliveryFixture();
    const { attempt } = await failedNotFound(fx);
    const other = await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Anexo', 'MULTA', '104522'), content: pdfBytes('anexo') }]);
    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113' });
    await fx.start.execute('operador', OCT_2026, 'CASH', other.ok ? other.value.manifestVersion : 0);
    const job = await fx.jobs.claimNext(fx.clock.now(), ['EXECUTE_BATCH']);
    await fx.run.execute(String(job?.payload.executionId));
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED' });

    const result = await fx.verify.batch('operador', OCT_2026, 'CASH');
    expect(result.ok && result.value.receipts.map((r) => [r.fileName, r.result, r.state, r.deliveryState])).toEqual([
      [fileName('Edificio Altos 00', 'MULTA', '104522'), 'UPDATED', 'SENT', 'ACCEPTED'],
    ]);
  });

  it('a late hard bounce: SENT + HARD_BOUNCE, the address is suppressed, both alerts', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await failedNotFound(fx);
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE', reason: '550 5.1.1 User unknown' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toMatchObject({ reason: 'HARD_BOUNCE', attemptId: attempt.attemptId });
    expect(await alertTypes(fx)).toEqual(['LATE_SEND_EVIDENCE', 'HARD_BOUNCE']);
    expect((await pendingEvents(fx)).map((e) => e.type)).toEqual(expect.arrayContaining(['RECEIPT_RESOLVED', 'DELIVERY_UPDATED', 'ADDRESS_SUPPRESSED']));
  });

  it('a receipt FAILED for any other reason is not changed by delivery evidence', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(2);
    // First: rejected by the provider (D28). Second: the email changed since review.
    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113' }, (email) => {
      fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
      return { kind: 'ACCEPTED', providerRequestId: email.attemptId };
    });
    await fx.startAndRun();
    const receipts = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(receipts.map((r) => [r.state, r.errorType])).toEqual([
      ['FAILED', 'PROVIDER_REJECTED'],
      ['SENT', undefined],
    ]);
    const [rejected] = receipts;
    const [attempt] = await fx.repository.attempts.listByReceipt(rejected?.sha256 as never);
    expect(await fx.deliver('w-x', { attemptId: attempt?.attemptId as string, recipient: 'admin@altos.com', state: 'ACCEPTED' })).toEqual(['RECORDED']);
    expect(await fx.receipt(rejected?.sha256 as string)).toMatchObject({ state: 'FAILED', errorType: 'PROVIDER_REJECTED' });
    expect((await fx.repository.receipts.history(rejected?.sha256 as never)).at(-1)).toMatchObject({ event: 'DELIVERY_EVENT_IGNORED', detail: 'ACCEPTED while FAILED' });
    expect(await fx.verify.receipt('operador', rejected?.sha256 as never)).toEqual({ ok: false, error: 'RECEIPT_NOT_VERIFIABLE' });
    expect(await alerts(fx)).toEqual([]);
  });

  it('a process failure in the logs is no proof that it went out: still FAILED, no alert', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await failedNotFound(fx);
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESS_FAILED' });
    expect(await fx.verify.receipt('operador', receipt.sha256)).toMatchObject({ ok: true, value: { result: 'NO_CHANGE', state: 'FAILED' } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
    expect(await alerts(fx)).toEqual([]);
  });

  it('an execution does not send a receipt that late evidence made SENT after it started', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await failedNotFound(fx);
    await reupload(fx);
    // "Anexo" goes first in the manifest; while it is being sent, the webhook of the old attempt arrives.
    const upload = await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Anexo', 'MULTA', '104522'), content: pdfBytes('anexo') }]);
    const sent: string[] = [];
    const provider: EmailProvider = {
      send: async (email) => {
        sent.push(email.attachment.name);
        if (sent.length === 1) await fx.deliver('w-during', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
        return { kind: 'ACCEPTED', providerRequestId: email.attemptId };
      },
    };
    const started = await fx.start.execute('operador', OCT_2026, 'CASH', upload.ok ? upload.value.manifestVersion : 0);
    if (!started.ok) throw new Error(started.error.code);
    await new RunExecution({ ...fx.execDeps, emailProvider: provider }).execute(started.value.executionId);

    expect(sent).toEqual([fileName('Anexo', 'MULTA', '104522')]);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', attempts: 1 });
    expect((await fx.repository.receipts.history(receipt.sha256)).at(-1)).toMatchObject({ event: 'SKIPPED', detail: `SENT when its turn came in execution ${started.value.executionId}` });
    expect(await fx.repository.executions.get(started.value.executionId)).toMatchObject({ result: 'COMPLETED' });
    expect(fx.progress.events.at(-1)?.event).toMatchObject({ type: 'FINISHED', counters: { total: 2, processed: 2, byState: { SENT: 2 } } });
  });
});

describe('D34: evidence for an older attempt while a later one holds the receipt', () => {
  it('an older send believed not sent did go out while a later one was sent too: DUPLICATE_SEND_DETECTED, once; state kept', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt: older } = await failedNotFound(fx);
    await reupload(fx);
    await fx.startAndRun();
    const newer = (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1);
    expect(newer).toMatchObject({ kind: 'BATCH', outcome: 'ACCEPTED' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED', attempts: 2 });

    expect(await fx.deliver('w-old', { attemptId: older.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' })).toEqual(['RECORDED']);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED' });
    const [duplicate] = await alerts(fx);
    expect(duplicate).toMatchObject({ type: 'DUPLICATE_SEND_DETECTED', subject: receipt.sha256 });
    expect(duplicate?.detail).toContain(`attempt ${older.attemptId} to admin@altos.com`);
    expect(duplicate?.detail).toContain(`attempt ${newer?.attemptId} to admin@altos.com is SENT`);

    // More evidence of the same older attempt (another webhook, the logs) does not repeat it.
    await fx.deliver('w-old-2', { attemptId: older.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    expect(await alertTypes(fx)).toEqual(['DUPLICATE_SEND_DETECTED']);
    expect(await fx.repository.suppressions.list()).toEqual([]);
  });

  it('no alert for an older attempt that had gone out (Resend after a hard bounce)', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'SENT' } });

    expect(await fx.deliver('w-late', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'COMPLAINT' })).toEqual(['RECORDED']);
    expect(await alertTypes(fx)).toEqual(['HARD_BOUNCE']);
  });

  it('no alert for an UNCERTAIN send that was confirmed and later resent after a bounce', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith(UNCERTAIN);
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    await fx.resend.execute('operador', receipt.sha256);

    await fx.deliver('w-late', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect(await alertTypes(fx)).toEqual(['HARD_BOUNCE']);
  });
});
