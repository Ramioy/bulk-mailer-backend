import { describe, expect, it } from 'vitest';

import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const HOUR = 3_600_000;
const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout after 30000 ms' };

const alertTypes = async (fx: DeliveryFixture) => (await fx.repository.alerts.list()).map((a) => a.type);
const outboxTypes = async (fx: DeliveryFixture) => (await fx.repository.outbox.lockPending(1000)).map((p) => p.event.type);

/** One receipt left UNCERTAIN by a lost response. */
async function uncertainOne(fx: DeliveryFixture) {
  fx.email.respondWith(UNCERTAIN);
  return fx.sendOne();
}

describe('delivery webhooks (RecordDeliveryWebhook + ProcessDeliveryEvent)', () => {
  it('stores the webhook once, queues its processing and applies an acceptance to the SENT receipt', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    const webhook = {
      webhookRequestId: 'wr-1',
      provider: 'ZEPTOMAIL',
      receivedAt: fx.clock.now(),
      body: '{"raw":true}',
      events: [{ eventId: 'wr-1:0', attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' as const, occurredAt: fx.clock.now(), source: 'WEBHOOK' as const }],
    };
    expect(await fx.recordWebhook.execute(webhook)).toEqual({ duplicate: false });
    expect(await fx.recordWebhook.execute(webhook)).toEqual({ duplicate: true });
    expect((await outboxTypes(fx)).filter((t) => t === 'WEBHOOK_RECEIVED')).toHaveLength(1);

    await fx.followUps.onWebhookReceived({ eventId: 'e', type: 'WEBHOOK_RECEIVED', occurredAt: fx.clock.now(), payload: { webhookRequestId: 'wr-1' } });
    expect(await fx.jobs.claimNext(fx.clock.now())).toMatchObject({ type: 'PROCESS_DELIVERY_EVENT', payload: { webhookRequestId: 'wr-1' } });

    expect(await fx.processWebhook.execute('wr-1')).toEqual(['APPLIED']);
    expect(await fx.processWebhook.execute('wr-1')).toEqual([]);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
    expect((await fx.repository.webhooks.get('wr-1'))?.processedAt).toBeDefined();
    expect(await fx.repository.deliveryEvents.listByAttempt(attempt.attemptId)).toMatchObject([{ isPrimaryRecipient: true, source: 'WEBHOOK' }]);
  });

  it('on a hard bounce: delivery HARD_BOUNCE, local suppression, alert, and Resend becomes available', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    expect(await fx.deliver('wr-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE', reason: '550 5.1.1 User unknown' })).toEqual(['APPLIED']);

    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toMatchObject({ reason: 'HARD_BOUNCE', attemptId: attempt.attemptId });
    expect((await fx.repository.alerts.list()).at(-1)).toMatchObject({ type: 'HARD_BOUNCE', subject: receipt.sha256, detail: expect.stringContaining('User unknown') });
    expect(await outboxTypes(fx)).toEqual(expect.arrayContaining(['DELIVERY_UPDATED', 'ADDRESS_SUPPRESSED', 'ALERT_RAISED']));
  });

  it('a complaint without a prior acceptance suppresses the address too (P5)', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('wr-c', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'COMPLAINT' });
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('COMPLAINT');
    expect(await fx.repository.suppressions.get('admin@altos.com')).toMatchObject({ reason: 'COMPLAINT' });
    expect(await alertTypes(fx)).toContain('COMPLAINT');
  });

  it('the delivery state only advances; a late or repeated event changes nothing', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect(await fx.deliver('w2', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'SOFT_BOUNCE' })).toEqual(['RECORDED']);
    expect(await fx.deliver('w3', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' })).toEqual(['RECORDED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
    expect((await fx.repository.receipts.history(receipt.sha256)).map((h) => h.event)).toContain('DELIVERY_ANOMALY');
    expect(await fx.repository.suppressions.list()).toEqual([]);
  });

  it('only the primary recipient counts: a bounce of the archive copy raises COPY_BOUNCED and does not touch the receipt', async () => {
    const fx = deliveryFixture({ execution: { archiveCopyAddress: 'archivo@anutibara.com' } });
    await fx.repository.settings.setArchiveCopyEnabled(true);
    const { receipt, attempt } = await fx.sendOne();
    expect(attempt.copyAddress).toBe('archivo@anutibara.com');

    expect(await fx.deliver('w-copy', { attemptId: attempt.attemptId, recipient: 'archivo@anutibara.com', state: 'HARD_BOUNCE' })).toEqual(['RECORDED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('UNCONFIRMED');
    expect(await alertTypes(fx)).toEqual(['COPY_BOUNCED']);
    expect(await fx.repository.suppressions.list()).toEqual([]);

    // Without a recipient in the event and with a copy, it cannot be attributed: recorded only.
    expect(await fx.deliver('w-unknown', { attemptId: attempt.attemptId, state: 'ACCEPTED' })).toEqual(['RECORDED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('UNCONFIRMED');
  });

  it('without a copy, an event without recipient is the primary one; an unknown client reference is only recorded', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    expect(await fx.deliver('w1', { attemptId: 'not-ours', state: 'ACCEPTED' })).toEqual(['UNKNOWN_ATTEMPT']);
    expect(await fx.deliver('w2', { attemptId: attempt.attemptId, state: 'ACCEPTED' })).toEqual(['APPLIED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
  });

  it('a webhook resolves an UNCERTAIN receipt: SENT, with its delivery state', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    expect(receipt.state).toBe('UNCERTAIN');
    await fx.deliver('w1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED', providerRequestId: 'req-9', emailReference: 'ref-9' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'ACCEPTED', errorType: undefined });
    expect(await fx.repository.attempts.get(attempt.attemptId)).toMatchObject({ providerRequestId: 'req-9', emailReference: 'ref-9' });
    expect(await outboxTypes(fx)).toContain('RECEIPT_RESOLVED');
  });
});

describe('ReconcileSends for UNCERTAIN receipts (§9.4)', () => {
  it('schedules lookups at 5, 15 and 60 minutes, only the last one final', async () => {
    const fx = deliveryFixture();
    const { attempt } = await uncertainOne(fx);
    const event = (await fx.repository.outbox.lockPending(100)).find((p) => p.event.type === 'RECEIPT_UNCERTAIN')?.event;
    if (!event) throw new Error('no RECEIPT_UNCERTAIN event');
    await fx.followUps.onReceiptUncertain(event);
    const at = event.occurredAt.getTime();
    const jobs = [];
    fx.clock.advance(2 * HOUR);
    for (let job = await fx.jobs.claimNext(fx.clock.now()); job; job = await fx.jobs.claimNext(fx.clock.now())) jobs.push(job);
    expect(jobs.map((j) => [j.type, j.payload, (j.runAt.getTime() - at) / 60_000])).toEqual([
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: false }, 5],
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: false }, 15],
      ['RECONCILE_ATTEMPT', { attemptId: attempt.attemptId, final: true }, 60],
    ]);
  });

  it('finds the attempt id of a receipt left UNCERTAIN by a crash', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    await fx.followUps.onReceiptUncertain({ eventId: 'e', type: 'RECEIPT_UNCERTAIN', occurredAt: fx.clock.now(), payload: { sha256: receipt.sha256 } });
    fx.clock.advance(HOUR);
    expect((await fx.jobs.claimNext(fx.clock.now()))?.payload).toEqual({ attemptId: attempt.attemptId, final: false });
  });

  it('marks NOT_FOUND_AT_PROVIDER only at the last lookup', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    expect(await fx.reconcile.execute(attempt.attemptId, false)).toBe('STILL_UNCERTAIN');
    expect((await fx.receipt(receipt.sha256)).state).toBe('UNCERTAIN');
    expect(fx.lookup.calls).toEqual([{ attemptId: attempt.attemptId, recipient: 'admin@altos.com' }]);

    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('FAILED');
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('ALREADY_RESOLVED');
  });

  it('stays UNCERTAIN when the logs API does not answer, even at the last lookup', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    fx.lookup.setUnavailable(true);
    expect(await fx.reconcile.execute(attempt.attemptId, true)).toBe('STILL_UNCERTAIN');
    expect((await fx.receipt(receipt.sha256)).state).toBe('UNCERTAIN');
    expect((await fx.repository.receipts.history(receipt.sha256)).at(-1)).toMatchObject({ event: 'RECONCILIATION_UNAVAILABLE' });
  });

  it.each([
    ['PROCESSED', { state: 'SENT', deliveryState: 'UNCONFIRMED' }],
    ['QUEUED', { state: 'SENT', deliveryState: 'UNCONFIRMED' }],
    ['DELIVERED', { state: 'SENT', deliveryState: 'ACCEPTED' }],
    ['SOFT_BOUNCE', { state: 'SENT', deliveryState: 'SOFT_BOUNCE' }],
    ['HARD_BOUNCE', { state: 'SENT', deliveryState: 'HARD_BOUNCE' }],
    ['PROCESS_FAILED', { state: 'FAILED', errorType: 'PROVIDER_REJECTED' }],
  ] as const)('found as %s → %j', async (status, expected) => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status, providerRequestId: 'req-1', emailReference: 'ref-1' });
    await fx.reconcile.execute(attempt.attemptId, false);
    expect(await fx.receipt(receipt.sha256)).toMatchObject(expected);
    expect(await fx.repository.attempts.get(attempt.attemptId)).toMatchObject({ providerRequestId: 'req-1', emailReference: 'ref-1' });
    expect((await fx.repository.suppressions.list()).map((x) => x.email)).toEqual(status === 'HARD_BOUNCE' ? ['admin@altos.com'] : []);
  });
});

describe('SweepUnconfirmed and WEBHOOKS_NOT_RECEIVED (§9.4)', () => {
  it('looks up SENT receipts still UNCONFIRMED between N and 72 h, and alerts once on a proven webhook loss', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED', emailReference: 'ref-1' });

    fx.clock.advance(2 * HOUR);
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 0, updated: 0, alerts: 0 });

    fx.clock.advance(5 * HOUR);
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 1, updated: 1, alerts: 1 });
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
    const alerts = (await fx.repository.alerts.list()).filter((a) => a.type === 'WEBHOOKS_NOT_RECEIVED');
    expect(alerts).toEqual([expect.objectContaining({ subject: attempt.executionId, detail: expect.stringContaining('no webhook arrived') })]);

    fx.clock.advance(HOUR);
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 0, updated: 0, alerts: 0 });
  });

  it('raises the alert on total silence: an execution with sends and no webhook after N hours, once', async () => {
    const fx = deliveryFixture();
    await fx.sendOne();
    fx.clock.advance(7 * HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ lookedUp: 1, alerts: 1 });
    expect(await fx.sweep.execute()).toMatchObject({ alerts: 0 });
    expect((await alertTypes(fx)).filter((t) => t === 'WEBHOOKS_NOT_RECEIVED')).toHaveLength(1);
  });

  it('does not alert when webhooks arrive, nor after 72 h', async () => {
    const fx = deliveryFixture();
    const { attempt } = await fx.sendOne();
    await fx.deliver('w1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'SOFT_BOUNCE' });
    fx.clock.advance(7 * HOUR);
    // D44 (M3): a SOFT_BOUNCE is looked up too (it may have become a hard bounce); a webhook arrived, so no alert.
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 1, updated: 0, alerts: 0 });

    const other = deliveryFixture();
    await other.sendOne();
    other.clock.advance(73 * HOUR);
    expect(await other.sweep.execute()).toEqual({ lookedUp: 0, updated: 0, alerts: 0 });
  });
});

describe('process failed after acceptance (M2)', () => {
  it('a SENT receipt the logs show as process failed: delivery PROCESS_FAILED, alert, no suppression, no WEBHOOKS_NOT_RECEIVED, resendable', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESS_FAILED', detail: 'Process failed' });

    fx.clock.advance(7 * HOUR);
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 1, updated: 1, alerts: 0 });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'PROCESS_FAILED' });
    expect((await fx.repository.alerts.list()).map((a) => [a.type, a.subject])).toEqual([['PROCESS_FAILED', receipt.sha256]]);
    expect(await fx.repository.suppressions.get('admin@altos.com')).toBeUndefined();
    // A second lookup changes nothing and raises nothing else.
    expect(await fx.sweep.execute()).toEqual({ lookedUp: 0, updated: 0, alerts: 0 });

    // Resend (§10.4 extended by M2): the file is uploaded again after the purge (A2), then it goes out.
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'FILE_NOT_AVAILABLE' });
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'SENT' } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED' });
  });

  it('an UNCERTAIN send the logs show as process failed is still FAILED / PROVIDER_REJECTED (unchanged)', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith({ kind: 'UNCERTAIN', detail: 'timeout' });
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESS_FAILED' });
    expect(await fx.reconcile.execute(attempt.attemptId, false)).toBe('FAILED');
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'PROVIDER_REJECTED' });
  });
});

describe('ResolveUncertain (manual, §9.4)', () => {
  it('requires an evidence note and an UNCERTAIN receipt; marks it sent and audits it', async () => {
    const fx = deliveryFixture();
    const { receipt } = await uncertainOne(fx);
    expect(await fx.resolve.execute('operador', receipt.sha256, 'SENT', '  ')).toEqual({ ok: false, error: 'NOTE_REQUIRED' });
    expect(await fx.resolve.execute('operador', receipt.sha256, 'SENT', 'Processed Emails: Delivered 10:42')).toEqual({ ok: true, value: { state: 'SENT' } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED' });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({
      action: 'UNCERTAIN_RESOLVED',
      actor: 'operador',
      previousValue: 'UNCERTAIN',
      newValue: 'SENT',
      note: 'Processed Emails: Delivered 10:42',
    });
    expect(await fx.resolve.execute('operador', receipt.sha256, 'SENT', 'again')).toEqual({ ok: false, error: 'RECEIPT_NOT_UNCERTAIN' });
  });

  it('marks it not sent: FAILED / NOT_FOUND_AT_PROVIDER (it enters an execution again once its file is available)', async () => {
    const fx = deliveryFixture();
    const { receipt } = await uncertainOne(fx);
    expect(await fx.resolve.execute('operador', receipt.sha256, 'NOT_SENT', 'No aparece en Processed Emails')).toEqual({ ok: true, value: { state: 'FAILED' } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER' });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'UNCERTAIN_RESOLVED', newValue: 'FAILED' });
  });
});

describe('ReleaseSuppressedAddress (§10.3, D19)', () => {
  async function suppressed(fx: DeliveryFixture) {
    const { attempt } = await fx.sendOne();
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    fx.suppressionManager.suppress('admin@altos.com');
  }
  const request = { businessConfirmed: true, removedInProviderConsole: true, note: 'Administración confirmó el buzón por teléfono' };

  it('releases on both sides only when the provider confirms, and audits it', async () => {
    const fx = deliveryFixture();
    await suppressed(fx);
    expect(await fx.release.execute('operador', 'Admin@Altos.com', request)).toEqual({ ok: true, value: { email: 'admin@altos.com', provider: 'RELEASED' } });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toBeUndefined();
    expect(fx.suppressionManager.isSuppressed('admin@altos.com')).toBe(false);
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'ADDRESS_RELEASED', subject: 'admin@altos.com', previousValue: 'HARD_BOUNCE', note: request.note });
  });

  it('releases nothing when the provider fails (never on one side only)', async () => {
    const fx = deliveryFixture();
    await suppressed(fx);
    fx.suppressionManager.failWith('HTTP 503');
    expect(await fx.release.execute('operador', 'admin@altos.com', request)).toEqual({ ok: false, error: { code: 'SUPPRESSION_PROVIDER_FAILED', detail: 'HTTP 503' } });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toBeDefined();
  });

  it('requires the evidence note, the business confirmation and a suppressed address', async () => {
    const fx = deliveryFixture();
    await suppressed(fx);
    expect(await fx.release.execute('operador', 'admin@altos.com', { ...request, note: ' ' })).toEqual({ ok: false, error: { code: 'NOTE_REQUIRED' } });
    expect(await fx.release.execute('operador', 'admin@altos.com', { ...request, businessConfirmed: false })).toEqual({ ok: false, error: { code: 'BUSINESS_CONFIRMATION_REQUIRED' } });
    expect(await fx.release.execute('operador', 'otro@altos.com', request)).toEqual({ ok: false, error: { code: 'ADDRESS_NOT_SUPPRESSED' } });
  });

  it('with the console adapter (D19), requires the operator to confirm the removal in the ZeptoMail console', async () => {
    const fx = deliveryFixture({ confirmation: 'OPERATOR' });
    await suppressed(fx);
    expect(await fx.release.execute('operador', 'admin@altos.com', { ...request, removedInProviderConsole: false })).toEqual({
      ok: false,
      error: { code: 'PROVIDER_REMOVAL_NOT_CONFIRMED' },
    });
    expect(await fx.release.execute('operador', 'admin@altos.com', request)).toEqual({ ok: true, value: { email: 'admin@altos.com', provider: 'CONFIRMED_BY_OPERATOR' } });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'ADDRESS_RELEASED', newValue: 'CONFIRMED_BY_OPERATOR' });
  });
});

describe('ResendReceipt (§10.4)', () => {
  /** A sent receipt that hard-bounced, with its file uploaded again after the purge (A2). */
  async function bounced(fx: DeliveryFixture) {
    const { receipt, attempt } = await fx.sendOne();
    await fx.deliver('w-hb', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    return { receipt, attempt };
  }
  const reupload = (fx: DeliveryFixture) =>
    fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);

  it('is offered only after a hard bounce or a complaint', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_RESENDABLE' });
    await fx.deliver('w1', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_RESENDABLE' });
  });

  it('needs the file uploaded again after the purge; the upload gives it back without changing the state (A2)', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'FILE_NOT_AVAILABLE' });
    const upload = await reupload(fx);
    expect(upload).toMatchObject({ ok: true, value: { results: [{ outcome: 'REGISTERED', state: 'SENT' }] } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE', fileAvailable: true });
  });

  it('blocks the same address as EMAIL_SUPPRESSED until it is released', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    await reupload(fx);
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'EMAIL_SUPPRESSED' });
    expect(fx.email.calls).toHaveLength(1);

    await fx.release.execute('operador', 'admin@altos.com', { businessConfirmed: true, removedInProviderConsole: true, note: 'buzón confirmado' });
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'SENT', previousEmail: 'admin@altos.com', email: 'admin@altos.com' } });
  });

  it('sends to the corrected address with a new attempt, audits it and discards the file', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await bounced(fx);
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });

    const result = await fx.resend.execute('operador', receipt.sha256);
    expect(result).toMatchObject({ ok: true, value: { state: 'SENT', previousEmail: 'admin@altos.com', email: 'nuevo@altos.com' } });
    const resent = fx.email.calls.at(-1);
    expect(resent).toMatchObject({ to: 'nuevo@altos.com', subject: 'Multa – Octubre 2026' });
    expect(resent?.attemptId).not.toBe(attempt.attemptId);
    expect(await fx.repository.attempts.get(resent?.attemptId as string)).toMatchObject({ kind: 'RESEND', outcome: 'ACCEPTED' });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED', fileAvailable: false, attempts: 2, recipient: { email: 'nuevo@altos.com' } });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'RECEIPT_RESENT', previousValue: 'admin@altos.com', newValue: 'nuevo@altos.com' });
    // D41: deleted by the job queued with the outcome, once the file lane runs it.
    expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: receipt.sha256 })).toBeDefined();
    expect(await fx.runFileJobs()).toBe(1);
    expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: receipt.sha256 })).toBeUndefined();

    // A late event of the first attempt no longer changes the receipt.
    expect(await fx.deliver('w-late', { attemptId: attempt.attemptId, recipient: 'admin@altos.com', state: 'COMPLAINT' })).toEqual(['RECORDED']);
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('UNCONFIRMED');
  });

  it('a failed resend ends FAILED and enters the next normal manifest (D7c)', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    const before = (await fx.repository.batches.get(OCT_2026, 'CASH'))?.manifestVersion ?? 0;
    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113(to)' });

    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'FAILED' } });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'FAILED', errorType: 'PROVIDER_REJECTED', fileAvailable: true });
    const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
    expect(batch?.manifestVersion).toBe(before + 1);
    const manifest = await fx.repository.batches.getManifest(OCT_2026, 'CASH', batch?.manifestVersion ?? 0);
    expect(manifest?.entries.map((e) => [e.sha256, e.email])).toEqual([[receipt.sha256, 'nuevo@altos.com']]);
  });

  it('an uncertain resend is reconciled like any other send', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    await reupload(fx);
    fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
    fx.email.respondWith(UNCERTAIN);
    expect(await fx.resend.execute('operador', receipt.sha256)).toMatchObject({ ok: true, value: { state: 'UNCERTAIN' } });
    expect((await fx.repository.outbox.lockPending(1000)).map((p) => p.event).filter((e) => e.type === 'RECEIPT_UNCERTAIN').at(-1)?.payload).toMatchObject({
      attemptKind: 'RESEND',
    });
  });

  it('is refused while an execution runs', async () => {
    const fx = deliveryFixture();
    const { receipt } = await bounced(fx);
    await reupload(fx);
    // Another contract: admin@altos.com is suppressed.
    const upload = await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Las Palmas', 'MULTA', '98765'), content: pdfBytes('palmas') }]);
    expect((await fx.start.execute('operador', OCT_2026, 'CASH', upload.ok ? upload.value.manifestVersion : 0)).ok).toBe(true);
    expect(await fx.resend.execute('operador', receipt.sha256)).toEqual({ ok: false, error: 'EXECUTION_IN_PROGRESS' });
  });
});

describe('per-minute check of the sends of a running batch (D21)', () => {
  it('is active while an execution runs and 30 minutes after it, and applies what the logs show', async () => {
    const fx = deliveryFixture();
    expect(await fx.recentSends.active()).toBe(false);
    const { receipt, attempt } = await fx.sendOne();
    expect(await fx.recentSends.active()).toBe(true);

    expect(await fx.recentSends.execute()).toEqual({ checked: 1, updated: 0 });
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'SOFT_BOUNCE' });
    fx.clock.advance(60_000);
    expect(await fx.recentSends.execute()).toEqual({ checked: 1, updated: 1 });
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('SOFT_BOUNCE');

    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'DELIVERED' });
    fx.clock.advance(60_000);
    expect(await fx.recentSends.execute()).toEqual({ checked: 1, updated: 1 });
    expect((await fx.receipt(receipt.sha256)).deliveryState).toBe('ACCEPTED');
    // Final: no more lookups for it.
    expect(await fx.recentSends.execute()).toEqual({ checked: 0, updated: 0 });

    fx.clock.advance(31 * 60_000);
    expect(await fx.recentSends.active()).toBe(false);
  });

  it('is active as soon as an execution is running, and the job is queued only then', async () => {
    const fx = deliveryFixture();
    expect(await fx.followUps.requestRecentCheck(() => fx.recentSends.active())).toBe(false);
    const version = await fx.uploadValid(1);
    await fx.start.execute('operador', OCT_2026, 'CASH', version);
    expect(await fx.followUps.requestRecentCheck(() => fx.recentSends.active())).toBe(true);
    expect(await fx.jobs.claimNext(fx.clock.now(), ['CHECK_RECENT_SENDS'])).toMatchObject({ type: 'CHECK_RECENT_SENDS' });
  });

  it('confirms an UNCERTAIN send found in the logs but never fails it before the last scheduled lookup', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await uncertainOne(fx);
    expect(await fx.recentSends.execute()).toEqual({ checked: 1, updated: 0 });
    expect((await fx.receipt(receipt.sha256)).state).toBe('UNCERTAIN');
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'PROCESSED' });
    expect(await fx.recentSends.execute()).toEqual({ checked: 1, updated: 1 });
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'UNCONFIRMED' });
  });

  it('does not raise WEBHOOKS_NOT_RECEIVED at once; after N hours it does, for a state only the logs reported', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(2);
    await fx.startAndRun();
    const [first, second] = fx.email.calls.map((c) => c.attemptId);
    fx.lookup.setResult(first as string, { kind: 'FOUND', status: 'DELIVERED' });
    await fx.deliver('w-2', { attemptId: second as string, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    await fx.recentSends.execute();
    expect(await alertTypes(fx)).not.toContain('WEBHOOKS_NOT_RECEIVED');

    fx.clock.advance(7 * HOUR);
    expect(await fx.sweep.execute()).toMatchObject({ alerts: 1 });
    expect((await fx.repository.alerts.list()).find((a) => a.type === 'WEBHOOKS_NOT_RECEIVED')?.detail).toContain('1 receipt(s)');
    expect(await fx.sweep.execute()).toMatchObject({ alerts: 0 });
  });
});

describe('events that arrive while the send is being recorded (D21)', () => {
  it('keeps a webhook received while the receipt is SENDING and applies it with the outcome', async () => {
    let fx: DeliveryFixture | undefined;
    const results: string[][] = [];
    const provider = {
      send: async (email: { attemptId: string }) => {
        // The provider accepted and its webhook arrives before we record the response.
        results.push(await (fx as DeliveryFixture).deliver('w-early', { attemptId: email.attemptId, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' }));
        return { kind: 'ACCEPTED' as const, providerRequestId: 'req-early' };
      },
    };
    fx = deliveryFixture({ execution: { emailProvider: provider } });
    const { receipt } = await fx.sendOne();
    expect(results).toEqual([['PENDING_SEND']]);
    expect(await fx.receipt(receipt.sha256)).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toBeDefined();
  });
});

describe('manual delivery verification (D22)', () => {
  it('checks one receipt now, applies what the logs show and audits it', async () => {
    const fx = deliveryFixture();
    const { receipt, attempt } = await fx.sendOne();
    fx.lookup.setResult(attempt.attemptId, { kind: 'FOUND', status: 'HARD_BOUNCE', detail: 'hard bounce' });
    expect(await fx.verify.receipt('operador', receipt.sha256)).toEqual({
      ok: true,
      value: { sha256: receipt.sha256, fileName: receipt.fileName, result: 'UPDATED', providerStatus: 'HARD_BOUNCE', state: 'SENT', deliveryState: 'HARD_BOUNCE' },
    });
    expect(await fx.repository.suppressions.get('admin@altos.com')).toBeDefined();
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'DELIVERY_VERIFIED', actor: 'operador', subject: receipt.sha256, newValue: 'UPDATED (HARD_BOUNCE): SENT/HARD_BOUNCE' });
    // Final state: nothing left to verify.
    expect(await fx.verify.receipt('operador', receipt.sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_VERIFIABLE' });
  });

  it('reports a send the logs do not show yet without failing it, and an unavailable logs API', async () => {
    const fx = deliveryFixture();
    const { receipt } = await uncertainOne(fx);
    expect(await fx.verify.receipt('operador', receipt.sha256)).toMatchObject({ ok: true, value: { result: 'NOT_FOUND', state: 'UNCERTAIN' } });
    fx.lookup.setUnavailable(true);
    expect(await fx.verify.receipt('operador', receipt.sha256)).toMatchObject({ ok: true, value: { result: 'UNAVAILABLE', detail: 'simulated outage', state: 'UNCERTAIN' } });
  });

  it('checks every pending receipt of a batch, also while another execution runs', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(3);
    await fx.startAndRun();
    const [a, b, c] = fx.email.calls.map((call) => call.attemptId as string);
    fx.lookup.setResult(a as string, { kind: 'FOUND', status: 'DELIVERED' });
    fx.lookup.setResult(b as string, { kind: 'FOUND', status: 'PROCESSED' });
    await fx.deliver('w-c', { attemptId: c as string, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    // Another batch running does not block the verification.
    const other = await fx.upload.execute('operador', OCT_2026, 'ANGLO', [{ name: fileName('Anglo', 'MULTA', '7001'), content: pdfBytes('anglo') }]);
    expect((await fx.start.execute('operador', OCT_2026, 'ANGLO', other.ok ? other.value.manifestVersion : 0)).ok).toBe(true);
    expect(await fx.repository.executions.running()).toBeDefined();

    const result = await fx.verify.batch('operador', OCT_2026, 'CASH');
    expect(result.ok && result.value.receipts.map((r) => [r.result, r.deliveryState])).toEqual([
      ['UPDATED', 'ACCEPTED'],
      ['NO_CHANGE', 'UNCONFIRMED'],
    ]);
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'DELIVERY_VERIFIED', subject: '2026-10/CASH', newValue: '2 checked, 1 updated' });
    expect(await fx.verify.batch('operador', OCT_2026, 'DAVIVIENDA')).toEqual({ ok: false, error: 'BATCH_NOT_FOUND' });
  });
});
