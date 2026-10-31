import { describe, expect, it, vi } from 'vitest';

import { RefreshRecipients } from '../../src/application/receipts/refresh-recipients';
import { RemoveReceipt } from '../../src/application/receipts/remove-receipt';
import { ResolveDuplicateConflict } from '../../src/application/receipts/resolve-duplicate-conflict';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';
import { gate, guardExternalCalls } from '../support/serial-guard';

const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout after 30000 ms' };
const states = async (fx: DeliveryFixture) => (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => r.state);
const reupload = (fx: DeliveryFixture) =>
  fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);

/** Every external port fake of the fixture, observed while the serial executor is busy. */
function guarded(fx: DeliveryFixture): string[] {
  return guardExternalCalls(fx.deps.serial, [
    ['Tayrona', fx.tayrona, ['get']],
    ['SAP', fx.sap, ['get']],
    ['EmailProvider', fx.email, ['send']],
    ['SendLookup', fx.lookup, ['findByAttempt']],
    ['FileInspector', fx.deps.inspector, ['inspect']],
  ]);
}

/** A sent receipt that hard-bounced, with its file uploaded again for Resend. */
async function bounced(fx: DeliveryFixture) {
  const { receipt, attempt } = await fx.sendOne();
  await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
  await reupload(fx);
  return { receipt, attempt };
}

/** Holds the next lookup of the contract source until `open()`; `reached` resolves when it is in flight. */
function holdNextLookup(fx: DeliveryFixture, during?: () => Promise<void>) {
  const held = gate();
  const reached = gate();
  const original = fx.tayrona.get.bind(fx.tayrona);
  vi.spyOn(fx.tayrona, 'get').mockImplementationOnce(async (contract) => {
    reached.open();
    await held.wait;
    await during?.();
    return original(contract);
  });
  return { reached: reached.wait, open: held.open };
}

describe('D36: no external call while the serial executor is taken', () => {
  it('the guard notices a call made inside the executor', async () => {
    const fx = deliveryFixture();
    const violations = guarded(fx);
    await fx.deps.serial.run(() => fx.tayrona.get('104522'));
    expect(violations).toEqual(['Tayrona.get']);
  });

  it('upload, conflict, resolution, refresh, execution, reconciliation, verification, webhooks and resend', async () => {
    const fx = deliveryFixture();
    const violations = guarded(fx);
    const resolveConflict = new ResolveDuplicateConflict(fx.deps);
    const refresh = new RefreshRecipients(fx.deps);

    await fx.uploadValid(3);
    await fx.upload.execute('operador', OCT_2026, 'CASH', [
      { name: 'sin formato.pdf', content: pdfBytes('bad') },
      { name: fileName('Otro Nombre', 'MULTA', '98765'), content: pdfBytes('receipt-2') },
    ]);
    const [, , third] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(await resolveConflict.execute('operador', third?.sha256 as never, fileName('Otro Nombre', 'MULTA', '98765'), 'the right one')).toMatchObject({ ok: true });
    expect(await refresh.execute('operador', OCT_2026, 'CASH')).toMatchObject({ ok: true });

    fx.email.respondWith({ kind: 'ACCEPTED', providerRequestId: 'r1' }, UNCERTAIN);
    await fx.startAndRun();
    await fx.recentSends.execute();
    const attempts = fx.email.calls.map((c) => c.attemptId);
    await fx.reconcile.execute(attempts[1] as string, false);
    const [first] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    await fx.verify.receipt('operador', first?.sha256 as never);
    await fx.verify.batch('operador', OCT_2026, 'CASH');
    await fx.deliver('w-hb', { attemptId: attempts[0] as string, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    expect(await fx.resend.execute('operador', first?.sha256 as never)).toMatchObject({ ok: true, value: { state: 'SENT' } });
    await fx.sweep.execute();

    expect(fx.email.calls.length).toBeGreaterThanOrEqual(4);
    expect(violations).toEqual([]);
  });

  it('a slow contract source during an upload does not delay a webhook', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    const slow = holdNextLookup(fx);
    const upload = fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Nuevo', 'MULTA', '104522'), content: pdfBytes('nuevo') }]);
    await slow.reached;

    // The upload waits for the source outside the executor: the webhook goes through meanwhile.
    expect(await fx.deliver('w-1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' })).toEqual(['APPLIED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
    let uploaded = false;
    void upload.then(() => {
      uploaded = true;
    });
    await Promise.resolve();
    expect(uploaded).toBe(false);

    slow.open();
    expect(await upload).toMatchObject({ ok: true, value: { results: [{ outcome: 'REGISTERED', state: 'PENDING' }] } });
  });
});

describe('D36: phase (b) decides on the current state', () => {
  it('the same content uploaded by two operators at once is registered once', async () => {
    const fx = deliveryFixture();
    const slow = holdNextLookup(fx);
    const file = { name: fileName('Edificio Altos', 'MULTA', '104522'), content: pdfBytes('same') };
    const first = fx.upload.execute('operadora', OCT_2026, 'CASH', [file]);
    await slow.reached;
    // The second one gets its lookup at once and is decided first.
    const second = await fx.upload.execute('operador', OCT_2026, 'CASH', [file]);
    slow.open();
    expect(second).toMatchObject({ ok: true, value: { manifestVersion: 1, results: [{ outcome: 'REGISTERED' }] } });
    expect(await first).toMatchObject({ ok: true, value: { manifestVersion: 1, results: [{ outcome: 'DUPLICATE' }] } });
    expect(await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).toHaveLength(1);
    expect((await fx.repository.audit.list()).filter((a) => a.action === 'RECEIPTS_UPLOADED')).toHaveLength(1);
  });

  it('an execution started while the upload queried the source refuses it, and nothing is written', async () => {
    const fx = deliveryFixture();
    const other = await fx.upload.execute('operador', OCT_2026, 'ANGLO', [{ name: fileName('Anglo', 'MULTA', '7001'), content: pdfBytes('anglo') }]);
    const slow = holdNextLookup(fx);
    const upload = fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Nuevo', 'MULTA', '104522'), content: pdfBytes('nuevo') }]);
    await slow.reached;
    expect((await fx.start.execute('operador', OCT_2026, 'ANGLO', other.ok ? other.value.manifestVersion : 0)).ok).toBe(true);
    slow.open();
    expect(await upload).toEqual({ ok: false, error: 'EXECUTION_IN_PROGRESS' });
    expect(await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).toEqual([]);
    expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0]?.sha256 as never })).toBeUndefined();
  });

  it('refresh: an address suppressed while the source was queried is EMAIL_SUPPRESSED', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(1);
    const slow = holdNextLookup(fx);
    const refresh = new RefreshRecipients(fx.deps).execute('operador', OCT_2026, 'CASH');
    await slow.reached;
    await fx.repository.suppressions.save({ email: 'admin@altos.com', reason: 'HARD_BOUNCE', since: fx.clock.now(), attemptId: 'other' });
    slow.open();
    expect(await refresh).toMatchObject({ ok: true, value: { refreshed: 1 } });
    expect((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0]).toMatchObject({ state: 'PENDING', errorType: 'EMAIL_SUPPRESSED' });
  });

  it('resolve conflict: a receipt removed while the source was queried is no longer in conflict', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(1);
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Otro Nombre', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);
    const [receipt] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    const slow = holdNextLookup(fx);
    const resolving = new ResolveDuplicateConflict(fx.deps).execute('operador', receipt?.sha256 as never, fileName('Otro Nombre', 'MULTA', '104522'), 'that one');
    await slow.reached;
    expect(await new RemoveReceipt(fx.deps).execute('operador', receipt?.sha256 as never)).toMatchObject({ ok: true });
    slow.open();
    expect(await resolving).toEqual({ ok: false, error: { code: 'RECEIPT_NOT_IN_CONFLICT' } });
    expect(await states(fx)).toEqual(['REMOVED']);
  });

  it('resend: a hard bounce of the new address processed meanwhile is honoured; nothing is sent', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    const slow = holdNextLookup(fx);
    const resend = fx.resend.execute('operador', receipt.sha256);
    await slow.reached;
    await fx.repository.suppressions.save({ email: 'nuevo@altos.com', reason: 'HARD_BOUNCE', since: fx.clock.now(), attemptId: 'other' });
    slow.open();
    expect(await resend).toEqual({ ok: false, error: 'EMAIL_SUPPRESSED' });
    expect(fx.email.calls).toHaveLength(1);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE', attempts: 1 });
    expect(await fx.repository.attempts.listByReceipt(receipt.sha256)).toHaveLength(1);
  });
});

describe('D36 + D32: an exception during a resend releases the receipt', () => {
  it('before the provider call: back to SENT with its delivery state and recipient; it can be resent again', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    vi.spyOn(fx.repository.concepts, 'list').mockRejectedValueOnce(new Error('connection reset'));
    await expect(fx.resend.execute('operador', receipt.sha256)).rejects.toThrow('connection reset');

    expect(fx.email.calls).toHaveLength(1);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE', recipient: { email: 'admin@altos.com' }, attempts: 2 });
    const attempt = (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1);
    expect(attempt).toMatchObject({ kind: 'RESEND', detail: 'not sent: internal error (Error: connection reset)' });
    expect(attempt?.outcome).toBeUndefined();
    expect((await fx.repository.receipts.history(receipt.sha256)).at(-1)).toMatchObject({ event: 'SENT', detail: expect.stringContaining('back to SENT / HARD_BOUNCE') });

    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'SENT', email: 'nuevo@altos.com' } });
    expect(fx.email.calls).toHaveLength(2);
  });

  it('from the provider call: UNCERTAIN, never sent again blindly; reconciliation is scheduled', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    vi.spyOn(fx.email, 'send').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(fx.resend.execute('operador', receipt.sha256)).rejects.toThrow('fetch failed');

    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'UNCERTAIN', deliveryState: undefined });
    const attempt = (await fx.repository.attempts.listByReceipt(receipt.sha256)).at(-1);
    expect(attempt).toMatchObject({ outcome: 'UNCERTAIN', detail: expect.stringContaining('internal error after calling the provider') });
    const event = (await fx.repository.outbox.lockPending(1000)).map((p) => p.event).filter((e) => e.type === 'RECEIPT_UNCERTAIN').at(-1);
    expect(event?.payload).toMatchObject({ sha256: receipt.sha256, attemptId: attempt?.attemptId, attemptKind: 'RESEND' });
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_RESENDABLE' });
  });
});
