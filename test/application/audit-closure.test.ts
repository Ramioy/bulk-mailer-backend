import { describe, expect, it } from 'vitest';

import { FakeEmailProvider } from '../../src/adapters/outbound/fakes/fake-email-provider';
import { RedirectingEmailProvider } from '../../src/adapters/outbound/zeptomail/redirecting-email-provider';
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
