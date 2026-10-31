import { describe, expect, it } from 'vitest';

import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { registerOperationLog } from '../../src/adapters/outbound/logging/operation-log';
import { RedirectingEmailProvider } from '../../src/adapters/outbound/zeptomail/redirecting-email-provider';
import { RemoveReceipt } from '../../src/application/receipts/remove-receipt';
import { ResolveDuplicateConflict } from '../../src/application/receipts/resolve-duplicate-conflict';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const HOUR = 3_600_000;
const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout' };
const reupload = (fx: DeliveryFixture) =>
  fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);

describe('D50: data consistency', () => {
  it('B1: after an account error the receipt is PENDING without a foreign error detail; the cause stays on the attempt and in history', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102 credits exhausted' });
    const { receipt, attempt } = await fx.sendOne();
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'PENDING', errorType: undefined, errorDetail: undefined });
    expect(await fx.repository.attempts.get(attempt.attemptId)).toMatchObject({ outcome: 'ACCOUNT_ERROR', detail: 'LE_102 credits exhausted' });
    expect((await fx.repository.receipts.history(receipt.sha256)).at(-1)).toMatchObject({ event: 'PENDING', detail: 'LE_102 credits exhausted' });
  });

  it('late evidence of an older send while the latest one was not found either: SENT, alert, not sent a third time', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith(UNCERTAIN);
    const { receipt, attempt: first } = await fx.sendOne();
    fx.clock.advance(HOUR);
    await fx.reconcile.execute(first.attemptId, true);
    await reupload(fx);
    fx.email.respondWith(UNCERTAIN);
    await fx.startAndRun();
    const second = (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1);
    fx.clock.advance(HOUR);
    await fx.reconcile.execute(second?.attemptId as string, true);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });

    // The first one did go out after all.
    await fx.deliver('w-1', { attemptId: first.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'ACCEPTED' });
    expect(await fx.repository.alerts.list({ type: 'LATE_SEND_EVIDENCE', reference: first.attemptId })).toHaveLength(1);
    // More events of the same attempt are no duplicate.
    await fx.deliver('w-2', { attemptId: first.attemptId, recipient: 'admin@altos.com', state: 'COMPLAINT' });
    expect(await fx.repository.alerts.list({ type: 'DUPLICATE_SEND_DETECTED' })).toEqual([]);
    // Not ready any more: no third send.
    await reupload(fx);
    const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
    expect((await fx.start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0)).ok).toBe(false);
    expect(fx.email.calls).toHaveLength(2);
  });

  it('B6: outside production a bounce of the test mailbox alerts but does not suppress the real address', async () => {
    const redirecting = new RedirectingEmailProvider(new FakeEmailProvider(), 'pruebas@anutibara.com');
    const fx = deliveryFixture({ execution: { emailProvider: redirecting } });
    const { attempt } = await fx.sendOne();
    expect(attempt).toMatchObject({ to: 'admin@altos.com', redirectedTo: 'pruebas@anutibara.com' });
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, state: 'HARD_BOUNCE', reason: 'mailbox full' });
    expect(await fx.repository.suppressions.list()).toEqual([]);
    const [alert] = await fx.repository.alerts.list({ type: 'HARD_BOUNCE' });
    expect(alert?.detail).toContain('test mailbox pruebas@anutibara.com, address not suppressed');
  });
});

describe('D50: operability', () => {
  it('B3: removing a receipt or resolving a conflict works in a period no longer operable; uploading there does not', async () => {
    const fx = deliveryFixture();
    await fx.upload.execute('operador', OCT_2026, 'CASH', [
      { name: fileName('Uno', 'MULTA', '104522'), content: pdfBytes('uno') },
      { name: fileName('Dos', 'MULTA', '104522'), content: pdfBytes('dos') },
      { name: fileName('Otro Nombre', 'MULTA', '104522'), content: pdfBytes('dos') },
    ]);
    // Three months later.
    fx.clock.set('2027-01-15T15:00:00Z');
    expect(await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Tres', 'MULTA', '104522'), content: pdfBytes('tres') }])).toEqual({
      ok: false,
      error: 'PERIOD_NOT_OPERABLE',
    });
    const [dos, uno] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(await new RemoveReceipt(fx.deps).execute('operador', uno?.sha256 as never)).toMatchObject({ ok: true });
    expect(await new ResolveDuplicateConflict(fx.deps).execute('operador', dos?.sha256 as never, fileName('Dos', 'MULTA', '104522'), 'the right one')).toMatchObject({
      ok: true,
      value: { state: 'PENDING' },
    });
  });

  it('B7: one structured line per operation, with identifiers and counts, never addresses or file names', async () => {
    const fx = deliveryFixture();
    const lines: string[] = [];
    registerOperationLog(fx.bus, { log: (line) => void lines.push(line) });
    fx.email.respondWith({ kind: 'ACCEPTED', providerRequestId: 'r' }, UNCERTAIN);
    await fx.uploadValid(2);
    await fx.startAndRun();
    await fx.relay.drain();
    const ops = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ops.map((o) => o.op)).toEqual(
      expect.arrayContaining(['RECEIPTS_UPLOADED', 'EXECUTION_STARTED', 'RECEIPT_SENT', 'RECEIPT_UNCERTAIN', 'EXECUTION_FINISHED']),
    );
    expect(ops.find((o) => o.op === 'RECEIPTS_UPLOADED')).toMatchObject({ period: '2026-10', block: 'CASH', registered: 2 });
    const sent = ops.find((o) => o.op === 'RECEIPT_SENT');
    expect(sent).toMatchObject({ outcome: 'ACCEPTED', state: 'SENT' });
    expect(typeof sent?.sha256).toBe('string');
    expect(typeof sent?.attemptId).toBe('string');
    expect(ops.find((o) => o.op === 'EXECUTION_FINISHED')).toMatchObject({ result: 'COMPLETED', processed: 2, total: 2 });
    expect(lines.some((l) => l.includes('@') || l.includes('.pdf'))).toBe(false);
  });
});
